# Issue #1 verification: private ASU agent slice

Checked 2026-10-24. Scope: GitHub issue #1, "Start an outing with a private ASU agent".

This record separates what was verified locally from what remains unverified. It does not
claim that deployment or the seven-day deletion policy is implemented.

## Status

| Area | Status |
| --- | --- |
| ASU app API access from non-agent code | Verified with an existing key |
| ASU model compatibility with the AI SDK request path | Verified for `qwen38-27b` |
| Free-tier cost and quota fit | Checked; no paid usage required for this slice; no services provisioned |
| Local browser-to-agent-to-storage flow | Verified against the real ASU gateway |
| Clerk sign-in in production | Not verified; no Clerk application exists |
| Neon Postgres in production | Not verified; no Neon project exists |
| Vercel deployment | Not verified; no project exists |
| Seven-day deletion job | Not implemented or verified |
| Private content kept out of requests to other outings, logs, and workflow records | Verified locally for this slice; no workflows are used |

## ASU access and model compatibility

The existing ASU key was read from the shell environment at run time. It was never written to
the repository, `.env.local`, fixtures, or logs. `.env.example` contains placeholders only.

Evidence:

- `GET https://openai.rc.asu.edu/v1/models` with the bearer key returned 52 models. The chat
  models included `qwen38-27b` (262,144-token context, tools), `glm-5-3-flash`
  (262,144-token context, tools), and `glm-5-2`.
- `POST /v1/chat/completions` with `qwen38-27b` and `glm-5-3-flash` each returned the content
  `ready` for a one-word prompt.
- The app's exact request path (`ai@7.0.153` with `@ai-sdk/openai-compatible@3.0.78`,
  `generateText`, system message plus chat history, `maxRetries: 0`) returned `ready` from
  `qwen38-27b` in 1.3 s, with 24 prompt and 38 completion tokens.
- `qwen38-27b` does not advertise response-schema support. This slice only needs plain chat
  completions and text, so that limitation does not block it. Tool calls are not used.
- ASU documents a fair queue of up to 5 minutes before a `503`, a 60-minute total request
  limit, and per-minute `429` token budgets. The app uses a 60-second default timeout
  (`ASU_REQUEST_TIMEOUT_MS`) and no automatic model retries. A failed turn is saved and can
  be retried by the starter.
- ASU's gateway keeps request metadata (time, key, model, tokens, status, timing) for 180
  days. It does not record prompt or reply text. ASU runs models on its own hardware and does
  not send prompts to commercial providers for this endpoint.

The key works for script and application requests, not only the coding agent. It remains a
personal key: production must store a dedicated key in Vercel environment variables and
never send it to the browser.

## Free-tier checks

No service was provisioned. The table records what the provider pages state as of
2026-10-24.

| Service | $0 plan | Card or payment requirement | Relevant limits |
| --- | --- | --- | --- |
| ASU Research Computing API | No charge for application or script requests | None | Fair queue up to 5 min; 60-minute request cap; per-minute token budget |
| Vercel Hobby | $0/month | Not stated on the pricing page; not confirmed | 1M function invocations, 4 active CPU-hours, 1 hour of runtime logs, 50k workflow events and 1 GB workflow writes per month |
| Neon Free | $0/month, permanent | No credit card required (stated) | 100 CU-hours, 1 GB Postgres/project, 6-hour history capped at 1 GB, 1 manual snapshot, no scheduled snapshots |
| Clerk Hobby | $0/month | No credit card required (stated) | 50,000 MRUs/app, 1-day application log retention, 7-day fixed session lifetime |
| Resend Free | $0/month | Cards accepted for paid plans; free-plan requirement not stated | 3,000 emails/month, 100/day, 3 domains, 30-day data retention |

The implemented slice needs only the app runtime, Postgres, auth, and outbound model calls.
It fits the free allowances at demo scale. Vercel and Resend payment-method requirements
remain unconfirmed because no account or project was opened.

## Seven-day deletion feasibility

The approved policy deletes app-held outing data seven days after the outing or failed
attempt ends. The checks below cover restore history, snapshots, workflow state, and logs.

- **Neon restore history.** Free keeps a 6-hour point-in-time window, capped at 1 GB of
  changes. Rows deleted at the seven-day mark can remain in that window until roughly
  seven days and six hours. A strict seven-day deadline therefore needs the purge to run at
  or before day 6.5, or the claim must exclude the restore window. No purge job exists yet.
- **Neon snapshots.** Free includes one manual snapshot and no scheduled snapshots. The
  deployment must create none. Snapshot existence has not been checked because no project
  exists.
- **Vercel Workflows.** On Hobby, run payloads are readable for one day and may be kept for
  up to 66 days; run metadata may be kept for up to one year. Even `experimental_retention:
  0` keeps payloads for up to 36 days. Private prompts, replies, conditions, and rankings
  must stay out of run payloads. This slice starts no workflows. A later timer or cleanup
  workflow must pass IDs and sanitized offers only.
- **Logs.** Vercel Hobby keeps runtime logs for 1 hour and traces for 1 hour. Clerk Hobby
  keeps application logs for 1 day. Neon Free keeps monitoring data for 1 day. The app logs
  only an error code for a failed agent turn, never message text. The local integration
  check confirmed that private text did not appear in console or server output.
- **Resend.** Free retains email data for 30 days. Notices must contain only a return link,
  never private planning details. Recipient and link records would outlive the seven-day
  app-data deadline, which is an unresolved policy gap for any email notice.
- **ASU.** The gateway's 180-day metadata does not contain prompt or reply text. It is a
  provider-side record, not app-held outing data, and the policy does not claim that vendor
  records are erased.
- **Local development store.** `.data/pglite` is a local, gitignored development database.
  It is not part of a deployment and has no retention job.

Conclusion: the stack can meet the seven-day deadline for app rows, snapshots, and logs with
a purge scheduled before day 6.5, no manual snapshots, and no private data in workflow
payloads. The purge is not implemented, and the restore-history and snapshot checks cannot
be completed until a Neon project exists. The Resend gap remains.

## Local integration evidence

Automated checks (`npx vitest run`, 24 tests in 3 files):

- Cutoff resolution keeps the intended instant in Phoenix, Kolkata, and New York, rejects a
  spring-forward gap, chooses the earlier occurrence of a fall-back wall time, and rejects
  invalid dates, times, and zones.
- Creating an outing without a cutoff is rejected. The stored cutoff is the explicit one the
  starter supplied.
- A second signed-in account gets `404` for the outing page, the outing API, sends, and
  retries. Direct requests with another account's cookie were also checked against the
  running app.
- A turn saves the starter's message and the agent reply, and a reload returns both.
- The agent receives only the current outing's suggestion and history; another outing's
  private text is absent from the request.
- Two concurrent sends with the same client message ID produce one user row, one agent row,
  and one model call.
- A failed model request leaves the user message saved with a `failed` status and no agent
  row. A retry completes the same turn without creating a second user message.
- A failed message stays in the agent's context when the starter later sends a new message.
- A turn that is still pending can be retried; when both the original and retry responses
  arrive, the database keeps one user row and one agent row.
- Console methods captured during a turn contain neither the private prompt nor the reply.
- The real ASU gateway answered in a browser session (22.1 s and 10.2 s for two turns), the
  conversation survived a reload, and an intruder account saw the styled 404 page and no
  message text.
- A browser turn with an invalid model returned `502`, kept the user message, and showed
  "Ask again". After the server was restarted with the real model, that retry produced one
  agent reply and no duplicate user row. Server output contained only
  `agent turn failed model_error`, not the message text.

Reproduce:

```bash
npm install
cp .env.example .env.local   # set ASU_API_KEY; AUTH_MODE=local
npm run dev
npm test
npm run typecheck
AUTH_MODE=local npm run build
```

## Unresolved blockers

1. No Clerk application, Neon project, or Vercel project exists, so production sign-in,
   managed Postgres, deployment, and the actual provider log/restore surfaces are unverified.
2. Clerk mode is compiled but not exercised. The local cookie adapter is development-only and
   throws when `NODE_ENV=production` or `VERCEL` is set.
3. The seven-day purge job is not implemented. Purge timing relative to Neon's six-hour
   restore window, snapshot absence, and restore-history checks are open deployment tasks.
4. Resend notices are not implemented, and Resend's 30-day retention is incompatible with a
   strict seven-day claim unless the claim excludes vendor email records.
5. `qwen38-27b` is active today but can be retired. The app reads `ASU_MODEL` from the
   environment so a replacement does not require a code change.
6. The app uses an embedded PGlite database only in development. A production process
   without `DATABASE_URL` refuses to start the local adapter instead of falling back silently.

## Deployment checklist

1. Create the Neon project, run the app against `DATABASE_URL`, and confirm migrations.
2. Confirm no manual snapshots exist. Schedule the purge before day 6.5 or narrow the
   deletion claim to the live database.
3. Create the Clerk application, set both keys, remove `AUTH_MODE=local`, and verify that
   direct requests from a second account return `404`.
4. Create the Vercel Hobby project, add `DATABASE_URL`, Clerk keys, and a dedicated
   `ASU_API_KEY`; confirm Vercel and Resend do not require a card for the selected flow.
5. Repeat the browser flow against the deployment and inspect Vercel runtime logs for private
   text.
6. Keep private data out of any future Workflow payloads and use zero retention where
   possible.
