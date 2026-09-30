/**
 * Phase 2 exit gate: adapter review packets preserve all the information an
 * agent currently receives from the queue, and leak nothing extra.
 *
 * The check is a round-trip, not a spot check. Every item
 * `GET /api/agent-verifications-queue` serves is re-hydrated through its
 * adapter, the resulting packet is projected *back* into the legacy payload
 * shape, and the two are compared key by key — including keys present on only
 * one side. A field the adapter silently dropped, renamed or reshaped shows up
 * as a divergence; so does one it added, because the queue's audience is blind
 * peer reviewers and anything extra is something they were not previously
 * trusted with.
 *
 * The legacy side is the real route against real SQL, not a fixture: the whole
 * point is that the two hydrations agree on rows the production queue actually
 * produced, cutover-blocking differences included.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { eq } from 'drizzle-orm';
import {
  agents,
  citations,
  drugParameterDiscussions,
  drugParameterRevisions,
  drugParameters,
  paperReviews,
  pdfRequests,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from '../../../db/schema.js';
import queueHandler from '../../../api/agent-verifications-queue.js';
import {
  actorContextFrom,
  KINETIX_SPACE,
} from '../../../api/_lib/knowledge-governance/actor-context.js';
import {
  registeredTargetTypes,
  resetKnowledgeTargetAdaptersForTests,
} from '../../../api/_lib/knowledge-governance/registry.js';
import { pendingEditAdapter } from '../../../api/_lib/knowledge-governance/adapters/kinetix/pending-edit.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import {
  describeDivergence,
  reconcileQueueBatch,
  type LegacyQueueItem,
} from '../../../api/_lib/knowledge-governance/shadow-queue.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;

/** The verifier the queue is fetched as: an active agent that authored nothing. */
const VERIFIER = actorContextFrom({
  userId: 0,
  role: 'contributor',
  capabilities: [],
  agent: {
    agentId: 0,
    slug: 'verifier-agent',
    selfReviewEnabled: false,
    modelTier: 'flagship',
  },
});

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
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

async function fetchQueue(
  callerUserId: number,
  query = '',
): Promise<LegacyQueueItem[]> {
  getUserFromRequestMock.mockResolvedValue({
    userId: callerUserId,
    role: 'contributor',
  });
  const req = {
    method: 'GET',
    url: `/api/agent-verifications-queue?minAgeMinutes=0&limit=100${query}`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await queueHandler(req, res);
  expect(state.statusCode).toBe(200);
  return JSON.parse(state.body).items as LegacyQueueItem[];
}

async function seedAgent(userId: number, slug: string): Promise<number> {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active' })
    .returning({ id: agents.id });
  return row!.id;
}

/**
 * One row of every queue-served target type, plus the baselines each needs.
 *
 * Deliberately not minimal: the interesting divergences hide in the enrichment
 * the queue does on top of the row it selected — a wiki revision's *previous*
 * revision, a paper review's full-text evidence, a pending edit's current drug
 * value or page content. A fixture with only bare rows would pass while every
 * one of those was silently missing from the adapter's packet.
 */
async function seedEveryTargetType(): Promise<{
  authorId: number;
  verifierId: number;
}> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author-agent',
    role: 'contributor',
  });
  const verifierId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier-agent',
    role: 'contributor',
  });
  await seedAgent(authorId, 'author-agent');
  await seedAgent(verifierId, 'verifier-agent');

  const drugId = await seedDrug(db, {
    slug: 'diazepam',
    names: { nb: 'Diazepam', en: 'Diazepam' },
  });
  await db
    .insert(drugParameters)
    .values({ drugId, parameter: 'halfLife', value: { value: 30 } });

  // drug_parameter_revision — with a citation and a prior value to diff against.
  const [citationRow] = await db
    .insert(citations)
    .values({ type: 'pmid', identifier: '24500275' })
    .returning({ id: citations.id });
  const citationId = citationRow!.id;
  await db.insert(drugParameterRevisions).values({
    drugId,
    parameter: 'halfLife',
    oldValue: { value: 20 },
    newValue: { value: 30 },
    editSummary: 'Oppdatert halveringstid',
    referenceIds: [citationId],
    createdBy: authorId,
  });

  // wiki_revision — two revisions on a published page, so the newer one has a
  // predecessor the queue must hydrate as the baseline.
  const [pageRow] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      content: { type: 'doc', content: [] },
      contentHtml: '<p>nå</p>',
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });
  const pageId = pageRow!.id;
  await db.insert(wikiRevisions).values({
    pageId,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    contentHtml: '<p>før</p>',
    editSummary: 'Første',
    createdBy: authorId,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  await db.insert(wikiRevisions).values({
    pageId,
    content: { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] },
    contentHtml: '<p>etter</p>',
    editSummary: 'Andre',
    createdBy: authorId,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  });

  // A second published page for the wiki_fact edit. It needs its own page
  // because the legacy queue's hydration depth is batch-dependent: a wiki_page
  // edit in the same batch upgrades every other edit on that page to full
  // hydration. That quirk gets its own test below, where it is the subject
  // rather than a confound.
  const [factPageRow] = await db
    .insert(wikiPages)
    .values({
      slug: 'oksazepam',
      title: 'Oksazepam',
      content: { type: 'doc', content: [] },
      contentHtml: '<p>oksazepam</p>',
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });
  const factPageId = factPageRow!.id;

  // paper_review — attests read-in-full while an open PDF request and no
  // stored PDF contradict it, which is the queue's `readInFullUnverified` case.
  const [reviewCitation] = await db
    .insert(citations)
    .values({
      type: 'doi',
      identifier: '10.1000/parity',
      metadata: { title: 'A paper', year: 2024 },
    })
    .returning({ id: citations.id });
  await db.insert(paperReviews).values({
    citationId: reviewCitation!.id,
    reviewMarkdown: '# Vurdering',
    overallScore: 72,
    conclusionSupport: 'supported',
    reviewConfidence: 'high',
    readInFull: true,
    createdBy: authorId,
  });
  await db.insert(pdfRequests).values({
    citationId: reviewCitation!.id,
    status: 'open',
    requestedBy: authorId,
  });

  // drug_discussion — a reply, so parentId is exercised rather than left null.
  const [rootComment] = await db
    .insert(drugParameterDiscussions)
    .values({
      drugId,
      parameter: 'halfLife',
      body: 'Hvor kommer denne verdien fra?',
      createdBy: authorId,
    })
    .returning({ id: drugParameterDiscussions.id });
  await db.insert(drugParameterDiscussions).values({
    drugId,
    parameter: 'halfLife',
    parentId: rootComment!.id,
    body: 'Fra referansen under.',
    createdBy: authorId,
  });

  // pending_edit — one per baseline branch: a parameter edit (drug name +
  // current value), a wiki_page edit (full page hydration incl. HTML), a
  // wiki_fact edit (content hydration, HTML withheld), and a paper_review edit
  // (whose targetId points at a citation, not a review).
  await db.insert(pendingEdits).values({
    editType: 'parameter',
    targetId: drugId,
    parameter: 'halfLife',
    proposedValue: { value: 33 },
    proposedMeta: { note: 'ny metaanalyse' },
    referenceIds: [citationId],
    submittedBy: authorId,
    status: 'pending',
  });
  await db.insert(pendingEdits).values({
    editType: 'wiki_page',
    targetId: pageId,
    proposedValue: { content: { type: 'doc', content: [] } },
    submittedBy: authorId,
    status: 'pending',
  });
  await db.insert(pendingEdits).values({
    editType: 'wiki_fact',
    targetId: factPageId,
    sectionId: 'pk',
    fieldId: 'halfLife',
    factOperation: 'add',
    factStatement: 'Halveringstiden er 30 timer.',
    factTargetAnchor: { factId: 'f-1' },
    proposedValue: { factStatement: 'Halveringstiden er 30 timer.' },
    referenceId: citationId,
    submittedBy: authorId,
    status: 'pending',
  });
  await db.insert(pendingEdits).values({
    editType: 'paper_review',
    targetId: reviewCitation!.id,
    proposedValue: { reviewMarkdown: '# Forslag' },
    submittedBy: authorId,
    status: 'pending',
  });

  return { authorId, verifierId, pageId, factPageId };
}

describe('adapter hydration vs the live verification queue', () => {
  it('registers an adapter for every target type the queue can serve', () => {
    // Phase 2's exit gate in one assertion: no served type is left without a
    // representation, and `learning_unit_revision` is covered too even though
    // the queue deliberately does not interleave it (Phase 0 doc §5.2).
    expect(registeredTargetTypes(KINETIX_SPACE)).toEqual([
      'drug_discussion',
      'drug_parameter_revision',
      'learning_unit_revision',
      'paper_review',
      'pending_edit',
      'wiki_revision',
    ]);
  });

  it('reproduces every served payload exactly, across every target type', async () => {
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId);

    // Guard the guard: an empty or single-type batch would let the parity
    // assertion pass without exercising anything.
    const servedTypes = [...new Set(items.map((i) => i.targetType))].sort();
    expect(servedTypes).toEqual([
      'drug_discussion',
      'drug_parameter_revision',
      'paper_review',
      'pending_edit',
      'wiki_revision',
    ]);

    const divergences = await reconcileQueueBatch(items, VERIFIER);
    expect(divergences.map(describeDivergence)).toEqual([]);
  });

  it('reproduces every pending_edit baseline branch', async () => {
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId, '&targetType=pending_edit');

    const editTypes = items
      .map((i) => (i.payload as { editType: string }).editType)
      .sort();
    expect(editTypes).toEqual([
      'paper_review',
      'parameter',
      'wiki_fact',
      'wiki_page',
    ]);

    // The enrichment is the part worth naming: a parameter edit must arrive
    // with the drug's Norwegian name and its current value, or a reviewer has
    // nothing to compare the proposal against.
    const parameterEdit = items.find(
      (i) => (i.payload as { editType: string }).editType === 'parameter',
    )!;
    expect(parameterEdit.payload.drugName).toBe('Diazepam');
    expect(parameterEdit.payload.currentValue).toEqual({ value: 30 });

    expect(
      (await reconcileQueueBatch(items, VERIFIER)).map(describeDivergence),
    ).toEqual([]);
  });

  it('reproduces the wiki revision’s previous-revision baseline', async () => {
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId, '&targetType=wiki_revision');
    const newest = items.find(
      (i) => (i.payload as { editSummary: string }).editSummary === 'Andre',
    )!;
    expect(newest.payload.previousContentHtml).toBe('<p>før</p>');
    expect(
      (await reconcileQueueBatch(items, VERIFIER)).map(describeDivergence),
    ).toEqual([]);
  });

  it('reproduces the paper review’s unsupported read-in-full flag', async () => {
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId, '&targetType=paper_review');
    expect(items).toHaveLength(1);
    expect(items[0]!.payload.readInFullUnverified).toBe(true);
    expect(
      (await reconcileQueueBatch(items, VERIFIER)).map(describeDivergence),
    ).toEqual([]);
  });

  it('reports a divergence rather than passing when hydration differs', async () => {
    // Negative control. Parity across five target types is only meaningful if
    // the comparison can fail — mutate the row out from under the served
    // payload and the reconciler must say so.
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId, '&targetType=drug_discussion');
    expect(items.length).toBeGreaterThan(0);

    await db
      .update(drugParameterDiscussions)
      .set({ body: 'endret etterpå' })
      .where(eq(drugParameterDiscussions.id, items[0]!.targetId));

    const divergences = await reconcileQueueBatch([items[0]!], VERIFIER);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({
      kind: 'field_mismatch',
      field: 'body',
      shadow: 'endret etterpå',
    });
  });

  it('reports a missing row rather than silently serving nothing', async () => {
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId, '&targetType=drug_discussion');
    await db
      .delete(drugParameterDiscussions)
      .where(eq(drugParameterDiscussions.id, items[0]!.targetId));

    const divergences = await reconcileQueueBatch([items[0]!], VERIFIER);
    expect(divergences).toEqual([
      expect.objectContaining({ kind: 'version_missing' }),
    ]);
  });
});

/**
 * A legacy behaviour this phase found and deliberately did not copy.
 *
 * `pendingEditPageHydrationFor` states the intended per-edit-type rule: a
 * `wiki_page` edit gets the page's rendered HTML, a `wiki_fact`/`wiki_section`
 * edit gets only the structured content. The queue then batches the page reads
 * and drops any page already in the full-hydration set from the content-only
 * set — so when one batch carries both kinds of edit against the *same* page,
 * the fact edit is served the HTML too. What a reviewer receives for a given
 * row therefore depends on which other rows happened to be in its batch.
 *
 * It is benign (the page is published, so the HTML is public either way) and it
 * is not the adapter's to fix: Phase 2 freezes behaviour and changes no
 * production path (§1.3). The adapter implements the stated per-row rule, the
 * reconciler reports the difference, and this test pins it so the divergence is
 * a recorded finding rather than a surprise when the queue is cut over.
 */
describe('known legacy divergence: batch-dependent page hydration', () => {
  it('serves a wiki_fact edit the page HTML when a wiki_page edit shares its batch', async () => {
    const { authorId, verifierId, pageId } = await seedEveryTargetType();
    // Same page as the existing wiki_page edit, which is what triggers it.
    await db.insert(pendingEdits).values({
      editType: 'wiki_fact',
      targetId: pageId,
      sectionId: 'pd',
      factOperation: 'add',
      factStatement: 'Virker på GABA-A.',
      proposedValue: { factStatement: 'Virker på GABA-A.' },
      submittedBy: authorId,
      status: 'pending',
    });

    const items = await fetchQueue(verifierId, '&targetType=pending_edit');
    const shared = items.find(
      (i) =>
        (i.payload as { editType: string; targetId: number }).editType ===
          'wiki_fact' &&
        (i.payload as { targetId: number }).targetId === pageId,
    )!;
    // The stated rule for wiki_fact is content-only; the batch upgraded it.
    expect(shared.payload.currentContentHtml).toBe('<p>nå</p>');

    const divergences = await reconcileQueueBatch([shared], VERIFIER);
    expect(divergences).toEqual([
      expect.objectContaining({
        kind: 'field_mismatch',
        field: 'currentContentHtml',
        legacy: '<p>nå</p>',
        shadow: null,
      }),
    ]);
  });

  it('serves the same edit content-only when it is alone in its batch', async () => {
    // The other half of the quirk: identical row, different batch, different
    // payload. This is what makes it batch-dependence rather than a rule.
    const { authorId, verifierId, pageId } = await seedEveryTargetType();
    await db.delete(pendingEdits).where(eq(pendingEdits.editType, 'wiki_page'));
    await db.insert(pendingEdits).values({
      editType: 'wiki_fact',
      targetId: pageId,
      sectionId: 'pd',
      factOperation: 'add',
      factStatement: 'Virker på GABA-A.',
      proposedValue: { factStatement: 'Virker på GABA-A.' },
      submittedBy: authorId,
      status: 'pending',
    });

    const items = await fetchQueue(verifierId, '&targetType=pending_edit');
    const alone = items.find(
      (i) =>
        (i.payload as { editType: string; targetId: number }).editType ===
          'wiki_fact' &&
        (i.payload as { targetId: number }).targetId === pageId,
    )!;
    expect(alone.payload.currentContentHtml).toBeNull();
    expect(
      (await reconcileQueueBatch([alone], VERIFIER)).map(describeDivergence),
    ).toEqual([]);
  });
});

describe('loadVersion withholds content a reviewer may not see', () => {
  /**
   * Codex P1. `loadVersion` fed `buildReviewPacket` through an id-only query,
   * so calling it directly for a `wiki_new` edit — or one against a draft page
   * — returned `proposedValue` and the packet disclosed it. The live queue
   * never serves those rows, but the adapter contract promised the same
   * guarantee and did not keep it, which is exactly what a future
   * adapter-backed queue or diagnostic would rely on.
   */
  const target = (id: number) => ({
    space: KINETIX_SPACE,
    type: 'pending_edit',
    id: String(id),
  });

  it('returns null for a wiki_new edit, which is always pre-publication', async () => {
    const { authorId } = await seedEveryTargetType();
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_new',
        proposedValue: { title: 'Upublisert monografi', body: 'hemmelig' },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    expect(await pendingEditAdapter.loadVersion(target(edit!.id))).toBeNull();
  });

  it('returns null for an edit against a draft page', async () => {
    const { authorId, factPageId } = await seedEveryTargetType();
    await db
      .update(wikiPages)
      .set({ status: 'draft' })
      .where(eq(wikiPages.id, factPageId));
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: factPageId,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: 'Utkast som ikke skal lekke.',
        proposedValue: { factStatement: 'Utkast som ikke skal lekke.' },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    expect(await pendingEditAdapter.loadVersion(target(edit!.id))).toBeNull();
  });

  it('still returns a published-page edit', async () => {
    // Guard the guard: a filter that hid everything would pass the two tests
    // above and break the whole adapter.
    await seedEveryTargetType();
    const [visible] = await db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(eq(pendingEdits.editType, 'wiki_fact'))
      .limit(1);
    expect(await pendingEditAdapter.loadVersion(target(visible!.id))).not.toBeNull();
  });

  it('returns the hidden row to the mirror, which needs complete history', async () => {
    // `includeHidden` exists for governance history, not for reviewers. A
    // wiki_new proposal never appears in a queue, but it still happened —
    // excluding it would make every one a permanent `missing_proposal`.
    const { authorId } = await seedEveryTargetType();
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_new',
        proposedValue: { title: 'Upublisert monografi' },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    const version = await pendingEditAdapter.loadVersion(target(edit!.id), {
      includeHidden: true,
    });
    expect(version).not.toBeNull();
    expect((version!.payload as { editType: string }).editType).toBe('wiki_new');
  });
});

describe('reviewer packets carry no assurance state', () => {
  it('serves no verdict, tally or dispute signal for any target type', async () => {
    const { verifierId } = await seedEveryTargetType();
    const items = await fetchQueue(verifierId);
    const { buildShadowQueueItem } = await import(
      '../../../api/_lib/knowledge-governance/shadow-queue.js'
    );

    for (const item of items) {
      const shadow = await buildShadowQueueItem(item, VERIFIER);
      expect(shadow).not.toBeNull();
      const serialised = JSON.stringify(shadow!.packet);
      // `sealReviewPacket` already refuses to build a leaking packet; this is
      // the belt to that braces, phrased in terms of the vocabulary an agent
      // would recognise rather than the key names the guard matches.
      for (const forbidden of ['approveCount', 'disputeCount', 'verdict', 'quorum']) {
        expect(serialised).not.toContain(forbidden);
      }
    }
  });
});
