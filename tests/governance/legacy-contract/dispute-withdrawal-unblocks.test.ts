/**
 * Phase 0 gap 2 (docs/plans/2026-08-26-general-knowledge-governance-
 * extraction.md): the "upheld" ruling's blocking effect is covered by
 * tests/api/disputes-upheld-ruling.test.ts and tests/api/pending-edits-
 * review-status.test.ts, but nothing shows the mirror image — that
 * WITHDRAWING an open dispute actually lifts whatever it was blocking.
 *
 * Chosen path: the self-decision block in api/pending-edits.ts's PATCH route
 * (`self_decision_blocked_by_dispute`, guarded by `selfReviewBlockedByDispute`
 * in api/pending-edits.ts, which reads `hasOpenDispute` from
 * api/_lib/disputes.ts). This is more directly testable against real route
 * code than the agent-consensus auto-apply direction
 * (`applyOnAgentConsensus`), which needs a multi-agent quorum to even reach
 * the dispute check — here a single admin submitter/reviewer is enough to
 * drive the whole real HTTP path twice (blocked, then unblocked) with one
 * fixture.
 *
 * The submitter is an admin so `review.edit.decideOwn` (default admin) grants
 * self-decision on its own terms — no agent self-review plumbing needed — and
 * the same admin also holds `dispute.resolve` to withdraw the dispute it did
 * not open, mirroring the "an admin who wants it gone resolves the dispute
 * first, as a separate and recorded act" comment on that guard.
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
import { eq } from 'drizzle-orm';
import { citations, pendingEdits } from '../../../db/schema.js';
import pendingEditsHandler from '../../../api/pending-edits.js';
import disputesHandler from '../../../api/disputes.js';
import { pendingEditReviewToken } from '../../../api/_lib/pending-edit-review-token.js';
import { verificationTargetVersion } from '../../../api/_lib/verification-targets.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

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

function jsonRequest(method: string, url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

async function seedFixture(): Promise<{
  adminId: number;
  disputerId: number;
  editId: number;
}> {
  // Author-and-decides-its-own-work admin (review.edit.decideOwn is
  // admin-default), plus a separate editor who raises the dispute — the
  // block/unblock has to be visible to someone other than the party it binds.
  const adminId = await seedUser(db, {
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
  });
  const disputerId = await seedUser(db, {
    email: 'disputer@example.com',
    username: 'disputer',
    role: 'editor',
  });
  const drugId = await seedDrug(db);
  const [citation] = await db
    .insert(citations)
    .values({ type: 'doi', identifier: '10.1/dispute-withdrawal', metadata: {} })
    .returning({ id: citations.id });
  const citationId = citation!.id;

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      referenceIds: [citationId],
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 20,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
      submittedBy: adminId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  return { adminId, disputerId, editId: edit!.id };
}

async function openDispute(args: {
  callerUserId: number;
  editId: number;
}): Promise<number> {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.callerUserId,
    role: 'editor',
  });
  const { res, state } = createResponse();
  await disputesHandler(
    jsonRequest('POST', '/api/disputes', {
      targetType: 'pending_edit',
      targetId: args.editId,
      targetVersion: await verificationTargetVersion({
        targetType: 'pending_edit',
        targetId: args.editId,
      }),
      reasonMd: 'Konsentrasjonsintervallet mangler en trykt kilde.',
    }),
    res,
  );
  expect(state.statusCode).toBe(201);
  return (JSON.parse(state.body) as { id: number }).id;
}

async function withdrawDispute(args: {
  callerUserId: number;
  disputeId: number;
}): Promise<void> {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.callerUserId,
    role: 'admin',
  });
  const { res, state } = createResponse();
  await disputesHandler(
    jsonRequest('PATCH', `/api/disputes?id=${args.disputeId}`, {
      resolution: 'withdrawn',
    }),
    res,
  );
  expect(state.statusCode).toBe(200);
  expect(JSON.parse(state.body)).toMatchObject({ resolution: 'withdrawn' });
}

async function attemptSelfApprove(args: {
  adminId: number;
  editId: number;
}) {
  const [edit] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, args.editId));
  getUserFromRequestMock.mockResolvedValue({
    userId: args.adminId,
    role: 'admin',
  });
  const { res, state } = createResponse();
  await pendingEditsHandler(
    jsonRequest('PATCH', `/api/pending-edits?id=${args.editId}`, {
      status: 'approved',
      reviewToken: pendingEditReviewToken(edit!),
    }),
    res,
  );
  return state;
}

describe('dispute withdrawal unblocks self-decision', () => {
  it('blocks self-approval while the dispute is open, then lifts the block on withdrawal', async () => {
    const { adminId, disputerId, editId } = await seedFixture();

    const disputeId = await openDispute({ callerUserId: disputerId, editId });

    const blocked = await attemptSelfApprove({ adminId, editId });
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.body)).toMatchObject({
      code: 'self_decision_blocked_by_dispute',
    });
    const [stillPending] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect(stillPending!.status).toBe('pending');

    await withdrawDispute({ callerUserId: adminId, disputeId });

    const unblocked = await attemptSelfApprove({ adminId, editId });
    expect(unblocked.statusCode).toBeLessThan(300);
    const [applied] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect(applied!.status).toBe('approved');
  });
});
