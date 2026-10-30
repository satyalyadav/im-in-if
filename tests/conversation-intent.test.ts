import { describe, expect, it } from "vitest";
import { prepareConversationInterest } from "@/lib/conversation-intent";

function intent(overrides: Partial<Parameters<typeof prepareConversationInterest>[0]> = {}) {
  return prepareConversationInterest({
    suggested: "interested",
    currentStatus: "pending",
    conditionsReady: false,
    clarifyingQuestions: [],
    confirmedAttendee: false,
    cutoffPassed: false,
    text: "You're in.",
    ...overrides,
  });
}

describe("conversation interest", () => {
  it("leaves interest unchanged without a suggested change", () => {
    expect(intent({ suggested: null })).toEqual({
      interest: null,
      text: "You're in.",
      markConditionsReady: false,
    });
  });

  it("leaves interest unchanged when the agent returns no suggestion for a question", () => {
    expect(intent({ suggested: null, text: "A few times could work." })).toEqual({
      interest: null,
      text: "A few times could work.",
      markConditionsReady: false,
    });
  });

  it("records a clear conditional interest and marks empty conditions ready", () => {
    expect(intent({ suggested: "interested" })).toEqual({
      interest: "interested",
      text: "You're in.",
      markConditionsReady: true,
    });
  });

  it("refuses interest while a focused condition question is open", () => {
    expect(intent({
      clarifyingQuestions: ["Is that a strict cap or a preference?"],
    })).toEqual({
      interest: null,
      text: "You're in. I haven't recorded your interest yet.",
      markConditionsReady: false,
    });
  });

  it("records clear disinterest without requiring conditions", () => {
    expect(intent({
      suggested: "not_interested",
      currentStatus: "interested",
    })).toEqual({
      interest: "not_interested",
      text: "You're in.",
      markConditionsReady: false,
    });
  });

  it("does not toggle interest for a confirmed attendee", () => {
    const result = intent({
      suggested: "not_interested",
      currentStatus: "interested",
      confirmedAttendee: true,
    });
    expect(result.interest).toBeNull();
    expect(result.text).toContain("Request to leave the roster");
  });

  it("does not change interest after the response cutoff", () => {
    const result = intent({
      suggested: "not_interested",
      currentStatus: "interested",
      cutoffPassed: true,
    });
    expect(result.interest).toBeNull();
    expect(result.text).toContain("response cutoff has passed");
  });
});
