import { z } from "zod";
import { AgentError, type Agent } from "@/lib/agent";
import { formatZonedDateTime, resolveCutoffInstant } from "@/lib/cutoff";
import type { Db } from "@/lib/db";

export type OwnerContext = {
  db: Db;
  userId: string;
};

export type AgentContext = OwnerContext & {
  agent: Agent;
};

export type ApiResponse = {
  status: number;
  body: Record<string, unknown>;
};

type OutingRow = {
  id: string;
  starter_user_id: string;
  suggestion: string;
  cutoff_at: string | Date;
  cutoff_time_zone: string;
  created_at: string | Date;
};

type MessageRow = {
  seq: number;
  id: string;
  outing_id: string;
  role: "user" | "agent";
  content: string;
  client_message_id: string | null;
  reply_to_message_id: string | null;
  status: "pending" | "replied" | "failed" | "complete";
  error_code: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
};

export type OutingView = {
  id: string;
  suggestion: string;
  cutoffAt: string;
  cutoffTimeZone: string;
  cutoffDisplay: string;
  createdAt: string;
};

export type MessageView = {
  id: string;
  role: "user" | "agent";
  content: string;
  status: "pending" | "replied" | "failed" | "complete";
  errorCode: string | null;
  replyToMessageId: string | null;
  createdAt: string;
};

const createOutingSchema = z.object({
  suggestion: z.string().trim().min(1).max(400),
  cutoffDate: z.string().min(1).max(32),
  cutoffTime: z.string().min(1).max(16),
  cutoffTimeZone: z.string().min(1).max(64),
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sendMessageSchema = z.object({
  clientMessageId: z.string().regex(UUID_PATTERN),
  content: z.string().trim().min(1).max(4000),
});

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function toOutingView(row: OutingRow): OutingView {
  return {
    id: row.id,
    suggestion: row.suggestion,
    cutoffAt: iso(row.cutoff_at),
    cutoffTimeZone: row.cutoff_time_zone,
    cutoffDisplay: formatZonedDateTime(new Date(row.cutoff_at), row.cutoff_time_zone),
    createdAt: iso(row.created_at),
  };
}

function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    errorCode: row.error_code,
    replyToMessageId: row.reply_to_message_id,
    createdAt: iso(row.created_at),
  };
}

async function findOuting(
  db: Db,
  outingId: string,
  userId: string,
): Promise<OutingRow | null> {
  const rows = await db.query<OutingRow>(
    `select * from outings where id = $1 and starter_user_id = $2`,
    [outingId, userId],
  );
  return rows[0] ?? null;
}

async function listMessages(db: Db, outingId: string): Promise<MessageView[]> {
  const rows = await db.query<MessageRow>(
    `select * from messages where outing_id = $1 order by seq`,
    [outingId],
  );
  return rows.map(toMessageView);
}

export async function listOutings(context: OwnerContext): Promise<OutingView[]> {
  const rows = await context.db.query<OutingRow>(
    `select * from outings where starter_user_id = $1 order by created_at desc limit 20`,
    [context.userId],
  );
  return rows.map(toOutingView);
}

async function loadHistory(
  db: Db,
  outingId: string,
  current: MessageRow,
): Promise<Array<{ role: "user" | "agent"; content: string }>> {
  const rows = await db.query<Pick<MessageRow, "role" | "content">>(
    `select role, content from messages
      where outing_id = $1 and seq < $2
      order by seq`,
    [outingId, current.seq],
  );

  return [...rows, { role: "user" as const, content: current.content }];
}

async function generateReply(
  context: AgentContext,
  outing: OutingRow,
  userMessage: MessageRow,
  successStatus: number,
): Promise<ApiResponse> {
  const history = await loadHistory(context.db, outing.id, userMessage);

  try {
    const { text } = await context.agent.reply({
      outing: {
        suggestion: outing.suggestion,
        cutoffAt: iso(outing.cutoff_at),
        cutoffTimeZone: outing.cutoff_time_zone,
      },
      history,
    });

    await context.db.query(
      `insert into messages
        (id, outing_id, role, content, reply_to_message_id, status, completed_at)
       values ($1, $2, 'agent', $3, $4, 'complete', now())
       on conflict do nothing`,
      [crypto.randomUUID(), outing.id, text, userMessage.id],
    );
    await context.db.query(
      `update messages set status = 'replied', error_code = null, completed_at = now()
        where id = $1 and status <> 'replied'`,
      [userMessage.id],
    );

    return {
      status: successStatus,
      body: {
        messageId: userMessage.id,
        messages: await listMessages(context.db, outing.id),
      },
    };
  } catch (error) {
    const code = error instanceof AgentError ? error.code : "model_error";
    await context.db.query(
      `update messages set status = 'failed', error_code = $2
        where id = $1 and status = 'pending'`,
      [userMessage.id, code],
    );
    console.error("agent turn failed", code);

    return {
      status: code === "unavailable" ? 503 : 502,
      body: { messageId: userMessage.id, error: code },
    };
  }
}

export async function createOuting(
  context: OwnerContext,
  input: unknown,
): Promise<ApiResponse> {
  const parsed = createOutingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: "invalid_input", fields: parsed.error.flatten().fieldErrors },
    };
  }

  const cutoff = resolveCutoffInstant({
    date: parsed.data.cutoffDate,
    time: parsed.data.cutoffTime,
    timeZone: parsed.data.cutoffTimeZone,
  });
  if (!cutoff.ok) {
    return { status: 400, body: { error: cutoff.error } };
  }

  const rows = await context.db.query<OutingRow>(
    `insert into outings (id, starter_user_id, suggestion, cutoff_at, cutoff_time_zone)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [
      crypto.randomUUID(),
      context.userId,
      parsed.data.suggestion,
      cutoff.instant.toISOString(),
      parsed.data.cutoffTimeZone,
    ],
  );

  return { status: 201, body: { outing: toOutingView(rows[0]) } };
}

export async function getOuting(
  context: OwnerContext,
  outingId: string,
): Promise<ApiResponse> {
  if (!isUuid(outingId)) return { status: 404, body: { error: "not_found" } };
  const outing = await findOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };

  return {
    status: 200,
    body: {
      outing: toOutingView(outing),
      messages: await listMessages(context.db, outing.id),
    },
  };
}

export async function sendMessage(
  context: AgentContext,
  outingId: string,
  input: unknown,
): Promise<ApiResponse> {
  const parsed = sendMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid_input" } };
  }
  if (!isUuid(outingId)) return { status: 404, body: { error: "not_found" } };

  const outing = await findOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };

  const inserted = await context.db.query<MessageRow>(
    `insert into messages
      (id, outing_id, role, content, client_message_id, status)
     values ($1, $2, 'user', $3, $4, 'pending')
     on conflict do nothing
     returning *`,
    [crypto.randomUUID(), outing.id, parsed.data.content, parsed.data.clientMessageId],
  );

  if (inserted.length === 0) {
    const existing = await context.db.query<MessageRow>(
      `select * from messages where outing_id = $1 and client_message_id = $2`,
      [outing.id, parsed.data.clientMessageId],
    );
    const message = existing[0];

    if (!message) return { status: 409, body: { error: "message_conflict" } };
    if (message.status === "pending") {
      return { status: 202, body: { messageId: message.id, status: "pending" } };
    }
    if (message.status === "failed") {
      return {
        status: 502,
        body: { messageId: message.id, error: message.error_code ?? "model_error" },
      };
    }
    return {
      status: 200,
      body: {
        messageId: message.id,
        messages: await listMessages(context.db, outing.id),
      },
    };
  }

  return generateReply(context, outing, inserted[0], 200);
}

export async function retryMessage(
  context: AgentContext,
  outingId: string,
  messageId: string,
): Promise<ApiResponse> {
  if (!isUuid(outingId) || !isUuid(messageId)) {
    return { status: 404, body: { error: "not_found" } };
  }
  const outing = await findOuting(context.db, outingId, context.userId);
  if (!outing) return { status: 404, body: { error: "not_found" } };

  const rows = await context.db.query<MessageRow>(
    `select * from messages where id = $1 and outing_id = $2 and role = 'user'`,
    [messageId, outing.id],
  );
  const message = rows[0];
  if (!message) return { status: 404, body: { error: "not_found" } };

  const replies = await context.db.query<{ id: string }>(
    `select id from messages where reply_to_message_id = $1`,
    [message.id],
  );
  if (replies.length > 0) {
    await context.db.query(
      `update messages set status = 'replied', error_code = null where id = $1`,
      [message.id],
    );
    return {
      status: 200,
      body: {
        messageId: message.id,
        messages: await listMessages(context.db, outing.id),
      },
    };
  }

  return generateReply(context, outing, message, 200);
}
