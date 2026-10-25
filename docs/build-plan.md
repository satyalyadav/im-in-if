# Build plan and current setup

Updated 2026-10-25. The approved product requirements remain in [product-brief.md](product-brief.md). The current provider choice follows the user's later direction: OpenCode Go `deepseek-v4.1-flash` only, with no alternate provider or model fallback. No paid use, purchases, DNS edits, or private outing data are part of this implementation.

## Services and boundaries

| Component | Current choice and status |
| --- | --- |
| App and storage | Next.js with Vercel AI SDK. Local development uses embedded PGlite; production uses Neon through `DATABASE_URL`. Missing production auth/database bindings fail closed. |
| Sign-in | Local cookie auth is development-only. Production uses Clerk. Admission requires a signed-in account. Email opt-in accepts only an address verified on that Clerk account. |
| Agent | OpenCode Go at its explicit OpenAI-compatible endpoint, pinned to `deepseek-v4.1-flash`. Stable per-participant session IDs and the app's honest User-Agent are sent. Response metadata must confirm `go` or `go-plus` and numeric zero cost. The guard detects billing metadata after the request; account Extra Usage must remain disabled before calls. Go is intended for coding-agent traffic and does not guarantee planning-app support. The current free-use term runs through 2026-10-31; recheck before later demos. [OpenCode Go terms](https://opencode.ai/v2/docs/console/go/). |
| Neon retention | Project check found `history_retention_seconds=0`, no snapshots, and only the main branch. A controlled restore probe from before the setting was rejected by the zero-second retention window. This disables app-accessible historical restoration; it does not establish physical WAL erasure timing. See [verification](verification/0001-private-agent-slice.md). |
| Email | Resend sender `notify.satyalyadav.com` is verified and the production key is configured. The adapter sends only admission and final-approval notices to opted-in verified recipients; local mode suppresses sends. Notices contain no private planning data. The real starter's verified opt-in remained checked after refresh, an admission-request email arrived in Gmail Spam, and the return link opened the correct outing. Primary-inbox placement and broader deliverability remain unverified. The approved policy covers app-held recipient, link, and outbox rows; provider copies are outside the policy. |
| Durable sweep | The global, ID-free sweep is live at `POST /api/maintenance/sweep` and has processed a real cutoff with every browser closed. Its health endpoint reports aggregate freshness only. A five-minute GitHub Actions workflow is active on the default branch with repository secrets set; a manual run succeeded. GitHub may delay or drop scheduled runs, so request-time deadline checks remain authoritative. Public-repository hosted-runner billing is documented by [GitHub Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage); schedule behavior is documented in [workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). |

## Data and negotiation

- Each admitted participant sees their own private conversation, condition state, rankings, and draft notes. One agent reply may update only that participant's conditions; the agent receives that owner's conversation and state plus the admitted public roster. Other participants' raw limits, reasons, chats, and draft notes are not shared.
- The private chat gathers conditions, asks focused questions about ambiguity, and handles corrections. No structured condition fields or separate interpretation/save action appear in the UI. The server validates candidate attendee sets against each person's hard limits and attendance dependencies. It preserves prior hard limits, requires explicit owner consent to relax them, and blocks negotiation while questions remain unresolved. Condition updates and replies commit together, increment the condition version on material changes, and supersede published proposals.
- Catalog samples are labeled; people can add manual options. Tie follow-up is private and allowed once per person. No common option ends in no agreement; all-either answers allow a candidate but still require every listed human's explicit confirmation.
- Proposals bind exact option, activity, time, estimated cost, attendee IDs, and revision. Their deadline is the earlier of publication plus 30 minutes or activity start. Confirmations are atomic and tied to one revision. Expiry leaves the roster unchanged; only an admitted participant can request a restart. Joins and departures create renewed proposals and require the remaining/new roster's confirmations.
- Admission requests are pending and reveal no outing details. Admission is not attendance or confirmation. Only the starter can decide admission, with an in-app notice.
- Each outing gets one database timestamp for seven-day app-data deletion. The global sweep and request-time checks delete at `ended_at + 7 days`, cascade through outing tables, and preserve sign-in accounts. They do not purge early. Failed model turns do not end an outing because the same turn can be retried; no-agreement and ended outings have `ended_at`.
- No private outing data is placed in durable scheduler metadata or logs. Scheduler state retains only aggregate counts and timestamps.

## Setup status and remaining verification

The Vercel project, Clerk development instance, and Neon database are provisioned. The app is deployed at <https://im-in-if.vercel.app>. Production and preview Go settings are pinned to DeepSeek; the API key remains a secret. Neon retention checks passed before app data was added.

Deployed browser checks passed with three synthetic Clerk development users: outing creation, invitation and admission, private chat through DeepSeek, condition interpretation, tie follow-up, offers, three-person confirmation, departure and join revisions, expiry and restart, direct-request privacy denials, an opt-out email flow, and a controlled-clock seven-day cascade deletion. The record is in [verification](verification/0001-private-agent-slice.md).

Resend sender verification and one real opted-in recipient's admission delivery and return link have been verified. Gmail classified that message as Spam; primary-inbox placement and broader deliverability remain unverified.

The GitHub Actions workflow is enabled on `main` with repository secrets configured; manual run 40170521273 succeeded. The authenticated sweep endpoint works in production; `GET /api/maintenance/health` reports aggregate freshness only.

## Acceptance checks

- Passed: direct requests as an admitted participant, a pending invitee, a stranger, a non-starter attempting admission, and an anonymous caller. Private messages, conditions, rankings, and offer notes stayed scoped to their owner.
- Passed: model-generated offers and counteroffers with synthetic content; infeasible strict conditions were rejected; tie choices constrained offers; mutual dependencies were evaluated against one proposed attendee set.
- Partially passed: email opt-in accepts only a verified account email; no planning details are in the message; event sends are idempotent. The real starter's verified opt-in remained checked after refresh, an admission-request email arrived in Gmail Spam, and the return link opened the correct outing. Primary-inbox placement and broader deliverability remain unverified.
- Passed: simultaneous approvals, stale revisions, exact deadlines, unchanged roster after expiry, restart, joins, and departures. Conditions changes invalidate published proposals.
- Passed: the sweep ran with browsers closed, processed a real cutoff, and deleted a controlled-clock seven-day-old outing with all cascading rows. Scheduler health contained only aggregate counts and timestamps.
- Passed: deployed browser-to-storage verification with synthetic app inputs. The Clerk instance is development-only and the model route is free through 2026-10-31; recheck both before a later demo.
