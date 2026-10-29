# Let personal agents handle outing negotiation

The target experience puts planning inside each participant's private chat, replacing the separate catalog, offers, and confirmation sections so people do not have to manage negotiation themselves. A personal agent may find suitable options and exchange offers and counteroffers without approval at every step, but must respect its owner's hard conditions and obtain their explicit approval of the final activity, time, estimated cost, and attendee list.

Keep the app's forest green, pale green, gold, and ink palette with Newsreader headings and Instrument Sans body text; simplify interactions without adopting iMessage styling.

Use variant C of the chat prototype as the selected design reference. The prototype answered whether planning could work through a simple conversation with a compact read-only plan; the user accepted C after the styling was adapted to the existing app. Preserve the full comparison on branch `prototype/agent-chat`, with the reviewed prototype at commit `b198b10` in `public/prototypes/agent-chat.html`, opened with `?variant=C`. Its scripted replies demonstrate the intended interaction, not working agent negotiation.

Keep private conversations and agent memory scoped to one outing, with participants switching outings through the existing homescreen. This decision preserves the private-input policy in [ADR 0001](0001-private-planning-inputs.md); permission to negotiate does not authorize sharing raw conditions or personal reasons.

Negotiation continues when a participant closes the app. Clear statements that a participant is interested or not interested record that response with an acknowledgment; questions about available plans alone do not count as interest. Participants give interest, conditions, approval, changes, clarifications, and requests to keep or restore an earlier proposal by typing in their private chat. Admission decisions also happen by typing in that chat. Do not add buttons or forms for these planning actions.

Show the current proposal as a compact, read-only attachment in the conversation. It contains only the activity and location, exact date and time with time zone, estimated per-person cost, and attendee names. The personal agent asks whether it works in a normal chat message. An explicit yes approves only its owner. Do not show a separate approval roster. The plan is confirmed only when every proposed attendee approves the same details. Any material change or restoration clears all approvals.

The agent normally negotiates one recommendation using its owner's conditions and preferences. It shows alternatives on request and asks for a choice when the owner's preferences do not settle a meaningful difference.

The starter must explicitly approve admission to the planning group. The agent presents admission requests inside the private chat, where the starter responds by typing. For now, the starter sends email invitations through a separate invitation control rather than through chat; that direct invitation grants admission when the recipient signs in with the invited verified email address, without a second approval from the starter. A shared invitation link still requires the starter's approval and must not grant admission merely because someone possesses the link.

Do not generate an automatic catch-up when someone returns to an outing; they may ask the agent for an update. Automatically present each plan awaiting approval in every proposed attendee's private chat, clearly requesting their decision without requiring them to ask for an update. If they were away, show the current pending request when they return. Do not add approval-request emails in this redesign, and defer alerts outside the chat. Email invitations sent through the separate invitation control remain in scope.

Keep live venue research and bookings outside this redesign. The agent must describe unverified options and estimated costs as tentative rather than claiming to have checked opening hours, prices, or availability.

Start new outings through chat from the existing homescreen. A person can describe what they want to do and optionally when; do not require an activity time before they can begin the conversation.

Make the response cutoff optional. The starter may set one in conversation, but creating an outing must not require it or silently invent one. Without a cutoff, do not automatically exclude participants merely because they have not replied.

Keep a proposal available for explicit approval until the proposed activity starts, replacing the previous 30-minute approval window because alerts are deferred and participants may be away. Every proposed attendee must approve the same current plan before its start time; changing its details requires fresh approval.
