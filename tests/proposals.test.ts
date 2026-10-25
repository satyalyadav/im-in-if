import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb, migrate, type Db, type DbStatement } from "@/lib/db";
import { createOuting } from "@/lib/outings-api";
import { emptyConditionInterpretation } from "@/lib/planning-types";
import { handlePlanningAction, requestAdmission } from "@/lib/planning-api";

const A = "proposal-starter";
const B = "proposal-attendee";
const C = "proposal-joiner";
let pg: PGlite;
let db: Db;

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("RESEND_FROM", "");
  pg = new PGlite();
  db = createPgliteDb(pg);
  await migrate(db);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

function ctx(userId: string, verifiedEmails: string[] = []) {
  return { db, userId, verifiedEmails };
}

async function setupPlan(includeC = false) {
  const created = await createOuting(ctx(A), {
    suggestion: "Synthetic approval test",
    cutoffDate: "2026-10-31",
    cutoffTime: "19:30",
    cutoffTimeZone: "America/Phoenix",
  });
  const outing = created.body.outing as { id: string; inviteToken: string };
  await requestAdmission(ctx(B, ["attendee@example.test"]), outing.inviteToken, {
    displayName: "Attendee",
    emailOptIn: true,
    email: "attendee@example.test",
  });
  await handlePlanningAction(ctx(A), outing.id, {
    action: "decide_admission", userId: B, decision: "admit",
  });
  if (includeC) {
    await requestAdmission(ctx(C, ["joiner@example.test"]), outing.inviteToken, {
      displayName: "Joiner",
      emailOptIn: false,
      email: null,
    });
    await handlePlanningAction(ctx(A), outing.id, {
      action: "decide_admission", userId: C, decision: "admit",
    });
  }
  const members = includeC ? [A, B, C] : [A, B];
  for (const userId of members) {
    const interpretation = emptyConditionInterpretation();
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb,
              interpretation_ready = true where outing_id = $1 and user_id = $2`,
      [outing.id, userId, JSON.stringify(interpretation)],
    );
    await db.query(
      `update participants set response_status = 'interested', responded_at = now()
        where outing_id = $1 and user_id = $2`,
      [outing.id, userId],
    );
  }
  await db.query(`update outings set cutoff_processed_at = now() where id = $1`, [outing.id]);
  const optionRows = await db.query<{
    id: string;
    activity: string;
    starts_at: string | Date;
    estimated_cost_cents: number;
    activity_tags: unknown;
  }>(
    `select id, activity, starts_at, estimated_cost_cents, activity_tags
       from outing_options where outing_id = $1 order by starts_at limit 1`, [outing.id],
  );
  const option = optionRows[0];
  const offerId = crypto.randomUUID();
  await db.query(
    `insert into offers
      (id, outing_id, owner_user_id, option_id, activity, starts_at, estimated_cost_cents,
       attendee_user_ids, activity_tags, private_note, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, '', 'draft')`,
    [offerId, outing.id, A, option.id, option.activity, option.starts_at,
      option.estimated_cost_cents, JSON.stringify([A, B]), JSON.stringify(option.activity_tags)],
  );
  expect((await handlePlanningAction(ctx(A), outing.id, { action: "publish_offer", offerId })).status).toBe(200);
  return { outingId: outing.id, offerId, option, members: [A, B] };
}

async function publishProposal(outingId: string, offerId: string) {
  const result = await handlePlanningAction(ctx(A), outingId, { action: "publish_proposal", offerId });
  expect(result.status).toBe(201);
  expect(result.body.proposal).toMatchObject({ startsAt: expect.any(String) });
  expect(Array.isArray((result.body.proposal as { attendeeUserIds?: unknown }).attendeeUserIds)).toBe(true);
  return result.body.proposal as { id: string; revision: number; expiresAt: string };
}

describe("versioned proposal approvals", () => {
  it("confirms once under simultaneous approvals and notifies only the proposed attendees", async () => {
    const plan = await setupPlan();
    const proposal = await publishProposal(plan.outingId, plan.offerId);
    const noAgreement = await handlePlanningAction(ctx(B), plan.outingId, { action: "declare_no_agreement" });
    expect(noAgreement).toMatchObject({ status: 409, body: { error: "agreement_still_open" } });
    const stillOpen = await db.query<{ status: string }>(`select status from proposals where id = $1`, [proposal.id]);
    expect(stillOpen[0].status).toBe("published");
    const [approveA, approveB] = await Promise.all([
      handlePlanningAction(ctx(A), plan.outingId, {
        action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
      }),
      handlePlanningAction(ctx(B), plan.outingId, {
        action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
      }),
    ]);
    expect([approveA.status, approveB.status].some((status) => status === 200)).toBe(true);

    const statuses = await db.query<{ status: string; confirmed_at: string | Date | null }>(
      `select status, confirmed_at from proposals where id = $1`, [proposal.id],
    );
    expect(statuses).toEqual([{ status: "confirmed", confirmed_at: expect.anything() }]);
    const notices = await db.query<{ recipient_user_id: string; kind: string }>(
      `select recipient_user_id, kind from in_app_notifications
        where outing_id = $1 and kind = 'proposal_confirmed'`, [plan.outingId],
    );
    expect(notices.map((row) => row.recipient_user_id).sort()).toEqual([...plan.members].sort());
    const outing = await db.query<{ status: string; ended_at: string | Date | null }>(
      `select status, ended_at from outings where id = $1`, [plan.outingId],
    );
    expect(outing[0]).toMatchObject({ status: "confirmed", ended_at: null });
    const mail = await db.query<{ status: string; recipient_email: string | null }>(
      `select status, recipient_email from email_outbox
        where outing_id = $1 and event_type = 'final_approval'`, [plan.outingId],
    );
    expect(mail).toEqual([{ status: "suppressed", recipient_email: "attendee@example.test" }]);
  });

  it("expires on the exact deadline, preserves the roster on explicit restart, and rejects stale revisions", async () => {
    const plan = await setupPlan(true);
    const proposal = await publishProposal(plan.outingId, plan.offerId);
    await db.query(`update proposals set expires_at = now() - interval '1 millisecond' where id = $1`, [proposal.id]);

    const staleApproval = await handlePlanningAction(ctx(A), plan.outingId, {
      action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
    });
    expect(staleApproval.status).toBe(409);
    expect(staleApproval.body.error).toBe("proposal_expired");

    const restarted = await handlePlanningAction(ctx(B), plan.outingId, {
      action: "restart_proposal", proposalId: proposal.id,
    });
    expect(restarted.status).toBe(201);
    const next = restarted.body.proposal as { id: string; revision: number; attendeeUserIds: string[] };
    expect(next.id).not.toBe(proposal.id);
    expect(next.revision).toBe(2);

    const rows = await db.query<{ status: string; attendee_user_ids: unknown; expires_at: string | Date; published_at: string | Date }>(
      `select status, attendee_user_ids, expires_at, published_at from proposals
        where outing_id = $1 order by revision`, [plan.outingId],
    );
    expect(rows[0].status).toBe("expired");
    expect(rows[1].status).toBe("published");
    expect(rows[1].attendee_user_ids).toEqual(plan.members);
    const remaining = new Date(rows[1].expires_at).getTime() - new Date(rows[1].published_at).getTime();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30 * 60 * 1000);

    const late = await handlePlanningAction(ctx(A), plan.outingId, {
      action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
    });
    expect(late.status).toBe(409);
    const approvalCount = await db.query<{ count: number }>(
      `select count(*)::int as count from proposal_approvals where proposal_id = $1`, [next.id],
    );
    expect(approvalCount[0].count).toBe(0);

    const nonAttendeeNoAgreement = await handlePlanningAction(ctx(C), plan.outingId, {
      action: "declare_no_agreement",
    });
    expect(nonAttendeeNoAgreement).toMatchObject({ status: 409, body: { error: "agreement_still_open" } });

    await Promise.all([
      handlePlanningAction(ctx(A), plan.outingId, {
        action: "approve_proposal", proposalId: next.id, revision: next.revision,
      }),
      handlePlanningAction(ctx(B), plan.outingId, {
        action: "approve_proposal", proposalId: next.id, revision: next.revision,
      }),
    ]);
    const staleRestart = await handlePlanningAction(ctx(A), plan.outingId, {
      action: "restart_proposal", proposalId: proposal.id,
    });
    expect(staleRestart).toMatchObject({ status: 409, body: { error: "plan_already_confirmed" } });
    const current = await db.query<{ status: string; attendee_user_ids: unknown }>(
      `select status, attendee_user_ids from proposals where id = $1`, [next.id],
    );
    expect(current[0]).toMatchObject({ status: "confirmed", attendee_user_ids: plan.members });
  });

  it.each(["request_join", "request_departure"] as const)(
    "rejects a %s based on a confirmed roster that changed before the write transaction",
    async (action) => {
      const plan = await setupPlan(true);
      const proposal = await publishProposal(plan.outingId, plan.offerId);
      await Promise.all([
        handlePlanningAction(ctx(A), plan.outingId, {
          action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
        }),
        handlePlanningAction(ctx(B), plan.outingId, {
          action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
        }),
      ]);

      let injected = false;
      const racingDb: Db = {
        query<T>(text: string, params?: unknown[]) {
          return db.query<T>(text, params);
        },
        async transaction<T>(statements: DbStatement[]): Promise<T[][]> {
          if (!injected) {
            injected = true;
            const current = await db.query<{
              id: string;
              outing_id: string;
              revision: number;
              created_by_user_id: string;
              option_id: string;
              activity: string;
              starts_at: string | Date;
              estimated_cost_cents: number;
              status: string;
              kind: string;
              published_at: string | Date;
              expires_at: string | Date;
            }>(
              `select * from proposals where outing_id = $1 and status = 'confirmed' order by revision desc limit 1`,
              [plan.outingId],
            );
            const previous = current[0];
            const newId = crypto.randomUUID();
            await db.query(`update proposals set status = 'superseded' where id = $1`, [previous.id]);
            await db.query(
              `insert into proposals
                (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
                 estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at, confirmed_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'confirmed', $10,
                       $11, $12, now())`,
              [newId, previous.outing_id, previous.revision + 1, previous.created_by_user_id,
                previous.option_id, previous.activity, previous.starts_at,
                previous.estimated_cost_cents, JSON.stringify([A, B, C]), previous.kind,
                previous.published_at, previous.expires_at],
            );
          }
          return db.transaction<T>(statements);
        },
      };

      const actor = action === "request_join" ? C : B;
      const result = await handlePlanningAction({ ...ctx(actor), db: racingDb }, plan.outingId, { action });
      expect(result).toMatchObject({ status: 409, body: { error: "plan_changed" } });

      const current = await db.query<{ status: string; attendee_user_ids: unknown }>(
        `select status, attendee_user_ids from proposals where outing_id = $1 order by revision desc`,
        [plan.outingId],
      );
      expect(current).toHaveLength(2);
      expect(current[0]).toMatchObject({ status: "confirmed", attendee_user_ids: [A, B, C] });
      expect(current[1]).toMatchObject({ status: "superseded" });

      const requests = await db.query<{ status: string }>(
        action === "request_join"
          ? `select status from join_requests where outing_id = $1 and user_id = $2`
          : `select status from departure_requests where outing_id = $1 and user_id = $2`,
        [plan.outingId, actor],
      );
      expect(requests[0]?.status).toBe("expired");
    },
  );

  it("expires a superseded join request and confirms a feasible departure revision", async () => {
    const plan = await setupPlan(true);
    const initial = await publishProposal(plan.outingId, plan.offerId);
    await Promise.all([A, B].map((userId) => handlePlanningAction(ctx(userId), plan.outingId, {
      action: "approve_proposal", proposalId: initial.id, revision: initial.revision,
    })));

    const invitation = await db.query<{ invite_token: string }>(
      `select invite_token from outings where id = $1`, [plan.outingId],
    );
    const D = "proposal-second-joiner";
    await requestAdmission(ctx(D, ["second-joiner@example.test"]), invitation[0].invite_token, {
      displayName: "Second joiner", emailOptIn: false, email: null,
    });
    await handlePlanningAction(ctx(A), plan.outingId, {
      action: "decide_admission", userId: D, decision: "admit",
    });
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [plan.outingId, D, JSON.stringify(emptyConditionInterpretation())],
    );

    const join = await handlePlanningAction(ctx(D), plan.outingId, { action: "request_join" });
    expect(join.status).toBe(201);
    const joinProposal = join.body.proposal as { id: string; revision: number };
    const joinRequest = await db.query<{ id: string; status: string }>(
      `select id, status from join_requests where outing_id = $1 and user_id = $2`,
      [plan.outingId, D],
    );
    expect(joinRequest[0].status).toBe("proposed");

    const departure = await handlePlanningAction(ctx(B), plan.outingId, { action: "request_departure" });
    expect(departure.status).toBe(201);
    const departureProposal = departure.body.proposal as { id: string; revision: number };
    expect(departureProposal.id).not.toBe(joinProposal.id);
    const superseded = await db.query<{ status: string }>(
      `select status from proposals where id = $1`, [joinProposal.id],
    );
    const expiredJoin = await db.query<{ status: string }>(
      `select status from join_requests where id = $1`, [joinRequest[0].id],
    );
    expect(superseded[0].status).toBe("superseded");
    expect(expiredJoin[0].status).toBe("expired");

    const approved = await handlePlanningAction(ctx(A), plan.outingId, {
      action: "approve_proposal", proposalId: departureProposal.id, revision: departureProposal.revision,
    });
    expect(approved).toMatchObject({ status: 200, body: { status: "confirmed" } });
    const current = await db.query<{ status: string; attendee_user_ids: unknown }>(
      `select status, attendee_user_ids from proposals where id = $1`, [departureProposal.id],
    );
    expect(current[0]).toMatchObject({ status: "confirmed", attendee_user_ids: [A] });
    const acceptedDeparture = await db.query<{ status: string }>(
      `select status from departure_requests where outing_id = $1 and user_id = $2`,
      [plan.outingId, B],
    );
    expect(acceptedDeparture[0].status).toBe("accepted");
  });

  it("rejects departure after activity start without leaving a request", async () => {
    const plan = await setupPlan();
    const proposal = await publishProposal(plan.outingId, plan.offerId);
    await Promise.all([A, B].map((userId) => handlePlanningAction(ctx(userId), plan.outingId, {
      action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
    })));
    await db.query(`update proposals set starts_at = now() - interval '1 second' where id = $1`, [proposal.id]);

    const result = await handlePlanningAction(ctx(B), plan.outingId, { action: "request_departure" });
    expect(result).toMatchObject({ status: 409, body: { error: "activity_already_started" } });
    const requests = await db.query<{ count: number }>(
      `select count(*)::int as count from departure_requests where outing_id = $1`, [plan.outingId],
    );
    expect(requests[0].count).toBe(0);
  });

  it("expires an open join request when the starter ends the outing", async () => {
    const plan = await setupPlan(true);
    const proposal = await publishProposal(plan.outingId, plan.offerId);
    await Promise.all([A, B].map((userId) => handlePlanningAction(ctx(userId), plan.outingId, {
      action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
    })));

    const invitation = await db.query<{ invite_token: string }>(
      `select invite_token from outings where id = $1`, [plan.outingId],
    );
    const D = "proposal-ending-joiner";
    await requestAdmission(ctx(D, ["ending@example.test"]), invitation[0].invite_token, {
      displayName: "Ending joiner", emailOptIn: false, email: null,
    });
    await handlePlanningAction(ctx(A), plan.outingId, {
      action: "decide_admission", userId: D, decision: "admit",
    });
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb, interpretation_ready = true
        where outing_id = $1 and user_id = $2`,
      [plan.outingId, D, JSON.stringify(emptyConditionInterpretation())],
    );
    const join = await handlePlanningAction(ctx(D), plan.outingId, { action: "request_join" });
    expect(join.status).toBe(201);

    const ended = await handlePlanningAction(ctx(A), plan.outingId, { action: "end_outing" });
    expect(ended.status).toBe(200);
    const requests = await db.query<{ status: string }>(
      `select status from join_requests where outing_id = $1 and user_id = $2`,
      [plan.outingId, D],
    );
    expect(requests[0]).toMatchObject({ status: "expired" });
  });
});

describe("review regressions", () => {
  it("rejects confirmation when a listed participant's conditions changed after publication", async () => {
    const plan = await setupPlan();
    const proposal = await publishProposal(plan.outingId, plan.offerId);
    await db.query(
      `update participant_preferences set conditions_version = conditions_version + 1
        where outing_id = $1 and user_id = $2`,
      [plan.outingId, A],
    );

    const approval = await handlePlanningAction(ctx(A), plan.outingId, {
      action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
    });
    expect(approval).toMatchObject({ status: 409, body: { error: "conditions_changed" } });
    const rows = await db.query<{ status: string }>(`select status from proposals where id = $1`, [proposal.id]);
    expect(rows[0].status).toBe("expired");
  });

  it("moves an infeasible departure into renegotiation instead of keeping an invalid confirmation", async () => {
    const plan = await setupPlan();
    const dependent = emptyConditionInterpretation();
    dependent.hard.attendanceDependencies = [B];
    await db.query(
      `update participant_preferences set interpretation = $3::jsonb,
              conditions_version = conditions_version + 1
        where outing_id = $1 and user_id = $2`,
      [plan.outingId, A, JSON.stringify(dependent)],
    );

    const proposal = await publishProposal(plan.outingId, plan.offerId);
    await Promise.all([A, B].map((userId) => handlePlanningAction(ctx(userId), plan.outingId, {
      action: "approve_proposal", proposalId: proposal.id, revision: proposal.revision,
    })));
    const confirmed = await db.query<{ status: string }>(
      `select status from proposals where id = $1`, [proposal.id],
    );
    expect(confirmed[0].status).toBe("confirmed");

    const tieOptions = await db.query<{ id: string }>(
      `select id from outing_options where outing_id = $1 order by starts_at`, [plan.outingId],
    );
    const [tieA, tieB] = [tieOptions[0].id, tieOptions[1].id].sort();
    await db.query(
      `insert into tie_polls
        (id, outing_id, tie_key, option_a_id, option_b_id, participant_user_ids,
         status, outcome, selected_option_id, resolved_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'resolved', 'a', $4, now())`,
      [crypto.randomUUID(), plan.outingId, `${tieA}:${tieB}`, tieOptions[0].id, tieOptions[1].id,
        JSON.stringify([A, B])],
    );

    const result = await handlePlanningAction(ctx(B), plan.outingId, { action: "request_departure" });
    expect(result).toMatchObject({ status: 200, body: { status: "renegotiation_required" } });
    const outing = await db.query<{ status: string; ended_at: string | Date | null }>(
      `select status, ended_at from outings where id = $1`, [plan.outingId],
    );
    expect(outing[0]).toMatchObject({ status: "planning", ended_at: null });
    const oldProposal = await db.query<{ status: string }>(
      `select status from proposals where id = $1`, [proposal.id],
    );
    expect(oldProposal[0].status).toBe("superseded");
    const departure = await db.query<{ status: string }>(
      `select status from departure_requests where outing_id = $1 and user_id = $2`,
      [plan.outingId, B],
    );
    expect(departure[0].status).toBe("accepted");
    const tieState = await db.query<{ status: string }>(
      `select status from tie_polls where outing_id = $1`, [plan.outingId],
    );
    expect(tieState[0].status).toBe("no_agreement");

    const noAgreement = await handlePlanningAction(ctx(A), plan.outingId, { action: "declare_no_agreement" });
    expect(noAgreement.status).toBe(200);
    const ended = await db.query<{ status: string }>(`select status from outings where id = $1`, [plan.outingId]);
    expect(ended[0].status).toBe("no_agreement");
  });

  it("rejects publishing an existing offer that conflicts with a resolved tie", async () => {
    const plan = await setupPlan();
    const options = await db.query<{
      id: string; activity: string; starts_at: string | Date;
      estimated_cost_cents: number; activity_tags: unknown;
    }>(
      `select id, activity, starts_at, estimated_cost_cents, activity_tags
         from outing_options where outing_id = $1 order by starts_at`, [plan.outingId],
    );
    const second = options[1];
    const offerB = crypto.randomUUID();
    await db.query(
      `insert into offers
        (id, outing_id, owner_user_id, option_id, activity, starts_at, estimated_cost_cents,
         attendee_user_ids, activity_tags, private_note, status, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, '', 'published', now())`,
      [offerB, plan.outingId, A, second.id, second.activity, second.starts_at,
        second.estimated_cost_cents, JSON.stringify([A, B]), JSON.stringify(second.activity_tags)],
    );
    const [sortedA, sortedB] = [options[0].id, second.id].sort();
    await db.query(
      `insert into tie_polls
        (id, outing_id, tie_key, option_a_id, option_b_id, participant_user_ids,
         status, outcome, selected_option_id, resolved_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'resolved', 'a', $4, now())`,
      [crypto.randomUUID(), plan.outingId, `${sortedA}:${sortedB}`, options[0].id, second.id,
        JSON.stringify([A, B])],
    );

    const result = await handlePlanningAction(ctx(A), plan.outingId, {
      action: "publish_proposal", offerId: offerB,
    });
    expect(result).toMatchObject({ status: 409, body: { error: "tie_choice_required" } });

    const expired = crypto.randomUUID();
    await db.query(
      `insert into proposals
        (id, outing_id, revision, created_by_user_id, option_id, activity, starts_at,
         estimated_cost_cents, attendee_user_ids, status, kind, published_at, expires_at, condition_versions)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb, 'expired', 'initial',
               now() - interval '1 hour', now() - interval '30 minutes', '{}'::jsonb)`,
      [expired, plan.outingId, A, second.id, second.activity, second.starts_at,
        second.estimated_cost_cents, JSON.stringify([A, B])],
    );
    const restart = await handlePlanningAction(ctx(B), plan.outingId, {
      action: "restart_proposal", proposalId: expired,
    });
    expect(restart).toMatchObject({ status: 409, body: { error: "tie_choice_required" } });
  });

  it("allows an explicit no-agreement decision when no proposal was ever published", async () => {
    const plan = await setupPlan();
    const result = await handlePlanningAction(ctx(B), plan.outingId, { action: "declare_no_agreement" });
    expect(result.status).toBe(200);
    const outing = await db.query<{ status: string; ended_at: string | Date | null }>(
      `select status, ended_at from outings where id = $1`, [plan.outingId],
    );
    expect(outing[0].status).toBe("no_agreement");
    expect(outing[0].ended_at).not.toBeNull();
  });
});
