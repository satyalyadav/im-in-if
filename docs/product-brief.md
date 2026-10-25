# Product brief

## Concept and problem

Planning a movie, dinner, or campus event with friends can fizzle during the back-and-forth. Personal agents help existing student friends turn conditional interest into a social plan by exchanging relevant constraints.

At least one person must have sparked interest in doing something, but everyone else need not be initially interested or motivated. A plan may start from an incomplete suggestion such as "Dinner Friday?" before anyone chooses a restaurant, exact time, or budget. A useful outcome can be that no willing attendee set fits the current replies and known options. That does not prove that no real-world plan exists.

## First version

The first version covers one local outing among existing student friends. The demo is a movie night. The broader concept includes movies, dinner, and campus events; trips are outside this version.

- Cubbie Hackathon Track 2
- Build-time budget: 12 to 16 hours

The first version uses a small catalog of candidate options with stated showtimes and prices. People can add options manually. Synthetic or sample entries must be labeled clearly. The catalog does not claim live discovery or verified ticket prices. Live discovery for movie showtimes, restaurants, and events is deferred.

Each participant provides conditions and option rankings anew for each outing. Carrying these forward as memory is outside this version. Signing in does not imply reuse of earlier preferences. The app deletes private planning data it stores, including private agent chats, conditions, and option rankings, seven days after the outing or failed planning attempt ends. Sign-in accounts remain. This policy does not require deleting accounts or claim that model or email providers erase their copies. Retention of other plan data remains open.

## Conditions, preferences, and negotiation

The first version should account for availability, spending limits, activities a person wants or avoids, named-person attendance dependencies, and minimum group size. Strict limits are mandatory. An agent may compromise on a flexible preference, but only its owner may explicitly relax a strict limit. How participants classify conditions as strict or flexible remains undecided.

If a condition's meaning or strictness is unclear, the agent asks its own user a focused question. Before negotiation, each agent shows its user a short, editable summary of its interpretation. The agent does not silently guess at strict limits.

Participants may privately rank workable options, such as preferring a 7 PM movie while also accepting dinner. Their own agent uses those choices to negotiate and explain proposals. A ranking is not approval; everyone included in a proposed plan must still explicitly confirm it.

A smaller willing group may proceed if each attendee's conditions hold. A person who does not attend does not automatically veto the others' plan. Attendance dependencies can be evaluated together against one proposed attendee set. Mutually dependent people do not need unconditional prior commitments, but each must explicitly confirm that same plan through their own agent. A missing named person may make another participant ineligible. For example, if Bob will attend only if Maya attends, Maya's absence can make Bob ineligible.

Agents explain feasible options and tradeoffs in simple terms. The product does not impose an attendance-first choice. The starter may decide the initial direction. Once invitees are admitted, everyone contacted about the plan should have a say in later choices. When options tie, each participant's own agent asks one short, private follow-up with A, B, or either. Agents use the answers to negotiate a candidate. If everyone answers either, the agents may suggest either option for explicit final confirmation. If no acceptable common option remains, report no agreement rather than repeat the same poll. The starter does not break a tie alone.

Each agent asks its own user to approve the plan. The user makes the decision; the agent does not commit on the user's behalf. A confirmation covers the activity, time, estimated cost, and attendee list. Booking and payment are outside the first version.

The intended sharing policy keeps each student's budget caps, other raw constraints, and personal reasons private to that student and their own agent. The shared group page displays brief offers and counteroffers using only approved details, along with the current proposal and its status. A shared update could say "7PM does not work for this group; how about 8?" without naming who objected or why. The page does not show private agent conversations, raw limits, or personal reasons. This describes the intended sharing policy, not a technical security guarantee. Offers and refusals may still reveal clues.

## Web app and invitations

The first version is a web app. The starter begins a plan and manually shares an invitation link in the friends' existing group chat. Each participant signs in before private agent chat; a shared link or typed name alone does not establish identity. Each participant's private chat is only with their own agent. The agents negotiate in the app, and people review and confirm the plan there. Participants do not install agents. Native iMessage or WhatsApp integration is not required.

A signed-in invitee who opens the shared invitation link can request admission to the planning group. The starter approves or rejects each request. Until approved, a request is pending, and the invitee cannot see group details or participate in negotiation. Pending admission does not count as attendance or confirmation. Approval grants access to the planning group only; it does not add the person to the attendee list or confirm attendance. The starter receives an in-app notification for every admission request.

A person who does not respond by the response cutoff may request admission later. When that timing is permitted remains open. Admission is separate from a post-confirmation join request to add someone to the attendee list.

For the demo, email approval and admission notices are in scope only for recipients who have opted in. The app should record each recipient's opt-in before sending. Email notices should contain a short return-to-app link, not private planning details. The starter always receives an in-app notice for an admission request. No email provider or sending behavior is specified or configured, and delivery is not guaranteed. Other notification channels are outside the hackathon scope.

## Response cutoff and confirmation

The starter sets a response cutoff. A person who has not replied by the cutoff is not part of the current proposed group. This establishes only that they did not respond in time; their reason is unknown. It must not be interpreted as a decline, loss of interest, or unavailability.

After the cutoff, the process reassesses the willing attendee set against every remaining person's conditions, including strict limits and attendance dependencies. A missing named person can make another participant ineligible. Earlier approvals for a larger group do not transfer to the revised plan.

Final approval is separate from the response cutoff. After conditions have been gathered and a proposed attendee set is ready, each person's own agent asks them to approve the exact activity, time, estimated cost, and attendee list. The default final-approval window is 30 minutes after final approval is requested. If any user does not approve before expiry, the proposal is not confirmed. Silence is not approval. Expiry does not automatically remove that person or reshuffle the group, and an agent does not commit for its user.

A person who did not respond in time may request to join after the group confirms. The request does not reopen or change the existing plan. The proposed revised group must satisfy every member's conditions, and everyone in that group, including the joiner, must explicitly confirm the revised plan. The existing plan stays intact while the proposed addition is considered.

A material change to the activity, time, estimated cost, or attendee list requires renewed confirmation from each remaining participant. Previous approvals apply to the plan those participants approved.

## Product questions still open

- How people select among candidates after everyone has had input, including whether to use consensus or voting, how conflicting private rankings are reconciled, and the starter's role; no majority or aggregation rule is set
- The exact wording for an outcome where current replies and known options yield no willing attendee set
- The exact presentation of the one-round A/B/either follow-up and how people resolve non-tie disagreements
- How pending admission requests interact with the response cutoff and attendee set, and when late admission is allowed
- What happens after a participant withdraws or is removed from a confirmed plan, whether and how they may reenter, and how later changes are handled beyond renewed approval
- What to do if an activity is due to start while final approval is pending
- Late approval after expiry or restart, and the disposition of an unconfirmed proposal
- Whether the 30-minute final-approval window can be changed, and whether its clock is shared or starts separately for each request
- Default response-cutoff length and reminder behavior
- How and when people opt in to email notices, whether approval reminders are sent, and their cadence
- How long to retain plan, offer, decision, and shared-feed data after private chats, conditions, and rankings are deleted
- How long agents persist beyond an outing
- The catalog and shared group page layout, and how admitted participants submit late replies and other requests

## Build choices not selected

- Sign-in and identity provider, and how a signed-in account matches an invited person
- API, model, and email providers
- Data store and deployment target
- Plan versioning, timestamps, and any atomic handling of simultaneous approvals
- Technical enforcement of admission, access, and privacy rules
- Email sending and in-app notification implementation
