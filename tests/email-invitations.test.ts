import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptEmailInvitation,
  createEmailInvitation,
  listEmailInvitations,
} from "@/lib/email-invitations";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import { createOuting } from "@/lib/outings-api";
import { dispatchEmailInvitation } from "@/lib/email";
import { getOutingWorkspace } from "@/lib/planning-api";

let pg: PGlite;
let db: Db;
let outingId: string;
const STARTER = "email-invite-starter";

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "clerk");
  vi.stubEnv("RESEND_API_KEY", "synthetic-resend-key");
  vi.stubEnv("RESEND_FROM", "Planning <updates@notify.example.test>");
  vi.stubEnv("APP_BASE_URL", "https://planning.example.test");
  pg = new PGlite();
  db = createPgliteDb(pg);
  await migrate(db);
  const created = await createOuting({ db, userId: STARTER }, {
    suggestion: "PRIVATE OUTING IDEA",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  outingId = (created.body.outing as { id: string }).id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await pg.close();
});

describe("email invitations", () => {
  it("stores one recipient request and reuses its provider key on retries", async () => {
    const requestId = crypto.randomUUID();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "synthetic-message-id" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: "  Friend@Example.test ",
      requestId,
    });
    expect(first.status).toBe(201);
    expect(first.body.invitation).toMatchObject({
      recipientEmail: "Friend@Example.test",
      status: "sent",
      accepted: false,
      requestId,
    });

    const repeated = await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: "Friend@Example.test",
      requestId,
    });
    expect(repeated.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe(requestId);
    const email = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
    expect(email.to).toEqual(["Friend@Example.test"]);
    expect(email.subject).toBe("You are invited to a private outing");
    expect(email.text).toContain("/email-invite/");
    expect(JSON.stringify(email)).not.toContain("PRIVATE OUTING IDEA");

    const reused = await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: "other@example.test",
      requestId,
    });
    expect(reused).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });

    const secondClick = await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: " friend@example.test ",
      requestId: crypto.randomUUID(),
    });
    expect(secondClick).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const saved = await db.query<{ count: number }>(
      `select count(*)::int as count from email_invitations where outing_id = $1`,
      [outingId],
    );
    expect(saved[0].count).toBe(1);
  });

  it("admits only the account with the intended verified email and keeps acceptance separate from interest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ id: "synthetic-message-id" }), { status: 202 }),
    ));
    const created = await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: "Friend@Example.test",
      requestId: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const invitations = await db.query<{ invite_token: string }>(
      `select invite_token from email_invitations where outing_id = $1`,
      [outingId],
    );
    const token = invitations[0].invite_token;

    const noVerifiedEmail = await acceptEmailInvitation(
      { db, userId: "unverified-account", verifiedEmails: [] },
      token,
    );
    expect(noVerifiedEmail).toMatchObject({ status: 403, body: { error: "verified_email_required" } });
    const forwarded = await acceptEmailInvitation(
      { db, userId: "wrong-account", verifiedEmails: ["other@example.test"] },
      token,
    );
    expect(forwarded).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await getOutingWorkspace({ db, userId: "wrong-account" }, outingId)).status).toBe(404);

    const recipient = { db, userId: "friend-account", verifiedEmails: ["  friend@EXAMPLE.test "] };
    const competingAccount = {
      db,
      userId: "competing-account",
      verifiedEmails: ["friend@example.test"],
    };
    const results = await Promise.all([
      acceptEmailInvitation(recipient, token),
      acceptEmailInvitation(competingAccount, token),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 404]);
    const winner = results[0].status === 200 ? recipient : competingAccount;
    const repeatedAcceptance = await acceptEmailInvitation(winner, token);
    expect(repeatedAcceptance).toEqual({
      status: 200,
      body: { status: "admitted", outingId },
    });
    const member = await db.query<{
      admission_status: string;
      response_status: string;
      email_opt_in: boolean;
      notification_email: string | null;
    }>(
      `select admission_status, response_status, email_opt_in, notification_email
         from participants where outing_id = $1 and user_id = $2`,
      [outingId, winner.userId],
    );
    expect(member).toEqual([{
      admission_status: "admitted",
      response_status: "pending",
      email_opt_in: false,
      notification_email: null,
    }]);
    await expect(db.query(
      `select user_id from participant_preferences where outing_id = $1 and user_id = 'friend-account'`,
      [outingId],
    )).resolves.toHaveLength(1);
    const starterView = await getOutingWorkspace({ db, userId: STARTER }, outingId);
    expect(starterView.body.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: winner.userId, displayName: "Email invitee" }),
    ]));
    const status = await listEmailInvitations({ db, userId: STARTER }, outingId);
    expect(status.body.invitations).toEqual([
      expect.objectContaining({ accepted: true, status: "sent" }),
    ]);
  });

  it("serializes duplicate sends and limits retries after provider uncertainty", async () => {
    const requestId = crypto.randomUUID();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response("provider unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const simultaneous = await Promise.all([
      createEmailInvitation({ db, userId: STARTER }, outingId, {
        email: "friend@example.test",
        requestId,
      }),
      createEmailInvitation({ db, userId: STARTER }, outingId, {
        email: "FRIEND@example.test",
        requestId,
      }),
    ]);
    expect(simultaneous.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstInvite = await db.query<{
      id: string;
      first_attempted_at: string | Date;
      error_code: string | null;
    }>(`select id, first_attempted_at, error_code from email_invitations where outing_id = $1`, [outingId]);
    expect(firstInvite[0].error_code).toBe("provider_http_503");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retried = await createEmailInvitation({ db, userId: STARTER }, outingId, {
        email: "friend@example.test",
        requestId: crypto.randomUUID(),
      });
      expect(retried).toMatchObject({
        status: 200,
        body: { duplicate: true, invitation: { status: "failed" } },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map((call) =>
      (call[1]?.headers as Record<string, string>)["idempotency-key"],
    );
    expect(keys).toEqual([requestId, requestId, requestId]);

    await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: "friend@example.test",
      requestId: crypto.randomUUID(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const expired = await dispatchEmailInvitation(
      db,
      firstInvite[0].id,
      new Date(new Date(firstInvite[0].first_attempted_at).getTime() + 24 * 60 * 60 * 1000),
    );
    expect(expired).toEqual({ status: "failed", errorCode: "delivery_unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an invitation usable when email sending is disabled and deletes it with the outing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AUTH_MODE", "local");
    const created = await createEmailInvitation({ db, userId: STARTER }, outingId, {
      email: "friend@example.test",
      requestId: crypto.randomUUID(),
    });
    expect(created).toMatchObject({
      status: 201,
      body: { invitation: { status: "disabled", errorCode: "email_disabled_local_mode" } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const token = await db.query<{ invite_token: string }>(
      `select invite_token from email_invitations where outing_id = $1`,
      [outingId],
    );
    const accepted = await acceptEmailInvitation(
      { db, userId: "friend-account", verifiedEmails: ["friend@example.test"] },
      token[0].invite_token,
    );
    expect(accepted).toMatchObject({ status: 200, body: { status: "admitted", outingId } });

    await db.query(`delete from outings where id = $1`, [outingId]);
    await expect(db.query(
      `select id from email_invitations where outing_id = $1`,
      [outingId],
    )).resolves.toHaveLength(0);
  });

  it("rejects non-starter sends and sends for ended outings", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = { email: "friend@example.test", requestId: crypto.randomUUID() };
    const unauthorized = await createEmailInvitation({ db, userId: "another-user" }, outingId, input);
    expect(unauthorized).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await listEmailInvitations({ db, userId: "another-user" }, outingId)).status).toBe(404);
    await db.query(`update outings set ended_at = now(), status = 'ended' where id = $1`, [outingId]);
    const ended = await createEmailInvitation({ db, userId: STARTER }, outingId, input);
    expect(ended).toMatchObject({ status: 409, body: { error: "outing_not_active" } });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(db.query(
      `select id from email_invitations where outing_id = $1`,
      [outingId],
    )).resolves.toHaveLength(0);
  });
});
