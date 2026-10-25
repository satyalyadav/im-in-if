"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const ERROR_COPY: Record<string, string> = {
  invalid_input: "Check the suggestion, date, time, and time zone.",
  invalid_date: "That date does not exist. Pick another day.",
  invalid_time: "Use a time like 19:30.",
  invalid_time_zone: "Pick a time zone from the list.",
  nonexistent_local_time:
    "That clock time does not exist in the chosen zone because the clocks change that night. Pick another time.",
};

function detectedZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function StartOutingForm() {
  const router = useRouter();
  const ids = useId();
  const [suggestion, setSuggestion] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [zone, setZone] = useState("");
  const [availableZone, setAvailableZone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const zones = useMemo(() => {
    const local = detectedZone();
    const supported =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [local];
    return supported.includes(local) ? supported : [local, ...supported];
  }, []);

  useEffect(() => {
    setAvailableZone(detectedZone());
  }, []);

  useEffect(() => {
    if (availableZone && !zone) setZone(availableZone);
  }, [availableZone, zone]);

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (!suggestion.trim() || !date || !time || !zone) {
      setError("Give the idea, the cutoff date, the cutoff time, and the time zone.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/outings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          suggestion,
          cutoffDate: date,
          cutoffTime: time,
          cutoffTimeZone: zone,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { outing?: { id: string }; error?: string }
        | null;

      if (!response.ok || !data?.outing) {
        setError(ERROR_COPY[data?.error ?? ""] ?? "The outing could not be started. Try again.");
        return;
      }

      router.push(`/outings/${data.outing.id}`);
    } catch {
      setError("The connection dropped before the outing started. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="ticket" onSubmit={start}>
      <h2>Begin an outing</h2>

      <div className="field">
        <label htmlFor={`${ids}-suggestion`}>The half-formed idea</label>
        <input
          id={`${ids}-suggestion`}
          className="idea-input"
          value={suggestion}
          onChange={(event) => setSuggestion(event.target.value)}
          placeholder="Dinner Friday?"
          maxLength={400}
          autoComplete="off"
          required
        />
        <p className="hint">Anything from &ldquo;movie Saturday?&rdquo; to &ldquo;dinner, maybe 7?&rdquo;</p>
      </div>

      <fieldset className="cutoff">
        <legend>Replies stop counting at</legend>
        <p className="hint">You choose the exact moment. There is no default.</p>

        <div className="field-row">
          <div className="field">
            <label htmlFor={`${ids}-date`}>Date</label>
            <input
              id={`${ids}-date`}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor={`${ids}-time`}>Time</label>
            <input
              id={`${ids}-time`}
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              required
            />
          </div>
          <div className="field field-wide">
            <label htmlFor={`${ids}-zone`}>Time zone</label>
            <select
              id={`${ids}-zone`}
              value={zone}
              onChange={(event) => setZone(event.target.value)}
              required
            >
              <option value="" disabled>
                Choose a time zone
              </option>
              {zones.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ticket-action">
        <button type="submit" className="button button-solid" disabled={submitting}>
          {submitting ? "Opening…" : "Open my private chat"}
        </button>
      </div>
    </form>
  );
}
