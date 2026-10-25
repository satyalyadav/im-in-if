# I'm in if...

Personal agents help existing student friends turn a spark of interest into a workable social plan. The first build is a local movie-night outing for Cubbie Hackathon Track 2, with a build budget of 12 to 16 hours. See the [product brief](docs/product-brief.md), [proposed build plan](docs/build-plan.md), and [glossary](GLOSSARY.md).

## Current stage

The first vertical slice works locally: a signed-in starter begins an outing, supplies an explicit response cutoff, and exchanges saved private messages with an ASU-backed agent. The app uses Next.js, Clerk-ready auth, Postgres storage, and the ASU OpenAI-compatible gateway through the Vercel AI SDK.

Deployment, managed-service provisioning, and the seven-day purge are not complete. See the [verification record](docs/verification/0001-private-agent-slice.md) for evidence and open blockers.

## Run locally

Requirements: Node 24 or newer, npm, and an ASU Research Computing API key.

```bash
npm install
cp .env.example .env.local
```

Set `ASU_API_KEY` in `.env.local`. Keep `AUTH_MODE=local` for development; it uses an
httpOnly cookie instead of Clerk and is rejected in production. Then:

```bash
npm run dev
```

Open <http://localhost:3000>, choose a local user name, and start an outing. The embedded
PGlite database lives in `.data/pglite` and is gitignored. Set `DATABASE_URL` to use Neon
instead.

Checks:

```bash
npm test
npm run typecheck
AUTH_MODE=local npm run build
```

For deployment, set `DATABASE_URL`, `CLERK_SECRET_KEY`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `ASU_API_KEY`, `ASU_BASE_URL`, and `ASU_MODEL`, and omit
`AUTH_MODE`.
