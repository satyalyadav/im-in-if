# Private planning verification

Checked 2026-10-25. This record separates implemented behavior, deployed evidence, and remaining blockers. It does not claim that unit tests alone prove the full browser-to-storage flow.

## Current status

| Area | Status |
| --- | --- |
| Starter chat, per-participant chat ownership, admission, private conditions, catalog, offers, proposals, confirmations, joins, and departures | Implemented. Unit and deployed browser checks passed for the synthetic development-instance flow. |
| Model selection | Pinned to OpenCode Go `deepseek-v4.1-flash`; no other model or provider fallback. Extra Usage is confirmed off by the user. |
| DeepSeek live calls | Deployed chat, condition interpretation, and offer generation returned real replies. A direct compatibility check returned `go` billing and numeric zero cost in 1.813 s. Evidence: `/tmp/im-in-if-remaining-run/deepseek-live-check.json`. This does not establish guaranteed planning-app support. |
| Billing safety | Successful responses without an explicit `go`/`go-plus` source and finite numeric zero cost are rejected. This runs after the provider response and cannot prevent a charge. Extra Usage off is the preventive control. |
| Production app | Deployed at <https://im-in-if.vercel.app> (Vercel project `prj_zjyTygz8z1k7UkbQdy1lb32v42Xw`). Production uses Clerk, Neon, and the production secrets. |
| Neon app-accessible restoration | Verified at zero-second history retention with no snapshots. A controlled historical restore probe was rejected. No app outing data existed during the check. |
| App-held seven-day deletion | Exact `ended_at + 7 days` cascade deletion is implemented and proved against the deployed database with a controlled clock. Tests do not purge early. Vendor-side physical erasure is not claimed. |
| Email | Opt-in persistence and one real-recipient admission notice are verified in production. The recipient found the message in Spam and its return link opened the expected outing; broader inbox placement and deliverability are not established. See [production email evidence](#production-email-evidence). |
| Scheduled maintenance | The authenticated global sweep and health endpoint work in production. The five-minute ID-free GitHub Actions workflow is active on `main`, repository secrets are set, and a manual run succeeded. |
| Full browser flow | Completed with three synthetic Clerk development users: creation, invitation, pending denial, admission, private chat, interpretation, tie answers, offers, three-person confirmation, departure, join, expiry, restart, and privacy checks. |

## Model request and limits

The active route is `https://opencode.ai/inference/go/openai/v1` with `deepseek-v4.1-flash`. Requests use the honest `im-in-if/0.1.0` User-Agent and a stable per-participant `x-opencode-session`. The app does not choose GLM, ASU, Zen, or a paid fallback.

The response guard requires `usage.opencode.billing_source` to be `go` or `go-plus` and every reported provider cost field (`usage.cost`, `usage.cost0`) to be a finite numeric zero. Missing, malformed, nonzero, or conflicting values fail closed. The key is a deployment secret and is absent from the repository and evidence files.

OpenCode Go is intended for coding-agent traffic and does not guarantee use by this planning app. The current DeepSeek Go free-use term runs through 2026-10-31; recheck it before a later demo. Do not enable Extra Usage or switch providers without an explicit user decision.

## Deployment and authentication

Production is the Vercel project above, served at the stable `https://im-in-if.vercel.app` alias. `APP_BASE_URL` points to that origin, and the production deployment exposes no Vercel SSO wall on that alias. Preview deployments should keep their normal protection.

Clerk is a **development instance** (`pk_test_`/`sk_test_`). Three synthetic users with `+clerk_test@example.com` addresses were used for deployment checks. Their sessions exercised the real Clerk browser SDK and Neon persistence. This is not evidence of a Clerk production instance, production session-cookie behavior, or the 100-user development limit being sufficient for launch. The synthetic accounts are job-owned and can be removed with `/tmp/im-in-if-remaining-run/managed-auth/cleanup-test-users.mjs`.

Neon is project `polished-truth-38314900`, main branch only. The app uses pooled `DATABASE_URL`. The schema migration takes a session advisory lock and is idempotent. A missing production database binding fails closed.

## Neon retention evidence

Root verified the production Neon project before any outing data was added:

- The project API returned `history_retention_seconds=0`.
- The snapshots list had count `0`; the branch list contained only the main branch.
- A controlled compute-free restore attempt from before the retention change was rejected by the zero-second window. No probe branch was created.
- Evidence: `/tmp/im-in-if-remaining-run/neon-retention-verification.json` and `/tmp/im-in-if-remaining-run/restore-probe.json`.

This verifies that app-accessible historical restoration is disabled under the tested project setting. Physical vendor WAL erasure timing is vendor-specific and is not claimed. The approved promise remains exact deletion of app-held outing data seven days after `ended_at`; do not change it to an early-purge policy.

## App behavior and privacy boundaries

- A signed-in invitee receives no outing details before admission. Admission is not attendance or confirmation, and the starter receives an in-app notice.
- Each participant sees only their own chat, private input, structured conditions, rankings, and draft notes. Shared offers omit private notes. The shared participant list contains only user ID and display name.
- Server validation checks strict limits and mutual attendance dependencies against the exact attendee set. Model output cannot override those checks or relax a hard condition.
- Offers may counter only a published offer from another participant. Tie answers are private and saved once. Only one tie poll may be open per outing. The tie result constrains newly generated and already-published offers; all-either answers still require a new proposal and explicit human approvals.
- Each proposal revision binds the option, activity, time, estimated cost, attendee IDs, and a version of every listed participant's conditions. All listed attendees must approve the same revision. A condition change after publication expires or rejects the proposal. The shared deadline is the earlier of publication plus 30 minutes or activity start.
- Expiry leaves the roster unchanged. Only an admitted participant can request a restart. A restarted proposal needs new approvals from every listed person and does not inherit earlier approvals.
- A confirmed join or departure creates a revised proposal. The remaining and new roster must approve it. A failed or stale request is expired rather than silently replacing the confirmed plan. If a departure makes the remaining roster infeasible, the old confirmation is superseded and the outing returns to planning for explicit renegotiation instead of ending for everyone.
- The scheduler stores only aggregate run timestamps and counts. It receives no outing IDs, conditions, chats, or offer data. Logs contain generic failure codes.
- Admission and final-approval emails are opt-in only and require a verified account email in production. The message contains a short return link and no planning details. Provider idempotency keys and event keys make retries safe. Ambiguous deliveries are not retried after the provider idempotency window.
- Deleting an outing cascades through participants, preferences, messages, options, offers, proposals, approvals, join and departure requests, tie polls and answers, in-app notices, and email outbox rows.

## Verification runs

### Source checks

- `npx vitest run` with `maxWorkers: 1`: 52 of 52 tests passed on 2026-10-25.
- `npm run typecheck`: passed.
- `AUTH_MODE=local npm run build`: passed.

### Deployed browser-to-storage checks

All checks used the production deployment and production Neon database, with synthetic Clerk development users and synthetic planning content.

- Created an outing from the browser with an explicit response cutoff.
- Sent and received real private chat replies through OpenCode Go DeepSeek in all three participant sessions.
- Ran condition interpretation through the model, then saved the corrected structured conditions.
- Invited two friends, confirmed pending invitees could not open the outing, and admitted both. A non-starter admission attempt returned 404.
- Closed every browser, waited for the cutoff, and invoked the authenticated sweep. The sweep processed the cutoff without ending an outing whose admitted participants were interested. Health was fresh and contained no outing IDs.
- Started a private A/B tie follow-up, answered `either` from all three participants, and generated offers constrained to the resolved tie and the full interested set.
- Published the proposal, and confirmed the same revision from all three listed attendees. The database recorded three approvals, one confirmed proposal, and three in-app confirmation notices.
- Requested a departure, confirmed the revised two-person proposal, then requested a join and confirmed the revised three-person proposal. Revisions 1 and 2 were superseded; revision 3 was confirmed.
- Expired a proposal by controlled database clock, ran the sweep without a client action, verified the proposal expired and left the roster unchanged, restarted it as an admitted participant, and confirmed revision 2 with fresh approvals from both attendees.
- Verified direct-request denials: pending invitee 404, signed-in stranger 404, non-starter admission 404, pending participant planning 404, and anonymous request 401. A participant's workspace did not contain another participant's private input.
- Verified deletion with a controlled clock: ended an outing, moved `ended_at` eight days into the past, ran the sweep, and found zero rows for the outing and all thirteen cascading tables. The same signed-in account still loaded and the deleted outing returned 404.
- Earlier synthetic email check: asked the app to send an admission notice to Resend's `delivered@resend.dev` test sink. The outbox recorded `sent`; at that time no human address received mail and no synthetic Clerk user was opted in.

Evidence lives under `/tmp/im-in-if-remaining-run/`, including `e2e/privacy.json`, `e2e/expiry.json`, `e2e/deletion.json`, `e2e/email-sink.json`, and `logs/`.

### Production email evidence

On 2026-10-25, the user signed in through Google with their own verified Gmail account and enabled email opt-in. The first save returned `400 invalid_input`. Strict validation of nested payloads and server-rendered initialization of verified emails were fixed in commit `25d97e7`. Production deployment `dpl_2V3sLWiFViGxweJKJ7zKHX6Kqf66` is READY and includes those fixes. Production checks returned 200 when saving opt-in and `true` on a fresh GET. The checkbox remained checked after reload, which the user confirmed.

For a separate test, an opted-out synthetic account was used as an invitee. Its admission request returned 200 pending, with zero sends to that account in the synthetic test. The request queued an admission notice to the real opted-in account. The user found the email in Gmail Spam, followed its app return link to the correct outing, and admitted the original demo guest. The new synthetic guest remains pending. Delivery and link behavior are verified for this one recipient; primary-inbox placement and broader deliverability are not. The message contains a generic event notice and app return link, with no planning details.

The app deletes its own outing and email records seven days after `ended_at`; this does not control provider copies. As of this check, Resend's [security page](https://resend.com/security) says email and log data is retained for 30 days on Free, Pro, and Scale plans. Vendor-side physical erasure is not claimed. Public Google DNS checks at 17:10 UTC found the DKIM TXT record at `resend._domainkey.notify.satyalyadav.com` and returned NXDOMAIN for both `_dmarc.notify.satyalyadav.com` and `_dmarc.satyalyadav.com`. Missing DMARC is a possible deliverability gap, not a proven cause of the Spam placement. No DNS changes were made.

### Conversation transport verification

Commit `9b3977f6947164b0f44bee9ec12797e2339366c1` is in production deployment `dpl_CkAeKZC345tiqwdWR8J9hP79P3Fh` (`READY`). A live Chrome test with a synthetic owner verified: `$15` saved; an ambiguous increase asked for an amount and retained `$15`; `20 bucks.` prompted the server's exact-consent question while retaining `$15`; `Yes.` saved `$20`; `Thanks.` left `$20` unchanged; and `lower my hard spending cap to $12` saved `$12`. After reload, GET retained `1200` with `ready=true`. The UI showed `Ask agent for an offer` and no `Ask DeepSeek` or structured conditions editor. Typed tool calls through the real Go model succeeded.

The full server suite passed 65 tests across 8 files before the final transport change. After that change, the provider suite passed 14 tests, typecheck and diff check passed, and the remote production build reached READY. The 65-test result was not rerun on the final transport. The two-account privacy rerun and full walkthrough were also not repeated after transport; those earlier checks remain historical, and the user will run the walkthrough for the demo.

### Scheduled maintenance

The authenticated endpoint `POST /api/maintenance/sweep` ran in production and returned aggregate counts. `GET /api/maintenance/health` reported a fresh successful run with no outing identifiers. The five-minute workflow is active on `main`; repository secrets `SCHEDULER_URL` and `SCHEDULER_SECRET` are set. Manual run 40170521273 completed successfully and returned `{"ok":true,"cutoffsProcessed":0,"proposalsExpired":0,"outingsDeleted":0}`. GitHub scheduled events are best effort; request-time deadline checks remain authoritative.

## Remaining external work and limits

1. Keep the GitHub Actions schedule enabled and monitor its health; scheduled events are best effort.
2. Broader email deliverability remains unverified. One opted-in recipient received the admission notice in Spam; see [production email evidence](#production-email-evidence) for observed DNS records.
3. The Clerk instance is development-only. A production launch needs a Clerk production instance and a review of session-cookie behavior, domain settings, and user limits.
4. The free-use term for the current DeepSeek Go route ends 2026-10-31. Recheck terms before a later demo. Never enable Extra Usage or switch providers without an explicit user decision.
5. The app uses the free Vercel/Neon/Clerk/Resend tiers. Current quotas are sufficient for this demo but are not a capacity guarantee.
6. Booking, payments, trips, live showtime discovery, native messaging, reminders, and past-plan archives remain out of scope.
