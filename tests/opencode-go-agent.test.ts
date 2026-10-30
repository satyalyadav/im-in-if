import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { APICallError } from "ai";
import {
  AgentError,
  ACTIVE_GO_MODEL,
  createOpenCodeGoAgent,
  getSafeAgentFailureDiagnostic,
  type AgentTurnInput,
  type OfferGenerationInput,
} from "@/lib/agent";
import { validateCandidate } from "@/lib/planning";
import {
  emptyConditionInterpretation,
  type CatalogOption,
} from "@/lib/planning-types";

type Captured = {
  body: Record<string, unknown>;
  method: string | undefined;
  path: string | undefined;
  userAgent: string | undefined;
  session: string | undefined;
};

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
) => void;
const servers: Server[] = [];

async function fakeGo(handler: Handler): Promise<{ baseURL: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsedBody = JSON.parse(body) as Record<string, unknown>;
      captured.push({
        body: parsedBody,
        method: request.method,
        path: request.url,
        userAgent: Array.isArray(request.headers["user-agent"])
          ? request.headers["user-agent"][0]
          : request.headers["user-agent"],
        session: Array.isArray(request.headers["x-opencode-session"])
          ? request.headers["x-opencode-session"][0]
          : request.headers["x-opencode-session"],
      });
      handler(request, response, parsedBody);
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

const OFFER_TOOL_NAME = "private_plan_offer";
const OFFER_SESSION = "ses_synthetic-maya-offer";

function existingOptionToolInput(optionId: string) {
  return {
    kind: "existing_option",
    optionId,
    option: null,
    attendeeUserIds: ["maya-user"],
    counterOfferToId: null,
    privateNote: "Synthetic private offer note.",
    question: null,
  };
}

function offerRequestIsForced(
  request: IncomingMessage,
  body: Record<string, unknown>,
  expectedSession = OFFER_SESSION,
): boolean {
  const toolChoice = body.tool_choice as { type?: string; function?: { name?: string } } | undefined;
  const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
  const sessionHeader = request.headers["x-opencode-session"];
  const session = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  return body.model === ACTIVE_GO_MODEL &&
    (body.thinking as { type?: string } | undefined)?.type === "disabled" &&
    session === expectedSession &&
    toolChoice?.type === "function" && toolChoice.function?.name === OFFER_TOOL_NAME &&
    tools?.length === 1 && tools[0].function?.name === OFFER_TOOL_NAME;
}

function respondIfOfferToolIsForced(
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
  responseBody: string,
  expectedSession = OFFER_SESSION,
): void {
  if (!offerRequestIsForced(request, body, expectedSession)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "expected forced typed offer tool request" } }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(responseBody);
}

function expectForcedOfferRequest(captured: Captured, expectedSession = OFFER_SESSION): void {
  expect(captured).toMatchObject({
    session: expectedSession,
    body: {
      model: ACTIVE_GO_MODEL,
      thinking: { type: "disabled" },
      tool_choice: { type: "function", function: { name: OFFER_TOOL_NAME } },
      tools: [{ type: "function", function: { name: OFFER_TOOL_NAME } }],
    },
  });
  const tools = captured.body.tools as Array<{
    function: { parameters: { required: string[]; additionalProperties: boolean } };
  }>;
  expect(tools[0].function.parameters.required).toEqual([
    "kind", "optionId", "option", "attendeeUserIds", "counterOfferToId", "privateNote", "question",
  ]);
  expect(tools[0].function.parameters.additionalProperties).toBe(false);
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

function offerInput(options: CatalogOption[]): OfferGenerationInput {
  const privateConditions = emptyConditionInterpretation();
  privateConditions.hard.availableWindows = [{
    startsAt: "2026-10-28T02:01:00.000Z",
    endsAt: "2026-10-28T06:00:00.000Z",
  }];
  privateConditions.hard.maxCostCents = 1500;
  privateConditions.hard.requiredActivityTags = ["movie"];
  privateConditions.hard.avoidedActivityTags = ["comedy"];
  return {
    outing,
    sessionId: "ses_synthetic-maya-offer",
    participantUserId: "maya-user",
    privateInput: "Synthetic Maya private input",
    privateConditions,
    recentConversation: [],
    privateRankings: [],
    options,
    participants: [
      { userId: "maya-user", displayName: "Maya" },
      { userId: "sam-user", displayName: "Sam" },
    ],
    approvedOffers: [],
  };
}

function catalogOption(
  id: string,
  startsAt: string,
  estimatedCostCents: number,
  activityTags = ["movie"],
): CatalogOption {
  return {
    id,
    title: `Synthetic option ${id}`,
    activity: "Movie",
    startsAt,
    estimatedCostCents,
    activityTags,
    source: "manual",
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
      category: "upstream_error",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(privateValue);
  });

  it.each([
    ["missing_session", 400, { error: { code: "session_not_found", message: "Session not found" } }],
    ["tool_choice_or_schema", 400, { error: { code: "unsupported_tool_choice", message: "tool_choice is unsupported" } }],
    ["invalid_request_parameters", 400, { error: { type: "invalid_request_error", message: "Invalid parameter" } }],
    ["context_length", 400, { error: { code: "context_length_exceeded", message: "Maximum context length exceeded" } }],
    ["authentication", 401, { error: { code: "unauthorized", message: "Invalid API key" } }],
    ["rate_or_usage_limit", 429, { error: { code: "insufficient_quota", message: "Usage limit exceeded" } }],
    ["upstream_error", 502, { error: { message: "Gateway failure" } }],
    ["unknown", 404, { error: { message: "Provider returned an unclassified failure" } }],
  ] as const)("categorizes provider failures as %s without exposing provider text", (category, statusCode, body) => {
    const privateValue = "PRIVATE-RESPONSE-BODY";
    const responseBody = JSON.stringify({
      ...body,
      privateText: privateValue,
      userId: "owner-user-id",
      sessionId: "ses-private-session",
    });
    const diagnostic = getSafeAgentFailureDiagnostic(new APICallError({
      message: `${privateValue} owner-user-id ses-private-session`,
      url: `https://provider.invalid/${privateValue}`,
      requestBodyValues: { prompt: "PRIVATE-PROMPT" },
      responseHeaders: { authorization: "PRIVATE-SECRET" },
      responseBody,
      statusCode,
      isRetryable: false,
    }));

    expect(diagnostic).toEqual({
      errorClass: "APICallError",
      statusCode,
      retryable: false,
      category,
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain("PRIVATE-PROMPT");
    expect(serialized).not.toContain("PRIVATE-SECRET");
    expect(serialized).not.toContain("owner-user-id");
    expect(serialized).not.toContain("ses-private-session");
  });

  it("disables DeepSeek thinking before sending the forced typed reply tool", async () => {
    const expected = { text: "What time works?", conditionUpdate: null };
    const { baseURL, captured } = await fakeGo((_request, response, body) => {
      const thinking = body.thinking as { type?: string } | undefined;
      if (body.tool_choice && thinking?.type !== "disabled") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "tool_choice requires disabled thinking" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(toolCallCompletion([call("call-1", expected)], goUsage()));
    });

    const result = await agent(baseURL).reply(turnInput());

    expect(result).toEqual(expected);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
      session: "ses_synthetic-conversation-1",
      body: {
        model: ACTIVE_GO_MODEL,
        thinking: { type: "disabled" },
        tool_choice: {
          type: "function",
          function: { name: "private_plan_reply" },
        },
      },
    });
  });

  it("offers only catalog options that fit the owner's hard option conditions", async () => {
    const options = [
      catalogOption("00000000-0000-4000-8000-000000000007", "2026-10-28T02:00:00.000Z", 900),
      catalogOption("00000000-0000-4000-8000-000000000008", "2026-10-28T03:00:00.000Z", 1200),
      catalogOption("00000000-0000-4000-8000-000000000009", "2026-10-28T04:00:00.000Z", 1600),
      catalogOption("00000000-0000-4000-8000-000000000010", "2026-10-28T05:00:00.000Z", 1200, ["movie", "comedy"]),
      catalogOption("00000000-0000-4000-8000-000000000011", "2026-10-28T05:00:00.000Z", 1200, ["live"]),
    ];
    const { baseURL, captured } = await fakeGo((request, response, body) => {
      const messages = body.messages as Array<{ role?: string; content?: unknown }>;
      const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
      const catalogLine = prompt.split("\n").find((line) => line.startsWith("Catalog options: "));
      const supplied = JSON.parse(catalogLine?.slice("Catalog options: ".length) ?? "[]") as CatalogOption[];
      const selected = supplied[0];
      if (!selected) throw new Error("mock provider received no catalog options");
      respondIfOfferToolIsForced(
        request,
        response,
        body,
        toolCallCompletion([
          call("offer-call-1", existingOptionToolInput(selected.id), OFFER_TOOL_NAME),
        ], goUsage()),
      );
    });
    const provider = agent(baseURL);
    const input = offerInput(options);
    if (!provider.generateOffer) throw new Error("offer generation is unavailable");

    const candidate = await provider.generateOffer(input);

    expect(captured).toHaveLength(1);
    expectForcedOfferRequest(captured[0]);
    const messages = captured[0].body.messages as Array<{ role?: string; content?: unknown }>;
    const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
    expect(prompt).not.toContain(options[0].id);
    expect(prompt).toContain(options[1].id);
    expect(prompt).not.toContain(options[2].id);
    expect(prompt).not.toContain(options[3].id);
    expect(prompt).not.toContain(options[4].id);
    expect(prompt).toContain('"startsAt":"2026-10-28T03:00:00.000Z"');
    expect(prompt).toContain('"startsAtLocal":"Oct 27, 2026, 8:00 PM MST"');
    expect(prompt).toContain('"timeZone":"America/Phoenix"');
    expect(prompt).toContain("has already passed your owner's hard availability, budget, and activity-tag checks");
    if (!("optionId" in candidate)) throw new Error("expected an existing-option offer");
    expect(candidate.optionId).toBe(options[1].id);
    expect(validateCandidate(
      candidate,
      "maya-user",
      options[1],
      [{ userId: "maya-user", admissionStatus: "admitted", responseStatus: "interested" }],
      [{ userId: "maya-user", interpretation: input.privateConditions, interpretationReady: true }],
    )).toEqual({ ok: true });
  });

  it("asks for a focused clarification when no catalog option fits", async () => {
    const options = [
      catalogOption("00000000-0000-4000-8000-000000000007", "2026-10-28T02:00:00.000Z", 900),
      catalogOption("00000000-0000-4000-8000-000000000009", "2026-10-28T04:00:00.000Z", 1600),
      catalogOption("00000000-0000-4000-8000-000000000010", "2026-10-28T05:00:00.000Z", 1200, ["movie", "comedy"]),
      { ...catalogOption("00000000-0000-4000-8000-000000000012", "2026-10-28T02:30:00.000Z", 900), source: "sample" as const },
    ];
    const { baseURL, captured } = await fakeGo((request, response, body) => {
      const messages = body.messages as Array<{ role?: string; content?: unknown }>;
      const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
      expect(prompt).toContain("Catalog options: []");
      respondIfOfferToolIsForced(request, response, body, toolCallCompletion([
        call("offer-call-1", {
          kind: "clarification",
          optionId: null,
          option: null,
          attendeeUserIds: [],
          counterOfferToId: null,
          privateNote: "",
          question: "Which date and time should I use for dinner?",
        }, OFFER_TOOL_NAME),
      ], goUsage()));
    });
    const provider = agent(baseURL);
    if (!provider.generateOffer) throw new Error("offer generation is unavailable");

    await expect(provider.generateOffer(offerInput(options))).resolves.toEqual({
      kind: "clarification",
      question: "Which date and time should I use for dinner?",
    });
    expect(captured).toHaveLength(1);
    expectForcedOfferRequest(captured[0]);
  });

  it("does not present UTC catalog times as local when the outing has no time zone", async () => {
    const options = [catalogOption(
      "00000000-0000-4000-8000-000000000007",
      "2026-10-28T03:00:00.000Z",
      900,
    )];
    const { baseURL, captured } = await fakeGo((request, response, body) => {
      respondIfOfferToolIsForced(request, response, body, toolCallCompletion([
        call("offer-call-1", {
          kind: "clarification",
          optionId: null,
          option: null,
          attendeeUserIds: [],
          counterOfferToId: null,
          privateNote: "",
          question: "Which time zone should I use?",
        }, OFFER_TOOL_NAME),
      ], goUsage()));
    });
    const provider = agent(baseURL);
    if (!provider.generateOffer) throw new Error("offer generation is unavailable");

    await expect(provider.generateOffer({
      ...offerInput(options),
      outing: { ...outing, cutoffAt: null, cutoffTimeZone: null },
    })).resolves.toEqual({ kind: "clarification", question: "Which time zone should I use?" });
    expect(captured).toHaveLength(1);
    const messages = captured[0].body.messages as Array<{ role?: string; content?: unknown }>;
    const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
    const catalogLine = prompt.split("\n").find((line) => line.startsWith("Catalog options: "));
    const supplied = JSON.parse(catalogLine?.slice("Catalog options: ".length) ?? "[]") as Array<Record<string, unknown>>;
    expect(prompt).toContain("No outing time zone is set.");
    expect(prompt).toContain("Do not treat an option's ISO timestamp as the owner's local time");
    expect(supplied).toHaveLength(1);
    expect(supplied[0]).not.toHaveProperty("startsAtLocal");
    expect(supplied[0]).not.toHaveProperty("timeZone");
  });

  it("drafts a relevant option from private details when the public catalog is empty", async () => {
    const { baseURL, captured } = await fakeGo((request, response, body) => {
      const messages = body.messages as Array<{ role?: string; content?: unknown }>;
      const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
      expect(prompt).toContain('Outing suggestion: "Sushi Friday"');
      expect(prompt).toContain("Synthetic Maya private input");
      expect(prompt).toContain("Owner availability windows:");
      expect(prompt).toContain("A new option's estimatedCostCents is a generic per-person estimate");
      expect(prompt).toContain("Do not claim live restaurant availability, a booking, or a reservation.");
      expect(prompt).toContain("Use a supplied public catalog option only when its activity fits the outing suggestion and the owner's private input and preferences, as well as the hard conditions.");
      expect(prompt).toContain("Otherwise draft a relevant generic option or ask one focused clarification.");
      expect(prompt).toContain("Follow the owner's latest explicit user messages about activity and venue over older user messages and the initial suggestion.");
      expect(prompt).toContain("Treat only the current structured condition state above as hard limits; chat does not create or relax hard limits without the existing owner condition-update flow.");
      expect(prompt).toContain('Recent private owner conversation: [{"role":"user","content":"Use Kiku House near Central."}]');
      respondIfOfferToolIsForced(request, response, body, toolCallCompletion([
        call("offer-call-1", {
          kind: "new_option",
          optionId: null,
          option: {
            title: "Sushi dinner",
            activity: "Sushi dinner",
            startsAt: "2026-11-07T03:00:00.000Z",
            estimatedCostCents: 4500,
            activityTags: ["sushi", "dinner"],
          },
          attendeeUserIds: ["maya-user"],
          counterOfferToId: null,
          privateNote: "Generic per-person estimate.",
          question: null,
        }, OFFER_TOOL_NAME),
      ], goUsage()));
    });
    const provider = agent(baseURL);
    if (!provider.generateOffer) throw new Error("offer generation is unavailable");
    const input = offerInput([]);
    input.outing = { ...outing, suggestion: "Sushi Friday", cutoffAt: "2026-11-01T02:30:00.000Z" };
    input.privateConditions.hard.availableWindows = [{
      startsAt: "2026-11-07T02:00:00.000Z",
      endsAt: "2026-11-07T04:00:00.000Z",
    }];
    input.privateConditions.hard.maxCostCents = 6000;
    input.privateConditions.hard.requiredActivityTags = [];
    input.recentConversation = [{ role: "user", content: "Use Kiku House near Central." }];

    const candidate = await provider.generateOffer(input);

    expect(candidate).toMatchObject({ kind: "new_option", option: { activity: "Sushi dinner" } });
    expect(captured).toHaveLength(1);
    expectForcedOfferRequest(captured[0]);
  });

  it.each([
    ["missing tool call", () => completion("Synthetic response", goUsage())],
    ["wrong tool name", () => toolCallCompletion([
      call("offer-call-1", existingOptionToolInput("00000000-0000-4000-8000-000000000014"), "private_plan_reply"),
    ], goUsage())],
    ["multiple tool calls", () => toolCallCompletion([
      call("offer-call-1", existingOptionToolInput("00000000-0000-4000-8000-000000000014"), OFFER_TOOL_NAME),
      call("offer-call-2", existingOptionToolInput("00000000-0000-4000-8000-000000000014"), OFFER_TOOL_NAME),
    ], goUsage())],
    ["branch-inconsistent output", () => toolCallCompletion([
      call("offer-call-1", {
        ...existingOptionToolInput("00000000-0000-4000-8000-000000000014"),
        optionId: null,
      }, OFFER_TOOL_NAME),
    ], goUsage())],
  ])("rejects offer generation with a %s", async (_case, responseBody) => {
    const { baseURL, captured } = await fakeGo((request, response, body) => {
      respondIfOfferToolIsForced(request, response, body, responseBody());
    });
    const provider = agent(baseURL);
    if (!provider.generateOffer) throw new Error("offer generation is unavailable");
    const options = [catalogOption(
      "00000000-0000-4000-8000-000000000014",
      "2026-10-28T03:00:00.000Z",
      900,
    )];

    await expect(provider.generateOffer(offerInput(options)))
      .rejects.toMatchObject({ code: "invalid_output" } satisfies Partial<AgentError>);
    expect(captured).toHaveLength(1);
    expectForcedOfferRequest(captured[0]);
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

  it("asks before interpreting dates when an outing has no cutoff or time zone", async () => {
    const { baseURL, captured } = await fakeGo((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(toolCallCompletion([
        call("call-1", { text: "What time zone should I use?", conditionUpdate: null }),
      ], goUsage()));
    });
    const input: AgentTurnInput = {
      ...turnInput(),
      outing: { ...outing, cutoffAt: null, cutoffTimeZone: null },
    };

    await agent(baseURL).reply(input);

    const messages = captured[0].body.messages as Array<{ role?: string; content?: unknown }>;
    const prompt = String(messages.find((message) => message.role === "system")?.content ?? "");
    expect(prompt).toContain("No response cutoff has been set.");
    expect(prompt).toContain("If no outing time zone is set, ask for one");
    expect(prompt).not.toContain("Invalid Date");
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
