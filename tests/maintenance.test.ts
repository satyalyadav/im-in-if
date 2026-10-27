import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import { getOuting, createOuting } from "@/lib/outings-api";
import { getMaintenanceHealth, processOutingDeadlines, sweepDueWork } from "@/lib/maintenance";

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

describe("durable global deadline and deletion sweep", () => {
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
