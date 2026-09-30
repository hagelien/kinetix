/**
 * `GET /api/agent-verifications-queue?targetType=&targetId=` — a direct
 * single-target lookup for a caller that already knows which target it
 * needs content for (the escalation feed, api/agent-escalation-queue.ts,
 * hands out identifiers only and needs this to turn one into a payload).
 * Exercises the real per-type eligibility SQL the mocked unit suite doesn't
 * reach, same rationale as agent-verification-queue-submitters.test.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { agents, agentVerifications, pendingEdits } from '../../db/schema.js';
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

async function seedPendingParameterEdit(drugId: number, submittedBy: number): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      proposedValue: { median: 1 },
      submittedBy,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

async function callQueue(callerUserId: number, url: string) {
  getUserFromRequestMock.mockResolvedValue({ userId: callerUserId, role: 'contributor' });
  const req = { method: 'GET', url, headers: { host: 'localhost' } } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
}

describe('GET /api/agent-verifications-queue?targetId=', () => {
  it('hydrates one target directly, outside the oldest-first batch order', async () => {
    const submitterId = await seedUser(db, { email: 'submitter@example.com', username: 'submitter' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent');
    const drugId = await seedDrug(db, { slug: 'target-id-drug' });
    const editId = await seedPendingParameterEdit(drugId, submitterId);

    const { status, body } = await callQueue(
      verifierUserId,
      `/api/agent-verifications-queue?targetType=pending_edit&targetId=${editId}`,
    );
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].targetId).toBe(editId);
    expect(body.items[0].payload.currentValue).toBeDefined();
  });

  it('returns nothing for a target the caller authored', async () => {
    const authorUserId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    await seedAgent(authorUserId, 'author-agent');
    const drugId = await seedDrug(db, { slug: 'target-id-own-drug' });
    const editId = await seedPendingParameterEdit(drugId, authorUserId);

    const { body } = await callQueue(
      authorUserId,
      `/api/agent-verifications-queue?targetType=pending_edit&targetId=${editId}`,
    );
    expect(body.items).toEqual([]);
  });

  it('returns nothing for a target the caller already verified', async () => {
    const submitterId = await seedUser(db, { email: 'submitter2@example.com', username: 'submitter2' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier2@example.com',
      username: 'verifier2',
      role: 'contributor',
    });
    const verifierAgentId = await seedAgent(verifierUserId, 'verifier-agent-2');
    const drugId = await seedDrug(db, { slug: 'target-id-verified-drug' });
    const editId = await seedPendingParameterEdit(drugId, submitterId);
    await db.insert(agentVerifications).values({
      agentId: verifierAgentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'approve',
      rationaleMd: '',
      evidenceRefs: [],
      isImplicit: false,
    });

    const { body } = await callQueue(
      verifierUserId,
      `/api/agent-verifications-queue?targetType=pending_edit&targetId=${editId}`,
    );
    expect(body.items).toEqual([]);
  });

  it('returns nothing for a target that no longer exists', async () => {
    const verifierUserId = await seedUser(db, {
      email: 'verifier3@example.com',
      username: 'verifier3',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-3');

    const { status, body } = await callQueue(
      verifierUserId,
      '/api/agent-verifications-queue?targetType=pending_edit&targetId=999999',
    );
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('rejects a targetId with no targetType', async () => {
    const verifierUserId = await seedUser(db, {
      email: 'verifier4@example.com',
      username: 'verifier4',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-4');

    const { status } = await callQueue(
      verifierUserId,
      '/api/agent-verifications-queue?targetId=1',
    );
    expect(status).toBe(400);
  });
});
