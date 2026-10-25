import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { formatZonedDateTime } from "@/lib/cutoff";

export type AgentErrorCode = "timeout" | "model_error" | "empty_reply" | "unavailable";

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

export type AgentTurnInput = {
  outing: {
    suggestion: string;
    cutoffAt: string;
    cutoffTimeZone: string;
  };
  history: Array<{ role: "user" | "agent"; content: string }>;
};

export interface Agent {
  reply(input: AgentTurnInput): Promise<{ text: string }>;
}

export type AsuAgentConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

function systemPrompt(input: AgentTurnInput): string {
  const cutoff = formatZonedDateTime(
    new Date(input.outing.cutoffAt),
    input.outing.cutoffTimeZone,
  );

  return [
    "You are the starter's private personal agent for one outing.",
    `The starter's incomplete suggestion: ${JSON.stringify(input.outing.suggestion)}`,
    `Response cutoff chosen by the starter: ${cutoff}.`,
    "Help the starter turn this idea into a workable plan: ask short, focused questions and suggest concrete next steps.",
    "Their conversation is private. Do not reveal or invent other participants' conditions, chats, or personal reasons, and do not claim anyone else has agreed to anything.",
    "Keep replies concise and plain. Reply in plain text without Markdown formatting such as asterisks or hash headings. You cannot book, pay, or confirm on the starter's behalf.",
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

export function createAsuAgent(config: AsuAgentConfig): Agent {
  const provider = createOpenAICompatible({
    name: "asu",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  const model = provider.chatModel(config.model);

  return {
    async reply(input) {
      try {
        const { text } = await generateText({
          model,
          system: systemPrompt(input),
          messages: input.history.map((message) => ({
            role: message.role === "agent" ? "assistant" : "user",
            content: message.content,
          })),
          abortSignal: AbortSignal.timeout(config.timeoutMs),
          maxRetries: 0,
        });

        const reply = text.trim();
        if (!reply) throw new AgentError("empty_reply");
        return { text: reply };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        if (isAbort(error)) {
          throw new AgentError("timeout", "model request timed out", { cause: error });
        }
        throw new AgentError("model_error", "model request failed", { cause: error });
      }
    },
  };
}

export function getAsuAgent(): Agent {
  const apiKey = process.env.ASU_API_KEY;
  if (!apiKey) throw new AgentError("unavailable", "ASU_API_KEY is not configured");

  const timeoutMs = Number(process.env.ASU_REQUEST_TIMEOUT_MS ?? 60_000);
  return createAsuAgent({
    baseURL: process.env.ASU_BASE_URL ?? "https://openai.rc.asu.edu/v1",
    apiKey,
    model: process.env.ASU_MODEL ?? "qwen38-27b",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
  });
}
