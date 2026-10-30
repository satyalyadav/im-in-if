import type { PGlite } from "@electric-sql/pglite";

export type DbStatement = { text: string; params?: unknown[] };

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T = Record<string, unknown>>(statements: DbStatement[]): Promise<T[][]>;
}

const BASE_SCHEMA = [
  `create table if not exists schema_migrations (
    version integer primary key,
    applied_at timestamptz not null default now()
  )`,
  `create table if not exists outings (
    id uuid primary key,
    starter_user_id text not null,
    suggestion text not null check (char_length(suggestion) between 1 and 400),
    cutoff_at timestamptz,
    cutoff_time_zone text,
    invite_token text,
    creation_request_id uuid,
    status text not null default 'planning',
    cutoff_processed_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists participants (
    outing_id uuid not null references outings (id) on delete cascade,
    user_id text not null,
    display_name text not null check (char_length(display_name) between 1 and 64),
    admission_status text not null check (admission_status in ('pending', 'admitted', 'rejected')),
    response_status text not null default 'pending'
      check (response_status in ('pending', 'interested', 'not_interested', 'no_response')),
    responded_at timestamptz,
    agent_session_id text not null,
    email_opt_in boolean not null default false,
    notification_email text,
    created_at timestamptz not null default now(),
    primary key (outing_id, user_id),
    check (email_opt_in = false or notification_email is not null)
  )`,
  `create table if not exists participant_preferences (
    outing_id uuid not null,
    user_id text not null,
    private_input text not null default '' check (char_length(private_input) <= 4000),
    interpretation jsonb,
    interpretation_ready boolean not null default false,
    rankings jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (outing_id, user_id),
    foreign key (outing_id, user_id) references participants (outing_id, user_id) on delete cascade
  )`,
  `create table if not exists messages (
    seq bigserial primary key,
    id uuid not null unique,
    outing_id uuid not null references outings (id) on delete cascade,
    owner_user_id text not null,
    role text not null check (role in ('user', 'agent')),
    content text not null check (char_length(content) between 1 and 12000),
    client_message_id text,
    processing_started_at timestamptz,
    reply_to_message_id uuid references messages (id) on delete cascade,
    status text not null,
    error_code text,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    constraint messages_role_status_check check (
      (role = 'user' and status in ('pending', 'replied', 'failed'))
      or (role = 'agent' and status = 'complete')
    )
  )`,
  `create table if not exists outing_options (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    created_by_user_id text not null,
    title text not null check (char_length(title) between 1 and 120),
    activity text not null check (char_length(activity) between 1 and 80),
    starts_at timestamptz not null,
    estimated_cost_cents integer not null check (estimated_cost_cents >= 0),
    activity_tags jsonb not null default '[]'::jsonb,
    source text not null check (source in ('sample', 'manual', 'agent')),
    visibility text not null default 'shared' check (visibility in ('private', 'shared')),
    created_at timestamptz not null default now()
  )`,
  `create table if not exists offers (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    owner_user_id text not null,
    option_id uuid not null references outing_options (id) on delete cascade,
    activity text not null,
    starts_at timestamptz not null,
    estimated_cost_cents integer not null check (estimated_cost_cents >= 0),
    attendee_user_ids jsonb not null,
    activity_tags jsonb not null default '[]'::jsonb,
    private_note text not null default '' check (char_length(private_note) <= 1000),
    counter_offer_to_id uuid references offers (id) on delete cascade,
    status text not null check (status in ('draft', 'published', 'withdrawn')),
    created_at timestamptz not null default now(),
    published_at timestamptz
  )`,
  `create table if not exists proposals (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    revision integer not null check (revision > 0),
    created_by_user_id text not null,
    option_id uuid not null references outing_options (id) on delete restrict,
    activity text not null,
    starts_at timestamptz not null,
    estimated_cost_cents integer not null check (estimated_cost_cents >= 0),
    attendee_user_ids jsonb not null,
    status text not null check (status in ('published', 'confirmed', 'expired', 'superseded')),
    kind text not null check (kind in ('initial', 'restart', 'join', 'departure')),
    published_at timestamptz not null,
    expires_at timestamptz not null,
    confirmed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (outing_id, revision)
  )`,
  `create table if not exists proposal_approvals (
    proposal_id uuid not null references proposals (id) on delete cascade,
    outing_id uuid not null references outings (id) on delete cascade,
    user_id text not null,
    revision integer not null,
    approved_at timestamptz not null default now(),
    primary key (proposal_id, user_id)
  )`,
  `create table if not exists tie_polls (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    tie_key text not null,
    option_a_id uuid not null references outing_options (id) on delete cascade,
    option_b_id uuid not null references outing_options (id) on delete cascade,
    participant_user_ids jsonb not null,
    status text not null check (status in ('open', 'resolved', 'no_agreement')),
    outcome text check (outcome in ('a', 'b', 'either')),
    selected_option_id uuid references outing_options (id) on delete set null,
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    unique (outing_id, tie_key)
  )`,
  `create table if not exists tie_answers (
    poll_id uuid not null references tie_polls (id) on delete cascade,
    outing_id uuid not null references outings (id) on delete cascade,
    user_id text not null,
    answer text not null check (answer in ('a', 'b', 'either')),
    answered_at timestamptz not null default now(),
    primary key (poll_id, user_id)
  )`,
  `create table if not exists join_requests (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    user_id text not null,
    status text not null check (status in ('pending', 'proposed', 'accepted', 'rejected', 'expired')),
    proposal_id uuid references proposals (id) on delete set null,
    created_at timestamptz not null default now(),
    unique (outing_id, user_id)
  )`,
  `create table if not exists departure_requests (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    user_id text not null,
    status text not null check (status in ('pending', 'proposed', 'accepted', 'rejected', 'expired')),
    proposal_id uuid references proposals (id) on delete set null,
    created_at timestamptz not null default now(),
    unique (outing_id, user_id)
  )`,
  `create table if not exists in_app_notifications (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    recipient_user_id text not null,
    actor_user_id text,
    kind text not null check (kind in ('admission_request', 'admission_decision', 'proposal_ready', 'proposal_confirmed')),
    event_key text not null,
    read_at timestamptz,
    created_at timestamptz not null default now(),
    unique (outing_id, recipient_user_id, kind, event_key)
  )`,
  `create table if not exists email_outbox (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    recipient_user_id text not null,
    event_type text not null check (event_type in ('admission', 'final_approval')),
    event_key text not null,
    status text not null check (status in ('pending', 'sending', 'sent', 'failed', 'suppressed')),
    error_code text,
    attempted_at timestamptz,
    first_attempted_at timestamptz,
    recipient_email text,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    unique (outing_id, recipient_user_id, event_type, event_key)
  )`,
  `create table if not exists email_invitations (
    id uuid primary key,
    outing_id uuid not null references outings (id) on delete cascade,
    created_by_user_id text not null,
    recipient_email text not null,
    normalized_recipient_email text not null,
    send_request_id uuid not null,
    invite_token text not null unique,
    status text not null default 'pending'
      check (status in ('pending', 'sending', 'sent', 'failed', 'disabled')),
    error_code text,
    attempt_count integer not null default 0 check (attempt_count between 0 and 3),
    attempted_at timestamptz,
    first_attempted_at timestamptz,
    sent_at timestamptz,
    accepted_by_user_id text,
    accepted_at timestamptz,
    created_at timestamptz not null default now(),
    unique (outing_id, normalized_recipient_email),
    unique (created_by_user_id, send_request_id)
  )`,
  `create table if not exists maintenance_state (
    singleton boolean primary key default true check (singleton),
    status text not null default 'idle' check (status in ('idle', 'running', 'ok', 'failed')),
    last_started_at timestamptz,
    last_succeeded_at timestamptz,
    last_error text,
    cutoffs_processed integer not null default 0,
    proposals_expired integer not null default 0,
    outings_deleted integer not null default 0
  )`,
];

const VERSIONED_MIGRATION = `
do $im_in_if_migration$
begin
  if not exists (select 1 from schema_migrations where version = 1) then
    alter table outings add column if not exists invite_token text;
    alter table outings add column if not exists status text not null default 'planning';
    alter table outings add column if not exists cutoff_processed_at timestamptz;
    alter table outings add column if not exists ended_at timestamptz;
    update outings set invite_token = gen_random_uuid()::text where invite_token is null;

    alter table messages add column if not exists owner_user_id text;
    insert into participants
      (outing_id, user_id, display_name, admission_status, response_status, responded_at, agent_session_id)
    select o.id, o.starter_user_id, 'Starter', 'admitted', 'interested', o.created_at,
           'ses_' || replace(gen_random_uuid()::text, '-', '')
      from outings o
    on conflict (outing_id, user_id) do nothing;
    update messages m set owner_user_id = o.starter_user_id
      from outings o
     where m.outing_id = o.id and m.owner_user_id is null;
    alter table messages alter column owner_user_id set not null;

    drop index if exists messages_client_unique;
    create unique index if not exists messages_owner_client_unique
      on messages (outing_id, owner_user_id, client_message_id)
      where client_message_id is not null;
    create unique index if not exists messages_reply_unique
      on messages (reply_to_message_id) where reply_to_message_id is not null;

    create unique index if not exists outings_invite_token_unique
      on outings (invite_token) where invite_token is not null;
    create index if not exists outings_starter_idx
      on outings (starter_user_id, created_at desc);
    create index if not exists outings_cutoff_due_idx
      on outings (cutoff_at) where cutoff_processed_at is null;
    create index if not exists outings_ended_due_idx
      on outings (ended_at) where ended_at is not null;
    create index if not exists participants_user_idx
      on participants (user_id, created_at desc);
    create index if not exists participants_admitted_idx
      on participants (outing_id, admission_status, response_status);
    create index if not exists messages_outing_idx
      on messages (outing_id, owner_user_id, seq);
    create index if not exists outing_options_idx
      on outing_options (outing_id, starts_at);
    create index if not exists offers_shared_idx
      on offers (outing_id, status, created_at);
    create index if not exists proposals_expiry_idx
      on proposals (expires_at) where status = 'published';
    create index if not exists proposals_outing_revision_idx
      on proposals (outing_id, revision desc);
    create index if not exists notifications_user_idx
      on in_app_notifications (recipient_user_id, created_at desc);
    create index if not exists email_outbox_due_idx
      on email_outbox (created_at) where status in ('pending', 'failed');

    insert into schema_migrations (version) values (1);
  end if;
end
$im_in_if_migration$`;

const VERSION_2_MIGRATION = `
do $im_in_if_migration_v2$
begin
  if not exists (select 1 from schema_migrations where version = 2) then
    alter table offers add column if not exists counter_offer_to_id uuid
      references offers (id) on delete cascade;
    alter table email_outbox add column if not exists recipient_email text;
    alter table email_outbox add column if not exists first_attempted_at timestamptz;
    update email_outbox e set recipient_email = p.notification_email
      from participants p
     where p.outing_id = e.outing_id and p.user_id = e.recipient_user_id
       and e.recipient_email is null;
    create index if not exists offers_counter_offer_idx
      on offers (counter_offer_to_id) where counter_offer_to_id is not null;
    insert into schema_migrations (version) values (2);
  end if;
end
$im_in_if_migration_v2$`;

const VERSION_3_MIGRATION = `
do $im_in_if_migration_v3$
begin
  if not exists (select 1 from schema_migrations where version = 3) then
    alter table participant_preferences
      add column if not exists conditions_version integer not null default 0;
    alter table proposals
      add column if not exists condition_versions jsonb not null default '{}'::jsonb;
    with ranked as (
      select id, row_number() over (partition by outing_id order by created_at, id) as rn
        from tie_polls where status = 'open'
    )
    update tie_polls t
       set status = 'no_agreement', resolved_at = coalesce(t.resolved_at, now())
      from ranked r
     where t.id = r.id and r.rn > 1;
    create unique index if not exists tie_polls_one_open_idx
      on tie_polls (outing_id) where status = 'open';
    insert into schema_migrations (version) values (3);
  end if;
end
$im_in_if_migration_v3$`;

const VERSION_4_MIGRATION = `
do $im_in_if_migration_v4$
begin
  if not exists (select 1 from schema_migrations where version = 4) then
    alter table outing_options
      add column if not exists visibility text not null default 'shared';
    alter table outing_options drop constraint if exists outing_options_source_check;
    alter table outing_options
      add constraint outing_options_source_check check (source in ('sample', 'manual', 'agent'));
    alter table outing_options drop constraint if exists outing_options_visibility_check;
    alter table outing_options
      add constraint outing_options_visibility_check check (visibility in ('private', 'shared'));
    insert into schema_migrations (version) values (4);
  end if;
end
$im_in_if_migration_v4$`;

const VERSION_5_MIGRATION = `
do $im_in_if_migration_v5$
begin
  if not exists (select 1 from schema_migrations where version = 5) then
    alter table outings alter column cutoff_at drop not null;
    alter table outings alter column cutoff_time_zone drop not null;
    alter table outings add column if not exists creation_request_id uuid;
    alter table messages add column if not exists processing_started_at timestamptz;
    create unique index if not exists outings_owner_creation_request_unique
      on outings (starter_user_id, creation_request_id)
      where creation_request_id is not null;
    create index if not exists email_invitations_outing_idx
      on email_invitations (outing_id, created_at desc);
    insert into schema_migrations (version) values (5);
  end if;
end
$im_in_if_migration_v5$`;

export async function migrate(db: Db): Promise<void> {
  await db.transaction([
    { text: `select pg_advisory_xact_lock(87123562)` },
    ...BASE_SCHEMA.map((text) => ({ text })),
    { text: VERSIONED_MIGRATION },
    { text: VERSION_2_MIGRATION },
    { text: VERSION_3_MIGRATION },
    { text: VERSION_4_MIGRATION },
    { text: VERSION_5_MIGRATION },
  ]);
}

export function createPgliteDb(pg: PGlite): Db {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
    async transaction<T>(statements: DbStatement[]): Promise<T[][]> {
      return pg.transaction(async (tx) => {
        const results: T[][] = [];
        for (const statement of statements) {
          const result = await tx.query<T>(statement.text, statement.params);
          results.push(result.rows);
        }
        return results;
      });
    },
  };
}

type NeonQueryExecutor = (text: string, params?: unknown[]) => Promise<unknown[]>;
type NeonTransactionExecutor = (statements: DbStatement[]) => Promise<unknown[][]>;

export function createNeonDb(
  executor: NeonQueryExecutor,
  transactionExecutor: NeonTransactionExecutor,
): Db {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      return (await executor(text, params)) as T[];
    },
    async transaction<T>(statements: DbStatement[]): Promise<T[][]> {
      return (await transactionExecutor(statements)) as T[][];
    },
  };
}

type DbGlobal = typeof globalThis & {
  __imInIfDb?: Promise<Db>;
  __imInIfPglite?: PGlite;
};

const globalForDb = globalThis as DbGlobal;

async function createNeon(): Promise<Db> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(connectionString);
  const db = createNeonDb(
    async (text, params) => sql.query(text, params),
    async (statements) =>
      (await sql.transaction(
        statements.map((statement) => sql.query(statement.text, statement.params)),
      )) as unknown[][],
  );
  await migrate(db);
  return db;
}

async function createLocal(): Promise<Db> {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    throw new Error("DATABASE_URL is required for a production database");
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DIR ?? ".data/pglite";

  if (dataDir !== "memory://") {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(dataDir), { recursive: true });
  }

  const pg = new PGlite(dataDir);
  globalForDb.__imInIfPglite = pg;
  const db = createPgliteDb(pg);
  await migrate(db);
  return db;
}

export function getDb(): Promise<Db> {
  globalForDb.__imInIfDb ??= (process.env.DATABASE_URL ? createNeon() : createLocal()).catch(
    (error: unknown) => {
      globalForDb.__imInIfDb = undefined;
      throw error;
    },
  );
  return globalForDb.__imInIfDb;
}
