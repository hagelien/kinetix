/**
 * Batched agent-consensus status on the /review list response (issue #1374).
 *
 * `ConsensusHoldNote` (src/components/review/PendingEditCard.tsx) used to call
 * GET /api/agent-verifications?targetId=… once per mounted card — up to 100
 * requests on a full moderator queue, each re-running the same verdict
 * lookup. `GET /api/pending-edits` now computes the same explanation for the
 * whole page in one pass (`consensusStatusForTargets`,
 * api/agent-verifications.ts) and attaches it to each qualifying row as
 * `consensusStatus`, so the card can read it straight off `edit` instead of
 * fetching it itself.
 *
 * These pin two things against real SQL: the batched status for an eligible
 * row matches what the single-target endpoint has always returned, and a row
 * that cannot show the note (no approval yet, or an unresolved dispute) never
 * gets a `consensusStatus` at all — mirroring the card's own gate for
 * rendering `ConsensusHoldNote` in the first place.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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

import handler, { agentConsensusStatus } from '../../api/agent-verifications.js';
import pendingEditsHandler from '../../api/pending-edits.js';
import { agentVerifications, agents, pendingEdits } from '../../db/schema.js';
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

async function seedAgent(
  slug: string,
  name = slug,
  opts: { selfReviewEnabled?: boolean } = {},
) {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({
      userId,
      name,
      slug,
      status: 'active',
      selfReviewEnabled: opts.selfReviewEnabled ?? false,
    })
    .returning({ id: agents.id });
  return { userId, agentId: row!.id };
}

async function approve(
  agentId: number,
  editId: number,
  opts: { model?: string; tier?: string | null } = {},
) {
  await db.insert(agentVerifications).values({
    agentId,
    targetType: 'pending_edit',
    targetId: editId,
    verdict: 'approve',
    rationaleMd: 'Kontrollert mot kilden.',
    evidenceRefs: [],
    isImplicit: false,
    model: opts.model ?? null,
    verifierTier: opts.tier ?? null,
  });
}

async function dispute(agentId: number, editId: number) {
  await db.insert(agentVerifications).values({
    agentId,
    targetType: 'pending_edit',
    targetId: editId,
    verdict: 'dispute',
    rationaleMd: 'Kilden støtter ikke dette.',
    evidenceRefs: [],
    isImplicit: false,
  });
}

/** A quoted, calculation-driving source value an agent proposed. */
async function seedHighRiskEdit(authorUserId: number) {
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: 1,
      parameter: 'volumeOfDistribution',
      proposedValue: {
        op: 'create',
        input: {
          value: 0.35,
          quote:
            'Remifentanil subsequently distributes into peripheral tissues with a steady-state volume of distribution of approximately 350 mL/kg.',
        },
      },
      submittedBy: authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

function createResponse() {
  const state = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
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

function getPendingEditsRequest(query = 'status=pending'): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = `/api/pending-edits?${query}`;
  req.headers = { host: 'localhost' };
  return req;
}

describe('GET /api/pending-edits — batched agent-consensus status (#1374)', () => {
  it('matches the single-target endpoint for an eligible row, and is absent from ineligible ones', async () => {
    const author = await seedAgent('author');
    const opus = await seedAgent('opus', 'Claude Opus 5');
    const sol = await seedAgent('sol', 'GPT-5.6 Sol');

    // Eligible: pending, ≥1 approval, no unresolved dispute — two mid-tier
    // approvals on a high-risk value, so the hold is the reportable
    // high_risk_missing_flagship reason (not the quiet quorum_unmet one).
    const heldEditId = await seedHighRiskEdit(author.userId);
    await approve(opus.agentId, heldEditId, { model: 'claude-opus-5' });
    await approve(sol.agentId, heldEditId, { model: 'gpt-5.6-sol' });

    // Ineligible: no approval yet at all.
    const untouchedEditId = await seedHighRiskEdit(author.userId);

    // Ineligible: has an approval, but an unresolved dispute stands against it.
    const disputedEditId = await seedHighRiskEdit(author.userId);
    await approve(opus.agentId, disputedEditId, { model: 'claude-opus-5' });
    await dispute(sol.agentId, disputedEditId);

    // The reference answer, from the single-target endpoint this replaces
    // per-card fetches to.
    expect(await agentConsensusStatus(heldEditId)).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
    });
    getUserFromRequestMock.mockResolvedValue({ userId: 0, role: 'admin' });
    const singleReq = {
      method: 'GET',
      url: `/api/agent-verifications?targetType=pending_edit&targetId=${heldEditId}`,
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;
    const { res: singleRes, state: singleState } = createResponse();
    await handler(singleReq, singleRes);
    const singleBody = JSON.parse(singleState.body);

    // The batched list response.
    getUserFromRequestMock.mockResolvedValue({ userId: 0, role: 'admin' });
    const { res, state } = createResponse();
    await pendingEditsHandler(getPendingEditsRequest(), res);
    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body) as {
      pendingEdits: Array<{ id: number; consensusStatus?: unknown }>;
    };
    const byId = new Map(body.pendingEdits.map((e) => [e.id, e]));

    expect(byId.get(heldEditId)?.consensusStatus).toEqual(singleBody.consensus);
    expect(byId.get(heldEditId)?.consensusStatus).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
      unrankedFlagshipApprovers: expect.arrayContaining([
        'Claude Opus 5',
        'GPT-5.6 Sol',
      ]),
    });
    expect(byId.get(untouchedEditId)?.consensusStatus).toBeUndefined();
    expect(byId.get(disputedEditId)?.consensusStatus).toBeUndefined();
  });

  // "An agent does not review what it wrote" (AGENTS.md, Self-review):
  // GET /api/agent-verifications?targetId= 404s a non-self-review agent's own
  // submission rather than reveal peer verdicts on it — including, for a
  // missing-flagship hold, the approvers' names. The batched status must
  // apply that same visibility rule, or the queue leaks exactly what the
  // single-target endpoint withholds.
  it('withholds consensusStatus from a non-self-review agent viewing its own submission, but not from a reviewer', async () => {
    const author = await seedAgent('author2');
    const opus = await seedAgent('opus2', 'Claude Opus 5');
    const sol = await seedAgent('sol2', 'GPT-5.6 Sol');
    const editId = await seedHighRiskEdit(author.userId);
    await approve(opus.agentId, editId, { model: 'claude-opus-5' });
    await approve(sol.agentId, editId, { model: 'gpt-5.6-sol' });

    // The author, viewing its own queue (no review.queue.readAll as a plain
    // contributor): the row is visible (it's their own submission), but the
    // consensus explanation — and the peer approvers it would name — is not.
    getUserFromRequestMock.mockResolvedValue({
      userId: author.userId,
      role: 'contributor',
    });
    const { res: authorRes, state: authorState } = createResponse();
    await pendingEditsHandler(getPendingEditsRequest(), authorRes);
    expect(authorState.statusCode).toBe(200);
    const authorBody = JSON.parse(authorState.body) as {
      pendingEdits: Array<{ id: number; consensusStatus?: unknown }>;
    };
    const authorRow = authorBody.pendingEdits.find((e) => e.id === editId);
    expect(authorRow).toBeDefined();
    expect(authorRow?.consensusStatus).toBeUndefined();

    // A reviewer sees the same row's consensus explanation as before.
    getUserFromRequestMock.mockResolvedValue({ userId: 0, role: 'admin' });
    const { res: adminRes, state: adminState } = createResponse();
    await pendingEditsHandler(getPendingEditsRequest(), adminRes);
    const adminBody = JSON.parse(adminState.body) as {
      pendingEdits: Array<{ id: number; consensusStatus?: unknown }>;
    };
    expect(
      adminBody.pendingEdits.find((e) => e.id === editId)?.consensusStatus,
    ).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
      unrankedFlagshipApprovers: expect.arrayContaining([
        'Claude Opus 5',
        'GPT-5.6 Sol',
      ]),
    });
  });

  it('does attach consensusStatus for a self-review-enabled agent viewing its own submission', async () => {
    const author = await seedAgent('author3', 'author3', {
      selfReviewEnabled: true,
    });
    const opus = await seedAgent('opus3', 'Claude Opus 5');
    const sol = await seedAgent('sol3', 'GPT-5.6 Sol');
    const editId = await seedHighRiskEdit(author.userId);
    await approve(opus.agentId, editId, { model: 'claude-opus-5' });
    await approve(sol.agentId, editId, { model: 'gpt-5.6-sol' });

    getUserFromRequestMock.mockResolvedValue({
      userId: author.userId,
      role: 'contributor',
    });
    const { res, state } = createResponse();
    await pendingEditsHandler(getPendingEditsRequest(), res);
    const body = JSON.parse(state.body) as {
      pendingEdits: Array<{ id: number; consensusStatus?: unknown }>;
    };
    expect(
      body.pendingEdits.find((e) => e.id === editId)?.consensusStatus,
    ).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
      unrankedFlagshipApprovers: expect.arrayContaining([
        'Claude Opus 5',
        'GPT-5.6 Sol',
      ]),
    });
  });
});
