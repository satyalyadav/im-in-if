# Product brief

## Concept and problem

Planning a movie, dinner, or campus event with friends can fizzle during the back-and-forth. Personal agents help existing student friends turn conditional interest into a social plan by exchanging relevant constraints.

A useful interaction does not require a workable plan, but at least one person must have sparked interest in doing something. Everyone else need not be initially interested or motivated. A plan may start from an incomplete suggestion such as "Dinner Friday?" before anyone chooses a restaurant, exact time, or budget.

## First build

The first version covers one local outing among existing student friends. The demo is a movie night. The broader concept includes movies, dinner, and campus events; trips are outside the first build.

- Cubbie Hackathon Track 2
- Build-time budget: 12 to 16 hours

## Conditions and agreement

Conditions the first version should account for include availability, spending limits, activities a person wants or avoids, attendance dependencies on a named person, and minimum group size. Whether a condition is hard or flexible is not settled.

Each student has a personal agent. The intended sharing policy keeps each student's budget caps, other raw constraints, and personal reasons private to that student and their own agent. Other agents and the shared planning context receive acceptable proposals and counteroffers instead of those raw inputs. Offers and refusals may still reveal clues.

Agents negotiate tentatively. People explicitly approve the final activity, time, estimated cost, and attendees. Booking and payment are outside the first version.

If a smaller willing group proceeds, each attending person's conditions must hold. A person's nonattendance does not automatically veto the others' plan. An explicit attendance dependency still applies to the person who stated it.

## Chosen first-version interaction

The first version is a web app. An initiator starts a plan and manually shares an invitation link in the friends' existing group chat. Friends open the invite and talk privately with their own personal agent for that outing. The agents negotiate in the app, and people review and confirm the plan there. Participants do not install agents. Native iMessage or WhatsApp integration is not required.

## Open decisions

- Account, sign-in, and participant identity
- Invite access and privacy enforcement
- How to implement coordination among multiple people in the web app
- Whether Cubbie integration is needed
- Notifications and agent lifetime beyond an outing
- How participants classify conditions as hard or flexible, and how conflicts are handled
- What happens when a confirmed activity, time, cost, or attendee changes, someone drops out, or a participant does not reply
- Where activity options come from and how their selection is implemented
