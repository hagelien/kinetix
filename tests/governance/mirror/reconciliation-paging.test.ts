/**
 * The reconciliation scanner past its first page.
 *
 * ## The bug this exists for
 *
 * Every scan ordered by id and took the first `limit` rows, so it always read
 * the *oldest* window and never advanced. Once production held more rows than
 * the limit, every missing mirror among the newer ones was permanently
 * invisible — and the scan went on reporting zero divergences, because there
 * genuinely were none in the window it read.
 *
 * That is the failure mode this whole migration is built to avoid, aimed at the
 * instrument itself: the Phase 4 exit gate is "unexplained mirror loss = 0
 * after reconciliation", which is a claim about a table, and the scanner could
 * only ever support a claim about its first page. A clean truncated scan and a
 * clean complete scan produced identical output.
 *
 * ## What replaced it
 *
 * `reconcile` takes a cursor and reports `truncated` and `nextCursor`;
 * `reconcileAll` walks to the end and reports `complete`. Everything that gates
 * on "no divergences" — the dossier and the definition-of-done audit — uses the
 * complete walk and treats an unfinished scan as unproven rather than clean.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pendingEdits, wikiPages } from '../../../db/schema.js';
import {
  reconcile,
  reconcileAll,
} from '../../../api/_lib/knowledge-governance/reconciliation.js';
import { definitionOfDone } from '../../../api/_lib/knowledge-governance/definition-of-done.js';
import {
  buildDossier,
  readinessBlockers,
} from '../../../api/_lib/knowledge-governance/dossier.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { mirrorProposalVersion } from '../../../api/_lib/knowledge-governance/mirror.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
});

/**
 * `count` pending edits, of which the first `mirrored` are mirrored.
 *
 * The shape that matters: the loss is at the END of the table, which is where a
 * first-page scan cannot see it and where new production rows actually land.
 */
async function seedEdits(count: number, mirrored: number): Promise<number[]> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      pageType: 'drug_monograph',
      content: { version: 2, sections: { pk: { body: { type: 'doc', content: [] } } } },
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });

  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  invalidateMigrationStateCache();

  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement: `Påstand nummer ${i}.`,
        proposedValue: {
          type: 'fact',
          attrs: { factId: `fact-${i}`, referenceIds: [] },
          content: [{ type: 'text', text: `Påstand nummer ${i}.` }],
        },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    ids.push(edit!.id);
    if (i < mirrored) {
      const outcome = await mirrorProposalVersion({
        targetType: 'pending_edit',
        targetId: edit!.id,
        legacyPendingEditId: edit!.id,
      });
      expect(outcome.mirrored).toBe(true);
    }
  }
  return ids;
}

describe('one page is one page, and says so', () => {
  it('reports truncation and a cursor when it fills its limit', async () => {
    await seedEdits(7, 7);
    const page = await reconcile(db, { limit: 3 });
    expect(page.examined.pendingEdits).toBe(3);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor?.pendingEditId).toBeDefined();
  });

  it('reports neither once it reaches the end', async () => {
    await seedEdits(2, 2);
    const page = await reconcile(db, { limit: 3 });
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('resumes after the cursor rather than restarting', async () => {
    const ids = await seedEdits(7, 7);
    const first = await reconcile(db, { limit: 3 });
    expect(first.nextCursor!.pendingEditId).toBe(ids[2]);
    const second = await reconcile(db, { limit: 3, after: first.nextCursor! });
    expect(second.nextCursor!.pendingEditId).toBe(ids[5]);
  });
});

describe('the loss at the end of the table', () => {
  it('is invisible to a single page, which is exactly the bug', async () => {
    // Seven edits, the oldest five mirrored. A three-row scan reads the oldest
    // three, finds them all clean, and reports zero divergences — truthfully,
    // and uselessly. This assertion is the old behaviour, kept so the reason
    // for `truncated` is visible rather than argued.
    await seedEdits(7, 5);
    const page = await reconcile(db, { limit: 3 });
    expect(page.divergences).toHaveLength(0);
    // The only thing distinguishing this from a genuinely clean table:
    expect(page.truncated).toBe(true);
  });

  it('is found by the complete walk', async () => {
    const ids = await seedEdits(7, 5);
    const full = await reconcileAll(db, { limit: 3 });
    expect(full.complete).toBe(true);
    expect(full.examined.pendingEdits).toBe(7);

    const missing = full.divergences.filter((d) => d.kind === 'missing_proposal');
    expect(missing.map((d) => d.legacyId).sort((a, b) => a! - b!)).toEqual([
      ids[5],
      ids[6],
    ]);
  });

  it('walks the whole table even when the page size is one', async () => {
    // The pathological page size, to prove the loop terminates on the cursor
    // rather than on a coincidence of sizes.
    await seedEdits(5, 3);
    const full = await reconcileAll(db, { limit: 1 });
    expect(full.complete).toBe(true);
    expect(full.examined.pendingEdits).toBe(5);
    expect(full.counts.missing_proposal).toBe(2);
    expect(full.pages).toBeGreaterThan(5);
  });

  it('stops at the page bound and says the scan is incomplete', async () => {
    // The other honest outcome. A scanner that walked forever would be an
    // outage; one that stopped quietly would be the original bug with extra
    // steps.
    await seedEdits(7, 5);
    const capped = await reconcileAll(db, { limit: 1, maxPages: 2 });
    expect(capped.complete).toBe(false);
    expect(capped.examined.pendingEdits).toBe(2);
  });
});

describe('the gates refuse to read an unfinished scan as clean', () => {
  it('passes the definition-of-done criterion only on a complete clean scan', async () => {
    // Everything IS mirrored here, so the criterion legitimately holds.
    await seedEdits(7, 7);
    const done = await definitionOfDone({ db, limit: 500 });
    const clean = done.criteria.find(
      (c) => c.id === 'safety.reconciliation_clean',
    );
    expect(clean?.status).toBe('holds');
  });

  it('does not pass it on a scan that stopped early with nothing found', async () => {
    // The state a growing table reaches on its own: nothing wrong in the part
    // that was read, and most of the table unread. Before the fix these two
    // cases produced an identical criterion status, because the only input was
    // the divergence count and it is zero in both.
    await seedEdits(7, 7);
    const done = await definitionOfDone({ db, limit: 1, maxPages: 2 });
    const clean = done.criteria.find(
      (c) => c.id === 'safety.reconciliation_clean',
    )!;
    expect(clean.status).toBe('not_yet');
    // Same database, same zero divergences — only the scan's reach differs.
    const complete = await definitionOfDone({ db, limit: 500 });
    expect(
      complete.criteria.find((c) => c.id === 'safety.reconciliation_clean')!
        .status,
    ).toBe('holds');
  });

  it('blocks a cutover dossier whose scan did not finish', async () => {
    await seedEdits(7, 7);
    const dossier = await buildDossier('wiki_fact', { db, limit: 500 });
    expect(dossier.reconciliation.complete).toBe(true);
    expect(readinessBlockers(dossier).join(' ')).not.toMatch(/stopped before the end/);

    // The same dossier with only its completeness flag flipped. Everything else
    // — coverage, policy observations, zero divergences — still says advance.
    const truncated = {
      ...dossier,
      reconciliation: { ...dossier.reconciliation, complete: false },
    };
    expect(readinessBlockers(truncated).join(' ')).toMatch(/stopped before the end/);
  });
});
