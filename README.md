# I'm in if...

Ever had issues creating plans for going out with friends? Personal agents can help you turn interest from friends into a social plan.

**[Open the live app](https://im-in-if.vercel.app)**

Cubbie Hackathon Track 2 project.

The intended flow gives each person a private chat with their own agent. Their agents work with friends' agents to find a workable plan. Everyone must explicitly approve the proposed activity, time, estimated cost, and attendee list before it is final. Agents can draft tentative options from the outing idea and private chats. Costs are estimates; the app does not check live listings or make bookings.

Start an outing by writing what you have in mind. You do not need to know the activity time or set a response cutoff.

The starter can invite a friend by email. The recipient signs in with the invited verified email address and chooses Join planning group. Joining does not record interest or attendance.

Read the [build plan](docs/build-plan.md) for setup and model-provider details. Check its included-usage limits and required Extra Usage setting before enabling agent calls. The [verification record](docs/verification/0001-private-agent-slice.md) describes checked behavior and data retention.

## Run locally

Requires Node.js 24 or newer and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `AUTH_MODE=local` in `.env.local` before starting the app.

## Checks

```bash
npm test
npm run typecheck
AUTH_MODE=local npm run build
```
