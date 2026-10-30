# Agent-led planning tickets

Parent: [Plan an outing through a personal agent](https://github.com/satyalyadav/im-in-if/issues/15).

The user approved this breakdown, including optional inline admission and approval actions. All ten tickets are published as native sub-issues with `ready-for-agent` labels and verified native blocking relationships. The section numbers preserve the original planning sequence; the GitHub links identify the actual issues. The parent spec remains open with its body, title, and labels unchanged.

Each slice delivers a user-visible behavior through the real authenticated API and database. Follow the parent spec's privacy, approved provider and budget, retry, deletion, and verification requirements. Use variant C and rewrite its behavior for production; do not ship its canned interpreter or reviewer controls. Keep existing working planning paths available during migration until their conversational replacements are ready. The final slice removes the replaced paths.

## 1. Start an outing through a simple private chat

### What to build

A signed-in person chooses New outing, types an idea, and gets a saved private conversation in the existing app style. They can switch between outings on the homescreen without conditions or memory carrying over. Activity timing and the response cutoff are optional.

### Acceptance criteria

- [ ] The first substantive idea creates one outing and saves its initiating message. Retrying that submission cannot create duplicate outings or messages.
- [ ] The production chat adopts variant C's simple layout and compact typography while keeping existing authentication and outing access checks. New outing creation no longer requires the date, time, and time-zone form.
- [ ] An outing can start without an activity time or response cutoff. Preserve supplied timing; ask a focused question when interpretation matters rather than guessing an absolute date or time zone.
- [ ] Store an absent cutoff explicitly and handle it throughout creation, outing reads, and deadline processing. Without a cutoff, unanswered people are not automatically excluded. Existing explicit cutoffs still work.
- [ ] Reloading or switching outings preserves the correct private conversation and does not generate an automatic catch-up. Existing saved outings and membership survive the migration.
- [ ] Integration checks cover incomplete creation, duplicate submissions, absent versus present cutoff, access denial, and memory isolation. Verify the basic new-outing flow in the browser.

### Blocked by

None. Existing authentication, chat, outing storage, and homescreen navigation provide the starting point.

## 2. Record interest and conditions by talking to the agent

### What to build

A participant expresses interest, disinterest, hard conditions, flexible preferences, or a correction in the outing chat. The agent records the appropriate saved state and acknowledges the result without requiring separate controls.

### Acceptance criteria

- [ ] Add structured conversation intentions behind the existing message boundary, with server-side validation and authorization before applying effects. Do not copy the prototype's keyword parser into production.
- [ ] A clear conditional statement such as "I'm in if it's under $30" records interest and the condition. A question about options does not change interest, and conditional interest never approves a proposal.
- [ ] A clear disinterest statement is acknowledged and persisted. Do not treat withdrawal from an already confirmed plan as an ordinary interest toggle; route that situation through the existing departure rules until its full conversational replacement is ready.
- [ ] Preserve saved hard conditions across turns and allow only the owner to explicitly relax them. Ask focused questions about ambiguous strictness, dates, amounts, or named people. Flexible preferences remain distinct.
- [ ] Message retries cannot repeat planning effects. Only owner-permitted inputs reach that owner's agent; other participants' raw conditions, chats, rankings, and reasons remain unavailable.
- [ ] Verify complete conversations through the message API and real local database, including ambiguity, correction, duplicate delivery, and cross-user denials. Demonstrate the behavior in the production chat without interest or condition-entry buttons.

### Blocked by

[Start an outing through a simple private chat](https://github.com/satyalyadav/im-in-if/issues/16).

## 3. Invite a friend by email and admit the verified recipient

### What to build

The starter uses a separate Invite control to send an email invitation. The recipient signs in with that invited verified address and gains admission without a second approval from the starter.

### Acceptance criteria

- [ ] Add invitation entry outside chat, with persisted recipient identity and delivery state. Only the authenticated starter may send invitations for that outing.
- [ ] Reuse the existing delivery adapter with a distinct invitation flow for people who may not yet be participants. Display an honest send or failure result; admission must not depend on whether the provider labels delivery successful.
- [ ] Require a signed-in account with the invited verified email address. A forwarded link, wrong account, unverified address, or typed name alone cannot grant access or reveal private group details.
- [ ] The invitation counts as the starter's admission approval only. It does not record the recipient's interest, add them as a confirmed attendee, or subscribe them to planning alerts.
- [ ] Repeated acceptance and delivery retries remain idempotent. Include invitation and delivery records in ended-outing deletion coverage and keep private planning content out of emails and scheduler metadata.
- [ ] Verify the separate-control journey, unauthorized sends, matching and mismatched verified identities, duplicate sends, provider failure, and recipient acceptance using the real database and stubbed delivery. Retain a real-auth verification step for the final journey.

### Blocked by

None. Existing outings, authentication, membership, the invitation entry point, and the email adapter are sufficient. This does not require conversational creation or the new conversation-intention interpreter.

## 4. Decide shared-link admission requests in chat

### What to build

A signed-in person follows a shared link and requests admission. The starter receives that request in their private chat and decides by typing or using a compact inline action.

### Acceptance criteria

- [ ] Persist the pending request and its starter-visible conversation message so the request remains available after reload.
- [ ] Interpret an unambiguous starter reply to admit or reject the named requester, or accept a compact inline action bound to that request, with the same server-side identity and permission checks. Ask for clarification when a reply such as "yes" could refer to either a plan or an admission request.
- [ ] Pending and rejected invitees cannot access group details or negotiate. A non-starter cannot decide a request, including through direct API calls.
- [ ] Admission grants planning-group access only; it creates neither interest nor confirmed attendance. Preserve the existing shared-link and repeated-request protections.
- [ ] Retried or concurrent replies preserve a consistent admission state and do not duplicate conversation messages or grant extra permissions.
- [ ] Verify with separate starter and invitee identities through the message/API boundary and a browser interaction. Typing remains supported; compact Admit or Decline actions inside the chat are also allowed. Verify every implemented route, including stale requests and duplicate submissions.

### Blocked by

[Record interest and conditions by talking to the agent](https://github.com/satyalyadav/im-in-if/issues/17).

## 5. Receive one workable recommendation inside the conversation

### What to build

After receiving sufficient conditions, a participant's agent creates and exchanges feasible offers without asking the participant to generate drafts, rank options, or publish offers. A current recommendation appears as a compact read-only plan attachment with an agent request for approval.

### Acceptance criteria

- [ ] Relevant saved messages and permitted incoming offers cause automatic generation and publication of validated tentative offers. Reuse existing feasibility and private-context boundaries rather than giving a shared agent access to raw participant inputs.
- [ ] Validate all included participants' availability, spending limits, activity conditions, attendance dependencies, and minimum group size against the same proposed attendee set. A smaller feasible group remains possible under the existing rules; admission is not attendance.
- [ ] Normally select one recommendation from the owner's conditions and preferences. Show alternatives on request and ask a focused question when a meaningful unresolved choice prevents progress. Report no agreement honestly without weakening hard conditions.
- [ ] Render the current proposal in every proposed attendee's private chat automatically, including after reload. Show only activity and location, exact date/time/time zone, estimated per-person cost, and attendees. Do not require a request for a recap or show a technical revision selector or approval roster.
- [ ] Preserve the current proposal's association with the conversation and internal revision identity for later approval. Suggestions remain tentative and unverified, with no claim of checked availability or booking.
- [ ] Verify the message-to-recommendation journey through the authenticated API and database, with fake agents that enforce input privacy. Check the actual compact card at mobile and desktop widths. This slice proves automatic recommendation from a request; durable continuation with every browser closed belongs to draft 6.

### Blocked by

[Record interest and conditions by talking to the agent](https://github.com/satyalyadav/im-in-if/issues/17).

## 6. Continue negotiation while participants are away

### What to build

Participants can close every browser and their agents still process permitted offers and relevant changes, returning a recommendation, a focused question, or an honest no-agreement outcome to the saved conversations.

### Acceptance criteria

- [ ] Persist pending negotiation work and resume through the existing database-backed background mechanism without relying on client polling, reloads, or a browser-held task.
- [ ] Resume safely after interruption and tolerate repeated triggers without duplicate offers, proposal messages, or effects. Recheck the current outing, condition, and proposal state before committing results from earlier work.
- [ ] Bound retries and model-call work; pause for a missing answer, a human decision, or a no-agreement outcome rather than calling indefinitely. Preserve approved model-provider and included-usage limits without introducing paid services.
- [ ] Keep private chats, raw conditions, model inputs/outputs, and personal reasons out of durable scheduling metadata and logs. Delete new persisted work records under the existing ended-outing policy.
- [ ] Do not add recap messages on return, approval emails, push alerts, or reminders. A saved current approval request remains available in chat independently of external notifications.
- [ ] Demonstrate progress using the maintenance entry point with no client connected, including interruption, duplicate trigger, stale work, retry exhaustion, and privacy cases. Confirm the resulting saved conversation is visible on return; a reload that finishes the work is not evidence of background progress.

### Blocked by

[Receive one workable recommendation inside the conversation](https://github.com/satyalyadav/im-in-if/issues/20).

## 7. Approve the current plan inside chat

### What to build

Each proposed attendee approves the exact plan shown by replying to their own agent or using a compact inline approval action. Their approval does not approve for anyone else. The group is confirmed only when everyone approves before the activity starts.

### Acceptance criteria

- [ ] Interpret explicit approval through the existing conversation-intention boundary or a compact action on the displayed plan, binding either route to the authenticated owner, outing, and proposal revision the person was shown. Clarify an ambiguous target rather than approving by guesswork.
- [ ] Questions, casual acknowledgments, and conditional replies cannot count as approval. "I'm in if ..." can record conditions and interest but must not approve the proposal.
- [ ] Record and acknowledge the owner's approval accurately. Explain that others are still needed when appropriate; confirm the group only after every proposed attendee independently approves the same current plan.
- [ ] Replace the old 30-minute expiry with the proposed activity's start time. Apply authoritative server-time checks both to chat replies and maintenance; reopening, retries, or delays cannot reset the deadline.
- [ ] An incomplete proposal expires unconfirmed at its start time without silently removing attendees or reshuffling the group. Preserve saved confirmations and do not resurrect already expired proposals during migration.
- [ ] Verify chat-based approval, independent participants, simultaneous approvals, duplicate replies, stale targets, condition changes racing the last approval, and controlled-clock behavior beyond the former 30-minute boundary. Typing remains supported and a compact in-chat approval action is allowed. Test equivalent authorization, stale-target rejection, expiry, and deduplication for every implemented route.

### Blocked by

[Receive one workable recommendation inside the conversation](https://github.com/satyalyadav/im-in-if/issues/20). Browser-independent negotiation is not required to approve an already available proposal, so the background-continuation ticket is not a blocker.

## 8. Change, clarify, or restore a plan through conversation

### What to build

A participant can ask about the plan, request new details, keep the current proposal, or request earlier details by typing. Material changes and restorations produce a new current proposal that everyone must approve again.

### Acceptance criteria

- [ ] Questions such as "Who is coming?" or "What time?" receive an answer without approving or changing the proposal. Ambiguous changes prompt for clarification instead of silently choosing different details.
- [ ] Apply supported activity, location, time, cost, and attendee changes through real validated planning behavior, respecting every affected hard condition. Do not ship the prototype's canned date or cost substitutions.
- [ ] Keeping the current proposal does not silently confirm attendance, create a different proposal, or reset its deadline. An explicit request for earlier details creates a new approval target, even when those details were approved previously.
- [ ] Every material change or restoration clears all approvals, associates the new request with each affected private conversation, and displays the compact current plan without a version selector or revision form.
- [ ] A stale response cannot approve a replacement that the owner has not seen. Handle replacement, pending agent work, and the final approval atomically using the existing concurrency protections.
- [ ] Verify a browser journey that approves, asks a question, requests a change, rejects stale approval, restores earlier details, and collects fresh approvals through chat. Extend integration checks for duplicates, ambiguous requests, hard-condition failures, and replacement races.

### Blocked by

[Approve the current plan inside chat](https://github.com/satyalyadav/im-in-if/issues/22). This slice delivers changes and restorations across the new conversational approval flow, including invalidation of previously recorded chat approvals.

## 9. Handle post-confirmation attendance changes in chat

### What to build

An admitted nonattendee can request to join a confirmed plan, and a confirmed attendee can request to leave by talking to their agent. The existing membership, feasibility, and approval rules remain intact.

### Acceptance criteria

- [ ] Distinguish a join request from a request for admission, and a departure from ordinary pre-confirmation disinterest. The agent's reply explains the saved result without requiring separate attendance controls.
- [ ] Do not silently add someone to a confirmed attendee list or treat a join request as approval. Apply the existing feasibility rules and obtain explicit approval of any proposed revised group.
- [ ] Preserve existing departure handling, including required renegotiation when remaining participants' hard conditions no longer hold. A departure does not silently authorize a different plan for the remaining group.
- [ ] Reuse the compact in-chat proposal and fresh-approval behavior for revised groups, with accurate saved messages for the people affected.
- [ ] Verify concurrent attendance changes, repeated messages, stale confirmations, infeasible revisions, and privacy through the real API/database boundary. Demonstrate an attendee change entirely through the new chat.

### Blocked by

[Change, clarify, or restore a plan through conversation](https://github.com/satyalyadav/im-in-if/issues/23).

## 10. Finish the chat-only experience and verify the complete journey

### What to build

Remove the replaced manual planning sections and prove that the selected variant C experience supports the whole planning journey with real authentication, saved data, background negotiation, and independent participant approval.

### Acceptance criteria

- [ ] Remove the legacy catalog, offer, ranking, confirmation, interest, revision, and admission-action controls once their replacements work. Keep the homescreen outing switcher, separate email Invite control, and any compact in-chat admission or approval actions. Do not retain an approval roster or technical version interface.
- [ ] Exclude the prototype variants, sample data, scripted interpreter, reviewer controls, and development host from the production experience. Preserve the full prototype on its reference branch and rewrite the selected design as production UI.
- [ ] Run the approved multi-user browser journey at mobile and desktop widths: conversational creation, a separate-control email invitation, verified identity admission, conditions, browser-independent negotiation, visible pending proposal, clarification, changed details, and independent approvals through typing or the optional inline action.
- [ ] Verify email identity through real authentication in a suitable environment, together with wrong-account and forwarded-link access denials. Keep evidence explicit about any unverified provider delivery or deployment behavior.
- [ ] Verify deadline behavior, retries, privacy, cross-outing isolation, migration compatibility, and seven-day deletion for all new records, using the approved API/database/maintenance checks. Complete required tests, typechecking, and production build with heavy work run serially.
- [ ] Update the product documentation to match chat-led planning, optional cutoffs, separate email invites, and approval until activity start. Record validation evidence without treating helper tests or the throwaway prototype as proof of full production behavior.

### Blocked by

- [Invite a friend by email and admit the verified recipient](https://github.com/satyalyadav/im-in-if/issues/18).
- [Decide shared-link admission requests in chat](https://github.com/satyalyadav/im-in-if/issues/19).
- [Continue negotiation while participants are away](https://github.com/satyalyadav/im-in-if/issues/21).
- [Handle post-confirmation attendance changes in chat](https://github.com/satyalyadav/im-in-if/issues/24).

Those blockers already include the other required ancestors. Do not add duplicate dependency edges merely to list every earlier ticket.

## Published issues

1. [Start an outing through a simple private chat](https://github.com/satyalyadav/im-in-if/issues/16)
2. [Record interest and conditions by talking to the agent](https://github.com/satyalyadav/im-in-if/issues/17)
3. [Invite a friend by email and admit the verified recipient](https://github.com/satyalyadav/im-in-if/issues/18)
4. [Decide shared-link admission requests in chat](https://github.com/satyalyadav/im-in-if/issues/19)
5. [Receive one workable recommendation inside the conversation](https://github.com/satyalyadav/im-in-if/issues/20)
6. [Continue negotiation while participants are away](https://github.com/satyalyadav/im-in-if/issues/21)
7. [Approve the current plan inside chat](https://github.com/satyalyadav/im-in-if/issues/22)
8. [Change, clarify, or restore a plan through conversation](https://github.com/satyalyadav/im-in-if/issues/23)
9. [Handle post-confirmation attendance changes in chat](https://github.com/satyalyadav/im-in-if/issues/24)
10. [Finish the chat-only experience and verify the complete journey](https://github.com/satyalyadav/im-in-if/issues/25)

## Dependency review

Initial ready work: [Start an outing through a simple private chat](https://github.com/satyalyadav/im-in-if/issues/16) and [Invite a friend by email and admit the verified recipient](https://github.com/satyalyadav/im-in-if/issues/18).

The main progression is 1, then 2, then 5. Shared-link admission branches from 2. Background negotiation and conversational approval branch independently from 5. Changes and restoration follow conversational approval, then post-confirmation attendance changes. Final integration waits for email invitations, shared-link admission, background continuation, and the complete attendance-change flow.

These are feature dependencies, not instructions to run heavy jobs or edit shared modules concurrently. Each issue must preserve the parent's privacy, provider, retention, and validation constraints. No separate speculative refactoring ticket is proposed because the existing APIs and persistence already provide useful boundaries; any small prerequisite restructuring should stay inside the first slice that needs it.
