/**
 * `GET /api/agent-verifications-queue?revisit=abstained&abstainedBefore=` —
 * the abstention-recovery pass. The normal queue hides every target the agent
 * has a verdict on, `abstain` included, so an abstention made for a reason
 * that has since gone away (a worker on a stale checkout) never comes back by
 * itself. This mode serves exactly the caller's own blind abstentions from
 * before the cutoff. Runs the real eligibility SQL, like the target-id suite.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import {
  agents,
  agentVerdictReconsiderations,
  agentVerifications,
  pendingEdits,
} from '../../db/schema.js';
import handler from '../../api/agent-verifications-queue.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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

async function seedAgent(userId: number, slug: string): Promise<number> {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active', selfReviewEnabled: false })
    .returning({ id: agents.id });
  return row!.id;
}

let editSeq = 0;
async function seedPendingEdit(submittedBy: number): Promise<number> {
  const drugId = await seedDrug(db, { slug: `revisit-drug-${++editSeq}` });
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      proposedValue: { median: 1 },
      submittedBy,
      status: 'pending',
      submittedAt: new Date('2026-09-01T00:00:00Z'),
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

async function seedVerdict(
  agentId: number,
  targetId: number,
  verdict: 'approve' | 'dispute' | 'abstain',
  at: Date,
): Promise<number> {
  const [row] = await db
    .insert(agentVerifications)
    .values({
      agentId,
      targetType: 'pending_edit',
      targetId,
      verdict,
      rationaleMd: `${verdict}: fulltekst ikke tilgjengelig via leseren`,
      evidenceRefs: [],
      isImplicit: false,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: agentVerifications.id });
  return row!.id;
}

async function callQueue(callerUserId: number, query: string) {
  getUserFromRequestMock.mockResolvedValue({ userId: callerUserId, role: 'contributor' });
  const req = {
    method: 'GET',
    url: `/api/agent-verifications-queue?${query}`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
}

const BEFORE_FIX = new Date('2026-09-10T00:00:00Z');
const CUTOFF = '2026-09-22T00:00:00Z';
const AFTER_FIX = new Date('2026-09-25T00:00:00Z');

async function setup() {
  const submitterId = await seedUser(db, { email: 's@example.com', username: 's' });
  const verifierUserId = await seedUser(db, {
    email: 'v@example.com',
    username: 'v',
    role: 'contributor',
  });
  const agentId = await seedAgent(verifierUserId, 'codex-reviewer');
  return { submitterId, verifierUserId, agentId };
}

describe('GET /api/agent-verifications-queue?revisit=abstained', () => {
  it('serves only the caller’s own abstentions from before the cutoff, with its prior rationale', async () => {
    const { submitterId, verifierUserId, agentId } = await setup();
    const oldAbstain = await seedPendingEdit(submitterId);
    const newAbstain = await seedPendingEdit(submitterId);
    const oldApprove = await seedPendingEdit(submitterId);
    const unjudged = await seedPendingEdit(submitterId);
    await seedVerdict(agentId, oldAbstain, 'abstain', BEFORE_FIX);
    await seedVerdict(agentId, newAbstain, 'abstain', AFTER_FIX);
    await seedVerdict(agentId, oldApprove, 'approve', BEFORE_FIX);

    const { status, body } = await callQueue(
      verifierUserId,
      `revisit=abstained&abstainedBefore=${CUTOFF}&targetType=pending_edit`,
    );
    expect(status).toBe(200);
    expect(body.items.map((i: { targetId: number }) => i.targetId)).toEqual([oldAbstain]);
    expect(body.items[0].priorAbstention).toEqual({
      rationaleMd: 'abstain: fulltekst ikke tilgjengelig via leseren',
      recordedAt: BEFORE_FIX.toISOString(),
    });
    // The normal queue still hides it, and still serves the unjudged one.
    const normal = await callQueue(verifierUserId, 'targetType=pending_edit');
    expect(normal.body.items.map((i: { targetId: number }) => i.targetId)).toEqual([unjudged]);
  });

  it('does not serve another agent’s abstention', async () => {
    const { submitterId, verifierUserId } = await setup();
    const otherUserId = await seedUser(db, {
      email: 'o@example.com',
      username: 'o',
      role: 'contributor',
    });
    const otherAgentId = await seedAgent(otherUserId, 'other-agent');
    const editId = await seedPendingEdit(submitterId);
    await seedVerdict(otherAgentId, editId, 'abstain', BEFORE_FIX);

    const { body } = await callQueue(
      verifierUserId,
      `revisit=abstained&abstainedBefore=${CUTOFF}`,
    );
    expect(body.items).toEqual([]);
  });

  it('leaves out an abstention that came from withdrawing a dispute after reading peers', async () => {
    const { submitterId, verifierUserId, agentId } = await setup();
    const editId = await seedPendingEdit(submitterId);
    const verificationId = await seedVerdict(agentId, editId, 'abstain', BEFORE_FIX);
    await db.insert(agentVerdictReconsiderations).values({
      verificationId,
      agentId,
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: 'v1',
      originalVerdict: 'dispute',
      originalRationaleMd: 'original dispute',
      originalRecordedAt: BEFORE_FIX,
      outcome: 'withdraw',
    });

    const { body } = await callQueue(
      verifierUserId,
      `revisit=abstained&abstainedBefore=${CUTOFF}`,
    );
    expect(body.items).toEqual([]);
  });

  it('leaves out a target that is no longer pending', async () => {
    const { submitterId, verifierUserId, agentId } = await setup();
    const editId = await seedPendingEdit(submitterId);
    await seedVerdict(agentId, editId, 'abstain', BEFORE_FIX);
    const { eq } = await import('drizzle-orm');
    await db.update(pendingEdits).set({ status: 'approved' }).where(eq(pendingEdits.id, editId));

    const { body } = await callQueue(
      verifierUserId,
      `revisit=abstained&abstainedBefore=${CUTOFF}`,
    );
    expect(body.items).toEqual([]);
  });

  it('requires a valid, non-future cutoff', async () => {
    const { verifierUserId } = await setup();
    expect((await callQueue(verifierUserId, 'revisit=abstained')).status).toBe(400);
    expect(
      (await callQueue(verifierUserId, 'revisit=abstained&abstainedBefore=nope')).status,
    ).toBe(400);
    expect(
      (await callQueue(verifierUserId, 'revisit=abstained&abstainedBefore=2999-01-01T00:00:00Z'))
        .status,
    ).toBe(400);
    expect(
      (await callQueue(verifierUserId, `revisit=disputed&abstainedBefore=${CUTOFF}`)).status,
    ).toBe(400);
  });
});
