import type { AgentConditionUpdate } from "@/lib/agent";
import {
  ConditionInterpretationSchema,
  type ConditionInterpretation,
  type PublicParticipant,
} from "@/lib/planning-types";

export type ConversationMessage = { role: "user" | "agent"; content: string };

export type ConversationConditionResult = {
  text: string;
  interpretation: ConditionInterpretation | null;
  ready: boolean;
  changed: boolean;
};

type Hard = ConditionInterpretation["hard"];
type Relaxation =
  | { kind: "maxCost"; before: number; after: number | null }
  | { kind: "windows"; before: Hard["availableWindows"]; after: Hard["availableWindows"] }
  | { kind: "requiredTag"; tag: string }
  | { kind: "avoidedTag"; tag: string }
  | { kind: "dependency"; userId: string }
  | { kind: "minimumGroup"; before: number; after: number };

type Input = {
  ownerUserId: string;
  history: ConversationMessage[];
  current: ConditionInterpretation | null;
  currentReady: boolean;
  suggested: AgentConditionUpdate | null | undefined;
  participants: PublicParticipant[];
  conditionsLocked: boolean;
  timeZone: string | null;
  text: string;
};

const ACKNOWLEDGEMENT = /^(?:thanks?(?: so much)?|thank you|thx|okay|ok|got it|cool|sounds good|nice|awesome|great|all good)[.!\s]*$/i;
const PLANNING_SIGNAL = /\b(?:need|must|can't|cannot|won't|don't|do not|only|before|after|until|by|between|around|available|availability|free|budget|cost|spend|price|limit|cap|avoid|prefer|want|rather|like|works?|attend|come|join|bring|if|depends|group|people|movie|dinner|activity|friday|saturday|sunday|monday|tuesday|wednesday|thursday|weekend|time|date|day|dollar|restriction|condition|constraint|no limits?|no restrictions?|no conditions?|anything works|whatever works|flexible)\b|[$]\s*\d|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const AFFIRMATIVE = /^(?:yes|yeah|yep|okay|ok|sure)[.!\s]*$/i;
const NEGATIVE = /^(?:no|nope|no thanks|no thank you)[.!\s]*$/i;

function uniqueQuestions(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const question = value.trim();
    if (question && !output.some((item) => item.toLocaleLowerCase("en-US") === question.toLocaleLowerCase("en-US"))) {
      output.push(question);
    }
  }
  return output.slice(-4);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function mergeIntervals(windows: Hard["availableWindows"]): Array<[number, number]> {
  const sorted = windows
    .map((window) => [new Date(window.startsAt).getTime(), new Date(window.endsAt).getTime()] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

function windowsWidened(before: Hard["availableWindows"], after: Hard["availableWindows"]): boolean {
  if (before.length === 0) return false;
  if (after.length === 0) return true;
  const oldIntervals = mergeIntervals(before);
  return mergeIntervals(after).some(([start, end]) => {
    let cursor = start;
    for (const [oldStart, oldEnd] of oldIntervals) {
      if (oldEnd < cursor) continue;
      if (oldStart > cursor) return true;
      cursor = Math.max(cursor, oldEnd);
      if (cursor >= end) return false;
    }
    return cursor < end;
  });
}

function findRelaxations(
  before: ConditionInterpretation | null,
  after: ConditionInterpretation,
): Relaxation[] {
  if (!before) return [];
  const oldHard = before.hard;
  const nextHard = after.hard;
  const changes: Relaxation[] = [];

  if (oldHard.maxCostCents !== null &&
      (nextHard.maxCostCents === null || nextHard.maxCostCents > oldHard.maxCostCents)) {
    changes.push({ kind: "maxCost", before: oldHard.maxCostCents, after: nextHard.maxCostCents });
  }
  if (windowsWidened(oldHard.availableWindows, nextHard.availableWindows)) {
    changes.push({ kind: "windows", before: oldHard.availableWindows, after: nextHard.availableWindows });
  }
  const nextRequired = new Set(nextHard.requiredActivityTags.map(normalize));
  for (const tag of oldHard.requiredActivityTags) {
    if (!nextRequired.has(normalize(tag))) changes.push({ kind: "requiredTag", tag });
  }
  const nextAvoided = new Set(nextHard.avoidedActivityTags.map(normalize));
  for (const tag of oldHard.avoidedActivityTags) {
    if (!nextAvoided.has(normalize(tag))) changes.push({ kind: "avoidedTag", tag });
  }
  const nextDependencies = new Set(nextHard.attendanceDependencies);
  for (const userId of oldHard.attendanceDependencies) {
    if (!nextDependencies.has(userId)) changes.push({ kind: "dependency", userId });
  }
  if (nextHard.minimumGroupSize < oldHard.minimumGroupSize) {
    changes.push({ kind: "minimumGroup", before: oldHard.minimumGroupSize, after: nextHard.minimumGroupSize });
  }
  return changes;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function namesFor(ids: string[], participants: PublicParticipant[]): string {
  const names = ids.map((id) => participants.find((person) => person.userId === id)?.displayName ?? "someone");
  return names.join(", ");
}

function formatWindows(windows: Hard["availableWindows"], timeZone: string | null): string {
  if (windows.length === 0) return "no time restriction";
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: timeZone ?? "UTC", timeZoneName: "short",
    });
  } catch {
    return windows.map((window) => `${window.startsAt} to ${window.endsAt}`).join("; ");
  }
  const formatted = windows.map((window) =>
    `${formatter.format(new Date(window.startsAt))} to ${formatter.format(new Date(window.endsAt))}`,
  ).join("; ");
  return timeZone ? formatted : `${formatted} (your local time zone is not set)`;
}

function relaxationQuestion(change: Relaxation, participants: PublicParticipant[], timeZone: string | null): string {
  switch (change.kind) {
    case "maxCost": {
      const next = change.after === null ? "no cap" : money(change.after);
      return change.after === null
        ? `Your strict spending cap is ${money(change.before)}. Should I remove that cap?`
        : `Your strict spending cap is ${money(change.before)}. The new cap would be ${next}. Should I raise it to ${next}?`;
    }
    case "windows":
      return `Your availability is ${formatWindows(change.before, timeZone)}. The new interpretation would allow ${formatWindows(change.after, timeZone)}. Should I change your availability?`;
    case "requiredTag":
      return `You said ${change.tag} is required. Should I remove that requirement?`;
    case "avoidedTag":
      return `You said you want to avoid ${change.tag}. Should I remove that restriction?`;
    case "dependency":
      return `You said ${namesFor([change.userId], participants)} must attend with you. Should I remove that condition?`;
    case "minimumGroup":
      return `You said at least ${change.before} people must attend. Should I lower that to ${change.after}?`;
  }
}

function priorAssistant(history: ConversationMessage[]): string {
  return [...history.slice(0, -1)].reverse().find((message) => message.role === "agent")?.content.trim() ?? "";
}

function relaxationAnswer(change: Relaxation, input: Input, ownerText: string): "yes" | "no" | null {
  const question = relaxationQuestion(change, input.participants, input.timeZone);
  if (priorAssistant(input.history).replace(/\s+/g, " ") !== question.replace(/\s+/g, " ")) return null;
  if (AFFIRMATIVE.test(ownerText.trim())) return "yes";
  if (NEGATIVE.test(ownerText.trim())) return "no";
  return null;
}

function preserveHardLimit(
  candidate: ConditionInterpretation,
  current: ConditionInterpretation | null,
  change: Relaxation,
): ConditionInterpretation {
  if (!current) return candidate;
  const hard = { ...candidate.hard };
  switch (change.kind) {
    case "maxCost":
      hard.maxCostCents = current.hard.maxCostCents;
      break;
    case "windows":
      hard.availableWindows = current.hard.availableWindows;
      break;
    case "requiredTag":
      hard.requiredActivityTags = [...new Set([...candidate.hard.requiredActivityTags, change.tag])];
      break;
    case "avoidedTag":
      hard.avoidedActivityTags = [...new Set([...candidate.hard.avoidedActivityTags, change.tag])];
      break;
    case "dependency":
      hard.attendanceDependencies = [...new Set([...candidate.hard.attendanceDependencies, change.userId])];
      break;
    case "minimumGroup":
      hard.minimumGroupSize = Math.max(current.hard.minimumGroupSize, candidate.hard.minimumGroupSize);
      break;
  }
  return { ...candidate, hard };
}

function keepLimitMessage(change: Relaxation, input: Input): string {
  switch (change.kind) {
    case "maxCost":
      return `Understood. I'll keep your strict spending cap at ${money(change.before)}.`;
    case "windows":
      return `Understood. I'll keep your availability as ${formatWindows(change.before, input.timeZone)}.`;
    case "requiredTag":
      return `Understood. I'll keep ${change.tag} as a requirement.`;
    case "avoidedTag":
      return `Understood. I'll keep avoiding ${change.tag}.`;
    case "dependency":
      return `Understood. I'll keep ${namesFor([change.userId], input.participants)} as required to attend.`;
    case "minimumGroup":
      return `Understood. I'll keep the minimum group size at ${change.before}.`;
  }
}

function noConditionsExplicitly(text: string): boolean {
  return /\b(?:no (?:other )?(?:conditions?|constraints?|restrictions?|limits?)|nothing in particular|anything works|whatever works|i(?:'m| am) flexible about everything)\b/i.test(text);
}

function isYesNoQuestion(text: string): boolean {
  return /\b(?:do you|did you|are you|is it|is that|can you|would you|should i|will you)\b[^?]*\?/i.test(text);
}

function amountAnswerCents(text: string): number | null {
  const currencyAmounts = [
    ...[...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)(?!\d|\.\d)/g)].map((match) => match[1]),
    ...[...text.matchAll(/\b(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks)\b/gi)].map((match) => match[1]),
  ];
  const bareAmount = text.match(/^\s*(\d+(?:\.\d{1,2})?)\s*[.!]?\s*$/)?.[1];
  const amounts = bareAmount ? [...currencyAmounts, bareAmount] : currencyAmounts;
  const cents = [...new Set(amounts.map((amount) => Math.round(Number(amount) * 100)))];
  return cents.length === 1 ? cents[0] : null;
}

function isPendingQuestionAnswer(
  input: Input,
  suggestion: AgentConditionUpdate,
  text: string,
): boolean {
  const questions = input.current?.clarifyingQuestions ?? [];
  if (questions.length === 0 || text.trim().length > 120) return false;
  const cleanText = normalize(text).replace(/^[\W_]+|[\W_]+$/g, "");

  if (
    questions.some((question) => /\b(?:spend|spending|budget|cap|cost|price|amount|how much|dollars?)\b/i.test(question)) &&
    amountAnswerCents(text) === suggestion.hard.maxCostCents && suggestion.hard.maxCostCents !== null
  ) return true;

  const personQuestion = questions.some((question) =>
    /\b(?:who|whom|which (?:person|attendee|participant)|(?:person|name|attendee)\b)/i.test(question),
  );
  if (personQuestion) {
    const echoedName = suggestion.hard.attendanceDependencyNames.some(
      (name) => normalize(name).replace(/^[\W_]+|[\W_]+$/g, "") === cleanText,
    );
    if (echoedName) return true;
    const matched = input.participants.filter((person) => normalize(person.displayName) === cleanText);
    if (matched.length === 1 && suggestion.hard.attendanceDependencyNames.some(
      (name) => normalize(name) === normalize(matched[0].displayName),
    )) return true;
  }

  const timeQuestion = questions.some((question) =>
    /\b(?:when|what date|what time|what day|which (?:day|date|time)|availability|available|free)\b/i.test(question),
  );
  if (timeQuestion && suggestion.hard.availableWindows.length > 0 &&
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|am|pm|noon|midnight|between|after|before|at)\b|\b\d{1,2}(?::\d{2})?\b/i.test(text)) {
    return true;
  }

  const preferenceQuestion = questions.some((question) =>
    /\b(?:prefer|preference|what kind|what type|which activity|what activity|what food|what cuisine|what do you like)\b/i.test(question),
  );
  if (preferenceQuestion && cleanText && [
    ...suggestion.flexiblePreferences,
    ...suggestion.hard.requiredActivityTags,
    ...suggestion.hard.avoidedActivityTags,
  ].some((value) => normalize(value) === cleanText || normalize(value).includes(cleanText))) {
    return true;
  }
  return false;
}

function appendQuestion(text: string, question: string): string {
  return text.toLocaleLowerCase("en-US").includes(question.toLocaleLowerCase("en-US"))
    ? text
    : `${text.trim()} ${question}`.trim();
}

function noChange(input: Input, text = input.text): ConversationConditionResult {
  return { text, interpretation: input.current, ready: input.currentReady, changed: false };
}

export function prepareConversationConditionUpdate(input: Input): ConversationConditionResult {
  const suggestion = input.suggested;
  if (!suggestion) return noChange(input);

  const parsed = ConditionInterpretationSchema.safeParse({
    hard: {
      availableWindows: suggestion.hard.availableWindows,
      maxCostCents: suggestion.hard.maxCostCents,
      requiredActivityTags: suggestion.hard.requiredActivityTags,
      avoidedActivityTags: suggestion.hard.avoidedActivityTags,
      attendanceDependencies: [],
      minimumGroupSize: suggestion.hard.minimumGroupSize,
    },
    flexiblePreferences: suggestion.flexiblePreferences,
    clarifyingQuestions: suggestion.clarifyingQuestions,
  });
  if (!parsed.success) throw new Error("invalid_condition_update");

  const ownerText = input.history.at(-1)?.role === "user" ? input.history.at(-1)?.content ?? "" : "";
  const previousAgentText = priorAssistant(input.history);
  const shortAnswerToQuestion = (AFFIRMATIVE.test(ownerText.trim()) || NEGATIVE.test(ownerText.trim())) &&
    isYesNoQuestion(previousAgentText);
  const pendingQuestionAnswer = isPendingQuestionAnswer(input, suggestion, ownerText);
  const meaningful = PLANNING_SIGNAL.test(ownerText) || noConditionsExplicitly(ownerText) ||
    shortAnswerToQuestion || pendingQuestionAnswer;
  if (!meaningful || (ACKNOWLEDGEMENT.test(ownerText.trim()) && !shortAnswerToQuestion)) {
    return noChange(input);
  }

  const rosterNames = new Map<string, PublicParticipant[]>();
  for (const participant of input.participants) {
    const name = normalize(participant.displayName);
    rosterNames.set(name, [...(rosterNames.get(name) ?? []), participant]);
  }
  const resolvedDependencies: string[] = [];
  const unresolvedQuestions: string[] = [];
  for (const rawName of suggestion.hard.attendanceDependencyNames) {
    const matches = rosterNames.get(normalize(rawName)) ?? [];
    if (matches.length !== 1) {
      unresolvedQuestions.push(matches.length === 0
        ? `I couldn't match ${rawName} to an admitted person. Who did you mean?`
        : `More than one admitted person is named ${rawName}. Which one did you mean?`);
    } else if (matches[0].userId === input.ownerUserId) {
      unresolvedQuestions.push("You named yourself as someone who must attend. Did you mean that you need another person to come with you?");
    } else {
      resolvedDependencies.push(matches[0].userId);
    }
  }

  const validWindows = suggestion.hard.availableWindows.filter(
    (window) => new Date(window.startsAt).getTime() < new Date(window.endsAt).getTime(),
  );
  if (validWindows.length !== suggestion.hard.availableWindows.length) {
    unresolvedQuestions.push("One of those time ranges ends before it starts. What start and end time should I use?");
  }
  const currentDependencies = input.current?.hard.attendanceDependencies ?? [];
  const candidate: ConditionInterpretation = {
    hard: {
      availableWindows: validWindows.length === suggestion.hard.availableWindows.length
        ? validWindows
        : [...(input.current?.hard.availableWindows ?? []), ...validWindows],
      maxCostCents: suggestion.hard.maxCostCents,
      requiredActivityTags: [...new Set(suggestion.hard.requiredActivityTags.map((tag) => tag.trim()))],
      avoidedActivityTags: [...new Set(suggestion.hard.avoidedActivityTags.map((tag) => tag.trim()))],
      attendanceDependencies: unresolvedQuestions.length
        ? [...new Set([...currentDependencies, ...resolvedDependencies])]
        : [...new Set(resolvedDependencies)],
      minimumGroupSize: suggestion.hard.minimumGroupSize,
    },
    flexiblePreferences: [...new Set(suggestion.flexiblePreferences.map((value) => value.trim()))],
    clarifyingQuestions: uniqueQuestions([...suggestion.clarifyingQuestions, ...unresolvedQuestions]),
  };

  if (input.conditionsLocked && !same(candidate, input.current)) {
    return noChange(input, "Your conditions are locked because you confirmed this plan. Request to leave if it no longer works for you.");
  }

  const relaxations = findRelaxations(input.current, candidate);
  const unapproved = relaxations.filter((change) => relaxationAnswer(change, input, ownerText) !== "yes");
  let safeCandidate = candidate;
  for (const change of unapproved) {
    safeCandidate = preserveHardLimit(safeCandidate, input.current, change);
  }
  const refused = unapproved.find((change) => relaxationAnswer(change, input, ownerText) === "no");
  if (refused) return noChange(input, keepLimitMessage(refused, input));

  if (unresolvedQuestions.length) {
    return {
      text: unresolvedQuestions.reduce((text, question) => appendQuestion(text, question), input.text),
      interpretation: safeCandidate,
      ready: false,
      changed: !same(safeCandidate, input.current) || input.currentReady,
    };
  }

  if (unapproved.length > 0) {
    const next = safeCandidate;
    const stateChanged = !same(next, input.current);
    const ready = next.clarifyingQuestions.length === 0 && (stateChanged || input.currentReady);
    return {
      text: relaxationQuestion(unapproved[0], input.participants, input.timeZone),
      interpretation: next,
      ready,
      changed: stateChanged || ready !== input.currentReady,
    };
  }

  const stateChanged = !same(safeCandidate, input.current);
  const ready = safeCandidate.clarifyingQuestions.length === 0 &&
    (stateChanged || input.currentReady || noConditionsExplicitly(ownerText));
  if (!stateChanged && ready === input.currentReady) return noChange(input);
  return { text: input.text, interpretation: safeCandidate, ready, changed: true };
}
