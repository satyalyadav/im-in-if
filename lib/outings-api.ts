import { z } from "zod";
import { AgentError, type Agent } from "@/lib/agent";
import { formatZonedDateTime, resolveCutoffInstant } from "@/lib/cutoff";
import { prepareConversationConditionUpdate } from "@/lib/conversation-conditions";
import type { Db } from "@/lib/db";
import { processOutingDeadlines } from "@/lib/maintenance";
import {
  ConditionInterpretationSchema,
  emptyConditionInterpretation,
  parseJsonValue,
  type ConditionInterpretation,
  type PublicParticipant,
} from "@/lib/planning-types";

export type OwnerContext = {
  db: Db;
  userId: string;
  verifiedEmails?: string[];
};

export type AgentContext = OwnerContext & {
  agent: Agent;
};

export type ApiResponse = {
  status: number;
  body: Record<string, unknown>;
};

type OutingRow = {
  id: string;
  starter_user_id: string;
  suggestion: string;
  cutoff_at: string | Date;
  cutoff_time_zone: string;
  invite_token: string | null;
  status: string;
  cutoff_processed_at: string | Date | null;
  ended_at: string | Date | null;
  created_at: string | Date;
};

type MessageRow = {
  seq: number;
  id: string;
  outing_id: string;
  owner_user_id: string;
  role: "user" | "agent";
  content: string;
  client_message_id: string | null;
  reply_to_message_id: string | null;
  status: "pending" | "replied" | "failed" | "complete";
  error_code: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
};

export type OutingView = {
  id: string;
  suggestion: string;
  cutoffAt: string;
  cutoffTimeZone: string;
  cutoffDisplay: string;
  inviteToken: string | null;
  status: string;
  cutoffProcessedAt: string | null;
  endedAt: string | null;
  isStarter: boolean;
  createdAt: string;
};

export type MessageView = {
  id: string;
  role: "user" | "agent";
  content: string;
  status: "pending" | "replied" | "failed" | "complete";
  errorCode: string | null;
  replyToMessageId: string | null;
  createdAt: string;
};

const createOutingSchema = z.object({
  suggestion: z.string().trim().min(1).max(400),
  cutoffDate: z.string().min(1).max(32),
  cutoffTime: z.string().min(1).max(16),
  cutoffTimeZone: z.string().min(1).max(64),
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sendMessageSchema = z.object({
  clientMessageId: z.string().regex(UUID_PATTERN),
  content: z.string().trim().min(1).max(4000),
});

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function toOutingView(row: OutingRow, viewerId: string): OutingView {
  return {
    id: row.id,
    suggestion: row.suggestion,
    cutoffAt: iso(row.cutoff_at),
    cutoffTimeZone: row.cutoff_time_zone,
    cutoffDisplay: formatZonedDateTime(new Date(row.cutoff_at), row.cutoff_time_zone),
    inviteToken: row.starter_user_id === viewerId ? row.invite_token : null,
    status: row.status,
    cutoffProcessedAt: row.cutoff_processed_at ? iso(row.cutoff_processed_at) : null,
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    isStarter: row.starter_user_id === viewerId,
    createdAt: iso(row.created_at),
  };
}

function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    errorCode: row.error_code,
    replyToMessageId: row.reply_to_message_id,
    createdAt: iso(row.created_at),
  };
}

export async function findAccessibleOuting(
  db: Db,
  outingId: string,
  userId: string,
): Promise<OutingRow | null> {
  const rows = await db.query<OutingRow>(
    `select o.* from outings o
      join participants p on p.outing_id = o.id
     where o.id = $1 and p.user_id = $2 and p.admission_status = 'admitted'`,
    [outingId, userId],
  );
  return rows[0] ?? null;
}

export async function listOwnMessages(
  db: Db,
  outingId: string,
  userId: string,
): Promise<MessageView[]> {
  const rows = await db.query<MessageRow>(
    `select * from messages where outing_id = $1 and owner_user_id = $2 order by seq`,
    [outingId, userId],
  );
  return rows.map(toMessageView);
}

export async function listOutings(context: OwnerContext): Promise<OutingView[]> {
  const rows = await context.db.query<OutingRow>(
    `select distinct o.* from outings o
      join participants p on p.outing_id = o.id
     where p.user_id = $1 and p.admission_status = 'admitted'
     order by o.created_at desc limit 20`,
    [context.userId],
  );
  return rows.map((row) => toOutingView(row, context.userId));
}

async function loadHistory(
  db: Db,
  outingId: string,
  userId: string,
  current: MessageRow,
): Promise<Array<{ role: "user" | "agent"; content: string }>> {
  const rows = await db.query<Pick<MessageRow, "role" | "content">>(
    `select role, content from messages
      where outing_id = $1 and seq < $2
        and owner_user_id = $3
      order by seq`,
    [outingId, current.seq, userId],
  );

  return [...rows, { role: "user" as const, content: current.content }];
}

async function generateReply(
  context: AgentContext,
  outing: OutingRow,
  userMessage: MessageRow,
  successStatus: number,
): Promise<ApiResponse> {
  const history = await loadHistory(context.db, outing.id, context.userId, userMessage);

  try {
    await context.db.query(
      `insert into participant_preferences (outing_id, user_id)
       values ($1, $2) on conflict (outing_id, user_id) do nothing`,
      [outing.id, context.userId],
    );
    const [sessions, preferenceRows, participantRows, lockedRows] = await Promise.all([
      context.db.query<{ agent_session_id: string }>(
        `select agent_session_id from participants
          where outing_id = $1 and user_id = $2 and admission_status = 'admitted'`,
        [outing.id, context.userId],
      ),
      context.db.query<{
        interpretation: unknown;
        interpretation_ready: boolean;
        conditions_version: number | string;
      }>(
        `select interpretation, interpretation_ready, conditions_version
           from participant_preferences where outing_id = $1 and user_id = $2`,
        [outing.id, context.userId],
      ),
      context.db.query<{ user_id: string; display_name: string }>(
        `select user_id, display_name from participants
          where outing_id = $1 and admission_status = 'admitted'
          order by created_at`,
        [outing.id],
      ),
      context.db.query<{ locked: boolean }>(
        `select exists (
           select 1 from proposals p
            where p.outing_id = $1 and p.status = 'confirmed'
              and p.attendee_user_ids @> jsonb_build_array($2::text)
         ) as locked`,
        [outing.id, context.userId],
      ),
    ]);
    if (!sessions[0] || !preferenceRows[0]) return { status: 404, body: { error: "not_found" } };
    const stored = preferenceRows[0];
    const current = stored.interpretation
      ? parseJsonValue(stored.interpretation, emptyConditionInterpretation())
      : null;
    const participants: PublicParticipant[] = participantRows.map((participant) => ({
      userId: participant.user_id,
      displayName: participant.display_name,
    }));

    const agentReply = await context.agent.reply({
      outing: {
        suggestion: outing.suggestion,
        cutoffAt: iso(outing.cutoff_at),
        cutoffTimeZone: outing.cutoff_time_zone,
      },
      history,
      currentConditions: current,
      conditionsReady: stored.interpretation_ready,
      conditionsLocked: lockedRows[0]?.locked ?? false,
      participants,
      sessionId: sessions[0].agent_session_id,
    });

    const condition = prepareConversationConditionUpdate({
      ownerUserId: context.userId,
      history,
      current,
      currentReady: stored.interpretation_ready,
      suggested: agentReply.conditionUpdate,
      participants,
      conditionsLocked: lockedRows[0]?.locked ?? false,
      timeZone: outing.cutoff_time_zone,
      text: agentReply.text,
    });
    const parsedCondition = condition.interpretation
      ? ConditionInterpretationSchema.safeParse(condition.interpretation)
      : null;
    if (parsedCondition && !parsedCondition.success) {
      throw new AgentError("invalid_output", "agent returned invalid conditions");
    }
    const expectedVersion = Number(stored.conditions_version);
    const saved = await context.db.query<{
      inserted_reply_count: number | string;
      condition_write_count: number | string;
      marked_user_count: number | string;
    }>(
      `with outing_guard as materialized (
         select id from outings where id = $1 and ended_at is null for update
       ), message_guard as materialized (
         select id, seq from messages
          where id = $2 and outing_id = $1 and owner_user_id = $3 and role = 'user'
            and status in ('pending', 'failed')
          for update
       ), preference_guard as materialized (
         select pref.outing_id, pref.user_id, pref.conditions_version
           from participant_preferences pref
           join outing_guard o on o.id = pref.outing_id
          where pref.user_id = $3
          for update
       ), condition_write as (
         update participant_preferences pref
            set interpretation = $8::jsonb,
                interpretation_ready = $9,
                conditions_version = pref.conditions_version + 1,
                updated_at = now()
           where pref.outing_id = $1 and pref.user_id = $3
             and pref.conditions_version = $4 and $5::boolean
             and exists (select 1 from preference_guard)
             and exists (select 1 from message_guard)
             and not exists (
               select 1 from proposals p where p.outing_id = $1 and p.status = 'confirmed'
                 and p.attendee_user_ids @> jsonb_build_array($3::text)
             )
             and not exists (
               select 1 from messages m where m.reply_to_message_id = $2 and m.owner_user_id = $3
             )
           returning pref.outing_id, pref.user_id
       ), unchanged_conditions as (
         select pref.outing_id, pref.user_id
           from preference_guard pref
          where pref.conditions_version = $4 and not $5::boolean
            and exists (select 1 from message_guard)
            and not exists (
              select 1 from messages m where m.reply_to_message_id = $2 and m.owner_user_id = $3
            )
       ), valid_turn as (
         select outing_id, user_id from condition_write
         union all
         select outing_id, user_id from unchanged_conditions
       ), inserted_reply as (
         insert into messages
           (id, outing_id, owner_user_id, role, content, reply_to_message_id, status, completed_at)
         select $6, o.id, $3, 'agent', $7, $2, 'complete', now()
           from outing_guard o where exists (select 1 from valid_turn)
         on conflict do nothing returning id
       ), marked_user as (
         update messages set status = 'replied', error_code = null, completed_at = now()
          where id = $2 and status in ('pending', 'failed')
            and exists (select 1 from inserted_reply)
         returning id
       ), superseded_proposals as (
         update proposals set status = 'superseded'
          where outing_id = $1 and status = 'published'
            and exists (select 1 from condition_write)
         returning id
       ), expired_joins as (
         update join_requests set status = 'expired'
          where outing_id = $1 and status = 'proposed'
            and proposal_id in (select id from superseded_proposals)
         returning id
       ), expired_departures as (
         update departure_requests set status = 'expired'
          where outing_id = $1 and status = 'proposed'
            and proposal_id in (select id from superseded_proposals)
         returning id
       )
       select (select count(*)::int from inserted_reply) as inserted_reply_count,
              (select count(*)::int from condition_write) as condition_write_count,
              (select count(*)::int from marked_user) as marked_user_count,
              (select count(*)::int from expired_joins) as expired_join_count,
              (select count(*)::int from expired_departures) as expired_departure_count`,
      [
        outing.id,
        userMessage.id,
        context.userId,
        expectedVersion,
        condition.changed,
        crypto.randomUUID(),
        condition.text,
        condition.changed && parsedCondition?.success
          ? JSON.stringify(parsedCondition.data)
          : null,
        condition.ready,
      ],
    );
    if (!saved.length) {
      return { status: 409, body: { error: "outing_ended" } };
    }
    if (Number(saved[0].inserted_reply_count) === 0) {
      const existingReply = await context.db.query<{ id: string }>(
        `select id from messages where reply_to_message_id = $1 and owner_user_id = $2`,
        [userMessage.id, context.userId],
      );
      if (existingReply.length) {
        return {
          status: successStatus,
          body: {
            messageId: userMessage.id,
            messages: await listOwnMessages(context.db, outing.id, context.userId),
          },
        };
      }
      await context.db.query(
        `update messages set status = 'failed', error_code = 'stale_reply'
          where id = $1 and status in ('pending', 'failed')
            and exists (select 1 from outings where id = $2 and ended_at is null)`,
        [userMessage.id, outing.id],
      );
      const active = await context.db.query<{ ended_at: string | Date | null }>(
        `select ended_at from outings where id = $1`, [outing.id],
      );
      return active[0]?.ended_at
        ? { status: 409, body: { error: "outing_ended" } }
        : { status: 409, body: { messageId: userMessage.id, error: "stale_reply" } };
    }

    return {
      status: successStatus,
      body: {
        messageId: userMessage.id,
        messages: await listOwnMessages(context.db, outing.id, context.userId),
      },
    };
  } catch (error) {
    const code = error instanceof AgentError
      ? error.code
      : error instanceof Error && error.message === "invalid_condition_update"
        ? "invalid_output"
        : "model_error";
    await context.db.query(
      `update messages set status = 'failed', error_code = $2
        where id = $1 and status = 'pending'
          and exists (select 1 from outings where id = $3 and ended_at is null)`,
      [userMessage.id, code, outing.id],
    );
    console.error("agent turn failed", code);

    return {
      status: code === "unavailable" ? 503 : 502,
      body: { messageId: userMessage.id, error: code },
    };
  }
}

export async function createOuting(
  context: OwnerContext,
  input: unknown,
): Promise<ApiResponse> {
  const parsed = createOutingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: "invalid_input", fields: parsed.error.flatten().fieldErrors },
    };
  }

  const cutoff = resolveCutoffInstant({
    date: parsed.data.cutoffDate,
    time: parsed.data.cutoffTime,
    timeZone: parsed.data.cutoffTimeZone,
  });
  if (!cutoff.ok) {
    return { status: 400, body: { error: cutoff.error } };
  }

  const outingId = crypto.randomUUID();
  const inviteToken = crypto.randomUUID();
  const sessionId = `ses_${crypto.randomUUID()}`;
  const firstSampleId = crypto.randomUUID();
  const secondSampleId = crypto.randomUUID();
  const sampleStartsAt = new Date(cutoff.instant.getTime() + 24 * 60 * 60 * 1000);
  const laterSampleStartsAt = new Date(sampleStartsAt.getTime() + 60 * 60 * 1000);
  const result = await context.db.transaction<OutingRow>([
    {
      text: `insert into outings
        (id, starter_user_id, suggestion, cutoff_at, cutoff_time_zone, invite_token)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      params: [
        outingId,
        context.userId,
        parsed.data.suggestion,
        cutoff.instant.toISOString(),
        parsed.data.cutoffTimeZone,
        inviteToken,
      ],
    },
    {
      text: `insert into participants
        (outing_id, user_id, display_name, admission_status, response_status, responded_at, agent_session_id)
       values ($1, $2, 'Starter', 'admitted', 'interested', now(), $3)`,
      params: [outingId, context.userId, sessionId],
    },
    {
      text: `insert into participant_preferences (outing_id, user_id)
       values ($1, $2)`,
      params: [outingId, context.userId],
    },
    {
      text: `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values
        ($1, $2, $3, 'Sample: film night at 7 PM', 'Movie', $4, 900, '["movie"]', 'sample'),
        ($5, $2, $3, 'Sample: film night at 8 PM', 'Movie', $6, 1200, '["movie"]', 'sample')`,
      params: [
        firstSampleId,
        outingId,
        context.userId,
        sampleStartsAt.toISOString(),
        secondSampleId,
        laterSampleStartsAt.toISOString(),
      ],
    },
  ]);

  return {
    status: 201,
    body: { outing: toOutingView(result[0][0], context.userId) },
  };
}

export async function getOuting(
  context: OwnerContext,
  outingId: string,
): Promise<ApiResponse> {
  if (!isUuid(outingId)) return { status: 404, body: { error: "not_found" } };
  let outing = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };
  await processOutingDeadlines(context.db, outingId);
  outing = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };

  return {
    status: 200,
    body: {
      outing: toOutingView(outing, context.userId),
      messages: await listOwnMessages(context.db, outing.id, context.userId),
    },
  };
}

export async function sendMessage(
  context: AgentContext,
  outingId: string,
  input: unknown,
): Promise<ApiResponse> {
  const parsed = sendMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid_input" } };
  }
  if (!isUuid(outingId)) return { status: 404, body: { error: "not_found" } };

  await processOutingDeadlines(context.db, outingId);
  const outing = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };
  if (outing.ended_at) return { status: 409, body: { error: "outing_ended" } };

  const inserted = await context.db.query<MessageRow>(
    `insert into messages
      (id, outing_id, owner_user_id, role, content, client_message_id, status)
     select $1, o.id, $3, 'user', $4, $5, 'pending'
       from outings o where o.id = $2 and o.ended_at is null
     on conflict do nothing
     returning *`,
    [
      crypto.randomUUID(),
      outing.id,
      context.userId,
      parsed.data.content,
      parsed.data.clientMessageId,
    ],
  );

  if (inserted.length === 0) {
    const existing = await context.db.query<MessageRow>(
      `select * from messages
        where outing_id = $1 and owner_user_id = $2 and client_message_id = $3`,
      [outing.id, context.userId, parsed.data.clientMessageId],
    );
    const message = existing[0];

    if (!message) {
      const active = await context.db.query<{ ended_at: string | Date | null }>(
        `select ended_at from outings where id = $1`, [outing.id],
      );
      return active[0]?.ended_at
        ? { status: 409, body: { error: "outing_ended" } }
        : { status: 409, body: { error: "message_conflict" } };
    }
    if (message.status === "pending") {
      return { status: 202, body: { messageId: message.id, status: "pending" } };
    }
    if (message.status === "failed") {
      return {
        status: 502,
        body: { messageId: message.id, error: message.error_code ?? "model_error" },
      };
    }
    return {
      status: 200,
      body: {
        messageId: message.id,
        messages: await listOwnMessages(context.db, outing.id, context.userId),
      },
    };
  }

  return generateReply(context, outing, inserted[0], 200);
}

export async function retryMessage(
  context: AgentContext,
  outingId: string,
  messageId: string,
): Promise<ApiResponse> {
  if (!isUuid(outingId) || !isUuid(messageId)) {
    return { status: 404, body: { error: "not_found" } };
  }
  await processOutingDeadlines(context.db, outingId);
  const outing = await findAccessibleOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };
  if (outing.ended_at) return { status: 409, body: { error: "outing_ended" } };

  const rows = await context.db.query<MessageRow>(
    `select * from messages
      where id = $1 and outing_id = $2 and owner_user_id = $3 and role = 'user'`,
    [messageId, outing.id, context.userId],
  );
  const message = rows[0];
  if (!message) return { status: 404, body: { error: "not_found" } };

  const replies = await context.db.query<{ id: string }>(
    `select id from messages where reply_to_message_id = $1 and owner_user_id = $2`,
    [message.id, context.userId],
  );
  if (replies.length > 0) {
    await context.db.query(
      `update messages set status = 'replied', error_code = null where id = $1`,
      [message.id],
    );
    return {
      status: 200,
      body: {
        messageId: message.id,
        messages: await listOwnMessages(context.db, outing.id, context.userId),
      },
    };
  }

  return generateReply(context, outing, message, 200);
}
