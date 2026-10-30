"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

const REQUEST_STORAGE_KEY = "im-in-if:new-outing-request";

function requestIdFor(): string {
  try {
    const saved = sessionStorage.getItem(REQUEST_STORAGE_KEY);
    if (saved) return saved;
    const requestId = crypto.randomUUID();
    sessionStorage.setItem(REQUEST_STORAGE_KEY, requestId);
    return requestId;
  } catch {
    return crypto.randomUUID();
  }
}

export function StartOutingForm() {
  const router = useRouter();
  const inputId = useId();
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = suggestion.trim();
    if (!content || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/outings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suggestion: content, requestId: requestIdFor() }),
      });
      const data = (await response.json().catch(() => null)) as
        | { outing?: { id: string }; error?: string }
        | null;

      if (data?.outing?.id) {
        sessionStorage.removeItem(REQUEST_STORAGE_KEY);
        router.push(`/outings/${data.outing.id}`);
        return;
      }

      if (data?.error === "idempotency_conflict") {
        sessionStorage.removeItem(REQUEST_STORAGE_KEY);
        setError("This request was already used for a different idea. Submit again to start a new chat.");
      } else {
        setError("The chat could not be started. Check your idea and try again.");
      }
    } catch {
      setError("The connection dropped. Try the same idea again to continue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="ticket start-outing-form" onSubmit={start}>
      <h2>New outing</h2>
      <p className="start-outing-copy">Begin with the thought you have. You can work out the details in your private chat.</p>

      <div className="field">
        <label htmlFor={inputId}>What are you thinking?</label>
        <textarea
          id={inputId}
          className="idea-input"
          value={suggestion}
          onChange={(event) => setSuggestion(event.target.value)}
          placeholder="Maybe dinner Friday?"
          maxLength={400}
          rows={2}
          autoComplete="off"
          required
        />
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="ticket-action">
        <button type="submit" className="button button-solid" disabled={submitting}>
          {submitting ? "Opening…" : "Start a private chat"}
        </button>
      </div>
    </form>
  );
}
