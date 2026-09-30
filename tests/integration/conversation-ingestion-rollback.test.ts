/**
 * What conversation ingestion leaves behind when a fact's approval fails.
 *
 * Staging the `wiki_fact` pending edit and approving it are two commits: the
 * insert lands first, and if `applyApprovedEdit` then throws — a transient
 * database error, or a target that moved between the re-plan and the write —
 * the run reports the item as FAILED while a perfectly ordinary `pending`
 * proposal sits in the review queue, ready for someone to approve later. That
 * would publish content outside the receipt the admin was shown.
 *
 * The failure is injected rather than provoked, and deliberately so: every
 * natural way to break the approval (a deleted page, a moved fact, a corrupted
 * body) is caught by the re-plan that runs immediately before it, so nothing is
 * ever staged. Only a failure *after* staging reaches this branch, and in a
 * single-threaded test the only honest way to produce one is to make the
 * approval throw.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

let failApproval = false;
let failReview = false;

vi.mock('../../api/_lib/paper-review-store.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../api/_lib/paper-review-store.js')
  >();
  return {
    ...actual,
    recordPaperReview: async (
      args: Parameters<typeof actual.recordPaperReview>[0],
    ) => {
      if (failReview) throw new Error('injected review-write failure');
      return actual.recordPaperReview(args);
    },
  };
});

vi.mock('../../api/_lib/pending-edits-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../api/_lib/pending-edits-helpers.js')
  >();
  return {
    ...actual,
    applyApprovedEdit: async (editId: number, reviewerId: number) => {
      if (failApproval) throw new Error('injected approval failure');
      return actual.applyApprovedEdit(editId, reviewerId);
    },
  };
});

import { citations, paperReviews, pendingEdits, wikiPages } from '../../db/schema.js';
import { parseConversationIngestion } from '../../src/lib/conversationIngestion.js';
import { applyIngestion } from '../../api/_lib/conversationIngestionStore.js';
import { ensureDrugMonograph } from '../../api/_lib/monograph-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let monographId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  failApproval = false;
  failReview = false;
  await resetIntegrationDb(db);
  userId = await seedUser(db, {
    email: 'ingest@example.com',
    username: 'ingester',
    role: 'admin',
  });
  const drugId = await seedDrug(db, {
    slug: 'morfin',
    names: { nb: 'Morfin', en: 'Morphine' },
    pubchemCid: 5288826,
    searchKey: 'morfin\tmorphine',
  });
  const ensured = await ensureDrugMonograph(
    db as never,
    { id: drugId, names: { nb: 'Morfin', en: 'Morphine' }, pubchemCid: 5288826 },
    userId,
  );
  monographId = ensured.page.id;
});

const BUNDLE = {
  schemaVersion: 'kinetix-conversation-ingestion-v1',
  idempotencyKey: 'conv-rollback-01',
  mode: 'auto',
  conversationDigest: 'a'.repeat(64),
  createdAt: '2026-08-06T09:12:00Z',
  sources: [
    {
      key: 'S1',
      type: 'pmid',
      identifier: '10201674',
      verification: {
        readInFull: true,
        locator: 'Results',
        evidenceSummary: 'Cardiac/peripheral ratio varies with decomposition.',
        reviewMarkdown: 'Retrospective case series with paired sampling sites.',
      },
    },
  ],
  items: [
    {
      type: 'wiki_fact',
      target: {
        pageType: 'monograph',
        drug: { drugName: 'Morphine', pubchemCid: 5288826 },
        sectionId: 'forensic',
      },
      operation: 'add',
      statement: 'Forholdet varierer med forråtnelsesgrad.',
      sourceKeys: ['S1'],
      editSummary: 'Ny setning.',
    },
  ],
};

function parse() {
  const parsed = parseConversationIngestion(BUNDLE);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.data;
}

describe('conversation ingestion — approval failure', () => {
  it('retires the staged fact instead of leaving it in the review queue', async () => {
    failApproval = true;
    const result = await applyIngestion(parse(), { userId, accept: [0] });

    expect(result.items[0]).toMatchObject({ status: 'failed', reason: 'write_failed' });

    const rows = await db.select().from(pendingEdits);
    expect(rows).toHaveLength(1);
    // Not `pending`: a failed item must not be approvable by a reviewer who
    // never saw this run.
    expect(rows[0]).toMatchObject({ status: 'rejected', reviewedBy: userId });

    // And nothing reached the page.
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    expect(JSON.stringify(page!.content)).not.toContain('forråtnelsesgrad');
  });

  it('confines a source-write failure to its own item', async () => {
    // Two accepted items citing different sources. The first item's review
    // write throws; the second must still be attempted and land, and the run
    // must return a per-item receipt rather than an error page that says
    // nothing about what committed.
    failReview = true;
    const doc = parseConversationIngestion({
      ...BUNDLE,
      idempotencyKey: 'conv-rollback-02',
      items: [
        BUNDLE.items[0],
        {
          ...BUNDLE.items[0],
          statement: 'En annen setning.',
          editSummary: 'Andre setning.',
        },
      ],
    });
    if (!doc.ok) throw new Error(doc.errors.join('; '));

    // Without the per-item boundary this call throws and there is no receipt
    // at all — that is what the test discriminates.
    const result = await applyIngestion(doc.data, { userId, accept: [0, 1] });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ status: 'failed', reason: 'write_failed' });
    // The second item is still attempted, and reports its own failure rather
    // than silently producing nothing: a source whose review write threw is not
    // recorded as committed, so this item retries it and fails on its own.
    expect(result.items[1]).toMatchObject({ status: 'failed', reason: 'write_failed' });
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
  });

  it('confines a source-write failure without stopping unrelated items', async () => {
    // Same failure, but only the first item is accepted: the run still returns
    // a receipt, and nothing is left half-written.
    failReview = true;
    const result = await applyIngestion(parse(), { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 0, failed: 1 });
    expect(result.reviewsRecorded).toBe(0);
    expect(await db.select().from(pendingEdits)).toHaveLength(0);

    // The citation and its review are one unit: a failed review write must not
    // leave the citation behind. A receipt saying "no reviews recorded" beside
    // a live row is the pairing this guards against.
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(paperReviews)).toHaveLength(0);
  });

  it('still applies normally when the approval succeeds', async () => {
    const result = await applyIngestion(parse(), { userId, accept: [0] });

    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
    const rows = await db.select().from(pendingEdits);
    expect(rows[0]!.status).toBe('approved');
  });
});
