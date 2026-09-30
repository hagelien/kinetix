/**
 * The sampler's eligibility predicates reuse `notAuthoredByCaller` /
 * `unverifiedByAgent` (correlated `NOT EXISTS` over `agent_verifications`),
 * and its cohort membership depends on Postgres's `hashtext()` and its
 * ordering on a `case`/`random()` expression — the kind of raw SQL the
 * mocked unit suite never executes. Runs against real Postgres (PGlite)
 * rather than a mocked db client, mirroring agent-escalation-queue.test.ts.
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
  agentVerifications,
  drugParameterRevisions,
  pendingEdits,
} from '../../db/schema.js';
import handler, { drawAuditSample } from '../../api/agent-audit-sample.js';
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

async function seedAgent(
  userId: number,
  slug: string,
  selfReviewEnabled = false,
): Promise<number> {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active', selfReviewEnabled })
    .returning({ id: agents.id });
  return row!.id;
}

/** A direct revision, or one applied via a pending edit, per `reviewedBy`. */
async function seedRevision(args: {
  drugId: number;
  parameter?: string;
  createdBy: number;
  reviewedBy?: number | null;
  newValue?: unknown;
}): Promise<number> {
  let pendingEditId: number | null = null;
  if (args.reviewedBy !== undefined) {
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: args.drugId,
        parameter: args.parameter ?? 'clearance',
        proposedValue: { median: 1 },
        submittedBy: args.createdBy,
        status: 'approved',
        reviewedBy: args.reviewedBy,
        reviewedAt: new Date(),
      })
      .returning({ id: pendingEdits.id });
    pendingEditId = edit!.id;
  }
  const [row] = await db
    .insert(drugParameterRevisions)
    .values({
      drugId: args.drugId,
      parameter: args.parameter ?? 'clearance',
      oldValue: { median: 1 },
      newValue: args.newValue ?? { median: 2 },
      pendingEditId,
      createdBy: args.createdBy,
    })
    .returning({ id: drugParameterRevisions.id });
  return row!.id;
}

async function callSampler(callerUserId: number, url = '/api/agent-audit-sample') {
  getUserFromRequestMock.mockResolvedValue({ userId: callerUserId, role: 'contributor' });
  const req = { method: 'GET', url, headers: { host: 'localhost' } } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
}

describe('agent audit sample — eligibility (rate=1, full cohort)', () => {
  it('never hands the caller a revision it produced', async () => {
    const authorUserId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const authorAgentId = await seedAgent(authorUserId, 'author-agent');
    const drugId = await seedDrug(db, { slug: 'audit-drug-1' });
    await seedRevision({ drugId, createdBy: authorUserId });

    const { items, cohortSize } = await drawAuditSample({
      agentId: authorAgentId,
      agentUserId: authorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(items).toEqual([]);
    expect(cohortSize).toBe(0);
  });

  it('never re-serves a revision the caller already verified', async () => {
    const producerUserId = await seedUser(db, { email: 'producer@example.com', username: 'producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor@example.com',
      username: 'auditor',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent');
    const drugId = await seedDrug(db, { slug: 'audit-drug-2' });
    const revisionId = await seedRevision({ drugId, createdBy: producerUserId });

    await db.insert(agentVerifications).values({
      agentId: auditorAgentId,
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
      verdict: 'approve',
      rationaleMd: 'Already redone this in a prior shadow-audit cycle.',
      evidenceRefs: [],
      isImplicit: false,
    });

    const { items, cohortSize } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(items).toEqual([]);
    expect(cohortSize).toBe(0);
  });

  it('serves an eligible revision produced and reviewed by someone else', async () => {
    const producerUserId = await seedUser(db, { email: 'producer3@example.com', username: 'producer3' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor3@example.com',
      username: 'auditor3',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-3');
    const drugId = await seedDrug(db, { slug: 'audit-drug-3' });
    await seedRevision({ drugId, createdBy: producerUserId });

    const { items, cohortSize } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(cohortSize).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].targetType).toBe('drug_parameter_revision');
    expect(items[0].payload.parameter).toBe('clearance');
  });

  it('does not let a self-review grant bypass author exclusion, unlike the ordinary queue', async () => {
    // Every row here is authored by the caller itself, with self-review
    // enabled on its agent identity. If the endpoint mistakenly honoured
    // `self_review_enabled` (the ordinary queue's shorthanded-pool escape
    // hatch), a meaningful fraction of these 100 rows would clear the
    // author filter and show up, cohortSize included. It must stay zero.
    const selfReviewUserId = await seedUser(db, {
      email: 'self-review@example.com',
      username: 'self-review-producer',
      role: 'contributor',
    });
    await seedAgent(selfReviewUserId, 'self-review-agent', true);
    const drugId = await seedDrug(db, { slug: 'audit-drug-self-review' });
    for (let i = 0; i < 100; i++) {
      await seedRevision({ drugId, parameter: `clearance${i}`, createdBy: selfReviewUserId });
    }

    const { status, body } = await callSampler(selfReviewUserId);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.sample.cohortSize).toBe(0);
  });
});

describe('agent audit sample — appliedVia classification (rate=1)', () => {
  it('labels a revision with no originating pending edit as direct', async () => {
    const producerUserId = await seedUser(db, { email: 'direct@example.com', username: 'direct-producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-direct@example.com',
      username: 'auditor-direct',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-direct');
    const drugId = await seedDrug(db, { slug: 'audit-drug-direct' });
    await seedRevision({ drugId, createdBy: producerUserId });

    const { items } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(items[0]?.payload.appliedVia).toBe('direct');
  });

  it('labels a pending-edit-backed revision reviewed by an agent as agent_applied', async () => {
    const producerUserId = await seedUser(db, { email: 'consensus-producer@example.com', username: 'consensus-producer' });
    const reviewerUserId = await seedUser(db, { email: 'consensus-reviewer@example.com', username: 'consensus-reviewer' });
    await seedAgent(reviewerUserId, 'consensus-reviewer-agent');
    const auditorUserId = await seedUser(db, {
      email: 'auditor-consensus@example.com',
      username: 'auditor-consensus',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-consensus');
    const drugId = await seedDrug(db, { slug: 'audit-drug-consensus' });
    await seedRevision({ drugId, createdBy: producerUserId, reviewedBy: reviewerUserId });

    const { items } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(items[0]?.payload.appliedVia).toBe('agent_applied');
  });

  it('labels a pending-edit-backed revision reviewed by a human as human_reviewed', async () => {
    const producerUserId = await seedUser(db, { email: 'human-producer@example.com', username: 'human-producer' });
    const reviewerUserId = await seedUser(db, { email: 'human-reviewer@example.com', username: 'human-reviewer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-human@example.com',
      username: 'auditor-human',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-human');
    const drugId = await seedDrug(db, { slug: 'audit-drug-human' });
    await seedRevision({ drugId, createdBy: producerUserId, reviewedBy: reviewerUserId });

    const { items } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(items[0]?.payload.appliedVia).toBe('human_reviewed');
  });
});

describe('agent audit sample — blind payload', () => {
  it('never includes the published newValue or editSummary in the response', async () => {
    const producerUserId = await seedUser(db, { email: 'blind-producer@example.com', username: 'blind-producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-blind@example.com',
      username: 'auditor-blind',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-blind');
    const drugId = await seedDrug(db, { slug: 'audit-drug-blind' });
    // A distinctive sentinel value: if it leaks anywhere in the response body,
    // the blind-redo contract is broken. rate=1 (not the HTTP-clamped max of
    // 0.1) keeps this deterministic — see the "eligibility" describe block.
    await seedRevision({
      drugId,
      createdBy: producerUserId,
      newValue: { median: 999_999 },
    });

    const { items } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 1,
      since: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0].payload).not.toHaveProperty('newValue');
    expect(items[0].payload).not.toHaveProperty('editSummary');
    expect(JSON.stringify(items)).not.toContain('999999');
  });
});

describe('agent audit sample — cohort sizing and stability', () => {
  it('never returns anything when the cohort is empty (rate=0)', async () => {
    const producerUserId = await seedUser(db, { email: 'empty-cohort@example.com', username: 'empty-cohort-producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-empty@example.com',
      username: 'auditor-empty',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-empty');
    const drugId = await seedDrug(db, { slug: 'audit-drug-empty-cohort' });
    for (let i = 0; i < 20; i++) {
      await seedRevision({ drugId, parameter: `clearance${i}`, createdBy: producerUserId });
    }

    const { items, cohortSize } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 20,
      rate: 0,
      since: null,
    });
    expect(cohortSize).toBe(0);
    expect(items).toEqual([]);
  });

  it('respects an explicit limit even when the cohort is larger', async () => {
    const producerUserId = await seedUser(db, { email: 'capped-producer@example.com', username: 'capped-producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-capped@example.com',
      username: 'auditor-capped',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-capped');
    const drugId = await seedDrug(db, { slug: 'audit-drug-capped' });
    for (let i = 0; i < 40; i++) {
      await seedRevision({ drugId, parameter: `clearance${i}`, createdBy: producerUserId });
    }

    const { items, cohortSize } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 2,
      rate: 1,
      since: null,
    });
    expect(cohortSize).toBe(40);
    expect(items).toHaveLength(2);
  });

  it('prioritises agent_applied rows so limit never crowds them out', async () => {
    const producerUserId = await seedUser(db, { email: 'priority-producer@example.com', username: 'priority-producer' });
    const reviewerUserId = await seedUser(db, { email: 'priority-reviewer@example.com', username: 'priority-reviewer' });
    await seedAgent(reviewerUserId, 'priority-reviewer-agent');
    const auditorUserId = await seedUser(db, {
      email: 'auditor-priority@example.com',
      username: 'auditor-priority',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-priority');
    const drugId = await seedDrug(db, { slug: 'audit-drug-priority' });

    // Five direct (lowest priority) revisions...
    const directIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      directIds.push(
        await seedRevision({ drugId, parameter: `direct${i}`, createdBy: producerUserId }),
      );
    }
    // ...and two agent_applied (highest priority) ones.
    const agentAppliedIds: number[] = [];
    for (let i = 0; i < 2; i++) {
      agentAppliedIds.push(
        await seedRevision({
          drugId,
          parameter: `consensus${i}`,
          createdBy: producerUserId,
          reviewedBy: reviewerUserId,
        }),
      );
    }

    const { items, cohortSize } = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 2,
      rate: 1,
      since: null,
    });
    expect(cohortSize).toBe(7);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.payload.appliedVia === 'agent_applied')).toBe(true);
    expect(items.map((i) => i.targetId).sort()).toEqual([...agentAppliedIds].sort());
  });

  it('serves the same cohort membership across repeated calls when nothing new has been verified', async () => {
    const producerUserId = await seedUser(db, { email: 'stable-producer@example.com', username: 'stable-producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-stable@example.com',
      username: 'auditor-stable',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-stable');
    const drugId = await seedDrug(db, { slug: 'audit-drug-stable' });
    for (let i = 0; i < 50; i++) {
      await seedRevision({ drugId, parameter: `clearance${i}`, createdBy: producerUserId });
    }

    const draw = () =>
      drawAuditSample({
        agentId: auditorAgentId,
        agentUserId: auditorUserId,
        limit: 50,
        rate: 0.3,
        since: null,
      });

    const first = await draw();
    const second = await draw();
    expect(first.cohortSize).toBe(second.cohortSize);
    expect(first.items.map((i) => i.targetId).sort()).toEqual(
      second.items.map((i) => i.targetId).sort(),
    );
  });

  it('does not backfill from outside the cohort as members are verified', async () => {
    const producerUserId = await seedUser(db, { email: 'nobackfill-producer@example.com', username: 'nobackfill-producer' });
    const auditorUserId = await seedUser(db, {
      email: 'auditor-nobackfill@example.com',
      username: 'auditor-nobackfill',
      role: 'contributor',
    });
    const auditorAgentId = await seedAgent(auditorUserId, 'auditor-agent-nobackfill');
    const drugId = await seedDrug(db, { slug: 'audit-drug-nobackfill' });
    for (let i = 0; i < 50; i++) {
      await seedRevision({ drugId, parameter: `clearance${i}`, createdBy: producerUserId });
    }

    const before = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 50,
      rate: 0.3,
      since: null,
    });
    expect(before.cohortSize).toBeGreaterThan(0);

    // "Verify" every cohort member this cycle produced.
    for (const item of before.items) {
      await db.insert(agentVerifications).values({
        agentId: auditorAgentId,
        targetType: 'drug_parameter_revision',
        targetId: item.targetId,
        verdict: 'approve',
        rationaleMd: 'Shadow-audit redo recorded.',
        evidenceRefs: [],
        isImplicit: false,
      });
    }

    const after = await drawAuditSample({
      agentId: auditorAgentId,
      agentUserId: auditorUserId,
      limit: 50,
      rate: 0.3,
      since: null,
    });
    // The cohort shrank by exactly what was verified — nothing from outside
    // the original ~30% hash bucket backfilled in to replace it.
    expect(after.cohortSize).toBe(before.cohortSize - before.items.length);
  });
});
