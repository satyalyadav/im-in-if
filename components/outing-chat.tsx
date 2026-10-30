"use client";

import { useEffect, useRef, useState } from "react";
import { formatViewerDateTime, formatViewerTime, formatZonedTime } from "@/lib/cutoff";
import type { MessageView, OutingView } from "@/lib/outings-api";

const ERROR_COPY: Record<string, string> = {
  timeout: "Your agent took too long to answer. Your message is saved.",
  model_error: "Your agent could not answer. Your message is saved.",
  empty_reply: "Your agent sent an empty reply. Your message is saved.",
  unavailable: "The agent is not configured yet.",
  unauthorized: "Sign in again to send this message.",
  not_found: "This outing is no longer available.",
  invalid_input: "That message could not be sent.",
  stale_reply: "Your conditions changed while the agent was replying. Continue in the latest chat turn.",
};

function timeLabel(iso: string, timeZone: string | null): string {
  const instant = new Date(iso);
  return timeZone ? formatZonedTime(instant, timeZone) : formatViewerTime(instant);
}

type Props = {
  outing: OutingView;
  initialMessages: MessageView[];
  showPlaybill?: boolean;
  onConversationUpdate?: () => Promise<void> | void;
};

export function OutingChat({ outing, initialMessages, showPlaybill = true, onConversationUpdate }: Props) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerCutoff, setViewerCutoff] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const idempotency = useRef<{ content: string; id: string } | null>(null);
  const onConversationUpdateRef = useRef(onConversationUpdate);

  useEffect(() => {
    onConversationUpdateRef.current = onConversationUpdate;
  }, [onConversationUpdate]);

  useEffect(() => {
    setMessages((current) => {
      const localPending = current.filter((message) =>
        message.id.startsWith("local-") &&
        !initialMessages.some((saved) => saved.role === "user" && saved.content === message.content),
      );
      return [...initialMessages, ...localPending];
    });
  }, [initialMessages, outing.id]);

  const hasPendingTurn = messages.some((message) => message.status === "pending");

  async function refresh(): Promise<MessageView[]> {
    try {
      const response = await fetch(`/api/outings/${outing.id}`, { cache: "no-store" });
      if (!response.ok) return messages;
      const data = (await response.json()) as { messages?: MessageView[] };
      if (data.messages) {
        const changed = JSON.stringify(data.messages) !== JSON.stringify(messages);
        setMessages(data.messages);
        if (changed) await onConversationUpdateRef.current?.();
        return data.messages;
      }
    } catch {
      // The next poll or reload will try again.
    }
    return messages;
  }

  useEffect(() => {
    setViewerCutoff(outing.cutoffAt ? formatViewerDateTime(new Date(outing.cutoffAt)) : null);
  }, [outing.cutoffAt]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outing.id]);

  useEffect(() => {
    if (!hasPendingTurn) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPendingTurn]);

  useEffect(() => {
    if (!hasPendingTurn) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), 90_000);
    return () => clearTimeout(timer);
  }, [hasPendingTurn]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;

    if (!idempotency.current || idempotency.current.content !== content) {
      idempotency.current = { content, id: crypto.randomUUID() };
    }
    const clientMessageId = idempotency.current.id;

    setSending(true);
    setError(null);
    setDraft("");
    setMessages((current) => [
      ...current,
      {
        id: `local-${clientMessageId}`,
        role: "user",
        content,
        status: "pending",
        errorCode: null,
        replyToMessageId: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const response = await fetch(`/api/outings/${outing.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId, content }),
      });
      const data = (await response.json().catch(() => null)) as
        | { messages?: MessageView[]; error?: string }
        | null;

      let saved = false;
      if (data?.messages) {
        setMessages(data.messages);
        await onConversationUpdateRef.current?.();
        idempotency.current = null;
        saved = true;
      } else {
        const latest = await refresh();
        saved = latest.some(
          (message) => message.role === "user" && message.content === content,
        );
        if (saved || response.status === 502) {
          idempotency.current = null;
        }
      }

      if (!response.ok && response.status !== 202) {
        if (!saved && response.status !== 502) setDraft(content);
        setError(
          ERROR_COPY[data?.error ?? ""] ??
            (saved
              ? "Your agent did not answer. Your message is saved."
              : "Your message was not sent. Try again."),
        );
      }
    } catch {
      setError("The connection dropped. Check the conversation before sending again.");
      const latest = await refresh();
      const saved = latest.some(
        (message) => message.role === "user" && message.content === content,
      );
      if (!saved) {
        setDraft(content);
      } else {
        idempotency.current = null;
      }
    } finally {
      setSending(false);
    }
  }

  async function retry(messageId: string) {
    if (retrying) return;
    setRetrying(messageId);
    setError(null);

    try {
      const response = await fetch(
        `/api/outings/${outing.id}/messages/${messageId}/retry`,
        { method: "POST" },
      );
      const data = (await response.json().catch(() => null)) as
        | { messages?: MessageView[]; error?: string }
        | null;

      if (data?.messages) {
        setMessages(data.messages);
        await onConversationUpdateRef.current?.();
      }
      else await refresh();

      if (!response.ok && response.status !== 409) {
        setError(ERROR_COPY[data?.error ?? ""] ?? "Your agent did not answer. Try again.");
      }
    } catch {
      setError("The connection dropped. Your message is still saved.");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className={showPlaybill ? "outing-layout" : "outing-layout outing-layout-compact"}>
      {showPlaybill ? <aside className="playbill">
        <p className="playbill-kicker">Your outing</p>
        <h1>{outing.suggestion}</h1>

        {outing.cutoffAt && outing.cutoffDisplay ? (
          <div className="cutoff-card">
            <p className="cutoff-label">Replies stop counting</p>
            <time dateTime={outing.cutoffAt}>{outing.cutoffDisplay}</time>
            {viewerCutoff && viewerCutoff !== outing.cutoffDisplay ? (
              <p className="viewer-time">In your time zone: {viewerCutoff}</p>
            ) : null}
          </div>
        ) : (
          <p className="no-cutoff-note">No response cutoff. Silence will not exclude anyone.</p>
        )}

        <p className="privacy-note">
          Only you and your agent can read this chat. It belongs to this outing alone.
        </p>
      </aside> : null}

      <section className="chat" aria-label="Private chat with your agent">
        <header className="chat-head">
          <span>Private chat</span>
          <span className="chat-agent">Your agent</span>
        </header>

        <div className="messages" ref={listRef} role="log" aria-live="polite">
          {messages.length === 0 ? (
            <p className="empty">
              What would make this night work for you? Tell me what you know, and I'll ask about anything unclear.
            </p>
          ) : null}

          {messages.map((message) => {
            const retryable = !message.id.startsWith("local-");

            return (
              <article
                key={message.id}
                className={`message message-${message.role}`}
                aria-label={message.role === "user" ? "You" : "Your agent"}
              >
                <p className="sender">
                  {message.role === "user" ? "You" : "Your agent"}
                  <span className="message-time">
                    {timeLabel(message.createdAt, outing.cutoffTimeZone)}
                  </span>
                </p>
                <div className="bubble">{message.content}</div>

                {message.role === "user" && message.status === "pending" ? (
                  <>
                    <p className="thinking">
                      <span className="thinking-dot" aria-hidden="true" />
                      {stalled
                        ? "Still waiting for your agent."
                        : "Your agent is thinking. This can take a moment."}
                    </p>
                    {stalled ? (
                      <p className="turn-error">
                        {retryable
                          ? "No reply yet."
                          : "Still sending. Check your connection."}
                        {retryable ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => retry(message.id)}
                            disabled={retrying === message.id}
                          >
                            {retrying === message.id ? "Asking again…" : "Ask again"}
                          </button>
                        ) : null}
                      </p>
                    ) : null}
                  </>
                ) : null}

                {message.role === "user" && message.status === "failed" ? (
                  <p className="turn-error">
                    Your message is saved.
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => retry(message.id)}
                      disabled={retrying === message.id}
                    >
                      {retrying === message.id ? "Asking again…" : "Ask again"}
                    </button>
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>

        {error ? (
          <p className="chat-error" role="alert">
            {error}
          </p>
        ) : null}

        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="draft">
            Message your agent
          </label>
          <textarea
            id="draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Say what you are actually thinking…"
            rows={2}
            maxLength={4000}
          />
          <button
            type="submit"
            className="button button-solid"
            disabled={sending || draft.trim().length === 0}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </div>
  );
}
