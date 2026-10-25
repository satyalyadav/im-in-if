# Product brief

## Concept and problem

Planning a movie, dinner, or campus event with friends can fizzle during the back-and-forth. Personal agents help existing student friends turn conditional interest into a social plan by exchanging relevant constraints.

At least one person must have sparked interest in doing something, but everyone else need not be initially interested or motivated. A plan may start from an incomplete suggestion such as "Dinner Friday?" before anyone chooses a restaurant, exact time, or budget. A useful result may be that current replies and known options do not yield a willing attendee set. This does not prove that no real-world plan exists.

## First build

The first version covers one local outing among existing student friends. The demo is a movie night. The broader concept includes movies, dinner, and campus events; trips are outside the first build.

- Cubbie Hackathon Track 2
- Build-time budget: 12 to 16 hours

The first version uses a small catalog of candidate options with stated showtimes and prices. People can add options manually. Synthetic or sample entries must be labeled clearly. The catalog does not claim live discovery or verified ticket prices. Live discovery for movie showtimes, restaurants, and events is deferred.

## Conditions and negotiation

The first version should account for availability, spending limits, activities a person wants or avoids, named-person attendance dependencies, and minimum group size. Strict limits are mandatory. An agent may compromise on a flexible preference, but only its owner may explicitly relax a strict limit. How participants classify conditions as strict or flexible remains undecided.

If a condition's meaning or strictness is unclear, the agent asks its own user a focused question. Before negotiation, each agent shows its user a short, editable summary of its interpretation. The agent does not silently guess at strict limits.

A smaller willing group may proceed if each attendee's conditions hold. A person who does not attend does not automatically veto the others' plan. Attendance dependencies can be evaluated together against one proposed attendee set. Mutually dependent people do not need unconditional prior commitments, but each must explicitly confirm that same plan through their own agent. A missing named person may block another participant's attendance dependency.

Agents explain feasible options and tradeoffs in simple terms so people can choose. The product does not automatically prioritize maximum attendance or assign numeric scores. Which person or people have final authority when choices conflict remains open.

Each agent asks its own user to approve the plan. The user makes the decision; the agent does not commit on the user's behalf. A confirmation covers the activity, time, estimated cost, and attendee list. Booking and payment are outside the first version.

The intended sharing policy keeps each student's budget caps, other raw constraints, and personal reasons private to that student and their own agent. Other agents and the shared planning context may see only offer details the participant approves for sharing, such as proposed attendees, time, and estimated cost. Offers and refusals may still reveal clues.

## Chosen first-version interaction

The first version is a web app. An initiator starts a plan and manually shares an invitation link in the friends' existing group chat. Friends open the invite and talk privately with their own personal agent for that outing. The agents negotiate in the app, and people review and confirm the plan there. Participants do not install agents. Native iMessage or WhatsApp integration is not required.

## Deadline and confirmation changes

The initiator sets a decision deadline. Silence never counts as agreement. At the deadline, the process can identify a willing attendee set that may proceed or report that current replies and known options do not yield one. How that latter outcome is described remains open, as does whether the decision deadline is also the cutoff for final confirmation.

A material change to the activity, time, estimated cost, or attendee list requires renewed confirmation from each remaining participant. Previous approvals apply to the plan those participants approved.

## Open decisions

- Which people have final authority to select a group or plan, and how conflicting human choices are resolved
- How participants classify conditions as strict or flexible, and how flexible preferences are ranked or balanced fairly
- How the candidate catalog and manual options appear and are represented
- Default deadline length, reminder delivery, late replies and joins, and handling pending confirmations at the deadline
- How to handle dropouts and changes after confirmation beyond renewed approval
- Account, sign-in, participant identity, invite access, and privacy enforcement
- Notifications and agent lifetime beyond an outing
- How multi-person coordination is implemented, whether Cubbie integration is needed, and the technical design
