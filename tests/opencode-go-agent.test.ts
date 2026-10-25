import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { APICallError } from "ai";
import {
  AgentError,
  ACTIVE_GO_MODEL,
  createOpenCodeGoAgent,
  getSafeAgentFailureDiagnostic,
} from "@/lib/agent";

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

function toolCallCompletion(
  calls: Array<{ id: string; name: string; arguments: unknown }>,
  usage?: unknown,
): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: ACTIVE_GO_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  });
}

function goUsage() {
  return {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    opencode: { billing_source: "go" },
    cost: 0,
  };
}

function call(id: string, argumentsValue: unknown, name = "private_plan_reply") {
  return { id, name, arguments: argumentsValue };
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
  it("extracts only allowlisted HTTP status details from a wrapped SDK error", () => {
    const privateValue = "PRIVATE-CAP-15-AND-SECRET";
    const apiError = new APICallError({
      message: privateValue,
      url: `https://provider.invalid/${privateValue}`,
      requestBodyValues: { prompt: privateValue },
      responseHeaders: { authorization: privateValue },
      responseBody: privateValue,
      statusCode: 503,
      isRetryable: true,
    });
    const error = new AgentError("model_error", "model request failed", { cause: apiError });

    const diagnostic = getSafeAgentFailureDiagnostic(error);

    expect(diagnostic).toEqual({
      errorClass: "APICallError",
      statusCode: 503,
      retryable: true,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(privateValue);
  });

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
      response.end(toolCallCompletion([call("call-1", expected)], goUsage()));
    });
    const result = await agent(baseURL).reply(turnInput());

    expect(result).toEqual(expected);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe("deepseek-v4.1-flash");
    expect(captured[0].session).toBe("ses_synthetic-conversation-1");
    expect(captured[0].userAgent).toBe("im-in-if/0.1.0");
    expect(JSON.stringify(captured[0].body)).toContain("Synthetic private input");
    const tools = captured[0].body.tools as Array<{
      type: string;
      function: {
        name: string;
        parameters: {
          type?: string;
          required?: string[];
          additionalProperties?: boolean;
          properties?: Record<string, unknown>;
          anyOf?: Array<Record<string, unknown>>;
        };
      };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("private_plan_reply");
    expect(captured[0].body.tool_choice).toEqual({
      type: "function",
      function: { name: "private_plan_reply" },
    });
    const parameters = tools[0].function.parameters;
    expect(parameters).toMatchObject({
      type: "object",
      required: ["text", "conditionUpdate"],
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        conditionUpdate: { anyOf: expect.any(Array) },
      },
    });
    const update = parameters.properties?.conditionUpdate as {
      anyOf?: Array<{
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
      }>;
    };
    const updateObject = update.anyOf?.find((schema) => schema.type === "object");
    expect(updateObject?.required).toEqual(["hard", "flexiblePreferences", "clarifyingQuestions"]);
    const updateProperties = updateObject?.properties;
    expect(updateProperties).toEqual(expect.objectContaining({
      hard: expect.any(Object),
      flexiblePreferences: expect.any(Object),
      clarifyingQuestions: expect.any(Object),
    }));
    const hard = updateProperties?.hard as {
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    expect(hard.required).toEqual([
      "availableWindows", "maxCostCents", "requiredActivityTags", "avoidedActivityTags",
      "attendanceDependencyNames", "minimumGroupSize",
    ]);
    expect(hard.properties?.minimumGroupSize?.type).toBe("integer");
  });

  it("sends the reply schema through one forced tool and keeps behavioral guidance concise", async () => {
    const { baseURL, captured } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(toolCallCompletion([
        call("call-1", { text: "What time works?", conditionUpdate: null }),
      ], goUsage()));
    });

    await agent(baseURL).reply(turnInput());
    expect(captured).toHaveLength(1);
    expect(captured[0].body.tools).toHaveLength(1);
    expect(captured[0].body.tool_choice).toEqual({
      type: "function",
      function: { name: "private_plan_reply" },
    });
    const messages = captured[0].body.messages as Array<{ role?: string; content?: unknown }>;
    const prompt = String(messages.find((message) => message.role === "system")?.content ?? "");
    expect(prompt).toContain("Call private_plan_reply exactly once on every turn");
    expect(prompt).not.toContain("additionalProperties");
    expect(prompt).not.toContain('"minimumGroupSize":{"type"');
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
      response.end(toolCallCompletion([call("call-1", malformed)], goUsage()));
    });

    await expect(agent(baseURL).reply(turnInput()))
      .rejects.toMatchObject({ code: "invalid_output" } satisfies Partial<AgentError>);
  });

  it.each([
    ["missing tool call", () => completion("Synthetic response", goUsage())],
    ["wrong tool name", () => toolCallCompletion([
      call("call-1", { text: "Synthetic", conditionUpdate: null }, "other_tool"),
    ], goUsage())],
    ["multiple tool calls", () => toolCallCompletion([
      call("call-1", { text: "First", conditionUpdate: null }),
      call("call-2", { text: "Second", conditionUpdate: null }),
    ], goUsage())],
  ])("rejects a %s without a database-ready reply", async (_case, responseBody) => {
    const { baseURL, captured } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseBody());
    });

    await expect(agent(baseURL).reply(turnInput()))
      .rejects.toMatchObject({ code: "invalid_output" } satisfies Partial<AgentError>);
    expect(captured).toHaveLength(1);
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
