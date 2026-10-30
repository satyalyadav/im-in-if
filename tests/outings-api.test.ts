import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentError,
  type Agent,
  type AgentConditionUpdate,
  type AgentReply,
  type AgentTurnInput,
} from "@/lib/agent";
import { createPgliteDb, migrate, type Db } from "@/lib/db";
import { emptyConditionInterpretation, parseJsonValue } from "@/lib/planning-types";
import {
  createOuting,
  getOuting,
  retryMessage,
  sendMessage,
  type AgentContext,
} from "@/lib/outings-api";

class FakeAgent implements Agent {
  calls: AgentTurnInput[] = [];

  constructor(
    private readonly behavior: (input: AgentTurnInput) => string | AgentReply | Promise<string | AgentReply> = () =>
      "Here is a workable first step.",
  ) {}

  async reply(input: AgentTurnInput): Promise<AgentReply> {
    this.calls.push(structuredClone(input));
    const result = await this.behavior(input);
    return typeof result === "string" ? { text: result } : result;
  }
}

function agentConditions(options: {
  maxCostCents?: number | null;
  availableWindows?: AgentConditionUpdate["hard"]["availableWindows"];
  requiredActivityTags?: string[];
  avoidedActivityTags?: string[];
  attendanceDependencyNames?: string[];
  minimumGroupSize?: number;
  flexiblePreferences?: string[];
  clarifyingQuestions?: string[];
} = {}): AgentConditionUpdate {
  return {
    hard: {
      availableWindows: options.availableWindows ?? [],
      maxCostCents: options.maxCostCents ?? null,
      requiredActivityTags: options.requiredActivityTags ?? [],
      avoidedActivityTags: options.avoidedActivityTags ?? [],
      attendanceDependencyNames: options.attendanceDependencyNames ?? [],
      minimumGroupSize: options.minimumGroupSize ?? 1,
    },
    flexiblePreferences: options.flexiblePreferences ?? [],
    clarifyingQuestions: options.clarifyingQuestions ?? [],
  };
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

function ctx(agent: Agent, userId = STARTER): AgentContext {
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

  it("creates one saved private chat turn without requiring a cutoff", async () => {
    const agent = new FakeAgent();
    const input = {
      suggestion: "Maybe dinner Friday?",
      requestId: crypto.randomUUID(),
    };

    const first = await createOuting(ctx(agent), input);
    expect(first.status).toBe(201);
    expect(first.body.outing).toMatchObject({
      suggestion: "Maybe dinner Friday?",
      cutoffAt: null,
      cutoffTimeZone: null,
      cutoffDisplay: null,
    });
    expect(first.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Maybe dinner Friday?" }),
      expect.objectContaining({ role: "agent", content: "Here is a workable first step." }),
    ]));
    expect(agent.calls[0]?.outing).toEqual({
      suggestion: "Maybe dinner Friday?",
      cutoffAt: null,
      cutoffTimeZone: null,
    });

    const outingId = (first.body.outing as { id: string }).id;
    const repeated = await createOuting(ctx(agent), input);
    expect(repeated.status).toBe(200);
    expect((repeated.body.outing as { id: string }).id).toBe(outingId);
    expect(await db.query("select id from outings")).toHaveLength(1);
    expect(await savedMessages(outingId)).toHaveLength(2);
    expect(agent.calls).toHaveLength(1);

    const reused = await createOuting(ctx(agent), {
      ...input,
      suggestion: "Different idea",
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("idempotency_conflict");
    expect(await db.query("select id from outings")).toHaveLength(1);
    expect(await savedMessages(outingId)).toHaveLength(2);
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

  it("does not add movie options to a sushi outing", async () => {
    const response = await createOuting(ctx(new FakeAgent()), {
      suggestion: "Sushi with Starter, Dan, and Jolly",
      cutoffDate: "2026-10-31",
      cutoffTime: "19:30",
      cutoffTimeZone: "America/Phoenix",
    });
    expect(response.status).toBe(201);
    const outingId = (response.body.outing as { id: string }).id;
    const options = await db.query<{ title: string; activity: string; source: string }>(
      `select title, activity, source from outing_options where outing_id = $1`,
      [outingId],
    );
    expect(options).toEqual([]);
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

  it("keeps another participant's private state out of the owner's model context", async () => {
    const agent = new FakeAgent();
    const outingId = await makeOuting(agent);
    const otherConditions = emptyConditionInterpretation();
    otherConditions.hard.maxCostCents = 300;
    await db.query(
      `insert into participants
        (outing_id, user_id, display_name, admission_status, response_status, agent_session_id)
       values ($1, $2, 'Other', 'admitted', 'pending', 'ses_other-private-context')`,
      [outingId, OTHER],
    );
    await db.query(
      `insert into participant_preferences
        (outing_id, user_id, private_input, interpretation, interpretation_ready)
       values ($1, $2, 'SECRET-OTHER-NOTE', $3::jsonb, true)`,
      [outingId, OTHER, JSON.stringify(otherConditions)],
    );
    await db.query(
      `insert into messages (id, outing_id, owner_user_id, role, content, status)
       values ($1, $2, $3, 'user', 'SECRET-OTHER-CHAT', 'replied')`,
      [crypto.randomUUID(), outingId, OTHER],
    );

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I want to keep it cheap.",
    });

    const payload = JSON.stringify(agent.calls[0]);
    expect(payload).toContain("Other");
    expect(payload).not.toContain("SECRET-OTHER-NOTE");
    expect(payload).not.toContain("SECRET-OTHER-CHAT");
    expect(payload).not.toContain('"maxCostCents":300');
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

  it("stores initial facts, asks about ambiguity, then saves the answer as ready conditions", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content?.startsWith("I can spend")
      ? {
          text: "I have your $15 cap. Which Friday and time should I use?",
          conditionUpdate: agentConditions({
            maxCostCents: 1500,
            clarifyingQuestions: ["Which Friday and time should I use?"],
          }),
        }
      : {
          text: "Got it. Friday, November 6 from 6 to 8 PM works with your $15 cap.",
          conditionUpdate: agentConditions({
            maxCostCents: 1500,
            availableWindows: [{
              startsAt: "2026-11-07T01:00:00.000Z",
              endsAt: "2026-11-07T03:00:00.000Z",
            }],
          }),
        });
    const outingId = await makeOuting(agent);

    const first = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I can spend up to $15, maybe Friday.",
    });
    expect(first.status).toBe(200);
    let preference = await db.query<{
      interpretation: unknown;
      interpretation_ready: boolean;
      conditions_version: number;
    }>(`select interpretation, interpretation_ready, conditions_version
          from participant_preferences where outing_id = $1 and user_id = $2`, [outingId, STARTER]);
    let interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.maxCostCents).toBe(1500);
    expect(interpretation.clarifyingQuestions).toEqual(["Which Friday and time should I use?"]);
    expect(preference[0]).toMatchObject({ interpretation_ready: false, conditions_version: 1 });

    const second = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Friday, November 6, between 6 and 8 PM in Phoenix.",
    });
    expect(second.status).toBe(200);
    expect(agent.calls[1].currentConditions?.hard.maxCostCents).toBe(1500);
    preference = await db.query(
      `select interpretation, interpretation_ready, conditions_version
         from participant_preferences where outing_id = $1 and user_id = $2`,
      [outingId, STARTER],
    );
    interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.maxCostCents).toBe(1500);
    expect(interpretation.hard.availableWindows).toEqual([{
      startsAt: "2026-11-07T01:00:00.000Z",
      endsAt: "2026-11-07T03:00:00.000Z",
    }]);
    expect(interpretation.clarifyingQuestions).toEqual([]);
    expect(preference[0]).toMatchObject({ interpretation_ready: true, conditions_version: 2 });
  });

  it("accepts short amount answers to a pending clarification but ignores thanks and off-topic chat", async () => {
    const agent = new FakeAgent((input) => {
      const latest = input.history.at(-1)?.content;
      if (latest === "I am still figuring out my spending limit.") {
        return {
          text: "How much is your maximum spending cap?",
          conditionUpdate: agentConditions({ clarifyingQuestions: ["How much is your maximum spending cap?"] }),
        };
      }
      if (latest === "Thanks.") {
        return { text: "You're welcome.", conditionUpdate: agentConditions({ maxCostCents: 2000 }) };
      }
      return { text: "I'll use $20 as your cap.", conditionUpdate: agentConditions({ maxCostCents: 2000 }) };
    });
    const outingId = await makeOuting(agent);
    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I am still figuring out my spending limit.",
    });

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Thanks.",
    });
    let preference = await db.query<{ interpretation: unknown; conditions_version: number; interpretation_ready: boolean }>(
      `select interpretation, interpretation_ready, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBeNull();
    expect(preference[0].conditions_version).toBe(1);

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I saw a documentary about birds last night.",
    });
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBeNull();
    expect(preference[0].conditions_version).toBe(1);

    const answered = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "20 bucks",
    });
    expect(answered.status).toBe(200);
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(2000);
    expect(preference[0].conditions_version).toBe(2);

    const bareNumberOutingId = await makeOuting(agent);
    await sendMessage(ctx(agent), bareNumberOutingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I am still figuring out my spending limit.",
    });
    await sendMessage(ctx(agent), bareNumberOutingId, {
      clientMessageId: crypto.randomUUID(),
      content: "20",
    });
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [bareNumberOutingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(2000);
    expect(preference[0].conditions_version).toBe(2);
  });

  it("accepts an admitted person's bare name as the answer to a pending clarification", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I need Jordan to come."
      ? {
          text: "I couldn't match Jordan to an admitted person. Who did you mean?",
          conditionUpdate: agentConditions({ attendanceDependencyNames: ["Jordan"] }),
        }
      : {
          text: "Got it, Jordan needs to attend with you.",
          conditionUpdate: agentConditions({ attendanceDependencyNames: ["Jordan"] }),
        });
    const outingId = await makeOuting(agent);
    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I need Jordan to come.",
    });
    const stillUnknown = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Jordan",
    });
    expect((stillUnknown.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("I couldn't match Jordan to an admitted person");
    let preference = await db.query<{ interpretation: unknown; interpretation_ready: boolean }>(
      `select interpretation, interpretation_ready from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    let interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.attendanceDependencies).toEqual([]);
    expect(preference[0].interpretation_ready).toBe(false);

    await db.query(
      `insert into participants
        (outing_id, user_id, display_name, admission_status, response_status, agent_session_id)
       values ($1, 'user_jordan', 'Jordan', 'admitted', 'pending', 'ses_jordan-followup')`,
      [outingId],
    );

    const answered = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Jordan",
    });
    expect(answered.status).toBe(200);
    preference = await db.query(
      `select interpretation, interpretation_ready from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.attendanceDependencies).toEqual(["user_jordan"]);
    expect(interpretation.clarifyingQuestions).toEqual([]);
    expect(preference[0].interpretation_ready).toBe(true);
  });

  it("keeps an existing cap through an unknown-name clarification and later resolution", async () => {
    const agent = new FakeAgent((input) => {
      const latest = input.history.at(-1)?.content;
      if (latest === "My hard spending cap is $15.") {
        return { text: "I saved your $15 cap.", conditionUpdate: agentConditions({ maxCostCents: 1500 }) };
      }
      if (latest === "I need Unknown Friend to come.") {
        return {
          text: "I'll check who you mean.",
          conditionUpdate: agentConditions({ maxCostCents: null, attendanceDependencyNames: ["Unknown Friend"] }),
        };
      }
      return {
        text: "Jordan needs to attend with you.",
        conditionUpdate: agentConditions({ maxCostCents: null, attendanceDependencyNames: ["Jordan"] }),
      };
    });
    const outingId = await makeOuting(agent);
    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My hard spending cap is $15.",
    });
    const unresolved = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I need Unknown Friend to come.",
    });
    expect(unresolved.status).toBe(200);
    let preference = await db.query<{ interpretation: unknown; interpretation_ready: boolean }>(
      `select interpretation, interpretation_ready from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    let interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.maxCostCents).toBe(1500);
    expect(interpretation.clarifyingQuestions.join(" ")).toContain("couldn't match Unknown Friend");
    expect(preference[0].interpretation_ready).toBe(false);

    await db.query(
      `insert into participants
        (outing_id, user_id, display_name, admission_status, response_status, agent_session_id)
       values ($1, 'user_jordan', 'Jordan', 'admitted', 'pending', 'ses_jordan-cap-preservation')`,
      [outingId],
    );
    const resolved = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Jordan",
    });
    expect(resolved.status).toBe(200);
    expect((resolved.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("Should I remove that cap?");
    preference = await db.query(
      `select interpretation, interpretation_ready from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.maxCostCents).toBe(1500);
    expect(interpretation.hard.attendanceDependencies).toEqual(["user_jordan"]);
  });

  it("preserves saved limits when a later generic thanks would otherwise clear them", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "Thanks."
      ? { text: "You're welcome.", conditionUpdate: agentConditions() }
      : { text: "I saved your $15 cap.", conditionUpdate: agentConditions({ maxCostCents: 1500 }) });
    const outingId = await makeOuting(agent);

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My hard spending cap is $15.",
    });
    const thanked = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Thanks.",
    });

    expect(thanked.status).toBe(200);
    const preference = await db.query<{ interpretation: unknown; conditions_version: number }>(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    const interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.maxCostCents).toBe(1500);
    expect(preference[0].conditions_version).toBe(1);
  });

  it("labels availability timestamps when an outing has no time zone", async () => {
    const agent = new FakeAgent((input) => ({
      text: "Let's find a plan.",
      conditionUpdate: agentConditions({
        availableWindows: input.currentConditions ? [] : [{
          startsAt: "2026-10-30T02:00:00.000Z",
          endsAt: "2026-10-30T04:00:00.000Z",
        }],
      }),
    }));
    const created = await createOuting(ctx(agent), {
      suggestion: "I am only available during these saved times for dinner.",
      requestId: crypto.randomUUID(),
    }, agent);
    const outingId = (created.body.outing as { id: string }).id;
    const reply = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Maybe a movie instead.",
    });
    expect(reply.status).toBe(200);
    const text = (reply.body.messages as Array<{ content: string }>).at(-1)?.content;
    expect(text).toContain("UTC");
    expect(text).toContain("your local time zone is not set");
  });

  it("asks before weakening a hard limit and requires confirmation for direct corrections", async () => {
    const agent = new FakeAgent((input) => {
      const latest = input.history.at(-1)?.content ?? "";
      if (latest === "I want a movie.") {
        return { text: "A movie sounds good.", conditionUpdate: agentConditions({ maxCostCents: 2000 }) };
      }
      if (latest === "Yes.") {
        const nextCap = (input.currentConditions?.hard.maxCostCents ?? 0) < 2000 ? 2000 : 2500;
        return { text: `Your cap is now $${nextCap / 100}.`, conditionUpdate: agentConditions({ maxCostCents: nextCap }) };
      }
      if (latest === "Actually, raise my cap to $20.") {
        return { text: "Your cap is now $20.50.", conditionUpdate: agentConditions({ maxCostCents: 2050 }) };
      }
      if (latest.startsWith("Actually, raise")) {
        return { text: "Your cap is now $25.", conditionUpdate: agentConditions({ maxCostCents: 2500 }) };
      }
      return { text: "I saved your $15 cap.", conditionUpdate: agentConditions({ maxCostCents: 1500 }) };
    });
    const outingId = await makeOuting(agent);

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My hard spending cap is $15.",
    });
    const suggestion = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I want a movie.",
    });
    expect(suggestion.status).toBe(200);
    expect((suggestion.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toBe("Your strict spending cap is $15.00. The new cap would be $20.00. Should I raise it to $20.00?");
    let preference = await db.query<{ interpretation: unknown; conditions_version: number; interpretation_ready: boolean }>(
      `select interpretation, interpretation_ready, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(1500);
    expect(preference[0].conditions_version).toBe(1);

    const confirmed = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Yes.",
    });
    expect(confirmed.status).toBe(200);
    const correction = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Actually, raise my cap to $25.",
    });
    expect((correction.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("Should I raise it to $25.00?");
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(2000);
    expect(preference[0].conditions_version).toBe(2);

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Yes.",
    });
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(2500);
    expect(preference[0].conditions_version).toBe(3);

    const preciseAmountOutingId = await makeOuting(agent);
    await sendMessage(ctx(agent), preciseAmountOutingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My hard spending cap is $15.",
    });
    const mismatch = await sendMessage(ctx(agent), preciseAmountOutingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Actually, raise my cap to $20.",
    });
    expect((mismatch.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("Should I raise it to $20.50?");
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [preciseAmountOutingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(1500);
    expect(preference[0].conditions_version).toBe(1);
  });

  it("ignores negated, quoted, and hypothetical relaxations until a clear yes to the exact prompt", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "My hard spending cap is $15."
      ? { text: "I saved your $15 cap.", conditionUpdate: agentConditions({ maxCostCents: 1500 }) }
      : { text: "Your cap is now $20.", conditionUpdate: agentConditions({ maxCostCents: 2000 }) });
    const outingId = await makeOuting(agent);
    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My hard spending cap is $15.",
    });

    for (const content of [
      "Do not raise my budget to $20.",
      '"Yes, raise my budget to $20."',
      "What if I raised my budget to $20?",
    ]) {
      const result = await sendMessage(ctx(agent), outingId, {
        clientMessageId: crypto.randomUUID(),
        content,
      });
      expect((result.body.messages as Array<{ content: string }>).at(-1)?.content)
        .toBe("Your strict spending cap is $15.00. The new cap would be $20.00. Should I raise it to $20.00?");
      const preference = await db.query<{ interpretation: unknown }>(
        `select interpretation from participant_preferences where outing_id = $1 and user_id = $2`,
        [outingId, STARTER],
      );
      expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(1500);
    }

    const refused = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "No.",
    });
    expect((refused.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toBe("Understood. I'll keep your strict spending cap at $15.00.");
    let preference = await db.query<{ interpretation: unknown; conditions_version: number }>(
      `select interpretation, conditions_version from participant_preferences where outing_id = $1 and user_id = $2`,
      [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(1500);
    expect(preference[0].conditions_version).toBe(1);

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I want a movie.",
    });
    const confirmed = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Okay.",
    });
    expect(confirmed.status).toBe(200);
    preference = await db.query(
      `select interpretation, conditions_version from participant_preferences where outing_id = $1 and user_id = $2`,
      [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(2000);
    expect(preference[0].conditions_version).toBe(2);
  });

  it("clarifies unknown or self attendance names and malformed time windows", async () => {
    const agent = new FakeAgent(() => ({
      text: "I can check that.",
      conditionUpdate: agentConditions({
        attendanceDependencyNames: ["Nobody", "Starter"],
        availableWindows: [{
          startsAt: "2026-11-07T03:00:00.000Z",
          endsAt: "2026-11-07T01:00:00.000Z",
        }],
      }),
    }));
    const outingId = await makeOuting(agent);

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I can only come if Jordan comes, and I need a time after 8.",
    });
    expect(sent.status).toBe(200);
    const preference = await db.query<{ interpretation: unknown; interpretation_ready: boolean }>(
      `select interpretation, interpretation_ready from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    const interpretation = parseJsonValue(preference[0].interpretation, emptyConditionInterpretation());
    expect(interpretation.hard.attendanceDependencies).toEqual([]);
    expect(interpretation.hard.availableWindows).toEqual([]);
    expect(interpretation.clarifyingQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("couldn't match Nobody"),
      expect.stringContaining("named yourself"),
      expect.stringContaining("ends before it starts"),
    ]));
    expect(preference[0].interpretation_ready).toBe(false);
  });

  it("commits condition state with the reply and supersedes published proposals", async () => {
    const agent = new FakeAgent(() => ({
      text: "I saved your hard $15 cap.",
      conditionUpdate: agentConditions({ maxCostCents: 1500 }),
    }));
    const outingId = await makeOuting(agent);
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Synthetic movie option', 'Movie', '2026-11-02T02:00:00Z',
               900, '["movie"]', 'manual')`,
      [crypto.randomUUID(), outingId, STARTER],
    );
    const option = await db.query<{ id: string; activity: string; starts_at: string | Date; estimated_cost_cents: number }>(
      `select id, activity, starts_at, estimated_cost_cents from outing_options
        where outing_id = $1 order by starts_at limit 1`, [outingId],
    );
    const proposalId = crypto.randomUUID();
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at, condition_versions)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb, 'published', 'initial', now(), now() + interval '30 minutes', $9::jsonb)`,
      [proposalId, outingId, STARTER, option[0].id, option[0].activity, option[0].starts_at,
        option[0].estimated_cost_cents, JSON.stringify([STARTER]), JSON.stringify({ [STARTER]: 0 })],
    );

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My hard spending cap is $15.",
    });

    expect(sent.status).toBe(200);
    const [preference, proposal, reply] = await Promise.all([
      db.query<{ conditions_version: number; interpretation_ready: boolean }>(
        `select conditions_version, interpretation_ready from participant_preferences
          where outing_id = $1 and user_id = $2`, [outingId, STARTER],
      ),
      db.query<{ status: string }>(`select status from proposals where id = $1`, [proposalId]),
      db.query<{ count: number | string }>(
        `select count(*)::int as count from messages where outing_id = $1 and role = 'agent'`, [outingId],
      ),
    ]);
    expect(preference[0]).toMatchObject({ conditions_version: 1, interpretation_ready: true });
    expect(proposal[0].status).toBe("superseded");
    expect(Number(reply[0].count)).toBe(1);
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
    const failedPreference = await db.query<{
      interpretation: unknown;
      interpretation_ready: boolean;
      conditions_version: number;
    }>(`select interpretation, interpretation_ready, conditions_version
          from participant_preferences where outing_id = $1 and user_id = $2`, [outingId, STARTER]);
    expect(failedPreference[0]).toMatchObject({
      interpretation: null,
      interpretation_ready: false,
      conditions_version: 0,
    });

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

  it("does not take over a reply before its configured request timeout", async () => {
    const outingId = await makeOuting(new FakeAgent());
    let release!: (reply: AgentReply) => void;
    const slow = Object.assign(
      new FakeAgent(() => new Promise<AgentReply>((resolve) => { release = resolve; })),
      { requestTimeoutMs: 300_000 },
    );
    const inFlight = sendMessage(ctx(slow), outingId, {
      clientMessageId: crypto.randomUUID(), content: "Dinner Friday?",
    });
    await waitFor(async () => slow.calls.length === 1);
    const [pending] = await savedMessages(outingId);
    await db.query(
      `update messages set processing_started_at = now() - interval '3 minutes' where id = $1`,
      [pending.id],
    );
    const retrying = Object.assign(new FakeAgent(() => "Duplicate call."), { requestTimeoutMs: 300_000 });
    try {
      const result = await retryMessage(ctx(retrying), outingId, pending.id);
      expect(result.status).toBe(202);
      expect(retrying.calls).toHaveLength(0);
    } finally {
      release({ text: "Original reply." });
      await inFlight;
    }
  });

  it("recovers a turn that is stuck pending without duplicating the reply", async () => {
    const outingId = await makeOuting(new FakeAgent());
    let release!: (reply: AgentReply) => void;
    const slow = new FakeAgent(
      () =>
        new Promise<AgentReply>((resolve) => {
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
    await db.query(
      `update messages set processing_started_at = now() - interval '3 minutes' where id = $1`,
      [pendingId],
    );

    const recovered = await retryMessage(
      ctx(new FakeAgent(() => ({
        text: "Recovered reply.",
        conditionUpdate: agentConditions({ maxCostCents: 1500 }),
      }))),
      outingId,
      pendingId,
    );
    expect(recovered.status).toBe(200);

    release({ text: "Late reply.", conditionUpdate: agentConditions({ maxCostCents: 2000 }) });
    expect((await inFlight).status).toBe(200);

    const messages = await savedMessages(outingId);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
    const preference = await db.query<{ interpretation: unknown; conditions_version: number }>(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(1500);
    expect(preference[0].conditions_version).toBe(1);
  });

  it("rejects a stale model update after a newer turn has saved conditions", async () => {
    const outingId = await makeOuting(new FakeAgent());
    let release!: (reply: AgentReply) => void;
    const slow = new FakeAgent(() => new Promise<AgentReply>((resolve) => { release = resolve; }));
    const olderTurn = sendMessage(ctx(slow), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "My cap is $10.",
    });
    let olderId = "";
    await waitFor(async () => {
      const messages = await savedMessages(outingId);
      if (!release || messages.length !== 1 || messages[0].status !== "pending") return false;
      olderId = messages[0].id;
      return true;
    });

    const newer = await sendMessage(ctx(new FakeAgent(() => ({
      text: "I saved your $20 cap.",
      conditionUpdate: agentConditions({ maxCostCents: 2000 }),
    }))), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Actually, my cap is $20 now.",
    });
    expect(newer.status).toBe(200);
    release({
      text: "I saved your $10 cap.",
      conditionUpdate: agentConditions({ maxCostCents: 1000 }),
    });
    const stale = await olderTurn;

    expect(stale).toMatchObject({ status: 409, body: { error: "stale_reply", messageId: olderId } });
    const preference = await db.query<{ interpretation: unknown; conditions_version: number }>(
      `select interpretation, conditions_version from participant_preferences
        where outing_id = $1 and user_id = $2`, [outingId, STARTER],
    );
    expect(parseJsonValue(preference[0].interpretation, emptyConditionInterpretation()).hard.maxCostCents).toBe(2000);
    expect(preference[0].conditions_version).toBe(1);
    const messages = await savedMessages(outingId);
    expect(messages.find((message) => message.id === olderId)).toMatchObject({
      status: "failed",
      error_code: "stale_reply",
    });
  });

  it("keeps a failed message in the agent's context when the starter moves on", async () => {
    const outingId = await makeOuting(new FakeAgent());
    const failing = new FakeAgent(() => {
      throw new AgentError("model_error");
    });

    const failed = await sendMessage(ctx(failing), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "PRIVATE-FAILED-CONTEXT",
    });
    expect(failed.status).toBe(502);

    const next = new FakeAgent();
    const sent = await sendMessage(ctx(next), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Try a different night.",
    });

    expect(sent.status).toBe(200);
    const history = JSON.stringify(next.calls[0]?.history);
    expect(history).toContain("PRIVATE-FAILED-CONTEXT");
    expect(history).toContain("Try a different night.");
  });

  it("keeps private text out of application logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
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

describe("conversation interest", () => {
  async function addParticipant(
    outingId: string,
    userId: string,
    displayName: string,
    responseStatus = "pending",
  ) {
    await db.query(
      `insert into participants
        (outing_id, user_id, display_name, admission_status, response_status, agent_session_id)
       values ($1, $2, $3, 'admitted', $4, $5)`,
      [outingId, userId, displayName, responseStatus, `ses_${userId}`],
    );
  }

  async function participantState(outingId: string, userId: string) {
    const participants = await db.query<{ response_status: string }>(
      `select response_status from participants where outing_id = $1 and user_id = $2`,
      [outingId, userId],
    );
    const preferences = await db.query<{
      interpretation: unknown;
      interpretation_ready: boolean;
      conditions_version: number;
    }>(
      `select interpretation, interpretation_ready, conditions_version
         from participant_preferences where outing_id = $1 and user_id = $2`,
      [outingId, userId],
    );
    return {
      status: participants[0]?.response_status,
      ready: preferences[0]?.interpretation_ready,
      version: preferences[0]?.conditions_version,
      interpretation: preferences[0]
        ? parseJsonValue(preferences[0].interpretation, emptyConditionInterpretation())
        : null,
    };
  }

  it("records conditional interest and its hard condition from one clear statement", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm in if it's under $30."
      ? {
          text: "You're in if it stays under $30. I saved that as a strict cap.",
          interestUpdate: "interested",
          conditionUpdate: agentConditions({ maxCostCents: 3000 }),
        }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);
    await addParticipant(outingId, OTHER, "Other");

    const sent = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm in if it's under $30.",
    });

    expect(sent.status).toBe(200);
    const state = await participantState(outingId, OTHER);
    expect(state).toMatchObject({ status: "interested", ready: true, version: 1 });
    expect(state.interpretation?.hard.maxCostCents).toBe(3000);
    expect(agent.calls.at(-1)?.responseStatus).toBe("pending");
    expect((sent.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("under $30");
  });

  it("records plain interest with empty conditions so an offer can be prepared", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm in."
      ? { text: "You're in. I'll look for something that fits.", interestUpdate: "interested" }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);
    await addParticipant(outingId, OTHER, "Other");

    const sent = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm in.",
    });

    expect(sent.status).toBe(200);
    const state = await participantState(outingId, OTHER);
    expect(state).toMatchObject({ status: "interested", ready: true, version: 1 });
    expect(state.interpretation).toEqual(emptyConditionInterpretation());
  });

  it("leaves interest unchanged when the owner asks about options", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "What time works?"
      ? { text: "A few times could work. What are you considering?", interestUpdate: null }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);
    await addParticipant(outingId, OTHER, "Other");

    const sent = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "What time works?",
    });

    expect(sent.status).toBe(200);
    await expect(participantState(outingId, OTHER)).resolves.toMatchObject({
      status: "pending",
      version: 0,
    });
  });

  it("records clear disinterest", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm out."
      ? { text: "I've noted that you're not interested in this one.", interestUpdate: "not_interested" }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm out.",
    });

    expect(sent.status).toBe(200);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "not_interested",
    });
  });

  it("asks about ambiguous strictness before recording interest, then applies the answer", async () => {
    const agent = new FakeAgent((input) => {
      const latest = input.history.at(-1)?.content;
      if (latest === "I'm in if it's cheap.") {
        return {
          text: "Is $30 a strict spending cap or a flexible preference? I haven't recorded your interest yet.",
          interestUpdate: "interested",
          conditionUpdate: agentConditions({
            clarifyingQuestions: ["Is $30 a strict spending cap or a flexible preference?"],
          }),
        };
      }
      return {
        text: "Got it. Under $30 is your strict cap, and I've recorded your interest.",
        interestUpdate: "interested",
        conditionUpdate: agentConditions({ maxCostCents: 3000 }),
      };
    });
    const outingId = await makeOuting(agent);
    await addParticipant(outingId, OTHER, "Other");

    const ambiguous = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm in if it's cheap.",
    });

    expect(ambiguous.status).toBe(200);
    expect((ambiguous.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("Is $30 a strict spending cap");
    let state = await participantState(outingId, OTHER);
    expect(state).toMatchObject({ status: "pending", ready: false, version: 1 });
    expect(state.interpretation?.hard.maxCostCents).toBeNull();

    const answered = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "Under $30 is a strict cap.",
    });

    expect(answered.status).toBe(200);
    state = await participantState(outingId, OTHER);
    expect(state).toMatchObject({ status: "interested", ready: true, version: 2 });
    expect(state.interpretation?.hard.maxCostCents).toBe(3000);
    expect(state.interpretation?.clarifyingQuestions).toEqual([]);
  });

  it("keeps a confirmed attendee's interest unchanged and points to the departure rules", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm out."
      ? { text: "I'll note that.", interestUpdate: "not_interested" }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);
    const optionId = crypto.randomUUID();
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Confirmed option', 'Dinner', '2026-12-02T02:00:00Z',
               1200, '["dinner"]', 'manual')`,
      [optionId, outingId, STARTER],
    );
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at, confirmed_at)
       values ($1, $2, 1, $3, $4, 'Dinner', '2026-12-02T02:00:00Z', 1200,
               $5::jsonb, 'confirmed', 'initial', now(), '2026-12-02T02:00:00Z', now())`,
      [crypto.randomUUID(), outingId, STARTER, optionId, JSON.stringify([STARTER])],
    );

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm out.",
    });

    expect(sent.status).toBe(200);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
    });
    expect((sent.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("Request to leave the roster");
    const departures = await db.query(`select id from departure_requests where outing_id = $1`, [outingId]);
    expect(departures).toEqual([]);
  });

  it("does not let an interest change approve a published proposal", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm in if it's under $30."
      ? {
          text: "You're in if it's under $30.",
          interestUpdate: "interested",
          conditionUpdate: agentConditions({ maxCostCents: 3000 }),
        }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);
    await addParticipant(outingId, OTHER, "Other");
    const optionId = crypto.randomUUID();
    const proposalId = crypto.randomUUID();
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Published option', 'Dinner', '2026-12-02T02:00:00Z',
               1200, '["dinner"]', 'manual')`,
      [optionId, outingId, STARTER],
    );
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at)
       values ($1, $2, 1, $3, $4, 'Dinner', '2026-12-02T02:00:00Z', 1200,
               $5::jsonb, 'published', 'initial', now(), '2026-12-02T02:00:00Z')`,
      [proposalId, outingId, STARTER, optionId, JSON.stringify([OTHER])],
    );

    const sent = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm in if it's under $30.",
    });

    expect(sent.status).toBe(200);
    const [proposal, approvals] = await Promise.all([
      db.query<{ status: string; confirmed_at: string | Date | null }>(
        `select status, confirmed_at from proposals where id = $1`, [proposalId],
      ),
      db.query(`select proposal_id from proposal_approvals where proposal_id = $1`, [proposalId]),
    ]);
    expect(proposal[0]).toMatchObject({ status: "superseded", confirmed_at: null });
    expect(approvals).toEqual([]);
    await expect(participantState(outingId, OTHER)).resolves.toMatchObject({
      status: "interested",
      ready: true,
    });
  });

  it("applies a retried interest change once and ignores duplicate delivery", async () => {
    const outingId = await makeOuting(new FakeAgent());
    await db.query(
      `update participants set response_status = 'not_interested', responded_at = now()
        where outing_id = $1 and user_id = $2`,
      [outingId, STARTER],
    );
    const failing = new FakeAgent(() => {
      throw new AgentError("model_error");
    });
    const failed = await sendMessage(ctx(failing), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm in if it's under $30.",
    });
    expect(failed.status).toBe(502);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "not_interested",
      version: 0,
    });

    const working = new FakeAgent(() => ({
      text: "You're in if it's under $30.",
      interestUpdate: "interested",
      conditionUpdate: agentConditions({ maxCostCents: 3000 }),
    }));
    const retried = await retryMessage(ctx(working), outingId, failed.body.messageId as string);
    expect(retried.status).toBe(200);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
      ready: true,
      version: 1,
    });

    const callsAfterRetry = working.calls.length;
    const repeated = await retryMessage(ctx(working), outingId, failed.body.messageId as string);
    expect(repeated.status).toBe(200);
    expect(working.calls).toHaveLength(callsAfterRetry);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
      version: 1,
    });

    await db.query(
      `update participants set response_status = 'not_interested', responded_at = now()
        where outing_id = $1 and user_id = $2`,
      [outingId, STARTER],
    );
    const callsBeforeDuplicate = working.calls.length;
    const messagesBeforeDuplicate = (await savedMessages(outingId)).length;
    const duplicateInput = { clientMessageId: crypto.randomUUID(), content: "Count me in." };
    const [first, second] = await Promise.all([
      sendMessage(ctx(working), outingId, duplicateInput),
      sendMessage(ctx(working), outingId, duplicateInput),
    ]);
    expect([first.status, second.status].every((status) => status < 300)).toBe(true);
    expect(working.calls).toHaveLength(callsBeforeDuplicate + 1);
    const messagesAfterDuplicate = await savedMessages(outingId);
    expect(messagesAfterDuplicate).toHaveLength(messagesBeforeDuplicate + 2);
    expect(messagesAfterDuplicate.filter((message) => message.role === "agent")).toHaveLength(2);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
      version: 1,
    });
  });

  it("does not change interest after the response cutoff", async () => {
    const agent = new FakeAgent(() => ({
      text: "I've noted that you're not interested.",
      interestUpdate: "not_interested",
    }));
    const outingId = await makeOuting(agent);
    await db.query(
      `update outings set cutoff_at = now() - interval '1 minute' where id = $1`,
      [outingId],
    );

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm out.",
    });

    expect(sent.status).toBe(200);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
    });
    expect((sent.body.messages as Array<{ content: string }>).at(-1)?.content)
      .toContain("response cutoff has passed");
  });

  it("records interest corrections through later messages", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm out."
      ? { text: "I've noted that you're not interested.", interestUpdate: "not_interested" }
      : { text: "You're in.", interestUpdate: "interested" });
    const outingId = await makeOuting(agent);

    await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm out.",
    });
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "not_interested",
    });

    const corrected = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm back in.",
    });

    expect(corrected.status).toBe(200);
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
      version: 1,
    });
  });

  it("does not save conditions when the interest write loses a race", async () => {
    let outingId = "";
    const agent = new FakeAgent(async () => {
      await db.query(
        `update participants set response_status = 'pending', responded_at = now()
          where outing_id = $1 and user_id = $2`,
        [outingId, STARTER],
      );
      return {
        text: "You're in if it stays under $30.",
        interestUpdate: "interested",
        conditionUpdate: agentConditions({ maxCostCents: 3000 }),
      };
    });
    outingId = await makeOuting(agent);
    await db.query(
      `update participants set response_status = 'not_interested', responded_at = now()
        where outing_id = $1 and user_id = $2`,
      [outingId, STARTER],
    );
    const optionId = crypto.randomUUID();
    const proposalId = crypto.randomUUID();
    await db.query(
      `insert into outing_options
        (id, outing_id, created_by_user_id, title, activity, starts_at,
         estimated_cost_cents, activity_tags, source)
       values ($1, $2, $3, 'Pending option', 'Dinner', '2026-12-02T02:00:00Z',
               1200, '["dinner"]', 'manual')`,
      [optionId, outingId, STARTER],
    );
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at)
       values ($1, $2, 1, $3, $4, 'Dinner', '2026-12-02T02:00:00Z', 1200,
               $5::jsonb, 'published', 'initial', now(), '2026-12-02T02:00:00Z')`,
      [proposalId, outingId, STARTER, optionId, JSON.stringify([STARTER])],
    );

    const sent = await sendMessage(ctx(agent), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm in if it's under $30.",
    });

    expect(sent.status).toBe(409);
    expect(sent.body.error).toBe("stale_reply");
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "pending",
      version: 0,
    });
    const proposal = await db.query<{ status: string }>(
      `select status from proposals where id = $1`, [proposalId],
    );
    expect(proposal[0]?.status).toBe("published");
    const messages = await savedMessages(outingId);
    expect(messages).toHaveLength(1);
  });

  it("does not let another admitted participant change the owner's interest", async () => {
    const agent = new FakeAgent((input) => input.history.at(-1)?.content === "I'm out."
      ? { text: "Noted.", interestUpdate: "not_interested" }
      : { text: "Let's plan it." });
    const outingId = await makeOuting(agent);
    await addParticipant(outingId, OTHER, "Other");

    const sent = await sendMessage(ctx(agent, OTHER), outingId, {
      clientMessageId: crypto.randomUUID(),
      content: "I'm out.",
    });

    expect(sent.status).toBe(200);
    await expect(participantState(outingId, OTHER)).resolves.toMatchObject({
      status: "not_interested",
    });
    await expect(participantState(outingId, STARTER)).resolves.toMatchObject({
      status: "interested",
    });
    const messages = await savedMessages(outingId);
    expect(messages).toHaveLength(2);
  });
});
