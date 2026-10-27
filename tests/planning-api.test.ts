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
import { emptyConditionInterpretation, type OfferCandidate } from "@/lib/planning-types";

const STARTER = "starter-user";
const GUEST = "guest-user";
const PENDING = "pending-user";

let pg: PGlite;
let db: Db;

class FakeAgent implements Agent {
  calls: AgentTurnInput[] = [];
  offerCalls: OfferGenerationInput[] = [];
  candidate: OfferCandidate | null = null;
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

async function makeOuting(agent = new FakeAgent()) {
  const created = await createOuting(context(STARTER), {
    suggestion: "Synthetic movie plan",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  expect(created.status).toBe(201);
  return {
    id: (created.body.outing as { id: string }).id,
    inviteToken: (created.body.outing as { inviteToken: string }).inviteToken,
    agent,
  };
}

async function admit(outingId: string, token: string, userId: string, email: string) {
  const request = await requestAdmission(
    context(userId, [email]),
    token,
    { displayName: userId, emailOptIn: true, email },
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
    const guestView = await getOutingWorkspace(context(GUEST), outing.id);
    expect(JSON.stringify(guestView.body)).toContain("GUEST-ONLY OFFER NOTE");
    const starterView = await getOutingWorkspace(context(STARTER), outing.id);
    expect(JSON.stringify(starterView.body)).not.toContain("GUEST-ONLY OFFER NOTE");
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
