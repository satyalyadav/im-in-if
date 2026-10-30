# Private planning verification

This record summarizes checks performed on 2026-10-25 and 2026-10-26. Deployment and service settings below are dated observations. Consult the [build plan](../build-plan.md) for setup and the [product brief](../product-brief.md) for requirements. Original browser traces and provider responses were local run artifacts and are not included in this repository.

## Optional-cutoff chat and email invitation checks

On 2026-10-29, the source for issues [#16](https://github.com/satyalyadav/im-in-if/issues/16) and [#18](https://github.com/satyalyadav/im-in-if/issues/18) passed local checks: `npm test -- --maxWorkers=1` (120 tests across 9 files), `npm run typecheck`, and `AUTH_MODE=local npm run build`. The PGlite integration tests use stubbed network responses; they did not call a live model or email provider.

The checks cover starting a saved chat turn without a cutoff, reusing its idempotency key without duplicate outings or messages, leaving pending invitees and outings unchanged when no cutoff exists, and accepting an email invitation only for an account with the intended verified address. Email delivery and acceptance are independent, and the message reports provider acceptance without claiming delivery. Local auth synthesizes a test email from its user ID; these checks do not establish Clerk verified-email behavior. The initial implementation checks did not include a browser flow or real Resend delivery.

Root browser checks used Chrome, local authentication, a fresh PGlite database, and disabled model and email keys. An idea alone created a chat with one saved opening message and no cutoff or time zone; reopening added no recap or duplicate message. An unrelated local account received 404 for the outing and invitation list. The layout had no horizontal overflow at a 390-pixel viewport. Email sending reported that no email was sent when delivery was disabled.

Kiro Opus 5.5 at medium reviewed standards and spec coverage against the initial implementation. Follow-up fixes label availability with its actual display time zone, distinguish uncertain email sends from definite rejection, use account names or distinct guest labels for invitees, keep invitation GET rendering read-only, provide a persistent announcement for invitation results, and size the message-processing lease to outlast the configured model request timeout. The low-priority duplicate-query and compatibility-parameter refactoring suggestions were not required to change these behaviors.

A follow-up browser check showed that opening the invitation left the intended local recipient without outing access. Choosing Join planning group invoked a POST Server Action, granted admission, and left interest pending. Account names appeared in the roster. A stubbed uncertain-send response produced the correct visible message and a persistent atomic status announcement. New integration regressions cover missing-zone text, distinct account names, read-only invitation checks, and a model request timeout longer than the old claim lease. Browser processes and bounded local servers were closed afterward. No real Clerk verification, provider delivery, live model response, or deployment is established by these checks.

After the review fixes, the serial suite passed all 124 tests across 9 files with `npm test -- --maxWorkers=1 --hookTimeout=60000`. Typechecking and the local-auth production build passed. The longer test-hook limit accommodates PGlite startup on the shared machine; it does not change application timeouts. The build was also rerun successfully with `AUTH_MODE=local CIRCLE_NODE_TOTAL=2 npm run build`; this installed Next version uses that setting for one build worker. Kiro Opus 5.5 at medium rechecked the review-fix commit and reported no remaining blockers. The creation form additionally retains a request ID in memory when session storage is unavailable and treats storage cleanup as best effort.

## Conversational interest and condition checks

On 2026-10-29, the source for issue #17 added a structured interest intention to the private agent reply and removed the participant interest buttons. The message boundary validates the owner's agent output before applying it: the sender must be an admitted participant, the outing must be active, the cutoff must be open, and the owner must not already be on a confirmed plan. A clear conditional statement records interest and its hard condition in the same database statement as the agent reply. A question about options leaves interest unchanged. Unresolved condition questions block interest until the owner answers. A confirmed attendee who says they are out receives guidance to the existing request-to-leave control rather than an ordinary interest toggle. Duplicate client-message IDs return the saved reply, and a retry applies an interest or condition effect at most once because the reply, condition write, and interest write share one guarded statement.

The PGlite integration tests in [`tests/outings-api.test.ts`](../../tests/outings-api.test.ts) cover conditional interest with a hard cap, plain interest with empty conditions, question-only messages, ambiguous strictness, clear disinterest, confirmed-plan withdrawal guidance, published-proposal non-approval, duplicate delivery, retry-once behavior, and cross-account denial. The unit checks in [`tests/conversation-intent.test.ts`](../../tests/conversation-intent.test.ts) cover the same validation rules without a database. The production workspace no longer renders interest or condition-entry buttons; the saved response appears as read-only text in the outing summary. The complete serial suite passed all 140 tests across 10 files with `npm test -- --maxWorkers=1 --hookTimeout=60000`, and `AUTH_MODE=local CIRCLE_NODE_TOTAL=2 npm run build` passed. The checks use deterministic fake agents and PGlite. They did not call a live model, open a browser, or exercise Clerk or a deployment.

## Repeatable demo recipe

Use three separate synthetic sign-in accounts on the deployed Clerk development instance. The app's current Go configuration is DeepSeek only. Before making agent requests, check that the existing OpenCode Go subscription has included usage left and that Extra Usage is disabled. Stop when included usage is exhausted. Do not buy credits, upgrade, or enable Extra Usage.

1. In the starter session, create an outing with a response cutoff and invite two participants. From a pending invitee session, try to open the outing before the starter admits them, then request admission and admit them from the starter session.
2. In each participant's private chat, enter distinct availability, cost, and attendance conditions. Correct one condition after the agent asks a clarification. Privately rank options, resolve a tie, and review the agents' offers and counteroffers. Check the other sessions for private-chat exposure.
3. Review the proposed activity, time, estimated cost, and attendee list. Approve from each listed participant's session and confirm that the proposal remains unconfirmed until all have approved. Try a join and a departure, then verify the revised attendee list requires fresh approvals. Let a proposal expire and restart it without changing the roster.
4. To demonstrate email, use only a real participant who has opted in with a verified address. Trigger an admission notice, check its content and return link, and disclose that the recorded message landed in Gmail Spam. Do not treat opening its link as deadline-reset evidence unless you record that check.
5. Close all browser sessions before the cutoff check and use the authenticated sweep. Run seven-day deletion only against disposable non-production data with a controlled clock. Verify the outing rows are gone and the sign-in account remains.

This recipe is a repeatable run guide, not evidence that every step has passed. The issue #11 table below separates recorded observations from remaining checks.

## Verified behavior

The 2026-10-25 checks used the deployed app, Neon, real OpenCode Go replies, and three synthetic users on a Clerk development instance.

- Created an outing with an explicit response cutoff, requested admission, and admitted participants. Pending invitees, strangers, and non-starters attempting admission received 404; anonymous requests received 401.
- Saved private conversations and restored them after reload. Each participant's workspace excluded other participants' private inputs. Shared offers omitted private notes.
- Generated offers and counteroffers, rejected hard-condition conflicts, resolved private tie answers, and constrained offers to the resolved choice and interested group.
- Confirmed one proposal revision with explicit approval from every attendee. Join and departure proposals required fresh approvals. Expiry preserved the roster; restarting required new approvals.
- Processed a response cutoff through the authenticated maintenance sweep with all browsers closed. A controlled-clock deletion check removed an ended outing and its rows from thirteen dependent tables while preserving the sign-in account.

On 2026-10-26, the source later committed as [`7468794`](https://github.com/satyalyadav/im-in-if/commit/7468794) passed a further deployed three-person flow. The participants supplied a budget cap, an availability window, and an attendance dependency through private chats. Agents produced a compatible offer and counteroffer. The proposal remained unconfirmed after approvals one and two, then confirmed after the third explicit approval. Reload and database checks agreed. All six checks for cross-participant chat exposure passed.

## Source checks

For the source in `7468794`, checked on 2026-10-26:

| Check | Recorded result |
| --- | --- |
| `npm test -- --reporter=verbose --maxWorkers=1` | 86 tests passed across 8 files. |
| `npm run typecheck` | Passed. |
| Vercel production build | Completed; deployment reached `READY`. |

The automated checks cover [provider requests](../../tests/opencode-go-agent.test.ts), [private chat and admission](../../tests/outings-api.test.ts), [planning actions](../../tests/planning-api.test.ts), [proposal revisions](../../tests/proposals.test.ts), [maintenance](../../tests/maintenance.test.ts), and [email handling](../../tests/email.test.ts). Browser checks above are separate observations; test results alone do not establish deployed behavior.

The focused follow-up ran locally on 2026-10-26:

| Check | Recorded result |
| --- | --- |
| `npm test -- --maxWorkers=1 tests/planning-api.test.ts tests/maintenance.test.ts tests/proposals.test.ts` | Passed: 28 tests across 3 files in 129.18 seconds. |
| `npm run typecheck` | Passed after removing a duplicate error-message property in `outing-workspace.tsx`, preserving the message that previously took precedence. |

The focused tests did not call a live model or send email. These results came from local integration tests. No new deployed browser verification was performed for this follow-up.

Before publication on 2026-10-27, `npm test -- --maxWorkers=1 tests/maintenance.test.ts` passed all four tests in 40.07 seconds against `63566d4` with the maintenance additions. `git diff --check` also passed.

## Issue #11 acceptance evidence

Issue #11 asks for eight acceptance checks. This table separates recorded deployed observations, local integration support, and remaining limits. The new tests listed here ran locally and were not deployed. The recorded three-person run provides independent evidence across the browser, server, and production storage. The edge cases do not need separate deployed browser traces. The earlier [October 25 issue comment](https://github.com/satyalyadav/im-in-if/issues/11#issuecomment-6394574133) has since been supplemented by the related issue records below.

| # | Deployed record | Integration support | Remaining limit |
| --- | --- | --- | --- |
| 1 | The October 25 and 26 runs recorded private condition entry and correction, offers and counteroffers, tie follow-up, and explicit approval by all three participants. The October 26 run recorded a budget cap, availability window, and attendance dependency. Issue [#4](https://github.com/satyalyadav/im-in-if/issues/4#issuecomment-6394569200) also records a ranked catalog option and saved interest. | Existing planning and proposal tests cover condition handling, offer generation, and explicit approval. | No raw browser trace is kept in the repository. The recorded run summaries remain the deployed evidence. |
| 2 | Issue [#1](https://github.com/satyalyadav/im-in-if/issues/1) records owner-only access through altered URLs and direct requests, with no private text in logs. Six cross-participant chat-exposure checks passed on October 26. | Workspace and model-context tests cover private chat, conditions, rankings, and draft notes in [`planning-api.test.ts`](../../tests/planning-api.test.ts) and [`outings-api.test.ts`](../../tests/outings-api.test.ts). | These checks establish app access controls. They do not claim technical isolation from the app or model provider. |
| 3 | The deployed runs recorded a hard-condition rejection, an attendance dependency, and a proposal confirmed only after all three people approved. Issue [#9](https://github.com/satyalyadav/im-in-if/issues/9#issuecomment-6394570191) records a three-to-two departure and two-to-three join with fresh approvals, including a smaller willing group. | New PGlite-backed handler tests cover mutual attendance dependencies, an omitted required person, minimum group size, and a feasible smaller willing group. A rejected model candidate leaves the hard condition unchanged and creates no offer, proposal, or approval. Existing tests also cover no agreement. | The added edge cases were not each replayed in a deployed browser. They support the recorded end-to-end flow and do not create a separate deployment claim. |
| 4 | Issue [#7](https://github.com/satyalyadav/im-in-if/issues/7#issuecomment-6394569759) records controlled-clock proposal expiry without client action, an unchanged roster, restart at revision 2, and rejection of stale and concurrent actions. A deployed authenticated sweep also processed a response cutoff with all browsers closed. | New PGlite coverage calls the authenticated maintenance route with a due proposal and no participant request; the response reports one expired proposal. Existing tests cover simultaneous approvals, stale revisions, restart, and the exact deadline. | GitHub scheduling is best effort. Request-time deadline checks remain active. |
| 5 | Issue [#2](https://github.com/satyalyadav/im-in-if/issues/2#issuecomment-6394568761) records deletion across fourteen outing tables, including notices and outbox rows, while the account remained usable. Neon reported zero history retention and no snapshots; a historical restore probe was rejected. | New tests check that a `no_agreement` attempt remains before seven days, is purged at the boundary, and does not make the same starter's next outing inaccessible. | The app does not store sign-in accounts. Physical vendor WAL erasure timing and provider-held email copies remain outside the app's deletion policy. |
| 6 | A verified, opted-in participant received an admission notice in Gmail Spam, and its authorized link opened the expected outing. The [closed issue #10 comment](https://github.com/satyalyadav/im-in-if/issues/10#issuecomment-6400620653) records that observation. | The shared email dispatcher tests cover admission and final-approval events. A new workspace response test confirms that reading the published proposal leaves its approval timestamp and deadline unchanged. | Primary-inbox placement and broad deliverability are unverified. Gmail Spam placement is disclosed, not an added demo acceptance gate. |
| 7 | Issue [#4](https://github.com/satyalyadav/im-in-if/issues/4#issuecomment-6394569200) records that the sample catalog entries were labeled. | Existing tests cover sample options and manual option creation. | Sample prices are not live listings or verified prices. |
| 8 | Source checks and deployed observations are dated above. On October 26, the user approved the existing OpenCode Go key and included subscription usage. | No new provider calls or credentials were needed for this follow-up. | No account-specific remaining-usage snapshot is recorded. Check included usage and keep Extra Usage disabled before a demo; stop if included usage is exhausted. `$0` means no incremental purchases, upgrades, credits, or Extra Usage. The October 31, 2026 date in the [dated terms check](https://opencode.ai/v2/docs/console/go/) concerns the DeepSeek zero-data-retention agreement, not free use. |

## Data retention checks

On 2026-10-25, before adding outing data, the Neon project API reported `history_retention_seconds=0`, no snapshots, and only the main branch. A controlled historical restore attempt was rejected, and no probe branch was created. This established the tested app-accessible restoration settings; it did not establish physical vendor WAL erasure timing.

The app's purge query uses `ended_at + 7 days` as the deletion threshold and cascades through outing data, including its email outbox. Tests check that it does not purge early. A delayed sweep can delay deletion. Provider-held copies remain outside the app's deletion policy. See [maintenance](../../lib/maintenance.ts) and the [scheduler research](../research/2026-10-25-free-maintenance-scheduler.md).

## Runtime and scheduler inspection

On October 26 local time, a Vercel production runtime-log query covered the preceding 30 minutes and returned fifteen records. Their message bodies contained only Clerk SDK telemetry notices, with no planning inputs. Request metadata included paths and outing IDs. This is a bounded retained-window observation, not proof of older logs or vendor erasure. No separate application tracing integration was found in the inspected app and library sources.

The maintenance workflow contains a global URL and secret, without per-outing workflow payloads. GitHub Actions run [40423801342](https://github.com/satyalyadav/im-in-if/actions/runs/40423801342) succeeded and returned only `ok`, `cutoffsProcessed`, `proposalsExpired`, and `outingsDeleted`, all counts zero. Source inspection found application diagnostics restricted to failure codes and safe provider diagnostics. The deployed deletion observation in issue #2 includes app-held notices and email outbox rows.

## Included Go usage

The [OpenCode terms](https://opencode.ai/v2/docs/console/go/) inspected on October 26 list a DeepSeek V4.1 Flash monthly allowance of $80 of metered usage on Go and $160 on Go Plus. Five-hour and weekly limits are 20% and 50% of the monthly allowance. These are subscription usage limits, not permission to buy credits or spend those amounts. No account-specific remaining balance or Extra Usage setting was inspected in this follow-up. The user authorizes the existing subscription's included usage, with no incremental spending.

## Production email evidence

On 2026-10-25, a verified account opted in to email. After the fix in [`25d97e7`](https://github.com/satyalyadav/im-in-if/commit/25d97e7), saving the preference returned 200 and it survived reload. One admission notice reached the recipient's Gmail Spam folder; its return link opened the expected outing. An opted-out synthetic invitee received no email in that check.

Broader deliverability and primary-inbox placement were not established. DNS checks that day found the sender's DKIM record but no DMARC record at the sender subdomain or parent domain. Missing DMARC was a possible gap, not a proven cause of Spam placement. Provider retention and DNS settings need rechecking before relying on those observations.

## Scheduled maintenance

On 2026-10-25, the authenticated sweep and health endpoints returned aggregate results without outing identifiers. Manual GitHub Actions run [40170521273](https://github.com/satyalyadav/im-in-if/actions/runs/40170521273) succeeded. The [workflow](../../.github/workflows/outing-sweep.yml) requests a five-minute cadence; GitHub scheduling is best effort. Request-time deadline checks remain authoritative.

## Limits and follow-up

- The deployed checks used Clerk development authentication. This is a disclosed demo limit; issue #11 does not require production authentication. These runs do not establish production-instance session behavior or launch capacity.
- The tested OpenCode Go route used `deepseek-v4.1-flash`, a stable per-participant session, and no provider fallback. Its billing guard rejects responses without an explicit `go` or `go-plus` source and finite numeric zero cost. This guard runs after a request; disabling account Extra Usage is the preventive control. See [the adapter](../../lib/agent.ts).
- OpenCode Go is a paid subscription with included usage. The user approved use of the existing key and subscription usage only. The `$0` limit forbids incremental purchases, upgrades, credits, and Extra Usage. Check the remaining included allowance and that Extra Usage is disabled before a demo; stop if the allowance is exhausted. The current DeepSeek zero-data-retention agreement runs through 2026-10-31 and renews monthly. Recheck that agreement after its current term. Planning-app support is not guaranteed.
- Workspace privacy checks establish participant access controls, not technical isolation from the app or model provider. See the [privacy decision](../adr/0001-private-planning-inputs.md).
- Sample movie options are not live listings or verified prices. Booking and payment remain outside the first version.
