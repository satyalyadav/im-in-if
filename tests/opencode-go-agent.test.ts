import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, ACTIVE_GO_MODEL, createOpenCodeGoAgent } from "@/lib/agent";

type Captured = {
  body: Record<string, unknown>;
  userAgent: string | undefined;
  session: string | undefined;
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];

async function fakeGo(handler: Handler): Promise<{ baseURL: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captured.push({
        body: JSON.parse(body) as Record<string, unknown>,
        userAgent: Array.isArray(request.headers["user-agent"])
          ? request.headers["user-agent"][0]
          : request.headers["user-agent"],
        session: Array.isArray(request.headers["x-opencode-session"])
          ? request.headers["x-opencode-session"][0]
          : request.headers["x-opencode-session"],
      });
      handler(request, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, captured };
}

function completion(content: string, usage?: unknown): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: ACTIVE_GO_MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    ...(usage === undefined ? {} : { usage }),
  });
}

function agent(baseURL: string) {
  return createOpenCodeGoAgent({
    baseURL,
    apiKey: "synthetic-test-key",
    model: ACTIVE_GO_MODEL,
    timeoutMs: 5_000,
  });
}

function turnInput() {
  return {
    outing,
    history: [{ role: "user" as const, content: "Synthetic private input" }],
    currentConditions: null,
    conditionsReady: false,
    conditionsLocked: false,
    participants: [{ userId: "owner-user", displayName: "Owner" }],
    sessionId: "ses_synthetic-conversation-1",
  };
}

const outing = {
  suggestion: "Synthetic dinner plan",
  cutoffAt: "2026-11-01T02:30:00.000Z",
  cutoffTimeZone: "America/Phoenix",
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("OpenCode Go agent boundary", () => {
  it("pins DeepSeek, uses an honest app identity and stable session, and accepts explicit zero-cost metadata", async () => {
    const expected = {
      text: "Compare two synthetic times.",
      conditionUpdate: {
        hard: {
          availableWindows: [],
          maxCostCents: 1500,
          requiredActivityTags: [],
          avoidedActivityTags: [],
          attendanceDependencyNames: [],
          minimumGroupSize: 1,
        },
        flexiblePreferences: [],
        clarifyingQuestions: [],
      },
    };
    const { baseURL, captured } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion(JSON.stringify(expected), {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        opencode: { billing_source: "go" },
        cost: 0,
      }));
    });
    const result = await agent(baseURL).reply(turnInput());

    expect(result).toEqual(expected);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe("deepseek-v4.1-flash");
    expect(captured[0].session).toBe("ses_synthetic-conversation-1");
    expect(captured[0].userAgent).toBe("im-in-if/0.1.0");
    expect(JSON.stringify(captured[0].body)).toContain("Synthetic private input");
    expect(JSON.stringify(captured[0].body)).toContain("conditionUpdate");
  });

  it("sends the complete required condition-output schema in the captured request", async () => {
    const { baseURL, captured } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion(JSON.stringify({ text: "What time works?", conditionUpdate: null }), {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        opencode: { billing_source: "go" },
        cost: 0,
      }));
    });

    await agent(baseURL).reply(turnInput());
    const messages = captured[0].body.messages as Array<{ role?: string; content?: unknown }>;
    const prompt = String(messages.find((message) => message.role === "system")?.content ?? "");
    expect(prompt).toContain('"required":["text","conditionUpdate"]');
    expect(prompt).toContain('"minimumGroupSize":{"type":"integer","minimum":1,"maximum":20}');
    expect(prompt).toContain('"flexiblePreferences":{"type":"array","maxItems":12');
    expect(prompt).toContain('"clarifyingQuestions":{"type":"array","maxItems":4');
    expect(prompt).toContain('"startsAt":{"type":"string","format":"date-time"}');
    expect(prompt).toContain('"attendanceDependencyNames":[],"minimumGroupSize":1');
    expect(prompt).toContain("copy unchanged values from the current saved state");
  });

  it("fails closed when mandatory condition fields have malformed types", async () => {
    const malformed = {
      text: "I saved those conditions.",
      conditionUpdate: {
        hard: {
          availableWindows: [],
          maxCostCents: null,
          requiredActivityTags: [],
          avoidedActivityTags: [],
          attendanceDependencyNames: [],
          minimumGroupSize: "1",
        },
        flexiblePreferences: null,
        clarifyingQuestions: [],
      },
    };
    const { baseURL } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion(JSON.stringify(malformed), {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        opencode: { billing_source: "go" },
        cost: 0,
      }));
    });

    await expect(agent(baseURL).reply(turnInput()))
      .rejects.toMatchObject({ code: "invalid_output" } satisfies Partial<AgentError>);
  });

  it.each([
    ["missing usage", undefined],
    ["missing billing source", { cost: 0 }],
    ["missing cost", { opencode: { billing_source: "go" } }],
    ["paid billing source", { opencode: { billing_source: "payg" }, cost: 0 }],
    ["nonzero cost", { opencode: { billing_source: "go" }, cost: 0.0001 }],
    ["malformed cost", { opencode: { billing_source: "go" }, cost: "0" }],
    ["conflicting cost fields", { opencode: { billing_source: "go-plus" }, cost: 0, cost0: 1 }],
  ])("rejects successful responses with %s", async (_name, usage) => {
    const { baseURL } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion("Synthetic response", usage));
    });
    await expect(agent(baseURL).reply({ ...turnInput(), sessionId: "ses_synthetic-guard-check" }))
      .rejects.toMatchObject({ code: "usage_not_included" });
  });

  it("rejects malformed successful response bodies", async () => {
    const { baseURL } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
    });
    await expect(agent(baseURL).reply({ ...turnInput(), sessionId: "ses_synthetic-malformed-check" }))
      .rejects.toMatchObject({ code: "usage_not_included" } satisfies Partial<AgentError>);
  });
});
