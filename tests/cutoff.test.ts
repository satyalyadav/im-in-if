import { describe, expect, it } from "vitest";
import {
  formatZonedDateTime,
  formatZonedTime,
  resolveCutoffInstant,
} from "@/lib/cutoff";

describe("resolveCutoffInstant", () => {
  it("keeps a Phoenix wall time at UTC-7 year round", () => {
    const result = resolveCutoffInstant({
      date: "2026-10-31",
      time: "19:30",
      timeZone: "America/Phoenix",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant.toISOString()).toBe("2026-11-01T02:30:00.000Z");
    expect(result.display).toBe("Oct 31, 2026, 7:30 PM MST");
  });

  it("applies a half-hour offset zone", () => {
    const result = resolveCutoffInstant({
      date: "2026-10-31",
      time: "19:30",
      timeZone: "Asia/Kolkata",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant.toISOString()).toBe("2026-10-31T14:00:00.000Z");
  });

  it("resolves a New York time during daylight saving time", () => {
    const result = resolveCutoffInstant({
      date: "2026-07-04",
      time: "18:00",
      timeZone: "America/New_York",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant.toISOString()).toBe("2026-07-04T22:00:00.000Z");
  });

  it("rejects a wall time skipped by the spring DST transition", () => {
    const result = resolveCutoffInstant({
      date: "2026-03-08",
      time: "02:30",
      timeZone: "America/New_York",
    });

    expect(result).toEqual({ ok: false, error: "nonexistent_local_time" });
  });

  it("chooses the earlier instant for a fall-back repeated wall time", () => {
    const result = resolveCutoffInstant({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/New_York",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rejects calendar dates that do not exist", () => {
    const result = resolveCutoffInstant({
      date: "2026-02-30",
      time: "18:00",
      timeZone: "America/Phoenix",
    });

    expect(result).toEqual({ ok: false, error: "invalid_date" });
  });

  it("rejects malformed times and unknown zones", () => {
    expect(
      resolveCutoffInstant({ date: "2026-10-31", time: "7pm", timeZone: "America/Phoenix" }),
    ).toEqual({ ok: false, error: "invalid_time" });
    expect(
      resolveCutoffInstant({ date: "2026-10-31", time: "19:30", timeZone: "Mars/Olympus" }),
    ).toEqual({ ok: false, error: "invalid_time_zone" });
  });
});

describe("formatZonedDateTime", () => {
  it("renders the same instant in the intended and viewer zones", () => {
    const instant = new Date("2026-11-01T02:30:00.000Z");

    expect(formatZonedDateTime(instant, "America/Phoenix", "en-US")).toBe(
      "Oct 31, 2026, 7:30 PM MST",
    );
    expect(formatZonedDateTime(instant, "Asia/Kolkata", "en-US")).toBe(
      "Nov 1, 2026, 8:00 AM GMT+5:30",
    );
    expect(formatZonedTime(instant, "America/Phoenix", "en-US")).toBe("7:30 PM");
  });
});
