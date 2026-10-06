/**
 * Agent consensus after the approve instant (issue #1357).
 *
 * Consensus used to run only when an `approve` landed, so an edit held at that
 * moment stayed held for good. These pin the three fixes against real SQL: the
 * read-only hold explanation the /review card shows, the tier re-stamp an
 * admin's correction triggers, and the retry sweep.
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

import { eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  disputes,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import handler, {
  agentConsensusStatus,
  persistConsensusApplyFailure,
  retryAgentConsensus,
  runAgentConsensus,
  sweepAgentConsensus,
} from '../../api/agent-verifications.js';
import { pendingEditReviewToken } from '../../api/_lib/pending-edit-review-token.js';
import {
  lockConsensusEligibility,
  restampPendingVerdictTiers,
  updateAgentWithTierRestamp,
  withAgentPoolGrowthLock,
} from '../../api/_lib/agent-verifications.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';
import { getDb } from '../../api/_lib/db.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import { collectConsensusFacts } from '../../api/_lib/knowledge-governance/policy-shadow.js';

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

async function seedAgent(slug: string, name = slug) {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({ userId, name, slug, status: 'active' })
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

/** A quoted, calculation-driving source value an agent proposed. */
async function seedHighRiskEdit(authorUserId: number, status = 'pending') {
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
      status: status as 'pending',
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

describe('agent consensus hold, re-stamp and retry', () => {
  it('explains a flagship hold and names approvers whose tier is unset', async () => {
    const author = await seedAgent('author');
    const opus = await seedAgent('opus', 'Claude Opus 5');
    const sol = await seedAgent('sol', 'GPT-5.6 Sol');
    const editId = await seedHighRiskEdit(author.userId);
    await approve(opus.agentId, editId, { model: 'claude-opus-5' });
    await approve(sol.agentId, editId, { model: 'gpt-5.6-sol' });

    expect(await agentConsensusStatus(editId)).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
    });

    getUserFromRequestMock.mockResolvedValue({ userId: 0, role: 'admin' });
    const req = {
      method: 'GET',
      url: `/api/agent-verifications?targetType=pending_edit&targetId=${editId}`,
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;
    const { res, state } = createResponse();
    await handler(req, res);
    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.consensus.reason).toBe('high_risk_missing_flagship');
    expect(body.consensus.unrankedFlagshipApprovers.sort()).toEqual([
      'Claude Opus 5',
      'GPT-5.6 Sol',
    ]);
  });

  it('does not raise earlier verdicts when an agent is promoted', async () => {
    const author = await seedAgent('author');
    const opus = await seedAgent('opus');
    const other = await seedAgent('other');
    const editId = await seedHighRiskEdit(author.userId);
    // Cast while the agent's tier was unset: judged at that standing.
    await approve(opus.agentId, editId, { model: 'claude-opus-5' });
    await approve(other.agentId, editId);

    const { touched } = await updateAgentWithTierRestamp(opus.agentId, {
      modelTier: 'flagship',
    });
    // A promotion re-stamps nothing: the old judgment keeps its tier, so it
    // cannot newly satisfy the flagship gate on a calculation-driving value.
    expect(touched).toEqual([]);
    const [row] = await db
      .select({ tier: agentVerifications.verifierTier })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, opus.agentId));
    expect(row!.tier).toBeNull();
    expect(await agentConsensusStatus(editId)).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
    });
  });

  it('withdraws flagship standing on pending edits only when demoted', async () => {
    const author = await seedAgent('author');
    const opus = await seedAgent('opus');
    const other = await seedAgent('other');
    const pendingId = await seedHighRiskEdit(author.userId);
    const decidedId = await seedHighRiskEdit(author.userId, 'approved');
    await approve(opus.agentId, pendingId, { tier: 'flagship' });
    await approve(other.agentId, pendingId);
    await approve(opus.agentId, decidedId, { tier: 'flagship' });

    expect(await restampPendingVerdictTiers(opus.agentId, 'mid')).toEqual([
      pendingId,
    ]);
    const rows = await db
      .select({
        targetId: agentVerifications.targetId,
        tier: agentVerifications.verifierTier,
      })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, opus.agentId));
    const tierOf = new Map(rows.map((r) => [r.targetId, r.tier]));
    expect(tierOf.get(pendingId)).toBe('mid');
    // A decided edit keeps the tier it was decided under.
    expect(tierOf.get(decidedId)).toBe('flagship');
  });

  it('re-stamps a dispute, an abstain and an implicit approval but does not return them for retry (#1369)', async () => {
    const author = await seedAgent('author');
    const opus = await seedAgent('opus');
    const disputedId = await seedHighRiskEdit(author.userId);
    const abstainedId = await seedHighRiskEdit(author.userId);
    const implicitId = await seedHighRiskEdit(author.userId);
    const publishableId = await seedHighRiskEdit(author.userId);
    await db.insert(agentVerifications).values({
      agentId: opus.agentId,
      targetType: 'pending_edit',
      targetId: disputedId,
      verdict: 'dispute',
      rationaleMd: 'Kilden oppgir en annen verdi enn foreslått.',
      evidenceRefs: [],
      isImplicit: false,
      verifierTier: 'flagship',
    });
    await db.insert(agentVerifications).values({
      agentId: opus.agentId,
      targetType: 'pending_edit',
      targetId: abstainedId,
      verdict: 'abstain',
      rationaleMd: 'Utilstrekkelig grunnlag til å vurdere denne verdien.',
      evidenceRefs: [],
      isImplicit: false,
      verifierTier: 'flagship',
    });
    await db.insert(agentVerifications).values({
      agentId: opus.agentId,
      targetType: 'pending_edit',
      targetId: implicitId,
      verdict: 'approve',
      rationaleMd: '',
      evidenceRefs: [],
      isImplicit: true,
      verifierTier: 'flagship',
    });
    await approve(opus.agentId, publishableId, { tier: 'flagship' });

    // Only the explicit, non-implicit approval can ever flip a hold to
    // publish — the demotion must still restamp every verdict kind, but the
    // retry list is narrowed to the one row retrying it can actually change.
    expect(await restampPendingVerdictTiers(opus.agentId, 'mid')).toEqual([
      publishableId,
    ]);
    const rows = await db
      .select({
        targetId: agentVerifications.targetId,
        tier: agentVerifications.verifierTier,
      })
      .from(agentVerifications)
      .where(eq(agentVerifications.agentId, opus.agentId));
    const tierOf = new Map(rows.map((r) => [r.targetId, r.tier]));
    expect(tierOf.get(disputedId)).toBe('mid');
    expect(tierOf.get(abstainedId)).toBe('mid');
    expect(tierOf.get(implicitId)).toBe('mid');
    expect(tierOf.get(publishableId)).toBe('mid');
  });

  it('sweeps an edit whose consensus was never re-run', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    // Two approvals already on record, as if consensus had been held when the
    // second one landed and nothing had tried again since.
    await approve(b.agentId, edit!.id);
    await approve(c.agentId, edit!.id);

    const results = await sweepAgentConsensus();
    expect(results).toEqual([
      expect.objectContaining({ pendingEditId: edit!.id, outcome: 'applied' }),
    ]);
    const [after] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(after!.status).toBe('approved');
    // A second sweep finds nothing left to do.
    expect(await sweepAgentConsensus()).toEqual([]);
  });

  it('keeps edits consensus can never publish out of the sweep window', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    // A third agent so each high-risk edit can carry the full two-approval quorum.
    const c = await seedAgent('c');
    const human = await seedUser(db, {
      email: 'human@example.com',
      username: 'human',
      role: 'contributor',
    });
    // Three permanently held edits, all older than the one that can publish.
    const humanEdit = await seedHighRiskEdit(human);
    const clinical = await seedHighRiskEdit(author.userId);
    await db
      .update(pendingEdits)
      .set({ editType: 'clinical_case' })
      .where(eq(pendingEdits.id, clinical));
    const humanDisputed = await seedHighRiskEdit(author.userId);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: humanDisputed,
      createdBy: human,
      reasonMd: 'Verdien stemmer ikke med kilden.',
    });
    const eligible = await seedHighRiskEdit(author.userId);
    for (const id of [humanEdit, clinical, humanDisputed, eligible]) {
      await approve(b.agentId, id);
      await approve(c.agentId, id);
    }

    // With a window of one, the eligible edit is still the one retried.
    const results = await sweepAgentConsensus(1);
    expect(results.map((r) => r.pendingEditId)).toEqual([eligible]);
  });

  it('keeps a permanently sub-quorum tally from occupying the sweep window (#1367)', async () => {
    // A pool of three: the full two-approval quorum applies to every edit.
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });

    async function seedWikiFactEdit(factId: string, statement: string) {
      const [edit] = await db
        .insert(pendingEdits)
        .values({
          editType: 'wiki_fact',
          targetId: page!.id,
          sectionId: 'pk',
          factOperation: 'add',
          factStatement: statement,
          proposedValue: {
            type: 'fact',
            attrs: { factId, referenceIds: [] },
            content: [{ type: 'text', text: statement }],
          },
          submittedBy: author.userId,
          status: 'pending',
        })
        .returning({ id: pendingEdits.id });
      return edit!.id;
    }

    // Older, but stuck at one approval forever — no third agent is ever going
    // to review it, so it can never reach the pool's two-approval quorum.
    const stuck = await seedWikiFactEdit('f-1', 'Halveringstiden er 20–100 timer.');
    await approve(b.agentId, stuck);
    await new Promise((r) => setTimeout(r, 5));
    // Newer, and already at quorum — its hold (if any) cleared by some other
    // event, so a retry should publish it.
    const ready = await seedWikiFactEdit('f-2', 'Distribusjonsvolumet er ca. 1 L/kg.');
    await approve(b.agentId, ready);
    await approve(c.agentId, ready);

    // A window of one would return only the oldest candidate under a plain
    // oldest-first LIMIT; the stuck row must not be that candidate.
    const results = await sweepAgentConsensus(1);
    expect(results).toEqual([
      expect.objectContaining({ pendingEditId: ready, outcome: 'applied' }),
    ]);
    const [stuckAfter] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, stuck));
    expect(stuckAfter!.status).toBe('pending');
  });

  it("counts only approvals the gate counts when filtering the sweep window (issue 1398)", async () => {
    // A pool of three, so the floor is the full two approvals.
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    // Older: the author's own approval (cast under a self-review grant that no
    // longer exists) plus one peer approval. The raw count is two, but the
    // gate counts one.
    const revoked = await seedHighRiskEdit(author.userId);
    await approve(author.agentId, revoked);
    await approve(b.agentId, revoked);
    await new Promise((r) => setTimeout(r, 5));
    const ready = await seedHighRiskEdit(author.userId);
    await approve(b.agentId, ready);
    await approve(c.agentId, ready);

    const results = await sweepAgentConsensus(1);
    expect(results.map((r) => r.pendingEditId)).toEqual([ready]);
  });

  it("does not let one-approval high-risk rows fill the sweep window in a two-agent pool", async () => {
    // Two active agents: the pool floor is one approval, but a high-risk edit
    // never rides the degraded path and needs two.
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const stuck = await seedHighRiskEdit(author.userId);
    await approve(b.agentId, stuck);
    await new Promise((r) => setTimeout(r, 5));
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [ready] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Distribusjonsvolumet er ca. 1 L/kg.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-hr', referenceIds: [] },
          content: [{ type: 'text', text: 'Distribusjonsvolumet er ca. 1 L/kg.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    await approve(b.agentId, ready!.id);

    const results = await sweepAgentConsensus(1);
    expect(results.map((r) => r.pendingEditId)).toEqual([ready!.id]);
  });

  it('downgrades a tier and its pending verdict snapshots together', async () => {
    const author = await seedAgent('author');
    const opus = await seedAgent('opus');
    const other = await seedAgent('other');
    await db
      .update(agents)
      .set({ modelTier: 'flagship' })
      .where(eq(agents.id, opus.agentId));
    const editId = await seedHighRiskEdit(author.userId);
    await approve(opus.agentId, editId, { tier: 'flagship' });
    await approve(other.agentId, editId);
    expect(await agentConsensusStatus(editId)).toEqual({ ready: true });

    const tierOfVerdict = async () =>
      (
        await db
          .select({ tier: agentVerifications.verifierTier })
          .from(agentVerifications)
          .where(eq(agentVerifications.agentId, opus.agentId))
      )[0]!.tier;

    // A failing agent update (slug taken) must roll the re-stamp back too:
    // the verdict keeps the tier the agent still has.
    await expect(
      updateAgentWithTierRestamp(opus.agentId, {
        modelTier: null,
        slug: 'other',
      }),
    ).rejects.toThrow();
    expect(await tierOfVerdict()).toBe('flagship');

    const { touched } = await updateAgentWithTierRestamp(opus.agentId, {
      modelTier: null,
    });
    expect(touched).toEqual([editId]);
    expect(await tierOfVerdict()).toBeNull();
    // The revoked flagship grant no longer satisfies the high-risk gate.
    expect(await agentConsensusStatus(editId)).toEqual({
      ready: false,
      reason: 'high_risk_missing_flagship',
    });
  });

  it('aborts the approval when the under-lock re-check fails', async () => {
    const author = await seedAgent('author');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    let ranUnderLock = false;
    await expect(
      applyApprovedEdit(edit!.id, author.userId, undefined, {
        revalidate: async () => {
          ranUnderLock = true;
          throw new Error('gate no longer holds');
        },
      }),
    ).rejects.toThrow('gate no longer holds');
    expect(ranUnderLock).toBe(true);
    const [after] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    // Nothing was written: the approval rolled back with the re-check.
    expect(after!.status).toBe('pending');
  });

  it('does not count an author approval once self-review is revoked', async () => {
    // Two active agents: the degraded pool where the quorum drops to one.
    const author = await seedAgent('author');
    await seedAgent('peer');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    // An explicit self-approval cast while the grant was on; the grant is now
    // off (the seeded agent has self_review_enabled = false).
    await approve(author.agentId, edit!.id);

    // The sweep no longer offers a row whose only approval is ineligible
    // (issue 1398); the gate itself still holds it when asked directly.
    expect(await sweepAgentConsensus()).toEqual([]);
    expect(await retryAgentConsensus(edit!.id)).toEqual({
      outcome: 'held',
      reason: 'quorum_unmet',
    });
    const [after] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(after!.status).toBe('pending');
  });

  it('leaves a revoked author approval out of the generic engine tally too', async () => {
    const author = await seedAgent('author');
    const peer = await seedAgent('peer');
    const editId = await seedHighRiskEdit(author.userId);
    await approve(author.agentId, editId);
    await approve(peer.agentId, editId);

    // Self-review off: only the peer's approval is a verifier's.
    const facts = await collectConsensusFacts(editId);
    expect(facts!.authorSelfReviews).toBe(false);
    expect(facts!.summary.approveCount).toBe(1);

    // With the grant on, the author is a verifier and counts.
    await db
      .update(agents)
      .set({ selfReviewEnabled: true })
      .where(eq(agents.id, author.agentId));
    const granted = await collectConsensusFacts(editId);
    expect(granted!.summary.approveCount).toBe(2);
  });

  it('does not publish on the approval of a since-suspended agent', async () => {
    // Two active agents after the suspension: quorum drops to one.
    const author = await seedAgent('author');
    const peer = await seedAgent('peer');
    const suspended = await seedAgent('suspended');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    await approve(suspended.agentId, edit!.id);
    await db
      .update(agents)
      .set({ status: 'suspended' })
      .where(eq(agents.id, suspended.agentId));
    void peer;

    // Filtered out of the sweep (issue 1398); the gate still holds it directly.
    expect(await sweepAgentConsensus()).toEqual([]);
    expect(await retryAgentConsensus(edit!.id)).toMatchObject({
      outcome: 'held',
    });
    const [after] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(after!.status).toBe('pending');
  });

  it('never attributes a retry to an author without the self-review grant', async () => {
    const author = await seedAgent('author');
    const peer = await seedAgent('peer');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    // The peer approves first; the author's (now ungranted) self-approval is
    // the NEWEST approval on record.
    await approve(peer.agentId, edit!.id);
    await new Promise((r) => setTimeout(r, 5));
    await approve(author.agentId, edit!.id);

    const result = await retryAgentConsensus(edit!.id);
    expect(result.outcome).toBe('applied');
    const [after] = await db
      .select({ reviewedBy: pendingEdits.reviewedBy })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(after!.reviewedBy).toBe(peer.userId);
  });

  it('leaves a disputed edit out of the sweep', async () => {
    const author = await seedAgent('author');
    const b = await seedAgent('b');
    const c = await seedAgent('c');
    const editId = await seedHighRiskEdit(author.userId);
    await approve(b.agentId, editId);
    await db.insert(agentVerifications).values({
      agentId: c.agentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'dispute',
      rationaleMd: 'Kilden oppgir en annen verdi.',
      evidenceRefs: [],
      isImplicit: false,
    });
    expect(await sweepAgentConsensus()).toEqual([]);
  });

  it('adds an agent under the pool lock a consensus re-check shares', async () => {
    // PGlite runs one connection, so the phantom race itself cannot be staged
    // here; this pins that creation and the re-check take the same advisory
    // key (exclusive vs shared) and that both run on real SQL.
    const userId = await seedUser(db, {
      email: 'pool@example.com',
      username: 'pool',
      role: 'contributor',
    });
    const created = await withAgentPoolGrowthLock(async () => {
      const [row] = await getDb()
        .insert(agents)
        .values({ userId, name: 'pool', slug: 'pool', status: 'active' })
        .returning({ id: agents.id });
      return row;
    });
    expect(created?.id).toBeGreaterThan(0);
    await expect(lockConsensusEligibility()).resolves.toBeUndefined();
  });

  it('refuses to attribute a publication to an approver who lost standing', async () => {
    const author = await seedAgent('author');
    const peerA = await seedAgent('peer-a');
    const peerB = await seedAgent('peer-b');
    const stale = await seedAgent('stale');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    await approve(peerA.agentId, edit!.id);
    await approve(peerB.agentId, edit!.id);
    await approve(stale.agentId, edit!.id);
    // Suspended after being picked as the actor: the tally still passes on
    // the two peers, but the publication must not carry its identity.
    await db
      .update(agents)
      .set({ status: 'suspended' })
      .where(eq(agents.id, stale.agentId));

    expect(
      await runAgentConsensus({
        pendingEditId: edit!.id,
        approverUserId: stale.userId,
      }),
    ).toEqual({ outcome: 'held', reason: 'approver_ineligible' });
    const [held] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(held!.status).toBe('pending');

    expect(
      await runAgentConsensus({
        pendingEditId: edit!.id,
        approverUserId: peerA.userId,
      }),
    ).toEqual({ outcome: 'applied' });
    const [after] = await db
      .select({ status: pendingEdits.status, reviewedBy: pendingEdits.reviewedBy })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(after).toEqual({ status: 'approved', reviewedBy: peerA.userId });
  });

  it('reports apply_failed instead of ready once a retry has already failed (#1364)', async () => {
    const author = await seedAgent('author');
    const peerA = await seedAgent('peer-a');
    const peerB = await seedAgent('peer-b');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    // A remove op anchored on a factId the section's content does not
    // contain: applyFactOp always throws "not found" for it, so every
    // consensus attempt against this exact payload refuses identically —
    // the deterministic case the issue names (a moved/missing fact target).
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'remove',
        factTargetAnchor: { factId: 'does-not-exist' },
        proposedValue: {},
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    await approve(peerA.agentId, edit!.id);
    await approve(peerB.agentId, edit!.id);

    // Before any apply attempt, the gates all pass and the card would
    // correctly say ready.
    expect(await agentConsensusStatus(edit!.id)).toEqual({ ready: true });

    expect(
      await runAgentConsensus({
        pendingEditId: edit!.id,
        approverUserId: peerA.userId,
      }),
    ).toEqual({
      outcome: 'held',
      reason: 'apply_failed',
      detail: expect.stringContaining('not found'),
    });

    // The failed attempt is now on record: the status endpoint must not
    // claim readiness for a proposal that has already deterministically
    // failed to apply under these exact contents.
    expect(await agentConsensusStatus(edit!.id)).toEqual({
      ready: false,
      reason: 'apply_failed',
    });

    const [row] = await db
      .select({ failure: pendingEdits.lastConsensusApplyFailure })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(row!.failure).toMatchObject({
      detail: expect.stringContaining('not found'),
    });

    // A resubmit bumps `submittedAt`, and so the review token the failure was
    // keyed to — the stale failure must not bind a token it was never
    // recorded against; the gates alone decide again until a new attempt is
    // made against the new token.
    await db
      .update(pendingEdits)
      .set({ submittedAt: new Date(Date.now() + 1000) })
      .where(eq(pendingEdits.id, edit!.id));
    expect(await agentConsensusStatus(edit!.id)).toEqual({ ready: true });
  });

  it('never lets a stale apply-failure attempt clobber a fresher one (#1392 review)', async () => {
    // Two consensus attempts against different tokens can race: an older
    // attempt (pre-revision token) recording after a newer one has already
    // recorded its own failure must not overwrite it — that would leave the
    // CURRENT token's failure lost, and agentConsensusStatus would see a
    // token mismatch and wrongly report ready: true.
    const author = await seedAgent('author');
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pk',
        factOperation: 'remove',
        factTargetAnchor: { factId: 'x' },
        proposedValue: {},
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    const [row1] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    const tokenOld = pendingEditReviewToken(row1 as never);

    await persistConsensusApplyFailure(edit!.id, tokenOld, 'first attempt');
    let [stored] = await db
      .select({ failure: pendingEdits.lastConsensusApplyFailure })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(stored!.failure).toMatchObject({ token: tokenOld, detail: 'first attempt' });

    // A resubmit: submittedAt bumps, so the token changes.
    await db
      .update(pendingEdits)
      .set({ submittedAt: new Date(Date.now() + 1000) })
      .where(eq(pendingEdits.id, edit!.id));
    const [row2] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    const tokenNew = pendingEditReviewToken(row2 as never);
    expect(tokenNew).not.toBe(tokenOld);

    // The newer attempt records its own failure first.
    await persistConsensusApplyFailure(edit!.id, tokenNew, 'second attempt');

    // The older attempt's write finally arrives, bound to the now-stale
    // token — it must be a no-op rather than clobbering the newer record.
    await persistConsensusApplyFailure(edit!.id, tokenOld, 'late first attempt');

    ([stored] = await db
      .select({ failure: pendingEdits.lastConsensusApplyFailure })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id)));
    expect(stored!.failure).toMatchObject({ token: tokenNew, detail: 'second attempt' });
  });

  it('never publishes a version a moderator upheld a dispute against', async () => {
    const author = await seedAgent('author');
    const peerA = await seedAgent('peer-a');
    const peerB = await seedAgent('peer-b');
    const moderator = await seedUser(db, {
      email: 'moderator@example.com',
      username: 'moderator',
      role: 'admin',
    });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    // Approved by both peers, then a human dispute was upheld (which returned
    // the edit) and the author resubmitted it unchanged: status pending again,
    // the peer approvals still on record, no revision marker.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    await approve(peerA.agentId, edit!.id);
    await approve(peerB.agentId, edit!.id);
    const resolvedAt = new Date(Date.now() - 60_000);
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: edit!.id,
      createdBy: moderator,
      reasonMd: 'Kilden oppgir 20–50 timer, ikke 20–100.',
      status: 'resolved',
      resolution: 'upheld',
      resolvedBy: moderator,
      resolvedAt,
    });

    expect(await sweepAgentConsensus()).toEqual([
      expect.objectContaining({
        pendingEditId: edit!.id,
        outcome: 'held',
        reason: 'upheld_dispute',
      }),
    ]);
    expect((await collectConsensusFacts(edit!.id))?.disputeHoldCause).toBe('upheld_dispute');
    expect((await collectConsensusFacts(edit!.id))?.hasOpenHumanDispute).toBe(true);
    const [held] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(held!.status).toBe('pending');

    // A real revision after the ruling moves the edit out from under it.
    await db
      .update(pendingEdits)
      .set({ proposedMeta: { revisedAt: new Date().toISOString() } })
      .where(eq(pendingEdits.id, edit!.id));
    expect((await collectConsensusFacts(edit!.id))?.hasOpenHumanDispute).toBe(false);
    expect(await sweepAgentConsensus()).toEqual([
      expect.objectContaining({ pendingEditId: edit!.id, outcome: 'applied' }),
    ]);
  });

  it('never publishes into a page moved back to draft', async () => {
    const author = await seedAgent('author');
    const peerA = await seedAgent('peer-a');
    const peerB = await seedAgent('peer-b');
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    // Quorum gathered while the page was published; then an editor moved it
    // back to draft.
    await approve(peerA.agentId, edit!.id);
    await approve(peerB.agentId, edit!.id);
    await db
      .update(wikiPages)
      .set({ status: 'draft' })
      .where(eq(wikiPages.id, page!.id));

    // Out of the sweep window, and held however it is reached.
    expect(await sweepAgentConsensus()).toEqual([]);
    expect(
      await runAgentConsensus({
        pendingEditId: edit!.id,
        approverUserId: peerA.userId,
      }),
    ).toEqual({ outcome: 'held', reason: 'target_unpublished' });
    expect((await collectConsensusFacts(edit!.id))?.disputeHoldCause).toBe('target_unpublished');
    expect((await collectConsensusFacts(edit!.id))?.hasOpenHumanDispute).toBe(true);
    const [held] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(held!.status).toBe('pending');
  });

  it('never attributes a publication to an implicit approval', async () => {
    const author = await seedAgent('author');
    const peerA = await seedAgent('peer-a');
    const peerB = await seedAgent('peer-b');
    await db
      .update(agents)
      .set({ selfReviewEnabled: true })
      .where(eq(agents.id, author.agentId));
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content: {
          version: 2,
          sections: { pk: { body: { type: 'doc', content: [] } } },
        },
        status: 'published',
        createdBy: author.userId,
        updatedBy: author.userId,
      })
      .returning({ id: wikiPages.id });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Halveringstiden er 20–100 timer.',
        proposedValue: {
          type: 'fact',
          attrs: { factId: 'f-1', referenceIds: [] },
          content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
        },
        submittedBy: author.userId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    await approve(peerA.agentId, edit!.id);
    await approve(peerB.agentId, edit!.id);
    // The author's own row is the implicit approval a bare resubmit records,
    // not an approval it cast.
    await db.insert(agentVerifications).values({
      agentId: author.agentId,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      rationaleMd: 'Forfatterens implisitte godkjenning.',
      evidenceRefs: [],
      isImplicit: true,
    });

    expect(
      await runAgentConsensus({
        pendingEditId: edit!.id,
        approverUserId: author.userId,
      }),
    ).toEqual({ outcome: 'held', reason: 'approver_ineligible' });
    expect(
      await runAgentConsensus({
        pendingEditId: edit!.id,
        approverUserId: peerB.userId,
      }),
    ).toEqual({ outcome: 'applied' });
    const [after] = await db
      .select({ reviewedBy: pendingEdits.reviewedBy })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, edit!.id));
    expect(after!.reviewedBy).toBe(peerB.userId);
  });
});
