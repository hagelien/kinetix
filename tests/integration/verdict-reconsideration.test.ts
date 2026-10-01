/**
 * The control phase after a blind dispute (issue #1357), against real SQL.
 *
 * A dispute that stands against peer approvals is shown to its author with the
 * peers' rationales; the author maintains or withdraws it. The original blind
 * verdict is kept, a withdrawal never becomes an approval, and a withdrawal
 * that was the only hold lets the edit publish on the independent approvals.
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

import { and, eq } from 'drizzle-orm';
import {
  agentVerdictReconsiderations,
  agentVerifications,
  agents,
  disputes,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import reconsiderHandler from '../../api/agent-verifications/reconsider.js';
import * as verificationsRoute from '../../api/agent-verifications.js';
import verificationsHandler from '../../api/agent-verifications.js';
import pendingEditsHandler from '../../api/pending-edits.js';
import { verificationTargetVersion } from '../../api/_lib/verification-targets.js';
import { listReconsiderationCandidates } from '../../api/_lib/verdict-reconsideration.js';
import {
  PeersSeenError,
  recordVerification,
  restampPendingVerdictTiers,
} from '../../api/_lib/agent-verifications.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../api/_lib/knowledge-governance/migration-state.js';
import { mirrorAssessment } from '../../api/_lib/knowledge-governance/mirror.js';
import * as mirrorModule from '../../api/_lib/knowledge-governance/mirror.js';
import { kgProposals } from '../../db/schema.js';
import {
  currentAssessments,
  listVersions,
} from '../../api/_lib/knowledge-governance/store/postgres.js';
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
  invalidateMigrationStateCache();
});

const FACT = 'Den basiske amin-pKa er 8,17; kilden oppgir også pKa2 = 9,54.';
const BLIND_DISPUTE =
  'Forslaget presenterer 8,17 som om det var stoffets eneste pKa.';

async function seedAgent(slug: string) {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active' })
    .returning({ id: agents.id });
  return { userId, agentId: row!.id };
}

async function seedWikiFactEdit(authorUserId: number, slug = 'oksymorfon') {
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug,
      title: 'Oksymorfon',
      pageType: 'drug_monograph',
      content: {
        version: 2,
        sections: { pk: { body: { type: 'doc', content: [] } } },
      },
      status: 'published',
      createdBy: authorUserId,
      updatedBy: authorUserId,
    })
    .returning({ id: wikiPages.id });
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: FACT,
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f-1', referenceIds: [] },
        content: [{ type: 'text', text: FACT }],
      },
      submittedBy: authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

async function approve(agentId: number, editId: number) {
  await db.insert(agentVerifications).values({
    agentId,
    targetType: 'pending_edit',
    targetId: editId,
    verdict: 'approve',
    rationaleMd: 'Forslaget skiller eksplisitt mellom pKa1 og pKa2.',
    evidenceRefs: [],
    isImplicit: false,
  });
}

/** A blind dispute as POST /api/agent-verifications leaves it: verdict + mirror. */
async function dispute(agent: { agentId: number; userId: number }, editId: number) {
  const version = await verificationTargetVersion({
    targetType: 'pending_edit',
    targetId: editId,
  });
  await db.insert(agentVerifications).values({
    agentId: agent.agentId,
    targetType: 'pending_edit',
    targetId: editId,
    verdict: 'dispute',
    rationaleMd: BLIND_DISPUTE,
    evidenceRefs: [],
    isImplicit: false,
    verifierTier: 'flagship',
    model: 'gpt-5.6-sol',
  });
  await db.insert(disputes).values({
    targetType: 'pending_edit',
    targetId: editId,
    createdBy: agent.userId,
    source: 'agent',
    reasonMd: BLIND_DISPUTE,
    targetVersion: version,
  });
  return version!;
}

function createResponse() {
  const state = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
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

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  userId: number,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
) {
  getUserFromRequestMock.mockResolvedValue({ userId, role: 'contributor' });
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  const { res, state } = createResponse();
  await handler(req, res);
  return {
    statusCode: state.statusCode,
    headers: state.headers,
    body: state.body ? JSON.parse(state.body) : null,
  };
}

const RECONSIDER = '/api/agent-verifications/reconsider';

/**
 * List, then disclose the caller's first item and return its peer digest (or a
 * dummy when there is nothing to disclose).
 */
async function digestFor(userId: number): Promise<string> {
  const listed = await call(reconsiderHandler, userId, 'GET', RECONSIDER);
  const first = listed.body.items[0];
  if (!first) return '0'.repeat(64);
  const disclosed = await call(reconsiderHandler, userId, 'POST', RECONSIDER, {
    step: 'disclose',
    targetType: first.targetType,
    targetId: first.targetId,
    targetVersion: first.targetVersion,
  });
  return disclosed.body.peerDigest;
}

describe('dispute reconsideration', () => {
  it('shows the peers, keeps the blind verdict, and lets a withdrawal release consensus', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    await approve(c.agentId, editId);
    const version = await dispute(sol, editId);

    // The list is a pure read: the payload, never the peers.
    const listed = await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
    });
    expect(listed.body.items[0].payload).toBeTruthy();
    expect(listed.body.items[0].peerVerdicts).toBeUndefined();
    // Private to the caller: never cached by an intermediary.
    expect(String(listed.headers['Cache-Control'])).toMatch(/no-store/);
    expect(await db.select().from(agentVerdictReconsiderations)).toEqual([]);

    const disclosed = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      step: 'disclose',
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
    });
    expect(disclosed.statusCode).toBe(200);
    expect(String(disclosed.headers['Cache-Control'])).toMatch(/no-store/);
    const item = disclosed.body;
    expect(item).toMatchObject({ yourVerdict: { rationaleMd: BLIND_DISPUTE } });
    expect(item.peerVerdicts.map((p: { verdict: string }) => p.verdict)).toEqual([
      'approve',
      'approve',
    ]);

    // The agent's tier changes between the blind verdict and the decision.
    await db.update(agents).set({ modelTier: 'mid' }).where(eq(agents.id, sol.agentId));

    const addendum =
      'Jeg leste forslaget feil: det skiller eksplisitt mellom pKa1 og pKa2.';
    const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'withdraw',
      model: 'gpt-5.7-sol',
      peerDigest: await digestFor(sol.userId),
      addendumMd: addendum,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.body).toMatchObject({ outcome: 'withdrawn', autoApplied: true });

    const [edit] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect(edit!.status).toBe('approved');

    // The live verdict stops objecting but does not become an approval.
    const [live] = await db
      .select()
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, sol.agentId));
    expect(live!.verdict).toBe('abstain');
    expect(live!.rationaleMd).toContain(addendum);
    // The live row carries the decision, attributed to the model that made it.
    expect(live!.model).toBe('gpt-5.7-sol');
    expect(live!.verifierTier).toBe('mid');
    expect(live!.rationaleMd).toContain(BLIND_DISPUTE);

    // The blind signal is preserved unchanged.
    const [kept] = await db.select().from(agentVerdictReconsiderations);
    expect(kept).toMatchObject({
      agentId: sol.agentId,
      targetVersion: version,
      originalVerdict: 'dispute',
      originalRationaleMd: BLIND_DISPUTE,
      originalVerifierTier: 'flagship',
      originalModel: 'gpt-5.6-sol',
      decisionVerifierTier: 'mid',
      outcome: 'withdrawn',
      addendumMd: addendum,
    });
    // The peer verdicts the decision was made against are kept in full.
    // Exactly what was shown, plus who produced each one — kept even though
    // a revision would delete the peer rows themselves.
    const stored = kept!.peerVerdicts as Array<Record<string, unknown>>;
    expect(stored.map(({ agentId: _a, model: _m, ...shown }) => shown)).toEqual(
      item.peerVerdicts,
    );
    expect(stored.map((p) => p.agentId).sort()).toEqual(
      [b.agentId, c.agentId].sort(),
    );
    // The identities are stored, never shown to the reconsidering agent.
    expect(item.peerVerdicts[0]).not.toHaveProperty('agentId');
    expect(item.peerVerdicts[0]).not.toHaveProperty('model');

    const [mirror] = await db
      .select({ status: disputes.status, resolution: disputes.resolution })
      .from(disputes);
    expect(mirror).toEqual({ status: 'resolved', resolution: 'withdrawn' });
  });

  it('keeps a maintained dispute blocking and refuses a later non-blind verdict', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    await approve(c.agentId, editId);
    const version = await dispute(sol, editId);

    const addendum = 'Peer-begrunnelsene endrer ikke at kilden er feillest her.';
    const body = {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'maintain',
      model: 'gpt-5.7-sol',
      peerDigest: await digestFor(sol.userId),
      addendumMd: addendum,
    };
    const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, body);
    expect(posted.statusCode).toBe(200);
    expect(posted.body).toMatchObject({ outcome: 'maintained', autoApplied: false });

    const [edit] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect(edit!.status).toBe('pending');
    const [mirror] = await db.select().from(disputes);
    expect(mirror!.status).toBe('open');
    expect(mirror!.reasonMd).toContain(addendum);

    // One second look per version.
    const again = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, body);
    expect(again.statusCode).toBe(409);
    expect(again.body.code).toBe('reconsideration_already_recorded');
    expect(
      (await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER)).body.items,
    ).toEqual([]);

    // Having read its peers, the agent cannot re-enter the tally on this version.
    const flipped = await call(
      verificationsHandler,
      sol.userId,
      'POST',
      '/api/agent-verifications',
      {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: version,
        verdict: 'approve',
      },
    );
    expect(flipped.statusCode).toBe(409);
    expect(flipped.body.code).toBe('agent_verification_peers_seen');
  });

  it('offers nothing when no peer approved, and refuses a stale version', async () => {
    const author = await seedAgent('author');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    const version = await dispute(sol, editId);

    expect(
      (await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER)).body.items,
    ).toEqual([]);
    const base = {
      targetType: 'pending_edit',
      targetId: editId,
      outcome: 'withdraw',
      model: 'gpt-5.7-sol',
      peerDigest: await digestFor(sol.userId),
      addendumMd: 'Ingen andre har vurdert dette ennå, så ingenting å sammenligne.',
    };
    const noConflict = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      ...base,
      targetVersion: version,
    });
    expect(noConflict.statusCode).toBe(409);
    expect(noConflict.body.code).toBe('reconsideration_no_conflict');

    const stale = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      ...base,
      targetVersion: 'not-the-current-version',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe('reconsideration_target_version_stale');
  });

  it('pages past a starved candidate instead of returning it on every call (#1386)', async () => {
    const author = await seedAgent('author');
    const peer = await seedAgent('peer');
    const sol = await seedAgent('sol');

    const staleEdit = await seedWikiFactEdit(author.userId, 'oksymorfon-stale');
    await approve(peer.agentId, staleEdit);
    await dispute(sol, staleEdit);
    // Simulate the target becoming unreadable after the dispute was filed —
    // the dispute stays open, but the version it names is no longer current
    // (a status-only resubmit, a page reverted to draft, …).
    await db
      .update(disputes)
      .set({ targetVersion: 'not-the-current-version' })
      .where(
        and(eq(disputes.targetType, 'pending_edit'), eq(disputes.targetId, staleEdit)),
      );

    const liveEdit = await seedWikiFactEdit(author.userId, 'oksymorfon-live');
    await approve(peer.agentId, liveEdit);
    await dispute(sol, liveEdit);

    // Before the #1386 fix, `LIMIT 1` always selected the oldest row (the
    // starved one), the post-query check then dropped it, and the call
    // returned an empty list — starving every valid candidate behind it on
    // every request.
    const candidates = await listReconsiderationCandidates({
      agentId: sol.agentId,
      agentUserId: sol.userId,
      limit: 1,
    });
    expect(candidates).toEqual([
      expect.objectContaining({ targetType: 'pending_edit', targetId: liveEdit }),
    ]);
  });

  it('pages past a candidate that is no longer servable instead of starving the ones behind it (issue 1395)', async () => {
    const author = await seedAgent('author');
    const peer = await seedAgent('peer');
    const sol = await seedAgent('sol');

    const hiddenEdit = await seedWikiFactEdit(author.userId, 'oksymorfon-hidden');
    await approve(peer.agentId, hiddenEdit);
    await dispute(sol, hiddenEdit);
    // The page goes back to draft after the dispute was filed. The dispute's
    // version is still current, so the listing keeps it, but the GET handler's
    // visibility check refuses to serve a draft page's payload.
    const [hidden] = await db
      .select({ pageId: pendingEdits.targetId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, hiddenEdit));
    await db
      .update(wikiPages)
      .set({ status: 'draft' })
      .where(eq(wikiPages.id, hidden!.pageId!));

    const liveEdit = await seedWikiFactEdit(author.userId, 'oksymorfon-live');
    await approve(peer.agentId, liveEdit);
    const liveVersion = await dispute(sol, liveEdit);

    // Without the visibility check inside the scan, `?limit=1` selected the
    // hidden row, the handler dropped it, and every call came back empty.
    const listed = await call(reconsiderHandler, sol.userId, 'GET', `${RECONSIDER}?limit=1`);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      targetId: liveEdit,
      targetVersion: liveVersion,
    });
  });

  it('refuses a verdict write that was admitted before the second look but lands after it', async () => {
    // The route's pre-check can pass while /reconsider holds the source-row
    // lock; the write that follows must re-check under that lock.
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    const version = await dispute(sol, editId);
    const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'withdraw',
      model: 'gpt-5.7-sol',
      peerDigest: await digestFor(sol.userId),
      addendumMd: 'Jeg leste forslaget feil; innsigelsen trekkes.',
    });
    expect(posted.statusCode).toBe(200);

    await expect(
      recordVerification({
        expectTargetVersion: version,
        agentId: sol.agentId,
        targetType: 'pending_edit',
        targetId: editId,
        verdict: 'approve',
        rationaleMd: '',
        evidenceRefs: [],
        isImplicit: false,
      }),
    ).rejects.toBeInstanceOf(PeersSeenError);
    const [live] = await db
      .select({ verdict: agentVerifications.verdict })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, sol.agentId));
    expect(live!.verdict).toBe('abstain');
  });

  it('mirrors the withdrawal into the governance store', async () => {
    await setMigrationMode({ targetType: 'pending_edit', mode: 'shadow', updatedBy: null });
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    const version = await dispute(sol, editId);
    const [row] = await db
      .select({ id: agentVerifications.id })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, sol.agentId));
    await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: row!.id,
      actorRef: `user:${sol.userId}`,
      verdict: 'dispute',
      rationaleMd: BLIND_DISPUTE,
    });
    const verdictOf = async () => {
      const [proposal] = await db.select().from(kgProposals);
      if (!proposal) return [];
      const versions = await listVersions(db, proposal.id);
      const current = await currentAssessments(db, {
        subjectType: 'proposal_version',
        subjectId: versions[versions.length - 1]!.id,
      });
      return current.map((a) => a.verdict);
    };
    expect(await verdictOf()).toEqual(['dispute']);

    const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'withdraw',
      model: 'gpt-5.7-sol',
      peerDigest: await digestFor(sol.userId),
      addendumMd: 'Jeg leste forslaget feil; innsigelsen trekkes.',
    });
    expect(posted.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect(await verdictOf()).toEqual(['abstain']);
    });
  });

  it('reports a committed withdrawal even when the consensus retry throws', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    const version = await dispute(sol, editId);
    const spy = vi
      .spyOn(verificationsRoute, 'retryAgentConsensus')
      .mockRejectedValueOnce(new Error('connection reset'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: version,
        outcome: 'withdraw',
        model: 'gpt-5.7-sol',
        peerDigest: await digestFor(sol.userId),
        addendumMd: 'Jeg leste forslaget feil; innsigelsen trekkes.',
      });
      expect(spy).toHaveBeenCalled();
      expect(posted.statusCode).toBe(200);
      expect(posted.body).toMatchObject({
        outcome: 'withdrawn',
        autoApplied: false,
        consensusRetryFailed: true,
      });
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('refuses a decision made against peer verdicts that have since changed', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    const version = await dispute(sol, editId);
    const digest = await digestFor(sol.userId);
    // The peer re-verdicts in place after the list was served.
    await db
      .update(agentVerifications)
      .set({ rationaleMd: 'Ny begrunnelse etter at listen ble hentet.', updatedAt: new Date() })
      .where(eq(agentVerifications.agentId, b.agentId));

    const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'withdraw',
      model: 'gpt-5.7-sol',
      peerDigest: digest,
      addendumMd: 'Jeg leste forslaget feil; innsigelsen trekkes.',
    });
    expect(posted.statusCode).toBe(409);
    expect(posted.body.code).toBe('reconsideration_peers_changed');
    // Only the disclosure is on record; no decision was made.
    const rows = await db.select().from(agentVerdictReconsiderations);
    expect(rows.map((r) => r.outcome)).toEqual(['disclosed']);

    // Disclosing again binds the decision to the new set — and keeps the
    // first set on record, since the agent read that one too.
    const redisclosed = await digestFor(sol.userId);
    expect(redisclosed).not.toBe(digest);
    const decided = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'maintain',
      model: 'gpt-5.7-sol',
      peerDigest: redisclosed,
      addendumMd: 'Den nye begrunnelsen endrer ikke vurderingen min av kilden.',
    });
    expect(decided.statusCode).toBe(200);
    const [row] = await db.select().from(agentVerdictReconsiderations);
    const disclosures = row!.peerDisclosures as Array<{
      peerVerdicts: Array<{ rationaleMd: string }>;
    }>;
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]!.peerVerdicts[0]!.rationaleMd).toBe(
      'Forslaget skiller eksplisitt mellom pKa1 og pKa2.',
    );
    expect(disclosures[1]!.peerVerdicts[0]!.rationaleMd).toBe(
      'Ny begrunnelse etter at listen ble hentet.',
    );
    // The decision's model is recorded apart from the blind verdict's.
    expect(row!.decisionModel).toBe('gpt-5.7-sol');
  });

  it('freezes the blind verdict once the peers are shown', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    const version = await dispute(sol, editId);

    // Deciding without having been shown the peers is refused.
    const blindPost = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'withdraw',
      model: 'gpt-5.7-sol',
      peerDigest: '0'.repeat(64),
      addendumMd: 'Jeg leste forslaget feil; innsigelsen trekkes.',
    });
    expect(blindPost.statusCode).toBe(409);
    expect(blindPost.body.code).toBe('reconsideration_not_listed');

    const digest = await digestFor(sol.userId);
    // With the peers in view, the agent cannot rewrite its own verdict…
    const rewrite = await call(
      verificationsHandler,
      sol.userId,
      'POST',
      '/api/agent-verifications',
      {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: version,
        verdict: 'approve',
      },
    );
    expect(rewrite.statusCode).toBe(409);
    expect(rewrite.body.code).toBe('agent_verification_peers_seen');

    // …and listing again keeps the snapshot taken at the first disclosure.
    expect(await digestFor(sol.userId)).toBe(digest);
    const [kept] = await db.select().from(agentVerdictReconsiderations);
    expect(kept).toMatchObject({
      outcome: 'disclosed',
      originalVerdict: 'dispute',
      originalRationaleMd: BLIND_DISPUTE,
      decidedAt: null,
    });

    const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'maintain',
      model: 'gpt-5.7-sol',
      peerDigest: digest,
      addendumMd: 'Peer-begrunnelsen svarer ikke på motsigelsen i kilden.',
    });
    expect(posted.statusCode).toBe(200);
    const [decided] = await db.select().from(agentVerdictReconsiderations);
    expect(decided!.outcome).toBe('maintained');
    expect(decided!.decidedAt).not.toBeNull();
    expect(decided!.originalRationaleMd).toBe(BLIND_DISPUTE);
  });

  it('mirrors the withdrawal before the consensus it releases closes the edit', async () => {
    await setMigrationMode({ targetType: 'pending_edit', mode: 'shadow', updatedBy: null });
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    await approve(c.agentId, editId);
    const version = await dispute(sol, editId);
    const [row] = await db
      .select({ id: agentVerifications.id })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, sol.agentId));
    await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: row!.id,
      actorRef: `user:${sol.userId}`,
      verdict: 'dispute',
      rationaleMd: BLIND_DISPUTE,
    });

    const currentVerdicts = async () => {
      const [proposal] = await db.select().from(kgProposals);
      const versions = await listVersions(db, proposal!.id);
      return (
        await currentAssessments(db, {
          subjectType: 'proposal_version',
          subjectId: versions[0]!.id,
        })
      ).map((a) => a.verdict);
    };
    // The retry can close the edit, after which the mirror has nothing to bind
    // to — so the abstention must already be mirrored when the retry starts.
    const realRetry = verificationsRoute.retryAgentConsensus;
    // A slow mirror, so an undelayed retry would visibly overtake it.
    const realMirror = mirrorModule.mirrorAssessment;
    const slowMirror = vi
      .spyOn(mirrorModule, 'mirrorAssessment')
      .mockImplementationOnce(async (a) => {
        await new Promise((r) => setTimeout(r, 50));
        return realMirror(a);
      });
    let atRetry: string[] = [];
    const spy = vi
      .spyOn(verificationsRoute, 'retryAgentConsensus')
      .mockImplementationOnce(async (id: number) => {
        atRetry = await currentVerdicts();
        return realRetry(id);
      });
    try {
      const posted = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: version,
        outcome: 'withdraw',
        model: 'gpt-5.7-sol',
        peerDigest: await digestFor(sol.userId),
        addendumMd: 'Jeg leste forslaget feil; innsigelsen trekkes.',
      });
      expect(spy).toHaveBeenCalled();
      expect(posted.body).toMatchObject({ outcome: 'withdrawn', autoApplied: true });
      // Mirrored under the model that decided, not the blind verdict's.
      expect(slowMirror.mock.calls[0]![0]).toMatchObject({ model: 'gpt-5.7-sol' });
    } finally {
      spy.mockRestore();
      slowMirror.mockRestore();
    }
    expect(atRetry).toContain('abstain');
    expect(atRetry).not.toContain('dispute');
  });

  it('keeps the tier the blind verdict was written under through a demotion', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    await db.update(agents).set({ modelTier: 'flagship' }).where(eq(agents.id, sol.agentId));
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    const version = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    });
    // The real write path stamps both the effective and the recorded tier.
    await recordVerification({
      expectTargetVersion: version!,
      agentId: sol.agentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'dispute',
      rationaleMd: BLIND_DISPUTE,
      evidenceRefs: [],
      isImplicit: false,
    });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: editId,
      createdBy: sol.userId,
      source: 'agent',
      reasonMd: BLIND_DISPUTE,
      targetVersion: version,
    });
    // Demoted before the second look: the effective tier is restamped.
    await db.update(agents).set({ modelTier: 'mid' }).where(eq(agents.id, sol.agentId));
    await restampPendingVerdictTiers(sol.agentId, 'mid');

    await digestFor(sol.userId);
    const [kept] = await db.select().from(agentVerdictReconsiderations);
    expect(kept!.originalVerifierTier).toBe('flagship');
    const [live] = await db
      .select({
        tier: agentVerifications.verifierTier,
        recorded: agentVerifications.recordedVerifierTier,
      })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, sol.agentId));
    expect(live).toEqual({ tier: 'mid', recorded: 'flagship' });
  });

  it('keeps the verdict frozen through a status-only resubmit', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    await dispute(sol, editId);
    await digestFor(sol.userId);

    // A bare resubmit bumps the version but keeps the payload and every verdict.
    await db
      .update(pendingEdits)
      .set({ submittedAt: new Date(Date.now() + 60_000) })
      .where(eq(pendingEdits.id, editId));
    const newVersion = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    });

    // No fresh, non-blind verdict on unchanged content…
    const flipped = await call(
      verificationsHandler,
      sol.userId,
      'POST',
      '/api/agent-verifications',
      {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: newVersion,
        verdict: 'approve',
      },
    );
    expect(flipped.statusCode).toBe(409);
    expect(flipped.body.code).toBe('agent_verification_peers_seen');

    // …and no implicit approval stamped over the frozen dispute either.
    await recordVerification({
      agentId: sol.agentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'approve',
      rationaleMd: '',
      evidenceRefs: [],
      isImplicit: true,
    });
    const [live] = await db
      .select({ verdict: agentVerifications.verdict, isImplicit: agentVerifications.isImplicit })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, sol.agentId));
    expect(live).toEqual({ verdict: 'dispute', isImplicit: false });

    // A real revision clears the verdicts, and with them the freeze.
    await db.delete(agentVerifications).where(eq(agentVerifications.targetId, editId));
    const fresh = await call(
      verificationsHandler,
      sol.userId,
      'POST',
      '/api/agent-verifications',
      {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: newVersion,
        verdict: 'approve',
      },
    );
    expect(fresh.statusCode).toBe(201);
  });

  it('keeps a dispute reconsiderable through the author\'s bare status-only resubmit (#1388)', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    await approve(c.agentId, editId);
    const version = await dispute(sol, editId);

    const listedBefore = await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER);
    expect(listedBefore.body.items).toHaveLength(1);
    expect(listedBefore.body.items[0]).toMatchObject({
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
    });

    // The submitter answers the dispute with a bare `{status:'pending'}`
    // resubmit through the real PATCH route — no payload fields at all, so
    // the content never moves, but `submittedAt` (and so the version token)
    // does.
    const req = Readable.from([JSON.stringify({ status: 'pending' })]) as IncomingMessage;
    req.method = 'PATCH';
    req.url = `/api/pending-edits?id=${editId}`;
    req.headers = {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
    };
    getUserFromRequestMock.mockResolvedValue({ userId: author.userId, role: 'contributor' });
    const { res, state } = createResponse();
    await pendingEditsHandler(req, res);
    expect(state.statusCode).toBe(200);

    const newVersion = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    });
    expect(newVersion).not.toBe(version);

    // The dispute is still there for a second look — bound to the token the
    // resubmit produced, not stranded on the one it was filed against.
    const stillListed = await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER);
    expect(stillListed.body.items).toHaveLength(1);
    expect(stillListed.body.items[0]).toMatchObject({
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: newVersion,
    });
    const [mirror] = await db
      .select({ targetVersion: disputes.targetVersion, status: disputes.status })
      .from(disputes)
      .where(eq(disputes.targetId, editId));
    expect(mirror).toEqual({ targetVersion: newVersion, status: 'open' });

    // Reconsideration still works end to end against the rebound version.
    const disclosed = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      step: 'disclose',
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: newVersion,
    });
    expect(disclosed.statusCode).toBe(200);
  });

  it("leaves a legacy dispute's unknown anchor unrebound across a material revision (#1388 review)", async () => {
    // A dispute row written before targetVersion existed (migration 0126) has
    // no recorded anchor. If the edit was later materially revised, this
    // dispute's relationship to that revision was never captured — it may
    // predate it (#1327's revised_since must keep catching that) or not.
    // A bare status-only resubmit must not guess "current" for it.
    const author = await seedAgent('author');
    const objector = await seedUser(db, { email: 'objector@example.com', username: 'objector' });
    const editId = await seedWikiFactEdit(author.userId);
    const revisedAt = '2026-09-01T00:00:00.000Z';
    await db
      .update(pendingEdits)
      .set({ proposedMeta: { revisedAt } })
      .where(eq(pendingEdits.id, editId));
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: editId,
      createdBy: objector,
      source: 'human',
      reasonMd: 'En eldre innsigelse skrevet før target_version fantes.',
      targetVersion: null,
    });

    const req = Readable.from([JSON.stringify({ status: 'pending' })]) as IncomingMessage;
    req.method = 'PATCH';
    req.url = `/api/pending-edits?id=${editId}`;
    req.headers = {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
    };
    getUserFromRequestMock.mockResolvedValue({ userId: author.userId, role: 'contributor' });
    const { res, state } = createResponse();
    await pendingEditsHandler(req, res);
    expect(state.statusCode).toBe(200);

    const [mirror] = await db
      .select({ targetVersion: disputes.targetVersion, status: disputes.status })
      .from(disputes)
      .where(eq(disputes.targetId, editId));
    // Untouched: still no anchor, so a later upheld-return check still falls
    // back to the objection's raw createdAt instead of reading it as current.
    expect(mirror).toEqual({ targetVersion: null, status: 'open' });
  });

  it("does not re-offer a dispute its author already maintained, through a bare status-only resubmit (#1388 review)", async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const sol = await seedAgent('sol');
    const editId = await seedWikiFactEdit(author.userId);
    await approve(b.agentId, editId);
    await approve(c.agentId, editId);
    const version = await dispute(sol, editId);

    // sol takes its one sanctioned second look and maintains the objection.
    const maintained = await call(reconsiderHandler, sol.userId, 'POST', RECONSIDER, {
      targetType: 'pending_edit',
      targetId: editId,
      targetVersion: version,
      outcome: 'maintain',
      model: 'gpt-5.7-sol',
      peerDigest: await digestFor(sol.userId),
      addendumMd: 'Peer-begrunnelsene endrer ikke vurderingen.',
    });
    expect(maintained.statusCode).toBe(200);
    expect(maintained.body).toMatchObject({ outcome: 'maintained' });
    expect(
      (await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER)).body.items,
    ).toEqual([]);

    // The submitter answers with a bare, payload-identical resubmit — the
    // same operation #1388 exists to keep an UNDECIDED dispute reachable
    // through, not a licence to reopen one already decided.
    const req = Readable.from([JSON.stringify({ status: 'pending' })]) as IncomingMessage;
    req.method = 'PATCH';
    req.url = `/api/pending-edits?id=${editId}`;
    req.headers = {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
    };
    getUserFromRequestMock.mockResolvedValue({ userId: author.userId, role: 'contributor' });
    const { res, state } = createResponse();
    await pendingEditsHandler(req, res);
    expect(state.statusCode).toBe(200);

    // Still not offered — the maintained decision stands, not a fresh round.
    expect(
      (await call(reconsiderHandler, sol.userId, 'GET', RECONSIDER)).body.items,
    ).toEqual([]);
    const [mirror] = await db
      .select({ targetVersion: disputes.targetVersion, status: disputes.status })
      .from(disputes)
      .where(eq(disputes.targetId, editId));
    // Left exactly as it was: still bound to the version the completed
    // reconsideration itself is keyed on.
    expect(mirror).toEqual({ targetVersion: version, status: 'open' });
    const reconsiderations = await db
      .select({ outcome: agentVerdictReconsiderations.outcome })
      .from(agentVerdictReconsiderations)
      .where(eq(agentVerdictReconsiderations.targetId, editId));
    // No duplicate round was created either.
    expect(reconsiderations).toEqual([{ outcome: 'maintained' }]);
  });
});
