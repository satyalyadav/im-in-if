# Proposed build plan

Checked 2026-10-24. Proposal only; no app code or services are configured.

## Recommendation

Proposed stack: Next.js, Vercel AI SDK, Vercel Workflows, Neon Postgres, Clerk, and Resend for opted-in email. None is approved or configured.

Vercel's build-agent guidance defaults to Eve. I compared Eve with app-owned chats and direct AI SDK calls. Eve sessions expire, but expiry does not delete stored session data. Clear removes model history but keeps durable state; reset retires the session without deleting its data. That conflicts with the approved rule to delete private chats stored by the app seven days after an outing or failed attempt ends. Keep chats in app-controlled rows and verify their deletion instead. [Eve session lifecycle](https://github.com/vercel/eve/blob/main/docs/concepts/sessions-runs-and-streaming.md), [Eve session controls](https://github.com/vercel/eve/blob/main/docs/channels/eve.mdx).

The AI SDK can use AI Gateway with Vercel OIDC or an API key. Choose a current model during implementation. Codex access is not app access. [AI SDK provider setup](https://ai-sdk.dev/docs/getting-started/choosing-a-provider).

## Flow and data boundaries

- Store outing membership, admission requests, private chats, conditions, rankings, options, offers, proposal revisions, and approvals in Postgres. Check account and group access on every server request.
- Handle private agent turns in authenticated web requests that store chats in Postgres. Each agent call receives only that person's private inputs and approved shared offers. A coordinator passes between agents only allowlisted offer details. The group page shows those offers, the current proposal, and status, never private chats, raw limits, or personal reasons.
- Agents suggest offers. Server code checks candidate attendee sets and options against hard conditions, availability, spending limits, attendance dependencies, and minimum group size. Agents explain options and use private rankings to negotiate. People choose and approve; agents cannot commit for them.
- Bind each explicit approval to a proposal revision. A material change requires every person in the revised attendee set to approve again. Evaluate mutual attendance dependencies on the same set. A post-confirmation join request proposes a new revision while the confirmed plan remains intact.
- Run agent negotiation, the response cutoff, final-approval expiry using the accepted 30-minute default, and seven-day private-data cleanup as durable Workflows. Whether the approval clock is shared or per request remains open. Workflow sleep supports waits from minutes to days or months, so these timers do not depend on the browser staying open. Pass only outing or revision IDs into workflows; return only safe statuses and sanitized offers. Keep private values out of workflow payloads and logs. Do not use in-process timers or a deployment cron as the source of truth. Vercel Hobby cron runs only once per day with up to 59 minutes of timing variation. [Workflow sleep](https://vercel.com/blog/a-new-programming-model-for-durable-execution), [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- Seven days after an outing or failed attempt ends, delete app-stored private chats, conditions, and rankings. Keep sign-in accounts. This does not promise deletion of other plan data or copies held by model and email providers.
- Use clearly labeled sample movie options and allow manual additions. Do not fetch live listings or claim prices are verified.
- Starter admission requests always generate an in-app notice. Proposed Resend sends admission and final-approval emails only to opted-in recipients, with a short return link and no private details. Student delivery needs a verified sender domain; the default test sender reaches only its owner. Resend supports idempotency keys for retry-safe email sends. [Resend domain verification](https://resend.com/changelog/domain-verification-events), [Resend test sender](https://resend.com/changelog/v0-integration), [Resend email idempotency](https://resend.com/changelog/idempotency-keys).

## Providers and setup

Neon is the proposed Postgres service from the Vercel Marketplace catalog. Clerk is proposed for sign-in and needs a Vercel project and Clerk application. [Marketplace storage catalog](https://vercel.com/marketplace/category/storage), [Clerk Marketplace setup](https://clerk.com/docs/guides/development/integrations/platforms/vercel-marketplace).

## Solo estimate

| Phase | Hours |
| --- | ---: |
| App skeleton, accounts, and services | 1 |
| Sign-in, invitation, and starter admission | 2 |
| Private agent input, editable interpretation, conditions, and catalog | 2 |
| Negotiation, hard-condition checks, dependencies, rankings, and tie follow-up | 3 |
| Sanitized group page, proposal revisions, and approvals | 2 |
| Durable timers and opted-in email notices | 2 |
| Seven-day private-data purge | 1 |
| End-to-end checks, deployment, and buffer | 2 |
| **Total** | **15** |

This estimate assumes accounts, credentials, and a verified sender domain are ready first. Without them, the 12 to 16 hour budget is at risk. Do not substitute fake agents, memory-only timers, or mock email for the real flow.

## Acceptance checks

- With separate signed-in accounts, no participant can read another person's private chat, conditions, or rankings by changing a URL or request. An invitee sees no group details before starter admission.
- Ambiguous conditions receive a private clarification and editable summary before negotiation. Code blocks options that violate strict limits unless the owner explicitly relaxes them. Test mutual attendance dependencies on the same attendee set.
- Agents exchange real model-generated offers and counteroffers. Shared updates contain only approved details. Ties trigger one private A/B/either follow-up; no formula or starter tie-break chooses for the group.
- A material change invalidates earlier approvals. Silence at response cutoff is not a decline. Missing approval after 30 minutes leaves the proposal unconfirmed without automatic roster changes.
- Close the browser and verify cutoff, final-approval expiry, and cleanup still run. Use a test clock or short durations in tests, then verify deployed Workflow timing.
- Retry timers and email jobs. Transitions stay idempotent, stale revisions cannot be confirmed, and a notification is not sent twice.
- Advance a test clock past seven days. Verify app-stored private chats, conditions, and rankings are gone while sign-in accounts remain. Check logs and workflow records for raw private values.

## Setup blockers and open choices

The workspace has Node v26.12.0, npm 11.20.0, and pnpm, but no app manifest, Vercel CLI, or .env files. Checked environment names VERCEL_TOKEN, AI_GATEWAY_API_KEY, DATABASE_URL, CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, and RESEND_API_KEY are absent. Implementation needs a Vercel account and project, selected sign-in and database resources, model access through OIDC or a Gateway key, and a verified email sender domain with a Resend key. Do not share keys in chat.

No Vercel CLI was available for Marketplace discovery, so I used public official catalog pages as a read-only fallback. Nothing was installed or provisioned.

Product questions still open:

1. How participants choose when preferences conflict outside a tie, and what happens if the one-round follow-up leaves a tie.
2. How participants mark conditions strict or flexible, and how pending or late admission, the response-cutoff default, withdrawal, removal, and reentry affect the attendee set.
3. Whether the 30-minute approval window can change or is shared, what happens if an activity starts during approval, how late approval after expiry is handled, and email opt-in/reminder details.
4. Retention for plan, offer, decision, and shared-feed data beyond the private fields covered by the seven-day rule, and agent lifetime beyond an outing.

Framework, database and sign-in providers, model, email service, deployment, and access-control implementation remain build choices proposed here, not settled decisions.
