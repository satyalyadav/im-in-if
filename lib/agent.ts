import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { z } from "zod";
import { formatZonedDateTime } from "@/lib/cutoff";
import {
  ConditionInterpretationSchema,
  OfferCandidateSchema,
  type CatalogOption,
  type ConditionInterpretation,
  type OfferCandidate,
  type PublicOffer,
  type PublicParticipant,
} from "@/lib/planning-types";

export type AgentErrorCode =
  | "timeout"
  | "model_error"
  | "empty_reply"
  | "invalid_output"
  | "usage_not_included"
  | "unavailable";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentError";
  }
}

export type AgentOutingContext = {
  suggestion: string;
  cutoffAt: string;
  cutoffTimeZone: string;
};

export type AgentTurnInput = {
  outing: AgentOutingContext;
  history: Array<{ role: "user" | "agent"; content: string }>;
  sessionId?: string;
};

export type ConditionInterpretationInput = {
  outing: AgentOutingContext;
  sessionId?: string;
  privateInput: string;
  participantUserId: string;
  participants: PublicParticipant[];
};

export type OfferGenerationInput = {
  outing: AgentOutingContext;
  sessionId?: string;
  participantUserId: string;
  privateInput: string;
  privateConditions: ConditionInterpretation;
  privateRankings: string[];
  options: CatalogOption[];
  participants: PublicParticipant[];
  approvedOffers: PublicOffer[];
  tieContext?: {
    optionIds: string[];
    everyoneAnsweredEither: boolean;
    selectedOptionId: string | null;
    participantUserIds: string[];
  };
};

export interface Agent {
  reply(input: AgentTurnInput): Promise<{ text: string }>;
  interpretConditions?(
    input: ConditionInterpretationInput,
  ): Promise<ConditionInterpretation>;
  generateOffer?(input: OfferGenerationInput): Promise<OfferCandidate>;
}

export type OpenCodeGoAgentConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export const ACTIVE_GO_MODEL = "deepseek-v4.1-flash";

const InterpretationSchema = ConditionInterpretationSchema;
const OfferSchema = OfferCandidateSchema;

function systemPrompt(input: AgentTurnInput): string {
  const cutoff = formatZonedDateTime(
    new Date(input.outing.cutoffAt),
    input.outing.cutoffTimeZone,
  );

  return [
    "You are one participant's private personal agent for one outing.",
    `The outing's initial suggestion: ${JSON.stringify(input.outing.suggestion)}`,
    `Response cutoff: ${cutoff}.`,
    "Help your owner think through their own conditions and next steps.",
    "Do not claim anyone else agreed. Do not commit for your owner.",
    "Keep replies concise and plain. Use plain text without Markdown headings or asterisks.",
  ].join("\n");
}

function isAbort(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    current = current.cause;
  }
  return false;
}

function findAgentError(error: unknown): AgentError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof AgentError) return current;
    current = current.cause;
  }
  return null;
}

function normalizedJson<T>(text: string, schema: z.ZodType<T>): T {
  let trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!trimmed) {
    throw new AgentError("empty_reply", "model returned no text");
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) trimmed = trimmed.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AgentError("invalid_output", "model returned invalid structured output", {
      cause: error,
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AgentError(
      "invalid_output",
      JSON.stringify(result.error.issues.map((issue) => issue.path.join("."))),
    );
  }
  return result.data;
}

type ProviderOptions = {
  name: string;
  config: OpenCodeGoAgentConfig;
  requiresSession: boolean;
  postResponseBillingGuard?: boolean;
};

const APP_USER_AGENT = "im-in-if/0.1.0";

function appIdentityFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  request.headers.set("User-Agent", APP_USER_AGENT);
  return fetch(request);
}

function goBillingGuardFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return appIdentityFetch(input, init).then(async (response) => {
    if (!response.ok) return response;

    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      throw new AgentError("usage_not_included", "provider billing metadata was missing");
    }

    if (!payload || typeof payload !== "object") {
      throw new AgentError("usage_not_included", "provider billing metadata was malformed");
    }
    const root = payload as {
      usage?: unknown;
    };
    if (!root.usage || typeof root.usage !== "object" || Array.isArray(root.usage)) {
      throw new AgentError("usage_not_included", "provider billing metadata was missing");
    }
    const usage = root.usage as {
      cost?: unknown;
      cost0?: unknown;
      opencode?: { billing_source?: unknown };
    };
    const billingSource = usage.opencode?.billing_source;
    const reportedCosts = [usage.cost, usage.cost0].filter((value) => value !== undefined);

    if (
      (billingSource !== "go" && billingSource !== "go-plus") ||
      reportedCosts.length === 0 ||
      reportedCosts.some(
        (cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost !== 0,
      )
    ) {
      throw new AgentError("usage_not_included", "provider did not confirm zero-cost Go usage");
    }
    return response;
  });
}

function createAgent(options: ProviderOptions): Agent {
  const { config } = options;
  const timeout = () => AbortSignal.timeout(config.timeoutMs);

  function modelFor(sessionId?: string) {
    if (options.requiresSession && !sessionId) {
      throw new AgentError("unavailable", "a stable provider session is required");
    }
    const headers = options.requiresSession
      ? {
          "User-Agent": "im-in-if/0.1.0",
          "x-opencode-session": sessionId as string,
        }
      : undefined;
    const provider = createOpenAICompatible({
      name: options.name,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      ...(headers ? { headers } : {}),
      ...(options.postResponseBillingGuard ? { fetch: goBillingGuardFetch } : {}),
    });
    return provider.chatModel(config.model);
  }

  async function generateStructured<T>(
    sessionId: string | undefined,
    schema: z.ZodType<T>,
    prompt: string,
  ): Promise<T> {
    try {
      const result = await generateText({
        model: modelFor(sessionId),
        output: Output.text(),
        prompt,
        abortSignal: timeout(),
        maxRetries: 0,
        maxOutputTokens: 4000,
      });
      return normalizedJson(result.text, schema);
    } catch (error) {
      const providerError = findAgentError(error);
      if (providerError) throw providerError;
      if (isAbort(error)) {
        throw new AgentError("timeout", "model request timed out", { cause: error });
      }
      throw new AgentError("model_error", "model request failed", { cause: error });
    }
  }

  return {
    async reply(input) {
      try {
        const result = await generateText({
          model: modelFor(input.sessionId),
          system: systemPrompt(input),
          messages: input.history.map((message) => ({
            role: message.role === "agent" ? "assistant" : "user",
            content: message.content,
          })),
          abortSignal: timeout(),
          maxRetries: 0,
        });

        const text = result.text.trim();
        if (!text) throw new AgentError("empty_reply");
        return { text };
      } catch (error) {
        const providerError = findAgentError(error);
        if (providerError) throw providerError;
        if (isAbort(error)) {
          throw new AgentError("timeout", "model request timed out", { cause: error });
        }
        throw new AgentError("model_error", "model request failed", { cause: error });
      }
    },

    async interpretConditions(input) {
      const prompt = [
        "Interpret only this participant's private planning input.",
        "Return one JSON object with exactly these fields: hard.availableWindows (start/end ISO timestamps), hard.maxCostCents (integer or null), hard.requiredActivityTags, hard.avoidedActivityTags, hard.attendanceDependencies (participant user IDs), hard.minimumGroupSize, flexiblePreferences, clarifyingQuestions.",
        "Treat a strict limit as hard only when the owner states it clearly. Put allowed tradeoffs in flexiblePreferences.",
        "Ask a short question for unclear amounts, times, strictness, or identity. Leave uncertain fields empty or null. Never infer attendance.",
        `Outing suggestion: ${JSON.stringify(input.outing.suggestion)}`,
        `Admitted people and their names: ${JSON.stringify(input.participants)}`,
        `Current participant ID: ${JSON.stringify(input.participantUserId)}`,
        `Private input: ${JSON.stringify(input.privateInput)}`,
      ].join("\n");
      return generateStructured(input.sessionId, InterpretationSchema, prompt);
    },

    async generateOffer(input) {
      const prompt = [
        "Create one tentative plan offer for your owner. This is not a confirmation.",
        "Return one JSON object with exactly these fields: optionId, activity, startsAt, estimatedCostCents, activityTags, attendeeUserIds, counterOfferToId (UUID or null), privateNote.",
        "Choose only a supplied catalog option and copy its activity, exact start time, cost, and tags. Include your owner in attendeeUserIds. Use only participants whose responseStatus is interested. Do not change strict conditions.",
        "Use only your owner's private conditions and rankings, the public catalog, participant names, resolved tie result, and approved shared offers below. A counterOfferToId must name a supplied shared offer owned by another participant, or be null. Do not disclose your privateNote to other people.",
        `Outing suggestion: ${JSON.stringify(input.outing.suggestion)}`,
        `Your user ID: ${JSON.stringify(input.participantUserId)}`,
        `Your private planning input: ${JSON.stringify(input.privateInput)}`,
        `Your private hard conditions and flexible preferences: ${JSON.stringify(input.privateConditions)}`,
        `Your private option rankings: ${JSON.stringify(input.privateRankings)}`,
        `Catalog options: ${JSON.stringify(input.options)}`,
        `Admitted interested participants: ${JSON.stringify(input.participants)}`,
        `Approved shared offers: ${JSON.stringify(input.approvedOffers)}`,
        `Resolved tie context: ${JSON.stringify(input.tieContext ?? null)}`,
        ...(input.tieContext
          ? [
              "A resolved tie is present. Include exactly the participants in tieContext.participantUserIds as attendeeUserIds, with no additions or omissions.",
              "Choose only the option fixed by the tie result: if selectedOptionId is set, use it; if everyone answered either, use one of tieContext.optionIds.",
            ]
          : []),
      ].join("\n");
      return generateStructured(input.sessionId, OfferSchema, prompt);
    },
  };
}

export function createOpenCodeGoAgent(config: OpenCodeGoAgentConfig): Agent {
  if (config.model !== ACTIVE_GO_MODEL) {
    throw new AgentError("unavailable", "the active demo model is pinned to DeepSeek V4.1 Flash");
  }
  return createAgent({
    name: "opencode-go",
    config,
    requiresSession: true,
    postResponseBillingGuard: true,
  });
}

function configuredTimeout(envName: string, fallback: number): number {
  const value = Number(process.env[envName] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getAgent(): Agent {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) throw new AgentError("unavailable", "OPENCODE_GO_API_KEY is not configured");
  const configuredModel = process.env.OPENCODE_GO_MODEL;
  if (configuredModel && configuredModel !== ACTIVE_GO_MODEL) {
    throw new AgentError("unavailable", "the configured model does not match the active demo model");
  }
  return createOpenCodeGoAgent({
    baseURL:
      process.env.OPENCODE_GO_BASE_URL ??
      "https://opencode.ai/inference/go/openai/v1",
    apiKey,
    model: ACTIVE_GO_MODEL,
    timeoutMs: configuredTimeout("OPENCODE_GO_REQUEST_TIMEOUT_MS", 60_000),
  });
}
