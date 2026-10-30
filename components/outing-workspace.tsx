"use client";

import { useEffect, useMemo, useState } from "react";
import { formatViewerDateTime, formatZonedDateTime } from "@/lib/cutoff";
import { OutingChat } from "@/components/outing-chat";
import type { MessageView, OutingView } from "@/lib/outings-api";
import {
  type CatalogOption,
  type ConditionInterpretation,
  type PublicOffer,
  type PublicParticipant,
} from "@/lib/planning-types";

type ProposalView = {
  id: string;
  revision: number;
  optionId: string;
  activity: string;
  startsAt: string;
  estimatedCostCents: number;
  attendeeUserIds: string[];
  status: string;
  kind: string;
  publishedAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  approvalCount: number;
};

export type Workspace = {
  viewerUserId: string;
  outing: {
    id: string;
    suggestion: string;
    cutoffAt: string | null;
    cutoffTimeZone: string | null;
    inviteToken: string | null;
    status: string;
    cutoffProcessedAt: string | null;
    endedAt: string | null;
    isStarter: boolean;
    createdAt: string;
  };
  participants: PublicParticipant[];
  pendingAdmissions: Array<{ userId: string; displayName: string; requestedAt: string }>;
  options: CatalogOption[];
  myConditions: ConditionInterpretation | null;
  myConditionsReady: boolean;
  myRankings: string[];
  myResponseStatus: string;
  messages: MessageView[];
  offers: PublicOffer[];
  myDraftOffers: Array<PublicOffer & { optionTitle: string; privateNote: string }>;
  proposal: ProposalView | null;
  myProposalApproved: boolean;
  confirmedProposal: ProposalView | null;
  expiredProposal: ProposalView | null;
  myJoinRequest: { status: string } | null;
  myDepartureRequest: { status: string } | null;
  myTiePoll: null | {
    id: string;
    optionA: CatalogOption | null;
    optionB: CatalogOption | null;
    status: string;
    outcome: string | null;
    selectedOptionId: string | null;
    myAnswer: "a" | "b" | "either" | null;
    answeredCount: number;
    participantCount: number;
    createdAt: string;
  };
  notifications: Array<{
    id: string;
    kind: string;
    actorName: string | null;
    createdAt: string;
  }>;
  myEmailEvents: Array<{ eventType: string; status: string; errorCode: string | null }>;
  myEmailOptIn: boolean;
  myNotificationEmail: string | null;
  myVerifiedEmails: string[];
  emailProviderConfigured: boolean;
};

type Action = Record<string, unknown> & { action: string };
type ActionRunner = (action: Action) => Promise<boolean>;

const ERROR_COPY: Record<string, string> = {
  agent_unavailable: "Your agent is not available on this deployment.",
  usage_not_included: "The provider did not confirm zero-cost Go usage. No response was accepted.",
  conditions_need_review: "Tell your agent what would make this outing work before responding.",
  confirmed_conditions_locked: "Conditions are locked for the confirmed plan. Request to leave if it no longer works for you.",
  response_cutoff_passed: "The response cutoff has passed.",
  response_changed: "Your interest response changed elsewhere. Refresh and review it before trying again.",
  offer_not_feasible: "That offer conflicts with one or more strict conditions.",
  option_unavailable: "That draft uses an option that is no longer available. Ask your agent for a new offer or add a manual option.",
  no_options: "Add an option with a date, time, and estimated cost, or ask your agent to draft one from your private chat.",
  clarification_required: "Answer the question in your private chat, then ask your agent for an offer again.",
  tie_options_not_feasible: "Both options must satisfy every attendee's strict conditions.",
  proposal_expired: "This proposal expired without reshuffling the attendee list.",
  proposal_already_active: "A plan is already waiting for approval. Its deadline and approvals stayed unchanged. Finish or wait for that request before starting another.",
  proposal_not_current: "This proposal was replaced by a newer revision.",
  activity_already_started: "This activity has already started.",
  verified_email_required: "Choose an email verified on your signed-in account.",
  outing_not_active: "This outing has ended.",
  email_unconfigured: "Email updates are opted in, but email delivery is not configured.",
  email_invalid_base_url: "Email delivery needs a valid secure return-link address.",
  tie_choice_required: "This offer must follow the private tie result for the same people.",
  counter_offer_target_unavailable: "Choose a published offer from another participant to counter.",
  plan_changed: "The confirmed attendee list changed while this request was being saved. Review the latest plan and try again.",
  departure_not_feasible: "The remaining attendees cannot use this plan under their strict conditions. Your departure request was not applied.",
  agreement_still_open: "A proposal or private tie follow-up is still open, or your interest has not been recorded.",
  tie_needs_two_interested_people: "At least two interested people are needed for a private tie follow-up.",
};

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function dateTime(value: string, timeZone: string | null): string {
  const instant = new Date(value);
  return timeZone ? formatZonedDateTime(instant, timeZone) : formatViewerDateTime(instant);
}

function tagsFromText(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function sameAttendees(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((userId, index) => userId === sortedRight[index]);
}

function errorText(code: string): string {
  return ERROR_COPY[code] ?? "That change could not be saved. Review it and try again.";
}

function PlannerButton({
  children,
  disabled,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button className="button button-solid planner-button" type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function CatalogPanel({ workspace, busy, act }: { workspace: Workspace; busy: boolean; act: ActionRunner }) {
  const [title, setTitle] = useState("");
  const [activity, setActivity] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [cost, setCost] = useState("");
  const [tags, setTags] = useState("");
  const ordered = useMemo(() => {
    const rank = new Map(workspace.myRankings.map((id, index) => [id, index]));
    return [...workspace.options].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  }, [workspace.options, workspace.myRankings]);

  function moveRank(optionId: string, direction: -1 | 1) {
    const ids = [...workspace.myRankings.filter((id) => workspace.options.some((option) => option.id === id))];
    if (!ids.includes(optionId)) ids.push(optionId);
    const index = ids.indexOf(optionId);
    const next = index + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void act({ action: "rank_options", optionIds: ids });
  }

  async function addOption(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const starts = new Date(startsAt);
    if (!Number.isFinite(starts.getTime())) return;
    const ok = await act({
      action: "add_option", title, activity, startsAt: starts.toISOString(),
      estimatedCostCents: Math.round(Number(cost) * 100), activityTags: tagsFromText(tags),
    });
    if (ok) { setTitle(""); setActivity(""); setStartsAt(""); setCost(""); setTags(""); }
  }

  return (
    <section className="planner-card" aria-labelledby="catalog-title">
      <p className="playbill-kicker">Shared options</p>
      <h2 id="catalog-title">The catalog</h2>
      <p className="planner-help">Add a shared option that fits this outing, or ask your agent to draft one from your private chat.</p>
      {workspace.options.length === 0 ? <p className="empty-light">No shared options yet. Your agent can draft one privately, or you can add a manual option for the group.</p> : null}
      <ol className="option-list">
        {ordered.map((option) => {
          const rank = workspace.myRankings.indexOf(option.id);
          return (
            <li className="option-card" key={option.id}>
              <div className="option-heading">
                <div><h3>{option.title}</h3><p>{option.activity}</p></div>
                <span className="source-tag source-manual">{option.source === "agent" ? "Agent drafted" : "Manual"}</span>
              </div>
              <p className="option-meta">{dateTime(option.startsAt, workspace.outing.cutoffTimeZone)} · Estimated {money(option.estimatedCostCents)} per person</p>
              {option.activityTags.length ? <p className="tag-list">{option.activityTags.join(" · ")}</p> : null}
              <div className="rank-actions">
                {rank < 0 ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void act({
                      action: "rank_options",
                      optionIds: [...workspace.myRankings.filter((id) => workspace.options.some((item) => item.id === id)), option.id],
                    })}
                  >
                    Rank this option
                  </button>
                ) : null}
                <span>{rank < 0 ? "Not ranked" : `Your rank: ${rank + 1}`}</span>
                <button type="button" className="text-button" onClick={() => moveRank(option.id, -1)} aria-label={`Move ${option.title} up in your ranking`}>Move up</button>
                <button type="button" className="text-button" onClick={() => moveRank(option.id, 1)} aria-label={`Move ${option.title} down in your ranking`}>Move down</button>
              </div>
            </li>
          );
        })}
      </ol>
      <details className="manual-option">
        <summary>Add a manual option</summary>
        <form className="planning-form" onSubmit={addOption}>
          <div className="field"><label htmlFor="option-title">Short title</label><input id="option-title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          <div className="field"><label htmlFor="option-activity">Activity</label><input id="option-activity" required maxLength={80} value={activity} onChange={(event) => setActivity(event.target.value)} /></div>
          <div className="field"><label htmlFor="option-start">Start time in your browser time zone</label><input id="option-start" type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></div>
          <div className="field"><label htmlFor="option-cost">Estimated cost per person (USD)</label><input id="option-cost" type="number" min="0" max="1000" step="0.01" required value={cost} onChange={(event) => setCost(event.target.value)} /></div>
          <div className="field"><label htmlFor="option-tags">Activity tags (comma separated)</label><input id="option-tags" maxLength={300} value={tags} onChange={(event) => setTags(event.target.value)} /></div>
          <PlannerButton type="submit" disabled={busy}>Add option</PlannerButton>
        </form>
      </details>
    </section>
  );
}

function OfferPanel({ workspace, busy, act }: { workspace: Workspace; busy: boolean; act: ActionRunner }) {
  const canRequestConfirmation = !workspace.outing.endedAt && !workspace.confirmedProposal;
  async function publishDraftAndRequestConfirmation(offerId: string) {
    const published = await act({ action: "publish_offer", offerId });
    if (published) await act({ action: "publish_proposal", offerId });
  }
  return (
    <section className="planner-card" aria-labelledby="offers-title">
      <p className="playbill-kicker">Negotiation</p>
      <h2 id="offers-title">Offers from the group</h2>
      <p className="planner-help">A private draft stays visible only to you. Publishing it shares the offer and asks every proposed attendee, including its owner, to approve the exact plan. The response cutoff closes interest collection, not confirmation.</p>
      {workspace.myConditionsReady && workspace.myResponseStatus === "interested" ? (
        <PlannerButton disabled={busy} onClick={() => void act({ action: "generate_offer" })}>
          Ask agent for an offer
        </PlannerButton>
      ) : <p className="empty-light">Tell your agent what would make this outing work, then choose “I’m interested” to draft an offer.</p>}

      {workspace.myDraftOffers.map((offer) => (
        <article className="offer-card offer-private" key={offer.id}>
          <p className="playbill-kicker">Your private draft</p>
          <h3>{offer.optionTitle}</h3>
          <p>{offer.activity}</p>
          <p>{dateTime(offer.startsAt, workspace.outing.cutoffTimeZone)} · Estimated {money(offer.estimatedCostCents)} per person</p>
          {offer.privateNote ? <p className="private-note">Only you see this note: {offer.privateNote}</p> : null}
          <PlannerButton disabled={busy} onClick={() => void publishDraftAndRequestConfirmation(offer.id)}>Publish and ask everyone to confirm</PlannerButton>
        </article>
      ))}

      {workspace.offers.length ? (
        <div className="offer-list">
          {workspace.offers.map((offer) => {
            const owner = workspace.participants.find((person) => person.userId === offer.ownerUserId);
            const activeProposal = workspace.proposal;
            const matchesActiveProposal = activeProposal &&
              activeProposal.optionId === offer.optionId &&
              activeProposal.activity === offer.activity &&
              new Date(activeProposal.startsAt).getTime() === new Date(offer.startsAt).getTime() &&
              activeProposal.estimatedCostCents === offer.estimatedCostCents &&
              sameAttendees(activeProposal.attendeeUserIds, offer.attendeeUserIds);
            return (
              <article className="offer-card" key={offer.id}>
                <p className="playbill-kicker">Offer from {owner?.displayName ?? "a participant"}</p>
                <h3>{offer.activity}</h3>
                <p>{dateTime(offer.startsAt, workspace.outing.cutoffTimeZone)} · Estimated {money(offer.estimatedCostCents)} per person</p>
                {offer.counterOfferToId ? (
                  <p className="hint dark-hint">
                    Counteroffer to {workspace.offers.find((item) => item.id === offer.counterOfferToId)?.activity ?? "a published offer"}
                  </p>
                ) : null}
                <p>{offer.attendeeUserIds.length} proposed attendee{offer.attendeeUserIds.length === 1 ? "" : "s"}</p>
                {canRequestConfirmation && activeProposal && !matchesActiveProposal ? (
                  <details className="replace-proposal">
                    <summary>Replace the plan waiting for approval</summary>
                    <p className="planner-help">This creates a new revision. Everyone on the new attendee list must approve it. Current approvals will not carry over.</p>
                    <PlannerButton disabled={busy} onClick={() => void act({
                      action: "replace_proposal",
                      proposalId: activeProposal.id,
                      offerId: offer.id,
                    })}>Replace the plan and ask everyone again</PlannerButton>
                  </details>
                ) : null}
                {canRequestConfirmation && (!activeProposal || matchesActiveProposal) ? (
                  <PlannerButton disabled={busy} onClick={() => void act({ action: "publish_proposal", offerId: offer.id })}>
                    Ask everyone to confirm this plan
                  </PlannerButton>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : <p className="empty-light">Published offers appear here. Each person’s draft and private note stay private.</p>}
      {!workspace.confirmedProposal && !workspace.outing.endedAt ? <p className="hint dark-hint">You can ask everyone to confirm a published offer before or after the response cutoff.</p> : null}
    </section>
  );
}

function AgreementPanel({ workspace, busy, act }: { workspace: Workspace; busy: boolean; act: ActionRunner }) {
  const { proposal, confirmedProposal, expiredProposal, myTiePoll } = workspace;
  const tieOptions = workspace.options.slice(0, 2);

  return (
    <section className="planner-card" aria-labelledby="agreement-title">
      <p className="playbill-kicker">People decide</p>
      <h2 id="agreement-title">Confirmation</h2>
      {proposal ? (
        <article className="proposal-card" aria-label={`Proposal revision ${proposal.revision}`}>
          <p className="playbill-kicker">Revision {proposal.revision} · Confirm before {dateTime(proposal.expiresAt, workspace.outing.cutoffTimeZone)}</p>
          <h3>{proposal.activity}</h3>
          <p>{dateTime(proposal.startsAt, workspace.outing.cutoffTimeZone)} · Estimated {money(proposal.estimatedCostCents)} per person</p>
          <p>{proposal.attendeeUserIds.length} proposed attendee{proposal.attendeeUserIds.length === 1 ? "" : "s"} · {proposal.approvalCount} approval{proposal.approvalCount === 1 ? "" : "s"}</p>
          <p className="hint dark-hint">Attendees: {proposal.attendeeUserIds.map((id) => workspace.participants.find((person) => person.userId === id)?.displayName ?? "A participant").join(", ")}</p>
          {proposal.attendeeUserIds.includes(workspace.participants.find((p) => p.userId)?.userId ?? "") ? null : null}
          {proposal.attendeeUserIds.includes(workspace.viewerUserId) ? (
            workspace.myProposalApproved
              ? <p className="condition-status" role="status">You confirmed this revision. It still needs every listed person.</p>
              : <PlannerButton disabled={busy} onClick={() => void act({ action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision })}>Confirm this exact plan</PlannerButton>
          ) : <p className="hint dark-hint">You are not on this proposal’s attendee list.</p>}
          <p className="hint dark-hint">A material change creates a new revision and asks everyone again.</p>
        </article>
      ) : null}
      {expiredProposal && !confirmedProposal ? (
        <article className="proposal-card">
          <p className="playbill-kicker">Revision {expiredProposal.revision} expired</p>
          <p>No roster changes were made. An admitted participant can request a fresh confirmation.</p>
          <PlannerButton disabled={busy} onClick={() => void act({ action: "restart_proposal", proposalId: expiredProposal.id })}>Ask everyone again</PlannerButton>
        </article>
      ) : null}
      {confirmedProposal ? (
        <article className="proposal-card proposal-confirmed">
          <p className="playbill-kicker">Confirmed plan</p>
          <h3>{confirmedProposal.activity}</h3>
          <p>{dateTime(confirmedProposal.startsAt, workspace.outing.cutoffTimeZone)} · Estimated {money(confirmedProposal.estimatedCostCents)} per person</p>
          <p className="hint dark-hint">Attendees: {confirmedProposal.attendeeUserIds.map((id) => workspace.participants.find((person) => person.userId === id)?.displayName ?? "A participant").join(", ")}</p>
          <p>Everyone on this roster approved revision {confirmedProposal.revision}.</p>
          {!confirmedProposal.attendeeUserIds.includes(workspace.viewerUserId) ? (
            <PlannerButton disabled={busy || Boolean(workspace.myJoinRequest && ["pending", "proposed"].includes(workspace.myJoinRequest.status))} onClick={() => void act({ action: "request_join" })}>
              Request to join this plan
            </PlannerButton>
          ) : (
            <PlannerButton disabled={busy || Boolean(workspace.myDepartureRequest && ["pending", "proposed"].includes(workspace.myDepartureRequest.status))} onClick={() => void act({ action: "request_departure" })}>
              Request to leave the roster
            </PlannerButton>
          )}
          {workspace.myJoinRequest ? <p className="hint dark-hint">Your join request: {workspace.myJoinRequest.status}.</p> : null}
          {workspace.myDepartureRequest ? <p className="hint dark-hint">Your departure request: {workspace.myDepartureRequest.status}.</p> : null}
        </article>
      ) : null}
      {myTiePoll ? (
        <article className="tie-card">
          <p className="playbill-kicker">Private tie follow-up</p>
          <p>Choose A, B, or either. Only your answer is shown to you.</p>
          <div className="tie-options">
            <p><strong>A.</strong> {myTiePoll.optionA?.title ?? "Option unavailable"}</p>
            <p><strong>B.</strong> {myTiePoll.optionB?.title ?? "Option unavailable"}</p>
          </div>
          {myTiePoll.status === "open" && !myTiePoll.myAnswer ? (
            <div className="planner-actions">
              {(["a", "b", "either"] as const).map((answer) => (
                <PlannerButton key={answer} disabled={busy} onClick={() => void act({ action: "answer_tie", pollId: myTiePoll.id, answer })}>
                  {answer === "either" ? "Either works" : `Choose ${answer.toUpperCase()}`}
                </PlannerButton>
              ))}
            </div>
          ) : <p className="condition-status" role="status">Your answer: {myTiePoll.myAnswer ?? "not recorded"} · {myTiePoll.answeredCount} of {myTiePoll.participantCount} answered.</p>}
          {myTiePoll.status === "no_agreement" ? <p>No option received a compatible set of private answers.</p> : null}
        </article>
      ) : null}
      {!proposal && !confirmedProposal && !expiredProposal && !myTiePoll ? (
        <p className="empty-light">No plan is waiting for approval. Publish a private draft or ask everyone to confirm one of the published offers above.</p>
      ) : null}
      {workspace.outing.cutoffProcessedAt && !proposal && !confirmedProposal && tieOptions.length >= 2 && workspace.myResponseStatus === "interested" ? (
        <details className="tie-setup">
          <summary>Ask for a private A/B tie follow-up</summary>
          <p className="planner-help">Each person answers once. If everyone chooses either, the result is still only a candidate plan.</p>
          <PlannerButton disabled={busy} onClick={() => void act({
            action: "start_tie_poll", optionAId: tieOptions[0].id, optionBId: tieOptions[1].id,
          })}>Start tie follow-up for interested people</PlannerButton>
        </details>
      ) : null}
      {workspace.outing.cutoffProcessedAt && !confirmedProposal && !proposal ? (
        <PlannerButton disabled={busy} onClick={() => void act({ action: "declare_no_agreement" })}>End without an agreement</PlannerButton>
      ) : null}
      {workspace.outing.isStarter && !workspace.outing.endedAt ? (
        <PlannerButton disabled={busy} onClick={() => void act({ action: "end_outing" })}>End this outing</PlannerButton>
      ) : null}
    </section>
  );
}

function EmailPanel({ workspace, busy, act }: { workspace: Workspace; busy: boolean; act: ActionRunner }) {
  const [optIn, setOptIn] = useState(workspace.myEmailOptIn);
  const [email, setEmail] = useState(workspace.myNotificationEmail ?? workspace.myVerifiedEmails[0] ?? "");
  useEffect(() => {
    setOptIn(workspace.myEmailOptIn);
    setEmail(workspace.myNotificationEmail ?? workspace.myVerifiedEmails[0] ?? "");
  }, [workspace.myEmailOptIn, workspace.myNotificationEmail, workspace.myVerifiedEmails.join("|")]);

  return (
    <section className="planner-card" aria-labelledby="email-title">
      <p className="playbill-kicker">Optional email</p>
      <h2 id="email-title">Email updates</h2>
      <p className="planner-help">Only admission and final confirmation. Emails contain no planning details.</p>
      <label className="check-row">
        <input type="checkbox" checked={optIn} disabled={workspace.myVerifiedEmails.length === 0}
          onChange={(event) => setOptIn(event.target.checked)} />
        <span>Send me opted-in planning updates</span>
      </label>
      {optIn && workspace.myVerifiedEmails.length > 0 ? (
        <div className="field">
          <label htmlFor="my-verified-email">Verified email on your account</label>
          <select id="my-verified-email" value={email} onChange={(event) => setEmail(event.target.value)}>
            {workspace.myVerifiedEmails.map((address) => <option key={address} value={address}>{address}</option>)}
          </select>
        </div>
      ) : null}
      {workspace.myVerifiedEmails.length === 0 ? <p className="hint">Add and verify an email on your sign-in account to opt in.</p> : null}
      <PlannerButton disabled={busy} onClick={() => void act({
        action: "save_email_preferences", emailOptIn: optIn, email: optIn ? email : null,
      })}>Save email preference</PlannerButton>
      {!workspace.emailProviderConfigured ? <p className="hint dark-hint">Email provider setup is incomplete. In-app notices still appear here.</p> : null}
      {workspace.myEmailEvents.length ? (
        <ul className="email-events">
          {workspace.myEmailEvents.map((event, index) => <li key={`${event.eventType}-${index}`}>{event.eventType.replaceAll("_", " ")}: {event.errorCode ?? event.status}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

export function OutingWorkspace({ initialWorkspace }: { initialWorkspace: Workspace }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const response = await fetch(`/api/outings/${workspace.outing.id}`, { cache: "no-store" });
      if (!response.ok) return;
      setWorkspace(await response.json() as Workspace);
    } catch {
      // The next refresh or page interaction will try again.
    }
  }

  useEffect(() => {
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.outing.id]);

  async function act(action: Action): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/outings/${workspace.outing.id}/planning`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const data = await response.json().catch(() => null) as (Workspace & { error?: string; question?: string }) | null;
      if (!response.ok) {
        setError(data?.error === "clarification_required" && data.question
          ? `${data.question} Reply in your private chat, then ask your agent again.`
          : errorText(data?.error ?? "unknown"));
        if (response.status === 409) void refresh();
        return false;
      }
      setWorkspace(data as Workspace);
      return true;
    } catch {
      setError("The connection dropped. Refresh to check whether your change was saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const outing: OutingView = {
    ...workspace.outing,
    cutoffDisplay: workspace.outing.cutoffAt && workspace.outing.cutoffTimeZone
      ? formatZonedDateTime(new Date(workspace.outing.cutoffAt), workspace.outing.cutoffTimeZone)
      : null,
  };
  const latestNotification = workspace.notifications[0];

  return (
    <div className="workspace-layout">
      <aside className="playbill">
        <p className="playbill-kicker">Your outing</p>
        <h1>{workspace.outing.suggestion}</h1>
        <p className="planner-status">{workspace.outing.status.replaceAll("_", " ")}</p>
        <div className="participant-summary">
          <p className="cutoff-label">Admitted people</p>
          <ul>{workspace.participants.map((person) => <li key={person.userId}>{person.displayName}</li>)}</ul>
        </div>
        {workspace.outing.inviteToken ? (
          <div className="invite-link-card">
            <label htmlFor="invite-url">Invite link</label>
            <input id="invite-url" readOnly value={`/invite/${workspace.outing.inviteToken}`} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="text-button" onClick={() => {
              void navigator.clipboard.writeText(`${window.location.origin}/invite/${workspace.outing.inviteToken}`);
            }}>Copy invitation link</button>
            <p className="hint dark-hint">The link only requests admission. The starter decides who can see the outing.</p>
          </div>
        ) : null}
        {workspace.outing.isStarter && workspace.pendingAdmissions.length > 0 ? (
          <section className="admission-list" aria-labelledby="admission-title">
            <h2 id="admission-title">Requests to join</h2>
            {workspace.pendingAdmissions.map((request) => (
              <article className="admission-request" key={request.userId}>
                <strong>{request.displayName}</strong>
                <div className="planner-actions">
                  <PlannerButton disabled={busy} onClick={() => void act({ action: "decide_admission", userId: request.userId, decision: "admit" })}>Admit</PlannerButton>
                  <button className="text-button" type="button" disabled={busy} onClick={() => void act({ action: "decide_admission", userId: request.userId, decision: "reject" })}>Decline</button>
                </div>
              </article>
            ))}
          </section>
        ) : null}
        <p className="privacy-note">Only you and your agent can read this private chat and your conditions.</p>
      </aside>

      <div className="workspace-content">
        {error ? <p className="planner-alert" role="alert">{error}</p> : null}
        {latestNotification ? (
          <aside className="notice-banner" aria-label="Latest in-app notice">
            <strong>Planning update</strong>
            <span>{latestNotification.kind.replaceAll("_", " ")}{latestNotification.actorName ? ` · ${latestNotification.actorName}` : ""}</span>
          </aside>
        ) : null}
        <OutingChat
          outing={outing}
          initialMessages={workspace.messages}
          showPlaybill={false}
          onConversationUpdate={refresh}
        />
        <section className="planner-card response-card" aria-labelledby="response-title">
          <p className="playbill-kicker">Your response</p>
          <h2 id="response-title">Would you like to be considered?</h2>
          <p className="planner-help">This is only your interest. It is not attendance or confirmation.</p>
          <div className="planner-actions">
            <PlannerButton disabled={busy || !workspace.myConditionsReady || Boolean(workspace.outing.cutoffProcessedAt)} onClick={() => void act({ action: "set_interest", interested: true })}>I’m interested</PlannerButton>
            <button className="text-button" type="button" disabled={busy || Boolean(workspace.outing.cutoffProcessedAt)} onClick={() => void act({ action: "set_interest", interested: false })}>I’m not interested</button>
          </div>
          <p className="condition-status">Your response: {workspace.myResponseStatus.replaceAll("_", " ")}</p>
        </section>
        <CatalogPanel workspace={workspace} busy={busy} act={act} />
        <OfferPanel workspace={workspace} busy={busy} act={act} />
        <AgreementPanel workspace={workspace} busy={busy} act={act} />
        <EmailPanel workspace={workspace} busy={busy} act={act} />
      </div>
    </div>
  );
}
