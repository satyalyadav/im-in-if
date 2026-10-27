# Production video flow verification

Checked 2026-10-26 against the production app at [im-in-if.vercel.app](https://im-in-if.vercel.app), deployment `dpl_4JFmA9RTZsoEF3NrzF7tqG8eaDfu`. The walkthrough started at `2026-10-26T23:01:57.791Z`. The Vercel Go API key was rotated before this build. The deployment came from the tested local working tree. This record contains no credential values or authentication headers.

The [walkthrough evidence](/tmp/im-in-if-video-verification/walkthrough-final.json) and [privacy evidence](/tmp/im-in-if-video-verification/privacy-final.json) use synthetic planning data. Starter, Maya, and Sam are the participant labels used in this run.

## Observed flow

- The three participants used their own private chats to provide planning conditions and separately chose "I'm interested". The starter had a $15 hard budget. Maya's hard availability began at 7:01 PM. Sam would attend only if Maya attended.
- Maya offered the 8 PM sample option for $12. The starter privately ranked 8 PM, generated a counteroffer, and published it. Both offers were published.
- Proposal revision 1 was published with zero approvals. Maya approved first, bringing the count to one. The starter approved second, bringing it to two while the proposal remained in planning. Sam approved third, bringing the count to three and confirming the proposal. After reload, the starter saw the confirmed plan and all three approvals.
- The privacy evidence records all six checks that each participant's chat stayed hidden from the other two. It also records the proposal as unconfirmed before final approval.

## Implementation notes

- The OpenCode Go request disables DeepSeek thinking when it sends the forced typed reply tool. The provider test covers this request shape in [lib/agent.ts](../../lib/agent.ts) and [tests/opencode-go-agent.test.ts](../../tests/opencode-go-agent.test.ts).
- Offer generation sends the model only catalog options that pass the owner's hard availability, budget, and activity-tag checks. It includes each option's local time and time zone. The server still validates the model's candidate. See [lib/agent.ts](../../lib/agent.ts) and [lib/planning-api.ts](../../lib/planning-api.ts).
- A new outing creates labeled 7 PM and 8 PM sample movie options for the local calendar day after the cutoff, using the cutoff's time zone. The sample prices are $9 and $12. [lib/outings-api.ts](../../lib/outings-api.ts) seeds them.
- Offer rejection responses use a generic reason code, such as `condition_conflict`, without returning private condition text. The tests check that private inputs, notes, participant IDs, and outing IDs do not appear in the response or rejection log. Provider failure diagnostics also omit provider response text.
- [.vercelignore](../../.vercelignore) excludes `.data/`, `.next/`, `.vercel/`, `.git/`, `node_modules/`, `.env*` while allowing `.env.example`, and `*.tsbuildinfo`.

## Recording prerequisites

1. Start a new outing with an explicit future response-cutoff date, time, and time zone. Existing sample option times were not migrated. A new outing creates samples for the next local calendar date after the cutoff.
2. Use synthetic accounts and planning data. Admit all three participants before starting their private chats. State the same outing date and time zone in each chat. After their conditions are ready, each person must choose "I'm interested" before the response cutoff. Saying it in chat does not set their response status.
3. Use the tested conditions: the starter has a $15 hard budget, Maya's hard window is 7:01 PM through 11 PM, and Sam attends only if Maya does. These make 7 PM infeasible for Maya and allow 8 PM. Have Maya ask for an offer and publish the 8 PM, $12 draft. Have the starter privately rank 8 PM, ask for an offer, and publish the counteroffer.
4. After the response cutoff, publish the proposal during the recording. The shared approval deadline is 30 minutes after publication, or the activity start if sooner. Each person must choose "Confirm this exact plan" for the activity, time, estimated cost, and attendee list.

The cutoff and confirmation rules are in the [product brief](../product-brief.md#response-cutoff-and-confirmation). This run verifies the described synthetic flow; it does not claim technical isolation from the app or model provider. Sample options are not live listings or current prices. Booking and payment remain outside the first version.

## Build segment evidence

The task given to AI was to test this three-person recording flow and fix failures. An actual model replay chose 7 PM despite its owner's hard 7:01 PM earliest time. The server rejected that candidate. The change in [lib/agent.ts](../../lib/agent.ts) now filters the catalog with the shared hard-condition checks in [lib/planning.ts](../../lib/planning.ts) before asking the model to choose. The transport regression in [tests/opencode-go-agent.test.ts](../../tests/opencode-go-agent.test.ts) failed before the filter and passed afterward.

Review that diff and test before recording. For the product decision, show the [requirement that each person decides whether to commit](../product-brief.md#conditions-preferences-and-negotiation) and the three explicit approvals described above.

## Source checks

- `npm test -- --reporter=verbose --maxWorkers=1`: passed, 8 test files and 86 tests, in 211.27 seconds. [Full test log](/tmp/im-in-if-video-verification/frozen-final-tests.log).
- `npm run typecheck`: passed. [Typecheck log](/tmp/im-in-if-video-verification/frozen-final-typecheck.log).
- The remote production build completed and the deployment reached `READY`. [Build events](/tmp/im-in-if-video-verification/final-build-events.json).
- The fingerprint of the changed source and test diffs plus `.vercelignore` was `b587bd3e84a6c25df392881fa51b307665e38c6c510f166f409844ca9d76eb78` before and after both checks.
