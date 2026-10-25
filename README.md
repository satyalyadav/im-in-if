# I'm in if...

Personal agents help existing student friends turn interest into a social plan. This project is a private movie-night planning app for Cubbie Hackathon Track 2. See the [product brief](docs/product-brief.md), [build plan](docs/build-plan.md), [verification record](docs/verification/0001-private-agent-slice.md), and [glossary](GLOSSARY.md).

## Current stage

The app has local sign-in, private participant chats and conditions, invitation admission, a labeled sample catalog, model-generated offers, proposal revisions, explicit confirmations, and request-time plus scheduled cleanup. Development uses PGlite and a development-only cookie. Production uses Clerk and Neon and fails closed when those bindings are missing.

The only active model route is OpenCode Go `deepseek-v4.1-flash`. It has no model or provider fallback. The successful response must report OpenCode Go/Go Plus billing and numeric zero cost; this check runs after the provider response and cannot prevent a charge. Keep the account's Extra Usage setting off before any request. OpenCode Go is intended for coding-agent traffic and does not guarantee support for a planning app. Recheck the model's current free-use terms before later demos.

Vercel, Clerk, and Neon project bindings exist. The app is deployed at <https://im-in-if.vercel.app>. Neon app-accessible restore history is set to zero and no snapshots exist; the verification record describes the evidence and its limits. The authenticated maintenance sweep runs in production. A scheduled GitHub Actions workflow is in source but still needs repository secrets and activation on the default branch. Resend sender verification is complete and a test-sink send succeeded; a real recipient must still opt in before any human delivery.

## Run locally

Requirements: Node 24 or newer and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Keep `AUTH_MODE=local` for development. Choose a local user name at <http://localhost:3000>. PGlite stores development data in the gitignored `.data/pglite` directory. Configure `OPENCODE_GO_API_KEY` only when the account is ready for a synthetic test; keep Extra Usage disabled. Never use real outing details for provider tests.

For a managed database, set `DATABASE_URL`. Production requires `DATABASE_URL` and Clerk keys, and must omit `AUTH_MODE=local`. Only verified email addresses on the signed-in Clerk account can be used for opt-in notices.

## Email and maintenance

Email is limited to opted-in admission and final-approval notices. The message contains a short return link and no planning details. Set `RESEND_API_KEY`, `RESEND_FROM`, and an HTTPS `APP_BASE_URL` only after a verified sender is available. Local mode suppresses sending. App-held recipient, link, and outbox records cascade with outing data at the seven-day deadline; the policy does not claim email-provider copies are erased.

Run a secured sweep with `npm run sweep` and inspect its status with `npm run maintenance:health`. Both use `SCHEDULER_URL` and `SCHEDULER_SECRET`. Deployed scheduling is provided by `.github/workflows/outing-sweep.yml`: it runs every five minutes when active on the default branch, and can be started manually from GitHub Actions. Configure repository secrets named `SCHEDULER_URL` and `SCHEDULER_SECRET`. The schedule is best effort; exact expiry is also checked on app requests.

## Checks

```bash
npm test
npm run typecheck
AUTH_MODE=local npm run build
```

See [verification](docs/verification/0001-private-agent-slice.md) for current results, deployment checks, and remaining work.
