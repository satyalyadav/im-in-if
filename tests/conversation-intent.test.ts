import { describe, expect, it } from "vitest";
import { prepareConversationInterest } from "@/lib/conversation-intent";

function intent(overrides: Partial<Parameters<typeof prepareConversationInterest>[0]> = {}) {
  return prepareConversationInterest({
    ownerText: "I'm in.",
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

  it("does not treat a question about options as interest", () => {
    expect(intent({ ownerText: "What time works?" })).toMatchObject({
      interest: null,
    });
  });

  it("records a clear conditional interest and marks empty conditions ready", () => {
    expect(intent({ ownerText: "I'm in if it's under $30." })).toEqual({
      interest: "interested",
      text: "You're in.",
      markConditionsReady: true,
    });
  });

  it("refuses interest while a focused condition question is open", () => {
    expect(intent({
      ownerText: "I'm in if it's cheap.",
      clarifyingQuestions: ["Is that a strict cap or a preference?"],
    })).toEqual({
      interest: null,
      text: "You're in. I haven't recorded your interest yet.",
      markConditionsReady: false,
    });
  });

  it("records clear disinterest without requiring conditions", () => {
    expect(intent({
      ownerText: "I'm out.",
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
      ownerText: "I'm out.",
      suggested: "not_interested",
      currentStatus: "interested",
      confirmedAttendee: true,
    });
    expect(result.interest).toBeNull();
    expect(result.text).toContain("Request to leave the roster");
  });

  it("does not change interest after the response cutoff", () => {
    const result = intent({
      ownerText: "I'm out.",
      suggested: "not_interested",
      currentStatus: "interested",
      cutoffPassed: true,
    });
    expect(result.interest).toBeNull();
    expect(result.text).toContain("response cutoff has passed");
  });
});
