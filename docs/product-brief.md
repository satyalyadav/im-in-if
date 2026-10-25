# Product brief

## Concept and problem

Planning a movie, dinner, or campus event with friends can fizzle during the back-and-forth. Personal agents help existing student friends turn conditional interest into a social plan by exchanging relevant constraints.

At least one person must have sparked interest in doing something, but everyone else need not be initially interested or motivated. A plan may start from an incomplete suggestion such as "Dinner Friday?" before anyone chooses a restaurant, exact time, or budget. A useful outcome can be that no willing attendee set fits the current replies and known options. That does not prove that no real-world plan exists.

## First build

The first version covers one local outing among existing student friends. The demo is a movie night. The broader concept includes movies, dinner, and campus events; trips are outside the first build.

- Cubbie Hackathon Track 2
- Build-time budget: 12 to 16 hours

The first version uses a small catalog of candidate options with stated showtimes and prices. People can add options manually. Synthetic or sample entries must be labeled clearly. The catalog does not claim live discovery or verified ticket prices. Live discovery for movie showtimes, restaurants, and events is deferred.

## Conditions and negotiation

The first version should account for availability, spending limits, activities a person wants or avoids, named-person attendance dependencies, and minimum group size. Strict limits are mandatory. An agent may compromise on a flexible preference, but only its owner may explicitly relax a strict limit. How participants classify conditions as strict or flexible remains undecided.

If a condition's meaning or strictness is unclear, the agent asks its own user a focused question. Before negotiation, each agent shows its user a short, editable summary of its interpretation. The agent does not silently guess at strict limits.

Participants may privately rank workable options, such as preferring a 7 PM movie while also accepting dinner. Their own agent uses those choices to negotiate and explain proposals. A ranking is not approval; every person included in a proposed plan must still explicitly confirm it.

A smaller willing group may proceed if each attendee's conditions hold. A person who does not attend does not automatically veto the others' plan. Attendance dependencies can be evaluated together against one proposed attendee set. Mutually dependent people do not need unconditional prior commitments, but each must explicitly confirm that same plan through their own agent. A missing named person may make another participant ineligible. For example, if Bob will attend only if Maya attends, Maya's absence can make Bob ineligible.

Agents explain feasible options and tradeoffs in simple terms. The product does not impose an attendance-first choice. The starter may decide the initial direction, but everyone contacted about the plan should have a say afterward. The selection method, tie handling, and the starter's later role remain open.

Each agent asks its own user to approve the plan. The user makes the decision; the agent does not commit on the user's behalf. A confirmation covers the activity, time, estimated cost, and attendee list. Booking and payment are outside the first version.

The intended sharing policy keeps each student's budget caps, other raw constraints, and personal reasons private to that student and their own agent. The shared group page displays brief offers and counteroffers using only approved details, along with the current proposal and its status. A shared update could say "7PM does not work for this group; how about 8?" without naming who objected or why. The page does not show private agent conversations, raw limits, or personal reasons. This describes the intended sharing policy, not a technical security guarantee. Offers and refusals may still reveal clues.

## Chosen first-version interaction

The first version is a web app. An initiator starts a plan and manually shares an invitation link in the friends' existing group chat. Friends open the invite and talk privately with their own personal agent for that outing. Each participant must sign in before private agent chat; an invitation link or typed name alone does not establish identity. The agents negotiate in the app, and people review and confirm the plan there. Participants do not install agents. Native iMessage or WhatsApp integration is not required.

## Response cutoff and confirmation

The initiator sets a response cutoff. A person who has not replied by the cutoff is not part of the current proposed group. This establishes only that they did not respond in time; their reason is unknown. It must not be interpreted as a decline, loss of interest, or unavailability.

After the cutoff, the process reassesses the willing attendee set against every remaining person's conditions, including strict limits and attendance dependencies. A missing named person can make another participant ineligible. Earlier approvals for a larger group do not transfer to the revised plan.

Final approval is separate from the response cutoff. After conditions have been gathered and a proposed attendee set is ready, each person's own agent asks them to approve the exact activity, time, estimated cost, and attendee list. The default final-approval window is 30 minutes after final approval is requested. If any user does not approve before expiry, the proposal is not confirmed. Silence is not approval. Expiry does not automatically remove that person or reshuffle the group, and an agent does not commit for its user.

A person who did not respond in time may request to join after the group confirms. The request does not reopen or change the existing plan. The proposed revised group must satisfy every member's conditions, and everyone in that group, including the joiner, must explicitly confirm the revised plan. The existing plan stays intact while the proposed addition is considered.

A material change to the activity, time, estimated cost, or attendee list requires renewed confirmation from each remaining participant. Previous approvals apply to the plan those participants approved.

## Open decisions

- The selection method after invitations, including consensus or voting, tie handling, and the starter's role
- How participants classify conditions as strict or flexible, and how different participants' private rankings are reconciled fairly
- How the candidate catalog, shared group page, and manual options appear and are represented
- The default response cutoff length and any reminders for that cutoff
- Whether users can change the 30-minute final-approval window, how its timing is anchored across participants, and how that setting is presented
- What happens if an activity is due to start while final approval is pending
- Final-approval reminders and their delivery, late approval after expiry or restart, and the disposition of an unconfirmed proposal
- How people submit late replies and join requests, and how reentry works
- How to handle withdrawals or removals and changes after confirmation beyond renewed approval
- Identity provider and sign-in method, matching an account to an invited participant, retention, invite access, and privacy enforcement
- Notifications and agent lifetime beyond an outing
- How multi-person coordination is implemented, whether Cubbie integration is needed, and the technical design
