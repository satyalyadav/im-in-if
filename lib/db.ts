import type { PGlite } from "@electric-sql/pglite";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const MIGRATIONS = [
  `create table if not exists outings (
    id uuid primary key,
    starter_user_id text not null,
    suggestion text not null check (char_length(suggestion) between 1 and 400),
    cutoff_at timestamptz not null,
    cutoff_time_zone text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists outings_starter_idx
    on outings (starter_user_id, created_at desc)`,
  `create table if not exists messages (
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
  )`,
  `create index if not exists messages_outing_idx on messages (outing_id, seq)`,
  `create unique index if not exists messages_client_unique
    on messages (outing_id, client_message_id) where client_message_id is not null`,
  `create unique index if not exists messages_reply_unique
    on messages (reply_to_message_id) where reply_to_message_id is not null`,
];

export async function migrate(db: Db): Promise<void> {
  for (const statement of MIGRATIONS) {
    await db.query(statement);
  }
}

export function createPgliteDb(pg: PGlite): Db {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
}

export function createNeonDb(
  executor: (text: string, params?: unknown[]) => Promise<unknown[]>,
): Db {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      return (await executor(text, params)) as T[];
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
  const db = createNeonDb(async (text, params) => sql.query(text, params));
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
