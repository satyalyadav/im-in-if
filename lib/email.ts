import type { Db } from "@/lib/db";

type OutboxRow = {
  id: string;
  outing_id: string;
  recipient_user_id: string;
  recipient_email: string;
  event_type: "admission" | "final_approval";
};

export type EmailDispatchResult = {
  sent: number;
  failed: number;
  unconfigured: boolean;
};

const IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const STALE_SEND_MS = 2 * 60 * 1000;

export async function dispatchOutbox(
  db: Db,
  outingId?: string,
  now = new Date(),
): Promise<EmailDispatchResult> {
  const baseUrl = getSafeBaseUrl(process.env.APP_BASE_URL);
  if (process.env.AUTH_MODE === "local") {
    await suppressUnsent(db, outingId, "email_disabled_local_mode");
    return { sent: 0, failed: 0, unconfigured: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from || !baseUrl) {
    const code = !apiKey || !from ? "email_unconfigured" : "email_invalid_base_url";
    await markUnconfigured(db, outingId, code);
    return { sent: 0, failed: 0, unconfigured: true };
  }

  const timestamp = now.toISOString();
  await db.query(
    `update email_outbox set status = 'failed', error_code = 'delivery_unknown'
      where status in ('pending', 'failed', 'sending')
        and first_attempted_at <= $1::timestamptz - interval '23 hours'
        and ($2::uuid is null or outing_id = $2::uuid)`,
    [timestamp, outingId ?? null],
  );

  const rows = await db.query<OutboxRow>(
    `select e.id, e.outing_id, e.recipient_user_id, e.recipient_email, e.event_type
       from email_outbox e
       join outings o on o.id = e.outing_id
       join participants p
         on p.outing_id = e.outing_id and p.user_id = e.recipient_user_id
      where ($1::uuid is null or e.outing_id = $1::uuid)
        and (e.status in ('pending', 'failed') or
             (e.status = 'sending' and e.attempted_at <= $2::timestamptz - interval '2 minutes'))
        and e.error_code is distinct from 'delivery_unknown'
        and (e.first_attempted_at is null or
             e.first_attempted_at > $2::timestamptz - interval '23 hours')
        and p.email_opt_in = true and p.notification_email = e.recipient_email
        and e.recipient_email is not null
        and (o.ended_at is null or o.ended_at + interval '7 days' > $2::timestamptz)
      order by e.created_at
      limit 20`,
    [outingId ?? null, timestamp],
  );

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const claimed = await db.query<{ id: string }>(
      `update email_outbox e
          set status = 'sending', attempted_at = $2::timestamptz,
              first_attempted_at = coalesce(first_attempted_at, $2::timestamptz),
              error_code = null
        where e.id = $1
          and (e.status in ('pending', 'failed') or
               (e.status = 'sending' and e.attempted_at <= $2::timestamptz - interval '2 minutes'))
          and (e.first_attempted_at is null or
               e.first_attempted_at > $2::timestamptz - interval '23 hours')
          and exists (
            select 1 from outings o
            join participants p on p.outing_id = o.id
              where o.id = e.outing_id and p.user_id = e.recipient_user_id
                and p.email_opt_in = true and p.notification_email = e.recipient_email
                and e.recipient_email is not null
                and (o.ended_at is null or o.ended_at + interval '7 days' > $2::timestamptz)
          )
        returning e.id`,
      [row.id, timestamp],
    );
    if (!claimed.length) continue;

    const returnUrl = new URL(`/outings/${row.outing_id}`, baseUrl).toString();
    const subject =
      row.event_type === "admission" ? "A planning update is ready" : "Your plan is confirmed";
    const text = `A planning update is ready. Sign in to view it: ${returnUrl}`;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": row.id,
        },
        body: JSON.stringify({
          from,
          to: [row.recipient_email],
          subject,
          text,
        }),
      });
      if (!response.ok) {
        await markFailed(db, row.id, `provider_http_${response.status}`);
        failed += 1;
        continue;
      }

      const completed = await db.query<{ id: string }>(
        `update email_outbox e set status = 'sent', sent_at = $2::timestamptz
          where e.id = $1 and e.status = 'sending'
            and e.first_attempted_at > $2::timestamptz - interval '23 hours'
            and exists (
              select 1 from outings o join participants p on p.outing_id = o.id
               where o.id = e.outing_id and p.user_id = e.recipient_user_id
                 and p.email_opt_in = true and p.notification_email = e.recipient_email
                 and (o.ended_at is null or o.ended_at + interval '7 days' > $2::timestamptz)
            )
          returning e.id`,
        [row.id, timestamp],
      );
      if (completed.length) sent += 1;
    } catch {
      await markFailed(db, row.id, "provider_request_failed");
      failed += 1;
    }
  }

  return { sent, failed, unconfigured: false };
}

function getSafeBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function suppressUnsent(db: Db, outingId: string | undefined, code: string) {
  await db.query(
    `update email_outbox set status = 'suppressed', error_code = $2
      where status in ('pending', 'failed', 'sending')
        and ($1::uuid is null or outing_id = $1::uuid)`,
    [outingId ?? null, code],
  );
}

async function markUnconfigured(db: Db, outingId: string | undefined, code: string) {
  await db.query(
    `update email_outbox set status = 'failed', error_code = $2
      where status in ('pending', 'failed')
        and ($1::uuid is null or outing_id = $1::uuid)`,
    [outingId ?? null, code],
  );
}

async function markFailed(db: Db, outboxId: string, code: string): Promise<void> {
  await db.query(
    `update email_outbox set status = 'failed', error_code = $2
      where id = $1 and status = 'sending'`,
    [outboxId, code],
  );
}
