# Proposed build plan

Checked 2026-10-24. Proposal only; no app code or services are configured. Cost cap: $0. Use free tiers; buy no credits or domain. Stop if paid usage is required.

## Candidate stack and cost check

Candidate stack: Next.js, Vercel AI SDK and Workflows, Neon Postgres, Clerk, and Resend. First AI candidate: the existing ASU Research Computing API, documented as free and OpenAI-compatible for applications. The configured endpoint matches; AI SDK supports custom compatible endpoints. Verify model capability and app credentials. Do not use OpenCode Go unless official terms allow planning traffic. No provider is approved or configured. [ASU API](https://docs.rc.asu.edu/ai/api/), [AI SDK provider](https://ai-sdk.dev/providers/openai-compatible-providers), [OpenCode Go](https://opencode.ai/v2/docs/console/go/).

| Service | Pricing and project limits |
| --- | --- |
| Vercel Hobby and Workflows | Hobby is $0/month. Workflows include 50,000 events and 1 GB written monthly. Workflow Data Retained is unavailable on Hobby. Finished payloads are readable for one day and may remain up to 66 days; metadata may remain up to one year. Sleeping and waiting runs keep all state without a time limit. Keep private data out of runs and metadata. [Vercel pricing](https://vercel.com/pricing), [Workflow pricing](https://vercel.com/docs/workflows/pricing), [Workflow retention](https://vercel.com/docs/workflows/retention). |
| ASU Research Computing API | ASU says application and script requests have no charge. Gateway logs retain request metadata for 180 days, not prompt/reply text. Requests can wait in a fair queue for up to 60 minutes or hit per-minute token limits. Tool-call and response-schema support varies by model; check the chosen model. [ASU API and data](https://docs.rc.asu.edu/ai/api/), [model capabilities](https://docs.rc.asu.edu/ai/api/chat/). |
| OpenCode Go | Not in the $0 proposal. Go is $10/month and requires billing details. OpenCode describes it for coding agents sending typical coding traffic. Do not route this app through it unless official terms allow that use. [OpenCode Go pricing and use](https://opencode.ai/v2/docs/console/go/). |
| Neon Free | $0, no credit card, 100 CU-hours and 1 GB storage per project. The free plan lists restore history up to six hours or 1 GB of data changes, plus one snapshot. Verify purge behavior for history and snapshots before claiming seven-day deletion. Do not create snapshots. [Neon pricing](https://neon.com/pricing). |
| Clerk Hobby | $0, no credit card, 50,000 MRUs per app. Application logs have one-day retention; keep private planning data out of auth logs. [Clerk pricing](https://clerk.com/pricing). |
| Resend Free | $0, 3,000 emails/month, 100/day, and three domains. Email data remains for 30 days. Send only opted-in notices with a return link, not private planning details. The approved subdomain approach needs DNS access and sender verification, neither confirmed. [Resend pricing](https://resend.com/pricing). |

Stay on free plans, enable no paid options, and stop when a quota blocks the demo. Resend overage is only for paid plans. Vercel and Resend signup payment requirements are unclear, so check before setup. Use the approved existing-domain subdomain; buy no domain, OpenCode Go subscription, or AI Gateway credits.

## Proposed flow and data boundaries

- Store outing membership, admission requests, private chats, conditions, rankings, options, offers, proposal revisions, and approvals in Postgres. Check account and group access on every server request.
- Handle private agent turns in authenticated web requests. Each call gets its owner's inputs and approved offers. Store private chats and outputs in the app database. ASU says its gateway does not retain prompt/reply text; keep private values out of app logs. Do not claim provider-side deletion beyond published policy.
- Agents suggest offers. Server code checks attendee sets against hard conditions, availability, spending limits, attendance dependencies, and minimum group size. Agents explain options using private rankings. People choose and approve; agents cannot commit for them.
- Tie each approval to the plan it covers. A material change requires each person in the revised attendee group to approve again. Evaluate mutual attendance dependencies on one attendee set. A post-confirmation join request proposes a new plan while the confirmed plan stays intact.
- Use durable Workflows for negotiation, the response cutoff, final-approval expiry, and seven-day cleanup. Sleep supports waits of days with the browser closed. Active runs, including sleeping or waiting runs, retain all state without a time limit. Pass only outing or plan IDs and sanitized offers. Keep private chats, raw conditions, rankings, personal reasons, and private model inputs or outputs out of run arguments, step inputs/returns, attributes, and logs. Verify this boundary in run records. [Workflow sleep](https://vercel.com/blog/a-new-programming-model-for-durable-execution), [Workflow retention](https://vercel.com/docs/workflows/retention).
- Seven days after an outing or failed attempt ends, delete active app records for private chats, conditions, and rankings. Keep sign-in accounts. Check Neon history/snapshots, Workflow records, provider records, traces, and logs before claiming the policy is met. Do not weaken the policy. Resend may retain recipient and return-link data for 30 days; email contains no private planning details.
- Use labeled sample movie options and manual additions. Do not fetch live listings or claim sample prices are verified. Starter admission creates an in-app notice. Proposed Resend emails admission and final-approval notices only to opted-in recipients. Student delivery needs a verified sender; its test sender reaches only its owner. [Resend sender setup](https://resend.com/changelog/v0-integration).

## Setup status

Node, npm, and pnpm are available. There is no app manifest, local Vercel CLI, or `.env` file. Vercel connector access to an existing team is confirmed, but no app project exists; the team-plan check is separate. DNS access and sender verification are unknown. No services or DNS records changed.

The user reports existing ASU API access. Safe OpenCode provider metadata matches ASU's documented endpoint and declares model IDs. Auth files and key values were not inspected; app access is unverified. ASU's OpenCode setup reads `ASU_AIR_API_KEY` by default. Implementation needs a Vercel project, auth and database resources, and a verified Resend sender. Neon and Clerk offer no-card free plans; Vercel and Resend requirements are unclear. Do not share keys in chat. Codex access is not app API access. No services are provisioned.

## Solo estimate

| Phase | Hours |
| --- | ---: |
| App, sign-in, invitation, and admission | 3 |
| Private agent input, editable interpretation, conditions, and sample catalog | 2 |
| Negotiation, hard-condition checks, dependencies, rankings, and tie follow-up | 3 |
| Sanitized group page, proposal revisions, and approvals | 2 |
| Durable timers and opted-in email | 2 |
| Seven-day private-data purge | 1 |
| End-to-end checks, deployment, and buffer | 2 |
| **Total** | **15** |

The 15-hour estimate assumes accounts, credentials, free tiers, and a verified sender subdomain are ready first. Otherwise, the 12 to 16 hour budget is at risk.

## Acceptance checks

- Separate signed-in participants cannot read another person's chats, conditions, or rankings by changing a URL or request. Invitees see no group details before starter admission.
- Ambiguous conditions get private clarification and an editable summary. Code blocks options that violate strict limits unless the owner relaxes one. Test mutual attendance dependencies on one attendee set.
- Agents exchange model-generated offers and counteroffers. Shared updates show only approved details. Ties trigger one private A/B/either follow-up; no automatic group-size ranking or starter tie-break chooses for everyone.
- Material changes require renewed approval. Silence at response cutoff is not a decline. Missing approval after 30 minutes leaves the proposal unconfirmed, with no automatic roster change.
- Close the browser and verify deadlines and cleanup still run. Test duplicate timers/emails, stale approvals, and simultaneous approvals.
- Advance a test clock past seven days. Verify private rows are gone and accounts remain. Inspect database history/snapshots, Workflow records, and logs for private values before claiming deletion.

## Open questions

Product questions remain about preference conflicts, admission and response-cutoff timing, withdrawal and reentry, activity starting during approval, late approval, email opt-in and reminders, retention of other plan data, and agent lifetime beyond an outing. Provider choices remain conditional on account access, free-tier limits, the privacy policy, and model compatibility.
