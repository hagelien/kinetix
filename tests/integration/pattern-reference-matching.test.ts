/**
 * A cohort contributes to matching only while its citation still is one
 * (§7.7, §13.3).
 *
 * Admission decided once that the citation was a publication somebody had read.
 * That decision has two halves with different lifetimes: the review is a fact
 * about the moment of admission, and the classification is a claim that
 * expires. This is where the second half is re-read — a cohort whose citation
 * has since become conflicted, or has acquired a handle nobody asked about,
 * contributes nothing, skipped exactly as an unprovenanced band is.
 *
 * The exclusions are counted rather than silently dropped: a band that quietly
 * loses half its cohorts renders anyway, with a smaller n and no mark on
 * screen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { citations, patternReferenceCohorts } from '../../db/schema.js';
import {
  loadMatchableCohorts,
  withheldByReason,
} from '../../api/_lib/pattern-reference-store.js';
import { mergeCitations } from '../../api/_lib/citation-merge.js';
import { resolveCitationWorkKind } from '../../api/_lib/citation-work-kind.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});

afterAll(async () => {
  await teardownIntegrationDb();
});

beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
});

async function seedCohort(citationId: number, name = 'Diazepam ratios'): Promise<number> {
  const [row] = await db
    .insert(patternReferenceCohorts)
    .values({
      citationId,
      name,
      cohortType: 'controlled_single_dose',
      timeOrigin: 'declared_exposure',
      sourceDatasetHash: 'sha256:abc',
      importerVersion: '1.0.0',
      transformationVersion: '1.0.0',
      authorizedBy: userId,
    })
    .returning({ id: patternReferenceCohorts.id });
  return row!.id;
}

describe('loading the cohorts matching may use', () => {
  it('offers a cohort whose citation is still a resolved publication', async () => {
    const citationId = await seedAdmissibleCitation(db, { createdBy: userId });
    const cohortId = await seedCohort(citationId);

    const { cohorts, withheld } = await loadMatchableCohorts(db);
    expect(cohorts.map((c) => c.id)).toEqual([cohortId]);
    expect(withheld).toEqual([]);
    expect(cohorts[0]).toMatchObject({
      citationId,
      cohortType: 'controlled_single_dose',
      sourceDatasetHash: 'sha256:abc',
    });
  });

  it('withholds a cohort whose citation has since acquired a handle', async () => {
    // The claim a classification makes is "every handle this row carried was
    // asked". A DOI arriving afterwards is exactly where a dataset verdict
    // would have come from, and admission has already happened — so the check
    // has to be here, on every read, or the cohort scores cases against a
    // verdict that expired.
    const citationId = await seedAdmissibleCitation(db, { createdBy: userId });
    const cohortId = await seedCohort(citationId);
    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.5281/zenodo.1' } } })
      .where(eq(citations.id, citationId));

    const { cohorts, withheld } = await loadMatchableCohorts(db);
    expect(cohorts).toEqual([]);
    expect(withheld).toEqual([{ id: cohortId, citationId, reason: 'stale' }]);
  });

  it('withholds a cohort whose citation two registries disagree about', async () => {
    const winnerId = await seedAdmissibleCitation(db, {
      identifier: '29462364',
      createdBy: userId,
    });
    const cohortId = await seedCohort(winnerId);
    const loserId = await seedAdmissibleCitation(db, {
      type: 'doi',
      identifier: '10.5281/zenodo.1',
      createdBy: userId,
    });
    // Give the loser a dataset verdict, then fold it in: the merge carries both
    // rows' evidence onto the survivor and records the disagreement.
    await db
      .update(citations)
      .set({
        workKind: null,
        workKindStatus: 'conflicted',
        workKindHandles: ['doi:10.5281/zenodo.1', 'pmid:11111111'],
        workKindVerdicts: [
          { handle: 'doi:10.5281/zenodo.1', kind: 'dataset' },
          { handle: 'pmid:11111111', kind: 'journal_article' },
        ],
        workKindResolvedAt: new Date(),
      })
      .where(eq(citations.id, loserId));

    await mergeCitations(db, winnerId, loserId);

    const { cohorts, withheld } = await loadMatchableCohorts(db);
    expect(cohorts).toEqual([]);
    // A curation question, not something a retry settles — so the cohort waits
    // for a human rather than being scored on the more permissive verdict.
    expect(withheld).toEqual([
      { id: cohortId, citationId: winnerId, reason: 'conflicted' },
    ]);
  });

  it('withholds a cohort whose citation was never classified', async () => {
    // Every citation predating the classification column is unresolved, and
    // admission is what would have resolved it. A cohort admitted before the
    // gate existed therefore reads as unresolved here rather than as admitted.
    const citationId = await seedAdmissibleCitation(db, { createdBy: userId });
    const cohortId = await seedCohort(citationId);
    await db
      .update(citations)
      .set({
        workKind: null,
        workKindStatus: 'unresolved',
        workKindHandles: null,
        workKindVerdicts: null,
        workKindResolvedAt: null,
      })
      .where(eq(citations.id, citationId));

    const { cohorts, withheld } = await loadMatchableCohorts(db);
    expect(cohorts).toEqual([]);
    expect(withheld[0]?.reason).toBe('unresolved');
  });

  it('keeps a cohort whose citation merely lost a handle', async () => {
    // Adding a handle re-opens the question; removing one does not answer it.
    // Were a shrink to withhold the cohort, patching away an alias would take
    // an admitted cohort out of matching without anyone deciding to.
    const citationId = await seedAdmissibleCitation(db, { createdBy: userId });
    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.5281/zenodo.1' } } })
      .where(eq(citations.id, citationId));
    await resolveCitationWorkKind(db, citationId, {
      // Both handles answer, so the classification covers the row and the
      // cohort can be admitted at all — which is the state the shrink below
      // has to leave standing.
      crossref: async () => ({ workType: 'journal-article' }) as never,
      datacite: async () => null,
      pubmed: async () => ({ publicationTypes: ['Journal Article'] }) as never,
    });
    const cohortId = await seedCohort(citationId);
    await db
      .update(citations)
      .set({ metadata: { title: 'A paper' } })
      .where(eq(citations.id, citationId));

    const { cohorts, withheld } = await loadMatchableCohorts(db);
    expect(cohorts.map((c) => c.id)).toEqual([cohortId]);
    expect(withheld).toEqual([]);
  });

  it('reports each cohort separately, so one bad citation does not hide the rest', async () => {
    const goodCitation = await seedAdmissibleCitation(db, {
      identifier: '29462364',
      createdBy: userId,
    });
    const staleCitation = await seedAdmissibleCitation(db, {
      identifier: '24500275',
      createdBy: userId,
    });
    const goodCohort = await seedCohort(goodCitation, 'Living volunteers');
    const staleCohort = await seedCohort(staleCitation, 'Postmortem series');
    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.5281/zenodo.1' } } })
      .where(eq(citations.id, staleCitation));

    const { cohorts, withheld } = await loadMatchableCohorts(db);
    expect(cohorts.map((c) => c.id)).toEqual([goodCohort]);
    expect(withheld.map((c) => c.id)).toEqual([staleCohort]);
    expect(withheldByReason(withheld)).toMatchObject({ stale: 1, conflicted: 0 });
  });

  it('narrows to the cohorts asked for, and answers nothing for an empty ask', async () => {
    const first = await seedAdmissibleCitation(db, {
      identifier: '29462364',
      createdBy: userId,
    });
    const second = await seedAdmissibleCitation(db, {
      identifier: '24500275',
      createdBy: userId,
    });
    const firstCohort = await seedCohort(first);
    await seedCohort(second);

    expect((await loadMatchableCohorts(db, [firstCohort])).cohorts.map((c) => c.id)).toEqual(
      [firstCohort],
    );
    // An empty list is a caller asking about nothing, which is not the same as
    // asking about everything — the difference between a feature with no
    // candidate cohorts and one nobody filtered.
    expect(await loadMatchableCohorts(db, [])).toEqual({ cohorts: [], withheld: [] });
  });
});
