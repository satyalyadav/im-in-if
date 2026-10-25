"use client";

import { useId, useState } from "react";

type AdmissionStatus = "not_requested" | "pending" | "rejected" | "admitted";

const statusCopy: Record<AdmissionStatus, string> = {
  not_requested: "Ask the person who started the outing to let you in.",
  pending: "Your request is waiting. You will not see outing details until you are admitted.",
  rejected: "The starter declined this request.",
  admitted: "You have been admitted.",
};

export function InvitationRequestForm({
  token,
  initialStatus,
  verifiedEmails,
}: {
  token: string;
  initialStatus: AdmissionStatus;
  verifiedEmails: string[];
}) {
  const id = useId();
  const [status, setStatus] = useState<AdmissionStatus>(initialStatus);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState(verifiedEmails[0] ?? "");
  const [emailOptIn, setEmailOptIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkStatus() {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | { status?: AdmissionStatus; outingId?: string; error?: string }
        | null;
      if (response.ok && data?.status === "admitted" && data.outingId) {
        window.location.assign(`/outings/${data.outingId}`);
        return;
      }
      if (response.ok && data?.status) setStatus(data.status);
      else setError("This invitation is no longer available.");
    } catch {
      setError("Could not check the invitation. Try again.");
    } finally {
      setChecking(false);
    }
  }

  async function requestAdmission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName,
          emailOptIn,
          email: emailOptIn ? email : null,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { status?: AdmissionStatus; error?: string }
        | null;
      if (!response.ok || !data?.status) {
        setError(data?.error === "invalid_input" ? "Check your name and email." : "Could not send the request.");
        return;
      }
      setStatus(data.status);
    } catch {
      setError("The connection dropped. Check the request status before trying again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="invitation-card" aria-labelledby={`${id}-title`}>
      <p className="playbill-kicker">Private invitation</p>
      <h1 id={`${id}-title`}>Request to join</h1>
      <p>{statusCopy[status]}</p>

      {status === "not_requested" ? (
        <form className="planning-form" onSubmit={requestAdmission}>
          <div className="field">
            <label htmlFor={`${id}-name`}>Name the starter will recognize</label>
            <input
              id={`${id}-name`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={64}
              autoComplete="name"
              required
            />
          </div>
          <fieldset className="email-choice">
            <legend>Email updates</legend>
            {verifiedEmails.length > 0 ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={emailOptIn}
                  onChange={(event) => setEmailOptIn(event.target.checked)}
                />
                <span>Send updates to an email verified on your signed-in account.</span>
              </label>
            ) : (
              <p className="hint">Add and verify an email on your account to opt in to email updates.</p>
            )}
            {emailOptIn ? (
              <div className="field">
                <label htmlFor={`${id}-email`}>Verified account email</label>
                <select
                  id={`${id}-email`}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                >
                  {verifiedEmails.map((address) => (
                    <option key={address} value={address}>{address}</option>
                  ))}
                </select>
                <p className="hint">Each email contains a short sign-in link, not outing details.</p>
              </div>
            ) : null}
          </fieldset>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="button button-solid" disabled={submitting}>
            {submitting ? "Sending request…" : "Request admission"}
          </button>
        </form>
      ) : (
        <div className="invitation-actions">
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button type="button" className="button button-solid" onClick={() => void checkStatus()} disabled={checking}>
            {checking ? "Checking…" : "Check request status"}
          </button>
        </div>
      )}
    </section>
  );
}
