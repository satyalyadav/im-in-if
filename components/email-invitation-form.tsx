"use client";

import { useEffect, useId, useRef, useState } from "react";

type Invitation = {
  id: string;
  recipientEmail: string;
  status: "pending" | "sending" | "sent" | "failed" | "disabled";
  errorCode: string | null;
  accepted: boolean;
};

function statusText(invitation: Invitation): string {
  if (invitation.accepted) return "Admitted";
  if (invitation.status === "sent") {
    return "Email provider accepted the request. Delivery is not confirmed.";
  }
  if (invitation.status === "pending") return "Invitation email is pending.";
  if (invitation.status === "sending") return "Sending invitation email.";
  if (invitation.status === "disabled") return "Email is disabled or not configured. No email was sent.";
  if (invitation.errorCode === "delivery_unknown") {
    return "Delivery is unknown. This request will not be sent again.";
  }
  if (invitation.errorCode === "provider_request_failed") {
    return "The send result is unknown. The email may still arrive.";
  }
  if (invitation.errorCode === "retry_limit") return "The send retry limit was reached.";
  return "The email provider did not accept the request. You can retry this request.";
}

export function EmailInvitationForm({ outingId }: { outingId: string }) {
  const id = useId();
  const request = useRef<{ email: string; id: string } | null>(null);
  const [email, setEmail] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let current = true;
    void fetch(`/api/outings/${encodeURIComponent(outingId)}/email-invitations`, {
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { invitations?: Invitation[] };
      if (current) setInvitations(data.invitations ?? []);
    }).catch(() => {
      if (current) setError("Invitation status could not be loaded.");
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [outingId]);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return;
    if (!request.current || request.current.email !== normalizedEmail) {
      request.current = { email: normalizedEmail, id: crypto.randomUUID() };
    }

    setSending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/outings/${encodeURIComponent(outingId)}/email-invitations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), requestId: request.current.id }),
        },
      );
      const data = await response.json().catch(() => null) as
        | { invitation?: Invitation; error?: string }
        | null;
      if (!response.ok || !data?.invitation) {
        setError(data?.error === "outing_not_active"
          ? "This outing has ended."
          : "The invitation could not be saved. Check the address and try again.");
        return;
      }
      setInvitations((current) => [
        data.invitation!,
        ...current.filter((item) => item.id !== data.invitation!.id),
      ]);
      setAnnouncement(`${data.invitation.recipientEmail}. ${statusText(data.invitation)}`);
      setEmail("");
      request.current = null;
    } catch {
      setError("The connection dropped. Retry with the same address to check this request.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="email-invitation-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Invite by email</h2>
      <p className="invite-help">
        Your friend joins with the same verified email address. Admission does not record interest or attendance.
      </p>
      <form className="email-invitation-form" onSubmit={invite}>
        <label htmlFor={`${id}-email`}>Friend&rsquo;s email address</label>
        <div className="email-invitation-row">
          <input
            id={`${id}-email`}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={320}
            autoComplete="email"
            required
          />
          <button className="button button-solid" type="submit" disabled={sending}>
            {sending ? "Sending…" : "Invite"}
          </button>
        </div>
      </form>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading ? <p className="hint">Loading invitation status.</p> : null}
      {invitations.length > 0 ? (
        <ul className="email-invitation-list">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span>{invitation.recipientEmail}</span>
              <small>{statusText(invitation)}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
