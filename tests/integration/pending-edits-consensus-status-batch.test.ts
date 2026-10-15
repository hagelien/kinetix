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

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import handler, {
  agentConsensusStatus,
  consensusExplanation,
  consensusStatusForTargets,
  persistConsensusApplyFailure,
} from '../../api/agent-verifications.js';
import pendingEditsHandler from '../../api/pending-edits.js';
import { listVerifications } from '../../api/_lib/agent-verifications.js';
import { setDbForTesting } from '../../api/_lib/db.js';
import { pendingEditReviewToken } from '../../api/_lib/pending-edit-review-token.js';
import * as schema from '../../db/schema.js';
import {
  agentVerifications,
  agents,
  citations,
  disputes,
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

async function seedAgent(
  slug: string,
  name = slug,
  opts: { selfReviewEnabled?: boolean; status?: string } = {},
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
      status: opts.status ?? 'active',
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

// ──────────────────────────────────────────────────────────────────────────
// Issue #33: the batched status is a read-only sibling of the real gate.
//
// `consensusStatusForTargets` used to call `agentConsensusStatus` once per
// row, so a 100-card queue ran every gate's queries 100 times. It now reads
// each gate input once for the whole page and evaluates the gates in memory
// (`agentConsensusStatusForTargets` → `consensusStatusFromFacts`). The real
// gate (`legacyConsensusHold`) still decides every publication; these pin the
// batch to it, case by case, against real SQL — and pin that the number of
// queries no longer grows with the page.
// ──────────────────────────────────────────────────────────────────────────

/** What the single-target endpoint (the real gate) reports for each id. */
async function realGate(ids: number[]) {
  const out = new Map<number, unknown>();
  for (const id of ids) {
    const rows = await listVerifications({ targetType: 'pending_edit', targetId: id });
    out.set(id, await consensusExplanation(id, rows));
  }
  return out;
}

async function seedPage(status: 'published' | 'draft', by: number, slug: string) {
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug,
      title: slug,
      pageType: 'drug_monograph',
      content: { version: 2, sections: { pk: { body: { type: 'doc', content: [] } } } },
      status,
      createdBy: by,
      updatedBy: by,
    })
    .returning({ id: wikiPages.id });
  return page!.id;
}

async function seedWikiFact(
  pageId: number,
  submittedBy: number,
  over: Partial<typeof pendingEdits.$inferInsert> = {},
) {
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: pageId,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 20–100 timer.',
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f-1', referenceIds: [] },
        content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
      },
      submittedBy,
      status: 'pending',
      ...over,
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

/** Count every statement `fn` sends, through a logging client on the same database. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const counting = drizzle({
    client: db.$client,
    schema,
    logger: { logQuery: () => void (count += 1) },
  });
  setDbForTesting(counting);
  try {
    await fn();
  } finally {
    setDbForTesting(db);
  }
  return count;
}

describe('batched read-only consensus status agrees with the real gate (issue #33)', () => {
  it('reports what agentConsensusStatus reports, for every kind of hold', async () => {
    const author = await seedAgent('author');
    const selfie = await seedAgent('selfie', 'selfie', { selfReviewEnabled: true });
    const b = await seedAgent('b', 'Claude Opus 5');
    const c = await seedAgent('c', 'GPT-5.6 Sol');
    const flag = await seedAgent('flag');
    const suspended = await seedAgent('suspended', 'suspended', { status: 'suspended' });
    const person = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'contributor',
    });
    const published = await seedPage('published', person, 'diazepam');
    const draft = await seedPage('draft', person, 'utkast');
    const both = async (id: number) => {
      await approve(b.agentId, id, { model: 'claude-opus-5' });
      await approve(c.agentId, id, { model: 'gpt-5.6-sol' });
    };

    const expected = new Map<number, unknown>();
    const ready = { ready: true };
    const held = (reason: string) => ({ ready: false, reason });

    // Consensus reached.
    const reached = await seedWikiFact(published, author.userId);
    await both(reached);
    expected.set(reached, ready);

    // Short of the quorum.
    const short = await seedWikiFact(published, author.userId);
    await approve(b.agentId, short);
    expected.set(short, held('quorum_unmet'));

    // The author's own approval does not count without the grant...
    const ownApproval = await seedWikiFact(published, author.userId);
    await approve(author.agentId, ownApproval);
    await approve(b.agentId, ownApproval);
    expected.set(ownApproval, held('quorum_unmet'));

    // ...and does with it.
    const selfReviewed = await seedWikiFact(published, selfie.userId);
    await approve(selfie.agentId, selfReviewed);
    await approve(b.agentId, selfReviewed);
    expected.set(selfReviewed, ready);

    // A suspended verifier's approval no longer carries standing.
    const suspendedApproval = await seedWikiFact(published, author.userId);
    await approve(b.agentId, suspendedApproval);
    await approve(suspended.agentId, suspendedApproval);
    expected.set(suspendedApproval, held('quorum_unmet'));

    // A person's proposal publishes under the same bar.
    const personal = await seedWikiFact(published, person);
    await both(personal);
    expected.set(personal, ready);

    // High risk: two mid-tier approvals hold; a flagship one clears it.
    const midTier = await seedHighRiskEdit(author.userId);
    await both(midTier);
    expected.set(midTier, {
      ...held('high_risk_missing_flagship'),
      unrankedFlagshipApprovers: expect.arrayContaining(['Claude Opus 5', 'GPT-5.6 Sol']),
    });
    const flagship = await seedHighRiskEdit(author.userId);
    await approve(flag.agentId, flagship, { tier: 'flagship' });
    await approve(b.agentId, flagship);
    expected.set(flagship, ready);

    // An agent's dispute verdict holds on the tally...
    const agentDisputed = await seedWikiFact(published, author.userId);
    await both(agentDisputed);
    await dispute(flag.agentId, agentDisputed);
    expected.set(agentDisputed, held('quorum_unmet'));

    // ...until a ruling answers it.
    const overruled = await seedWikiFact(published, author.userId);
    await both(overruled);
    await dispute(flag.agentId, overruled);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: overruled,
      createdBy: flag.userId,
      source: 'agent',
      reasonMd: 'Kilden oppgir en annen verdi.',
      status: 'resolved',
      resolution: 'rejected',
      resolvedAt: new Date(Date.now() + 60_000),
    });
    expected.set(overruled, ready);

    // A person's open dispute.
    const humanDisputed = await seedWikiFact(published, author.userId);
    await both(humanDisputed);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: humanDisputed,
      createdBy: person,
      reasonMd: 'Verdien stemmer ikke med kilden.',
    });
    expected.set(humanDisputed, held('open_dispute'));

    // An upheld ruling against the unrevised payload.
    const upheld = await seedWikiFact(published, author.userId);
    await both(upheld);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: upheld,
      createdBy: person,
      reasonMd: 'Verdien stemmer ikke med kilden.',
      status: 'resolved',
      resolution: 'upheld',
      resolvedAt: new Date(),
    });
    expected.set(upheld, held('upheld_dispute'));

    // A comment-only return nobody has revised since.
    const returned = await seedWikiFact(published, author.userId, {
      proposedMeta: { returnedAt: '2026-10-06T10:00:00.000Z' },
    });
    await both(returned);
    expected.set(returned, held('returned_unrevised'));

    // Legacy hold: a clinical case. (The other, a proposal with no recorded
    // author, cannot be stored — `submitted_by` is NOT NULL — and is pinned
    // in tests/governance/policy/apply-gate-parity.test.ts instead.)
    const clinical = await seedHighRiskEdit(author.userId);
    await db
      .update(pendingEdits)
      .set({ editType: 'clinical_case' })
      .where(eq(pendingEdits.id, clinical));
    await both(clinical);
    expected.set(clinical, held('clinical_case'));

    // A page moved back to draft.
    const onDraft = await seedWikiFact(draft, author.userId);
    await both(onDraft);
    expected.set(onDraft, held('target_unpublished'));

    // An ingested fact citing a paper nobody has read in full.
    const [paper] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '12345678' })
      .returning({ id: citations.id });
    const unread = await seedWikiFact(published, person, {
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f-1', referenceIds: [paper!.id] },
        content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
      },
      proposedMeta: {
        source: 'conversation_ingestion',
        unverifiedSourceKeys: ['S1'],
        unverifiedReferenceIds: [paper!.id],
      },
      referenceIds: [paper!.id],
      referenceId: paper!.id,
    });
    await both(unread);
    expected.set(unread, held('unverified_sources'));

    // A calculation-driving value with no source quote.
    const [unquotedRow] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: 1,
        parameter: 'volumeOfDistribution',
        proposedValue: { op: 'create', input: { value: 0.35 } },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    const unquoted = unquotedRow!.id;
    await both(unquoted);
    expected.set(unquoted, held('source_quote_missing'));

    // Every gate passes, but this exact version already failed to apply.
    const failed = await seedWikiFact(published, author.userId);
    await both(failed);
    const [failedRow] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, failed));
    await persistConsensusApplyFailure(
      failed,
      pendingEditReviewToken(failedRow as never),
      'parameter collision',
    );
    expected.set(failed, held('apply_failed'));

    // No longer pending, and no such edit.
    const decided = await seedWikiFact(published, author.userId, { status: 'approved' });
    expected.set(decided, held('not_pending'));
    expected.set(999_999, held('not_found'));

    const ids = [...expected.keys()];
    const reference = await realGate(ids);
    const batched = await consensusStatusForTargets(ids);

    // Not vacuous: the real gate gives the reason each case was built for...
    for (const [id, want] of expected) {
      expect({ id, status: reference.get(id) }).toEqual({ id, status: want });
    }
    // ...and the batch agrees with it on every one.
    expect(new Set(batched.keys())).toEqual(new Set(ids));
    for (const id of ids) {
      expect({ id, status: batched.get(id) }).toEqual({ id, status: reference.get(id) });
    }
  });

  it('agrees on a pool too small for the design quorum (insufficient verifiers)', async () => {
    // Two active agents: an agent author's edit can only ever get one
    // independent approval, so the quorum degrades to one — which carries an
    // ordinary edit but never a calculation-driving one.
    const author = await seedAgent('author');
    const flag = await seedAgent('flag');
    const person = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'contributor',
    });
    const page = await seedPage('published', person, 'diazepam');
    const ordinary = await seedWikiFact(page, author.userId);
    await approve(flag.agentId, ordinary);
    const highRisk = await seedHighRiskEdit(author.userId);
    await approve(flag.agentId, highRisk, { tier: 'flagship' });
    const personal = await seedWikiFact(page, person);
    await approve(flag.agentId, personal);

    const ids = [ordinary, highRisk, personal];
    const reference = await realGate(ids);
    expect(reference.get(ordinary)).toEqual({ ready: true });
    expect(reference.get(highRisk)).toEqual({
      ready: false,
      reason: 'high_risk_degraded_quorum',
    });
    // Both agents may verify a person's proposal: one approval is short.
    expect(reference.get(personal)).toEqual({ ready: false, reason: 'quorum_unmet' });
    expect(await consensusStatusForTargets(ids)).toEqual(reference);
  });

  it('issues the same number of queries for a page of 4 as for a page of 40', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const person = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'contributor',
    });
    const page = await seedPage('published', person, 'diazepam');
    const [paper] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '12345678' })
      .returning({ id: citations.id });

    // One of each shape that reaches a distinct read: a wiki fact (page
    // visibility), a high-risk entry create (answered from the payload — only
    // an entry UPDATE asks the store, once per proposal by design), an
    // ingested fact (source reviews), and a person's disputed proposal.
    const seedRound = async () => {
      const fact = await seedWikiFact(page, author.userId);
      const entry = await seedHighRiskEdit(author.userId);
      const ingested = await seedWikiFact(page, person, {
        proposedMeta: { unverifiedReferenceIds: [paper!.id] },
        referenceIds: [paper!.id],
      });
      const disputed = await seedWikiFact(page, person);
      await db.insert(disputes).values({
        targetType: 'pending_edit',
        targetId: disputed,
        createdBy: person,
        reasonMd: 'Verdien stemmer ikke med kilden.',
      });
      const round = [fact, entry, ingested, disputed];
      for (const id of round) {
        await approve(b.agentId, id);
        await approve(c.agentId, id);
      }
      return round;
    };
    const small = await seedRound();
    const large = [...small];
    for (let i = 0; i < 9; i += 1) large.push(...(await seedRound()));
    expect(large).toHaveLength(40);

    const smallCount = await countQueries(() => consensusStatusForTargets(small));
    const largeCount = await countQueries(() => consensusStatusForTargets(large));
    expect(smallCount).toBeGreaterThan(0);
    expect(largeCount).toBe(smallCount);

    // The per-row path it replaces grows with the page.
    const perRowSmall = await countQueries(() => realGate(small));
    const perRowLarge = await countQueries(() => realGate(large));
    expect(perRowLarge).toBeGreaterThan(perRowSmall * 5);
    expect(largeCount).toBeLessThan(perRowLarge / 10);

    // And the answers still agree.
    expect(await consensusStatusForTargets(large)).toEqual(await realGate(large));
  });
});
