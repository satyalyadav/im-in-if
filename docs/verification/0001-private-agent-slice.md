# Private planning verification

This record summarizes checks performed on 2026-10-25 and 2026-10-26. Deployment and service settings below are dated observations. Consult the [build plan](../build-plan.md) for setup and the [product brief](../product-brief.md) for requirements. Original browser traces and provider responses were local run artifacts and are not included in this repository.

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

## Data retention checks

On 2026-10-25, before adding outing data, the Neon project API reported `history_retention_seconds=0`, no snapshots, and only the main branch. A controlled historical restore attempt was rejected, and no probe branch was created. This established the tested app-accessible restoration settings; it did not establish physical vendor WAL erasure timing.

The app's purge query uses `ended_at + 7 days` as the deletion threshold and cascades through outing data, including its email outbox. Tests check that it does not purge early. A delayed sweep can delay deletion. Provider-held copies remain outside the app's deletion policy. See [maintenance](../../lib/maintenance.ts) and the [scheduler research](../research/2026-10-25-free-maintenance-scheduler.md).

## Production email evidence

On 2026-10-25, a verified account opted in to email. After the fix in [`25d97e7`](https://github.com/satyalyadav/im-in-if/commit/25d97e7), saving the preference returned 200 and it survived reload. One admission notice reached the recipient's Gmail Spam folder; its return link opened the expected outing. An opted-out synthetic invitee received no email in that check.

Broader deliverability and primary-inbox placement were not established. DNS checks that day found the sender's DKIM record but no DMARC record at the sender subdomain or parent domain. Missing DMARC was a possible gap, not a proven cause of Spam placement. Provider retention and DNS settings need rechecking before relying on those observations.

## Scheduled maintenance

On 2026-10-25, the authenticated sweep and health endpoints returned aggregate results without outing identifiers. Manual GitHub Actions run [40170521273](https://github.com/satyalyadav/im-in-if/actions/runs/40170521273) succeeded. The [workflow](../../.github/workflows/outing-sweep.yml) requests a five-minute cadence; GitHub scheduling is best effort. Request-time deadline checks remain authoritative.

## Limits and follow-up

- The deployed checks used Clerk development authentication. They do not establish production-instance session behavior or launch capacity.
- The tested OpenCode Go route used `deepseek-v4.1-flash`, a stable per-participant session, and no provider fallback. Its billing guard rejects responses without an explicit `go` or `go-plus` source and finite numeric zero cost. This guard runs after a request; disabling account Extra Usage is the preventive control. See [the adapter](../../lib/agent.ts).
- The provider terms recorded during these runs offered free use through 2026-10-31. Recheck eligibility and terms before further use. Planning-app support and continued free availability were not guaranteed.
- Workspace privacy checks establish participant access controls, not technical isolation from the app or model provider. See the [privacy decision](../adr/0001-private-planning-inputs.md).
- Sample movie options are not live listings or verified prices. Booking and payment remain outside the first version.
