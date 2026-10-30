import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError, type Agent, type AgentTurnInput, type OfferGenerationInput } from "@/lib/agent";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import { createOuting, getOuting, sendMessage } from "@/lib/outings-api";
import {
  getInvitationStatus,
  getOutingWorkspace,
  handlePlanningAction,
  requestAdmission,
} from "@/lib/planning-api";
import {
  emptyConditionInterpretation,
  type OfferCandidate,
  type OfferGenerationResult,
} from "@/lib/planning-types";

const STARTER = "starter-user";
const GUEST = "guest-user";
const PENDING = "pending-user";

let pg: PGlite;
let db: Db;

class FakeAgent implements Agent {
  calls: AgentTurnInput[] = [];
  offerCalls: OfferGenerationInput[] = [];
  candidate: OfferGenerationResult | null = null;
  offerError: AgentError | null = null;

  async reply(input: AgentTurnInput) {
    this.calls.push(structuredClone(input));
    return { text: "Synthetic reply." };
  }

  async generateOffer(input: OfferGenerationInput) {
    this.offerCalls.push(structuredClone(input));
    if (this.offerError) throw this.offerError;
    if (!this.candidate) throw new Error("test candidate not configured");
    return structuredClone(this.candidate);
  }
}

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("RESEND_FROM", "");
  pg = new PGlite();
  db = createPgliteDb(pg);
  await migrate(db);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

function context(userId: string, verifiedEmails: string[] = []) {
  return { db, userId, verifiedEmails };
}

async function makeOuting(
  agent = new FakeAgent(),
  options: { withFixtureOptions?: boolean; suggestion?: string } = {},
) {
  const created = await createOuting(context(STARTER), {
    suggestion: options.suggestion ?? "Synthetic movie plan",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  expect(created.status).toBe(201);
  const outingId = (created.body.outing as { id: string }).id;
  if (options.withFixtureOptions !== false) {
    for (const option of [
      { title: "Synthetic late show", startsAt: "2026-11-02T02:00:00.000Z" },
      { title: "Synthetic second show", startsAt: "2026-11-02T03:00:00.000Z" },
    ]) {
      const added = await handlePlanningAction(context(STARTER), outingId, {
        action: "add_option",
        title: option.title,
        activity: "Movie",
        startsAt: option.startsAt,
        estimatedCostCents: 900,
        activityTags: ["movie"],
      });
      expect(added.status).toBe(201);
    }
  }
  return {
    id: outingId,
    inviteToken: (created.body.outing as { inviteToken: string }).inviteToken,
    agent,
  };
}

async function admit(
  outingId: string,
  token: string,
  userId: string,
  email: string,
  displayName = userId,
) {
  const request = await requestAdmission(
    context(userId, [email]),
    token,
    { displayName, emailOptIn: true, email },
  );
  expect(request.status).toBe(200);
  expect(request.body).toEqual({ status: "pending" });
  const decision = await handlePlanningAction(context(STARTER), outingId, {
    action: "decide_admission",
    userId,
    decision: "admit",
  });
  expect(decision.status).toBe(200);
}

describe("outings without response cutoffs", () => {
  it("keeps planning open and returns a null-safe workspace", async () => {
    const created = await createOuting(context(STARTER), {
      suggestion: "Coffee sometime",
      requestId: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const outingId = (created.body.outing as { id: string }).id;
    await db.query(
      `update participant_preferences
          set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [outingId, STARTER, JSON.stringify(emptyConditionInterpretation())],
    );

    const interest = await handlePlanningAction(context(STARTER), outingId, {
      action: "set_interest",
      interested: true,
    });
    expect(interest.status).toBe(200);

    const workspace = await getOutingWorkspace(context(STARTER), outingId);
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({
      outing: { cutoffAt: null, cutoffTimeZone: null },
      myResponseStatus: "interested",
    });
  });
});

describe("invitation admission and participant privacy", () => {
  it("keeps pending requests out of the outing and accepts opt-in only for a verified account email", async () => {
    const outing = await makeOuting();
    const arbitrary = await requestAdmission(
      context(GUEST, ["owned@example.test"]),
      outing.inviteToken,
      { displayName: "Guest", emailOptIn: true, email: "someone-else@example.test" },
    );
    expect(arbitrary.status).toBe(400);
    expect(arbitrary.body.error).toBe("verified_email_required");

    const pending = await requestAdmission(
      context(GUEST, ["guest@example.test"]),
      outing.inviteToken,
      { displayName: "Guest", emailOptIn: true, email: "guest@example.test" },
    );
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ status: "pending" });
    expect(await getInvitationStatus(context(GUEST), outing.inviteToken)).toMatchObject({
      status: 200,
      body: { status: "pending" },
    });
    expect((await getOutingWorkspace(context(GUEST), outing.id)).status).toBe(404);

    const starterView = await getOutingWorkspace(context(STARTER), outing.id);
    expect(JSON.stringify(starterView.body)).toContain(GUEST);
    expect(JSON.stringify(starterView.body)).not.toContain("guest@example.test");
    expect(JSON.stringify(starterView.body)).toContain("Synthetic movie plan");

    const admitted = await handlePlanningAction(context(STARTER), outing.id, {
      action: "decide_admission",
      userId: GUEST,
      decision: "admit",
    });
    expect(admitted.status).toBe(200);
    expect(await getInvitationStatus(context(GUEST), outing.inviteToken)).toMatchObject({
      body: { status: "admitted", outingId: outing.id },
    });
  });

  it("returns each admitted participant only their own chat, conditions, and draft notes", async () => {
    const outing = await makeOuting();
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test");
    await requestAdmission(context(PENDING), outing.inviteToken, {
      displayName: "Not admitted yet",
      emailOptIn: false,
      email: null,
    });

    const starterAgent = new FakeAgent();
    const guestAgent = new FakeAgent();
    await sendMessage({ ...context(STARTER), agent: starterAgent }, outing.id, {
      clientMessageId: crypto.randomUUID(),
      content: "STARTER PRIVATE CONVERSATION",
    });
    await sendMessage({ ...context(GUEST), agent: guestAgent }, outing.id, {
      clientMessageId: crypto.randomUUID(),
      content: "GUEST PRIVATE CONVERSATION",
    });

    const options = await db.query<{ id: string; starts_at: string | Date; estimated_cost_cents: number }>(
      `select id, starts_at, estimated_cost_cents from outing_options where outing_id = $1 order by starts_at`,
      [outing.id],
    );
    await db.query(
      `update participant_preferences set private_input = $3
        where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER, "STARTER PRIVATE CONDITION"],
    );
    await db.query(
      `update participant_preferences set private_input = $3
        where outing_id = $1 and user_id = $2`,
      [outing.id, GUEST, "GUEST PRIVATE CONDITION"],
    );
    await db.query(
      `insert into offers
        (id, outing_id, owner_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, activity_tags, private_note, status)
       values ($1, $2, $3, $4, 'Movie', $5, $6, $7::jsonb, '["movie"]', $8, 'draft')`,
      [crypto.randomUUID(), outing.id, GUEST, options[0].id, options[0].starts_at,
        options[0].estimated_cost_cents, JSON.stringify([GUEST]), "GUEST DRAFT NOTE"],
    );

    const starterView = await getOutingWorkspace(context(STARTER), outing.id);
    const guestView = await getOutingWorkspace(context(GUEST), outing.id);
    const starterJson = JSON.stringify(starterView.body);
    const guestJson = JSON.stringify(guestView.body);

    expect(starterJson).toContain("STARTER PRIVATE CONVERSATION");
    expect(starterJson).not.toContain("GUEST PRIVATE CONVERSATION");
    expect(starterJson).not.toContain("GUEST PRIVATE CONDITION");
    expect(starterJson).not.toContain("GUEST DRAFT NOTE");
    expect(starterJson).toContain(PENDING);
    expect((starterView.body.participants as Array<Record<string, unknown>>).every(
      (participant) => !Object.hasOwn(participant, "responseStatus"),
    )).toBe(true);

    expect(guestJson).toContain("GUEST PRIVATE CONVERSATION");
    expect(guestJson).not.toContain("STARTER PRIVATE CONVERSATION");
    expect(guestJson).not.toContain("STARTER PRIVATE CONDITION");
    expect(guestJson).toContain("GUEST DRAFT NOTE");
    expect(guestJson).not.toContain(PENDING);
  });
});

describe("email preference and manual option actions", () => {
  it("persists a verified opt-in, keeps later opt-ins from backfilling, and suppresses queued email on opt-out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outing = await makeOuting();
    const request = await requestAdmission(context(GUEST), outing.inviteToken, {
      displayName: "Guest",
      emailOptIn: false,
      email: null,
    });
    expect(request.status).toBe(200);
    const admission = await handlePlanningAction(context(STARTER), outing.id, {
      action: "decide_admission",
      userId: GUEST,
      decision: "admit",
    });
    expect(admission.status).toBe(200);

    const saved = await handlePlanningAction(context(GUEST, ["guest@example.test"]), outing.id, {
      action: "save_email_preferences",
      emailOptIn: true,
      email: "Guest@Example.test",
    });
    expect(saved.status).toBe(200);

    const freshWorkspace = await getOutingWorkspace(context(GUEST), outing.id);
    expect(freshWorkspace.body).toMatchObject({
      myEmailOptIn: true,
      myNotificationEmail: "guest@example.test",
    });
    const storedPreference = await db.query<{
      email_opt_in: boolean;
      notification_email: string | null;
    }>(
      `select email_opt_in, notification_email from participants where outing_id = $1 and user_id = $2`,
      [outing.id, GUEST],
    );
    expect(storedPreference[0]).toEqual({ email_opt_in: true, notification_email: "guest@example.test" });

    const malformed = await handlePlanningAction(context(GUEST, ["guest@example.test"]), outing.id, {
      action: "save_email_preferences",
      emailOptIn: true,
      email: "not-an-email",
    });
    expect(malformed).toMatchObject({ status: 400, body: { error: "invalid_input" } });

    const unverified = await handlePlanningAction(context(GUEST, ["owned@example.test"]), outing.id, {
      action: "save_email_preferences",
      emailOptIn: true,
      email: "guest@example.test",
    });
    expect(unverified).toMatchObject({ status: 400, body: { error: "verified_email_required" } });

    const unknownField = await handlePlanningAction(context(GUEST, ["guest@example.test"]), outing.id, {
      action: "save_email_preferences",
      emailOptIn: true,
      email: "guest@example.test",
      unexpected: true,
    });
    expect(unknownField).toMatchObject({ status: 400, body: { error: "invalid_input" } });

    const beforeQueuedEvent = await db.query<{ count: number | string }>(
      `select count(*)::int as count from email_outbox where outing_id = $1 and recipient_user_id = $2`,
      [outing.id, GUEST],
    );
    expect(Number(beforeQueuedEvent[0].count)).toBe(0);

    await db.query(
      `insert into email_outbox
        (id, outing_id, recipient_user_id, event_type, event_key, status, recipient_email)
       values ($1, $2, $3, 'admission', 'test-admission', 'pending', $4)`,
      [crypto.randomUUID(), outing.id, GUEST, "guest@example.test"],
    );
    const optedOut = await handlePlanningAction(context(GUEST, ["guest@example.test"]), outing.id, {
      action: "save_email_preferences",
      emailOptIn: false,
      email: null,
    });
    expect(optedOut.status).toBe(200);
    const optedOutWorkspace = await getOutingWorkspace(context(GUEST), outing.id);
    expect(optedOutWorkspace.body).toMatchObject({
      myEmailOptIn: false,
      myNotificationEmail: null,
    });
    const suppressedEvent = await db.query<{ status: string; error_code: string | null }>(
      `select status, error_code from email_outbox
        where outing_id = $1 and recipient_user_id = $2 and event_key = 'test-admission'`,
      [outing.id, GUEST],
    );
    expect(suppressedEvent[0]).toEqual({ status: "suppressed", error_code: "recipient_opted_out" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("creates a manual option through the action handler and rejects unknown action fields", async () => {
    const outing = await makeOuting();
    const input = {
      action: "add_option",
      title: "Manual late show",
      activity: "Movie",
      startsAt: "2026-11-02T02:00:00.000Z",
      estimatedCostCents: 1100,
      activityTags: ["movie"],
    };
    const rejected = await handlePlanningAction(context(STARTER), outing.id, {
      ...input,
      unexpected: true,
    });
    expect(rejected).toMatchObject({ status: 400, body: { error: "invalid_input" } });

    const added = await handlePlanningAction(context(STARTER), outing.id, input);
    expect(added.status).toBe(201);
    const option = await db.query<{
      title: string;
      activity: string;
      estimated_cost_cents: number;
      source: string;
    }>(
      `select title, activity, estimated_cost_cents, source from outing_options
        where outing_id = $1 and title = 'Manual late show'`,
      [outing.id],
    );
    expect(option).toEqual([{
      title: "Manual late show",
      activity: "Movie",
      estimated_cost_cents: 1100,
      source: "manual",
    }]);
  });
});

describe("model-generated offer boundary", () => {
  it("passes only the owner's recent bounded chat from this outing into offer generation", async () => {
    const agent = new FakeAgent();
    agent.candidate = {
      kind: "new_option",
      option: {
        title: "Sushi dinner",
        activity: "Sushi dinner",
        startsAt: "2026-11-07T03:00:00.000Z",
        estimatedCostCents: 4500,
        activityTags: ["sushi", "dinner"],
      },
      attendeeUserIds: [STARTER],
      counterOfferToId: null,
      privateNote: "Generic per-person estimate.",
    };
    const outing = await makeOuting(agent, { withFixtureOptions: false, suggestion: "Sushi Friday?" });
    const otherOuting = await makeOuting(new FakeAgent(), {
      withFixtureOptions: false,
      suggestion: "Dinner soon",
    });
    await admit(outing.id, outing.inviteToken, GUEST, "dan@example.test", "Dan");
    await admit(outing.id, outing.inviteToken, PENDING, "jolly@example.test", "Jolly");
    const conditions = emptyConditionInterpretation();
    await db.query(
      `insert into participant_preferences
        (outing_id, user_id, private_input, interpretation, interpretation_ready)
       values ($1, $2, '', $3::jsonb, true)
       on conflict (outing_id, user_id) do update
         set private_input = '', interpretation = excluded.interpretation, interpretation_ready = true`,
      [outing.id, STARTER, JSON.stringify(conditions)],
    );

    const sendOwnerMessage = (outingId: string, chatAgent: FakeAgent, content: string) =>
      sendMessage({ ...context(STARTER), agent: chatAgent }, outingId, {
        clientMessageId: crypto.randomUUID(),
        content,
      });
    const otherOutingAgent = new FakeAgent();
    const ownerDetail = "For this outing only, choose Kiku House near Central and Thomas; ask for patio seating.";
    expect((await sendOwnerMessage(
      otherOuting.id,
      otherOutingAgent,
      "OUTING_B_ONLY_PRIVATE_VENUE: Juniper Cafe on Camelback.",
    )).status).toBe(200);

    expect((await sendMessage({ ...context(GUEST), agent: new FakeAgent() }, outing.id, {
      clientMessageId: crypto.randomUUID(),
      content: "DAN_ONLY_PRIVATE_CHAT_MARKER: prefer a quiet table.",
    })).status).toBe(200);
    expect((await sendMessage({ ...context(PENDING), agent: new FakeAgent() }, outing.id, {
      clientMessageId: crypto.randomUUID(),
      content: "JOLLY_ONLY_PRIVATE_CHAT_MARKER: avoid the patio.",
    })).status).toBe(200);

    await db.query(
      `insert into messages (id, outing_id, owner_user_id, role, content, status, completed_at)
       select gen_random_uuid(), $1, $2, 'user', repeat('OLDER OWNER CHAT DETAIL ', 45), 'replied', now()
         from generate_series(1, 42)`,
      [outing.id, STARTER],
    );
    expect((await sendOwnerMessage(outing.id, agent, ownerDetail)).status).toBe(200);

    expect(await db.query<{ private_input: string }>(
      `select private_input from participant_preferences where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER],
    )).toEqual([{ private_input: "" }]);
    expect(await db.query<{ interpretation: unknown }>(
      `select interpretation from participant_preferences where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER],
    )).toEqual([{ interpretation: conditions }]);

    const generated = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);
    expect(generated.status).toBe(201);
    const input = agent.offerCalls[0] as OfferGenerationInput & {
      recentConversation?: Array<{ role: "user" | "agent"; content: string }>;
    };
    const recentConversation = input.recentConversation ?? [];
    expect(recentConversation.length).toBeLessThanOrEqual(40);
    expect(recentConversation.reduce((sum, message) => sum + message.content.length, 0)).toBe(8000);
    expect(recentConversation.slice(-2)).toEqual([
      { role: "user", content: ownerDetail },
      { role: "agent", content: "Synthetic reply." },
    ]);
    const modelInput = JSON.stringify(input);
    expect(modelInput).toContain(ownerDetail);
    expect(modelInput).not.toContain("OUTING_B_ONLY_PRIVATE_VENUE");
    expect(modelInput).not.toContain("DAN_ONLY_PRIVATE_CHAT_MARKER");
    expect(modelInput).not.toContain("JOLLY_ONLY_PRIVATE_CHAT_MARKER");
  });

  it("drafts a sushi option privately, then shares it only after publication and approval", async () => {
    const agent = new FakeAgent();
    agent.candidate = {
      kind: "new_option",
      option: {
        title: "Sushi dinner",
        activity: "Sushi dinner",
        startsAt: "2026-11-07T03:00:00.000Z",
        estimatedCostCents: 4500,
        activityTags: ["sushi", "dinner"],
      },
      attendeeUserIds: [STARTER],
      counterOfferToId: null,
      privateNote: "Generic per-person estimate.",
    };
    const outing = await makeOuting(agent, {
      withFixtureOptions: false,
      suggestion: "Sushi Friday?",
    });
    await admit(outing.id, outing.inviteToken, GUEST, "dan@example.test", "Dan");
    await admit(outing.id, outing.inviteToken, PENDING, "jolly@example.test", "Jolly");

    const ownerConditions = emptyConditionInterpretation();
    ownerConditions.hard.availableWindows = [{
      startsAt: "2026-11-07T02:00:00.000Z",
      endsAt: "2026-11-07T04:00:00.000Z",
    }];
    ownerConditions.hard.maxCostCents = 6000;
    ownerConditions.hard.requiredActivityTags = ["sushi"];
    await db.query(
      `update participant_preferences set private_input = $3, interpretation = $4::jsonb,
              interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER, "Sushi after 7 on Friday works for me.", JSON.stringify(ownerConditions)],
    );
    for (const [userId, privateInput] of [
      [GUEST, "DAN PRIVATE CONDITION"],
      [PENDING, "JOLLY PRIVATE CONDITION"],
    ]) {
      await db.query(
        `update participant_preferences set private_input = $3 where outing_id = $1 and user_id = $2`,
        [outing.id, userId, privateInput],
      );
    }

    const generated = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);
    expect(generated.status).toBe(201);
    expect(agent.offerCalls).toHaveLength(1);
    expect(agent.offerCalls[0]).toMatchObject({
      outing: { suggestion: "Sushi Friday?" },
      privateInput: "Sushi after 7 on Friday works for me.",
      privateConditions: ownerConditions,
      options: [],
      participants: [{ userId: STARTER, displayName: "Starter" }],
    });
    const modelInput = JSON.stringify(agent.offerCalls[0]);
    expect(modelInput).not.toContain("DAN PRIVATE CONDITION");
    expect(modelInput).not.toContain("JOLLY PRIVATE CONDITION");

    const offer = generated.body.offer as { id: string; optionId: string };
    const savedOption = await db.query<{ source: string; visibility: string; title: string }>(
      `select source, visibility, title from outing_options where id = $1`,
      [offer.optionId],
    );
    expect(savedOption).toEqual([{ source: "agent", visibility: "private", title: "Sushi dinner" }]);
    const ownerView = await getOutingWorkspace(context(STARTER), outing.id);
    expect(ownerView.body.options).toEqual([]);
    expect(ownerView.body.myDraftOffers).toMatchObject([
      { optionTitle: "Sushi dinner", activity: "Sushi dinner", privateNote: "Generic per-person estimate." },
    ]);
    const danView = await getOutingWorkspace(context(GUEST), outing.id);
    const jollyView = await getOutingWorkspace(context(PENDING), outing.id);
    expect(danView.body.options).toEqual([]);
    expect(danView.body.myDraftOffers).toEqual([]);
    expect(jollyView.body.options).toEqual([]);
    expect(JSON.stringify(danView.body)).not.toContain("Sushi dinner");
    expect(JSON.stringify(jollyView.body)).not.toContain("Sushi dinner");
    const responsesBeforePublish = await db.query<{ user_id: string; response_status: string }>(
      `select user_id, response_status from participants where outing_id = $1 order by created_at`,
      [outing.id],
    );
    expect(responsesBeforePublish).toEqual([
      { user_id: STARTER, response_status: "interested" },
      { user_id: GUEST, response_status: "pending" },
      { user_id: PENDING, response_status: "pending" },
    ]);

    const published = await handlePlanningAction(context(STARTER), outing.id, {
      action: "publish_offer",
      offerId: offer.id,
    });
    expect(published.status).toBe(200);
    const sharedOption = await db.query<{ visibility: string }>(
      `select visibility from outing_options where id = $1`,
      [offer.optionId],
    );
    expect(sharedOption[0].visibility).toBe("shared");
    const danViewAfterPublish = await getOutingWorkspace(context(GUEST), outing.id);
    expect(danViewAfterPublish.body.options).toMatchObject([
      { title: "Sushi dinner", activity: "Sushi dinner", source: "agent" },
    ]);

    await db.query(`update outings set cutoff_processed_at = now() where id = $1`, [outing.id]);
    const proposalResult = await handlePlanningAction(context(STARTER), outing.id, {
      action: "publish_proposal",
      offerId: offer.id,
    });
    expect(proposalResult.status).toBe(201);
    const proposal = proposalResult.body.proposal as { id: string; revision: number; attendeeUserIds: string[] };
    expect(proposal.attendeeUserIds).toEqual([STARTER]);
    const approval = await handlePlanningAction(context(STARTER), outing.id, {
      action: "approve_proposal",
      proposalId: proposal.id,
      revision: proposal.revision,
    });
    expect(approval).toMatchObject({ status: 200, body: { status: "confirmed" } });
    const confirmed = await db.query<{ status: string; count: number | string }>(
      `select p.status, (select count(*)::int from proposal_approvals a where a.proposal_id = p.id) as count
         from proposals p where p.id = $1`,
      [proposal.id],
    );
    expect(confirmed).toEqual([{ status: "confirmed", count: 1 }]);
  });

  it.each([
    {
      name: "a reasonable synonym for the suggested activity",
      suggestion: "Japanese food Friday?",
      privateNote: "Generic per-person estimate.",
    },
    {
      name: "a disclaimer that negates a price verification claim",
      suggestion: "Sushi Friday?",
      privateNote: "This is an estimate, not a verified price.",
    },
  ])("accepts $name while keeping the draft private", async ({ suggestion, privateNote }) => {
    const agent = new FakeAgent();
    agent.candidate = {
      kind: "new_option",
      option: {
        title: "Sushi dinner",
        activity: "Sushi dinner",
        startsAt: "2026-11-07T03:00:00.000Z",
        estimatedCostCents: 4500,
        activityTags: ["sushi", "dinner"],
      },
      attendeeUserIds: [STARTER],
      counterOfferToId: null,
      privateNote,
    };
    const outing = await makeOuting(agent, { withFixtureOptions: false, suggestion });
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test", "Guest");
    const conditions = emptyConditionInterpretation();
    await db.query(
      `update participant_preferences set private_input = '', interpretation = $3::jsonb,
              interpretation_ready = true where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER, JSON.stringify(conditions)],
    );

    const generated = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);

    expect(generated.status).toBe(201);
    const offer = generated.body.offer as { id: string; optionId: string };
    expect(await db.query<{ source: string; visibility: string }>(
      `select source, visibility from outing_options where id = $1`, [offer.optionId],
    )).toEqual([{ source: "agent", visibility: "private" }]);
    expect(await db.query<{ status: string }>(
      `select status from offers where id = $1`, [offer.id],
    )).toEqual([{ status: "draft" }]);

    const ownerView = await getOutingWorkspace(context(STARTER), outing.id);
    const guestView = await getOutingWorkspace(context(GUEST), outing.id);
    expect(ownerView.body.options).toEqual([]);
    expect(ownerView.body.myDraftOffers).toMatchObject([{ optionTitle: "Sushi dinner", privateNote }]);
    expect(guestView.body.options).toEqual([]);
    expect(guestView.body.myDraftOffers).toEqual([]);
    expect(JSON.stringify(guestView.body)).not.toContain("Sushi dinner");
  });

  it("publishes a private sushi draft for three constrained attendees and waits for every approval", async () => {
    const agent = new FakeAgent();
    agent.candidate = {
      kind: "new_option",
      option: {
        title: "Sushi dinner",
        activity: "Sushi dinner",
        startsAt: "2026-11-07T03:00:00.000Z",
        estimatedCostCents: 4500,
        activityTags: ["sushi", "dinner"],
      },
      attendeeUserIds: [STARTER, GUEST, PENDING],
      counterOfferToId: null,
      privateNote: "Generic per-person estimate.",
    };
    const outing = await makeOuting(agent, {
      withFixtureOptions: false,
      suggestion: "Sushi Friday?",
    });
    await admit(outing.id, outing.inviteToken, GUEST, "dan@example.test", "Dan");
    await admit(outing.id, outing.inviteToken, PENDING, "jolly@example.test", "Jolly");

    const attendeeIds = [STARTER, GUEST, PENDING];
    const attendeeNames = ["Starter", "Dan", "Jolly"];
    const privateInputs = [
      "Sushi works after 7 on Friday.",
      "DAN'S PRIVATE CONDITION: budget under $52 and Friday available.",
      "JOLLY'S PRIVATE CONDITION: budget under $50 and Friday available.",
    ];
    for (const [index, userId] of attendeeIds.entries()) {
      const conditions = emptyConditionInterpretation();
      conditions.hard.availableWindows = [{
        startsAt: "2026-11-07T02:00:00.000Z",
        endsAt: "2026-11-07T04:00:00.000Z",
      }];
      conditions.hard.maxCostCents = [6000, 5200, 5000][index];
      conditions.hard.requiredActivityTags = ["sushi"];
      conditions.hard.minimumGroupSize = 3;
      conditions.hard.attendanceDependencies = [
        [GUEST], [PENDING], [STARTER],
      ][index];
      await db.query(
        `update participant_preferences set private_input = $3, interpretation = $4::jsonb,
                interpretation_ready = true where outing_id = $1 and user_id = $2`,
        [outing.id, userId, privateInputs[index], JSON.stringify(conditions)],
      );
      const interest = await handlePlanningAction(context(userId), outing.id, {
        action: "set_interest",
        interested: true,
      });
      expect(interest.status).toBe(200);
    }

    const generated = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);
    expect(generated.status).toBe(201);
    expect(agent.offerCalls[0].participants).toEqual(attendeeIds.map((userId, index) => ({
      userId,
      displayName: attendeeNames[index],
    })));
    const modelInput = JSON.stringify(agent.offerCalls[0]);
    expect(modelInput).toContain(privateInputs[0]);
    expect(modelInput).not.toContain(privateInputs[1]);
    expect(modelInput).not.toContain(privateInputs[2]);

    const offer = generated.body.offer as { id: string; optionId: string };
    expect(await db.query<{ visibility: string }>(
      `select visibility from outing_options where id = $1`, [offer.optionId],
    )).toEqual([{ visibility: "private" }]);
    for (const userId of [GUEST, PENDING]) {
      const view = await getOutingWorkspace(context(userId), outing.id);
      expect(view.body.options).toEqual([]);
      expect(view.body.myDraftOffers).toEqual([]);
      expect(JSON.stringify(view.body)).not.toContain("Sushi dinner");
    }

    const published = await handlePlanningAction(context(STARTER), outing.id, {
      action: "publish_offer",
      offerId: offer.id,
    });
    expect(published.status).toBe(200);
    expect(await db.query<{ visibility: string }>(
      `select visibility from outing_options where id = $1`, [offer.optionId],
    )).toEqual([{ visibility: "shared" }]);

    await db.query(`update outings set cutoff_processed_at = now() where id = $1`, [outing.id]);
    const proposalResult = await handlePlanningAction(context(STARTER), outing.id, {
      action: "publish_proposal",
      offerId: offer.id,
    });
    expect(proposalResult.status).toBe(201);
    const proposal = proposalResult.body.proposal as { id: string; revision: number };
    for (const [index, userId] of attendeeIds.entries()) {
      const approval = await handlePlanningAction(context(userId), outing.id, {
        action: "approve_proposal",
        proposalId: proposal.id,
        revision: proposal.revision,
      });
      if (index < 2) {
        expect(approval).toMatchObject({ status: 200, body: { status: "awaiting_others" } });
        expect(await db.query<{ status: string; count: number | string }>(
          `select p.status, (select count(*)::int from proposal_approvals a where a.proposal_id = p.id) as count
             from proposals p where p.id = $1`,
          [proposal.id],
        )).toEqual([{ status: "published", count: index + 1 }]);
      } else {
        expect(approval).toMatchObject({ status: 200, body: { status: "confirmed" } });
      }
    }
    expect(await db.query<{ status: string; count: number | string; attendee_user_ids: unknown }>(
      `select p.status,
              (select count(*)::int from proposal_approvals a where a.proposal_id = p.id) as count,
              p.attendee_user_ids
         from proposals p where p.id = $1`,
      [proposal.id],
    )).toEqual([{ status: "confirmed", count: 3, attendee_user_ids: attendeeIds }]);
  });

  it("returns a private clarification and writes no option or offer when details are missing", async () => {
    const agent = new FakeAgent();
    agent.candidate = {
      kind: "clarification",
      question: "Which date and time should I use for dinner?",
    };
    const outing = await makeOuting(agent, {
      withFixtureOptions: false,
      suggestion: "Let's do something soon.",
    });
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER, JSON.stringify(emptyConditionInterpretation())],
    );

    const response = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);

    expect(response).toEqual({
      status: 409,
      body: { error: "clarification_required", question: "Which date and time should I use for dinner?" },
    });
    expect(agent.offerCalls[0].options).toEqual([]);
    await expect(db.query(`select id from outing_options where outing_id = $1`, [outing.id])).resolves.toHaveLength(0);
    await expect(db.query(`select id from offers where outing_id = $1`, [outing.id])).resolves.toHaveLength(0);
  });

  it.each([
    {
      name: "a malformed date",
      candidate: {
        kind: "new_option",
        option: {
          title: "Sushi dinner",
          activity: "Sushi dinner",
          startsAt: "next Friday",
          estimatedCostCents: 4500,
          activityTags: ["sushi"],
        },
        attendeeUserIds: [STARTER],
        counterOfferToId: null,
        privateNote: "",
      } as unknown as OfferGenerationResult,
      expected: { status: 502, body: { error: "invalid_output" } },
    },
    {
      name: "a malformed price",
      candidate: {
        kind: "new_option",
        option: {
          title: "Sushi dinner",
          activity: "Sushi dinner",
          startsAt: "2026-11-07T03:00:00.000Z",
          estimatedCostCents: 45.5,
          activityTags: ["sushi"],
        },
        attendeeUserIds: [STARTER],
        counterOfferToId: null,
        privateNote: "",
      } as unknown as OfferGenerationResult,
      expected: { status: 502, body: { error: "invalid_output" } },
    },
    {
      name: "a cost over the owner's hard limit",
      candidate: {
        kind: "new_option",
        option: {
          title: "Sushi dinner",
          activity: "Sushi dinner",
          startsAt: "2026-11-07T03:00:00.000Z",
          estimatedCostCents: 6500,
          activityTags: ["sushi"],
        },
        attendeeUserIds: [STARTER],
        counterOfferToId: null,
        privateNote: "",
      } satisfies OfferGenerationResult,
      expected: { status: 409, body: { error: "offer_not_feasible", reason: "condition_conflict" } },
    },
  ])("rejects $name without creating a draft option or offer", async ({ candidate, expected }) => {
    const agent = new FakeAgent();
    agent.candidate = candidate;
    const outing = await makeOuting(agent, { withFixtureOptions: false, suggestion: "Sushi Friday?" });
    const conditions = emptyConditionInterpretation();
    conditions.hard.maxCostCents = 6000;
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER, JSON.stringify(conditions)],
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let response: Awaited<ReturnType<typeof handlePlanningAction>>;
    try {
      response = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);
    } finally {
      warning.mockRestore();
    }

    expect(response).toMatchObject(expected);
    await expect(db.query(`select id from outing_options where outing_id = $1`, [outing.id])).resolves.toHaveLength(0);
    await expect(db.query(`select id from offers where outing_id = $1`, [outing.id])).resolves.toHaveLength(0);
  });

  it("hides and blocks legacy sample drafts while preserving confirmed history and approvals", async () => {
    const agent = new FakeAgent();
    const outing = await makeOuting(agent, { withFixtureOptions: false, suggestion: "Sushi Friday?" });
    const sampleOptionId = crypto.randomUUID();
    const sampleDraftId = crypto.randomUUID();
    const samplePublishedId = crypto.randomUUID();
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Old movie option', 'Movie', '2026-11-02T02:00:00Z',
               900, '["movie"]', 'sample')`,
      [sampleOptionId, outing.id, STARTER],
    );
    for (const [offerId, status] of [[sampleDraftId, "draft"], [samplePublishedId, "published"]]) {
      await db.query(
        `insert into offers
          (id, outing_id, owner_user_id, option_id, activity, starts_at,
           estimated_cost_cents, attendee_user_ids, activity_tags, private_note, status)
         values ($1, $2, $3, $4, 'Movie', '2026-11-02T02:00:00Z', 900,
                 $5::jsonb, '["movie"]', '', $6)`,
        [offerId, outing.id, STARTER, sampleOptionId, JSON.stringify([STARTER]), status],
      );
    }
    agent.candidate = {
      optionId: sampleOptionId,
      activity: "Movie",
      startsAt: "2026-11-02T02:00:00.000Z",
      estimatedCostCents: 900,
      activityTags: ["movie"],
      attendeeUserIds: [STARTER],
      counterOfferToId: null,
      privateNote: "",
    };
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [outing.id, STARTER, JSON.stringify(emptyConditionInterpretation())],
    );
    await db.query(`update outings set cutoff_processed_at = now() where id = $1`, [outing.id]);

    const before = await getOutingWorkspace(context(STARTER), outing.id);
    expect(before.body.options).toEqual([]);
    expect(before.body.offers).toEqual([]);
    expect(before.body.myDraftOffers).toEqual([]);
    const generated = await handlePlanningAction(context(STARTER), outing.id, { action: "generate_offer" }, () => agent);
    expect(generated).toMatchObject({ status: 409, body: { error: "offer_not_feasible" } });
    expect(agent.offerCalls[0].options).toEqual([]);

    const blockedDraft = await handlePlanningAction(context(STARTER), outing.id, {
      action: "publish_offer",
      offerId: sampleDraftId,
    });
    expect(blockedDraft).toMatchObject({ status: 409, body: { error: "option_unavailable" } });
    const blockedProposal = await handlePlanningAction(context(STARTER), outing.id, {
      action: "publish_proposal",
      offerId: samplePublishedId,
    });
    expect(blockedProposal).toMatchObject({ status: 409, body: { error: "option_unavailable" } });

    const proposalId = crypto.randomUUID();
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at, confirmed_at)
       values ($1, $2, 1, $3, $4, 'Movie', '2026-11-02T02:00:00Z', 900,
               $5::jsonb, 'confirmed', 'initial', now(), now() + interval '30 minutes', now())`,
      [proposalId, outing.id, STARTER, sampleOptionId, JSON.stringify([STARTER])],
    );
    await db.query(
      `insert into proposal_approvals (proposal_id, outing_id, user_id, revision)
       values ($1, $2, $3, 1)`,
      [proposalId, outing.id, STARTER],
    );
    const after = await getOutingWorkspace(context(STARTER), outing.id);
    expect(after.body.options).toEqual([]);
    expect(after.body.confirmedProposal).toMatchObject({
      id: proposalId,
      activity: "Movie",
      approvalCount: 1,
    });
    const stored = await db.query<{ options: number; offers: number; approvals: number }>(
      `select
         (select count(*)::int from outing_options where id = $1) as options,
         (select count(*)::int from offers where outing_id = $2 and id = any($3::uuid[])) as offers,
         (select count(*)::int from proposal_approvals where proposal_id = $4) as approvals`,
      [sampleOptionId, outing.id, [sampleDraftId, samplePublishedId], proposalId],
    );
    expect(stored[0]).toEqual({ options: 1, offers: 2, approvals: 1 });
  });

  it("returns the existing not-feasible error when the owner's catalog has no compatible options", async () => {
    const outing = await makeOuting();
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test");
    const interpretation = emptyConditionInterpretation();
    interpretation.hard.availableWindows = [{
      startsAt: "2026-11-01T02:01:00.000Z",
      endsAt: "2026-11-01T06:00:00.000Z",
    }];
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [outing.id, GUEST, JSON.stringify(interpretation)],
    );
    await db.query(
      `update participants set response_status = 'interested' where outing_id = $1 and user_id = $2`,
      [outing.id, GUEST],
    );
    const agent = new FakeAgent();
    agent.offerError = new AgentError("no_feasible_options");

    const response = await handlePlanningAction(
      context(GUEST),
      outing.id,
      { action: "generate_offer" },
      () => agent,
    );

    expect(response).toEqual({ status: 409, body: { error: "offer_not_feasible" } });
    expect(agent.offerCalls).toHaveLength(1);
    const drafts = await db.query<{ id: string }>(
      `select id from offers where outing_id = $1 and owner_user_id = $2 and status = 'draft'`,
      [outing.id, GUEST],
    );
    expect(drafts).toHaveLength(0);
  });

  it("passes only the owner's private data and rejects model output that violates hard limits", async () => {
    const outing = await makeOuting();
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test");
    const options = await db.query<{
      id: string;
      activity: string;
      starts_at: string | Date;
      estimated_cost_cents: number;
      activity_tags: unknown;
    }>(`select id, activity, starts_at, estimated_cost_cents, activity_tags
         from outing_options where outing_id = $1 order by starts_at`, [outing.id]);
    const interpretations = [
      { userId: STARTER, input: "STARTER MUST STAY PRIVATE", cost: null },
      { userId: GUEST, input: "GUEST PRIVATE BUDGET", cost: 700 },
    ];
    for (const row of interpretations) {
      const interpretation = emptyConditionInterpretation();
      interpretation.hard.maxCostCents = row.cost;
      await db.query(
        `update participant_preferences set private_input = $3, interpretation = $4::jsonb,
                interpretation_ready = true, rankings = $5::jsonb
          where outing_id = $1 and user_id = $2`,
        [outing.id, row.userId, row.input, JSON.stringify(interpretation), JSON.stringify([options[0].id])],
      );
      await db.query(
        `update participants set response_status = 'interested' where outing_id = $1 and user_id = $2`,
        [outing.id, row.userId],
      );
    }
    const sharedOfferId = crypto.randomUUID();
    await db.query(
      `insert into offers
        (id, outing_id, owner_user_id, option_id, activity, starts_at, estimated_cost_cents,
         attendee_user_ids, activity_tags, private_note, status, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '["movie"]', 'SHARED SECRET NOTE', 'published', now())`,
      [sharedOfferId, outing.id, STARTER, options[0].id, options[0].activity,
        options[0].starts_at, options[0].estimated_cost_cents, JSON.stringify([STARTER])],
    );

    const agent = new FakeAgent();
    agent.candidate = {
      optionId: options[0].id,
      activity: options[0].activity,
      startsAt: new Date(options[0].starts_at).toISOString(),
      estimatedCostCents: options[0].estimated_cost_cents,
      activityTags: ["movie"],
      attendeeUserIds: [GUEST],
      counterOfferToId: sharedOfferId,
      privateNote: "GUEST-ONLY OFFER NOTE",
    };
    const factory = () => agent;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejected: Awaited<ReturnType<typeof handlePlanningAction>>;
    let warningCalls: unknown[][] = [];
    try {
      rejected = await handlePlanningAction(context(GUEST), outing.id, { action: "generate_offer" }, factory);
      warningCalls = warning.mock.calls.map((call) => [...call]);
    } finally {
      warning.mockRestore();
    }
    expect(rejected).toEqual({
      status: 409,
      body: { error: "offer_not_feasible", reason: "condition_conflict" },
    });
    expect(warningCalls).toEqual([[
      "[offer-candidate-ineligible]",
      "condition_conflict",
    ]]);
    const diagnosticText = JSON.stringify({ body: rejected.body, logs: warningCalls });
    for (const privateValue of [
      outing.id,
      STARTER,
      GUEST,
      "GUEST PRIVATE BUDGET",
      "STARTER MUST STAY PRIVATE",
      "GUEST-ONLY OFFER NOTE",
      "SHARED SECRET NOTE",
    ]) {
      expect(diagnosticText).not.toContain(privateValue);
    }
    const failedDrafts = await db.query<{ id: string }>(
      `select id from offers where outing_id = $1 and owner_user_id = $2 and status = 'draft'`,
      [outing.id, GUEST],
    );
    expect(failedDrafts).toHaveLength(0);
    expect(agent.offerCalls).toHaveLength(1);
    const modelInput = JSON.stringify(agent.offerCalls[0]);
    expect(modelInput).toContain("GUEST PRIVATE BUDGET");
    expect(modelInput).not.toContain("STARTER MUST STAY PRIVATE");
    expect(modelInput).not.toContain("SHARED SECRET NOTE");
    const persisted = await db.query<{ interpretation: unknown }>(
      `select interpretation from participant_preferences where outing_id = $1 and user_id = $2`,
      [outing.id, GUEST],
    );
    const persistedInterpretation = typeof persisted[0].interpretation === "string"
      ? JSON.parse(persisted[0].interpretation)
      : persisted[0].interpretation;
    expect(persistedInterpretation).toMatchObject({ hard: { maxCostCents: 700 } });
    const beforeApproval = await db.query<{ proposals: number; approvals: number }>(
      `select
         (select count(*)::int from proposals where outing_id = $1) as proposals,
         (select count(*)::int from proposal_approvals where outing_id = $1) as approvals`,
      [outing.id],
    );
    expect(beforeApproval[0]).toEqual({ proposals: 0, approvals: 0 });

    const relaxed = emptyConditionInterpretation();
    relaxed.hard.maxCostCents = 1000;
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb where outing_id = $1 and user_id = $2`,
      [outing.id, GUEST, JSON.stringify(relaxed)],
    );
    const accepted = await handlePlanningAction(context(GUEST), outing.id, { action: "generate_offer" }, factory);
    expect(accepted.status).toBe(201);
    expect(agent.offerCalls).toHaveLength(2);
    const stored = await db.query<{ id: string; counter_offer_to_id: string | null; private_note: string }>(
      `select id, counter_offer_to_id, private_note from offers where owner_user_id = $1 and status = 'draft'`,
      [GUEST],
    );
    expect(stored[0]).toMatchObject({ counter_offer_to_id: sharedOfferId, private_note: "GUEST-ONLY OFFER NOTE" });
    const afterOffer = await db.query<{ proposals: number; approvals: number }>(
      `select
         (select count(*)::int from proposals where outing_id = $1) as proposals,
         (select count(*)::int from proposal_approvals where outing_id = $1) as approvals`,
      [outing.id],
    );
    expect(afterOffer[0]).toEqual({ proposals: 0, approvals: 0 });
    const guestView = await getOutingWorkspace(context(GUEST), outing.id);
    expect(JSON.stringify(guestView.body)).toContain("GUEST-ONLY OFFER NOTE");
    const starterView = await getOutingWorkspace(context(STARTER), outing.id);
    expect(JSON.stringify(starterView.body)).not.toContain("GUEST-ONLY OFFER NOTE");
  });

  const dependencyCases: Array<{
    name: string;
    dependencies: Record<string, string[]>;
    minimumGroupSizes: Record<string, number>;
    uninterested: string[];
    attendees: string[];
    expectedStatus: 201 | 409;
  }> = [
    {
      name: "mutual attendance dependencies are satisfied when both people are included",
      dependencies: { [STARTER]: [GUEST], [GUEST]: [STARTER] },
      minimumGroupSizes: {},
      uninterested: [PENDING],
      attendees: [STARTER, GUEST],
      expectedStatus: 201,
    },
    {
      name: "a required person cannot be omitted from an otherwise willing group",
      dependencies: { [STARTER]: [PENDING] },
      minimumGroupSizes: {},
      uninterested: [],
      attendees: [STARTER, GUEST],
      expectedStatus: 409,
    },
    {
      name: "the candidate cannot fall below a participant's minimum group size",
      dependencies: {},
      minimumGroupSizes: { [STARTER]: 3 },
      uninterested: [],
      attendees: [STARTER, GUEST],
      expectedStatus: 409,
    },
    {
      name: "a smaller willing group remains feasible when the third person opts out",
      dependencies: {},
      minimumGroupSizes: {},
      uninterested: [PENDING],
      attendees: [STARTER, GUEST],
      expectedStatus: 201,
    },
  ];

  it.each(dependencyCases)("$name", async ({ dependencies, minimumGroupSizes, uninterested, attendees, expectedStatus }) => {
    const outing = await makeOuting();
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test");
    await admit(outing.id, outing.inviteToken, PENDING, "pending@example.test");
    const options = await db.query<{
      id: string;
      activity: string;
      starts_at: string | Date;
      estimated_cost_cents: number;
      activity_tags: unknown;
    }>(
      `select id, activity, starts_at, estimated_cost_cents, activity_tags
         from outing_options where outing_id = $1 order by starts_at limit 1`,
      [outing.id],
    );
    for (const userId of [STARTER, GUEST, PENDING]) {
      const interpretation = emptyConditionInterpretation();
      interpretation.hard.attendanceDependencies = dependencies[userId] ?? [];
      interpretation.hard.minimumGroupSize = minimumGroupSizes[userId] ?? 1;
      await db.query(
        `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
          where outing_id = $1 and user_id = $2`,
        [outing.id, userId, JSON.stringify(interpretation)],
      );
      await db.query(
        `update participants set response_status = $3 where outing_id = $1 and user_id = $2`,
        [outing.id, userId, uninterested.includes(userId) ? "not_interested" : "interested"],
      );
    }

    const agent = new FakeAgent();
    agent.candidate = {
      optionId: options[0].id,
      activity: options[0].activity,
      startsAt: new Date(options[0].starts_at).toISOString(),
      estimatedCostCents: options[0].estimated_cost_cents,
      activityTags: typeof options[0].activity_tags === "string"
        ? JSON.parse(options[0].activity_tags)
        : options[0].activity_tags as string[],
      attendeeUserIds: attendees,
      counterOfferToId: null,
      privateNote: "Synthetic candidate note",
    };
    const result = await handlePlanningAction(
      context(STARTER), outing.id, { action: "generate_offer" }, () => agent,
    );

    if (expectedStatus === 409) {
      expect(result).toMatchObject({
        status: 409,
        body: { error: "offer_not_feasible", reason: "condition_conflict" },
      });
    } else {
      expect(result.status).toBe(201);
      const drafts = await db.query<{ attendee_user_ids: unknown }>(
        `select attendee_user_ids from offers where outing_id = $1 and owner_user_id = $2 and status = 'draft'`,
        [outing.id, STARTER],
      );
      expect(drafts[0]?.attendee_user_ids).toEqual(attendees);
    }

    const outcomes = await db.query<{ offers: number; proposals: number; approvals: number }>(
      `select
         (select count(*)::int from offers where outing_id = $1 and owner_user_id = $2 and status = 'draft') as offers,
         (select count(*)::int from proposals where outing_id = $1) as proposals,
         (select count(*)::int from proposal_approvals where outing_id = $1) as approvals`,
      [outing.id, STARTER],
    );
    expect(outcomes[0]).toEqual({
      offers: expectedStatus === 201 ? 1 : 0,
      proposals: 0,
      approvals: 0,
    });
    expect(agent.offerCalls).toHaveLength(1);
  });
});

describe("tie poll terminal handling", () => {
  it("closes open private polls when an outing ends and refuses late answers without moving its retention timestamp", async () => {
    const outing = await makeOuting();
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test");
    const participants = [STARTER, GUEST];
    for (const userId of participants) {
      await db.query(
        `update participants set response_status = 'interested' where outing_id = $1 and user_id = $2`,
        [outing.id, userId],
      );
      const interpretation = emptyConditionInterpretation();
      await db.query(
        `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
          where outing_id = $1 and user_id = $2`,
        [outing.id, userId, JSON.stringify(interpretation)],
      );
    }
    await db.query(`update outings set cutoff_processed_at = now() where id = $1`, [outing.id]);
    const options = await db.query<{ id: string }>(
      `select id from outing_options where outing_id = $1 order by starts_at`, [outing.id],
    );
    const opened = await handlePlanningAction(context(STARTER), outing.id, {
      action: "start_tie_poll", optionAId: options[0].id, optionBId: options[1].id,
    });
    expect(opened.status).toBe(201);
    const pollId = opened.body.myTiePoll && (opened.body.myTiePoll as { id: string }).id;
    expect(pollId).toBeTruthy();

    const ending = await handlePlanningAction(context(STARTER), outing.id, { action: "end_outing" });
    expect(ending.status).toBe(200);
    const beforeLateAnswer = await db.query<{ ended_at: string | Date; status: string }>(
      `select o.ended_at, t.status from outings o join tie_polls t on t.outing_id = o.id
        where o.id = $1 and t.id = $2`, [outing.id, pollId],
    );
    expect(beforeLateAnswer[0].status).toBe("no_agreement");
    const endedAt = new Date(beforeLateAnswer[0].ended_at).toISOString();
    const lateAnswer = await handlePlanningAction(context(GUEST), outing.id, {
      action: "answer_tie", pollId, answer: "either",
    });
    expect(lateAnswer.status).toBe(404);
    const state = await db.query<{ ended_at: string | Date; status: string }>(
      `select ended_at, status from outings where id = $1`, [outing.id],
    );
    expect(state[0].status).toBe("ended");
    expect(new Date(state[0].ended_at).toISOString()).toBe(endedAt);
  });
});

describe("tie polling regressions", () => {
  it("allows only one open poll and returns the resolved outcome from the last answer", async () => {
    const outing = await makeOuting();
    await admit(outing.id, outing.inviteToken, GUEST, "guest@example.test");
    for (const userId of [STARTER, GUEST]) {
      await db.query(
        `update participants set response_status = 'interested' where outing_id = $1 and user_id = $2`,
        [outing.id, userId],
      );
      await db.query(
        `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
          where outing_id = $1 and user_id = $2`,
        [outing.id, userId, JSON.stringify(emptyConditionInterpretation())],
      );
    }
    await db.query(`update outings set cutoff_processed_at = now() where id = $1`, [outing.id]);
    const options = await db.query<{ id: string }>(
      `select id from outing_options where outing_id = $1 order by starts_at`, [outing.id],
    );
    const thirdId = crypto.randomUUID();
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at, estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Manual late show', 'Movie', now() + interval '2 days', 1100, '["movie"]', 'manual')`,
      [thirdId, outing.id, STARTER],
    );

    const opened = await handlePlanningAction(context(STARTER), outing.id, {
      action: "start_tie_poll", optionAId: options[0].id, optionBId: options[1].id,
    });
    expect(opened.status).toBe(201);
    const pollId = (opened.body.myTiePoll as { id: string }).id;

    const secondPoll = await handlePlanningAction(context(STARTER), outing.id, {
      action: "start_tie_poll", optionAId: options[0].id, optionBId: thirdId,
    });
    expect(secondPoll).toMatchObject({ status: 409, body: { error: "tie_poll_already_open" } });

    const first = await handlePlanningAction(context(STARTER), outing.id, {
      action: "answer_tie", pollId, answer: "either",
    });
    expect(first).toMatchObject({ status: 200, body: { status: "open", outcome: null } });
    const last = await handlePlanningAction(context(GUEST), outing.id, {
      action: "answer_tie", pollId, answer: "either",
    });
    expect(last).toMatchObject({ status: 200, body: { status: "resolved", outcome: "either" } });
  });
});
