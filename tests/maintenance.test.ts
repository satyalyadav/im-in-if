import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import { getOuting, createOuting } from "@/lib/outings-api";
import { getMaintenanceHealth, processOutingDeadlines, sweepDueWork } from "@/lib/maintenance";
import { handlePlanningAction, requestAdmission } from "@/lib/planning-api";
import { emptyConditionInterpretation } from "@/lib/planning-types";

let pg: PGlite;
let db: Db;

beforeEach(async () => {
  pg = new PGlite();
  db = createPgliteDb(pg);
  await migrate(db);
});

afterEach(async () => {
  await pg.close();
});

async function newOuting(userId: string) {
  const result = await createOuting({ db, userId }, {
    suggestion: "Synthetic maintenance test",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  expect(result.status).toBe(201);
  return (result.body.outing as { id: string }).id;
}

describe("optional response cutoffs", () => {
  it("leaves unanswered people pending and the outing active when no cutoff exists", async () => {
    const created = await createOuting({ db, userId: "no-cutoff-starter" }, {
      suggestion: "Coffee sometime",
      requestId: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const outing = created.body.outing as { id: string; cutoffAt: string | null };
    expect(outing.cutoffAt).toBeNull();
    await db.query(
      `insert into participants
        (outing_id, user_id, display_name, admission_status, response_status, agent_session_id)
       values ($1, 'no-cutoff-guest', 'Guest', 'admitted', 'pending', 'ses_no_cutoff_guest')`,
      [outing.id],
    );

    await sweepDueWork(db, new Date("2027-01-01T00:00:00.000Z"));

    const state = await db.query<{
      status: string;
      ended_at: string | Date | null;
      cutoff_processed_at: string | Date | null;
    }>(`select status, ended_at, cutoff_processed_at from outings where id = $1`, [outing.id]);
    const guest = await db.query<{ response_status: string }>(
      `select response_status from participants where outing_id = $1 and user_id = 'no-cutoff-guest'`,
      [outing.id],
    );
    expect(state[0]).toMatchObject({ status: "planning", ended_at: null, cutoff_processed_at: null });
    expect(guest[0].response_status).toBe("pending");
  });
});

async function confirmBeforeCutoff(starterUserId: string, nonresponderUserId: string) {
  const created = await createOuting({ db, userId: starterUserId }, {
    suggestion: "Synthetic early confirmation",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  expect(created.status).toBe(201);
  const outing = created.body.outing as { id: string; inviteToken: string };
  const optionResult = await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "add_option",
    title: "Synthetic early option",
    activity: "Movie",
    startsAt: "2026-11-02T02:00:00.000Z",
    estimatedCostCents: 900,
    activityTags: ["movie"],
  });
  expect(optionResult.status).toBe(201);
  const options = await db.query<{
    id: string;
    activity: string;
    starts_at: string | Date;
    estimated_cost_cents: number;
    activity_tags: unknown;
  }>(
    `select id, activity, starts_at, estimated_cost_cents, activity_tags
       from outing_options where outing_id = $1`,
    [outing.id],
  );
  await db.query(
    `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
      where outing_id = $1 and user_id = $2`,
    [outing.id, starterUserId, JSON.stringify(emptyConditionInterpretation())],
  );
  const interest = await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "set_interest",
    interested: true,
  });
  expect(interest.status).toBe(200);

  const offerId = crypto.randomUUID();
  await db.query(
    `insert into offers
      (id, outing_id, owner_user_id, option_id, activity, starts_at, estimated_cost_cents,
       attendee_user_ids, activity_tags, private_note, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, '', 'draft')`,
    [offerId, outing.id, starterUserId, options[0].id, options[0].activity, options[0].starts_at,
      options[0].estimated_cost_cents, JSON.stringify([starterUserId]), JSON.stringify(options[0].activity_tags)],
  );
  expect((await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "publish_offer", offerId,
  })).status).toBe(200);
  const requested = await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "publish_proposal", offerId,
  });
  expect(requested.status).toBe(201);
  const proposal = requested.body.proposal as { id: string; revision: number };
  const approval = await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "approve_proposal",
    proposalId: proposal.id,
    revision: proposal.revision,
  });
  expect(approval).toMatchObject({ status: 200, body: { status: "confirmed" } });

  const interestChange = await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "set_interest",
    interested: false,
  });
  expect(interestChange.body).toMatchObject({ outing: { status: "confirmed" }, confirmedProposal: { id: proposal.id } });

  const admission = await requestAdmission({ db, userId: nonresponderUserId }, outing.inviteToken, {
    displayName: "Nonresponder",
    emailOptIn: false,
    email: null,
  });
  expect(admission.status).toBe(200);
  expect((await handlePlanningAction({ db, userId: starterUserId }, outing.id, {
    action: "decide_admission", userId: nonresponderUserId, decision: "admit",
  })).status).toBe(200);
  await db.query(
    `update outings set cutoff_at = '2026-10-23T00:00:00Z', cutoff_processed_at = null where id = $1`,
    [outing.id],
  );
  return { outingId: outing.id, proposalId: proposal.id, starterUserId, nonresponderUserId };
}

describe("durable global deadline and deletion sweep", () => {
  it.each(["global sweep", "request-time processing"] as const)(
    "keeps an early confirmed plan after %s and records nonresponses without adding attendees",
    async (processing) => {
      const plan = await confirmBeforeCutoff(`starter-${processing.replaceAll(" ", "-")}`, `silent-${processing.replaceAll(" ", "-")}`);
      const now = new Date("2026-10-24T00:00:00.000Z");
      if (processing === "global sweep") {
        await expect(sweepDueWork(db, now)).resolves.toMatchObject({ cutoffsProcessed: 1 });
      } else {
        await processOutingDeadlines(db, plan.outingId, now);
      }

      const outing = await db.query<{ status: string; ended_at: string | Date | null; cutoff_processed_at: string | Date | null }>(
        `select status, ended_at, cutoff_processed_at from outings where id = $1`,
        [plan.outingId],
      );
      expect(outing[0].status).toBe("confirmed");
      expect(outing[0].ended_at).toBeNull();
      expect(outing[0].cutoff_processed_at).not.toBeNull();

      const proposal = await db.query<{ status: string; attendee_user_ids: unknown }>(
        `select status, attendee_user_ids from proposals where id = $1`,
        [plan.proposalId],
      );
      expect(proposal).toEqual([{ status: "confirmed", attendee_user_ids: [plan.starterUserId] }]);

      const participants = await db.query<{ user_id: string; response_status: string }>(
        `select user_id, response_status from participants where outing_id = $1 order by user_id`,
        [plan.outingId],
      );
      expect(participants).toEqual([
        { user_id: plan.nonresponderUserId, response_status: "no_response" },
        { user_id: plan.starterUserId, response_status: "not_interested" },
      ]);
      const approvals = await db.query<{ user_id: string }>(
        `select user_id from proposal_approvals where proposal_id = $1`,
        [plan.proposalId],
      );
      expect(approvals).toEqual([{ user_id: plan.starterUserId }]);
    },
  );

  it("claims a sweep once, records aggregate health, processes cutoffs, and deletes exactly at seven days", async () => {
    const pending = await newOuting("pending-starter");
    const older = await newOuting("ended-starter");
    await db.query(`update outings set cutoff_at = '2026-10-23T00:00:00Z' where id = $1`, [pending]);
    await db.query(`update participants set response_status = 'pending' where outing_id = $1`, [pending]);
    await db.query(`update outings set status = 'ended', ended_at = '2026-10-17T00:00:00Z' where id = $1`, [older]);
    await db.query(
      `insert into messages (id, outing_id, owner_user_id, role, content, client_message_id, status)
       values ($1, $2, 'ended-starter', 'user', 'synthetic cascade fixture', 'cascade-key', 'failed')`,
      [crypto.randomUUID(), older],
    );

    const now = new Date("2026-10-24T00:00:00.000Z");
    const results = await Promise.all([sweepDueWork(db, now), sweepDueWork(db, now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(Boolean)[0]).toMatchObject({
      cutoffsProcessed: 1,
      outingsDeleted: 1,
    });

    const cutoffState = await db.query<{
      status: string;
      ended_at: string | Date | null;
      cutoff_processed_at: string | Date | null;
    }>(`select status, ended_at, cutoff_processed_at from outings where id = $1`, [pending]);
    expect(cutoffState[0].status).toBe("no_agreement");
    expect(new Date(cutoffState[0].ended_at as string).toISOString()).toBe(now.toISOString());
    expect(cutoffState[0].cutoff_processed_at).not.toBeNull();

    await expect(db.query(`select id from outings where id = $1`, [older])).resolves.toHaveLength(0);
    await expect(db.query(`select id from messages where outing_id = $1`, [older])).resolves.toHaveLength(0);

    const health = await getMaintenanceHealth(db, now);
    expect(health).toMatchObject({
      status: "ok",
      healthy: true,
      lastResult: { cutoffsProcessed: 1, outingsDeleted: 1 },
    });
    expect(JSON.stringify(health)).not.toContain(pending);
    expect(JSON.stringify(health)).not.toContain(older);
  });

  it("does not purge early and request-time processing applies the exact same seven-day boundary", async () => {
    const outingId = await newOuting("retention-starter");
    await db.query(
      `update outings set status = 'ended', ended_at = '2026-10-17T00:00:00Z' where id = $1`,
      [outingId],
    );
    const before = new Date("2026-10-23T23:59:59.999Z");
    await sweepDueWork(db, before);
    await expect(db.query(`select id from outings where id = $1`, [outingId])).resolves.toHaveLength(1);

    await processOutingDeadlines(db, outingId, new Date("2026-10-24T00:00:00.000Z"));
    await expect(db.query(`select id from outings where id = $1`, [outingId])).resolves.toHaveLength(0);
    const view = await getOuting({ db, userId: "retention-starter" }, outingId);
    expect(view.status).toBe(404);
  });

  it("purges a no-agreement attempt at seven days and keeps the same starter's next outing reachable", async () => {
    const userId = "retained-starter";
    const failedAttempt = await newOuting(userId);
    const nextOuting = await newOuting(userId);
    await db.query(
      `update outings set status = 'no_agreement', ended_at = '2026-10-17T00:00:00Z' where id = $1`,
      [failedAttempt],
    );

    const beforeBoundary = new Date("2026-10-23T23:59:59.999Z");
    const early = await sweepDueWork(db, beforeBoundary);
    expect(early).toMatchObject({ outingsDeleted: 0 });
    await expect(db.query(`select id from outings where id = $1`, [failedAttempt])).resolves.toHaveLength(1);

    const atBoundary = await sweepDueWork(db, new Date("2026-10-24T00:00:00.000Z"));
    expect(atBoundary).toMatchObject({ outingsDeleted: 1 });
    await expect(db.query(`select id from outings where id = $1`, [failedAttempt])).resolves.toHaveLength(0);
    const remainingOuting = await getOuting({ db, userId }, nextOuting);
    expect(remainingOuting.status).toBe(200);
  });

  it("expires a final-approval proposal through the authenticated background sweep without a participant request", async () => {
    const userId = "approval-sweep-starter";
    const outingId = await newOuting(userId);
    const optionId = crypto.randomUUID();
    const startsAt = "2026-11-01T02:00:00.000Z";
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Synthetic approval option', 'Movie', $4, 900, '["movie"]', 'manual')`,
      [optionId, outingId, userId, startsAt],
    );
    const proposalId = crypto.randomUUID();
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb, 'published', 'initial',
               now() - interval '31 minutes', now() - interval '1 minute')`,
      [proposalId, outingId, userId, optionId, "Movie", startsAt, 900, JSON.stringify([userId])],
    );
    vi.stubEnv("SCHEDULER_SECRET", "test-scheduler-secret");
    vi.doMock("@/lib/db", async () => {
      const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
      return { ...actual, getDb: async () => db };
    });

    try {
      const { POST } = await import("@/app/api/maintenance/sweep/route");
      const response = await POST(new Request("http://localhost/api/maintenance/sweep", {
        method: "POST",
        headers: { authorization: "Bearer test-scheduler-secret" },
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        cutoffsProcessed: 0,
        proposalsExpired: 1,
        outingsDeleted: 0,
      });
    } finally {
      vi.doUnmock("@/lib/db");
      vi.resetModules();
    }

    const expired = await db.query<{ status: string }>(
      `select status from proposals where id = $1`, [proposalId],
    );
    expect(expired).toEqual([{ status: "expired" }]);
  });
});
