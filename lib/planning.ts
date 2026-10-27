import type {
  ConditionInterpretation,
  OfferCandidate,
} from "@/lib/planning-types";

export type PlanningParticipant = {
  userId: string;
  admissionStatus: "pending" | "admitted" | "rejected";
  responseStatus: "pending" | "interested" | "not_interested" | "no_response";
};

export type CatalogChoice = {
  id: string;
  activity: string;
  startsAt: string;
  estimatedCostCents: number;
  activityTags: string[];
};

export type ProposalConditionRow = {
  userId: string;
  interpretation: ConditionInterpretation | null;
  interpretationReady: boolean;
  conditionsVersion?: number;
};

export type CandidateValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_attendees"
        | "conditions_incomplete"
        | "condition_conflict"
        | "option_mismatch";
    };

export type HardOptionConditions = Pick<
  ConditionInterpretation["hard"],
  "availableWindows" | "maxCostCents" | "requiredActivityTags" | "avoidedActivityTags"
>;

export function optionMeetsHardOptionConditions(
  option: CatalogChoice,
  hard: HardOptionConditions,
): boolean {
  const activityTags = new Set(option.activityTags.map(normalizeTag));
  const startsAt = new Date(option.startsAt).getTime();
  return (
    (hard.maxCostCents === null || option.estimatedCostCents <= hard.maxCostCents) &&
    hard.requiredActivityTags.every((tag) => activityTags.has(normalizeTag(tag))) &&
    hard.avoidedActivityTags.every((tag) => !activityTags.has(normalizeTag(tag))) &&
    (hard.availableWindows.length === 0 ||
      hard.availableWindows.some((window) => {
        const from = new Date(window.startsAt).getTime();
        const to = new Date(window.endsAt).getTime();
        return startsAt >= from && startsAt <= to;
      }))
  );
}

export function validateCandidate(
  offer: OfferCandidate,
  ownerUserId: string,
  option: CatalogChoice | null,
  participants: PlanningParticipant[],
  conditions: ProposalConditionRow[],
): CandidateValidation {
  if (
    !option ||
    option.id !== offer.optionId ||
    option.activity !== offer.activity ||
    new Date(option.startsAt).toISOString() !== new Date(offer.startsAt).toISOString() ||
    option.estimatedCostCents !== offer.estimatedCostCents ||
    !sameStrings(option.activityTags, offer.activityTags)
  ) {
    return { ok: false, reason: "option_mismatch" };
  }

  const attendeeIds = [...new Set(offer.attendeeUserIds)];
  if (
    attendeeIds.length !== offer.attendeeUserIds.length ||
    !attendeeIds.includes(ownerUserId)
  ) {
    return { ok: false, reason: "invalid_attendees" };
  }

  const attendeeSet = new Set(attendeeIds);
  const eligibleIds = new Set(
    participants
      .filter(
        (participant) =>
          participant.admissionStatus === "admitted" &&
          participant.responseStatus === "interested",
      )
      .map((participant) => participant.userId),
  );
  if (attendeeIds.some((userId) => !eligibleIds.has(userId))) {
    return { ok: false, reason: "invalid_attendees" };
  }

  const conditionByUser = new Map(conditions.map((row) => [row.userId, row]));

  for (const userId of attendeeIds) {
    const row = conditionByUser.get(userId);
    const interpretation = row?.interpretation;
    if (!row?.interpretationReady || !interpretation) {
      return { ok: false, reason: "conditions_incomplete" };
    }
    if (interpretation.clarifyingQuestions.length > 0) {
      return { ok: false, reason: "conditions_incomplete" };
    }

    const hard = interpretation.hard;
    if (
      !optionMeetsHardOptionConditions(option, hard) ||
      hard.attendanceDependencies.some((requiredUserId) => !attendeeSet.has(requiredUserId)) ||
      attendeeIds.length < hard.minimumGroupSize
    ) {
      return { ok: false, reason: "condition_conflict" };
    }
  }

  return { ok: true };
}

export function finalApprovalDeadline(publishedAt: Date, activityStartsAt: Date): Date {
  return new Date(
    Math.min(publishedAt.getTime() + 30 * 60 * 1000, activityStartsAt.getTime()),
  );
}

function normalizeTag(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = left.map(normalizeTag).sort();
  const b = right.map(normalizeTag).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
