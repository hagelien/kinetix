/**
 * What a citation identifies, stored on the citation (§13.3, migration 0107).
 *
 * Three things are checked here, and only the first is about SQL:
 *
 * 1. **The columns refuse a classification that contradicts its own evidence.**
 *    A `conflicted` row with one verdict is not a conflict; a `resolved` row
 *    whose verdicts disagree with the column that summarises them is a settled
 *    answer nobody reached. Both would be read downstream as fact.
 * 2. **A handle is examined only when a registry answered.** An outage must not
 *    look like an answer, because a classification covering every handle is
 *    exactly what stops the row being asked again — so an unreachable DOI that
 *    counted as examined would leave a dataset admitted on the strength of a
 *    timeout.
 * 3. **A merge folds both rows' evidence.** The loser is deleted; its verdict
 *    is about the same paper, and losing it is how a DOI Crossref called a
 *    dataset gets replaced by PubMed's "journal article" on the promoted PMID.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  citations,
  paperReviews,
  patternReferenceCohorts,
} from '../../db/schema.js';
import { mergeCitations } from '../../api/_lib/citation-merge.js';
import {
  admitCitationForCohort,
  readClassification,
  resolveCitationWorkKind,
  loadClassificationRow,
  type WorkKindProviders,
} from '../../api/_lib/citation-work-kind.js';
import {
  CITATION_WORK_KINDS,
  classificationHandles,
  isAdmissibleCitationWorkKind,
} from '../../src/lib/citationWorkKind.js';
import { seedUser } from './setup/seed.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});

afterAll(async () => {
  await teardownIntegrationDb();
});

beforeEach(async () => {
  await resetIntegrationDb(db);
});

async function seedCitation(
  type: string,
  identifier: string,
  metadata?: Record<string, unknown>,
): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type, identifier, metadata: metadata ?? null })
    .returning({ id: citations.id });
  return row!.id;
}

/** Provider stubs: one entry per handle, or an error to simulate an outage. */
function providers(options: {
  crossref?: Record<string, { workType: string | null } | null | Error>;
  datacite?: Record<string, { resourceTypeGeneral: string | null } | null | Error>;
  pubmed?: Record<string, { publicationTypes: string[] } | null | Error>;
}): WorkKindProviders {
  const answer = <T>(table: Record<string, T | null | Error> | undefined, key: string) => {
    const value = table?.[key];
    if (value instanceof Error) throw value;
    return (value ?? null) as T | null;
  };
  return {
    crossref: async (doi: string) =>
      answer(options.crossref, doi) as never,
    datacite: async (doi: string) => answer(options.datacite, doi) as never,
    pubmed: async (pmid: string) => answer(options.pubmed, pmid) as never,
  };
}

const ARTICLE = { publicationTypes: ['Journal Article', 'Case Reports'] };

/**
 * Assert that a write was refused *by a named constraint*.
 *
 * `rejects.toThrow()` alone passes for any error at all — a typo in the SQL
 * refuses the write just as loudly as the rule under test, and the test still
 * goes green while checking nothing. The driver wraps the Postgres error, so
 * the constraint name is read off the cause.
 */
async function expectRefusedBy(
  write: Promise<unknown>,
  constraint: string | string[],
): Promise<void> {
  const names = Array.isArray(constraint) ? constraint : [constraint];
  await write.then(
    () => {
      throw new Error(`expected ${names.join(' or ')} to refuse this write`);
    },
    (error: unknown) => {
      const cause = (error as { cause?: { constraint?: string } }).cause;
      expect(names).toContain(cause?.constraint);
    },
  );
}


/**
 * Assert that a write was refused, and that the refusal *said why*.
 *
 * The driver wraps the Postgres error, so the trigger's message is on the
 * cause. Matching it matters here: a guard that refuses everything for the
 * wrong reason would satisfy `rejects.toThrow()` while telling an operator
 * nothing about which condition their citation failed.
 */
async function expectRefusalSaying(
  write: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  await write.then(
    () => {
      throw new Error(`expected a refusal matching ${message}`);
    },
    (error: unknown) => {
      const cause = (error as { cause?: { message?: string } }).cause;
      expect(cause?.message ?? String(error)).toMatch(message);
    },
  );
}

describe('the classification columns', () => {
  it('start unresolved, with nothing else recorded', async () => {
    const id = await seedCitation('pmid', '29462364');
    const row = await loadClassificationRow(db, id);
    expect(row?.workKindStatus).toBe('unresolved');
    expect(row?.workKind).toBeNull();
    expect(row?.workKindHandles).toBeNull();
  });

  it('refuse an unresolved row that carries an answer anyway', async () => {
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations" SET "work_kind" = 'journal_article'
         WHERE "id" = ${id}
      `),
      'citations_work_kind_evidence',
    );
  });

  it('refuse a kind outside the canonical vocabulary', async () => {
    // Not a coarser answer: a value no admission rule is written about passes
    // every gate by matching no refusal.
    //
    // Either constraint may be the one that speaks. The column's own rule says
    // the kind must be canonical; the evidence rule independently says every
    // verdict names a canonical kind and that a resolved row's verdicts agree
    // with the column — so a bad kind cannot reach the column without also
    // breaking the evidence, and Postgres reports whichever it evaluates first.
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind" = 'journal-article',
               "work_kind_status" = 'resolved',
               "work_kind_handles" = ARRAY['pmid:29462364'],
               "work_kind_verdicts" =
                 '[{"handle":"pmid:29462364","kind":"journal-article"}]'::jsonb,
               "work_kind_resolved_at" = now()
         WHERE "id" = ${id}
      `),
      ['citations_work_kind_vocabulary', 'citations_work_kind_evidence'],
    );
  });

  it('refuse a resolved row whose verdicts say something else', async () => {
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind" = 'journal_article',
               "work_kind_status" = 'resolved',
               "work_kind_handles" = ARRAY['pmid:29462364'],
               "work_kind_verdicts" =
                 '[{"handle":"pmid:29462364","kind":"dataset"}]'::jsonb,
               "work_kind_resolved_at" = now()
         WHERE "id" = ${id}
      `),
      'citations_work_kind_evidence',
    );
  });

  it('refuse a conflict that only one registry took part in', async () => {
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind_status" = 'conflicted',
               "work_kind_handles" = ARRAY['pmid:29462364'],
               "work_kind_verdicts" =
                 '[{"handle":"pmid:29462364","kind":"dataset"}]'::jsonb,
               "work_kind_resolved_at" = now()
         WHERE "id" = ${id}
      `),
      'citations_work_kind_evidence',
    );
  });

  it('refuse a verdict for a handle that was never examined', async () => {
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind" = 'dataset',
               "work_kind_status" = 'resolved',
               "work_kind_handles" = ARRAY['pmid:29462364'],
               "work_kind_verdicts" =
                 '[{"handle":"doi:10.1234/abc","kind":"dataset"}]'::jsonb,
               "work_kind_resolved_at" = now()
         WHERE "id" = ${id}
      `),
      'citations_work_kind_evidence',
    );
  });

  it('refuse an examined handle that is not a handle', async () => {
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind" = 'dataset',
               "work_kind_status" = 'resolved',
               "work_kind_handles" = ARRAY['pmid:29462364', 'url:https://x.test'],
               "work_kind_verdicts" =
                 '[{"handle":"pmid:29462364","kind":"dataset"}]'::jsonb,
               "work_kind_resolved_at" = now()
         WHERE "id" = ${id}
      `),
      'citations_work_kind_evidence',
    );
  });

  it('refuse a settled classification with no verdicts behind it', async () => {
    // The trap a CHECK sets for its author: every predicate about `p_verdicts`
    // goes NULL against a NULL argument — `jsonb_typeof(NULL)` is NULL, and a
    // scalar subquery over `jsonb_array_elements(NULL)` aggregates zero rows to
    // NULL — and a CHECK that evaluates to NULL passes.
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind" = 'journal_article',
               "work_kind_status" = 'resolved',
               "work_kind_handles" = ARRAY['pmid:29462364'],
               "work_kind_resolved_at" = now()
         WHERE "id" = ${id}
      `),
      'citations_work_kind_evidence',
    );
  });

  it('refuse an answer with no date, and a date with no answer', async () => {
    const id = await seedCitation('pmid', '29462364');
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations"
           SET "work_kind" = 'journal_article',
               "work_kind_status" = 'resolved',
               "work_kind_handles" = ARRAY['pmid:29462364'],
               "work_kind_verdicts" =
                 '[{"handle":"pmid:29462364","kind":"journal_article"}]'::jsonb
         WHERE "id" = ${id}
      `),
      'citations_work_kind_resolved_at',
    );
    await expectRefusedBy(
      db.execute(sql`
        UPDATE "citations" SET "work_kind_resolved_at" = now() WHERE "id" = ${id}
      `),
      'citations_work_kind_resolved_at',
    );
  });
});

describe('resolving a classification', () => {
  it('asks every handle the row carries, not only the one it is filed under', async () => {
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.1234/abc' },
    });
    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.1234/abc': { workType: 'dataset' } },
      }),
    );
    // A disagreement lands in `conflicted` rather than being decided by which
    // handle happened to be stronger — the whole reason both are asked.
    expect(result.outcome).toBe('stored');
    expect(result.classification.status).toBe('conflicted');
    expect(result.classification.kind).toBeNull();
    expect(result.classification.current).toBe(true);
  });

  it('resolves an ordinary article both registries agree about', async () => {
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.1234/abc' },
    });
    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.1234/abc': { workType: 'journal-article' } },
      }),
    );
    expect(result.classification.status).toBe('resolved');
    expect(result.classification.kind).toBe('journal_article');
  });

  it('asks DataCite for a DOI Crossref has never heard of', async () => {
    // Where datasets actually live. Asking Crossref alone would answer
    // "unknown" for exactly the object the gate exists to refuse.
    const id = await seedCitation('doi', '10.5281/zenodo.1');
    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );
    expect(result.classification.status).toBe('resolved');
    expect(result.classification.kind).toBe('dataset');
  });

  it('does not treat an unreachable registry as an answer', async () => {
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.1234/abc' },
    });
    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.1234/abc': new Error('crossref 503') },
        datacite: { '10.1234/abc': new Error('datacite 503') },
      }),
    );
    // PubMed's verdict is stored, but the DOI was never examined — so the
    // classification does not cover the row's handles and reads as expired.
    // Otherwise an outage would settle the question in favour of the handle
    // that happened to be reachable.
    expect(result.outcome).toBe('stored');
    expect(result.classification.status).toBe('resolved');
    expect(result.classification.current).toBe(false);
  });

  it('counts a registry that answered without naming a kind as examined', async () => {
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.1234/abc' },
    });
    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({
        // Only study design: PubMed answered, it just did not say what the
        // object is. That is not the same as being unreachable.
        pubmed: { '29462364': { publicationTypes: ['Review'] } },
        crossref: { '10.1234/abc': { workType: 'journal-article' } },
      }),
    );
    expect(result.classification.kind).toBe('journal_article');
    expect(result.classification.current).toBe(true);
  });

  it('stores nothing when nobody answered', async () => {
    const id = await seedCitation('doi', '10.1234/abc');
    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({ crossref: { '10.1234/abc': null }, datacite: {} }),
    );
    expect(result.outcome).toBe('unanswered');
    const row = await loadClassificationRow(db, id);
    expect(row?.workKindStatus).toBe('unresolved');
  });

  it('has nothing to ask for a freetext row', async () => {
    const id = await seedCitation('freetext', 'Smith 1999, personal archive');
    const result = await resolveCitationWorkKind(db, id, providers({}));
    expect(result.outcome).toBe('no_handles');
    expect(result.classification.status).toBe('unresolved');
  });

  it('does not ask again while the answer still covers the row', async () => {
    const id = await seedCitation('pmid', '29462364');
    await resolveCitationWorkKind(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    let asked = 0;
    const counting: WorkKindProviders = {
      ...providers({ pubmed: { '29462364': ARTICLE } }),
      pubmed: async (pmid: string) => {
        asked += 1;
        return { ...ARTICLE, title: '', authors: [], journal: '', year: null, volume: null, pages: null } as never;
      },
    };
    const second = await resolveCitationWorkKind(db, id, counting);
    expect(second.outcome).toBe('current');
    expect(asked).toBe(0);
  });

  it('asks again once a handle appears', async () => {
    const id = await seedCitation('pmid', '29462364');
    await resolveCitationWorkKind(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    // The quiet case §13.3 names: a PMID row classified as an article acquires
    // a DOI that resolves to a dataset, with no merge and no null to notice.
    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.5281/zenodo.1' } } })
      .where(eq(citations.id, id));

    const stale = await loadClassificationRow(db, id);
    expect(readClassification(stale!).current).toBe(false);

    const result = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );
    expect(result.classification.status).toBe('conflicted');
  });

  it('keeps standing when a handle is removed', async () => {
    // Adding a handle re-opens the question; removing one does not answer it.
    // Were a shrink to expire the verdict, patching away the DOI would re-open
    // the question, the re-resolve would consult only the surviving PMID, and
    // the cohort would be admitted by deleting the evidence against it.
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.5281/zenodo.1' },
    });
    await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );
    await db
      .update(citations)
      .set({ metadata: { title: 'A paper' } })
      .where(eq(citations.id, id));

    const row = await loadClassificationRow(db, id);
    const classification = readClassification(row!);
    expect(classification.status).toBe('conflicted');
    expect(classification.current).toBe(true);
  });

  it('refuses to write a verdict for a handle set that moved mid-resolve', async () => {
    const id = await seedCitation('pmid', '29462364');
    const racing: WorkKindProviders = {
      ...providers({ pubmed: { '29462364': ARTICLE } }),
      pubmed: async () => {
        // A merge or a PATCH lands while the fetch is in flight. Writing over
        // the top would store a publication verdict that never looked at the
        // new DOI — and with no further handle change, nothing would expire it.
        await db
          .update(citations)
          .set({ metadata: { altIds: { doi: '10.5281/zenodo.1' } } })
          .where(eq(citations.id, id));
        return { ...ARTICLE } as never;
      },
    };
    const result = await resolveCitationWorkKind(db, id, racing);
    expect(result.outcome).toBe('raced');
    const row = await loadClassificationRow(db, id);
    expect(row?.workKindStatus).toBe('unresolved');
  });
});

describe('re-resolving keeps what the row already knew', () => {
  it('does not let an outage plus a patch erase a conflict', async () => {
    // The row is conflicted between an article PMID and a dataset DOI. It then
    // gains a third handle, so the verdict expires and is asked again — while
    // the dataset DOI is unreachable. Replacing the evidence with only the
    // handles that answered would rewrite the row as an article; removing the
    // unreachable DOI afterwards would then make that article verdict current,
    // and the conflict would be gone without any registry having changed its
    // mind.
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.5281/zenodo.1' },
    });
    await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );
    expect(readClassification((await loadClassificationRow(db, id))!).status).toBe(
      'conflicted',
    );

    await db
      .update(citations)
      .set({
        metadata: {
          altIds: {
            doi: '10.5281/zenodo.1',
            url: 'https://doi.org/10.1234/other',
          },
        },
      })
      .where(eq(citations.id, id));

    const retried = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: {
          '10.5281/zenodo.1': new Error('crossref 503'),
          '10.1234/other': { workType: 'journal-article' },
        },
        datacite: { '10.5281/zenodo.1': new Error('datacite 503') },
      }),
    );
    expect(retried.classification.status).toBe('conflicted');
    expect(retried.classification.current).toBe(true);

    // And the conflict survives the DOI being patched away afterwards.
    await db
      .update(citations)
      .set({ metadata: { altIds: { url: 'https://doi.org/10.1234/other' } } })
      .where(eq(citations.id, id));
    const after = readClassification((await loadClassificationRow(db, id))!);
    expect(after.status).toBe('conflicted');
    expect(after.current).toBe(true);
  });

  it('lets a registry correct itself about the same handle', async () => {
    // Retaining is per handle, not per verdict: a fresh answer replaces the old
    // one for the handle it is about, so keeping evidence does not freeze a
    // mistake.
    const id = await seedCitation('pmid', '29462364');
    await resolveCitationWorkKind(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.1234/abc' } } })
      .where(eq(citations.id, id));

    const retried = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': { publicationTypes: ['Preprint'] } },
        crossref: { '10.1234/abc': { workType: 'posted-content' } },
      }),
    );
    expect(retried.classification.status).toBe('resolved');
    expect(retried.classification.kind).toBe('preprint');
  });

  it('writes nothing when the attempt learned nothing new', async () => {
    const id = await seedCitation('pmid', '29462364');
    await resolveCitationWorkKind(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    const before = await db.execute<{ at: string }>(
      sql`SELECT "work_kind_resolved_at" AS at FROM "citations" WHERE "id" = ${id}`,
    );

    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.1234/abc' } } })
      .where(eq(citations.id, id));

    const retried = await resolveCitationWorkKind(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.1234/abc': new Error('crossref 503') },
        datacite: { '10.1234/abc': new Error('datacite 503') },
      }),
    );
    // PubMed repeated what the row already recorded and the DOI never answered.
    // Storing that as a fresh resolution would move the answer's date to a
    // moment at which no registry said anything.
    expect(retried.outcome).toBe('unanswered');
    const after = await db.execute<{ at: string }>(
      sql`SELECT "work_kind_resolved_at" AS at FROM "citations" WHERE "id" = ${id}`,
    );
    expect(after.rows[0]?.at).toEqual(before.rows[0]?.at);
  });
});

describe('a merge folds both rows\' evidence', () => {
  it("carries the loser's verdict onto the winner", async () => {
    const winnerId = await seedCitation('pmid', '29462364');
    const loserId = await seedCitation('doi', '10.5281/zenodo.1');
    await resolveCitationWorkKind(
      db,
      loserId,
      providers({
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );

    await mergeCitations(db, winnerId, loserId);

    const row = await loadClassificationRow(db, winnerId);
    const classification = readClassification(row!);
    // Without the carry the merged row is unclassified with a stronger handle
    // to re-resolve through: PubMed says "journal article" about the PMID, and
    // Crossref's dataset verdict on the DOI is gone.
    expect(classification.status).toBe('resolved');
    expect(classification.kind).toBe('dataset');
    expect(row?.workKindHandles).toContain('doi:10.5281/zenodo.1');
  });

  it('records two folded rows that disagree as a conflict', async () => {
    const winnerId = await seedCitation('pmid', '29462364');
    const loserId = await seedCitation('doi', '10.5281/zenodo.1');
    await resolveCitationWorkKind(
      db,
      winnerId,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    await resolveCitationWorkKind(
      db,
      loserId,
      providers({
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );

    await mergeCitations(db, winnerId, loserId);

    const row = await loadClassificationRow(db, winnerId);
    const classification = readClassification(row!);
    expect(classification.status).toBe('conflicted');
    expect(classification.kind).toBeNull();
    // And the merged claim covers the handles the winner now carries, so the
    // conflict is not quietly re-opened by the merge that produced it.
    expect(classification.current).toBe(true);
  });

  it('leaves the winner unresolved when neither row was ever asked', async () => {
    const winnerId = await seedCitation('pmid', '29462364');
    const loserId = await seedCitation('doi', '10.1234/abc');
    await mergeCitations(db, winnerId, loserId);
    const row = await loadClassificationRow(db, winnerId);
    expect(row?.workKindStatus).toBe('unresolved');
    expect(row?.workKindHandles).toBeNull();
  });
});

describe('admitting a citation to the atlas', () => {
  async function seedReview(citationId: number, readInFull: boolean) {
    await db.insert(paperReviews).values({
      citationId,
      reviewMarkdown: 'Vurdert.',
      readInFull,
    });
  }

  async function admit(citationId: number): Promise<number> {
    const userId = await seedUser(db, {
      email: `admin${citationId}@example.test`,
      username: `admin${citationId}`,
    });
    const [row] = await db
      .insert(patternReferenceCohorts)
      .values({
        citationId,
        name: 'Diazepam ratios',
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

  it('admits a read-in-full journal article', async () => {
    const id = await seedCitation('pmid', '29462364');
    await seedReview(id, true);
    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    expect(verdict).toMatchObject({ admissible: true, reason: null });
    await expect(admit(id)).resolves.toEqual(expect.any(Number));
  });

  it('refuses a dataset admitted under a DOI — the route the decision declined', async () => {
    const id = await seedCitation('doi', '10.5281/zenodo.1');
    await seedReview(id, true);
    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );
    expect(verdict).toMatchObject({
      admissible: false,
      reason: 'not_a_publication',
    });
    // And the table refuses it too, so a writer that never consulted the gate
    // cannot admit what the gate would have refused.
    await expectRefusalSaying(admit(id), /not a publication this atlas admits/);
  });

  it('refuses a bare url and a freetext note, which no registry can classify', async () => {
    for (const [type, identifier] of [
      ['url', 'https://example.org/report.pdf'],
      ['freetext', 'Internal dataset, 2026'],
    ] as const) {
      const id = await seedCitation(type, identifier);
      await seedReview(id, true);
      const verdict = await admitCitationForCohort(db, id, providers({}));
      expect(verdict).toMatchObject({ admissible: false, reason: 'unresolved' });
      await expectRefusalSaying(admit(id), /not a resolved publication/);
    }
  });

  it('refuses a DOI whose kind will not resolve, rather than assuming', async () => {
    const id = await seedCitation('doi', '10.1234/abc');
    await seedReview(id, true);
    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({ crossref: { '10.1234/abc': null }, datacite: {} }),
    );
    expect(verdict).toMatchObject({ admissible: false, reason: 'unresolved' });
  });

  it('refuses a conflicted citation until a human settles it', async () => {
    const id = await seedCitation('pmid', '29462364', {
      altIds: { doi: '10.5281/zenodo.1' },
    });
    await seedReview(id, true);
    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({
        pubmed: { '29462364': ARTICLE },
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );
    expect(verdict).toMatchObject({ admissible: false, reason: 'conflicted' });
    await expectRefusalSaying(admit(id), /not a resolved publication/);
  });

  it('refuses a paper nobody read in full (§34.4)', async () => {
    const id = await seedCitation('pmid', '29462364');
    await seedReview(id, false);
    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    expect(verdict).toMatchObject({
      admissible: false,
      reason: 'not_read_in_full',
    });
    await expectRefusalSaying(admit(id), /read-in-full/);
  });

  it('resolves before it judges, so a catalog predating the column is not refused wholesale', async () => {
    // Every citation older than migration 0107 is unresolved and nothing
    // re-derives one on its own. A gate that read the stored state directly
    // would refuse every journal article the catalog already holds.
    const id = await seedCitation('pmid', '29462364');
    await seedReview(id, true);
    expect((await loadClassificationRow(db, id))?.workKindStatus).toBe(
      'unresolved',
    );

    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    expect(verdict.admissible).toBe(true);
  });

  it('reports an outage as unresolved rather than as a verdict', async () => {
    const id = await seedCitation('pmid', '29462364');
    await seedReview(id, true);
    const verdict = await admitCitationForCohort(
      db,
      id,
      providers({ pubmed: { '29462364': new Error('pubmed 503') } }),
    );
    expect(verdict).toMatchObject({ admissible: false, reason: 'unresolved' });
  });

  it('does not block a merge from repointing an admitted cohort', async () => {
    // The guard is on admission, not on the repoint. A merge that lands two
    // disagreeing kinds on the winner marks it conflicted, and refusing the
    // repoint there would turn an ordinary merge into a failure with the cohort
    // still admitted — the data-loss shape #1083 exists to prevent.
    const winnerId = await seedCitation('pmid', '29462364');
    const loserId = await seedCitation('doi', '10.5281/zenodo.1');
    await seedReview(winnerId, true);
    await resolveCitationWorkKind(
      db,
      winnerId,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    const cohortId = await admit(winnerId);
    await resolveCitationWorkKind(
      db,
      loserId,
      providers({
        crossref: { '10.5281/zenodo.1': null },
        datacite: { '10.5281/zenodo.1': { resourceTypeGeneral: 'Dataset' } },
      }),
    );

    await mergeCitations(db, winnerId, loserId);

    const [cohort] = await db
      .select({ citationId: patternReferenceCohorts.citationId })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, cohortId));
    expect(cohort?.citationId).toBe(winnerId);
    // The citation is now conflicted, which is what stops it *matching* — a
    // continuing condition, read on every case rather than at admission.
    const after = readClassification((await loadClassificationRow(db, winnerId))!);
    expect(after.status).toBe('conflicted');
  });
});

describe('the admissible set is one decision, not two', () => {
  it('agrees between the SQL guard and the TypeScript predicate', async () => {
    // The list is written twice — in `citationWorkKind.ts` for the admission
    // path and in migration 0108 for the table guard — because a trigger cannot
    // call into TypeScript. Two copies of a policy drift, and the drift is
    // silent in the dangerous direction: a kind admitted by the table but
    // refused by the path merely annoys, while one the path admits and the
    // table refuses aborts an import halfway. This pins them together.
    for (const kind of CITATION_WORK_KINDS) {
      const result = await db.execute<{ ok: boolean }>(
        sql`SELECT "citation_work_kind_is_admissible"(${kind}) AS ok`,
      );
      expect(result.rows[0]?.ok, kind).toBe(isAdmissibleCitationWorkKind(kind));
    }
  });
});

describe('the guard refuses a classification that no longer covers the row', () => {
  it('catches a handle that appeared after the verdict was recorded', async () => {
    // The stale case: the row still *stores* `resolved`, and the handle it
    // acquired is exactly where a dataset verdict would have come from. Reading
    // the status alone would admit it — and "matching will skip it later" is a
    // promise about code that does not exist yet, not a backstop.
    const id = await seedCitation('pmid', '29462364');
    await db.insert(paperReviews).values({
      citationId: id,
      reviewMarkdown: 'Vurdert.',
      readInFull: true,
    });
    await resolveCitationWorkKind(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    await db
      .update(citations)
      .set({ metadata: { altIds: { doi: '10.5281/zenodo.1' } } })
      .where(eq(citations.id, id));

    const userId = await seedUser(db, {
      email: 'stale@example.test',
      username: 'stale',
    });
    await expectRefusalSaying(
      db.insert(patternReferenceCohorts).values({
        citationId: id,
        name: 'Diazepam ratios',
        cohortType: 'controlled_single_dose',
        timeOrigin: 'declared_exposure',
        sourceDatasetHash: 'sha256:abc',
        importerVersion: '1.0.0',
        transformationVersion: '1.0.0',
        authorizedBy: userId,
      }),
      /never examined/,
    );
  });

  it('names only handles the TypeScript derivation also names', async () => {
    // The guard recognises canonical identifiers rather than normalizing, so
    // its answer is a *subset* of the real handle set. That direction is the
    // whole safety argument: it can only refuse what `judgeStoredAdmission`
    // would also refuse, never the reverse — a second parser that disagreed
    // would refuse inserts the application had just approved.
    const rows = [
      { type: 'pmid', identifier: '29462364', metadata: null },
      { type: 'pmid', identifier: '0029462364', metadata: null },
      { type: 'pmid', identifier: 'PMID: 29462364', metadata: null },
      { type: 'doi', identifier: '10.1093/jat/bkt016', metadata: null },
      { type: 'doi', identifier: '10.1093/JAT/BKT016', metadata: null },
      { type: 'doi', identifier: 'https://doi.org/10.1093/jat/bkt016', metadata: null },
      { type: 'url', identifier: 'https://doi.org/10.1093/jat/bkt016', metadata: null },
      { type: 'url', identifier: 'https://doi.org/10.1093%2Fjat%2Fbkt016', metadata: null },
      { type: 'url', identifier: 'https://DOI.org/10.1093/jat/bkt016', metadata: null },
      { type: 'url', identifier: 'https://doi.org/10.1093/jat/bkt016?utm=x', metadata: null },
      { type: 'url', identifier: 'https://pubmed.ncbi.nlm.nih.gov/29462364/', metadata: null },
      {
        type: 'pmid',
        identifier: '29462364',
        metadata: { altIds: { url: 'https://doi.org/10.5281/zenodo.1' } },
      },
      { type: 'freetext', identifier: 'Smith 1999', metadata: null },
      {
        type: 'pmid',
        identifier: '29462364',
        metadata: { altIds: { doi: '10.1234/abc', pmcid: 'PMC1', url: 'https://x.test/a' } },
      },
      {
        type: 'doi',
        identifier: '10.1234/abc',
        metadata: { altIds: { pmid: '29462364' } },
      },
    ] as const;

    for (const row of rows) {
      const result = await db.execute<{ handles: string[] }>(sql`
        SELECT "citation_certain_handles"(
          ${row.type}, ${row.identifier}, ${JSON.stringify(row.metadata)}::jsonb
        ) AS handles
      `);
      const certain = result.rows[0]?.handles ?? [];
      const derived = classificationHandles({
        type: row.type,
        identifier: row.identifier,
        altIds: (row.metadata as { altIds?: never } | null)?.altIds ?? null,
      });
      for (const handle of certain) {
        expect(derived, `${row.type}:${row.identifier} → ${handle}`).toContain(
          handle,
        );
      }
    }
  });

  it('covers the plain resolver URL, which is how a handle arrives unannounced', () => {
    // Subset alone would be satisfied by a guard that recognised nothing, so
    // the cases that matter are pinned as equalities: `altIds.url` pointing at
    // a DOI is the one way a citation gains a handle without its own columns
    // changing, and it is exactly the insert a direct writer would slip past.
    const cases = [
      {
        row: { type: 'pmid', identifier: '29462364', altIds: { url: 'https://doi.org/10.5281/zenodo.1' } },
        expected: ['doi:10.5281/zenodo.1', 'pmid:29462364'],
      },
      {
        row: { type: 'url', identifier: 'https://doi.org/10.1093/jat/bkt016', altIds: null },
        expected: ['doi:10.1093/jat/bkt016'],
      },
      {
        row: { type: 'url', identifier: 'https://pubmed.ncbi.nlm.nih.gov/29462364/', altIds: null },
        expected: ['pmid:29462364'],
      },
    ] as const;
    for (const { row, expected } of cases) {
      expect(classificationHandles(row)).toEqual([...expected]);
    }
  });

  it('refuses an insert whose citation gained a DOI behind a resolver URL', async () => {
    const id = await seedCitation('pmid', '29462364');
    await db.insert(paperReviews).values({
      citationId: id,
      reviewMarkdown: 'Vurdert.',
      readInFull: true,
    });
    await resolveCitationWorkKind(
      db,
      id,
      providers({ pubmed: { '29462364': ARTICLE } }),
    );
    await db
      .update(citations)
      .set({ metadata: { altIds: { url: 'https://doi.org/10.5281/zenodo.1' } } })
      .where(eq(citations.id, id));

    const userId = await seedUser(db, {
      email: 'coat@example.test',
      username: 'coat',
    });
    await expectRefusalSaying(
      db.insert(patternReferenceCohorts).values({
        citationId: id,
        name: 'Diazepam ratios',
        cohortType: 'controlled_single_dose',
        timeOrigin: 'declared_exposure',
        sourceDatasetHash: 'sha256:abc',
        importerVersion: '1.0.0',
        transformationVersion: '1.0.0',
        authorizedBy: userId,
      }),
      /doi:10\.5281\/zenodo\.1/,
    );
  });
});
