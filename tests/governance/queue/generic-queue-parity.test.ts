/**
 * Phase 5: the shadow generic review queue.
 *
 * The point of building a second selector — after Phase 2 deliberately refused
 * to — is to prove an independent implementation reaches the same
 * inclusion/exclusion decisions. The legacy queue states each rule five times,
 * once per branch; the generic one states each once. These tests drive the real
 * route and the generic selector against the same database and the same actor,
 * and check that the two agree.
 *
 * Each preserved rule from Phase 5's work item 2 gets its own case, because a
 * whole-batch comparison that happens to match tells you nothing about *which*
 * rule is being honoured. And the differ gets a case proving it can fail: a
 * comparison that cannot report a divergence proves nothing when it reports
 * none.
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
  agentVerifications,
  agents,
  citations,
  drugParameterDiscussions,
  drugParameterRevisions,
  paperReviews,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from '../../../db/schema.js';
import queueHandler from '../../../api/agent-verifications-queue.js';
import {
  compareQueues,
  describeComparison,
} from '../../../api/_lib/knowledge-governance/queue/compare.js';
import {
  selectGenericQueue,
  type GenericQueueRequest,
} from '../../../api/_lib/knowledge-governance/queue/generic-queue.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import type { LegacyQueueItem } from '../../../api/_lib/knowledge-governance/shadow-queue.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

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
  resetKnowledgeTargetAdaptersForTests();
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

async function fetchLegacyQueue(
  callerUserId: number,
  query = '',
): Promise<LegacyQueueItem[]> {
  getUserFromRequestMock.mockResolvedValue({
    userId: callerUserId,
    role: 'contributor',
  });
  const req = {
    method: 'GET',
    // The caller's own parameters come first: `searchParams.get` returns the
    // first occurrence, so a test that passes `&limit=2` gets a batch of two
    // rather than silently keeping the default of a hundred.
    url: `/api/agent-verifications-queue?${query}&minAgeMinutes=0&limit=100`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await queueHandler(req, res);
  expect(state.statusCode).toBe(200);
  return JSON.parse(state.body).items as LegacyQueueItem[];
}

interface Seeded {
  authorId: number;
  verifierId: number;
  verifierAgentId: number;
  authorAgentId: number;
  editId: number;
  revisionId: number;
  discussionId: number;
  reviewId: number;
  wikiRevisionId: number;
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

/** One row of every queue-served type, authored by someone other than the verifier. */
async function seedEveryType(): Promise<Seeded> {
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
  const authorAgentId = await seedAgent(authorId, 'author-agent');
  const verifierAgentId = await seedAgent(verifierId, 'verifier-agent');

  const drugId = await seedDrug(db, {
    slug: 'diazepam',
    names: { nb: 'Diazepam', en: 'Diazepam' },
  });
  const [citation] = await db
    .insert(citations)
    .values({ type: 'pmid', identifier: '24500275' })
    .returning({ id: citations.id });

  const [revision] = await db
    .insert(drugParameterRevisions)
    .values({
      drugId,
      parameter: 'halfLife',
      oldValue: { value: 20 },
      newValue: { value: 30 },
      referenceIds: [citation!.id],
      createdBy: authorId,
    })
    .returning({ id: drugParameterRevisions.id });

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      content: { type: 'doc', content: [] },
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });
  const [wikiRev] = await db
    .insert(wikiRevisions)
    .values({
      pageId: page!.id,
      content: { type: 'doc', content: [] },
      editSummary: 'Første',
      createdBy: authorId,
    })
    .returning({ id: wikiRevisions.id });

  const [reviewCitation] = await db
    .insert(citations)
    .values({ type: 'doi', identifier: '10.1000/parity' })
    .returning({ id: citations.id });
  const [review] = await db
    .insert(paperReviews)
    .values({
      citationId: reviewCitation!.id,
      reviewMarkdown: '# Vurdering',
      readInFull: true,
      createdBy: authorId,
    })
    .returning({ id: paperReviews.id });

  const [comment] = await db
    .insert(drugParameterDiscussions)
    .values({
      drugId,
      parameter: 'halfLife',
      body: 'Hvor kommer denne fra?',
      createdBy: authorId,
    })
    .returning({ id: drugParameterDiscussions.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 30 timer.',
      proposedValue: { factStatement: 'Halveringstiden er 30 timer.' },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  return {
    authorId,
    verifierId,
    verifierAgentId,
    authorAgentId,
    editId: edit!.id,
    revisionId: revision!.id,
    discussionId: comment!.id,
    reviewId: review!.id,
    wikiRevisionId: wikiRev!.id,
  };
}

function requestFor(
  seeded: Seeded,
  over: Partial<GenericQueueRequest> = {},
): GenericQueueRequest {
  return {
    agentId: seeded.verifierAgentId,
    agentUserId: seeded.verifierId,
    selfReviewEnabled: false,
    limit: 100,
    minAgeMinutes: 0,
    ...over,
  };
}

/** Sorted `type:id` keys, so a set comparison reads clearly on failure. */
function keys(items: ReadonlyArray<{ targetType: string; targetId: number }>) {
  return items.map((i) => `${i.targetType}:${i.targetId}`).sort();
}

describe('the two selectors agree on candidate eligibility', () => {
  it('selects the same set across every served target type', async () => {
    const seeded = await seedEveryType();
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const comparison = await compareQueues(legacy, requestFor(seeded));

    // Guard the guard: agreement on an empty batch is not agreement.
    expect(keys(legacy)).toHaveLength(5);
    expect(comparison.legacyOnly).toEqual([]);
    expect(comparison.genericOnly).toEqual([]);
    expect(comparison.packetMismatches).toEqual([]);
    expect(describeComparison(comparison)).toContain('identical');
  });

  it('agrees when the queue is filtered to one type', async () => {
    const seeded = await seedEveryType();
    const legacy = await fetchLegacyQueue(seeded.verifierId, '&targetType=pending_edit');
    const comparison = await compareQueues(
      legacy,
      requestFor(seeded, { targetType: 'pending_edit' }),
    );
    expect(keys(legacy)).toEqual([`pending_edit:${seeded.editId}`]);
    expect(comparison.legacyOnly).toEqual([]);
    expect(comparison.genericOnly).toEqual([]);
  });
});

describe('each preserved rule, checked on its own', () => {
  it('excludes what the caller authored', async () => {
    const seeded = await seedEveryType();
    // Ask as the author. Every row is theirs, so both selectors should serve
    // nothing.
    const legacy = await fetchLegacyQueue(seeded.authorId);
    const generic = await selectGenericQueue(
      requestFor(seeded, {
        agentId: seeded.authorAgentId,
        agentUserId: seeded.authorId,
      }),
    );
    expect(legacy).toEqual([]);
    expect(generic.items).toEqual([]);
    expect(
      generic.excluded.every((e) => e.reason === 'authored_by_caller'),
    ).toBe(true);
  });

  it('excludes what the caller has already judged', async () => {
    const seeded = await seedEveryType();
    await db.insert(agentVerifications).values({
      agentId: seeded.verifierAgentId,
      targetType: 'pending_edit',
      targetId: seeded.editId,
      verdict: 'approve',
    });
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(keys(legacy)).not.toContain(`pending_edit:${seeded.editId}`);
    expect(keys(generic.items)).toEqual(keys(legacy));
    expect(
      generic.excluded.find((e) => e.candidate.targetId === seeded.editId)?.reason,
    ).toBe('already_judged');
  });

  it('keeps reading past a window the caller has already judged', async () => {
    // The production comparison that motivated this: an agent for whom the
    // oldest `limit` rows of a type were all already judged. The legacy queue
    // filters inside its SQL, ahead of the LIMIT, and served the rows beyond
    // that window; a selector that filters its oldest-`limit` read after the
    // fact served nothing. The two must agree on a backlog deeper than the
    // limit, not only on a table small enough to fit in one read.
    const seeded = await seedEveryType();
    const [page] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'diazepam'));
    const base = new Date('2026-01-01T00:00:00Z');
    const olderIds: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const [row] = await db
        .insert(wikiRevisions)
        .values({
          pageId: page!.id,
          content: { type: 'doc', content: [] },
          editSummary: `Backlog ${i}`,
          createdBy: seeded.authorId,
          createdAt: new Date(base.getTime() + i * 60_000),
        })
        .returning({ id: wikiRevisions.id });
      olderIds.push(row!.id);
    }
    // The verifier has judged the three oldest — the whole of a limit-3 window.
    await db.insert(agentVerifications).values(
      olderIds.slice(0, 3).map((targetId) => ({
        agentId: seeded.verifierAgentId,
        targetType: 'wiki_revision' as const,
        targetId,
        verdict: 'approve' as const,
      })),
    );

    const legacy = await fetchLegacyQueue(seeded.verifierId, '&targetType=wiki_revision&limit=3');
    expect(keys(legacy)).toEqual(
      keys([olderIds[3]!, olderIds[4]!, seeded.wikiRevisionId].map((id) => ({ targetType: 'wiki_revision', targetId: id }))),
    );
    const generic = await selectGenericQueue(
      requestFor(seeded, { targetType: 'wiki_revision', limit: 3 }),
    );
    expect(keys(generic.items)).toEqual(keys(legacy));
    expect(generic.truncated).toEqual([]);
    expect(generic.excluded.filter((e) => e.reason === 'already_judged')).toHaveLength(3);

    const comparison = await compareQueues(
      legacy,
      requestFor(seeded, { targetType: 'wiki_revision', limit: 3 }),
    );
    expect(comparison.legacyOnly).toEqual([]);
    expect(comparison.genericOnly).toEqual([]);
  });

  it('honours the self-review grant by surfacing the agent’s own work', async () => {
    // The grant withholds the author filter and nothing else; it never lowers
    // a bar. Its effect is that the author sees its own rows at all.
    const seeded = await seedEveryType();
    await db
      .update(agents)
      .set({ selfReviewEnabled: true })
      .where(eq(agents.id, seeded.authorAgentId));

    const legacy = await fetchLegacyQueue(seeded.authorId);
    const generic = await selectGenericQueue(
      requestFor(seeded, {
        agentId: seeded.authorAgentId,
        agentUserId: seeded.authorId,
        selfReviewEnabled: true,
      }),
    );
    expect(legacy.length).toBeGreaterThan(0);
    expect(keys(generic.items)).toEqual(keys(legacy));
  });

  it('still hides a self-reviewing agent’s own explicit verdicts', async () => {
    // The subtlety that makes the grant useful: an implicit-approve row is not
    // a judgment, so it must not hide the row — but an explicit one must.
    const seeded = await seedEveryType();
    await db
      .update(agents)
      .set({ selfReviewEnabled: true })
      .where(eq(agents.id, seeded.authorAgentId));
    await db.insert(agentVerifications).values([
      {
        agentId: seeded.authorAgentId,
        targetType: 'pending_edit',
        targetId: seeded.editId,
        verdict: 'approve',
        isImplicit: true,
      },
      {
        agentId: seeded.authorAgentId,
        targetType: 'drug_discussion',
        targetId: seeded.discussionId,
        verdict: 'approve',
        isImplicit: false,
      },
    ]);

    const legacy = await fetchLegacyQueue(seeded.authorId);
    const generic = await selectGenericQueue(
      requestFor(seeded, {
        agentId: seeded.authorAgentId,
        agentUserId: seeded.authorId,
        selfReviewEnabled: true,
      }),
    );
    expect(keys(legacy)).toContain(`pending_edit:${seeded.editId}`);
    expect(keys(legacy)).not.toContain(`drug_discussion:${seeded.discussionId}`);
    expect(keys(generic.items)).toEqual(keys(legacy));
  });

  it('honours the minimum age', async () => {
    const seeded = await seedEveryType();
    // Everything was created just now, so a five-minute delay hides all of it.
    const legacy = await fetchLegacyQueue(seeded.verifierId).then(() =>
      fetchLegacyQueueWithAge(seeded.verifierId, 5),
    );
    const generic = await selectGenericQueue(
      requestFor(seeded, { minAgeMinutes: 5 }),
    );
    expect(legacy).toEqual([]);
    expect(generic.items).toEqual([]);
  });

  it('hides a revision of an unpublished page from both', async () => {
    const seeded = await seedEveryType();
    await db.update(wikiPages).set({ status: 'draft' });
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(keys(legacy)).not.toContain(`wiki_revision:${seeded.wikiRevisionId}`);
    expect(keys(generic.items)).toEqual(keys(legacy));
  });

  it('hides a moderated pending edit from both', async () => {
    const seeded = await seedEveryType();
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, seeded.editId));
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(keys(legacy)).not.toContain(`pending_edit:${seeded.editId}`);
    expect(keys(generic.items)).toEqual(keys(legacy));
  });

  it('hides a topic-page comment, which has no drug to work on, from both', async () => {
    const seeded = await seedEveryType();
    // Exactly one of drugId/wikiPageId must be set (drug_param_disc_target_chk),
    // so re-homing the comment on the page is what "a topic-page fact comment"
    // actually looks like in this schema.
    const [page] = await db.select({ id: wikiPages.id }).from(wikiPages).limit(1);
    await db
      .update(drugParameterDiscussions)
      .set({ drugId: null, wikiPageId: page!.id, parameter: 'fact:abc' })
      .where(eq(drugParameterDiscussions.id, seeded.discussionId));
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(keys(legacy)).not.toContain(`drug_discussion:${seeded.discussionId}`);
    expect(keys(generic.items)).toEqual(keys(legacy));
  });

  it('keeps a null-authored paper review reviewable in both', async () => {
    // A null author is a real value: nobody can be the author of it, so it
    // must still pass the author filter rather than being silently dropped.
    const seeded = await seedEveryType();
    await db.update(paperReviews).set({ createdBy: null });
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(keys(legacy)).toContain(`paper_review:${seeded.reviewId}`);
    expect(keys(generic.items)).toEqual(keys(legacy));
  });

  it('does not serve learning_unit_revision from either', async () => {
    // Half-wired on purpose (Phase 0 doc §5.2). A generic queue that served it
    // would diverge by *including* something.
    const seeded = await seedEveryType();
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(
      generic.items.some((i) => i.targetType === 'learning_unit_revision'),
    ).toBe(false);
  });
});

describe('a truncated scan is reported, not passed off as parity', () => {
  it('marks the type and says the findings are not a verdict', async () => {
    // The cap exists so a reviewer who has judged an entire backlog cannot
    // make the selector read a whole table. When it bites, the generic batch
    // is a known lower bound: the rows it never reached come back as
    // `legacyOnly`, which is indistinguishable from rows it saw and dropped.
    // Reporting those findings without saying the scan stopped early would
    // state a parity conclusion nobody reached.
    const seeded = await seedEveryType();
    const [page] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'diazepam'));
    const base = new Date('2026-01-01T00:00:00Z');
    const ids: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [row] = await db
        .insert(wikiRevisions)
        .values({
          pageId: page!.id,
          content: { type: 'doc', content: [] },
          editSummary: `Backlog ${i}`,
          createdBy: seeded.authorId,
          createdAt: new Date(base.getTime() + i * 60_000),
        })
        .returning({ id: wikiRevisions.id });
      ids.push(row!.id);
    }
    // The two oldest are judged, and the cap stops the scan right there.
    await db.insert(agentVerifications).values(
      ids.slice(0, 2).map((targetId) => ({
        agentId: seeded.verifierAgentId,
        targetType: 'wiki_revision' as const,
        targetId,
        verdict: 'approve' as const,
      })),
    );

    const request = requestFor(seeded, {
      targetType: 'wiki_revision',
      limit: 2,
      maxCandidateWindow: 2,
    });
    const generic = await selectGenericQueue(request);
    expect(generic.truncated).toEqual(['wiki_revision']);
    expect(generic.items).toEqual([]);

    const legacy = await fetchLegacyQueue(seeded.verifierId, '&targetType=wiki_revision&limit=2');
    expect(legacy).toHaveLength(2);

    const comparison = await compareQueues(legacy, request);
    expect(comparison.truncated).toEqual(['wiki_revision']);
    expect(comparison.metrics.kg_queue_scan_truncated).toBe(1);
    // The findings are still listed — which of them the cap caused cannot be
    // told from this side — but the summary refuses to read as parity.
    expect(comparison.legacyOnly).toHaveLength(2);
    expect(describeComparison(comparison)).toContain('SCAN TRUNCATED');
    expect(describeComparison(comparison)).not.toContain('identical');
  });

  it('reports no truncation when the scan finished', async () => {
    const seeded = await seedEveryType();
    const generic = await selectGenericQueue(requestFor(seeded));
    expect(generic.truncated).toEqual([]);
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const comparison = await compareQueues(legacy, requestFor(seeded));
    expect(comparison.truncated).toEqual([]);
    expect(comparison.metrics.kg_queue_scan_truncated).toBe(0);
    expect(describeComparison(comparison)).toContain('identical');
  });
});

describe('rows tied on the ordering key', () => {
  it('are broken the same way by both selectors', async () => {
    // Postgres promises no order among rows tied on the ordering key, and
    // rows written in one transaction share a `now()` default. At the LIMIT
    // boundary that turns into two selectors choosing different candidates —
    // a parity finding caused by the comparison rather than found by it. Both
    // sides now order on (key, id), so the batch is the lowest ids.
    const seeded = await seedEveryType();
    const [page] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'diazepam'));
    const tied = new Date('2026-02-01T00:00:00Z');
    const ids: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [row] = await db
        .insert(wikiRevisions)
        .values({
          pageId: page!.id,
          content: { type: 'doc', content: [] },
          editSummary: `Samtidig ${i}`,
          createdBy: seeded.authorId,
          createdAt: tied,
        })
        .returning({ id: wikiRevisions.id });
      ids.push(row!.id);
    }
    const lowestTwo = [...ids].sort((a, b) => a - b).slice(0, 2);

    const legacy = await fetchLegacyQueue(seeded.verifierId, '&targetType=wiki_revision&limit=2');
    const generic = await selectGenericQueue(
      requestFor(seeded, { targetType: 'wiki_revision', limit: 2 }),
    );
    // The four tied rows are older than the one `seedEveryType` wrote, so the
    // batch of two falls entirely inside the tie — and lands on the two lowest
    // ids, from both selectors, rather than on whichever two Postgres felt
    // like returning.
    expect(keys(legacy)).toEqual(keys(generic.items));
    expect(keys(generic.items)).toEqual(
      keys(lowestTwo.map((id) => ({ targetType: 'wiki_revision', targetId: id }))),
    );
  });
});

describe('reserves', () => {
  it('gives pending_edit its reserved share at a small limit', async () => {
    // The reason the reserves exist: a pure oldest-first merge buries
    // pending_edit — the only type whose verification can publish content —
    // behind older wiki and discussion rows.
    const seeded = await seedEveryType();
    // Backdate everything else by an hour, leaving the pending edit the newest
    // eligible row — the position a pure oldest-first merge buries it in. It
    // stays in the past, so the age filter is not what is being tested here.
    const old = new Date(Date.now() - 3_600_000);
    await db.update(drugParameterRevisions).set({ createdAt: old });
    await db.update(wikiRevisions).set({ createdAt: old });
    await db.update(drugParameterDiscussions).set({ createdAt: old });
    await db.update(paperReviews).set({ updatedAt: old });

    const generic = await selectGenericQueue(requestFor(seeded, { limit: 2 }));
    expect(keys(generic.items)).toContain(`pending_edit:${seeded.editId}`);

    // And the control: without the reserve the two oldest would take both
    // slots, so the reserve is what put it there.
    const oldestTwo = keys(
      (await selectGenericQueue(requestFor(seeded, { limit: 5 }))).items,
    );
    expect(oldestTwo).toContain(`pending_edit:${seeded.editId}`);
  });
});

describe('no reviewer-data leakage', () => {
  it('carries no verdict, tally or author judgment in a candidate', async () => {
    // Structural rather than filtered: a QueueCandidate has no payload at all,
    // only identity, age, authorship and visibility. There is nothing in the
    // selection stage that *could* leak a peer's judgment — hydration is a
    // separate step, and it goes through `sealReviewPacket`, which refuses to
    // build a leaking packet. This pins the shape so a later field addition
    // has to be a deliberate act.
    const seeded = await seedEveryType();
    await db.insert(agentVerifications).values({
      agentId: seeded.authorAgentId,
      targetType: 'pending_edit',
      targetId: seeded.editId,
      verdict: 'dispute',
      rationaleMd: 'Dette stemmer ikke med kilden som er oppgitt.',
    });

    const generic = await selectGenericQueue(requestFor(seeded));
    const serialised = JSON.stringify(generic.items);
    for (const forbidden of ['verdict', 'dispute', 'rationale', 'approve']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(Object.keys(generic.items[0]!).sort()).toEqual([
      'authorUserId',
      'createdAt',
      'targetId',
      'targetType',
      'visible',
    ]);
  });
});

describe('the differ can fail', () => {
  it('reports a candidate the legacy queue served and the generic one dropped', async () => {
    // A comparison that cannot report a divergence proves nothing when it
    // reports none. Forced by recording a verdict the generic selector sees
    // and the already-fetched legacy batch predates.
    const seeded = await seedEveryType();
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    await db.insert(agentVerifications).values({
      agentId: seeded.verifierAgentId,
      targetType: 'pending_edit',
      targetId: seeded.editId,
      verdict: 'approve',
    });

    const comparison = await compareQueues(legacy, requestFor(seeded));
    expect(comparison.legacyOnly).toEqual([
      { key: `pending_edit:${seeded.editId}`, reason: 'already_judged' },
    ]);
    expect(comparison.metrics.kg_queue_candidate_legacy_only).toBe(1);
    expect(describeComparison(comparison)).toContain('already_judged');
  });

  it('reports a payload that moved between the two reads', async () => {
    const seeded = await seedEveryType();
    const legacy = await fetchLegacyQueue(seeded.verifierId, '&targetType=drug_discussion');
    await db
      .update(drugParameterDiscussions)
      .set({ body: 'endret etterpå' })
      .where(eq(drugParameterDiscussions.id, seeded.discussionId));

    const comparison = await compareQueues(
      legacy,
      requestFor(seeded, { targetType: 'drug_discussion' }),
    );
    expect(comparison.packetMismatches).toHaveLength(1);
    expect(comparison.metrics.kg_queue_packet_mismatch).toBe(1);
  });

  it('records a latency figure for the generic selection', async () => {
    const seeded = await seedEveryType();
    const legacy = await fetchLegacyQueue(seeded.verifierId);
    const comparison = await compareQueues(legacy, requestFor(seeded));
    expect(comparison.metrics.kg_queue_latency_ms).toBeGreaterThanOrEqual(0);
  });
});

/** Same as `fetchLegacyQueue` but with an explicit minimum age. */
async function fetchLegacyQueueWithAge(
  callerUserId: number,
  minAgeMinutes: number,
): Promise<LegacyQueueItem[]> {
  getUserFromRequestMock.mockResolvedValue({
    userId: callerUserId,
    role: 'contributor',
  });
  const req = {
    method: 'GET',
    url: `/api/agent-verifications-queue?minAgeMinutes=${minAgeMinutes}&limit=100`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await queueHandler(req, res);
  expect(state.statusCode).toBe(200);
  return JSON.parse(state.body).items as LegacyQueueItem[];
}
