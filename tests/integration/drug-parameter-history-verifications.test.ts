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
import { agents, agentVerifications, drugParameterRevisions, pendingEdits } from '../../db/schema.js';
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

async function getHistory(drugId: number, parameter: string) {
  const req = {
    method: 'GET',
    url: `/api/drug-parameter-history?drugId=${drugId}&parameter=${parameter}`,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return JSON.parse(state.body) as {
    revisions: Array<{
      id: number;
      pendingEditId: number | null;
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
async function seedRevisionWithDisputedPendingEdit(): Promise<{
  drugId: number;
  submitterId: number;
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

  return { drugId, submitterId };
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
