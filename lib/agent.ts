import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  generateText,
  InvalidToolInputError,
  RetryError,
  ToolChoiceViolationError,
  tool,
} from "ai";
import { z } from "zod";
import { formatZonedDateTime } from "@/lib/cutoff";
import { optionMeetsHardOptionConditions } from "@/lib/planning";
import {
  ConditionInterpretationSchema,
  NewOfferOptionSchema,
  OfferCandidateSchema,
  OfferGenerationResultSchema,
  type CatalogOption,
  type ConditionInterpretation,
  type OfferGenerationResult,
  type PublicOffer,
  type PublicParticipant,
} from "@/lib/planning-types";

export type AgentErrorCode =
  | "timeout"
  | "model_error"
  | "empty_reply"
  | "invalid_output"
  | "usage_not_included"
  | "unavailable"
  | "no_feasible_options";

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
  cutoffAt: string | null;
  cutoffTimeZone: string | null;
};

export type ParticipantResponseStatus =
  | "pending"
  | "interested"
  | "not_interested"
  | "no_response";

export type AgentTurnInput = {
  outing: AgentOutingContext;
  history: Array<{ role: "user" | "agent"; content: string }>;
  currentConditions: ConditionInterpretation | null;
  conditionsReady: boolean;
  conditionsLocked: boolean;
  responseStatus: ParticipantResponseStatus;
  participants: PublicParticipant[];
  sessionId?: string;
};

export type PrivateConversationMessage = {
  role: "user" | "agent";
  content: string;
};

const AgentConditionUpdateSchema = z.object({
  hard: z.object({
    availableWindows: ConditionInterpretationSchema.shape.hard.shape.availableWindows,
    maxCostCents: ConditionInterpretationSchema.shape.hard.shape.maxCostCents,
    requiredActivityTags: ConditionInterpretationSchema.shape.hard.shape.requiredActivityTags,
    avoidedActivityTags: ConditionInterpretationSchema.shape.hard.shape.avoidedActivityTags,
    attendanceDependencyNames: z.array(z.string().trim().min(1).max(128)).max(20),
    minimumGroupSize: ConditionInterpretationSchema.shape.hard.shape.minimumGroupSize,
  }).strict(),
  flexiblePreferences: ConditionInterpretationSchema.shape.flexiblePreferences,
  clarifyingQuestions: ConditionInterpretationSchema.shape.clarifyingQuestions,
}).strict();

export type AgentConditionUpdate = z.infer<typeof AgentConditionUpdateSchema>;

const AgentReplySchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  interestUpdate: z.enum(["interested", "not_interested"]).nullable(),
  conditionUpdate: AgentConditionUpdateSchema.nullable(),
}).strict();

const PrivatePlanOfferToolSchema = z.object({
  kind: z.enum(["existing_option", "new_option", "clarification"]),
  optionId: z.string().uuid().nullable(),
  option: NewOfferOptionSchema.nullable(),
  attendeeUserIds: z.array(z.string().min(1).max(128)).max(20),
  counterOfferToId: z.string().uuid().nullable(),
  privateNote: z.string().trim().max(1_000),
  question: z.string().trim().min(1).max(400).nullable(),
}).strict();

export type AgentReply = {
  text: string;
  interestUpdate?: "interested" | "not_interested" | null;
  conditionUpdate?: AgentConditionUpdate | null;
};

type PrivatePlanOfferToolReply = z.infer<typeof PrivatePlanOfferToolSchema>;

export type OfferGenerationInput = {
  outing: AgentOutingContext;
  sessionId?: string;
  participantUserId: string;
  privateInput: string;
  privateConditions: ConditionInterpretation;
  recentConversation: PrivateConversationMessage[];
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

function invalidOfferToolOutput(): AgentError {
  return new AgentError("invalid_output", "model returned invalid structured output");
}

function normalizeOfferToolReply(
  input: unknown,
  compatibleOptions: CatalogOption[],
): OfferGenerationResult {
  const parsed = PrivatePlanOfferToolSchema.safeParse(input);
  if (!parsed.success) throw invalidOfferToolOutput();
  const reply: PrivatePlanOfferToolReply = parsed.data;

  if (reply.kind === "existing_option") {
    if (
      !reply.optionId || reply.option !== null || reply.question !== null ||
      reply.attendeeUserIds.length === 0
    ) throw invalidOfferToolOutput();
    const option = compatibleOptions.find((candidate) => candidate.id === reply.optionId);
    if (!option) throw invalidOfferToolOutput();
    const candidate = OfferCandidateSchema.safeParse({
      optionId: option.id,
      activity: option.activity,
      startsAt: option.startsAt,
      estimatedCostCents: option.estimatedCostCents,
      activityTags: option.activityTags,
      attendeeUserIds: reply.attendeeUserIds,
      counterOfferToId: reply.counterOfferToId,
      privateNote: reply.privateNote,
    });
    if (!candidate.success) throw invalidOfferToolOutput();
    return candidate.data;
  }

  if (reply.kind === "new_option") {
    if (
      reply.optionId !== null || !reply.option || reply.question !== null ||
      reply.attendeeUserIds.length === 0
    ) throw invalidOfferToolOutput();
    const result = OfferGenerationResultSchema.safeParse({
      kind: "new_option",
      option: reply.option,
      attendeeUserIds: reply.attendeeUserIds,
      counterOfferToId: reply.counterOfferToId,
      privateNote: reply.privateNote,
    });
    if (!result.success) throw invalidOfferToolOutput();
    return result.data;
  }

  if (
    reply.optionId !== null || reply.option !== null || reply.attendeeUserIds.length !== 0 ||
    reply.counterOfferToId !== null || reply.privateNote !== "" || !reply.question
  ) throw invalidOfferToolOutput();
  return { kind: "clarification", question: reply.question };
}

export interface Agent {
  readonly requestTimeoutMs?: number;
  reply(input: AgentTurnInput): Promise<AgentReply>;
  generateOffer?(input: OfferGenerationInput): Promise<OfferGenerationResult>;
}

export type OpenCodeGoAgentConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export const ACTIVE_GO_MODEL = "deepseek-v4.1-flash";

function systemPrompt(input: AgentTurnInput): string {
  const cutoff = input.outing.cutoffAt && input.outing.cutoffTimeZone
    ? formatZonedDateTime(new Date(input.outing.cutoffAt), input.outing.cutoffTimeZone)
    : null;

  return [
    "You are one participant's private personal agent for one outing.",
    `The outing's initial suggestion: ${JSON.stringify(input.outing.suggestion)}`,
    cutoff ? `Response cutoff: ${cutoff}.` : "No response cutoff has been set.",
    "Gather and maintain only your owner's conditions in this private conversation.",
    "Use only the owner's messages, the current condition state below, and the admitted public roster below.",
    "Call private_plan_reply exactly once on every turn, including clarifications and turns with no condition changes. Put the concise natural-language reply in text and the complete current condition state in conditionUpdate, or null only when this message adds or corrects no condition.",
    "Set interestUpdate to 'interested' or 'not_interested' only when the owner's latest message is a clear first-person statement that records or withdraws interest in this outing. Conditional interest such as 'I am in if it is under $30' records both interest and the condition in the same turn. A question about options, a maybe, a thanks, or a statement about someone else's plans must leave interestUpdate null.",
    "Interest is not approval, attendance, or confirmation, and a condition update alone is not interest. Never say interest was recorded unless interestUpdate carries it. Never approve a proposal from an interest statement.",
    "If you ask a clarifying question about a condition, leave interestUpdate null and say the interest is not recorded yet.",
    "When the owner is on the confirmed plan, do not change interest. Explain that a confirmed plan change goes through the existing request to leave the roster. When the response cutoff has passed, do not change interest.",
    "When returning a condition update, include every field and copy unchanged values from the current saved state. Keep empty list fields as empty lists and keep a missing spending cap as null.",
    "Preserve every saved hard condition across turns. Never weaken or remove one unless the owner explicitly asks for that change. A generic thanks, off-topic message, or answer that does not resolve the question must not change conditions or count as confirmation.",
    "Treat only limits the owner states as required as hard. Put ordinary likes and tradeoffs in flexiblePreferences.",
    "Ask one focused question when the amount, date, time, strictness, or person is unclear. Do not guess missing dates or time zones. If no outing time zone is set, ask for one before interpreting relative dates or local clock times. Keep unresolved questions in clarifyingQuestions and leave the related condition unchanged.",
    "For attendance dependencies, use exact admitted display names from the roster. Ask who the owner means when a name is unknown or ambiguous. Never use the owner's own name as an attendance dependency.",
    "A condition update is not interest, attendance, agreement, or approval. Never claim anyone agreed or commit for your owner.",
    `Current condition state, with attendance dependencies shown as names: ${JSON.stringify(promptConditions(input))}`,
    `Current conditions are ${input.conditionsReady ? "ready" : "not yet ready"}.`,
    `The owner's saved interest response is ${JSON.stringify(input.responseStatus)}.`,
    `The owner has ${input.conditionsLocked ? "confirmed a plan, so conditions are locked" : "not confirmed a plan with locked conditions"}.`,
    `Admitted people: ${JSON.stringify(input.participants.map((participant) => participant.displayName))}`,
    "Keep replies concise and plain. Use no Markdown headings or asterisks.",
  ].join("\n");
}

function promptConditions(input: AgentTurnInput): unknown {
  if (!input.currentConditions) return null;
  const names = new Map(input.participants.map((person) => [person.userId, person.displayName]));
  return {
    hard: {
      availableWindows: input.currentConditions.hard.availableWindows,
      maxCostCents: input.currentConditions.hard.maxCostCents,
      requiredActivityTags: input.currentConditions.hard.requiredActivityTags,
      avoidedActivityTags: input.currentConditions.hard.avoidedActivityTags,
      attendanceDependencyNames: input.currentConditions.hard.attendanceDependencies.map(
        (userId) => names.get(userId) ?? "unknown admitted person",
      ),
      minimumGroupSize: input.currentConditions.hard.minimumGroupSize,
    },
    flexiblePreferences: input.currentConditions.flexiblePreferences,
    clarifyingQuestions: input.currentConditions.clarifyingQuestions,
  };
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

function isInvalidToolReply(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (
      InvalidToolInputError.isInstance(current) ||
      ToolChoiceViolationError.isInstance(current)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export type SafeAgentFailureDiagnostic = {
  errorClass:
    | "APICallError"
    | "RetryError"
    | "InvalidToolInputError"
    | "ToolChoiceViolationError"
    | "AgentError"
    | "UnknownError";
  statusCode?: number;
  retryable?: boolean;
  category?: SafeAgentFailureCategory;
};

export type SafeAgentFailureCategory =
  | "missing_session"
  | "tool_choice_or_schema"
  | "invalid_request_parameters"
  | "context_length"
  | "authentication"
  | "rate_or_usage_limit"
  | "upstream_error"
  | "unknown";

function providerErrorFields(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string") return [value.slice(0, 2048)];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.slice(0, 10).flatMap((item) => providerErrorFields(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of ["code", "type", "message", "param"]) {
    if (typeof record[key] === "string") fields.push((record[key] as string).slice(0, 2048));
  }
  for (const key of ["error", "details"]) {
    if (record[key] !== undefined) fields.push(...providerErrorFields(record[key], depth + 1));
  }
  return fields;
}

function providerFailureCategory(error: APICallError): SafeAgentFailureCategory {
  const fields = [error.message.slice(0, 4096)];
  if (error.responseBody) {
    fields.push(error.responseBody.slice(0, 4096));
    if (error.responseBody.length <= 16_384) {
      try {
        fields.push(...providerErrorFields(JSON.parse(error.responseBody)));
      } catch {
        // The bounded raw text still supports safe category matching below.
      }
    }
  }
  if (error.data !== undefined) fields.push(...providerErrorFields(error.data));
  const details = fields.map((field) => field.toLowerCase().replace(/[_-]+/g, " "));
  const has = (pattern: RegExp) => details.some((detail) => pattern.test(detail));
  const statusCode = error.statusCode;

  if (
    has(/\b(?:session|conversation)(?: id)?(?: is| was)? (?:not found|unknown|missing|invalid|expired|does not exist|not recognized)\b|\b(?:not found|unknown|missing|invalid|expired)(?: for| of)? (?:the )?(?:session|conversation)\b|\b(?:invalid|unknown|missing|expired) session(?: id)?\b/)
  ) return "missing_session";
  if (
    statusCode === 401 || statusCode === 403 ||
    has(/\b(?:unauthorized|forbidden|authentication|invalid (?:api|access) key|api key)\b/)
  ) return "authentication";
  if (
    statusCode === 429 ||
    has(/\b(?:rate limit|too many requests|quota|usage limit|billing|insufficient credits|credit balance)\b/)
  ) return "rate_or_usage_limit";
  if (
    has(/\b(?:context(?: window)? (?:length|limit)|maximum context|context length exceeded|too many tokens|token limit)\b|\b(?:prompt|input).{0,40}\b(?:too long|too large|exceed(?:ed)?)\b/)
  ) return "context_length";
  if (
    has(/\btool choice\b|\btools?\b.{0,60}\b(?:unsupported|not supported|invalid|unavailable|unknown)\b|\b(?:unsupported|not supported|invalid|unavailable|unknown)\b.{0,60}\btools?\b|\bfunction call\b|\bjson ?schema\b|\bschema\b.{0,60}\b(?:invalid|unsupported|not supported)\b/)
  ) return "tool_choice_or_schema";
  if (
    statusCode === 400 || statusCode === 422 ||
    has(/\b(?:bad request|invalid request|invalid parameter|invalid argument)\b/)
  ) return "invalid_request_parameters";
  if (statusCode === 408 || statusCode === 409 || (statusCode !== undefined && statusCode >= 500)) {
    return "upstream_error";
  }
  return "unknown";
}

export function getSafeAgentFailureDiagnostic(error: unknown): SafeAgentFailureDiagnostic {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  let errorClass: SafeAgentFailureDiagnostic["errorClass"] = "UnknownError";

  while (pending.length > 0 && seen.size < 12) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);

    if (APICallError.isInstance(current)) {
      const statusCode = current.statusCode;
      return {
        errorClass: "APICallError",
        ...(typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
          ? { statusCode }
          : {}),
        retryable: current.isRetryable,
        category: providerFailureCategory(current),
      };
    }
    if (RetryError.isInstance(current)) {
      errorClass = "RetryError";
      pending.push(current.lastError, ...current.errors);
    } else if (InvalidToolInputError.isInstance(current)) {
      errorClass = "InvalidToolInputError";
    } else if (ToolChoiceViolationError.isInstance(current)) {
      errorClass = "ToolChoiceViolationError";
    } else if (current instanceof AgentError) {
      errorClass = "AgentError";
    }

    pending.push(current.cause);
  }

  return { errorClass };
}

type ProviderOptions = {
  name: string;
  config: OpenCodeGoAgentConfig;
  requiresSession: boolean;
  postResponseBillingGuard?: boolean;
};

const APP_USER_AGENT = "im-in-if/0.1.0";
const OPENCODE_GO_PROVIDER_NAME = "opencode-go";
// The OpenAI-compatible adapter maps hyphenated provider names to camel case.
const OPENCODE_GO_PROVIDER_OPTIONS_NAMESPACE = "opencodeGo";
const OPENCODE_GO_PROVIDER_OPTIONS = {
  [OPENCODE_GO_PROVIDER_OPTIONS_NAMESPACE]: {
    thinking: { type: "disabled" },
  },
} as const;

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

  return {
    requestTimeoutMs: config.timeoutMs,
    async reply(input) {
      try {
        const result = await generateText({
          model: modelFor(input.sessionId),
          system: systemPrompt(input),
          messages: input.history.map((message) => ({
            role: message.role === "agent" ? "assistant" : "user",
            content: message.content,
          })),
          tools: {
            private_plan_reply: tool({
              description: "Return the private natural-language reply, any validated interest change, and the complete current condition state.",
              inputSchema: AgentReplySchema,
            }),
          },
          toolChoice: { type: "tool", toolName: "private_plan_reply" },
          abortSignal: timeout(),
          maxRetries: 0,
          maxOutputTokens: 4000,
          providerOptions: OPENCODE_GO_PROVIDER_OPTIONS,
        });
        if (result.toolCalls.length !== 1 || result.toolCalls[0].toolName !== "private_plan_reply") {
          throw new AgentError("invalid_output", "model returned invalid structured output");
        }
        const parsed = AgentReplySchema.safeParse(result.toolCalls[0].input);
        if (!parsed.success) {
          throw new AgentError("invalid_output", "model returned invalid structured output");
        }
        return parsed.data;
      } catch (error) {
        const providerError = findAgentError(error);
        if (providerError) throw providerError;
        if (isInvalidToolReply(error)) {
          throw new AgentError("invalid_output", "model returned invalid structured output", { cause: error });
        }
        if (isAbort(error)) {
          throw new AgentError("timeout", "model request timed out", { cause: error });
        }
        throw new AgentError("model_error", "model request failed", { cause: error });
      }
    },

    async generateOffer(input) {
      const compatibleOptions = input.options.filter((option) =>
        option.source !== "sample" &&
        optionMeetsHardOptionConditions(option, input.privateConditions.hard),
      );
      const displayTimeZone = input.outing.cutoffTimeZone;
      const localizedOptions = compatibleOptions.map((option) => ({
        ...option,
        ...(displayTimeZone
          ? {
              startsAtLocal: formatZonedDateTime(new Date(option.startsAt), displayTimeZone),
              timeZone: displayTimeZone,
            }
          : {}),
      }));
      const localizedOwnerWindows = input.privateConditions.hard.availableWindows.map((window) => ({
        ...window,
        ...(displayTimeZone
          ? {
              startsAtLocal: formatZonedDateTime(new Date(window.startsAt), displayTimeZone),
              endsAtLocal: formatZonedDateTime(new Date(window.endsAt), displayTimeZone),
              timeZone: displayTimeZone,
            }
          : {}),
      }));
      const prompt = [
        "Create one tentative plan offer for your owner. This is not a confirmation.",
        "Call private_plan_offer exactly once. Its object requires kind, optionId, option, attendeeUserIds, counterOfferToId, privateNote, and question on every call.",
        "For an existing catalog choice, set kind='existing_option', optionId to one supplied catalog UUID, option=null, question=null, and include attendees, counterOfferToId, and privateNote. The application copies the chosen option's canonical activity, time, cost, and tags.",
        "For a new choice, set kind='new_option', optionId=null, option to a new option object with title, activity, startsAt, estimatedCostCents, and activityTags, and question=null. For a clarification, set kind='clarification', optionId=null, option=null, attendeeUserIds=[], counterOfferToId=null, privateNote='', and ask one focused question.",
        "Use a supplied public catalog option only when its activity fits the outing suggestion and the owner's private input and preferences, as well as the hard conditions. Otherwise draft a relevant generic option or ask one focused clarification. Do not replace the suggested activity with an unrelated activity; for example, never offer a movie when the idea is sushi.",
        "Include your owner in attendeeUserIds. Use only participants whose responseStatus is interested. Do not change strict conditions. Other participants' conditions are checked after your answer, but their private details are not available to you.",
        `Every supplied catalog option has already passed your owner's hard availability, budget, and activity-tag checks. Do not claim a supplied option violates those checks. ${displayTimeZone ? "Use its startsAtLocal and timeZone for plain-language time descriptions." : "No outing time zone is set. Do not treat an option's ISO timestamp as the owner's local time; ask for the time zone before describing or choosing a local activity time."}`,
        "For a new option, use an owner-provided date and time or fit a dated window from Owner availability windows below. Return startsAt as an ISO instant in the outing time zone. The response cutoff is not the activity date. If the activity or date/time cannot be chosen from the supplied details without guessing, return one focused clarification instead of an option. If no outing time zone is set, ask the owner to choose one before interpreting dates or local clock times; do not treat UTC as the owner's local time.",
        "A new option's estimatedCostCents is a generic per-person estimate, not a checked price or quote. Do not claim live restaurant availability, a booking, or a reservation. Do not put verified prices or booking claims in privateNote.",
        "Use only the owner's private conditions and rankings, the public catalog, participant names, resolved tie result, and approved shared offers below. A counterOfferToId must name a supplied shared offer owned by another participant, or be null. Do not disclose your privateNote to other people.",
        `Outing suggestion: ${JSON.stringify(input.outing.suggestion)}`,
        `Your user ID: ${JSON.stringify(input.participantUserId)}`,
        `Your private planning input: ${JSON.stringify(input.privateInput)}`,
        `Your private hard conditions and flexible preferences: ${JSON.stringify(input.privateConditions)}`,
        "Recent owner messages are in chronological order. Follow the owner's latest explicit user messages about activity and venue over older user messages and the initial suggestion. Treat only the current structured condition state above as hard limits; chat does not create or relax hard limits without the existing owner condition-update flow.",
        `Recent private owner conversation: ${JSON.stringify(input.recentConversation)}`,
        `Owner availability windows: ${JSON.stringify(localizedOwnerWindows)}`,
        `Your private option rankings: ${JSON.stringify(input.privateRankings)}`,
        `Catalog options: ${JSON.stringify(localizedOptions)}`,
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
      try {
        const result = await generateText({
          model: modelFor(input.sessionId),
          prompt,
          tools: {
            private_plan_offer: tool({
              description: "Select a compatible outing option, draft a new private option, or ask a focused clarification using the complete required fields.",
              inputSchema: PrivatePlanOfferToolSchema,
            }),
          },
          toolChoice: { type: "tool", toolName: "private_plan_offer" },
          abortSignal: timeout(),
          maxRetries: 0,
          maxOutputTokens: 4000,
          providerOptions: OPENCODE_GO_PROVIDER_OPTIONS,
        });
        if (result.toolCalls.length !== 1 || result.toolCalls[0].toolName !== "private_plan_offer") {
          throw invalidOfferToolOutput();
        }
        return normalizeOfferToolReply(result.toolCalls[0].input, compatibleOptions);
      } catch (error) {
        const providerError = findAgentError(error);
        if (providerError) throw providerError;
        if (isInvalidToolReply(error)) {
          throw new AgentError("invalid_output", "model returned invalid structured output", { cause: error });
        }
        if (isAbort(error)) {
          throw new AgentError("timeout", "model request timed out", { cause: error });
        }
        throw new AgentError("model_error", "model request failed", { cause: error });
      }
    },
  };
}

export function createOpenCodeGoAgent(config: OpenCodeGoAgentConfig): Agent {
  if (config.model !== ACTIVE_GO_MODEL) {
    throw new AgentError("unavailable", "the active demo model is pinned to DeepSeek V4.1 Flash");
  }
  return createAgent({
    name: OPENCODE_GO_PROVIDER_NAME,
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
