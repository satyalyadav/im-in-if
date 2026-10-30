import type { ParticipantResponseStatus } from "@/lib/agent";

export type ConversationInterest = "interested" | "not_interested";

export type ConversationInterestResult = {
  interest: ConversationInterest | null;
  text: string;
  markConditionsReady: boolean;
};

type Input = {
  ownerText: string;
  suggested: ConversationInterest | null | undefined;
  currentStatus: ParticipantResponseStatus;
  conditionsReady: boolean;
  clarifyingQuestions: string[];
  confirmedAttendee: boolean;
  cutoffPassed: boolean;
  text: string;
};

const QUESTION_START =
  /^(?:what|which|when|where|who|whom|whose|why|how|is|are|was|were|can|could|do|does|did|would|should|shall|will|may|might|have|has)\b/i;

function unchanged(input: Input): ConversationInterestResult {
  return {
    interest: null,
    text: input.text,
    markConditionsReady: false,
  };
}

function appendMissing(text: string, sentence: string): string {
  const normalized = text.toLocaleLowerCase("en-US");
  if (normalized.includes(sentence.toLocaleLowerCase("en-US"))) return text;
  return `${text.trim()} ${sentence}`.trim();
}

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || QUESTION_START.test(trimmed);
}

/**
 * Validate an interest intention that the owner's agent already interpreted.
 * This function does not decide what a message means; it only blocks effects
 * the server cannot safely apply, such as questions, cutoff changes, or a
 * withdrawal from an already confirmed plan.
 */
export function prepareConversationInterest(input: Input): ConversationInterestResult {
  const suggested = input.suggested;
  if (!suggested) return unchanged(input);
  if (input.currentStatus === suggested) return unchanged(input);

  if (input.confirmedAttendee) {
    if (suggested === "not_interested") {
      // The conversational departure flow belongs to issue #24. Until then,
      // point the owner at the existing control instead of toggling interest.
      return {
        interest: null,
        text:
          "You're on the confirmed plan, so I haven't changed your interest. " +
          "Request to leave the roster if it no longer works for you. The usual departure rules still apply.",
        markConditionsReady: false,
      };
    }
    return unchanged(input);
  }

  if (input.cutoffPassed || input.currentStatus === "no_response") {
    return {
      interest: null,
      text: "The response cutoff has passed, so I haven't changed your interest.",
      markConditionsReady: false,
    };
  }

  if (isQuestion(input.ownerText)) {
    return {
      interest: null,
      text: appendMissing(input.text, "I haven't changed your interest."),
      markConditionsReady: false,
    };
  }

  if (suggested === "not_interested") {
    return {
      interest: "not_interested",
      text: input.text,
      markConditionsReady: false,
    };
  }

  if (input.clarifyingQuestions.length > 0) {
    return {
      interest: null,
      text: appendMissing(input.text, "I haven't recorded your interest yet."),
      markConditionsReady: false,
    };
  }

  return {
    interest: "interested",
    text: input.text,
    markConditionsReady: !input.conditionsReady,
  };
}
