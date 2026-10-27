import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPgliteDb, migrate } from "@/lib/db";

describe("versioned starter-schema upgrade", () => {
  it("backfills legacy ownership once, retires the global dedupe index, and serializes concurrent bootstraps", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        create table outings (
          id uuid primary key,
          starter_user_id text not null,
          suggestion text not null check (char_length(suggestion) between 1 and 400),
          cutoff_at timestamptz not null,
          cutoff_time_zone text not null,
          created_at timestamptz not null default now()
        );
        create index outings_starter_idx on outings (starter_user_id, created_at desc);
        create table messages (
          seq bigserial primary key,
          id uuid not null unique,
          outing_id uuid not null references outings (id) on delete cascade,
          role text not null check (role in ('user', 'agent')),
          content text not null check (char_length(content) between 1 and 12000),
          client_message_id text,
          reply_to_message_id uuid references messages (id) on delete cascade,
          status text not null,
          error_code text,
          created_at timestamptz not null default now(),
          completed_at timestamptz,
          constraint messages_role_status_check check (
            (role = 'user' and status in ('pending', 'replied', 'failed'))
            or (role = 'agent' and status = 'complete')
          )
        );
        create index messages_outing_idx on messages (outing_id, seq);
        create unique index messages_client_unique
          on messages (outing_id, client_message_id) where client_message_id is not null;
        create unique index messages_reply_unique
          on messages (reply_to_message_id) where reply_to_message_id is not null;
        insert into outings (id, starter_user_id, suggestion, cutoff_at, cutoff_time_zone)
          values ('11111111-1111-4111-8111-111111111111', 'legacy-starter', 'Legacy idea',
                  '2026-11-01T00:00:00Z', 'UTC');
        insert into messages (id, outing_id, role, content, client_message_id, status)
          values ('22222222-2222-4222-8222-222222222222',
                  '11111111-1111-4111-8111-111111111111', 'user', 'legacy private text',
                  'old-client-id', 'replied');
      `);

      const db = createPgliteDb(pg);
      await Promise.all([migrate(db), migrate(db)]);

      const owner = await db.query<{ owner_user_id: string }>(
        `select owner_user_id from messages where id = $1`,
        ["22222222-2222-4222-8222-222222222222"],
      );
      expect(owner[0]?.owner_user_id).toBe("legacy-starter");

      const starter = await db.query<{ display_name: string; agent_session_id: string }>(
        `select display_name, agent_session_id from participants
          where outing_id = $1 and user_id = 'legacy-starter'`,
        ["11111111-1111-4111-8111-111111111111"],
      );
      expect(starter).toHaveLength(1);
      expect(starter[0].display_name).toBe("Starter");

      const invite = await db.query<{ invite_token: string }>(
        `select invite_token from outings where id = $1`,
        ["11111111-1111-4111-8111-111111111111"],
      );
      expect(invite[0]?.invite_token).toMatch(/^[0-9a-f-]{36}$/i);

      await db.query(
        `update participants set display_name = 'Edited after upgrade' where user_id = 'legacy-starter'`,
      );
      await migrate(db);
      const preserved = await db.query<{ display_name: string }>(
        `select display_name from participants where user_id = 'legacy-starter'`,
      );
      expect(preserved[0]?.display_name).toBe("Edited after upgrade");

      const indexes = await db.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'messages'`,
      );
      const names = indexes.map((row) => row.indexname);
      expect(names).toContain("messages_owner_client_unique");
      expect(names).not.toContain("messages_client_unique");

      const versions = await db.query<{ version: number }>(
        `select version from schema_migrations order by version`,
      );
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    } finally {
      await pg.close();
    }
  });
});

describe("version 4 migration", () => {
  it("adds private agent options without changing legacy sample records and is repeatable", async () => {
    const pg = new PGlite();
    try {
      const db = createPgliteDb(pg);
      await migrate(db);
      const outingId = crypto.randomUUID();
      const legacySampleId = crypto.randomUUID();
      await db.query(
        `insert into outings (id, starter_user_id, suggestion, cutoff_at, cutoff_time_zone)
         values ($1, 'starter', 'Legacy outing', now() + interval '1 day', 'UTC')`,
        [outingId],
      );
      await db.query(
        `insert into outing_options
          (id, outing_id, created_by_user_id, title, activity, starts_at,
           estimated_cost_cents, activity_tags, source)
         values ($1, $2, 'starter', 'Legacy movie', 'Movie', now() + interval '2 days', 900, '["movie"]', 'sample')`,
        [legacySampleId, outingId],
      );

      await db.query(`alter table outing_options drop constraint if exists outing_options_source_check`);
      await db.query(
        `alter table outing_options add constraint outing_options_source_check
         check (source in ('sample', 'manual'))`,
      );
      await db.query(`alter table outing_options drop column visibility`);
      await db.query(`delete from schema_migrations where version = 4`);

      await Promise.all([migrate(db), migrate(db)]);

      const preserved = await db.query<{ source: string; visibility: string }>(
        `select source, visibility from outing_options where id = $1`,
        [legacySampleId],
      );
      expect(preserved).toEqual([{ source: "sample", visibility: "shared" }]);
      const agentOptionId = crypto.randomUUID();
      await db.query(
        `insert into outing_options
          (id, outing_id, created_by_user_id, title, activity, starts_at,
           estimated_cost_cents, activity_tags, source, visibility)
         values ($1, $2, 'starter', 'Private agent option', 'Dinner', now() + interval '2 days',
                 2500, '["dinner"]', 'agent', 'private')`,
        [agentOptionId, outingId],
      );
      await migrate(db);
      const agentOption = await db.query<{ source: string; visibility: string }>(
        `select source, visibility from outing_options where id = $1`,
        [agentOptionId],
      );
      expect(agentOption).toEqual([{ source: "agent", visibility: "private" }]);
      const versions = await db.query<{ version: number }>(
        `select version from schema_migrations order by version`,
      );
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    } finally {
      await pg.close();
    }
  });
});

describe("version 3 migration", () => {
  it("reconciles duplicate open tie polls before adding the unique index", async () => {
    const pg = new PGlite();
    try {
      const db = createPgliteDb(pg);
      await migrate(db);
      const outingId = crypto.randomUUID();
      const optionA = crypto.randomUUID();
      const optionB = crypto.randomUUID();
      await db.query(
        `insert into outings (id, starter_user_id, suggestion, cutoff_at, cutoff_time_zone)
         values ($1, 'starter', 'Migration tie fixture', now() + interval '1 day', 'UTC')`,
        [outingId],
      );
      await db.query(
        `insert into outing_options
          (id, outing_id, created_by_user_id, title, activity, starts_at, estimated_cost_cents, activity_tags, source)
         values ($1, $2, 'starter', 'A', 'Movie', now() + interval '1 day', 900, '["movie"]', 'sample'),
                ($3, $2, 'starter', 'B', 'Movie', now() + interval '1 day', 1000, '["movie"]', 'sample')`,
        [optionA, outingId, optionB],
      );
      await db.query(`drop index if exists tie_polls_one_open_idx`);
      for (const key of ["a:b", "a:c"]) {
        await db.query(
          `insert into tie_polls
            (id, outing_id, tie_key, option_a_id, option_b_id, participant_user_ids, status)
           values ($1, $2, $3, $4, $5, '["starter"]'::jsonb, 'open')`,
          [crypto.randomUUID(), outingId, key, optionA, optionB],
        );
      }
      await db.query(`delete from schema_migrations where version = 3`);
      await db.query(`drop index if exists tie_polls_one_open_idx`);
      await migrate(db);

      const open = await db.query<{ count: number }>(
        `select count(*)::int as count from tie_polls where outing_id = $1 and status = 'open'`,
        [outingId],
      );
      expect(open[0].count).toBe(1);
      const indexes = await db.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'tie_polls'`,
      );
      expect(indexes.map((row) => row.indexname)).toContain("tie_polls_one_open_idx");
    } finally {
      await pg.close();
    }
  });
});
