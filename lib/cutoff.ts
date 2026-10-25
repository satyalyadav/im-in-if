export type CutoffError =
  | "invalid_date"
  | "invalid_time"
  | "invalid_time_zone"
  | "nonexistent_local_time";

export type CutoffResult =
  | { ok: true; instant: Date; display: string }
  | { ok: false; error: CutoffError };

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DISPLAY_LOCALE = "en-US";

function parseDate(value: string): WallClock | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));

  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, hour: 0, minute: 0 };
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function assertTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function partsInZone(instantMs: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));

  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
  };
}

function offsetAt(instantMs: number, timeZone: string): number {
  const wall = partsInZone(instantMs, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return wallAsUtc - instantMs;
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

export function formatZonedDateTime(
  instant: Date,
  timeZone: string,
  locale = DISPLAY_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

export function formatZonedTime(
  instant: Date,
  timeZone: string,
  locale = DISPLAY_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

export function formatViewerDateTime(instant: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

/**
 * Resolves an explicitly supplied wall-clock date, time, and IANA zone to an
 * instant. The app never guesses a cutoff. When a fall-back transition repeats
 * a wall time, the earlier instant is used; a spring-forward gap is rejected.
 */
export function resolveCutoffInstant(input: {
  date: string;
  time: string;
  timeZone: string;
}): CutoffResult {
  const date = parseDate(input.date);
  if (!date) return { ok: false, error: "invalid_date" };

  const time = parseTime(input.time);
  if (!time) return { ok: false, error: "invalid_time" };

  if (!assertTimeZone(input.timeZone)) {
    return { ok: false, error: "invalid_time_zone" };
  }

  const wall: WallClock = { ...date, ...time };
  const naiveUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  // Transitions are at most a few hours wide. Sampling a day either side and
  // testing each distinct offset catches both gaps and repeated wall times.
  const offsets = new Set([
    offsetAt(naiveUtc - 26 * 60 * 60 * 1000, input.timeZone),
    offsetAt(naiveUtc + 26 * 60 * 60 * 1000, input.timeZone),
  ]);

  const matches = [...offsets]
    .map((offset) => naiveUtc - offset)
    .filter((instantMs) => sameWallClock(partsInZone(instantMs, input.timeZone), wall))
    .sort((a, b) => a - b);

  if (matches.length === 0) {
    return { ok: false, error: "nonexistent_local_time" };
  }

  const instant = new Date(matches[0]);
  return {
    ok: true,
    instant,
    display: formatZonedDateTime(instant, input.timeZone),
  };
}
