import { z } from "zod";
import { dispatchEmailInvitation } from "@/lib/email";
import type { Db } from "@/lib/db";
import { processOutingDeadlines } from "@/lib/maintenance";
import type { ApiResponse, OwnerContext } from "@/lib/outings-api";

type EmailInvitationRow = {
  id: string;
  outing_id: string;
  created_by_user_id: string;
  recipient_email: string;
  normalized_recipient_email: string;
  send_request_id: string;
  status: "pending" | "sending" | "sent" | "failed" | "disabled";
  error_code: string | null;
  accepted_by_user_id: string | null;
  accepted_at: string | Date | null;
  created_at: string | Date;
};

const createSchema = z.object({
  email: z.string().trim().email().max(320),
  requestId: z.string().uuid(),
}).strict();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function api(status: number, body: Record<string, unknown>): ApiResponse {
  return { status, body };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function mayRetryDelivery(row: EmailInvitationRow): boolean {
  return !row.accepted_by_user_id && row.status !== "sent" &&
    !(row.status === "failed" && (row.error_code === "delivery_unknown" || row.error_code === "retry_limit"));
}

function toInvitationView(row: EmailInvitationRow) {
  return {
    id: row.id,
    recipientEmail: row.recipient_email,
    status: row.status,
    errorCode: row.error_code,
    accepted: row.accepted_by_user_id !== null,
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    requestId: row.send_request_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadActiveStarter(
  db: Db,
  outingId: string,
  userId: string,
): Promise<"active" | "ended" | "not_found"> {
  const rows = await db.query<{ starter_user_id: string; ended_at: string | Date | null }>(
    `select starter_user_id, ended_at from outings where id = $1`,
    [outingId],
  );
  const outing = rows[0];
  if (!outing || outing.starter_user_id !== userId) return "not_found";
  return outing.ended_at ? "ended" : "active";
}

export async function listEmailInvitations(
  context: OwnerContext,
  outingId: string,
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(outingId)) return api(404, { error: "not_found" });
  await processOutingDeadlines(context.db, outingId);
  const access = await loadActiveStarter(context.db, outingId, context.userId);
  if (access === "not_found") return api(404, { error: "not_found" });
  if (access === "ended") return api(409, { error: "outing_not_active" });
  const rows = await context.db.query<EmailInvitationRow>(
    `select id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
            send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at
       from email_invitations where outing_id = $1 and created_by_user_id = $2
       order by created_at desc`,
    [outingId, context.userId],
  );
  return api(200, { invitations: rows.map(toInvitationView) });
}

export async function createEmailInvitation(
  context: OwnerContext,
  outingId: string,
  input: unknown,
): Promise<ApiResponse> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return api(400, { error: "invalid_input" });
  if (!UUID_PATTERN.test(outingId)) return api(404, { error: "not_found" });
  await processOutingDeadlines(context.db, outingId);
  const access = await loadActiveStarter(context.db, outingId, context.userId);
  if (access === "not_found") return api(404, { error: "not_found" });
  if (access === "ended") return api(409, { error: "outing_not_active" });

  const recipientEmail = parsed.data.email.trim();
  const normalizedEmail = normalizeEmail(recipientEmail);
  const requestId = parsed.data.requestId.toLowerCase();
  const priorRequest = await context.db.query<EmailInvitationRow>(
    `select id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
            send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at
       from email_invitations where created_by_user_id = $1 and send_request_id = $2`,
    [context.userId, requestId],
  );
  if (priorRequest[0]) {
    const prior = priorRequest[0];
    if (prior.outing_id !== outingId || prior.normalized_recipient_email !== normalizedEmail) {
      return api(409, { error: "idempotency_conflict" });
    }
    if (mayRetryDelivery(prior)) await dispatchEmailInvitation(context.db, prior.id);
    const refreshed = await loadInvitation(context.db, prior.id);
    return api(200, { invitation: toInvitationView(refreshed ?? prior) });
  }

  const alreadyInvited = await context.db.query<EmailInvitationRow>(
    `select id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
            send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at
       from email_invitations
      where outing_id = $1 and normalized_recipient_email = $2`,
    [outingId, normalizedEmail],
  );
  if (alreadyInvited[0]) {
    if (mayRetryDelivery(alreadyInvited[0])) {
      await dispatchEmailInvitation(context.db, alreadyInvited[0].id);
      const refreshed = await loadInvitation(context.db, alreadyInvited[0].id);
      return api(200, {
        invitation: toInvitationView(refreshed ?? alreadyInvited[0]),
        duplicate: true,
      });
    }
    return api(200, {
      invitation: toInvitationView(alreadyInvited[0]),
      duplicate: true,
    });
  }

  const invitationId = crypto.randomUUID();
  const inviteToken = crypto.randomUUID();
  const inserted = await context.db.query<EmailInvitationRow>(
    `insert into email_invitations
      (id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
       send_request_id, invite_token, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending')
     on conflict do nothing
     returning id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
               send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at`,
    [invitationId, outingId, context.userId, recipientEmail, normalizedEmail, requestId, inviteToken],
  );

  if (!inserted.length) {
    const requestCollision = await context.db.query<EmailInvitationRow>(
      `select id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
              send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at
         from email_invitations where created_by_user_id = $1 and send_request_id = $2`,
      [context.userId, requestId],
    );
    const recipientCollision = await context.db.query<EmailInvitationRow>(
      `select id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
              send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at
         from email_invitations
        where outing_id = $1 and normalized_recipient_email = $2`,
      [outingId, normalizedEmail],
    );
    const existing = requestCollision[0] ?? recipientCollision[0];
    if (!existing) return api(409, { error: "idempotency_conflict" });
    if (existing.outing_id !== outingId || existing.normalized_recipient_email !== normalizedEmail) {
      return api(409, { error: "idempotency_conflict" });
    }
    if (existing.send_request_id !== requestId) {
      return api(200, { invitation: toInvitationView(existing), duplicate: true });
    }
    if (mayRetryDelivery(existing)) await dispatchEmailInvitation(context.db, existing.id);
    const refreshed = await loadInvitation(context.db, existing.id);
    return api(200, { invitation: toInvitationView(refreshed ?? existing) });
  }

  await dispatchEmailInvitation(context.db, invitationId);
  const invitation = await loadInvitation(context.db, invitationId);
  return api(201, {
    invitation: toInvitationView(invitation ?? inserted[0]),
  });
}

async function loadInvitation(db: Db, invitationId: string): Promise<EmailInvitationRow | null> {
  const rows = await db.query<EmailInvitationRow>(
    `select id, outing_id, created_by_user_id, recipient_email, normalized_recipient_email,
            send_request_id, status, error_code, accepted_by_user_id, accepted_at, created_at
       from email_invitations where id = $1`,
    [invitationId],
  );
  return rows[0] ?? null;
}

export async function acceptEmailInvitation(
  context: OwnerContext,
  token: string,
): Promise<ApiResponse> {
  const verifiedEmails = [...new Set((context.verifiedEmails ?? []).map(normalizeEmail).filter(Boolean))];
  if (verifiedEmails.length === 0) return api(403, { error: "verified_email_required" });

  const references = await context.db.query<{ outing_id: string }>(
    `select outing_id from email_invitations where invite_token = $1`,
    [token],
  );
  if (references[0]) await processOutingDeadlines(context.db, references[0].outing_id);

  const accepted = await context.db.query<{ outing_id: string }>(
    `with invitation as materialized (
       select i.id, i.outing_id
         from email_invitations i
         join outings o on o.id = i.outing_id
        where i.invite_token = $1
          and i.normalized_recipient_email = any($2::text[])
          and o.ended_at is null
          and (i.accepted_by_user_id is null or i.accepted_by_user_id = $3)
        for update of i
     ), participant as (
       insert into participants
         (outing_id, user_id, display_name, admission_status, response_status, agent_session_id)
       select outing_id, $3, 'Email invitee', 'admitted', 'pending', $4 from invitation
       on conflict (outing_id, user_id) do update
         set admission_status = 'admitted'
       returning outing_id
     ), preferences as (
       insert into participant_preferences (outing_id, user_id)
       select outing_id, $3 from invitation
       on conflict (outing_id, user_id) do nothing
       returning outing_id
     ), accepted_invitation as (
       update email_invitations i
          set accepted_by_user_id = $3, accepted_at = coalesce(i.accepted_at, now())
         from invitation
        where i.id = invitation.id
          and (i.accepted_by_user_id is null or i.accepted_by_user_id = $3)
       returning i.outing_id
     )
     select outing_id from accepted_invitation`,
    [token, verifiedEmails, context.userId, "ses_" + crypto.randomUUID()],
  );
  if (!accepted.length) return api(404, { error: "not_found" });
  return api(200, { status: "admitted", outingId: accepted[0].outing_id });
}
