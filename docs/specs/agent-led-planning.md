# Plan an outing through a personal agent

Approved specification for a new GitHub issue linked to the completed MVP work.

## Problem statement

The current app asks participants to manage a catalog, rank options, request drafts, publish offers, and operate separate confirmation controls. Someone who wants help making a plan must understand and drive the negotiation process themselves. The interface should reduce the planning decisions people must manage rather than reproduce the manual workflow inside chat.

Participants should be able to describe what they want, let their personal agents negotiate, and answer when a decision needs their attention. The app must keep private conditions private and obtain explicit approval before confirming attendance.

## Solution

Use the selected variant C as the visual reference for a simple private conversation per outing. Keep the app's existing palette and typography. Replace the separate planning sections with ordinary agent messages and a compact plan attachment with read-only details and an optional approval action.

People start outings, express interest, describe conditions, ask questions, request changes, approve a proposal, and decide shared-link admission requests by typing. Admission and plan approval may also use small inline actions inside chat. Email invitations retain a separate control. Personal agents negotiate in the background within their owners' hard conditions, normally bringing back one recommendation. Every proposed attendee sees the plan in their private chat and must explicitly approve the same details before its start time.

## User stories

1. As a signed-in participant, I want to find my outings on the existing homescreen, so that I can choose the conversation I need.
2. As a starter, I want to begin an outing by typing an incomplete idea, so that I can start before I have worked out the details.
3. As a starter, I want to include an activity date or time if I know it, so that the agent can use it without requiring a form.
4. As a starter, I want to begin without an activity time, so that my friends and their agents can help settle it.
5. As a starter, I want a response cutoff to be optional, so that setup does not require choosing a deadline.
6. As a starter, I want to set a response cutoff in conversation, so that I can give people a deadline when one matters.
7. As an invitee, I want silence to leave my interest unknown when there is no cutoff, so that the app does not invent a response for me.
8. As a participant, I want each outing to have its own private chat and memory, so that conditions from another plan do not affect this one.
9. As a participant, I want to switch outings through the homescreen, so that separate conversations remain easy to find.
10. As a participant, I want a familiar conversation using the app's existing visual style, so that I can use the agent without learning planning controls.
11. As a participant, I want to state conditions in ordinary language, so that I do not have to fill out or maintain a planning form.
12. As a participant, I want the agent to ask a focused question when a condition is unclear, so that it does not guess my limits.
13. As a participant, I want my hard conditions respected until I explicitly relax them, so that negotiation cannot override what matters to me.
14. As a participant, I want my agent to compromise on flexible preferences, so that I do not have to approve each negotiation step.
15. As a participant, I want my raw conditions, private rankings, chat, and personal reasons to remain private, so that other people receive only permissible proposals and counteroffers.
16. As a participant, I want a clear statement such as "I'm in if it's under $30" to record my interest and condition, so that no separate interest button is needed.
17. As a participant, I want the agent to acknowledge the interest it recorded, so that I know what my message did.
18. As a participant, I want asking about options to leave my interest unchanged, so that a question is not mistaken for a commitment.
19. As a participant, I want to say that I am not interested, so that the agent stops treating me as willing to join an unconfirmed plan.
20. As a participant, I want my agent to generate and exchange suitable offers automatically, so that I do not manage drafts, catalogs, rankings, or publication steps.
21. As a participant, I want negotiation to continue after I close the app, so that keeping a browser open is not part of planning.
22. As a participant, I want one recommendation based on my conditions and preferences, so that I do not have to work through a list of options.
23. As a participant, I want to ask for alternatives when I need them, so that I can explore without always seeing a catalog.
24. As a participant, I want the agent to ask for a choice when my preferences do not settle an important difference, so that it does not invent my preference.
25. As a participant, I want an honest explanation when current replies and known options cannot produce a workable plan, so that I can change my own conditions or leave it there.
26. As a starter, I want a separate email invitation control, so that I can invite a friend without sending that instruction through chat.
27. As an email invitee, I want admission after signing in with the invited verified address, so that the starter does not have to approve me twice.
28. As a starter, I want my email invitation to grant access only to the intended verified identity, so that forwarding a link does not grant someone else admission.
29. As a shared-link invitee, I want to request admission after sign-in, so that the starter can decide who joins the planning group.
30. As a starter, I want admission requests to appear in my chat and to answer by typing or a small inline action, so that I do not manage a separate requests panel.
31. As an invitee, I want admission to remain separate from interest and attendance, so that joining the group does not commit me to an activity.
32. As a participant, I want a proposal to appear automatically in my chat when my approval is needed, so that I do not have to ask whether there is a plan.
33. As a participant returning after being away, I want the current pending proposal to be available, so that I can act without requesting a recap.
34. As a participant, I want a compact plan showing the activity and location, exact date and time with time zone, estimated cost per person, and attendees, so that I know exactly what I am approving.
35. As a participant, I want to approve by replying in chat or using a small action on the displayed plan, so that I can respond without opening another section.
36. As a participant, I want my approval to apply only to me and the current proposal, so that my response cannot commit another person or a different plan.
37. As a participant, I want questions, conditional responses, and casual acknowledgments to remain distinct from approval, so that the app does not treat ambiguity as consent.
38. As a participant, I want to ask who is coming or what time is proposed, so that clarification needs only a message.
39. As a participant, I want to request a change by typing, so that I do not need a change form.
40. As a participant, I want to keep the current proposal or request an earlier proposal's details in conversation, so that I do not need save, keep, or restore buttons.
41. As a participant, I want everyone to approve again after any material change or restoration, so that old approvals do not authorize a changed plan.
42. As a participant, I want the agent to distinguish my approval from the whole group's confirmation, so that I know when others still need to respond.
43. As a participant, I want approval to remain available until the proposed activity starts, so that a short unseen timer does not expire my opportunity to respond.
44. As a participant, I want an incomplete proposal to expire unconfirmed at its start time, so that silence never becomes approval.
45. As a returning participant, I want a catch-up only when I ask for it, so that reopening a chat does not generate an unsolicited summary.
46. As a participant, I want to ask for planning status in chat, so that I can understand progress without a separate dashboard or approval roster.
47. As a participant, I want tentative suggestions and estimated costs described honestly, so that I do not mistake an unverified suggestion for a booking or checked availability.
48. As a participant, I want my saved messages and actions to survive a dropped connection or retry without duplication, so that I can recover without repeating commitments.
49. As a participant, I want private planning to stay protected through both the UI and direct requests, so that changing the interface does not weaken access controls.
50. As a participant, I want the existing seven-day deletion policy for ended outings to cover the new conversation actions and background work, so that simplifying planning does not create an extra archive of my private data.

## Implementation decisions

- Treat variant C as the interaction and visual reference, using the existing forest green, pale green, gold, and ink palette with Newsreader and Instrument Sans. Keep compact messages, a composer, outing navigation, and the separate Invite control. The prototype is a reference for a production rewrite, not production agent logic.
- Remove the catalog, offer-management, confirmation, ranking, interest, and admission-control panels from the participant journey. Keep planning conversational. Admission and final approval may also have compact inline actions, while changes, clarification, interest, and keeping or restoring details remain typed interactions. Do not recreate catalog, offer, or version-management controls inside chat.
- Create an outing from the first substantive idea supplied through a new conversation. Save the idea as part of that outing's conversation without requiring an activity time or response cutoff. Continue using authenticated participant identity and separate outing membership.
- Represent an absent response cutoff explicitly rather than supplying an arbitrary default. Update creation validation, storage, displayed outing state, and deadline processing to accept its absence. A missing cutoff cannot trigger automatic exclusion of unanswered people. An explicit cutoff continues to close interest collection without delaying confirmation.
- Reuse the existing outing, message, membership, condition, offer, proposal, approval, and maintenance boundaries. Add a durable conversation-to-planning coordinator behind those boundaries. Interpret owner messages into structured planning intentions; validate and execute those intentions through the server's existing authorization and planning rules. The prototype's keyword matching is not the production interpreter.
- Give each personal agent only its owner's private conversation and conditions, permitted shared proposals and counteroffers, and the admitted public roster. Keep raw conditions and reasons out of shared agent context, scheduler metadata, and logs. The privacy ADR remains authoritative; this does not add a provider-level privacy guarantee.
- Distinguish interest, conditions, approval, clarification, admission, and post-confirmation attendance changes. A conditional statement can record interest and conditions without approving the current proposal. Do not reinterpret withdrawal from a confirmed plan as a simple interest toggle; retain the existing join and departure rules through conversational intentions.
- Bind an approval to the authenticated owner, outing, exact current proposal revision, and the proposal that the person was shown. If the conversation leaves the target unclear, ask a focused question. Reject stale or replaced proposal approvals atomically. Questions, "thanks," a conditional yes, and an unresolved admission-versus-plan reply cannot count as approval.
- Keep technical revision identifiers and concurrency checks internal. Show the current proposal as an attachment with read-only plan details associated with an agent message. An optional small approval action may accompany those details; typing remains supported. Both routes use the same authorization, proposal binding, deduplication, and deadline checks. Include only the activity and location, exact date and time with time zone, estimated cost per person, and proposed attendees. Ask for approval in ordinary conversation. Do not show a version-management interface or a per-person approval table.
- Persist the association between the approval request and its proposal so the current pending request remains available after reload or time away. Do not generate a fresh automatic recap when opening an outing. Conversational status requests may explain progress.
- Automatically generate, validate, publish, and negotiate offers within the owner's authorized conditions. Retain server checks for availability, spending limits, activity conditions, attendance dependencies, and minimum group size against one consistent proposed attendee set. Admission, interest, proposal inclusion, and confirmed attendance remain different states. Existing feasible-group rules continue to apply.
- Resume negotiation from relevant saved changes and permitted incoming offers without relying on a page load, client polling, or a browser-held task. Persist pending work and progress using the existing database and background maintenance mechanism where practical. Use bounded retries, deduplicate work, and pause for missing information, a decision, or a no-agreement outcome rather than repeating model calls indefinitely. This spec does not select a new hosting service, workflow provider, or paid dependency.
- Normally negotiate one recommendation using existing private preferences. Present alternatives only on request or ask a focused question when an unresolved choice matters. Never weaken a hard condition without the owner's explicit instruction. Describe no agreement as a limitation of current replies and known options, not proof that no real-world plan exists.
- A material change to activity, location, date, time, estimated cost, or attendees creates a new approval target. Restoring earlier details also creates a new current target and clears approvals. Do not copy old approvals into a restored proposal or let a change race the last approval unnoticed.
- All proposed attendees must explicitly approve the same current plan before its activity starts. The final approval deadline becomes that start time, replacing the previous 30-minute window. Server-time checks remain authoritative across client actions and durable processing. Opening a page, retrying, or asking for an update does not reset the deadline. Expiry leaves the proposal unconfirmed without silently removing people or reshuffling the group.
- Preserve saved conversations, membership, and confirmations during migration. Apply the new cutoff and deadline rules consistently without resurrecting expired proposals or treating old approvals as approval of materially changed details. Update the current product documentation where it still describes manual publishing, required cutoffs, or 30-minute expiry.
- Keep email invitation entry outside chat. Only the authenticated starter may send an invitation for an outing. Store the outing, invited email identity, and delivery state. Admission requires a signed-in account with that invited verified address; possession of a forwarded link alone grants no access. Do not infer identities from typed names or expose private group details before admission.
- Reuse the existing email delivery adapter while adding the distinct invitation-recipient flow. Its current participant opt-in flow does not already support first-time invitees. Preserve delivery idempotency so retries cannot send duplicate invitations for one send request. Sending an invitation or receiving admission does not opt someone into planning alerts, express their interest, or confirm attendance.
- Keep shared-link admission requests and starter decisions, delivered and answered in private chat by typing or a compact inline admission action. Both routes use the same authenticated request identity and permission checks. Authenticate and authorize each decision. Clarify ambiguous replies when an admission request and proposal are both awaiting a decision.
- Do not add approval-request emails, automatic catch-ups, or new alerts outside chat. Requested email invitations remain in scope. Persisted agent approval messages are part of the conversation, not an external alert system.
- Keep suggestions tentative unless verified by information already supplied in the outing. Do not claim live venue research, checked opening hours, verified prices, availability, bookings, or payments.
- Reuse existing message idempotency and extend it to conversation-driven planning effects and background tasks. A response after a retry or connection drop must reflect the saved result rather than repeat approval, invitation, proposal publication, or agent work. Add new persisted work, invitation, and proposal-message records to the existing ended-outing deletion coverage.
- Preserve the current approved authentication, model-provider, included-usage budget, and fail-closed provider behavior. This feature does not authorize purchases, a different provider, or relaxed access checks.

## Testing decisions

The approved main integration boundary is the existing authenticated outing and message API backed by the real local database. Exercise complete conversations through that boundary and observe saved conversations, proposals, membership, and API responses. Trigger the existing maintenance entry point to prove background progress and deadlines with browsers closed. Add one multi-user browser journey for rendering and real interaction. These tests exercise externally visible behavior rather than component internals or the prototype's implementation.

- Extend the existing outing/message, planning, proposal, email, database-migration, and maintenance integration suites, which already use PGlite, deterministic fake agents, and controlled clocks. Keep real model and email calls out of automated integration checks. Fake-agent assertions must verify that each agent receives only permitted context.
- Cover incomplete conversational creation, optional activity timing, absent and explicit cutoffs, and isolated memory after switching outings. Prove that repeated first-message submission does not create duplicate outings or messages.
- Exercise interest and disinterest, hard-condition corrections, flexible preferences, focused clarification, negotiation, alternatives, no agreement, and typed admission decisions through messages. Assert observable results and privacy, not prompt wording or a particular internal intention representation.
- Prove background negotiation advances without a connected client, survives interruption, tolerates duplicate triggers, has bounded retries, and stops or waits when appropriate. A browser reload that happens to finish work is not evidence of browser-independent operation.
- Exercise a compact pending proposal, typed explicit approval, questions and conditional replies that do not approve, independent approvals from all attendees, and requests to change or restore details. Include stale messages, ambiguous targets, concurrent condition changes, replacement racing the final approval, and duplicate delivery.
- Use controlled time to verify approval remains available beyond the former 30-minute boundary, expires at the activity start, does not reset on reload, and never counts silence as approval. Cover proposals with and without a response cutoff and preserve existing post-confirmation join/departure checks.
- Exercise separate email invitation sending with a stubbed provider, delivery retry deduplication, verified matching-email admission, wrong-account and forwarded-link denials, non-starter send denial, and shared-link admission through chat. Confirm admission changes neither interest nor attendance.
- Verify access denials through direct API requests as well as rendered screens. Verify raw conditions, private conversations, and reasons do not enter another person's agent input or shared view. Extend seven-day deletion and scheduler-metadata checks to every new persisted record.
- Run one complete browser journey with separate authenticated starter and invitee sessions, checking mobile and desktop layouts. Start an outing, invite through the separate control, enter conditions, close the clients while negotiation progresses, return to a visible proposal without a recap, ask for clarification, change details, approve by typing, and verify confirmation only after all approvals. Test verified-email identity through the real auth integration in a suitable environment; a fake mailbox or local auth shortcut alone does not establish that behavior.
- Confirm variant C's production UI has no separate catalog, offers, confirmation, interest, revision, or admission panels. Compact inline admission and approval actions are allowed alongside typing; verify equivalent authorization, stale-target rejection, and retry behavior for every implemented route. Its plan attachment contains the required details without an approval roster or version selector. The prototype switcher, inspector, canned replies, and sample controls must not appear in production.
- Complete the repository's required tests, typechecking, and production build as implementation checks. Run heavy jobs serially with a low explicit worker count. Keep evidence clear about local integration coverage versus deployed multi-user verification.

The user approved this verification boundary. This document records planned checks; drafting it does not establish that the feature has been implemented or verified.

## Out of scope

- One persistent agent conversation or memory shared across outings.
- Live venue discovery, verified listings, current availability, reservations, bookings, or payments.
- Contact importing, address-book management, or invitations issued through chat.
- Planning-alert emails, push notifications, reminders, and automatic reopening summaries.
- A new catalog, ranking tool, offer dashboard, approval roster, or plan-version UI.
- Automatic attendance commitment, approval on behalf of friends, or relaxation of an owner's hard conditions.
- New model providers, paid infrastructure, subscription changes, or a change to the seven-day ended-outing retention policy.
- Shipping the throwaway prototype's sample data, scripted interpreter, variant switcher, or reviewer controls.
- Implementation tickets or production code changes during this specification step.

## Further notes

The accepted domain glossary and both privacy and agent-led-planning ADRs describe the intended policy. Variant C of the preserved prototype at local commit `b198b10` on branch `prototype/agent-chat` is the approved visual reference. Its sample dates, replies, and simple parsers are not requirements for real negotiation. The prototype has been exercised with browser events and separate logic checks, but those checks do not verify the planned production feature.

The closed MVP work is relevant prior art, not evidence that this redesign already exists:

- [Negotiate feasible plans through personal agents](https://github.com/satyalyadav/im-in-if/issues/5) covers validated offers and private conditions. This spec removes the user's obligation to drive draft generation and publication and requires browser-independent negotiation.
- [Confirm exact proposals with a shared deadline](https://github.com/satyalyadav/im-in-if/issues/7) covers revision-bound approvals and the previous 30-minute rule. This spec retains atomic approval checks, moves approval into conversation, and changes the deadline to the activity start.
- [Invite friends and approve admission](https://github.com/satyalyadav/im-in-if/issues/3) covers shared-link admission. This spec retains that protection and adds separate-control email invitations bound to verified recipient identity.
- [Close the remaining planning race conditions](https://github.com/satyalyadav/im-in-if/pull/14) records existing concurrency protections that the conversation-driven design must retain.

The user approved creating a new spec linked to the closed work rather than extending a closed issue. GitHub Discussions are disabled. Apply the existing `ready-for-agent` label when publishing the spec and its approved implementation tickets.
