import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError, type Agent, type AgentTurnInput } from "@/lib/agent";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import {
  createOuting,
  getOuting,
  retryMessage,
  sendMessage,
  type ApiContext,
} from "@/lib/outings-api";

class FakeAgent implements Agent {
  calls: AgentTurnInput[] = [];

  constructor(
    private readonly behavior: (input: AgentTurnInput) => string | Promise<string> = () =>
      "Here is a workable first step.",
  ) {}

  async reply(input: AgentTurnInput): Promise<{ text: string }> {
    this.calls.push(structuredClone(input));
    return { text: await this.behavior(input) };
  }
}

const STARTER = "user_starter";
const OTHER = "user_other";

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

function ctx(agent: Agent, userId = STARTER): ApiContext {
  return { db, agent, userId };
}

async function makeOuting(agent: Agent, suggestion = "Dinner Friday?") {
  const response = await createOuting(ctx(agent), {
    suggestion,
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  expect(response.status).toBe(201);
  return (response.body.outing as { id: string }).id;
}

async function savedMessages(outingId: string) {
  return db.query<{
    id: string;
    role: string;
    content: string;
    status: string;
    error_code: string | null;
    reply_to_message_id: string | null;
  }>(
    "select id, role, content, status, error_code, reply_to_message_id from messages where outing_id = $1 order by seq",
    [outingId],
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("starting an outing", () => {
  it("stores the explicit cutoff the starter supplied", async () => {
    const agent = new FakeAgent();
    const response = await createOuting(ctx(agent), {
      suggestion: "Dinner Friday?",
      cutoffDate: "2026-10-31",
      cutoffTime: "19:30",
      cutoffTimeZone: "America/Phoenix",
    });

    expect(response.status).toBe(201);
    expect(response.body.outing).toMatchObject({
      suggestion: "Dinner Friday?",
      cutoffAt: "2026-11-01T02:30:00.000Z",
      cutoffTimeZone: "America/Phoenix",
      cutoffDisplay: "Oct 31, 2026, 7:30 PM MST",
    });
  });

  it("refuses to invent a cutoff when none was supplied", async () => {
    const response = await createOuting(ctx(new FakeAgent()), {
      suggestion: "Dinner Friday?",
    });

    expect(response.status).toBe(400);
    await expect(db.query("select id from outings")).resolves.toHaveLength(0);
  });

  it("rejects a cutoff time skipped by a daylight saving transition", async () => {
    const response = await createOuting(ctx(new FakeAgent()), {
      suggestion: "Dinner Friday?",
      cutoffDate: "2026-03-08",
      cutoffTime: "02:30",
      cutoffTimeZone: "America/New_York",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("nonexistent_local_time");
  });
});

describe("private chat ownership", () => {
  it("returns the outing and its conversation only to its starter", async () => {
    const agent = new FakeAgent();
    const outingId = await makeOuting(agent);
    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Maybe a 7pm movie?",
    });

    const ownerView = await getOuting(ctx(agent), outingId);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.messages).toHaveLength(2);

    const strangerView = await getOuting(ctx(agent, OTHER), outingId);
    expect(strangerView.status).toBe(404);
    expect(JSON.stringify(strangerView.body)).not.toContain("7pm movie");
  });

  it("refuses sends and retries from a different signed-in account", async () => {
    const agent = new FakeAgent();
    const outingId = await makeOuting(agent);
    const send = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Let me in.",
    });
    expect(send.status).toBe(404);

    const retry = await retryMessage(ctx(agent, OTHER), outingId, crypto.randomUUID());
    expect(retry.status).toBe(404);

    await expect(savedMessages(outingId)).resolves.toHaveLength(0);
  });
});

describe("private agent turns", () => {
  it("saves the starter's message and the agent reply, and restores both on reload", async () => {
    const agent = new FakeAgent(() => "Let's compare a 7pm and an 8pm show.");
    const outingId = await makeOuting(agent);

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I want to keep it cheap.",
    });

    expect(sent.status).toBe(200);
    expect(
      (sent.body.messages as Array<{ content: string }>).map((m) => m.content),
    ).toEqual(["I want to keep it cheap.", "Let's compare a 7pm and an 8pm show."]);

    const reloaded = await getOuting(ctx(agent), outingId);
    expect(reloaded.status).toBe(200);
    expect(
      (reloaded.body.messages as Array<{ content: string }>).map((m) => m.content),
    ).toEqual(["I want to keep it cheap.", "Let's compare a 7pm and an 8pm show."]);
  });

  it("gives the agent only this outing's suggestion and conversation", async () => {
    const agent = new FakeAgent();
    const first = await makeOuting(agent, "Dinner Friday?");
    await makeOuting(agent, "SECRET-OTHER-OUTING bowling on Sunday");

    await sendMessage(ctx(agent), first, {
      clientMessageId: crypto.randomUUID(),
      content: "Somewhere near campus.",
    });

    const payload = JSON.stringify(agent.calls);
    expect(payload).toContain("Dinner Friday?");
    expect(payload).toContain("Somewhere near campus.");
    expect(payload).not.toContain("SECRET-OTHER-OUTING");
  });

  it("does not create a second message pair for a duplicate client message id", async () => {
    const agent = new FakeAgent(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "One reply.";
    });
    const outingId = await makeOuting(agent);
    const input = { clientMessageId: crypto.randomUUID(), content: "Friday works." };

    const [first, second] = await Promise.all([
      sendMessage(ctx(agent), outingId, input),
      sendMessage(ctx(agent), outingId, input),
    ]);

    expect([first.status, second.status].every((status) => status < 300)).toBe(true);
    expect(agent.calls).toHaveLength(1);
    const messages = await savedMessages(outingId);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "agent")).toHaveLength(1);
  });

  it("keeps the starter's message after a model failure and lets a retry finish the turn", async () => {
    const outingId = await makeOuting(new FakeAgent());
    const failing = new FakeAgent(() => {
      throw new AgentError("model_error", "provider returned 500");
    });

    const failed = await sendMessage(ctx(failing), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Friday after 6.",
    });

    expect(failed.status).toBe(502);
    const failedMessageId = failed.body.messageId as string;
    expect(failedMessageId).toBeTruthy();
    let messages = await savedMessages(outingId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", status: "failed", error_code: "model_error" });

    const working = new FakeAgent(() => "Great, 6:30pm works.");
    const retried = await retryMessage(ctx(working), outingId, failedMessageId);

    expect(retried.status).toBe(200);
    messages = await savedMessages(outingId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", status: "replied" });
    expect(messages[1]).toMatchObject({
      role: "agent",
      content: "Great, 6:30pm works.",
      reply_to_message_id: messages[0].id,
    });

    const callsAfterRetry = working.calls.length;
    const again = await retryMessage(ctx(working), outingId, failedMessageId);
    expect(again.status).toBe(200);
    expect(working.calls).toHaveLength(callsAfterRetry);
    await expect(savedMessages(outingId)).resolves.toHaveLength(2);
  });

  it("recovers a turn that is stuck pending without duplicating the reply", async () => {
    const outingId = await makeOuting(new FakeAgent());
    let release!: (text: string) => void;
    const slow = new FakeAgent(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const inFlight = sendMessage(ctx(slow), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Still thinking about Friday.",
    });

    let pendingId = "";
    await waitFor(async () => {
      const messages = await savedMessages(outingId);
      if (messages.length !== 1 || messages[0].status !== "pending") return false;
      pendingId = messages[0].id;
      return true;
    });

    const recovered = await retryMessage(
      ctx(new FakeAgent(() => "Recovered reply.")),
      outingId,
      pendingId,
    );
    expect(recovered.status).toBe(200);

    release("Late reply.");
    expect((await inFlight).status).toBe(200);

    const messages = await savedMessages(outingId);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
  });

  it("keeps private text out of application logs", async () => {    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      const agent = new FakeAgent(() => "PRIVATE-REPLY-4821");
      const outingId = await makeOuting(agent);
      await sendMessage(ctx(agent), outingId, {
        clientMessageId: crypto.randomUUID(),
        content: "PRIVATE-BUDGET-900",
      });

      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain("PRIVATE-BUDGET-900");
      expect(logged).not.toContain("PRIVATE-REPLY-4821");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
