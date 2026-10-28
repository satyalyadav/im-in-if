# Product brief

## Concept and problem

Planning a movie, dinner, or campus event with friends can fizzle during the back-and-forth. Personal agents help existing student friends turn conditional interest into a social plan by exchanging relevant constraints.

At least one person must have sparked interest in doing something, but everyone else need not be initially interested or motivated. A plan may start from an incomplete suggestion such as "Dinner Friday?" before anyone chooses a restaurant, exact time, or budget. A useful outcome can be that no willing attendee set fits the current replies and known options. That does not prove that no real-world plan exists.

## First version

The first version covers one local outing among existing student friends. The demo is a movie night. The broader concept includes movies, dinner, and campus events; trips are outside this version.

- Cubbie Hackathon Track 2
- Build-time budget: 12 to 16 hours
- Out-of-pocket service budget: $0. Use free tiers only. Do not buy credits, upgrade plans, or purchase a domain; stop if the required flow needs paid usage.

Outings start without sample options. An agent can draft a tentative candidate from the outing idea and its owner's private chat, with a proposed time and estimated cost per person. It asks a focused question when needed details are missing. The draft stays private until its owner publishes the offer. People can also add options manually. The catalog does not claim live discovery, verified prices, venue availability, or bookings. Live discovery for movie showtimes, restaurants, and events is deferred.

Each personal agent works on one outing and has no persistent memory beyond it. Participants provide conditions and option rankings anew for each outing; sign-in does not imply reuse of earlier preferences. Seven days after an outing or failed attempt ends, delete all app-held outing data, including private chats, conditions, rankings, offers, proposals, and approval history. Keep sign-in accounts. Past-plan archives are outside this version. This policy does not claim that model or email providers erase their copies. Database restore history, snapshots, workflow records, and application logs must be checked before claiming the seven-day rule is implemented. The rule is approved; implementation is not verified.

## Conditions, preferences, and negotiation

The first version should account for availability, spending limits, activities a person wants or avoids, named-person attendance dependencies, and minimum group size. Strict limits are mandatory. An agent may compromise on a flexible preference, but only its owner may explicitly relax a strict limit.

If a condition's meaning or strictness is unclear, the agent asks its own user a focused question in their private chat. The agent remembers the owner's conditions across turns and applies corrections there. The owner can explicitly change a hard condition; the agent never guesses at strict limits. The app keeps the interpreted state for validation without asking people to fill out structured condition fields or save a separate summary.

Participants may privately rank workable options, such as preferring a 7 PM movie while also accepting dinner. Their own agent uses those choices to negotiate and explain proposals. A ranking is not approval; everyone included in a proposed plan must still explicitly confirm it.

A smaller willing group may proceed if each attendee's conditions hold. A person who does not attend does not automatically veto the others' plan. Attendance dependencies can be evaluated together against one proposed attendee set. Mutually dependent people do not need unconditional prior commitments, but each must explicitly confirm that same plan through their own agent. A missing named person may make another participant ineligible. For example, if Bob will attend only if Maya attends, Maya's absence can make Bob ineligible.

Agents explain feasible options and tradeoffs in simple terms. The product does not impose an attendance-first choice. The starter may decide the initial direction. Once invitees are admitted, everyone contacted about the plan should have a say in later choices. When options tie, each participant's own agent asks one short, private follow-up with A, B, or either. Agents use the answers to negotiate a candidate. If everyone answers either, the agents may suggest either option for explicit final confirmation. If no acceptable common option remains, report no agreement rather than repeat the same poll. The starter does not break a tie alone.

Each agent asks its own user to approve the plan. The user makes the decision; the agent does not commit on the user's behalf. A confirmation covers the activity, time, estimated cost, and attendee list. Booking and payment are outside the first version.

The intended sharing policy keeps each student's budget caps, other raw constraints, and personal reasons private to that student and their own agent. The shared group page displays brief offers and counteroffers using only approved details, along with the current proposal and its status. A shared update could say "7PM does not work for this group; how about 8?" without naming who objected or why. The page does not show private agent conversations, raw limits, or personal reasons. This describes the intended sharing policy, not a technical security guarantee. Offers and refusals may still reveal clues.

## Web app and invitations

The first version is a web app. The starter begins a plan and manually shares an invitation link in the friends' existing group chat. Each participant signs in before private agent chat; a shared link or typed name alone does not establish identity. Each participant's private chat is only with their own agent. The agents negotiate in the app, and people review and confirm the plan there. Participants do not install agents. Native iMessage or WhatsApp integration is not required.

A signed-in invitee who opens the shared invitation link can request admission to the planning group. The starter approves or rejects each request. Until approved, a request is pending, and the invitee cannot see group details or participate in negotiation. Pending admission does not count as attendance or confirmation. Approval grants access to the planning group only; it does not add the person to the attendee list or confirm attendance. The starter receives an in-app notification for every admission request.

A pending admission request does not count as attendance or extend the response cutoff. A late nonresponder may request admission, but admission alone does not include them in the current proposal. After the current group confirms, an admitted person may submit a separate join request to be added to the attendee list. That request leaves the confirmed plan intact until everyone in the revised attendee group, including the joiner, has explicitly approved the revised plan.

For the demo, admission and final-approval event notices are in scope only for recipients who have opted in. Record opt-in before sending. Email notices contain a short return-to-app link, not private planning details. The starter always receives an in-app notice for an admission request. No scheduled reminder emails are requested for this version. The approved sender approach uses a subdomain of an existing domain; no domain purchase or DNS change has been made. The email provider, DNS write access, and sender verification remain unconfirmed, and delivery is not guaranteed. Other notification channels are outside the hackathon scope.

## Response cutoff and confirmation

The starter must choose a response-cutoff date and time; the app does not set a default. This deadline closes interest collection; it does not delay publishing an offer for approval. Anyone who has not replied is not eligible for the proposed attendee group. Silence does not explain why they did not reply and must not be treated as a decline or unavailability.

For a proposal made after the cutoff, the process reassesses the interested attendee set against each person's conditions, including strict limits and attendance dependencies. A missing named person can make another participant ineligible. Earlier approvals for a larger group do not transfer to the revised plan.

Final approval is separate from the response cutoff. After conditions have been gathered and a proposed attendee set is ready, each person's own agent asks them to approve the exact activity, time, estimated cost, and attendee list. One shared deadline applies to everyone included in the proposal. It is 30 minutes after the approval request is published, or the activity start if that comes sooner. Opening the page or receiving a delayed email does not reset the deadline. If any included person has not approved by then, the proposal expires unconfirmed. Silence is not approval, and expiry does not automatically remove anyone or reshuffle the group.

After expiry, an admitted participant must explicitly request a restart. Each included person must approve the restarted proposal; earlier approvals do not carry over. Agents do not restart a proposal automatically or repeatedly. An agent asks only its own user for approval, and it never commits for them.

If someone leaves a confirmed attendee group, that changes the attendee list. The remaining group must still meet its conditions, and every person in the revised group must explicitly confirm the revised plan. The previous full-group confirmation does not cover the new attendee list.

A material change to the activity, time, estimated cost, or attendee list requires renewed confirmation from each remaining participant. Previous approvals apply to the plan those participants approved.

## Product policy status

No unresolved product policies are identified for this MVP. Remaining technical and interface choices are listed below.

## Build choices not selected

- Sign-in and identity provider, and how a signed-in account matches an invited person
- ASU is the primary AI API choice, conditional on the $0 cap, model compatibility, and app access; exact model and credential setup remain unverified. Email provider and sending setup are also unselected.
- Data store and deployment target
- Plan versioning, timestamps, and any atomic handling of simultaneous approvals
- Technical enforcement of admission, access, and privacy rules
- Email sending and in-app notification implementation
