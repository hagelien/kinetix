/**
 * `GET /api/agent-verifications?targetType=pending_edit&targetId=` for a
 * non-reviewer agent, after the target is decided.
 *
 * `visibleVerificationTargetIds`'s open-queue rule for an active agent only
 * covers a still-PENDING edit (so it can be picked up for review) — once the
 * edit is applied or rejected, that rule no longer matches it. Without the
 * `includeCallerVerdicts` widening (added alongside the drug-parameter
 * history dialog surfacing this same data, #1358 / review finding on #1361),
 * an agent that argued a debate loses read access to its own rationale the
 * moment the debate resolves. This runs against real SQL because the gap is
 * in a shared authorization helper reused by several routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/agent-verifications.js';
import {
  agents,
  agentVerifications,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
});

function createResponse() {
  const state = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

async function getVerdicts(callerUserId: number, targetId: number) {
  getUserFromRequestMock.mockResolvedValue({
    userId: callerUserId,
    role: 'contributor',
  });
  const req = {
    method: 'GET',
    url: `/api/agent-verifications?targetType=pending_edit&targetId=${targetId}`,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return state;
}

describe('agent-verifications GET: own-verdict visibility after decision (#1361)', () => {
  it('keeps a decided pending edit readable to the agent that disputed it', async () => {
    const submitterId = await seedUser(db, {
      email: 'submitter@example.com',
      username: 'submitter',
    });
    const verifierUserId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier',
      role: 'contributor',
    });
    const [agentRow] = await db
      .insert(agents)
      .values({
        userId: verifierUserId,
        name: 'verifier-agent',
        slug: 'verifier-agent',
        status: 'active',
      })
      .returning({ id: agents.id });

    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        parameter: 'therapeuticConcentration',
        proposedValue: { op: 'delete' },
        status: 'pending',
        submittedBy: submitterId,
      })
      .returning({ id: pendingEdits.id });

    await db.insert(agentVerifications).values({
      agentId: agentRow!.id,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'dispute',
      rationaleMd: 'The pooled median moves outside the reported CI.',
      evidenceRefs: [],
      isImplicit: false,
    });

    // The edit is later applied — the open-queue rule that let the agent see
    // an open target no longer matches it.
    await db
      .update(pendingEdits)
      .set({ status: 'approved', reviewedBy: submitterId, reviewedAt: new Date() })
      .where(eq(pendingEdits.id, edit!.id));

    const state = await getVerdicts(verifierUserId, edit!.id);

    expect(state.statusCode).toBeLessThan(300);
    const body = JSON.parse(state.body) as {
      verifications: Array<{ verdict: string; rationaleMd: string }>;
    };
    expect(body.verifications).toHaveLength(1);
    expect(body.verifications[0]!.verdict).toBe('dispute');
  });

  it('still hides a decided pending edit from an agent that never verified it', async () => {
    const submitterId = await seedUser(db, {
      email: 'submitter2@example.com',
      username: 'submitter2',
    });
    const bystanderUserId = await seedUser(db, {
      email: 'bystander@example.com',
      username: 'bystander',
      role: 'contributor',
    });
    await db.insert(agents).values({
      userId: bystanderUserId,
      name: 'bystander-agent',
      slug: 'bystander-agent',
      status: 'active',
    });

    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        parameter: 'therapeuticConcentration',
        proposedValue: { op: 'delete' },
        status: 'approved',
        submittedBy: submitterId,
        reviewedBy: submitterId,
        reviewedAt: new Date(),
      })
      .returning({ id: pendingEdits.id });

    const state = await getVerdicts(bystanderUserId, edit!.id);

    expect(state.statusCode).toBe(404);
  });

  // Review finding on #1361: the widening above must not bypass the
  // published-page gate — an agent's own rationale on a wiki edit stays
  // withheld once the page it targeted is unpublished again, same as it
  // would be for a still-open queue candidate.
  it('re-hides a decided wiki edit once its page reverts to draft, even for the agent that verified it', async () => {
    const submitterId = await seedUser(db, {
      email: 'submitter3@example.com',
      username: 'submitter3',
    });
    const verifierUserId = await seedUser(db, {
      email: 'verifier3@example.com',
      username: 'verifier3',
      role: 'contributor',
    });
    const [agentRow] = await db
      .insert(agents)
      .values({
        userId: verifierUserId,
        name: 'verifier3-agent',
        slug: 'verifier3-agent',
        status: 'active',
      })
      .returning({ id: agents.id });

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'mdma',
        title: 'MDMA',
        status: 'published',
        createdBy: submitterId,
        updatedBy: submitterId,
      })
      .returning({ id: wikiPages.id });

    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Tmax er 1,5–3 timer.',
        proposedValue: { factStatement: 'Tmax er 1,5–3 timer.' },
        submittedBy: submitterId,
        status: 'approved',
        reviewedBy: submitterId,
        reviewedAt: new Date(),
      })
      .returning({ id: pendingEdits.id });

    await db.insert(agentVerifications).values({
      agentId: agentRow!.id,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      rationaleMd: 'Matches the cited PK study.',
      evidenceRefs: [],
      isImplicit: false,
    });

    // Confirm the widening works while the page is still published...
    const whilePublished = await getVerdicts(verifierUserId, edit!.id);
    expect(whilePublished.statusCode).toBeLessThan(300);

    // ...then revert the page to draft and confirm it is withheld again.
    await db
      .update(wikiPages)
      .set({ status: 'draft' })
      .where(eq(wikiPages.id, page!.id));

    const afterRevert = await getVerdicts(verifierUserId, edit!.id);
    expect(afterRevert.statusCode).toBe(404);
  });

  // P1 review finding on #1361: `visibleVerificationTargetIds`'s pending_edit
  // branch excludes the caller's own submissions unless `callerSelfReviews`
  // is passed — a check every GET call site skipped, so a self-review-enabled
  // agent that explicitly reviewed its own edit lost visibility into that
  // verdict as soon as the edit was decided, exactly the workflow self-review
  // exists for.
  it('keeps a decided self-reviewed pending edit visible to its self-review-enabled author', async () => {
    const selfReviewerUserId = await seedUser(db, {
      email: 'self-reviewer@example.com',
      username: 'self-reviewer',
      role: 'contributor',
    });
    const [agentRow] = await db
      .insert(agents)
      .values({
        userId: selfReviewerUserId,
        name: 'self-reviewer-agent',
        slug: 'self-reviewer-agent',
        status: 'active',
        selfReviewEnabled: true,
      })
      .returning({ id: agents.id });

    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        parameter: 'therapeuticConcentration',
        proposedValue: { op: 'delete' },
        status: 'pending',
        submittedBy: selfReviewerUserId,
      })
      .returning({ id: pendingEdits.id });

    // The explicit self-review verdict (not the submit-time implicit stake).
    await db.insert(agentVerifications).values({
      agentId: agentRow!.id,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      rationaleMd: 'Re-checked against the primary source on a second pass.',
      evidenceRefs: [],
      isImplicit: false,
    });

    await db
      .update(pendingEdits)
      .set({
        status: 'approved',
        reviewedBy: selfReviewerUserId,
        reviewedAt: new Date(),
      })
      .where(eq(pendingEdits.id, edit!.id));

    const state = await getVerdicts(selfReviewerUserId, edit!.id);

    expect(state.statusCode).toBeLessThan(300);
    const body = JSON.parse(state.body) as {
      verifications: Array<{ verdict: string; isImplicit: boolean }>;
    };
    expect(
      body.verifications.some((v) => !v.isImplicit && v.verdict === 'approve'),
    ).toBe(true);
  });
});
