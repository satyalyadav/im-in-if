import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

export const ConditionInterpretationSchema = z.object({
  hard: z.object({
    availableWindows: z.array(
      z.object({ startsAt: isoDateTime, endsAt: isoDateTime }).strict(),
    ).max(12),
    maxCostCents: z.number().int().min(0).max(100_000).nullable(),
    requiredActivityTags: z.array(z.string().trim().min(1).max(40)).max(12),
    avoidedActivityTags: z.array(z.string().trim().min(1).max(40)).max(12),
    attendanceDependencies: z.array(z.string().min(1).max(128)).max(20),
    minimumGroupSize: z.number().int().min(1).max(20),
  }).strict(),
  flexiblePreferences: z.array(z.string().trim().min(1).max(160)).max(12),
  clarifyingQuestions: z.array(z.string().trim().min(1).max(240)).max(4),
}).strict();

export type ConditionInterpretation = z.infer<typeof ConditionInterpretationSchema>;

export const OfferCandidateSchema = z.object({
  optionId: z.string().uuid(),
  activity: z.string().trim().min(1).max(80),
  startsAt: isoDateTime,
  estimatedCostCents: z.number().int().min(0).max(100_000),
  activityTags: z.array(z.string().trim().min(1).max(40)).max(12),
  attendeeUserIds: z.array(z.string().min(1).max(128)).min(1).max(20),
  counterOfferToId: z.string().uuid().nullable(),
  privateNote: z.string().trim().max(1000),
}).strict();

export type OfferCandidate = z.infer<typeof OfferCandidateSchema>;

export type CatalogOption = {
  id: string;
  title: string;
  activity: string;
  startsAt: string;
  estimatedCostCents: number;
  activityTags: string[];
  source: "sample" | "manual";
};

export type PublicOffer = {
  id: string;
  ownerUserId: string;
  optionId: string;
  activity: string;
  startsAt: string;
  estimatedCostCents: number;
  attendeeUserIds: string[];
  activityTags: string[];
  counterOfferToId: string | null;
  createdAt: string;
};

export type PublicParticipant = {
  userId: string;
  displayName: string;
};

export function emptyConditionInterpretation(): ConditionInterpretation {
  return {
    hard: {
      availableWindows: [],
      maxCostCents: null,
      requiredActivityTags: [],
      avoidedActivityTags: [],
      attendanceDependencies: [],
      minimumGroupSize: 1,
    },
    flexiblePreferences: [],
    clarifyingQuestions: [],
  };
}

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value as T | null | undefined) ?? fallback;
}
