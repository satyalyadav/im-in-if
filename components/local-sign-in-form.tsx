"use client";

import { useId, useState } from "react";

export function LocalSignInForm({ returnTo = "/" }: { returnTo?: string }) {
  const id = useId();
  const [userId, setUserId] = useState("starter");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/dev/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      setError("Use 3 to 64 letters, numbers, dashes, or underscores.");
      setSubmitting(false);
      return;
    }

    window.location.assign(returnTo);
  }

  return (
    <form className="local-form" onSubmit={signIn}>
      <div className="field">
        <label htmlFor={`${id}-user`}>Local user name</label>
        <input
          id={`${id}-user`}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          autoComplete="username"
          maxLength={64}
          required
        />
        <p className="hint">Two names make it easy to check that one account cannot read another&rsquo;s chat.</p>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="button button-solid" disabled={submitting}>
        {submitting ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}
