import { z } from "zod";
import { AgentError, getAgent, type Agent, type PrivateConversationMessage } from "@/lib/agent";
import { dispatchOutbox } from "@/lib/email";
import type { Db } from "@/lib/db";
import { processOutingDeadlines } from "@/lib/maintenance";
import {
  findAccessibleOuting,
  listOwnMessages,
  type ApiResponse,
  type OwnerContext,
} from "@/lib/outings-api";
import {
  OfferGenerationResultSchema,
  emptyConditionInterpretation,
  parseJsonValue,
  type CatalogOption,
  type ConditionInterpretation,
  type OfferCandidate,
  type PublicOffer,
  type PublicParticipant,
} from "@/lib/planning-types";
import {
  validateCandidate,
  type PlanningParticipant,
  type ProposalConditionRow,
} from "@/lib/planning";

type WorkspaceOutingRow = {
  id: string;
  starter_user_id: string;
  suggestion: string;
  cutoff_at: string | Date | null;
  cutoff_time_zone: string | null;
  invite_token: string | null;
  status: string;
  cutoff_processed_at: string | Date | null;
  ended_at: string | Date | null;
  created_at: string | Date;
};

type ParticipantRow = PlanningParticipant & {
  user_id: string;
  display_name: string;
  admission_status: PlanningParticipant["admissionStatus"];
  response_status: PlanningParticipant["responseStatus"];
  responded_at: string | Date | null;
  agent_session_id?: string;
  email_opt_in?: boolean;
  notification_email?: string | null;
};

function toParticipantRow(row: ParticipantRow): ParticipantRow {
  return {
    ...row,
    userId: row.user_id,
    admissionStatus: row.admission_status,
    responseStatus: row.response_status,
  };
}

type OptionRow = {
  id: string;
  title: string;
  activity: string;
  starts_at: string | Date;
  estimated_cost_cents: number;
  activity_tags: unknown;
  source: "sample" | "manual" | "agent";
  visibility: "private" | "shared";
  created_by_user_id?: string;
};

type PreferenceRow = {
  private_input: string;
  interpretation: unknown;
  interpretation_ready: boolean;
  rankings: unknown;
  conditions_version?: number;
};

type OfferRow = {
  id: string;
  owner_user_id: string;
  option_id: string;
  activity: string;
  starts_at: string | Date;
  estimated_cost_cents: number;
  attendee_user_ids: unknown;
  activity_tags: unknown;
  private_note: string;
  counter_offer_to_id: string | null;
  status: "draft" | "published" | "withdrawn";
  created_at: string | Date;
  option_title?: string;
};

const RECENT_OFFER_CONVERSATION_TURN_LIMIT = 20;
const RECENT_OFFER_CONVERSATION_MESSAGE_LIMIT = RECENT_OFFER_CONVERSATION_TURN_LIMIT * 2;
const RECENT_OFFER_CONVERSATION_MESSAGE_CHARS = 1_200;
const RECENT_OFFER_CONVERSATION_TOTAL_CHARS = 8_000;

type ProposalRow = {
  id: string;
  revision: number;
  created_by_user_id: string;
  option_id: string;
  activity: string;
  starts_at: string | Date;
  estimated_cost_cents: number;
  attendee_user_ids: unknown;
  status: "published" | "confirmed" | "expired" | "superseded";
  kind: "initial" | "restart" | "join" | "departure";
  published_at: string | Date;
  expires_at: string | Date;
  confirmed_at: string | Date | null;
  approval_count: number | string;
  condition_versions?: unknown;
};

type NotificationRow = {
  id: string;
  kind: string;
  actor_user_id: string | null;
  actor_name: string | null;
  read_at: string | Date | null;
  created_at: string | Date;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const admissionRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  emailOptIn: z.boolean().default(false),
  email: z.string().trim().email().max(254).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.emailOptIn && !value.email) {
    context.addIssue({ code: "custom", path: ["email"], message: "email_required" });
  }
});

const optionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  activity: z.string().trim().min(1).max(80),
  startsAt: z.string().datetime({ offset: true }),
  estimatedCostCents: z.number().int().min(0).max(100_000),
  activityTags: z.array(z.string().trim().min(1).max(40)).max(12),
}).strict();

const emailPreferenceSchema = z.object({
  emailOptIn: z.boolean(),
  email: z.string().trim().email().max(254).nullable(),
}).strict().superRefine((value, context) => {
  if (value.emailOptIn && !value.email) {
    context.addIssue({ code: "custom", path: ["email"], message: "email_required" });
  }
});

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("decide_admission"), userId: z.string().min(1).max(128), decision: z.enum(["admit", "reject"]) }).strict(),
  z.object({ action: z.literal("save_email_preferences"), ...emailPreferenceSchema.shape }).strict(),
  z.object({ action: z.literal("set_interest"), interested: z.boolean() }).strict(),
  z.object({ action: z.literal("add_option"), ...optionSchema.shape }).strict(),
  z.object({ action: z.literal("rank_options"), optionIds: z.array(z.string().uuid()).max(40) }).strict(),
  z.object({ action: z.literal("generate_offer") }).strict(),
  z.object({ action: z.literal("publish_offer"), offerId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("publish_proposal"), offerId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("replace_proposal"), proposalId: z.string().uuid(), offerId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("approve_proposal"), proposalId: z.string().uuid(), revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("restart_proposal"), proposalId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("start_tie_poll"), optionAId: z.string().uuid(), optionBId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("answer_tie"), pollId: z.string().uuid(), answer: z.enum(["a", "b", "either"]) }).strict(),
  z.object({ action: z.literal("request_join") }).strict(),
  z.object({ action: z.literal("request_departure") }).strict(),
  z.object({ action: z.literal("end_outing") }).strict(),
  z.object({ action: z.literal("declare_no_agreement") }).strict(),
]);

type PlanningAction = z.infer<typeof ActionSchema>;

function api(status: number, body: Record<string, unknown>): ApiResponse {
  return { status, body };
}

function isVerifiedRecipient(context: OwnerContext, email: string | null): email is string {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return context.verifiedEmails?.some((verified) => verified.toLowerCase() === normalized) ?? false;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toCatalogOption(row: OptionRow): CatalogOption {
  return {
    id: row.id,
    title: row.title,
    activity: row.activity,
    startsAt: new Date(row.starts_at).toISOString(),
    estimatedCostCents: row.estimated_cost_cents,
    activityTags: parseJsonValue(row.activity_tags, [] as string[]),
    source: row.source,
  };
}

function toPublicOffer(row: OfferRow): PublicOffer {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    optionId: row.option_id,
    activity: row.activity,
    startsAt: new Date(row.starts_at).toISOString(),
    estimatedCostCents: row.estimated_cost_cents,
    attendeeUserIds: parseJsonValue(row.attendee_user_ids, [] as string[]),
    activityTags: parseJsonValue(row.activity_tags, [] as string[]),
    counterOfferToId: row.counter_offer_to_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toProposal(row: ProposalRow) {
  return {
    id: row.id,
    revision: row.revision,
    createdByUserId: row.created_by_user_id,
    optionId: row.option_id,
    activity: row.activity,
    startsAt: new Date(row.starts_at).toISOString(),
    estimatedCostCents: row.estimated_cost_cents,
    attendeeUserIds: parseJsonValue(row.attendee_user_ids, [] as string[]),
    status: row.status,
    kind: row.kind,
    publishedAt: new Date(row.published_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    confirmedAt: iso(row.confirmed_at),
    approvalCount: Number(row.approval_count),
  };
}

async function loadOuting(db: Db, outingId: string): Promise<WorkspaceOutingRow | null> {
  const rows = await db.query<WorkspaceOutingRow>(
    `select * from outings where id = $1`,
    [outingId],
  );
  return rows[0] ?? null;
}

async function isStarter(db: Db, outingId: string, userId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `select id from outings where id = $1 and starter_user_id = $2`,
    [outingId, userId],
  );
  return rows.length > 0;
}

async function loadParticipants(db: Db, outingId: string): Promise<ParticipantRow[]> {
  const rows = await db.query<ParticipantRow>(
    `select user_id, display_name, admission_status, response_status, responded_at
       from participants where outing_id = $1 order by created_at`,
    [outingId],
  );
  return rows.map(toParticipantRow);
}

async function loadConditionRows(db: Db, outingId: string): Promise<ProposalConditionRow[]> {
  const rows = await db.query<{
    user_id: string;
    interpretation: unknown;
    interpretation_ready: boolean;
    conditions_version: number | string;
  }>(
    `select p.user_id, pref.interpretation, coalesce(pref.interpretation_ready, false) as interpretation_ready,
            coalesce(pref.conditions_version, 0) as conditions_version
       from participants p
       left join participant_preferences pref
         on pref.outing_id = p.outing_id and pref.user_id = p.user_id
      where p.outing_id = $1 and p.admission_status = 'admitted'`,
    [outingId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    interpretation: row.interpretation
      ? parseJsonValue(row.interpretation, null as ConditionInterpretation | null)
      : null,
    interpretationReady: row.interpretation_ready,
    conditionsVersion: Number(row.conditions_version),
  }));
}

function conditionVersionsFor(
  conditions: ProposalConditionRow[],
  attendeeUserIds: string[],
): Record<string, number> {
  const byUser = new Map(conditions.map((row) => [row.userId, row.conditionsVersion ?? 0]));
  return Object.fromEntries(
    attendeeUserIds.map((userId) => [userId, byUser.get(userId) ?? -1]),
  );
}

async function latestProposal(
  db: Db,
  outingId: string,
  status: "published" | "confirmed",
): Promise<ProposalRow | null> {
  const rows = await db.query<ProposalRow>(
    `select p.*,
            (select count(*)::int from proposal_approvals a where a.proposal_id = p.id) as approval_count
       from proposals p
      where p.outing_id = $1 and p.status = $2
      order by p.revision desc limit 1`,
    [outingId, status],
  );
  return rows[0] ?? null;
}

async function latestExpiredProposal(db: Db, outingId: string): Promise<ProposalRow | null> {
  const rows = await db.query<ProposalRow>(
    `select p.*,
            (select count(*)::int from proposal_approvals a where a.proposal_id = p.id) as approval_count
       from proposals p
      where p.outing_id = $1 and p.status = 'expired'
      order by p.revision desc limit 1`,
    [outingId],
  );
  return rows[0] ?? null;
}

function matchesProposalRequest(
  proposal: ProposalRow,
  offer: OfferRow,
  attendeeUserIds: string[],
  expectedConditions: Record<string, number>,
): boolean {
  const proposedAttendees = parseJsonValue(proposal.attendee_user_ids, [] as string[]).sort();
  const requestedAttendees = [...attendeeUserIds].sort();
  const conditionVersions = parseJsonValue(
    proposal.condition_versions,
    {} as Record<string, number | string>,
  );
  return proposal.option_id === offer.option_id &&
    proposal.activity === offer.activity &&
    new Date(proposal.starts_at).getTime() === new Date(offer.starts_at).getTime() &&
    proposal.estimated_cost_cents === offer.estimated_cost_cents &&
    proposedAttendees.length === requestedAttendees.length &&
    proposedAttendees.every((userId, index) => userId === requestedAttendees[index]) &&
    requestedAttendees.every((userId) =>
      Number(conditionVersions[userId]) === expectedConditions[userId]
    );
}

export async function getOutingWorkspace(
  context: OwnerContext,
  outingId: string,
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(outingId)) return api(404, { error: "not_found" });
  const access = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!access) return api(404, { error: "not_found" });

  await processOutingDeadlines(context.db, outingId);
  const outing = await loadOuting(context.db, outingId);
  const member = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!outing || !member) return api(404, { error: "not_found" });

  const starter = outing.starter_user_id === context.userId;
  const [participantsAll, optionsRows, preferencesRows, ownMessages, offersRows, ownParticipantRows,
    proposalPending, proposalConfirmed, proposalExpired, notificationsRows, emailRows,
    pendingAdmissionsRows, ownJoinRows, ownDepartureRows, tieRows] = await Promise.all([
    loadParticipants(context.db, outingId),
    context.db.query<OptionRow>(
      `select id, title, activity, starts_at, estimated_cost_cents, activity_tags, source
         from outing_options where outing_id = $1
           and source in ('manual', 'agent') and visibility = 'shared'
         order by starts_at`,
      [outingId],
    ),
    context.db.query<PreferenceRow>(
      `select private_input, interpretation, interpretation_ready, rankings
         from participant_preferences where outing_id = $1 and user_id = $2`,
      [outingId, context.userId],
    ),
    listOwnMessages(context.db, outingId, context.userId),
    context.db.query<OfferRow>(
      `select f.id, f.owner_user_id, f.option_id, f.activity, f.starts_at, f.estimated_cost_cents,
              f.attendee_user_ids, f.activity_tags, f.private_note, f.counter_offer_to_id,
              f.status, f.created_at, o.title as option_title
         from offers f join outing_options o on o.id = f.option_id and o.outing_id = f.outing_id
        where f.outing_id = $1
          and o.source in ('manual', 'agent')
          and (o.visibility = 'shared' or
               (o.visibility = 'private' and o.source = 'agent'
                and f.owner_user_id = $2 and f.status = 'draft'))
          and (f.status = 'published' or f.owner_user_id = $2)
        order by f.created_at desc limit 40`,
      [outingId, context.userId],
    ),
    context.db.query<{ response_status: string; email_opt_in: boolean; notification_email: string | null }>(
      `select response_status, email_opt_in, notification_email
         from participants where outing_id = $1 and user_id = $2`,
      [outingId, context.userId],
    ),
    latestProposal(context.db, outingId, "published"),
    latestProposal(context.db, outingId, "confirmed"),
    latestExpiredProposal(context.db, outingId),
    context.db.query<NotificationRow>(
      `select n.id, n.kind, n.actor_user_id, p.display_name as actor_name, n.read_at, n.created_at
         from in_app_notifications n
         left join participants p on p.outing_id = n.outing_id and p.user_id = n.actor_user_id
        where n.outing_id = $1 and n.recipient_user_id = $2
        order by n.created_at desc limit 40`,
      [outingId, context.userId],
    ),
    context.db.query<{ event_type: string; status: string; error_code: string | null; created_at: string | Date }>(
      `select event_type, status, error_code, created_at from email_outbox
        where outing_id = $1 and recipient_user_id = $2
        order by created_at desc limit 20`,
      [outingId, context.userId],
    ),
    starter
      ? context.db.query<{ user_id: string; display_name: string; created_at: string | Date }>(
          `select user_id, display_name, created_at from participants
            where outing_id = $1 and admission_status = 'pending'
            order by created_at`,
          [outingId],
        )
      : Promise.resolve([]),
    context.db.query<{ status: string; proposal_id: string | null }>(
      `select status, proposal_id from join_requests where outing_id = $1 and user_id = $2`,
      [outingId, context.userId],
    ),
    context.db.query<{ status: string; proposal_id: string | null }>(
      `select status, proposal_id from departure_requests where outing_id = $1 and user_id = $2`,
      [outingId, context.userId],
    ),
    getPrivateTiePoll(context.db, outingId, context.userId),
  ]);

  const activeParticipants = participantsAll.filter(
    (participant) => participant.admissionStatus === "admitted",
  );
  const myProposalApproval = proposalPending
    ? await context.db.query<{ approved: boolean }>(
        `select exists (
           select 1 from proposal_approvals
            where proposal_id = $1 and revision = $2 and user_id = $3
         ) as approved`,
        [proposalPending.id, proposalPending.revision, context.userId],
      )
    : [];
  const ownPreferences = preferencesRows[0];
  const interpretation = ownPreferences?.interpretation
    ? parseJsonValue(ownPreferences.interpretation, emptyConditionInterpretation())
    : null;
  const allOffers = offersRows.filter((offer) => offer.status === "published");
  const ownDraftOffers = offersRows
    .filter((offer) => offer.owner_user_id === context.userId && offer.status === "draft")
    .map((offer) => ({
      ...toPublicOffer(offer),
      optionTitle: offer.option_title ?? offer.activity,
      privateNote: offer.private_note,
    }));

  return api(200, {
    viewerUserId: context.userId,
    outing: {
      id: outing.id,
      suggestion: outing.suggestion,
      cutoffAt: outing.cutoff_at ? new Date(outing.cutoff_at).toISOString() : null,
      cutoffTimeZone: outing.cutoff_time_zone,
      inviteToken: starter ? outing.invite_token : null,
      status: outing.status,
      cutoffProcessedAt: iso(outing.cutoff_processed_at),
      endedAt: iso(outing.ended_at),
      isStarter: starter,
      createdAt: new Date(outing.created_at).toISOString(),
    },
    participants: activeParticipants.map((participant) => ({
      userId: participant.user_id,
      displayName: participant.display_name,
    })),
    pendingAdmissions: pendingAdmissionsRows.map((participant) => ({
      userId: participant.user_id,
      displayName: participant.display_name,
      requestedAt: new Date(participant.created_at).toISOString(),
    })),
    options: optionsRows.map(toCatalogOption),
    myConditions: interpretation,
    myConditionsReady: ownPreferences?.interpretation_ready ?? false,
    myRankings: ownPreferences
      ? parseJsonValue(ownPreferences.rankings, [] as string[])
      : [],
    myResponseStatus: ownParticipantRows[0]?.response_status ?? "pending",
    myEmailOptIn: ownParticipantRows[0]?.email_opt_in ?? false,
    myNotificationEmail: ownParticipantRows[0]?.notification_email ?? null,
    messages: ownMessages,
    offers: allOffers.map(toPublicOffer),
    myDraftOffers: ownDraftOffers,
    proposal: proposalPending ? toProposal(proposalPending) : null,
    myProposalApproved: myProposalApproval[0]?.approved ?? false,
    confirmedProposal: proposalConfirmed ? toProposal(proposalConfirmed) : null,
    expiredProposal: proposalExpired ? toProposal(proposalExpired) : null,
    myJoinRequest: ownJoinRows[0] ?? null,
    myDepartureRequest: ownDepartureRows[0] ?? null,
    myTiePoll: tieRows,
    notifications: notificationsRows.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      actorUserId: notification.actor_user_id,
      actorName: notification.actor_name,
      readAt: iso(notification.read_at),
      createdAt: new Date(notification.created_at).toISOString(),
    })),
    myEmailEvents: emailRows.map((event) => ({
      eventType: event.event_type,
      status: event.status,
      errorCode: event.error_code,
      createdAt: new Date(event.created_at).toISOString(),
    })),
    myVerifiedEmails: context.verifiedEmails ?? [],
    emailProviderConfigured: process.env.AUTH_MODE !== "local" && Boolean(
      process.env.RESEND_API_KEY && process.env.RESEND_FROM && process.env.APP_BASE_URL,
    ),
  });
}

async function getPrivateTiePoll(db: Db, outingId: string, userId: string) {
  const rows = await db.query<{
    id: string;
    option_a_id: string;
    option_b_id: string;
    status: string;
    outcome: string | null;
    selected_option_id: string | null;
    participant_user_ids: unknown;
    created_at: string | Date;
    answer: "a" | "b" | "either" | null;
    answered_count: number | string;
    participant_count: number | string;
  }>(
    `select t.id, t.option_a_id, t.option_b_id, t.status, t.outcome,
            t.selected_option_id, t.participant_user_ids, t.created_at,
            own.answer,
            (select count(*)::int from tie_answers a where a.poll_id = t.id) as answered_count,
            jsonb_array_length(t.participant_user_ids)::int as participant_count
       from tie_polls t
       left join tie_answers own on own.poll_id = t.id and own.user_id = $2
      where t.outing_id = $1
        and t.participant_user_ids @> jsonb_build_array($2::text)
      order by t.created_at desc limit 1`,
    [outingId, userId],
  );
  const poll = rows[0];
  if (!poll) return null;
  const options = await db.query<OptionRow>(
    `select id, title, activity, starts_at, estimated_cost_cents, activity_tags, source, visibility
       from outing_options where id = any($1::uuid[])
         and source in ('manual', 'agent') and visibility = 'shared'`,
    [[poll.option_a_id, poll.option_b_id]],
  );
  const byId = new Map(options.map((option) => [option.id, toCatalogOption(option)]));
  return {
    id: poll.id,
    optionA: byId.get(poll.option_a_id) ?? null,
    optionB: byId.get(poll.option_b_id) ?? null,
    status: poll.status,
    outcome: poll.outcome,
    selectedOptionId: poll.selected_option_id,
    myAnswer: poll.answer,
    answeredCount: Number(poll.answered_count),
    participantCount: Number(poll.participant_count),
    createdAt: new Date(poll.created_at).toISOString(),
  };
}

export async function getInvitationStatus(
  context: OwnerContext,
  token: string,
): Promise<ApiResponse> {
  let outingRows = await context.db.query<{ id: string; starter_user_id: string; ended_at: string | Date | null }>(
    `select id, starter_user_id, ended_at from outings where invite_token = $1`,
    [token],
  );
  const initial = outingRows[0];
  if (initial) await processOutingDeadlines(context.db, initial.id);
  outingRows = await context.db.query<{ id: string; starter_user_id: string; ended_at: string | Date | null }>(
    `select id, starter_user_id, ended_at from outings where invite_token = $1`,
    [token],
  );
  const outing = outingRows[0];
  if (!outing || outing.ended_at || outing.starter_user_id === context.userId) {
    return api(404, { error: "not_found" });
  }
  const participant = await context.db.query<{ admission_status: string }>(
    `select admission_status from participants where outing_id = $1 and user_id = $2`,
    [outing.id, context.userId],
  );
  return api(200, {
    status: participant[0]?.admission_status ?? "not_requested",
    ...(participant[0]?.admission_status === "admitted" ? { outingId: outing.id } : {}),
  });
}

export async function requestAdmission(
  context: OwnerContext,
  token: string,
  input: unknown,
): Promise<ApiResponse> {
  const parsed = admissionRequestSchema.safeParse(input);
  if (!parsed.success) return api(400, { error: "invalid_input" });
  if (parsed.data.emailOptIn && !isVerifiedRecipient(context, parsed.data.email)) {
    return api(400, { error: "verified_email_required" });
  }
  let outingRows = await context.db.query<{ id: string; starter_user_id: string; ended_at: string | Date | null }>(
    `select id, starter_user_id, ended_at from outings where invite_token = $1`,
    [token],
  );
  const initial = outingRows[0];
  if (initial) await processOutingDeadlines(context.db, initial.id);
  outingRows = await context.db.query<{ id: string; starter_user_id: string; ended_at: string | Date | null }>(
    `select id, starter_user_id, ended_at from outings where invite_token = $1`,
    [token],
  );
  const outing = outingRows[0];
  if (!outing || outing.ended_at || outing.starter_user_id === context.userId) {
    return api(404, { error: "not_found" });
  }
  const participantId = crypto.randomUUID();
  const sessionId = `ses_${crypto.randomUUID()}`;
  const created = await context.db.query<{ admission_status: string }>(
    `with inserted as (
       insert into participants
         (outing_id, user_id, display_name, admission_status, response_status,
          agent_session_id, email_opt_in, notification_email)
       values ($1, $2, $3, 'pending', 'pending', $4, $5, $6)
       on conflict (outing_id, user_id) do nothing
       returning outing_id, user_id
     ), notice as (
       insert into in_app_notifications (id, outing_id, recipient_user_id, actor_user_id, kind, event_key)
       select $7, i.outing_id, $8, i.user_id, 'admission_request', i.user_id
         from inserted i
       on conflict do nothing
       returning id
     ), email as (
       insert into email_outbox
         (id, outing_id, recipient_user_id, event_type, event_key, status, recipient_email)
       select $9, i.outing_id, p.user_id, 'admission', i.user_id, 'pending', p.notification_email
         from inserted i
         join participants p on p.outing_id = i.outing_id and p.user_id = $8
        where p.email_opt_in = true and p.notification_email is not null
       on conflict do nothing
       returning id
     )
     select 'pending' as admission_status from inserted
     union all
     select p.admission_status from participants p
      where p.outing_id = $1 and p.user_id = $2
     limit 1`,
    [
      outing.id,
      context.userId,
      parsed.data.displayName,
      sessionId,
      parsed.data.emailOptIn,
      parsed.data.emailOptIn ? parsed.data.email?.trim().toLowerCase() ?? null : null,
      participantId,
      outing.starter_user_id,
      crypto.randomUUID(),
    ],
  );
  if (!created[0]) return api(404, { error: "not_found" });
  await context.db.query(
    `insert into participant_preferences (outing_id, user_id)
     values ($1, $2) on conflict (outing_id, user_id) do nothing`,
    [outing.id, context.userId],
  );
  const statusRows = await context.db.query<{ admission_status: string }>(
    `select admission_status from participants where outing_id = $1 and user_id = $2`,
    [outing.id, context.userId],
  );

  await dispatchOutbox(context.db, outing.id);
  return api(200, { status: statusRows[0]?.admission_status ?? "pending" });
}

export async function handlePlanningAction(
  context: OwnerContext,
  outingId: string,
  input: unknown,
  agentFactory: PlanningAgentFactory = getAgentSafely,
): Promise<ApiResponse> {
  const parsed = ActionSchema.safeParse(input);
  if (!parsed.success) return api(400, { error: "invalid_input" });
  const access = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!access) return api(404, { error: "not_found" });
  await processOutingDeadlines(context.db, outingId);
  const outing = await loadOuting(context.db, outingId);
  if (!outing) return api(404, { error: "not_found" });

  const action = parsed.data;
  let result: ApiResponse;
  switch (action.action) {
    case "decide_admission": result = await decideAdmission(context, outing, action.userId, action.decision); break;
    case "save_email_preferences": result = await saveEmailPreferences(context, outingId, {
      emailOptIn: action.emailOptIn,
      email: action.email,
    }); break;
    case "set_interest": result = await setInterest(context, outing, action.interested); break;
    case "add_option": result = await addOption(context, outingId, {
      title: action.title,
      activity: action.activity,
      startsAt: action.startsAt,
      estimatedCostCents: action.estimatedCostCents,
      activityTags: action.activityTags,
    }); break;
    case "rank_options": result = await rankOptions(context, outingId, action.optionIds); break;
    case "generate_offer": result = await generateOffer(context, outing, agentFactory); break;
    case "publish_offer": result = await publishOffer(context, outingId, action.offerId); break;
    case "publish_proposal": result = await publishProposal(context, outing, action.offerId, "initial"); break;
    case "replace_proposal": result = await publishProposal(context, outing, action.offerId, "initial", undefined, undefined, action.proposalId); break;
    case "approve_proposal": result = await approveProposal(context, outingId, action.proposalId, action.revision); break;
    case "restart_proposal": result = await restartProposal(context, outing, action.proposalId); break;
    case "start_tie_poll": result = await startTiePoll(context, outing, action.optionAId, action.optionBId); break;
    case "answer_tie": result = await answerTie(context, outingId, action.pollId, action.answer); break;
    case "request_join": result = await requestJoin(context, outing); break;
    case "request_departure": result = await requestDeparture(context, outing); break;
    case "end_outing": result = await endOuting(context, outing); break;
    case "declare_no_agreement": result = await declareNoAgreement(context, outing); break;
  }

  if (result.status >= 400) return result;
  const workspace = await getOutingWorkspace(context, outingId);
  return workspace.status === 200 ? api(result.status, { ...result.body, ...workspace.body }) : result;
}

type LoadedOuting = WorkspaceOutingRow;
export type PlanningAgentFactory = () => Agent | AgentError;

function getAgentSafely(): Agent | AgentError {
  try {
    return getAgent();
  } catch (error) {
    return error instanceof AgentError ? error : new AgentError("unavailable");
  }
}

async function decideAdmission(
  context: OwnerContext,
  outing: LoadedOuting,
  targetUserId: string,
  decision: "admit" | "reject",
): Promise<ApiResponse> {
  if (!(await isStarter(context.db, outing.id, context.userId))) {
    return api(404, { error: "not_found" });
  }
  const nextStatus = decision === "admit" ? "admitted" : "rejected";
  const changed = await context.db.query<{ user_id: string }>(
    `with changed as (
       update participants p set admission_status = $3
         from outings o
        where p.outing_id = o.id and p.outing_id = $1 and p.user_id = $2
          and p.admission_status = 'pending' and o.starter_user_id = $4
        returning p.outing_id, p.user_id
     ), notice as (
       insert into in_app_notifications (id, outing_id, recipient_user_id, actor_user_id, kind, event_key)
       select $5, c.outing_id, c.user_id, $4, 'admission_decision', $3
         from changed c
       on conflict do nothing
       returning id
     ), email as (
       insert into email_outbox
         (id, outing_id, recipient_user_id, event_type, event_key, status, recipient_email)
       select $6, c.outing_id, c.user_id, 'admission', $3, 'pending', p.notification_email
         from changed c
         join participants p on p.outing_id = c.outing_id and p.user_id = c.user_id
        where $3 = 'admitted' and p.email_opt_in = true and p.notification_email is not null
       on conflict do nothing
       returning id
     )
     select user_id from changed`,
    [outing.id, targetUserId, nextStatus, context.userId, crypto.randomUUID(), crypto.randomUUID()],
  );
  if (changed.length === 0) {
    const rows = await context.db.query<{ admission_status: string }>(
      `select admission_status from participants where outing_id = $1 and user_id = $2`,
      [outing.id, targetUserId],
    );
    if (!rows[0]) return api(404, { error: "not_found" });
    return api(409, { error: "admission_already_decided", status: rows[0].admission_status });
  }
  await dispatchOutbox(context.db, outing.id);
  return api(200, { ok: true });
}

async function saveEmailPreferences(
  context: OwnerContext,
  outingId: string,
  input: { emailOptIn: boolean; email: string | null },
): Promise<ApiResponse> {
  const parsed = emailPreferenceSchema.safeParse(input);
  if (!parsed.success) return api(400, { error: "invalid_input" });
  if (parsed.data.emailOptIn && !isVerifiedRecipient(context, parsed.data.email)) {
    return api(400, { error: "verified_email_required" });
  }
  await context.db.transaction([
    {
      text: `update participants set email_opt_in = $3, notification_email = $4
        where outing_id = $1 and user_id = $2 and admission_status = 'admitted'`,
      params: [outingId, context.userId, parsed.data.emailOptIn, parsed.data.emailOptIn ? parsed.data.email?.trim().toLowerCase() ?? null : null],
    },
    {
      text: `update email_outbox set status = 'suppressed', error_code = 'recipient_opted_out'
        where outing_id = $1 and recipient_user_id = $2
          and status in ('pending', 'failed', 'sending')
          and ($3 = false or recipient_email is distinct from $4)`,
      params: [outingId, context.userId, parsed.data.emailOptIn,
        parsed.data.emailOptIn ? parsed.data.email?.trim().toLowerCase() ?? null : null],
    },
  ]);
  return api(200, { ok: true });
}

async function setInterest(
  context: OwnerContext,
  outing: LoadedOuting,
  interested: boolean,
): Promise<ApiResponse> {
  if (outing.cutoff_processed_at || (outing.cutoff_at && new Date(outing.cutoff_at) <= new Date())) {
    return api(409, { error: "response_cutoff_passed" });
  }
  if (interested) {
    const preferences = await context.db.query<{ interpretation_ready: boolean; interpretation: unknown }>(
      `select interpretation_ready, interpretation from participant_preferences
        where outing_id = $1 and user_id = $2`,
      [outing.id, context.userId],
    );
    if (!preferences[0]?.interpretation_ready) {
      return api(409, { error: "conditions_need_review" });
    }
    const conditions = parseJsonValue(preferences[0].interpretation, emptyConditionInterpretation());
    if (conditions.clarifyingQuestions.length > 0) {
      return api(409, { error: "clarification_required" });
    }
  }
  const currentRows = await context.db.query<{ response_status: ParticipantRow["responseStatus"] }>(
    `select response_status from participants
      where outing_id = $1 and user_id = $2 and admission_status = 'admitted'`,
    [outing.id, context.userId],
  );
  const currentStatus = currentRows[0]?.response_status;
  if (!currentStatus) return api(404, { error: "not_found" });
  if (currentStatus === "no_response") return api(409, { error: "response_cutoff_passed" });
  const nextStatus = interested ? "interested" : "not_interested";
  if (currentStatus === nextStatus) return api(200, { ok: true });
  const changed = await context.db.query<{ user_id: string }>(
    `update participants set response_status = $3, responded_at = now()
      where outing_id = $1 and user_id = $2 and admission_status = 'admitted'
        and response_status = $4 and response_status <> 'no_response'
      returning user_id`,
    [outing.id, context.userId, nextStatus, currentStatus],
  );
  if (!changed.length) return api(409, { error: "response_changed" });
  await invalidatePublishedProposals(context.db, outing.id);
  return api(200, { ok: true });
}

async function addOption(
  context: OwnerContext,
  outingId: string,
  input: z.infer<typeof optionSchema>,
): Promise<ApiResponse> {
  const parsed = optionSchema.safeParse(input);
  if (!parsed.success) return api(400, { error: "invalid_input" });
  const tags = [...new Set(parsed.data.activityTags.map((tag) => tag.trim()))];
  await context.db.query(
    `insert into outing_options
      (id, outing_id, created_by_user_id, title, activity, starts_at, estimated_cost_cents, activity_tags, source)
     select $1, o.id, $2, $3, $4, $5::timestamptz, $6, $7::jsonb, 'manual'
       from outings o where o.id = $8 and o.ended_at is null`,
    [crypto.randomUUID(), context.userId, parsed.data.title, parsed.data.activity,
      parsed.data.startsAt, parsed.data.estimatedCostCents, JSON.stringify(tags), outingId],
  );
  return api(201, { ok: true });
}

async function rankOptions(
  context: OwnerContext,
  outingId: string,
  optionIds: string[],
): Promise<ApiResponse> {
  if (new Set(optionIds).size !== optionIds.length) return api(400, { error: "duplicate_option" });
  const options = await context.db.query<{ id: string }>(
    `select id from outing_options where outing_id = $1 and id = any($2::uuid[])
       and source in ('manual', 'agent') and visibility = 'shared'`,
    [outingId, optionIds],
  );
  if (options.length !== optionIds.length) return api(400, { error: "invalid_option" });
  await context.db.query(
    `insert into participant_preferences (outing_id, user_id, rankings, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (outing_id, user_id) do update
       set rankings = excluded.rankings, updated_at = now()`,
    [outingId, context.userId, JSON.stringify(optionIds)],
  );
  return api(200, { ok: true });
}

async function invalidatePublishedProposals(db: Db, outingId: string): Promise<void> {
  await db.query(
    `update proposals set status = 'superseded'
      where outing_id = $1 and status = 'published'`,
    [outingId],
  );
  await db.query(
    `update join_requests set status = 'expired'
      where outing_id = $1 and status = 'proposed'
        and proposal_id in (select id from proposals where outing_id = $1 and status = 'superseded')`,
    [outingId],
  );
  await db.query(
    `update departure_requests set status = 'expired'
      where outing_id = $1 and status = 'proposed'
        and proposal_id in (select id from proposals where outing_id = $1 and status = 'superseded')`,
    [outingId],
  );
}

async function generateOffer(
  context: OwnerContext,
  outing: LoadedOuting,
  agentFactory: PlanningAgentFactory,
): Promise<ApiResponse> {
  const agent = agentFactory();
  if (agent instanceof AgentError || !agent.generateOffer) {
    return api(503, { error: "agent_unavailable" });
  }
  const [ownRows, participants, optionsRows, offerRows, conditionRows, recentConversation] = await Promise.all([
    context.db.query<PreferenceRow & { agent_session_id: string }>(
      `select pref.private_input, pref.interpretation, pref.interpretation_ready, pref.rankings,
              p.agent_session_id
         from participants p
         join participant_preferences pref on pref.outing_id = p.outing_id and pref.user_id = p.user_id
        where p.outing_id = $1 and p.user_id = $2 and p.admission_status = 'admitted'`,
      [outing.id, context.userId],
    ),
    context.db.query<ParticipantRow>(
      `select user_id, display_name, admission_status, response_status, responded_at
         from participants where outing_id = $1 and admission_status = 'admitted'
         order by created_at`,
      [outing.id],
    ).then((rows) => rows.map(toParticipantRow)),
    context.db.query<OptionRow>(
      `select id, title, activity, starts_at, estimated_cost_cents, activity_tags, source, visibility
         from outing_options where outing_id = $1
           and source in ('manual', 'agent') and visibility = 'shared'
         order by starts_at`,
      [outing.id],
    ),
    context.db.query<OfferRow>(
      `select f.id, f.owner_user_id, f.option_id, f.activity, f.starts_at, f.estimated_cost_cents,
              f.attendee_user_ids, f.activity_tags, f.private_note, f.counter_offer_to_id,
              f.status, f.created_at
         from offers f join outing_options o on o.id = f.option_id and o.outing_id = f.outing_id
        where f.outing_id = $1 and f.status = 'published'
          and o.source in ('manual', 'agent') and o.visibility = 'shared'
        order by f.created_at desc limit 30`,
      [outing.id],
    ),
    loadConditionRows(context.db, outing.id),
    loadRecentOwnerConversation(context.db, outing.id, context.userId),
  ]);
  const own = ownRows[0];
  if (!own?.interpretation_ready || !own.interpretation) {
    return api(409, { error: "conditions_need_review" });
  }
  const conditions = parseJsonValue(own.interpretation, emptyConditionInterpretation());
  if (conditions.clarifyingQuestions.length > 0) {
    return api(409, { error: "clarification_required" });
  }
  const interested = participants.filter((participant) => participant.responseStatus === "interested");
  if (!interested.some((participant) => participant.user_id === context.userId)) {
    return api(409, { error: "interest_required" });
  }
  const options = optionsRows.map(toCatalogOption);

  const tieRows = await context.db.query<{
    option_a_id: string;
    option_b_id: string;
    outcome: "a" | "b" | "either" | null;
    selected_option_id: string | null;
    participant_user_ids: unknown;
  }>(
    `select option_a_id, option_b_id, outcome, selected_option_id, participant_user_ids from tie_polls
      where outing_id = $1 and status = 'resolved'
        and participant_user_ids @> jsonb_build_array($2::text)
      order by resolved_at desc limit 1`,
    [outing.id, context.userId],
  );
  const tie = tieRows[0];
  const tieContext = tie
    ? {
        optionIds: [tie.option_a_id, tie.option_b_id],
        everyoneAnsweredEither: tie.outcome === "either",
        selectedOptionId: tie.selected_option_id,
        participantUserIds: parseJsonValue(tie.participant_user_ids, [] as string[]),
      }
    : undefined;

  try {
    const candidate = await agent.generateOffer({
      outing: {
        suggestion: outing.suggestion,
        cutoffAt: outing.cutoff_at ? new Date(outing.cutoff_at).toISOString() : null,
        cutoffTimeZone: outing.cutoff_time_zone,
      },
      sessionId: own.agent_session_id,
      participantUserId: context.userId,
      privateInput: own.private_input,
      privateConditions: conditions,
      recentConversation,
      privateRankings: parseJsonValue(own.rankings, [] as string[])
        .filter((optionId) => options.some((option) => option.id === optionId)),
      options,
      participants: interested.map((participant) => ({
        userId: participant.user_id,
        displayName: participant.display_name,
      })),
      approvedOffers: offerRows.map(toPublicOffer),
      tieContext,
    });
    const parsedResult = OfferGenerationResultSchema.safeParse(candidate);
    if (!parsedResult.success) {
      return api(502, {
        error: "invalid_output",
        fields: parsedResult.error.issues.map((issue) => issue.path.join(".")),
      });
    }
    if ("kind" in parsedResult.data && parsedResult.data.kind === "clarification") {
      return api(409, {
        error: "clarification_required",
        question: parsedResult.data.question,
      });
    }
    const draftOption = "kind" in parsedResult.data ? parsedResult.data.option : null;
    const validCandidate: OfferCandidate = draftOption
      ? {
          optionId: crypto.randomUUID(),
          activity: draftOption.activity,
          startsAt: draftOption.startsAt,
          estimatedCostCents: draftOption.estimatedCostCents,
          activityTags: draftOption.activityTags,
          attendeeUserIds: parsedResult.data.attendeeUserIds,
          counterOfferToId: parsedResult.data.counterOfferToId,
          privateNote: parsedResult.data.privateNote,
        }
      : parsedResult.data as OfferCandidate;
    if (draftOption && (
      new Date(draftOption.startsAt) <= new Date() ||
      (outing.cutoff_at !== null && new Date(draftOption.startsAt) <= new Date(outing.cutoff_at))
    )) return api(409, { error: "offer_not_feasible", reason: "activity_time_invalid" });
    if (tieContext) {
      const selectedAttendees = [...validCandidate.attendeeUserIds].sort();
      const tiedAttendees = [...tieContext.participantUserIds].sort();
      if (
        selectedAttendees.length !== tiedAttendees.length ||
        selectedAttendees.some((id, index) => id !== tiedAttendees[index]) ||
        (tieContext.selectedOptionId !== null && validCandidate.optionId !== tieContext.selectedOptionId) ||
        (tieContext.everyoneAnsweredEither && !tieContext.optionIds.includes(validCandidate.optionId))
      ) return api(409, { error: "tie_choice_required" });
    }
    if (validCandidate.counterOfferToId !== null) {
      const referencedOffer = offerRows.find(
        (offer) => offer.id === validCandidate.counterOfferToId && offer.owner_user_id !== context.userId,
      );
      if (!referencedOffer) return api(409, { error: "counter_offer_target_unavailable" });
    }
    const option = draftOption
      ? {
          id: validCandidate.optionId,
          activity: draftOption.activity,
          startsAt: draftOption.startsAt,
          estimatedCostCents: draftOption.estimatedCostCents,
          activityTags: draftOption.activityTags,
        }
      : options.find((item) => item.id === validCandidate.optionId) ?? null;
    const eligibility = validateCandidate(
      validCandidate,
      context.userId,
      option,
      participants,
      conditionRows,
    );
    if (!eligibility.ok) {
      console.warn("[offer-candidate-ineligible]", eligibility.reason);
      return api(409, {
        error: eligibility.reason === "conditions_incomplete" ? "conditions_need_review" : "offer_not_feasible",
        reason: eligibility.reason,
      });
    }
    const offerId = crypto.randomUUID();
    const created = draftOption
      ? await context.db.query<{ id: string }>(
          `with active_outing as materialized (
             select o.id from outings o
              where o.id = $1 and o.ended_at is null
                and exists (select 1 from participants p where p.outing_id = o.id
                             and p.user_id = $3 and p.admission_status = 'admitted'
                             and p.response_status = 'interested')
           ), inserted_option as (
             insert into outing_options
               (id, outing_id, created_by_user_id, title, activity, starts_at,
                estimated_cost_cents, activity_tags, source, visibility)
             select $2, o.id, $3, $4, $5, $6::timestamptz, $7, $8::jsonb, 'agent', 'private'
               from active_outing o
             returning id, outing_id
           )
           insert into offers
             (id, outing_id, owner_user_id, option_id, activity, starts_at,
              estimated_cost_cents, attendee_user_ids, activity_tags, private_note,
              counter_offer_to_id, status)
           select $9, option.outing_id, $3, option.id, $5, $6::timestamptz,
                  $7, $10::jsonb, $8::jsonb, $11, $12, 'draft'
             from inserted_option option
           returning id`,
          [outing.id, validCandidate.optionId, context.userId, draftOption.title,
            validCandidate.activity, validCandidate.startsAt, validCandidate.estimatedCostCents,
            JSON.stringify(validCandidate.activityTags), offerId,
            JSON.stringify(validCandidate.attendeeUserIds), validCandidate.privateNote,
            validCandidate.counterOfferToId],
        )
      : await context.db.query<{ id: string }>(
          `insert into offers
            (id, outing_id, owner_user_id, option_id, activity, starts_at,
             estimated_cost_cents, attendee_user_ids, activity_tags, private_note,
             counter_offer_to_id, status)
           select $1, o.id, $2, $3, $4, $5::timestamptz, $6, $7::jsonb,
                  $8::jsonb, $9, $10, 'draft'
             from outings o
            where o.id = $11 and o.ended_at is null
              and exists (select 1 from participants p where p.outing_id = o.id
                           and p.user_id = $2 and p.admission_status = 'admitted'
                           and p.response_status = 'interested')
              and exists (select 1 from outing_options option
                           where option.id = $3 and option.outing_id = o.id
                             and option.source in ('manual', 'agent')
                             and option.visibility = 'shared')
           returning id`,
          [offerId, context.userId, validCandidate.optionId, validCandidate.activity,
            validCandidate.startsAt, validCandidate.estimatedCostCents,
            JSON.stringify(validCandidate.attendeeUserIds),
            JSON.stringify(validCandidate.activityTags), validCandidate.privateNote,
            validCandidate.counterOfferToId, outing.id],
        );
    if (!created.length) return api(409, { error: "outing_not_active" });
    return api(201, {
      offer: {
        id: offerId,
        optionId: validCandidate.optionId,
        activity: validCandidate.activity,
        startsAt: validCandidate.startsAt,
        estimatedCostCents: validCandidate.estimatedCostCents,
        attendeeUserIds: validCandidate.attendeeUserIds,
        activityTags: validCandidate.activityTags,
        privateNote: validCandidate.privateNote,
      },
    });
  } catch (error) {
    const code = error instanceof AgentError ? error.code : "model_error";
    if (code === "no_feasible_options") {
      return api(409, { error: "offer_not_feasible" });
    }
    console.error("offer generation failed", code);
    return api(code === "unavailable" ? 503 : 502, {
      error: code,
      ...(code === "invalid_output" && error instanceof AgentError
        ? { detail: error.message }
        : {}),
    });
  }
}

async function loadRecentOwnerConversation(
  db: Db,
  outingId: string,
  ownerUserId: string,
): Promise<PrivateConversationMessage[]> {
  const rows = await db.query<PrivateConversationMessage>(
    `select role, content from messages
      where outing_id = $1 and owner_user_id = $2
        and ((role = 'user' and status in ('pending', 'replied', 'failed'))
          or (role = 'agent' and status = 'complete'))
      order by seq desc limit $3`,
    [outingId, ownerUserId, RECENT_OFFER_CONVERSATION_MESSAGE_LIMIT],
  );
  let remainingChars = RECENT_OFFER_CONVERSATION_TOTAL_CHARS;
  const recentNewestFirst: PrivateConversationMessage[] = [];
  for (const row of rows) {
    if (remainingChars <= 0) break;
    const content = row.content.slice(
      0,
      Math.min(RECENT_OFFER_CONVERSATION_MESSAGE_CHARS, remainingChars),
    );
    recentNewestFirst.push({ role: row.role, content });
    remainingChars -= content.length;
  }
  return recentNewestFirst.reverse();
}

async function publishOffer(
  context: OwnerContext,
  outingId: string,
  offerId: string,
): Promise<ApiResponse> {
  const rows = await context.db.query<OfferRow>(
    `select id, owner_user_id, option_id, activity, starts_at, estimated_cost_cents,
            attendee_user_ids, activity_tags, private_note, counter_offer_to_id, status, created_at
       from offers where id = $1 and outing_id = $2 and owner_user_id = $3`,
    [offerId, outingId, context.userId],
  );
  const offer = rows[0];
  if (!offer) return api(404, { error: "not_found" });
  if (offer.status === "published") return api(200, { ok: true });
  if (offer.status !== "draft") return api(409, { error: "offer_not_available" });
  const validation = await validateStoredOffer(context.db, outingId, context.userId, offer);
  if (!validation.ok) {
    return validation.reason === "option_unavailable"
      ? api(409, { error: "option_unavailable" })
      : api(409, { error: "offer_not_feasible", reason: validation.reason });
  }
  const updated = await context.db.query<{ id: string }>(
    `with eligible as materialized (
       select f.id, f.outing_id, f.option_id
         from offers f
         join outing_options o on o.id = f.option_id and o.outing_id = f.outing_id
        where f.id = $1 and f.outing_id = $2 and f.owner_user_id = $3 and f.status = 'draft'
          and o.source in ('manual', 'agent')
          and (o.visibility = 'shared' or
               (o.visibility = 'private' and o.source = 'agent' and o.created_by_user_id = $3))
          and exists (select 1 from outings where id = $2 and ended_at is null)
        for update of f, o
     ), promoted as (
       update outing_options o set visibility = 'shared'
         from eligible e where o.id = e.option_id
       returning o.id
     )
     update offers f set status = 'published', published_at = now()
       from promoted p
      where f.id = $1 and f.outing_id = $2 and f.owner_user_id = $3
        and f.option_id = p.id and f.status = 'draft'
      returning f.id`,
    [offerId, outingId, context.userId],
  );
  return updated.length ? api(200, { ok: true }) : api(409, { error: "offer_not_available" });
}

async function validateStoredOffer(
  db: Db,
  outingId: string,
  ownerUserId: string,
  row: OfferRow,
) {
  const optionRows = await db.query<OptionRow>(
    `select id, title, activity, starts_at, estimated_cost_cents, activity_tags, source, visibility,
            created_by_user_id
       from outing_options where id = $1 and outing_id = $2`,
    [row.option_id, outingId],
  );
  const option = optionRows[0];
  const optionIsPublished = option &&
    (option.source === "manual" || option.source === "agent") && option.visibility === "shared";
  const optionIsOwnDraft = option && row.status === "draft" && option.source === "agent" &&
    option.visibility === "private" && option.created_by_user_id === ownerUserId;
  if (!optionIsPublished && !optionIsOwnDraft) {
    return { ok: false as const, reason: "option_unavailable" as const, versions: {} };
  }
  const [participants, conditions] = await Promise.all([
    loadParticipants(db, outingId),
    loadConditionRows(db, outingId),
  ]);
  const candidate: OfferCandidate = {
    optionId: row.option_id,
    activity: row.activity,
    startsAt: new Date(row.starts_at).toISOString(),
    estimatedCostCents: row.estimated_cost_cents,
    activityTags: parseJsonValue(row.activity_tags, [] as string[]),
    attendeeUserIds: parseJsonValue(row.attendee_user_ids, [] as string[]),
    counterOfferToId: row.counter_offer_to_id,
    privateNote: row.private_note,
  };
  const validation = validateCandidate(
    candidate,
    ownerUserId,
    optionRows[0]
      ? {
          id: optionRows[0].id,
          activity: optionRows[0].activity,
          startsAt: new Date(optionRows[0].starts_at).toISOString(),
          estimatedCostCents: optionRows[0].estimated_cost_cents,
          activityTags: parseJsonValue(optionRows[0].activity_tags, [] as string[]),
        }
      : null,
    participants,
    conditions,
  );
  return {
    ...validation,
    versions: conditionVersionsFor(conditions, candidate.attendeeUserIds),
  };
}

async function tieAllowsCandidate(
  db: Db,
  outingId: string,
  optionId: string,
  attendeeUserIds: string[],
): Promise<boolean> {
  const rows = await db.query<{
    outcome: "a" | "b" | "either" | null;
    selected_option_id: string | null;
    option_a_id: string;
    option_b_id: string;
    participant_user_ids: unknown;
  }>(
    `select outcome, selected_option_id, option_a_id, option_b_id, participant_user_ids
       from tie_polls where outing_id = $1 and status = 'resolved'
       order by resolved_at desc limit 1`,
    [outingId],
  );
  const tie = rows[0];
  if (!tie) return true;
  const tiedIds = parseJsonValue(tie.participant_user_ids, [] as string[]).sort();
  const candidateIds = [...attendeeUserIds].sort();
  if (
    tiedIds.length !== candidateIds.length ||
    tiedIds.some((userId, index) => userId !== candidateIds[index])
  ) {
    return false;
  }
  if (tie.outcome === "a" || tie.outcome === "b") {
    return tie.selected_option_id === optionId;
  }
  if (tie.outcome === "either") {
    return [tie.option_a_id, tie.option_b_id].includes(optionId);
  }
  return false;
}

async function publishProposal(
  context: OwnerContext,
  outing: LoadedOuting,
  offerId: string,
  kind: "initial" | "restart" | "join" | "departure",
  requestId?: string,
  attendeeOverride?: string[],
  expectedActiveProposalId?: string,
): Promise<ApiResponse> {
  if (outing.ended_at || outing.status === "no_agreement") {
    return api(409, { error: "outing_not_active" });
  }
  const confirmed = await latestProposal(context.db, outing.id, "confirmed");
  if (kind === "initial" && confirmed) return api(409, { error: "plan_already_confirmed" });
  const rows = await context.db.query<OfferRow>(
    `select id, owner_user_id, option_id, activity, starts_at, estimated_cost_cents,
            attendee_user_ids, activity_tags, private_note, counter_offer_to_id, status, created_at
       from offers where id = $1 and outing_id = $2 and status = 'published'`,
    [offerId, outing.id],
  );
  const offer = rows[0];
  if (!offer) return api(404, { error: "not_found" });

  const originalAttendees = parseJsonValue(offer.attendee_user_ids, [] as string[]);
  const attendeeUserIds = attendeeOverride ?? originalAttendees;
  if (!(await tieAllowsCandidate(context.db, outing.id, offer.option_id, attendeeUserIds))) {
    return api(409, { error: "tie_choice_required" });
  }
  const candidate: OfferCandidate = {
    optionId: offer.option_id,
    activity: offer.activity,
    startsAt: new Date(offer.starts_at).toISOString(),
    estimatedCostCents: offer.estimated_cost_cents,
    activityTags: parseJsonValue(offer.activity_tags, [] as string[]),
    attendeeUserIds,
    counterOfferToId: offer.counter_offer_to_id,
    privateNote: "",
  };
  const eligibility = await validateStoredOfferForAttendees(
    context.db,
    outing.id,
    offer.owner_user_id,
    offer,
    attendeeUserIds,
  );
  if (!eligibility.ok) {
    if (eligibility.reason === "option_unavailable") return api(409, { error: "option_unavailable" });
    return api(409, { error: eligibility.reason === "conditions_incomplete" ? "conditions_need_review" : "offer_not_feasible" });
  }
  if (new Date(candidate.startsAt) <= new Date()) return api(409, { error: "activity_already_started" });
  const active = kind === "initial"
    ? await latestProposal(context.db, outing.id, "published")
    : null;
  if (active) {
    if (matchesProposalRequest(active, offer, attendeeUserIds, eligibility.versions)) {
      return api(200, { proposal: toProposal(active) });
    }
    if (expectedActiveProposalId !== active.id) {
      return api(409, { error: expectedActiveProposalId ? "proposal_not_current" : "proposal_already_active" });
    }
  } else if (expectedActiveProposalId) {
    return api(409, { error: "proposal_not_current" });
  }
  return createProposalRevision(context, outing, {
    optionId: offer.option_id,
    activity: offer.activity,
    startsAt: candidate.startsAt,
    estimatedCostCents: offer.estimated_cost_cents,
    attendeeUserIds,
    kind,
    requestId,
    requestUserId: requestId ? context.userId : undefined,
    expectedConfirmedId: confirmed?.id ?? null,
    expectedPublishedId: expectedActiveProposalId,
    requireNoPublished: kind === "initial" && !expectedActiveProposalId,
    expectedConditions: eligibility.versions,
  });
}

async function createProposalRevision(
  context: OwnerContext,
  outing: LoadedOuting,
  input: {
    optionId: string;
    activity: string;
    startsAt: string;
    estimatedCostCents: number;
    attendeeUserIds: string[];
    kind: "initial" | "restart" | "join" | "departure";
    requestId?: string;
    requestUserId?: string;
    expectedConfirmedId?: string | null;
    expectedPublishedId?: string;
    requireNoPublished?: boolean;
    expectedConditions?: Record<string, number>;
  },
): Promise<ApiResponse> {
  const proposalId = crypto.randomUUID();
  const confirmedGuard = input.expectedConfirmedId === undefined
    ? ""
    : `and (($11::uuid is null and not exists (
           select 1 from proposals current where current.outing_id = o.id and current.status = 'confirmed'
         )) or exists (
           select 1 from proposals current where current.outing_id = o.id
             and current.id = $11::uuid and current.status = 'confirmed'
         ))`;
  const publishedGuard = input.expectedPublishedId
    ? `and exists (
         select 1 from proposals current where current.outing_id = o.id
           and current.id = $12::uuid and current.status = 'superseded'
       )
       and not exists (
         select 1 from proposals current where current.outing_id = o.id and current.status = 'published'
       )`
    : input.requireNoPublished
      ? `and not exists (
           select 1 from proposals current where current.outing_id = o.id and current.status = 'published'
         )`
      : "";
  const supersedeConfirmedGuard = input.expectedConfirmedId === undefined
    ? ""
    : `and (($2::uuid is null and not exists (
           select 1 from proposals current where current.outing_id = proposals.outing_id and current.status = 'confirmed'
         )) or exists (
           select 1 from proposals current where current.outing_id = proposals.outing_id
             and current.id = $2::uuid and current.status = 'confirmed'
         ))`;
  const supersedePublishedGuard = input.expectedPublishedId
    ? `and id = $4::uuid`
    : input.requireNoPublished
      ? `and not exists (
           select 1 from proposals current where current.outing_id = proposals.outing_id and current.status = 'published'
         )`
      : "";
  const supersedeParams = [outing.id, input.expectedConfirmedId ?? null, input.startsAt];
  const supersedeConditionsGuard = input.expectedPublishedId
    ? `and not exists (
         select 1 from jsonb_each_text($5::jsonb) expected(user_id, version)
         left join participant_preferences pref
           on pref.outing_id = proposals.outing_id and pref.user_id = expected.user_id
         where pref.user_id is null
           or coalesce(pref.conditions_version, 0) <> expected.version::int
       )`
    : "";
  const insertParams: unknown[] = [proposalId, outing.id, context.userId, input.optionId, input.activity,
    input.startsAt, input.estimatedCostCents, JSON.stringify(input.attendeeUserIds), input.kind,
    JSON.stringify(input.expectedConditions ?? {})];
  if (input.expectedConfirmedId !== undefined) insertParams.push(input.expectedConfirmedId);
  if (input.expectedPublishedId) {
    supersedeParams.push(input.expectedPublishedId);
    supersedeParams.push(JSON.stringify(input.expectedConditions ?? {}));
    insertParams.push(input.expectedPublishedId);
  }
  const statements = [
    { text: `select id from outings where id = $1 for update`, params: [outing.id] },
    { text: `update proposals set status = 'superseded'
      where outing_id = $1 and status = 'published'
        and exists (select 1 from outings where id = $1 and ended_at is null)
        and $3::timestamptz > now()
        ${supersedeConfirmedGuard} ${supersedePublishedGuard} ${supersedeConditionsGuard}`,
      params: supersedeParams},
    {
      text: `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at, condition_versions)
       select $1, o.id, coalesce(max(prev.revision), 0) + 1, $3, $4, $5, $6::timestamptz,
              $7, $8::jsonb, 'published', $9, now(),
              least(now() + interval '30 minutes', $6::timestamptz), $10::jsonb
         from outings o left join proposals prev on prev.outing_id = o.id
        where o.id = $2 and o.ended_at is null and $6::timestamptz > now()
          ${confirmedGuard} ${publishedGuard}
          and not exists (
            select 1 from jsonb_each_text($10::jsonb) expected(user_id, version)
            left join participant_preferences pref
              on pref.outing_id = o.id and pref.user_id = expected.user_id
            where pref.user_id is null
              or coalesce(pref.conditions_version, 0) <> expected.version::int
          )
        group by o.id returning id, revision, published_at, expires_at`,
      params: insertParams,
    },
    {
      text: `insert into in_app_notifications (id, outing_id, recipient_user_id, actor_user_id, kind, event_key)
       select gen_random_uuid(), p.outing_id, member.user_id, $2, 'proposal_ready', p.id::text
         from proposals p cross join lateral jsonb_array_elements_text(p.attendee_user_ids) member(user_id)
        where p.id = $1 on conflict do nothing`,
      params: [proposalId, context.userId],
    },
    {
      text: `update join_requests set status = 'expired'
        where outing_id = $1 and status = 'proposed'
          and proposal_id in (select id from proposals where outing_id = $1 and status = 'superseded')
          and exists (select 1 from proposals where id = $2 and status = 'published')`,
      params: [outing.id, proposalId],
    },
    {
      text: `update departure_requests set status = 'expired'
        where outing_id = $1 and status = 'proposed'
          and proposal_id in (select id from proposals where outing_id = $1 and status = 'superseded')
          and exists (select 1 from proposals where id = $2 and status = 'published')`,
      params: [outing.id, proposalId],
    },
    ...(input.requestId && input.kind === "join"
      ? [{
          text: `update join_requests set status = 'proposed', proposal_id = $2
            where id = $1 and outing_id = $3 and user_id = $4
              and exists (
                select 1 from proposals where id = $2 and outing_id = $3 and status = 'published'
              )`,
          params: [input.requestId, proposalId, outing.id, input.requestUserId ?? context.userId],
        }]
      : []),
    ...(input.requestId && input.kind === "departure"
      ? [{
          text: `update departure_requests set status = 'proposed', proposal_id = $2
            where id = $1 and outing_id = $3 and user_id = $4
              and exists (
                select 1 from proposals where id = $2 and outing_id = $3 and status = 'published'
              )`,
          params: [input.requestId, proposalId, outing.id, input.requestUserId ?? context.userId],
        }]
      : []),
  ];
  const created = await context.db.transaction<ProposalRow>(statements);
  const proposal = created[2]?.[0] as Pick<ProposalRow, "id" | "revision" | "published_at" | "expires_at"> | undefined;
  if (!proposal) {
    if (input.expectedPublishedId) {
      const confirmed = await latestProposal(context.db, outing.id, "confirmed");
      return confirmed
        ? api(409, { error: "plan_already_confirmed" })
        : api(409, { error: "proposal_not_current" });
    }
    if (input.expectedConfirmedId === null && input.requireNoPublished) {
      const confirmed = await latestProposal(context.db, outing.id, "confirmed");
      if (confirmed) return api(409, { error: "plan_already_confirmed" });
      const published = await latestProposal(context.db, outing.id, "published");
      return published
        ? api(409, { error: "proposal_already_active" })
        : api(409, { error: "activity_already_started" });
    }
    if (input.requireNoPublished && await latestProposal(context.db, outing.id, "published")) {
      return api(409, { error: "proposal_already_active" });
    }
    if (input.expectedConfirmedId === null) return api(409, { error: "plan_already_confirmed" });
    if (input.expectedConfirmedId !== undefined) return api(409, { error: "plan_changed" });
    return api(409, { error: "activity_already_started" });
  }
  return api(201, {
    proposal: {
      id: proposal.id,
      revision: proposal.revision,
      publishedAt: new Date(proposal.published_at).toISOString(),
      expiresAt: new Date(proposal.expires_at).toISOString(),
    },
  });
}

async function validateStoredOfferForAttendees(
  db: Db,
  outingId: string,
  ownerUserId: string,
  offer: OfferRow,
  attendeeUserIds: string[],
) {
  const revised = { ...offer, attendee_user_ids: attendeeUserIds };
  return validateStoredOffer(db, outingId, ownerUserId, revised);
}

async function approveProposal(
  context: OwnerContext,
  outingId: string,
  proposalId: string,
  revision: number,
): Promise<ApiResponse> {
  const inserted = await context.db.query<{ user_id: string }>(
    `insert into proposal_approvals (proposal_id, outing_id, user_id, revision)
     select p.id, p.outing_id, $3, p.revision
       from proposals p join participants member
         on member.outing_id = p.outing_id and member.user_id = $3
      where p.id = $1 and p.outing_id = $2 and p.revision = $4
        and p.status = 'published' and p.expires_at > now()
        and member.admission_status = 'admitted'
        and p.attendee_user_ids @> jsonb_build_array($3::text)
     on conflict (proposal_id, user_id) do nothing
     returning user_id`,
    [proposalId, outingId, context.userId, revision],
  );
  const finalized = await finalizeProposalIfReady(context.db, outingId, proposalId, revision);
  if (!finalized) {
    if (await proposalConditionsChanged(context.db, outingId, proposalId)) {
      await context.db.query(
        `update proposals set status = 'expired'
          where id = $1 and outing_id = $2 and status = 'published'`,
        [proposalId, outingId],
      );
      return api(409, { error: "conditions_changed" });
    }
    const current = await context.db.query<{ status: string; expires_at: string | Date }>(
      `select status, expires_at from proposals where id = $1 and outing_id = $2`,
      [proposalId, outingId],
    );
    if (!current[0]) return api(404, { error: "not_found" });
    if (new Date(current[0].expires_at) <= new Date() || current[0].status === "expired") {
      return api(409, { error: "proposal_expired" });
    }
    if (current[0].status !== "published") return api(409, { error: "proposal_not_current" });
    if (!inserted.length) {
      const ownApproval = await context.db.query<{ user_id: string }>(
        `select user_id from proposal_approvals where proposal_id = $1 and user_id = $2`,
        [proposalId, context.userId],
      );
      if (!ownApproval.length) return api(403, { error: "not_in_proposal" });
    }
    return api(200, { approved: true, status: "awaiting_others" });
  }
  await dispatchOutbox(context.db, outingId);
  return api(200, { approved: true, status: "confirmed" });
}

async function proposalConditionsChanged(
  db: Db,
  outingId: string,
  proposalId: string,
): Promise<boolean> {
  const rows = await db.query<{ changed: boolean }>(
    `select exists (
       select 1 from proposals p
       cross join lateral jsonb_array_elements_text(p.attendee_user_ids) attendee(user_id)
       left join participant_preferences pref
         on pref.outing_id = p.outing_id and pref.user_id = attendee.user_id
      where p.id = $1 and p.outing_id = $2
        and (pref.user_id is null
          or pref.interpretation_ready is not true
          or coalesce(pref.conditions_version, 0)
             <> coalesce((p.condition_versions->>attendee.user_id)::int, -1))
     ) as changed`,
    [proposalId, outingId],
  );
  return Boolean(rows[0]?.changed);
}

async function finalizeProposalIfReady(
  db: Db,
  outingId: string,
  proposalId: string,
  revision: number,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `with active_outing as materialized (
       select id from outings where id = $2 and ended_at is null for update
     ), confirmed as (
       update proposals p set status = 'confirmed', confirmed_at = now()
        where p.id = $1 and p.outing_id = $2 and p.revision = $3
          and p.outing_id in (select id from active_outing)
          and p.status = 'published' and p.expires_at > now()
          and not exists (
            select 1 from jsonb_array_elements_text(p.attendee_user_ids) attendee(user_id)
             where not exists (
               select 1 from proposal_approvals a
                where a.proposal_id = p.id and a.revision = p.revision
                  and a.user_id = attendee.user_id
             )
          )
          and not exists (
            select 1 from jsonb_array_elements_text(p.attendee_user_ids) attendee(user_id)
             left join participants member
               on member.outing_id = p.outing_id and member.user_id = attendee.user_id
            where member.admission_status is distinct from 'admitted'
          )
          and not exists (
            select 1 from jsonb_array_elements_text(p.attendee_user_ids) attendee(user_id)
             left join participant_preferences pref
               on pref.outing_id = p.outing_id and pref.user_id = attendee.user_id
            where pref.user_id is null
              or pref.interpretation_ready is not true
              or coalesce(pref.conditions_version, 0)
                 <> coalesce((p.condition_versions->>attendee.user_id)::int, -1)
          )
        returning p.id, p.outing_id, p.attendee_user_ids
     ), old_confirmed as (
       update proposals old set status = 'superseded'
         from confirmed current
        where old.outing_id = current.outing_id and old.id <> current.id and old.status = 'confirmed'
        returning old.id
     ), outing_update as (
       update outings o set status = 'confirmed'
         from confirmed current where o.id = current.outing_id
        returning o.id
     ), accepted_joins as (
       update join_requests set status = 'accepted'
        where proposal_id in (select id from confirmed) returning id
     ), accepted_departures as (
       update departure_requests set status = 'accepted'
        where proposal_id in (select id from confirmed) returning id
     ), notices as (
       insert into in_app_notifications (id, outing_id, recipient_user_id, actor_user_id, kind, event_key)
       select gen_random_uuid(), current.outing_id, attendee.user_id, null, 'proposal_confirmed', current.id::text
         from confirmed current cross join lateral jsonb_array_elements_text(current.attendee_user_ids) attendee(user_id)
       on conflict do nothing returning id
     ), emails as (
       insert into email_outbox
         (id, outing_id, recipient_user_id, event_type, event_key, status, recipient_email)
       select gen_random_uuid(), current.outing_id, member.user_id, 'final_approval',
              current.id::text, 'pending', member.notification_email
         from confirmed current
         cross join lateral jsonb_array_elements_text(current.attendee_user_ids) attendee(user_id)
         join participants member on member.outing_id = current.outing_id and member.user_id = attendee.user_id
        where member.email_opt_in = true and member.notification_email is not null
       on conflict do nothing returning id
     )
     select id from confirmed`,
    [proposalId, outingId, revision],
  );
  return rows.length > 0;
}

async function restartProposal(
  context: OwnerContext,
  outing: LoadedOuting,
  expiredProposalId: string,
): Promise<ApiResponse> {
  const rows = await context.db.query<ProposalRow>(
    `select p.*, (select count(*)::int from proposal_approvals a where a.proposal_id = p.id) as approval_count
       from proposals p where p.id = $1 and p.outing_id = $2`,
    [expiredProposalId, outing.id],
  );
  const expired = rows[0];
  if (!expired) return api(404, { error: "not_found" });
  if (expired.status !== "expired") return api(409, { error: "proposal_not_expired" });
  if (outing.ended_at) return api(409, { error: "outing_not_active" });
  if (await latestProposal(context.db, outing.id, "confirmed")) {
    return api(409, { error: "plan_already_confirmed" });
  }
  const active = await latestProposal(context.db, outing.id, "published");
  if (active) return api(409, { error: "proposal_already_active" });
  const attendeeUserIds = parseJsonValue(expired.attendee_user_ids, [] as string[]);
  const candidate: OfferCandidate = {
    optionId: expired.option_id,
    activity: expired.activity,
    startsAt: new Date(expired.starts_at).toISOString(),
    estimatedCostCents: expired.estimated_cost_cents,
    activityTags: await tagsForOption(context.db, expired.option_id),
    attendeeUserIds,
    counterOfferToId: null,
    privateNote: "",
  };
  const owner = attendeeUserIds[0];
  if (!(await tieAllowsCandidate(context.db, outing.id, expired.option_id, attendeeUserIds))) {
    return api(409, { error: "tie_choice_required" });
  }
  const eligibility = await validateCandidateForOption(context.db, outing.id, candidate, owner);
  if (!eligibility.ok) return api(409, { error: "offer_not_feasible" });
  if (new Date(candidate.startsAt) <= new Date()) return api(409, { error: "activity_already_started" });
  return createProposalRevision(context, outing, {
    optionId: expired.option_id,
    activity: expired.activity,
    startsAt: candidate.startsAt,
    estimatedCostCents: expired.estimated_cost_cents,
    attendeeUserIds,
    kind: "restart",
    expectedConfirmedId: null,
    requireNoPublished: true,
    expectedConditions: eligibility.versions,
  });
}

async function startTiePoll(
  context: OwnerContext,
  outing: LoadedOuting,
  optionAId: string,
  optionBId: string,
): Promise<ApiResponse> {
  if (!outing.cutoff_processed_at) return api(409, { error: "response_cutoff_not_reached" });
  if (outing.ended_at || outing.status === "confirmed") return api(409, { error: "outing_not_planning" });
  if (optionAId === optionBId) {
    return api(400, { error: "invalid_tie_options" });
  }
  const interestedRows = await context.db.query<{ user_id: string }>(
    `select user_id from participants
      where outing_id = $1 and admission_status = 'admitted' and response_status = 'interested'
      order by created_at, user_id`,
    [outing.id],
  );
  const attendeeUserIds = interestedRows.map((row) => row.user_id);
  if (attendeeUserIds.length < 2) return api(409, { error: "tie_needs_two_interested_people" });
  if (!attendeeUserIds.includes(context.userId)) return api(403, { error: "not_in_tie" });
  const [aRows, bRows] = await Promise.all([
    loadOption(context.db, outing.id, optionAId),
    loadOption(context.db, outing.id, optionBId),
  ]);
  if (!aRows || !bRows) return api(404, { error: "option_not_found" });
  const candidateA = optionAsCandidate(aRows, attendeeUserIds);
  const candidateB = optionAsCandidate(bRows, attendeeUserIds);
  const tieOwner = attendeeUserIds[0];
  const [validA, validB] = await Promise.all([
    validateCandidateForOption(context.db, outing.id, candidateA, tieOwner),
    validateCandidateForOption(context.db, outing.id, candidateB, tieOwner),
  ]);
  if (!validA.ok || !validB.ok) return api(409, { error: "tie_options_not_feasible" });
  if (new Date(candidateA.startsAt) <= new Date() || new Date(candidateB.startsAt) <= new Date()) {
    return api(409, { error: "activity_already_started" });
  }
  if (!attendeeUserIds.includes(context.userId)) return api(403, { error: "not_in_tie" });

  const [sortedA, sortedB] = [optionAId, optionBId].sort();
  const key = `${sortedA}:${sortedB}`;
  const inserted = await context.db.query<{ id: string; status: string }>(
    `with active_outing as materialized (
       select id from outings where id = $2 and ended_at is null and status <> 'confirmed'
         and cutoff_processed_at is not null for update
     )
     insert into tie_polls
      (id, outing_id, tie_key, option_a_id, option_b_id, participant_user_ids, status)
     select $1, active.id, $3, $4, $5, $6::jsonb, 'open' from active_outing active
      where $6::jsonb = coalesce((
        select jsonb_agg(member.user_id order by member.created_at, member.user_id)
          from participants member where member.outing_id = active.id
            and member.admission_status = 'admitted' and member.response_status = 'interested'
      ), '[]'::jsonb)
      and not exists (
        select 1 from tie_polls other
         where other.outing_id = active.id and other.status = 'open' and other.tie_key <> $3
      )
     on conflict (outing_id, tie_key) do nothing
     returning id, status`,
    [crypto.randomUUID(), outing.id, key, optionAId, optionBId, JSON.stringify(attendeeUserIds)],
  );
  if (inserted.length) return api(201, { pollId: inserted[0].id, status: inserted[0].status });
  const existing = await context.db.query<{ id: string; status: string }>(
    `select t.id, t.status from tie_polls t join outings o on o.id = t.outing_id
      where t.outing_id = $1 and t.tie_key = $2 and o.ended_at is null and o.status <> 'confirmed'`,
    [outing.id, key],
  );
  return existing[0]
    ? api(200, { pollId: existing[0].id, status: existing[0].status })
    : api(409, { error: "tie_poll_already_open" });
}

async function answerTie(
  context: OwnerContext,
  outingId: string,
  pollId: string,
  answer: "a" | "b" | "either",
): Promise<ApiResponse> {
  const pollRows = await context.db.query<{ participant_user_ids: unknown; status: string }>(
    `select t.participant_user_ids, t.status from tie_polls t
       join outings o on o.id = t.outing_id
      where t.id = $1 and t.outing_id = $2 and o.ended_at is null and o.status <> 'confirmed'`,
    [pollId, outingId],
  );
  const poll = pollRows[0];
  if (!poll) return api(404, { error: "not_found" });
  const attendeeIds = parseJsonValue(poll.participant_user_ids, [] as string[]);
  if (!attendeeIds.includes(context.userId)) return api(403, { error: "not_in_tie" });
  if (poll.status !== "open") return api(409, { error: "tie_already_resolved" });

  const inserted = await context.db.query<{ user_id: string }>(
    `with active_outing as materialized (
       select id from outings where id = $2 and ended_at is null and status <> 'confirmed' for update
     )
     insert into tie_answers (poll_id, outing_id, user_id, answer)
     select t.id, t.outing_id, $3, $4 from tie_polls t
       join active_outing active on active.id = t.outing_id
      where t.id = $1 and t.status = 'open'
        and t.participant_user_ids @> jsonb_build_array($3::text)
     on conflict (poll_id, user_id) do nothing
     returning user_id`,
    [pollId, outingId, context.userId, answer],
  );
  if (!inserted.length) {
    const existing = await context.db.query<{ answer: string }>(
      `select answer from tie_answers where poll_id = $1 and user_id = $2`,
      [pollId, context.userId],
    );
    if (!existing.length) return api(409, { error: "tie_already_resolved" });
  }
  const ownAnswer = await context.db.query<{ answer: string }>(
    `select answer from tie_answers where poll_id = $1 and user_id = $2`,
    [pollId, context.userId],
  );
  if (ownAnswer[0]?.answer !== answer) return api(409, { error: "answer_already_saved" });

  const resolved = await context.db.query<{ status: string; outcome: string | null }>(
    `with tally as (
       select t.id, t.outing_id, t.option_a_id, t.option_b_id,
              count(a.user_id)::int as answer_count,
              jsonb_array_length(t.participant_user_ids)::int as participant_count,
              bool_and(a.answer <> 'b') as allows_a,
              bool_and(a.answer <> 'a') as allows_b
         from tie_polls t
         join outings o on o.id = t.outing_id and o.ended_at is null and o.status <> 'confirmed'
         cross join lateral jsonb_array_elements_text(t.participant_user_ids) member(user_id)
         left join tie_answers a on a.poll_id = t.id and a.user_id = member.user_id
        where t.id = $1 and t.status = 'open'
        group by t.id
     ), changed as (
       update tie_polls t set
         status = case when tally.allows_a or tally.allows_b then 'resolved' else 'no_agreement' end,
         outcome = case
           when tally.allows_a and tally.allows_b then 'either'
           when tally.allows_a then 'a'
           when tally.allows_b then 'b'
           else null end,
         selected_option_id = case
           when tally.allows_a and not tally.allows_b then t.option_a_id
           when tally.allows_b and not tally.allows_a then t.option_b_id
           else null end,
         resolved_at = now()
        from tally
       where t.id = tally.id and tally.answer_count = tally.participant_count
       returning t.outing_id, t.status, t.outcome
     ), ended as (
       update outings o set status = 'no_agreement', ended_at = coalesce(o.ended_at, now())
        from changed c where o.id = c.outing_id and c.status = 'no_agreement'
          and o.ended_at is null
          and not exists (select 1 from proposals p where p.outing_id = o.id and p.status = 'confirmed')
       returning o.id
     ), closed_polls as (
       update tie_polls set status = 'no_agreement', resolved_at = coalesce(resolved_at, now())
        where outing_id in (select id from ended) and status = 'open'
        returning id
     ), abandoned_proposals as (
       update proposals set status = 'expired'
        where outing_id in (select id from ended) and status = 'published'
        returning id
     ), abandoned_joins as (
       update join_requests set status = 'expired'
        where outing_id in (select id from ended) and status = 'proposed'
        returning id
     ), abandoned_departures as (
       update departure_requests set status = 'expired'
        where outing_id in (select id from ended) and status = 'proposed'
        returning id
     ), canceled_messages as (
       update messages set status = 'failed', error_code = 'outing_ended'
        where outing_id in (select id from ended) and role = 'user' and status = 'pending'
        returning id
     ), canceled_mail as (
       update email_outbox set status = 'suppressed', error_code = 'outing_ended'
        where outing_id in (select id from ended) and status in ('pending', 'failed', 'sending')
        returning id
     )
     select status, outcome from changed`,
    [pollId],
  );
  return api(200, {
    answerSaved: true,
    status: resolved[0]?.status ?? "open",
    outcome: resolved[0]?.outcome ?? null,
  });
}

async function requestJoin(context: OwnerContext, outing: LoadedOuting): Promise<ApiResponse> {
  if (outing.ended_at || outing.status === "no_agreement") return api(409, { error: "outing_not_active" });
  const confirmed = await latestProposal(context.db, outing.id, "confirmed");
  if (!confirmed) return api(409, { error: "no_confirmed_plan" });
  if (await latestProposal(context.db, outing.id, "published")) {
    return api(409, { error: "proposal_already_active" });
  }
  const currentAttendees = parseJsonValue(confirmed.attendee_user_ids, [] as string[]);
  if (currentAttendees.includes(context.userId)) return api(409, { error: "already_attending" });
  if (new Date(confirmed.starts_at) <= new Date()) return api(409, { error: "activity_already_started" });
  const condition = await context.db.query<{ interpretation: unknown; interpretation_ready: boolean }>(
    `select interpretation, interpretation_ready from participant_preferences
      where outing_id = $1 and user_id = $2`,
    [outing.id, context.userId],
  );
  if (!condition[0]?.interpretation_ready || !condition[0].interpretation) {
    return api(409, { error: "conditions_need_review" });
  }
  const interpretation = parseJsonValue(condition[0].interpretation, emptyConditionInterpretation());
  if (interpretation.clarifyingQuestions.length) return api(409, { error: "clarification_required" });

  const requestRows = await context.db.query<{ id: string; status: string }>(
    `insert into join_requests (id, outing_id, user_id, status)
     values ($1, $2, $3, 'pending')
     on conflict (outing_id, user_id) do update
       set status = 'pending', proposal_id = null, created_at = now()
       where join_requests.status in ('rejected', 'expired')
     returning id, status`,
    [crypto.randomUUID(), outing.id, context.userId],
  );
  if (!requestRows.length) return api(409, { error: "join_request_already_open" });

  await context.db.query(
    `update participants set response_status = 'interested', responded_at = now()
      where outing_id = $1 and user_id = $2 and admission_status = 'admitted'`,
    [outing.id, context.userId],
  );
  const attendeeUserIds = [...currentAttendees, context.userId];
  const candidate: OfferCandidate = {
    optionId: confirmed.option_id,
    activity: confirmed.activity,
    startsAt: new Date(confirmed.starts_at).toISOString(),
    estimatedCostCents: confirmed.estimated_cost_cents,
    activityTags: await tagsForOption(context.db, confirmed.option_id),
    attendeeUserIds,
    counterOfferToId: null,
    privateNote: "",
  };
  const eligibility = await validateCandidateForOption(
    context.db,
    outing.id,
    candidate,
    context.userId,
  );
  if (!eligibility.ok) {
    await context.db.query(
      `update join_requests set status = 'rejected' where id = $1`,
      [requestRows[0].id],
    );
    return api(409, { error: "join_not_feasible" });
  }
  const revision = await createProposalRevision(context, outing, {
    optionId: confirmed.option_id,
    activity: confirmed.activity,
    startsAt: candidate.startsAt,
    estimatedCostCents: confirmed.estimated_cost_cents,
    attendeeUserIds,
    kind: "join",
    requestId: requestRows[0].id,
    requestUserId: context.userId,
    expectedConfirmedId: confirmed.id,
    requireNoPublished: true,
    expectedConditions: eligibility.versions,
  });
  if (revision.status >= 400) {
    await context.db.query(`update join_requests set status = 'expired' where id = $1 and status = 'pending'`, [requestRows[0].id]);
  }
  return revision;
}

async function requestDeparture(context: OwnerContext, outing: LoadedOuting): Promise<ApiResponse> {
  if (outing.ended_at || outing.status !== "confirmed") return api(409, { error: "no_confirmed_plan" });
  const confirmed = await latestProposal(context.db, outing.id, "confirmed");
  if (!confirmed) return api(409, { error: "no_confirmed_plan" });
  if (await latestProposal(context.db, outing.id, "published")) {
    return api(409, { error: "proposal_already_active" });
  }
  const currentAttendees = parseJsonValue(confirmed.attendee_user_ids, [] as string[]);
  if (!currentAttendees.includes(context.userId)) return api(409, { error: "not_attending" });
  if (new Date(confirmed.starts_at) <= new Date()) return api(409, { error: "activity_already_started" });
  const attendeeUserIds = currentAttendees.filter((userId) => userId !== context.userId);
  const startsAt = new Date(confirmed.starts_at).toISOString();
  let eligibility: Awaited<ReturnType<typeof validateCandidateForOption>> | null = null;
  if (attendeeUserIds.length > 0) {
    const candidate: OfferCandidate = {
      optionId: confirmed.option_id,
      activity: confirmed.activity,
      startsAt,
      estimatedCostCents: confirmed.estimated_cost_cents,
      activityTags: await tagsForOption(context.db, confirmed.option_id),
      attendeeUserIds,
      counterOfferToId: null,
      privateNote: "",
    };
    eligibility = await validateCandidateForOption(
      context.db,
      outing.id,
      candidate,
      attendeeUserIds[0],
    );
  }
  const requestRows = await context.db.query<{ id: string }>(
    `insert into departure_requests (id, outing_id, user_id, status)
     values ($1, $2, $3, 'pending')
     on conflict (outing_id, user_id) do update
       set status = 'pending', proposal_id = null, created_at = now()
       where departure_requests.status in ('rejected', 'expired')
     returning id`,
    [crypto.randomUUID(), outing.id, context.userId],
  );
  if (!requestRows.length) return api(409, { error: "departure_request_already_open" });
  if (attendeeUserIds.length === 0) {
    const closed = await closeOuting(context.db, outing.id, "no_agreement", confirmed.id);
    const ended = closed[1] as Array<{ ended_at: string | Date }>;
    if (!ended.length) {
      await context.db.query(`update departure_requests set status = 'expired' where id = $1`, [requestRows[0].id]);
      return api(409, { error: "plan_changed" });
    }
    await context.db.query(`update departure_requests set status = 'accepted' where id = $1`, [requestRows[0].id]);
    return api(200, { status: "no_agreement", endedAt: new Date(ended[0].ended_at).toISOString() });
  }
  if (eligibility && !eligibility.ok) {
    const renegotiation = await beginDepartureRenegotiation(
      context.db,
      outing.id,
      confirmed.id,
      requestRows[0].id,
      context.userId,
    );
    if (!renegotiation) {
      await context.db.query(`update departure_requests set status = 'expired' where id = $1 and status = 'pending'`, [requestRows[0].id]);
      if (await latestProposal(context.db, outing.id, "published")) {
        return api(409, { error: "proposal_already_active" });
      }
      return api(409, { error: "plan_changed" });
    }
    return api(200, { status: "renegotiation_required" });
  }
  if (!eligibility) return api(409, { error: "plan_changed" });
  const revision = await createProposalRevision(context, outing, {
    optionId: confirmed.option_id,
    activity: confirmed.activity,
    startsAt,
    estimatedCostCents: confirmed.estimated_cost_cents,
    attendeeUserIds,
    kind: "departure",
    requestId: requestRows[0].id,
    requestUserId: context.userId,
    expectedConfirmedId: confirmed.id,
    requireNoPublished: true,
    expectedConditions: eligibility.versions,
  });
  if (revision.status >= 400) {
    await context.db.query(`update departure_requests set status = 'expired' where id = $1 and status = 'pending'`, [requestRows[0].id]);
  }
  return revision;
}

async function beginDepartureRenegotiation(
  db: Db,
  outingId: string,
  confirmedProposalId: string,
  departureRequestId: string,
  departingUserId: string,
): Promise<boolean> {
  const rows = await db.query<{ accepted: number; outing_updated: number }>(
    `with locked as materialized (
       select id from outings where id = $2::uuid and ended_at is null for update
     ), changed as (
       update proposals set status = 'superseded'
        where id = $1::uuid and outing_id = $2::uuid and status = 'confirmed'
          and exists (select 1 from locked)
          and not exists (
            select 1 from proposals current where current.outing_id = $2::uuid and current.status = 'published'
          )
        returning id, attendee_user_ids
     ), accepted as (
       update departure_requests set status = 'accepted', proposal_id = null
        where id = $3::uuid and outing_id = $2::uuid and status = 'pending'
          and exists (select 1 from changed)
        returning id
     ), outing_update as (
       update outings set status = 'planning'
        where id = $2::uuid and status = 'confirmed' and ended_at is null
          and exists (select 1 from changed)
        returning id
     ), participant_update as (
       update participants set response_status = 'not_interested', responded_at = now()
        where outing_id = $2::uuid and user_id = $4 and admission_status = 'admitted'
          and exists (select 1 from changed)
        returning user_id
     ), expired_proposals as (
       update proposals set status = 'expired'
        where outing_id = $2::uuid and status = 'published'
          and exists (select 1 from changed)
        returning id
     ), expired_joins as (
       update join_requests set status = 'expired'
        where outing_id = $2::uuid and status in ('pending', 'proposed')
          and exists (select 1 from changed)
        returning id
     ), closed_polls as (
       update tie_polls set status = 'no_agreement', resolved_at = coalesce(resolved_at, now())
        where outing_id = $2::uuid and status in ('open', 'resolved')
          and exists (select 1 from changed)
        returning id
     ), notices as (
       insert into in_app_notifications (id, outing_id, recipient_user_id, actor_user_id, kind, event_key)
       select gen_random_uuid(), $2::uuid, attendee.user_id, $4, 'proposal_ready',
              'renegotiation:' || $1::text
         from changed
         cross join lateral jsonb_array_elements_text(changed.attendee_user_ids) attendee(user_id)
        where attendee.user_id <> $4
       on conflict do nothing
       returning id
     )
     select (select count(*)::int from accepted) as accepted,
            (select count(*)::int from outing_update) as outing_updated`,
    [confirmedProposalId, outingId, departureRequestId, departingUserId],
  );
  return rows[0]?.accepted === 1 && rows[0]?.outing_updated === 1;
}

async function endOuting(context: OwnerContext, outing: LoadedOuting): Promise<ApiResponse> {
  if (!(await isStarter(context.db, outing.id, context.userId))) return api(404, { error: "not_found" });
  const result = await closeOuting(context.db, outing.id, "ended");
  const rows = result[1] as Array<{ ended_at: string | Date }>;
  return rows.length ? api(200, { endedAt: new Date(rows[0].ended_at).toISOString() }) : api(409, { error: "outing_already_ended" });
}

async function declareNoAgreement(context: OwnerContext, outing: LoadedOuting): Promise<ApiResponse> {
  const result = await context.db.transaction([
    {
      text: `select id from outings where id = $1 and ended_at is null for update`,
      params: [outing.id],
    },
    {
      text: `update outings o set status = 'no_agreement', ended_at = now()
        where o.id = $1 and o.ended_at is null and o.cutoff_processed_at is not null
          and exists (
            select 1 from participants member where member.outing_id = o.id
              and member.user_id = $2 and member.admission_status = 'admitted'
              and member.response_status = 'interested'
          )
          and not exists (
            select 1 from proposals p where p.outing_id = o.id
              and p.status in ('published', 'confirmed')
          )
          and not exists (select 1 from tie_polls t where t.outing_id = o.id and t.status = 'open')
          and not exists (select 1 from join_requests j where j.outing_id = o.id and j.status in ('pending', 'proposed'))
          and not exists (select 1 from departure_requests d where d.outing_id = o.id and d.status in ('pending', 'proposed'))
        returning ended_at`,
      params: [outing.id, context.userId],
    },
    {
      text: `update proposals set status = 'expired'
        where outing_id = $1 and status = 'published'
          and exists (select 1 from outings where id = $1 and status = 'no_agreement' and ended_at is not null)`,
      params: [outing.id],
    },
    {
      text: `update tie_polls set status = 'no_agreement', resolved_at = coalesce(resolved_at, now())
        where outing_id = $1 and status = 'open'
          and exists (select 1 from outings where id = $1 and status = 'no_agreement' and ended_at is not null)`,
      params: [outing.id],
    },
    {
      text: `update join_requests set status = 'expired'
        where outing_id = $1 and status in ('pending', 'proposed')
          and exists (select 1 from outings where id = $1 and status = 'no_agreement' and ended_at is not null)`,
      params: [outing.id],
    },
    {
      text: `update departure_requests set status = 'expired'
        where outing_id = $1 and status in ('pending', 'proposed')
          and exists (select 1 from outings where id = $1 and status = 'no_agreement' and ended_at is not null)`,
      params: [outing.id],
    },
    {
      text: `update messages set status = 'failed', error_code = 'outing_ended'
        where outing_id = $1 and role = 'user' and status = 'pending'
          and exists (select 1 from outings where id = $1 and status = 'no_agreement' and ended_at is not null)`,
      params: [outing.id],
    },
    {
      text: `update email_outbox set status = 'suppressed', error_code = 'outing_ended'
        where outing_id = $1 and status in ('pending', 'failed', 'sending')
          and exists (select 1 from outings where id = $1 and status = 'no_agreement' and ended_at is not null)`,
      params: [outing.id],
    },
  ]);
  const rows = result[1] as Array<{ ended_at: string | Date }>;
  return rows.length
    ? api(200, { endedAt: new Date(rows[0].ended_at).toISOString() })
    : api(409, { error: "agreement_still_open" });
}

async function closeOuting(
  db: Db,
  outingId: string,
  status: "ended" | "no_agreement",
  expectedConfirmedId?: string | null,
) {
  const confirmedGuard = expectedConfirmedId === undefined
    ? ""
    : `and (($3::uuid is null and not exists (
           select 1 from proposals current where current.outing_id = outings.id and current.status = 'confirmed'
         )) or exists (
           select 1 from proposals current where current.outing_id = outings.id
             and current.id = $3::uuid and current.status = 'confirmed'
         ))`;
  const updateOutingParams = expectedConfirmedId === undefined
    ? [outingId, status]
    : [outingId, status, expectedConfirmedId];
  return db.transaction([
    {
      text: `select id from outings where id = $1 and ended_at is null for update`,
      params: [outingId],
    },
    {
      text: `update outings set status = $2, ended_at = now()
        where id = $1 and ended_at is null ${confirmedGuard} returning ended_at`,
      params: updateOutingParams,
    },
    {
      text: `update proposals set status = 'expired'
        where outing_id = $1 and status = 'published'
          and exists (select 1 from outings where id = $1 and ended_at is not null) returning id`,
      params: [outingId],
    },
    {
      text: `update tie_polls set status = 'no_agreement', resolved_at = coalesce(resolved_at, now())
        where outing_id = $1 and status = 'open'
          and exists (select 1 from outings where id = $1 and ended_at is not null)`,
      params: [outingId],
    },
    {
      text: `update join_requests set status = 'expired'
        where outing_id = $1 and status in ('pending', 'proposed')
          and exists (select 1 from outings where id = $1 and ended_at is not null)`,
      params: [outingId],
    },
    {
      text: `update departure_requests set status = 'expired'
        where outing_id = $1 and status in ('pending', 'proposed')
          and exists (select 1 from outings where id = $1 and ended_at is not null)`,
      params: [outingId],
    },
    {
      text: `update messages set status = 'failed', error_code = 'outing_ended'
        where outing_id = $1 and role = 'user' and status = 'pending'
          and exists (select 1 from outings where id = $1 and ended_at is not null)`,
      params: [outingId],
    },
    {
      text: `update email_outbox set status = 'suppressed', error_code = 'outing_ended'
        where outing_id = $1 and status in ('pending', 'failed', 'sending')
          and exists (select 1 from outings where id = $1 and ended_at is not null)`,
      params: [outingId],
    },
  ]);
}

async function validateCandidateForOption(
  db: Db,
  outingId: string,
  candidate: OfferCandidate,
  ownerUserId: string,
) {
  const option = await loadOption(db, outingId, candidate.optionId);
  const [participants, conditions] = await Promise.all([
    loadParticipants(db, outingId),
    loadConditionRows(db, outingId),
  ]);
  const validation = validateCandidate(
    candidate,
    ownerUserId,
    option ? optionChoice(option) : null,
    participants,
    conditions,
  );
  return {
    ...validation,
    versions: conditionVersionsFor(conditions, candidate.attendeeUserIds),
  };
}

async function loadOption(db: Db, outingId: string, optionId: string): Promise<OptionRow | null> {
  const rows = await db.query<OptionRow>(
    `select id, title, activity, starts_at, estimated_cost_cents, activity_tags, source, visibility
       from outing_options where id = $1 and outing_id = $2
         and source in ('manual', 'agent') and visibility = 'shared'`,
    [optionId, outingId],
  );
  return rows[0] ?? null;
}

function optionChoice(option: OptionRow) {
  return {
    id: option.id,
    activity: option.activity,
    startsAt: new Date(option.starts_at).toISOString(),
    estimatedCostCents: option.estimated_cost_cents,
    activityTags: parseJsonValue(option.activity_tags, [] as string[]),
  };
}

function optionAsCandidate(option: OptionRow, attendeeUserIds: string[]): OfferCandidate {
  const item = optionChoice(option);
  return {
    optionId: item.id,
    activity: item.activity,
    startsAt: item.startsAt,
    estimatedCostCents: item.estimatedCostCents,
    activityTags: item.activityTags,
    attendeeUserIds,
    counterOfferToId: null,
    privateNote: "",
  };
}

async function tagsForOption(db: Db, optionId: string): Promise<string[]> {
  const rows = await db.query<{ activity_tags: unknown }>(
    `select activity_tags from outing_options where id = $1 and visibility = 'shared'`,
    [optionId],
  );
  return rows[0] ? parseJsonValue(rows[0].activity_tags, [] as string[]) : [];
}
