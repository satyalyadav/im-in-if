import type { Db } from "@/lib/db";

export type SweepResult = {
  cutoffsProcessed: number;
  proposalsExpired: number;
  outingsDeleted: number;
};

export type MaintenanceHealth = {
  status: "idle" | "running" | "ok" | "failed";
  healthy: boolean;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastError: string | null;
  lastResult: SweepResult;
};

export async function sweepDueWork(db: Db, now = new Date()): Promise<SweepResult | null> {
  const timestamp = now.toISOString();
  await db.query(
    `insert into maintenance_state (singleton) values (true) on conflict (singleton) do nothing`,
  );
  const claimed = await db.query<{ singleton: boolean }>(
    `update maintenance_state
        set status = 'running', last_started_at = $1::timestamptz, last_error = null
      where singleton = true
        and (status <> 'running' or last_started_at <= $1::timestamptz - interval '5 minutes')
      returning singleton`,
    [timestamp],
  );
  if (!claimed.length) return null;

  try {
    const result = await runSweep(db, timestamp);
    await db.query(
      `update maintenance_state
          set status = 'ok', last_succeeded_at = $1::timestamptz,
              last_error = null, cutoffs_processed = $2,
              proposals_expired = $3, outings_deleted = $4
        where singleton = true and status = 'running' and last_started_at = $1::timestamptz`,
      [timestamp, result.cutoffsProcessed, result.proposalsExpired, result.outingsDeleted],
    );
    return result;
  } catch (error) {
    await db.query(
      `update maintenance_state set status = 'failed', last_error = 'maintenance_failed'
        where singleton = true and status = 'running' and last_started_at = $1::timestamptz`,
      [timestamp],
    );
    throw error;
  }
}

async function runSweep(db: Db, timestamp: string): Promise<SweepResult> {
  const expired = await db.query<{ expired_count: number | string }>(
    `with expired as (
       update proposals
          set status = 'expired'
        where status = 'published' and expires_at <= $1::timestamptz
        returning id
     ), expired_joins as (
       update join_requests set status = 'expired'
        where status = 'proposed' and proposal_id in (select id from expired)
        returning id
     ), expired_departures as (
       update departure_requests set status = 'expired'
        where status = 'proposed' and proposal_id in (select id from expired)
        returning id
     )
     select count(*)::int as expired_count from expired`,
    [timestamp],
  );

  await db.query(
    `with due as (
       select id from outings
        where cutoff_at is not null and cutoff_at <= $1::timestamptz
          and cutoff_processed_at is null
          and ended_at is null
     )
     update participants p
        set response_status = 'no_response'
       from due
      where p.outing_id = due.id
        and p.admission_status = 'admitted'
        and p.response_status = 'pending'`,
    [timestamp],
  );
  await db.query(
    `with due as (
       select id from outings
        where cutoff_at is not null and cutoff_at <= $1::timestamptz
          and cutoff_processed_at is null
          and ended_at is null
     )
     update outings o
        set status = 'no_agreement', ended_at = $1::timestamptz
       from due
      where o.id = due.id
        and not exists (
          select 1 from participants p
           where p.outing_id = due.id
             and p.admission_status = 'admitted'
             and p.response_status = 'interested'
        )
        and not exists (
          select 1 from proposals p
           where p.outing_id = due.id and p.status = 'confirmed'
        )`,
    [timestamp],
  );
  const cutoffs = await db.query<{ processed_count: number | string }>(
    `with claimed as (
       update outings
          set cutoff_processed_at = $1::timestamptz
        where cutoff_at is not null and cutoff_at <= $1::timestamptz
          and cutoff_processed_at is null
        returning id
     )
     select count(*)::int as processed_count from claimed`,
    [timestamp],
  );

  const deleted = await db.query<{ outing_id: string }>(
    `delete from outings
      where ended_at <= $1::timestamptz - interval '7 days'
      returning id as outing_id`,
    [timestamp],
  );

  return {
    cutoffsProcessed: Number(cutoffs[0]?.processed_count ?? 0),
    proposalsExpired: Number(expired[0]?.expired_count ?? 0),
    outingsDeleted: deleted.length,
  };
}

export async function processOutingDeadlines(
  db: Db,
  outingId: string,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();

  await db.query(
    `update proposals set status = 'expired'
      where outing_id = $1 and status = 'published'
        and expires_at <= $2::timestamptz`,
    [outingId, timestamp],
  );
  await db.query(
    `update join_requests set status = 'expired'
      where outing_id = $1 and status = 'proposed'
        and proposal_id in (
          select id from proposals where outing_id = $1 and status = 'expired'
        )`,
    [outingId],
  );
  await db.query(
    `update departure_requests set status = 'expired'
      where outing_id = $1 and status = 'proposed'
        and proposal_id in (
          select id from proposals where outing_id = $1 and status = 'expired'
        )`,
    [outingId],
  );
  await db.query(
    `update participants p set response_status = 'no_response'
      where p.outing_id = $1 and p.admission_status = 'admitted'
        and p.response_status = 'pending'
        and exists (
          select 1 from outings o
           where o.id = $1 and o.cutoff_at is not null and o.cutoff_at <= $2::timestamptz
             and o.cutoff_processed_at is null and o.ended_at is null
        )`,
    [outingId, timestamp],
  );
  await db.query(
    `update outings o set status = 'no_agreement', ended_at = $2::timestamptz
      where o.id = $1 and o.cutoff_at is not null and o.cutoff_at <= $2::timestamptz
        and o.cutoff_processed_at is null and o.ended_at is null
        and not exists (
          select 1 from participants p where p.outing_id = o.id
            and p.admission_status = 'admitted' and p.response_status = 'interested'
        )
        and not exists (
          select 1 from proposals p
           where p.outing_id = o.id and p.status = 'confirmed'
        )`,
    [outingId, timestamp],
  );
  await db.query(
    `update outings set cutoff_processed_at = $2::timestamptz
      where id = $1 and cutoff_at is not null and cutoff_at <= $2::timestamptz and cutoff_processed_at is null`,
    [outingId, timestamp],
  );
  await db.query(
    `delete from outings
      where id = $1 and ended_at <= $2::timestamptz - interval '7 days'`,
    [outingId, timestamp],
  );
}

export async function getMaintenanceHealth(
  db: Db,
  now = new Date(),
): Promise<MaintenanceHealth> {
  await db.query(
    `insert into maintenance_state (singleton) values (true) on conflict (singleton) do nothing`,
  );
  const rows = await db.query<{
    status: MaintenanceHealth["status"];
    last_started_at: string | Date | null;
    last_succeeded_at: string | Date | null;
    last_error: string | null;
    cutoffs_processed: number | string;
    proposals_expired: number | string;
    outings_deleted: number | string;
  }>(
    `select status, last_started_at, last_succeeded_at, last_error,
            cutoffs_processed, proposals_expired, outings_deleted
       from maintenance_state where singleton = true`,
  );
  const row = rows[0];
  return {
    status: row.status,
    healthy: row.status === "ok" && row.last_succeeded_at !== null &&
      new Date(row.last_succeeded_at).getTime() > now.getTime() - 15 * 60 * 1000,
    lastStartedAt: row.last_started_at ? new Date(row.last_started_at).toISOString() : null,
    lastSucceededAt: row.last_succeeded_at ? new Date(row.last_succeeded_at).toISOString() : null,
    lastError: row.last_error,
    lastResult: {
      cutoffsProcessed: Number(row.cutoffs_processed),
      proposalsExpired: Number(row.proposals_expired),
      outingsDeleted: Number(row.outings_deleted),
    },
  };
}
