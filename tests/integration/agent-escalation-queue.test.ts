/**
 * The escalation feed's per-trigger SQL (a correlated `exists()` subquery via
 * `alias()`, and a `selectDistinctOn` over verification_log) is exactly the
 * kind of raw fragment the mocked unit suite never executes — see the same
 * rationale in agent-verification-queue-submitters.test.ts. Runs against real
 * Postgres (PGlite) rather than a mocked db client.
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
  citations,
  disputes,
  wikiPages,
  wikiRevisions,
  drugParameterRevisions,
  drugs,
  parameterPriorityFlags,
  pendingEdits,
  verificationLog,
} from '../../db/schema.js';
import handler, {
  CONFLICTED_CITATION_SCAN_CAP,
  DISPUTE_SCAN_CAP,
  FLAG_REVISION_SCAN_CAP,
} from '../../api/agent-escalation-queue.js';
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

async function seedPendingParameterEdit(
  drugId: number,
  parameter: string,
  submittedBy: number,
  status: 'pending' | 'rejected' | 'returned' = 'pending',
): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'parameter',
      targetId: drugId,
      parameter,
      proposedValue: { median: 1 },
      submittedBy,
      status,
      reviewedAt: status === 'pending' ? null : new Date(),
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

async function callFeed(callerUserId: number, url = '/api/agent-escalation-queue') {
  getUserFromRequestMock.mockResolvedValue({ userId: callerUserId, role: 'contributor' });
  const req = { method: 'GET', url, headers: { host: 'localhost' } } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
}

describe('agent escalation queue — open dispute trigger', () => {
  it('surfaces a pending edit under an open dispute, not one whose dispute is resolved', async () => {
    const submitterId = await seedUser(db, { email: 'submitter@example.com', username: 'submitter' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier',
      role: 'contributor',
    });
    const disputerUserId = await seedUser(db, { email: 'disputer@example.com', username: 'disputer' });
    await seedAgent(verifierUserId, 'verifier-agent');
    const drugId = await seedDrug(db, { slug: 'escalation-drug-1' });

    const disputedEditId = await seedPendingParameterEdit(drugId, 'clearance', submitterId);
    const resolvedDisputeEditId = await seedPendingParameterEdit(drugId, 'volumeOfDistribution', submitterId);

    await db.insert(disputes).values([
      {
        targetType: 'pending_edit',
        targetId: disputedEditId,
        createdBy: disputerUserId,
        source: 'human',
        reasonMd: 'This median looks wrong for the cited population.',
        status: 'open',
      },
      {
        targetType: 'pending_edit',
        targetId: resolvedDisputeEditId,
        createdBy: disputerUserId,
        source: 'human',
        reasonMd: 'Already resolved contestation.',
        status: 'resolved',
        resolution: 'rejected',
        resolvedBy: disputerUserId,
        resolvedAt: new Date(),
      },
    ]);

    const { status, body } = await callFeed(verifierUserId);
    expect(status).toBe(200);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(disputedEditId);
    expect(ids).not.toContain(resolvedDisputeEditId);

    const disputedItem = body.items.find((i: { targetId: number }) => i.targetId === disputedEditId);
    expect(disputedItem.reasonCodes).toEqual(['open_dispute']);
    // Identifier-only: the dispute's rationale must never appear in the response.
    expect(body.items.every((i: Record<string, unknown>) => !('reasonMd' in i)));
    expect(JSON.stringify(body)).not.toContain('cited population');
  });

  it('never hands the caller a target it authored or already verified', async () => {
    const authorUserId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    await seedAgent(authorUserId, 'author-agent');
    const disputerUserId = await seedUser(db, { email: 'disputer2@example.com', username: 'disputer2' });
    const drugId = await seedDrug(db, { slug: 'escalation-drug-2' });

    const ownEditId = await seedPendingParameterEdit(drugId, 'clearance', authorUserId);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: ownEditId,
      createdBy: disputerUserId,
      source: 'human',
      reasonMd: 'Disputing the author’s own submission.',
      status: 'open',
    });

    const { status, body } = await callFeed(authorUserId);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('excludes a disputed target this agent already verified, even though the dispute stays open', async () => {
    const submitterId = await seedUser(db, { email: 'submitter6@example.com', username: 'submitter6' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier6@example.com',
      username: 'verifier6',
      role: 'contributor',
    });
    const disputerUserId = await seedUser(db, { email: 'disputer6@example.com', username: 'disputer6' });
    const verifierAgentId = await seedAgent(verifierUserId, 'verifier-agent-6');
    const drugId = await seedDrug(db, { slug: 'already-verified-drug' });

    const editId = await seedPendingParameterEdit(drugId, 'clearance', submitterId);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: editId,
      createdBy: disputerUserId,
      source: 'human',
      reasonMd: 'Still open — a moderator has not resolved it.',
      status: 'open',
    });
    await db.insert(agentVerifications).values({
      agentId: verifierAgentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'approve',
      rationaleMd: 'Already reviewed this in a prior cycle.',
      evidenceRefs: [],
      isImplicit: false,
    });

    const { body } = await callFeed(verifierUserId);
    expect(body.items.map((i: { targetId: number }) => i.targetId)).not.toContain(editId);
  });

  it('does not let already-verified open disputes fill the scan cap and starve a newer eligible one', async () => {
    const submitterId = await seedUser(db, { email: 'submitter7@example.com', username: 'submitter7' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier7@example.com',
      username: 'verifier7',
      role: 'contributor',
    });
    const disputerUserId = await seedUser(db, { email: 'disputer7@example.com', username: 'disputer7' });
    const verifierAgentId = await seedAgent(verifierUserId, 'verifier-agent-7');

    // DISPUTE_SCAN_CAP disputed targets this agent already verified — before
    // the fix, an unordered `LIMIT DISPUTE_SCAN_CAP` with no eligibility
    // predicate let these fill every slot on every call, since the dispute
    // itself never closes just because one agent judged it.
    const drugRows = await db
      .insert(drugs)
      .values(
        Array.from({ length: DISPUTE_SCAN_CAP }, (_, i) => ({
          slug: `scan-cap-noise-drug-${i}`,
          names: { nb: `Testmiddel ${i}`, en: `Test drug ${i}` },
        })),
      )
      .returning({ id: drugs.id });
    const editRows = await db
      .insert(pendingEdits)
      .values(
        drugRows.map((d) => ({
          editType: 'parameter' as const,
          targetId: d.id,
          parameter: 'clearance',
          proposedValue: { median: 1 },
          submittedBy: submitterId,
          status: 'pending' as const,
        })),
      )
      .returning({ id: pendingEdits.id });
    await db.insert(disputes).values(
      editRows.map((e) => ({
        targetType: 'pending_edit' as const,
        targetId: e.id,
        createdBy: disputerUserId,
        source: 'human' as const,
        reasonMd: 'Noise dispute for the scan-cap regression test.',
        status: 'open' as const,
      })),
    );
    await db.insert(agentVerifications).values(
      editRows.map((e) => ({
        agentId: verifierAgentId,
        targetType: 'pending_edit' as const,
        targetId: e.id,
        verdict: 'approve' as const,
        rationaleMd: 'Noise verification for the scan-cap regression test.',
        evidenceRefs: [],
        isImplicit: false,
      })),
    );

    // One more disputed target this agent has NOT verified.
    const freshDrugId = await seedDrug(db, { slug: 'scan-cap-fresh-drug' });
    const freshEditId = await seedPendingParameterEdit(freshDrugId, 'clearance', submitterId);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: freshEditId,
      createdBy: disputerUserId,
      source: 'human',
      reasonMd: 'The one eligible dispute among the noise.',
      status: 'open',
    });

    const { body } = await callFeed(verifierUserId, '/api/agent-escalation-queue?limit=5');
    expect(body.items.map((i: { targetId: number }) => i.targetId)).toContain(freshEditId);
  });
});

describe('agent escalation queue — admin flag trigger', () => {
  it('escalates a pending edit under a whole-drug flag and one under a parameter-scoped flag, not an unflagged one', async () => {
    const submitterId = await seedUser(db, { email: 'submitter3@example.com', username: 'submitter3' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier3@example.com',
      username: 'verifier3',
      role: 'contributor',
    });
    const flaggerId = await seedUser(db, { email: 'flagger@example.com', username: 'flagger' });
    await seedAgent(verifierUserId, 'verifier-agent-3');

    const wholeDrugId = await seedDrug(db, { slug: 'whole-drug-flag' });
    const scopedDrugId = await seedDrug(db, { slug: 'scoped-drug-flag' });
    const unflaggedDrugId = await seedDrug(db, { slug: 'unflagged-drug' });

    await db.insert(parameterPriorityFlags).values([
      { drugId: wholeDrugId, parameter: null, status: 'active', flaggedBy: flaggerId },
      { drugId: scopedDrugId, parameter: 'clearance', status: 'active', flaggedBy: flaggerId },
    ]);

    const wholeDrugEditId = await seedPendingParameterEdit(wholeDrugId, 'halfLife', submitterId);
    const scopedMatchEditId = await seedPendingParameterEdit(scopedDrugId, 'clearance', submitterId);
    const scopedMismatchEditId = await seedPendingParameterEdit(scopedDrugId, 'halfLife', submitterId);
    const unflaggedEditId = await seedPendingParameterEdit(unflaggedDrugId, 'clearance', submitterId);

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);

    expect(ids).toContain(wholeDrugEditId);
    expect(ids).toContain(scopedMatchEditId);
    expect(ids).not.toContain(scopedMismatchEditId);
    expect(ids).not.toContain(unflaggedEditId);

    const scopedItem = body.items.find((i: { targetId: number }) => i.targetId === scopedMatchEditId);
    expect(scopedItem.reasonCodes).toEqual(['admin_flag']);
  });
});

describe('agent escalation queue — reviewer rejection history trigger', () => {
  it('escalates a resubmission after a prior rejection, not a first-time submission', async () => {
    const submitterId = await seedUser(db, { email: 'submitter4@example.com', username: 'submitter4' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier4@example.com',
      username: 'verifier4',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-4');

    const resubmittedDrugId = await seedDrug(db, { slug: 'resubmitted-drug' });
    const freshDrugId = await seedDrug(db, { slug: 'fresh-drug' });

    await seedPendingParameterEdit(resubmittedDrugId, 'clearance', submitterId, 'rejected');
    const resubmittedEditId = await seedPendingParameterEdit(resubmittedDrugId, 'clearance', submitterId, 'pending');
    const freshEditId = await seedPendingParameterEdit(freshDrugId, 'clearance', submitterId, 'pending');

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);

    expect(ids).toContain(resubmittedEditId);
    expect(ids).not.toContain(freshEditId);
    const item = body.items.find((i: { targetId: number }) => i.targetId === resubmittedEditId);
    expect(item.reasonCodes).toEqual(['reviewer_rejection_history']);
  });

  it('does not label a proposal a resubmission of a rejection that came after it was submitted', async () => {
    const submitterId = await seedUser(db, { email: 'submitter4a@example.com', username: 'submitter4a' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier4a@example.com',
      username: 'verifier4a',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-4a');
    const drugId = await seedDrug(db, { slug: 'predates-rejection-drug' });

    // Submitted first, still pending — not a reaction to the sibling below,
    // which was submitted after it and rejected later still.
    const earlyEditId = (
      await db
        .insert(pendingEdits)
        .values({
          editType: 'parameter',
          targetId: drugId,
          parameter: 'clearance',
          proposedValue: { median: 1 },
          submittedBy: submitterId,
          status: 'pending',
          submittedAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: pendingEdits.id })
    )[0]!.id;

    await db.insert(pendingEdits).values({
      editType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      proposedValue: { median: 2 },
      submittedBy: submitterId,
      status: 'rejected',
      submittedAt: new Date(Date.now() - 30_000),
      reviewedAt: new Date(),
    });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).not.toContain(earlyEditId);
  });

  it('does not surface rejection history for a param_entry create sharing identity with a sibling create', async () => {
    const submitterId = await seedUser(db, { email: 'submitter4b@example.com', username: 'submitter4b' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier4b@example.com',
      username: 'verifier4b',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-4b');
    const drugId = await seedDrug(db, { slug: 'concurrent-create-drug' });

    // Two independent, concurrently-allowed creates on the same (drug,
    // parameter) — not resubmissions of each other. Submitted after the
    // sibling's rejection, so the timing guard alone would not exclude it;
    // only the create-op exclusion does.
    const pendingCreateId = (
      await db
        .insert(pendingEdits)
        .values({
          editType: 'param_entry',
          targetId: drugId,
          parameter: 'clearance',
          proposedValue: { op: 'create', low: 1, high: 2, unit: 'L/h' },
          submittedBy: submitterId,
          status: 'pending',
          submittedAt: new Date(),
        })
        .returning({ id: pendingEdits.id })
    )[0]!.id;

    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: 'clearance',
      proposedValue: { op: 'create', low: 3, high: 4, unit: 'L/h' },
      submittedBy: submitterId,
      status: 'rejected',
      submittedAt: new Date(Date.now() - 60_000),
      reviewedAt: new Date(Date.now() - 30_000),
    });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).not.toContain(pendingCreateId);
  });
});

describe('agent escalation queue — concordance gap trigger', () => {
  it('classifies the latest verification_log outcome as absent or weak, and lets a later strong result clear it', async () => {
    const submitterId = await seedUser(db, { email: 'submitter5@example.com', username: 'submitter5' });
    const verifierUserId = await seedUser(db, {
      email: 'verifier5@example.com',
      username: 'verifier5',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-5');

    const absentDrugId = await seedDrug(db, { slug: 'absent-concordance-drug' });
    const weakDrugId = await seedDrug(db, { slug: 'weak-concordance-drug' });
    const clearedDrugId = await seedDrug(db, { slug: 'cleared-concordance-drug' });

    await db.insert(verificationLog).values([
      { targetType: 'parameter', targetId: absentDrugId, parameter: 'clearance', concordance: 'absent', outcome: 'no_change' },
      { targetType: 'parameter', targetId: weakDrugId, parameter: 'clearance', concordance: 'weak', outcome: 'no_change' },
      // Older 'absent' superseded by a newer 'strong' — must not escalate.
      {
        targetType: 'parameter',
        targetId: clearedDrugId,
        parameter: 'clearance',
        concordance: 'absent',
        outcome: 'no_change',
        verifiedAt: new Date(Date.now() - 60_000),
      },
      { targetType: 'parameter', targetId: clearedDrugId, parameter: 'clearance', concordance: 'strong', outcome: 'no_change' },
    ]);

    const absentEditId = await seedPendingParameterEdit(absentDrugId, 'clearance', submitterId);
    const weakEditId = await seedPendingParameterEdit(weakDrugId, 'clearance', submitterId);
    const clearedEditId = await seedPendingParameterEdit(clearedDrugId, 'clearance', submitterId);

    const { body } = await callFeed(verifierUserId);
    const byId = new Map(body.items.map((i: { targetId: number; reasonCodes: string[] }) => [i.targetId, i.reasonCodes]));

    expect(byId.get(absentEditId)).toEqual(['absent_concordance']);
    expect(byId.get(weakEditId)).toEqual(['weak_concordance']);
    expect(byId.has(clearedEditId)).toBe(false);
  });
});

describe('agent escalation queue — auth gating', () => {
  it('rejects a non-agent caller', async () => {
    const userId = await seedUser(db, { email: 'plain@example.com', username: 'plain' });
    const { status } = await callFeed(userId);
    expect(status).toBe(403);
  });

  it('rejects an unauthenticated caller', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const req = {
      method: 'GET',
      url: '/api/agent-escalation-queue',
      headers: { host: 'localhost' },
    } as IncomingMessage;
    const { res, state } = createResponse();
    await handler(req, res);
    expect(state.statusCode).toBe(401);
  });
});

describe('agent escalation queue — citation identifier inconsistency trigger', () => {
  async function seedConflictedCitation(suffix: string): Promise<number> {
    const [row] = await db
      .insert(citations)
      .values({
        type: 'doi',
        identifier: `10.1000/conflicted-${suffix}`,
        // A 'conflicted' row needs >= 2 handles whose registries disagree on
        // `kind` (DB check constraint `citations_work_kind_evidence`).
        metadata: { altIds: [`pmid:2450027${suffix}`] },
        workKind: null,
        workKindStatus: 'conflicted',
        workKindHandles: [`doi:10.1000/conflicted-${suffix}`, `pmid:2450027${suffix}`],
        workKindVerdicts: [
          { handle: `doi:10.1000/conflicted-${suffix}`, kind: 'dataset' },
          { handle: `pmid:2450027${suffix}`, kind: 'journal_article' },
        ],
        workKindResolvedAt: new Date(),
      })
      .returning({ id: citations.id });
    return row!.id;
  }

  it('escalates a revision citing a conflicted work-kind, through the array and the legacy singular id alike', async () => {
    const authorId = await seedUser(db, { email: 'cite-author@example.com', username: 'cite-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite-verifier@example.com',
      username: 'cite-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite');
    const drugId = await seedDrug(db, { slug: 'cite-drug' });
    const conflictedId = await seedConflictedCitation('1');
    const [cleanCitation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/clean' })
      .returning({ id: citations.id });

    const revision = (over: Record<string, unknown>) => ({
      drugId,
      parameter: 'clearance',
      oldValue: null,
      newValue: { median: 1 },
      createdBy: authorId,
      ...over,
    });
    const [viaArray] = await db
      .insert(drugParameterRevisions)
      .values(revision({ referenceIds: [conflictedId] }))
      .returning({ id: drugParameterRevisions.id });
    // The legacy shape: an EMPTY array beside a populated singular id. A
    // match on the array alone silently misses exactly these rows.
    const [viaLegacyId] = await db
      .insert(drugParameterRevisions)
      .values(revision({ referenceId: conflictedId, referenceIds: [] }))
      .returning({ id: drugParameterRevisions.id });
    const [uncited] = await db
      .insert(drugParameterRevisions)
      .values(revision({ referenceId: cleanCitation!.id }))
      .returning({ id: drugParameterRevisions.id });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(viaArray!.id);
    expect(ids).toContain(viaLegacyId!.id);
    expect(ids).not.toContain(uncited!.id);
    const item = body.items.find((i: { targetId: number }) => i.targetId === viaArray!.id);
    expect(item.reasonCodes).toEqual(['citation_identifier_inconsistency']);
  });
  it('does not let target-less conflicted citations crowd out one that has a target', async () => {
    const authorId = await seedUser(db, { email: 'cite3-author@example.com', username: 'cite3-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite3-verifier@example.com',
      username: 'cite3-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite3');
    const drugId = await seedDrug(db, { slug: 'cite3-drug' });

    // Seeded FIRST, so it is the oldest conflicted citation — the one a
    // newest-first citation scan would drop once the cap fills.
    const citedId = await seedConflictedCitation('3');
    const [rev] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId,
        parameter: 'clearance',
        oldValue: null,
        newValue: { median: 1 },
        referenceId: citedId,
        createdBy: authorId,
      })
      .returning({ id: drugParameterRevisions.id });

    // More conflicted citations than the scan would hold, none of them cited
    // by anything: pure noise that must not occupy the escalation's slots.
    await db.insert(citations).values(
      Array.from({ length: CONFLICTED_CITATION_SCAN_CAP }, (_, i) => ({
        type: 'doi',
        identifier: `10.1000/noise-${i}`,
        metadata: { altIds: [`pmid:9${String(i).padStart(6, '0')}`] },
        workKind: null,
        workKindStatus: 'conflicted',
        workKindHandles: [`doi:10.1000/noise-${i}`, `pmid:9${String(i).padStart(6, '0')}`],
        workKindVerdicts: [
          { handle: `doi:10.1000/noise-${i}`, kind: 'dataset' },
          { handle: `pmid:9${String(i).padStart(6, '0')}`, kind: 'journal_article' },
        ],
        workKindResolvedAt: new Date(),
      })),
    );

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(rev!.id);
  });

  it('finds a conflicted citation embedded in wiki JSON, on a proposal and a revision', async () => {
    const authorId = await seedUser(db, { email: 'cite4-author@example.com', username: 'cite4-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite4-verifier@example.com',
      username: 'cite4-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite4');
    const conflictedId = await seedConflictedCitation('4');

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'cite4-page',
        title: 'Cite4',
        status: 'published',
        createdBy: authorId,
        updatedBy: authorId,
      })
      .returning({ id: wikiPages.id });

    // The citation is nested in TipTap content, with no top-level
    // reference_ids on the row at all.
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Påstand' }],
          attrs: { referenceIds: [conflictedId] },
        },
      ],
    };
    const [pageEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_page',
        targetId: page!.id,
        proposedValue: content,
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    const [revision] = await db
      .insert(wikiRevisions)
      .values({ pageId: page!.id, content, createdBy: authorId })
      .returning({ id: wikiRevisions.id });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(pageEdit!.id);
    expect(ids).toContain(revision!.id);
  });

  it('does not let draft-page revisions fill the scan ahead of a published one', async () => {
    const authorId = await seedUser(db, { email: 'cite7-author@example.com', username: 'cite7-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite7-verifier@example.com',
      username: 'cite7-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite7');
    const conflictedId = await seedConflictedCitation('7');
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Påstand' }],
          attrs: { referenceIds: [conflictedId] },
        },
      ],
    };

    const [draft] = await db
      .insert(wikiPages)
      .values({
        slug: 'cite7-draft',
        title: 'Cite7 draft',
        status: 'draft',
        createdBy: authorId,
        updatedBy: authorId,
      })
      .returning({ id: wikiPages.id });
    const [published] = await db
      .insert(wikiPages)
      .values({
        slug: 'cite7-published',
        title: 'Cite7 published',
        status: 'published',
        createdBy: authorId,
        updatedBy: authorId,
      })
      .returning({ id: wikiPages.id });

    // Draft-page revisions first, so an oldest-first scan that caps before
    // the published-page check fills itself with rows that check then drops.
    await db.insert(wikiRevisions).values(
      Array.from({ length: CONFLICTED_CITATION_SCAN_CAP }, () => ({
        pageId: draft!.id,
        content,
        createdBy: authorId,
      })),
    );
    const [visible] = await db
      .insert(wikiRevisions)
      .values({ pageId: published!.id, content, createdBy: authorId })
      .returning({ id: wikiRevisions.id });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(visible!.id);
  });

  it('ignores a stale singular reference_id when the array is authoritative', async () => {
    const authorId = await seedUser(db, { email: 'cite5-author@example.com', username: 'cite5-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite5-verifier@example.com',
      username: 'cite5-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite5');
    const drugId = await seedDrug(db, { slug: 'cite5-drug' });
    const conflictedId = await seedConflictedCitation('5');
    const [clean] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/cite5-clean' })
      .returning({ id: citations.id });

    // A non-empty reference_ids is authoritative; the singular id beside it
    // is stale and the hydrated payload will not show it, so escalating on
    // it would hand T2 a reason with nothing to inspect.
    const [stale] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId,
        parameter: 'clearance',
        oldValue: null,
        newValue: { median: 1 },
        referenceId: conflictedId,
        referenceIds: [clean!.id],
        createdBy: authorId,
      })
      .returning({ id: drugParameterRevisions.id });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).not.toContain(stale!.id);
  });

  it('does not let hidden wiki proposals fill the scan ahead of an eligible target', async () => {
    const authorId = await seedUser(db, { email: 'cite6-author@example.com', username: 'cite6-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite6-verifier@example.com',
      username: 'cite6-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite6');
    const drugId = await seedDrug(db, { slug: 'cite6-drug' });
    const conflictedId = await seedConflictedCitation('6');

    // `wiki_new` proposals are never visible to a verifying agent. Seeded
    // FIRST so an oldest-first scan that caps before the visibility gate
    // fills itself entirely with rows that gate then drops.
    await db.insert(pendingEdits).values(
      Array.from({ length: CONFLICTED_CITATION_SCAN_CAP }, (_, i) => ({
        editType: 'wiki_new',
        targetId: null,
        proposedValue: { title: `Utkast ${i}` },
        referenceIds: [conflictedId],
        submittedBy: authorId,
        status: 'pending' as const,
      })),
    );
    const [eligible] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'clearance',
        proposedValue: { median: 1 },
        referenceIds: [conflictedId],
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(eligible!.id);
  });

  it('covers citation-bearing targets beyond parameter edits', async () => {
    const authorId = await seedUser(db, { email: 'cite2-author@example.com', username: 'cite2-author' });
    const verifierUserId = await seedUser(db, {
      email: 'cite2-verifier@example.com',
      username: 'cite2-verifier',
      role: 'contributor',
    });
    await seedAgent(verifierUserId, 'verifier-agent-cite2');
    const conflictedId = await seedConflictedCitation('2');

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'cite2-page',
        title: 'Cite2',
        status: 'published',
        createdBy: authorId,
        updatedBy: authorId,
      })
      .returning({ id: wikiPages.id });

    // A wiki_fact proposal citing the contested reference — a provenance
    // conflict outside the parameter universe.
    const [factEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Noe som siterer den omstridte kilden.',
        proposedValue: { factStatement: 'Noe som siterer den omstridte kilden.' },
        referenceIds: [conflictedId],
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    // A paper_review proposal whose targetId IS that citation.
    const [reviewEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'paper_review',
        targetId: conflictedId,
        proposedValue: { summary: 'Gjennomgang' },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(factEdit!.id);
    expect(ids).toContain(reviewEdit!.id);
  });
});

describe('agent escalation queue — parameter identity under the scan caps', () => {
  it('keeps a flagged parameter\'s revision when the drug\'s other parameters flood the scan', async () => {
    const authorId = await seedUser(db, { email: 'flood-author@example.com', username: 'flood-author' });
    const verifierUserId = await seedUser(db, {
      email: 'flood-verifier@example.com',
      username: 'flood-verifier',
      role: 'contributor',
    });
    const flaggerId = await seedUser(db, { email: 'flood-flagger@example.com', username: 'flood-flagger' });
    await seedAgent(verifierUserId, 'verifier-agent-flood');
    const drugId = await seedDrug(db, { slug: 'flood-drug' });

    // The flag names ONE parameter on this drug.
    await db.insert(parameterPriorityFlags).values({
      drugId,
      parameter: 'clearance',
      status: 'active',
      flaggedBy: flaggerId,
    });

    const [flagged] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId,
        parameter: 'clearance',
        oldValue: null,
        newValue: { median: 1 },
        createdBy: authorId,
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      })
      .returning({ id: drugParameterRevisions.id });
    // More revisions of ANOTHER parameter on the same drug than the scan cap
    // holds, all newer. A drug-only filter would spend the whole cap here.
    await db.insert(drugParameterRevisions).values(
      Array.from({ length: FLAG_REVISION_SCAN_CAP + 1 }, (_, i) => ({
        drugId,
        parameter: 'halfLife',
        oldValue: null,
        newValue: { median: i + 1 },
        createdBy: authorId,
        createdAt: new Date(Date.UTC(2026, 5, 1, 0, i)),
      })),
    );

    const { body } = await callFeed(verifierUserId);
    const ids = body.items.map((i: { targetId: number }) => i.targetId);
    expect(ids).toContain(flagged!.id);
  });
});
