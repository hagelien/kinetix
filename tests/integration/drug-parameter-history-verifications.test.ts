/**
 * `GET /api/drug-parameter-history` surfacing agent verdicts on the pending
 * edit behind a revision (#1358): the history dialog previously said only
 * that a parameter was "recomputed from N source entries", with no way to
 * see why the count changed. A revision produced by an approved `param_entry`
 * pending edit carries `pendingEditId`; agents may have recorded
 * approve/dispute/abstain verdicts against that edit before it was applied,
 * so the route now attaches a verdict-count summary — but only when the
 * caller has the same visibility `pending_edit` verdicts require everywhere
 * else (reviewers; never an anonymous caller), so this runs against real SQL
 * rather than a mocked visibility check.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
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

import handler from '../../api/drug-parameter-history.js';
import { agents, agentVerifications, drugBlockRevisions, drugParameterRevisions, pendingEdits } from '../../db/schema.js';
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

async function getHistory(drugId: number, parameter: string, block = false) {
  const req = {
    method: 'GET',
    url: `/api/drug-parameter-history?drugId=${drugId}&${block ? 'block' : 'parameter'}=${parameter}`,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return JSON.parse(state.body) as {
    revisions: Array<{
      id: number;
      pendingEditId: number | null;
      author?: { id: number; email?: string };
      reviewDecision?: { reviewedAt: string | null; reviewer: { id: number; email?: string } | null };
      verifications?: {
        approveCount: number;
        disputeCount: number;
        abstainCount: number;
      };
    }>;
  };
}

/** A drug-parameter revision produced by an approved `param_entry` edit,
 * with one explicit dispute verdict recorded against that edit. */
async function seedRevisionWithDisputedPendingEdit(block?: 'metabolism' | 'pharmacodynamics' | 'modelStructure'): Promise<{
  drugId: number;
  submitterId: number;
  reviewerId: number;
}> {
  const submitterId = await seedUser(db, {
    email: 'submitter@example.com',
    username: 'submitter',
  });
  const verifierUserId = await seedUser(db, {
    email: 'verifier-agent@example.com',
    username: 'verifier-agent',
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

  const drugId = await seedDrug(db);
  const reviewerId = block ? await seedUser(db, {
    email: 'reviewer-private@example.com', username: 'moderator', role: 'editor',
  }) : submitterId;
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: block === 'metabolism' ? 'metabolism' : block === 'pharmacodynamics' ? 'receptor_targets' : 'param_entry',
      targetId: block ? drugId : null,
      parameter: 'therapeuticConcentration',
      proposedValue: { op: 'delete' },
      status: 'approved',
      submittedBy: submitterId,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    })
    .returning({ id: pendingEdits.id });

  await db.insert(agentVerifications).values({
    agentId: agentRow!.id,
    targetType: 'pending_edit',
    targetId: edit!.id,
    verdict: 'dispute',
    rationaleMd:
      'The cited paper reports plasma, not whole blood — pooling it understates Cmax.',
    evidenceRefs: [],
    isImplicit: false,
  });

  await db.insert(drugParameterRevisions).values({
    drugId,
    parameter: 'therapeuticConcentration',
    oldValue: { min: 1, max: 2, median: 1.5, unit: 'mg/L' },
    newValue: { min: 1, max: 1.8, median: 1.4, unit: 'mg/L' },
    editSummary: 'auto:param_entries_recomputed:2:from:3',
    pendingEditId: edit!.id,
    createdBy: submitterId,
  });

  if (block) {
    await db.insert(drugBlockRevisions).values({
      drugId, block, oldValue: {}, newValue: {}, createdBy: submitterId,
      pendingEditId: edit!.id,
    });
  }
  return { drugId, submitterId, reviewerId };
}

describe('drug-parameter-history: pending-edit verdict surfacing', () => {
  it('omits the verdict summary for an anonymous caller', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { drugId } = await seedRevisionWithDisputedPendingEdit();

    const { revisions } = await getHistory(drugId, 'therapeuticConcentration');

    expect(revisions).toHaveLength(1);
    // The linked pending edit id is not itself sensitive, but its verdicts
    // are — `pending_edit` visibility hides them from an anonymous request.
    expect(revisions[0]!.pendingEditId).not.toBeNull();
    expect(revisions[0]!.verifications).toBeUndefined();
  });

  it('attaches the verdict tally for a reviewer', async () => {
    const { drugId, submitterId } = await seedRevisionWithDisputedPendingEdit();
    getUserFromRequestMock.mockResolvedValue({
      userId: submitterId,
      role: 'editor',
    });

    const { revisions } = await getHistory(drugId, 'therapeuticConcentration');

    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.verifications).toEqual(
      expect.objectContaining({ approveCount: 0, disputeCount: 1, abstainCount: 0 }),
    );
  });
});


describe.each(['metabolism', 'pharmacodynamics', 'modelStructure'] as const)('block history %s: approval provenance', (block) => {
  it('shows the publication reviewer publicly without emails or private verdicts', async () => {
    const { drugId, submitterId, reviewerId } = await seedRevisionWithDisputedPendingEdit(block);
    getUserFromRequestMock.mockResolvedValue(null);
    const { revisions } = await getHistory(drugId, block, true);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.author?.id).toBe(submitterId);
    expect(revisions[0]!.reviewDecision?.reviewer?.id).toBe(reviewerId);
    expect(revisions[0]!.reviewDecision?.reviewedAt).toEqual(expect.any(String));
    expect(revisions[0]!.verifications).toBeUndefined();
    expect(JSON.stringify(revisions)).not.toContain('@example.com');
    expect(revisions[0]!.author?.email).toBeUndefined();
    expect(revisions[0]!.reviewDecision?.reviewer?.email).toBeUndefined();
  });

  it('shows the linked verdict tally to an authorized reviewer', async () => {
    const { drugId, reviewerId } = await seedRevisionWithDisputedPendingEdit(block);
    getUserFromRequestMock.mockResolvedValue({ userId: reviewerId, role: 'editor' });
    const { revisions } = await getHistory(drugId, block, true);
    expect(revisions[0]!.verifications).toMatchObject({ approveCount: 0, disputeCount: 1, abstainCount: 0 });
  });

  it('withholds the tally from an unrelated contributor', async () => {
    const { drugId } = await seedRevisionWithDisputedPendingEdit(block);
    const outsiderId = await seedUser(db, { email: 'outsider@example.com', username: 'outsider', role: 'contributor' });
    getUserFromRequestMock.mockResolvedValue({ userId: outsiderId, role: 'contributor' });
    const { revisions } = await getHistory(drugId, block, true);
    expect(revisions[0]!.reviewDecision).toBeDefined();
    expect(revisions[0]!.verifications).toBeUndefined();
  });

  it('does not invent a decision for a direct write', async () => {
    const drugId = await seedDrug(db);
    await db.insert(drugBlockRevisions).values({ drugId, block, oldValue: {}, newValue: {} });
    getUserFromRequestMock.mockResolvedValue(null);
    const { revisions } = await getHistory(drugId, block, true);
    expect(revisions[0]!.reviewDecision).toBeUndefined();
    expect(revisions[0]!.verifications).toBeUndefined();
  });
});
