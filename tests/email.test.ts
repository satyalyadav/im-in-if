import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import { createOuting } from "@/lib/outings-api";
import { dispatchOutbox } from "@/lib/email";

let pg: PGlite;
let db: Db;
let outingId: string;
const owner = "email-owner";

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "clerk");
  vi.stubEnv("RESEND_API_KEY", "synthetic-resend-key");
  vi.stubEnv("RESEND_FROM", "Planning <updates@notify.example.test>");
  vi.stubEnv("APP_BASE_URL", "https://planning.example.test");
  pg = new PGlite();
  db = createPgliteDb(pg);
  await migrate(db);
  const result = await createOuting({ db, userId: owner }, {
    suggestion: "PRIVATE OUTING SUGGESTION",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  outingId = (result.body.outing as { id: string }).id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await pg.close();
});

async function queueEmail(id = crypto.randomUUID(), firstAttemptedAt: Date | null = null) {
  await db.query(
    `update participants set email_opt_in = true, notification_email = 'verified@example.test'
      where outing_id = $1 and user_id = $2`,
    [outingId, owner],
  );
  await db.query(
    `insert into email_outbox
      (id, outing_id, recipient_user_id, event_type, event_key, status,
       recipient_email, first_attempted_at)
     values ($1, $2, $3, 'admission', 'synthetic-event', 'pending', $4, $5)`,
    [id, outingId, owner, "verified@example.test", firstAttemptedAt?.toISOString() ?? null],
  );
  return id;
}

describe("opt-in event email outbox", () => {
  it("sends one generic return-link email with a stable provider idempotency key", async () => {
    const outboxId = await queueEmail();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "synthetic-message-id" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date();
    expect(await dispatchOutbox(db, outingId, now)).toEqual({ sent: 1, failed: 0, unconfigured: false });
    expect(await dispatchOutbox(db, outingId, now)).toEqual({ sent: 0, failed: 0, unconfigured: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe(outboxId);
    const message = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
    expect(message.to).toEqual(["verified@example.test"]);
    expect(message.subject).toBe("A planning update is ready");
    expect(message.text).toContain(`/outings/${outingId}`);
    expect(JSON.stringify(message)).not.toContain("PRIVATE OUTING SUGGESTION");

    const sent = await db.query<{ status: string; first_attempted_at: string | Date; sent_at: string | Date }>(
      `select status, first_attempted_at, sent_at from email_outbox where id = $1`, [outboxId],
    );
    expect(sent[0].status).toBe("sent");
    expect(sent[0].first_attempted_at).not.toBeNull();
    expect(sent[0].sent_at).not.toBeNull();
  });

  it("does not retry an ambiguous delivery after the provider idempotency window", async () => {
    const outboxId = await queueEmail(crypto.randomUUID(), new Date(Date.now() - 24 * 60 * 60 * 1000));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutbox(db, outingId, new Date());
    expect(result).toEqual({ sent: 0, failed: 0, unconfigured: false });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await db.query<{ status: string; error_code: string | null }>(
      `select status, error_code from email_outbox where id = $1`, [outboxId],
    );
    expect(row[0]).toEqual({ status: "failed", error_code: "delivery_unknown" });
  });

  it("cascades queued recipient, link, and event data when an outing is deleted", async () => {
    await queueEmail();
    await db.query(`delete from outings where id = $1`, [outingId]);
    expect(await db.query(`select id from email_outbox where outing_id = $1`, [outingId])).toHaveLength(0);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await dispatchOutbox(db)).toEqual({ sent: 0, failed: 0, unconfigured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
