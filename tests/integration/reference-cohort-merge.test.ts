/**
 * An admitted cohort survives a citation merge (spec §18.1).
 *
 * `pattern_reference_cohorts.citation_id` is `NOT NULL` and `ON DELETE
 * RESTRICT`, which makes the omission loud rather than quiet: a merge that does
 * not repoint it fails on the foreign key when the loser row is deleted. The
 * failure the restrictive key is chosen to prevent is the other one — a
 * cascading key would delete an admitted cohort, and every reference case and
 * observation hanging off it, as a side effect of an ordinary DOI→PMID merge.
 *
 * The second test is the case a repoint alone does not survive: two cohorts
 * colliding onto one identity tuple. That is not a corner — it is what a merge
 * *asserts*, that these two handles are one paper, so the same dataset admitted
 * under each is one admission recorded twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  citations,
  paperReviews,
  patternReferenceAggregates,
  patternReferenceCases,
  patternReferenceCohorts,
} from '../../db/schema.js';
import {
  assertNoConflictingCohortBaselines,
  countCitationUsage,
  mergeCitations,
} from '../../api/_lib/citation-merge.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let winnerId: number;
let loserId: number;

/**
 * Every citation here backs a cohort, and migration 0108 refuses a cohort whose
 * citation is not a resolved, admissible publication with a read-in-full review
 * — so the fixture builds one. That is not incidental to this file: the merge
 * folds two admitted papers, and a fixture that could not be admitted would be
 * testing a merge no operator can reach.
 */
async function seedCitation(type: string, identifier: string): Promise<number> {
  return seedAdmissibleCitation(db, { type, identifier, createdBy: userId });
}

async function seedCohort(citationId: number, over: Record<string, unknown> = {}): Promise<number> {
  const [row] = await db
    .insert(patternReferenceCohorts)
    .values({
      citationId,
      name: 'Diazepam ratios, healthy volunteers',
      cohortType: 'controlled_single_dose',
      timeOrigin: 'declared_exposure',
      sourceDatasetHash: 'sha256:abc',
      importerVersion: '1.0.0',
      transformationVersion: '1.0.0',
      authorizedBy: userId,
      ...over,
    })
    .returning({ id: patternReferenceCohorts.id });
  return row!.id;
}

/**
 * `db`, with `race` run just before the first cohort write of the named kind —
 * `update` for the repoint, `execute` for the fold record — so it lands
 * between the read that chose the branch and the write that acts on it.
 *
 * The interleaving itself rather than an imitation of it: the merge issues the
 * same statement it always does, against a database another merge has changed
 * underneath it, which is what two `resolveCitation` calls do to each other
 * with no transaction and no lock between them.
 */
function interleaving(
  race: () => Promise<unknown>,
  before: 'update' | 'execute' = 'update',
): typeof db {
  let raced = false;
  const runFirst = <T>(statement: T): T => {
    const target = statement as { then: (...args: unknown[]) => unknown };
    const original = target.then.bind(target);
    target.then = (onFulfilled: unknown, onRejected: unknown) => {
      raced = true;
      return race().then(() => original(onFulfilled, onRejected));
    };
    return statement;
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop !== before) return value.bind(target);
      if (prop === 'execute') {
        return (query: unknown) => {
          const statement = value.call(target, query);
          return raced ? statement : runFirst(statement);
        };
      }
      return (table: unknown) => {
        const builder = value.call(target, table);
        if (table !== patternReferenceCohorts || raced) return builder;
        const set = builder.set.bind(builder);
        builder.set = (values: Record<string, unknown>) => runFirst(set(values));
        return builder;
      };
    },
  }) as typeof db;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});

beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  winnerId = await seedCitation('pmid', '24500275');
  loserId = await seedCitation('doi', '10.1093/jat/bkt016');
});

describe('a citation merge and the atlas', () => {
  it('treats an already-merged loser as nothing left to do', async () => {
    // Two requests resolving the same paper build their duplicate lists before
    // either takes the merge lock; the one that waits wakes to find the row it
    // meant to fold already folded. Failing there would fail a submission
    // because serialization worked — and it would contradict the idempotence
    // `mergeCitations` documents.
    await seedCohort(loserId);
    await mergeCitations(db, winnerId, loserId);

    const stats = await mergeCitations(db, winnerId, loserId);
    expect(stats.rowsRepointed).toBe(0);
    expect(stats.summaryRecompute).toBe('not-needed');
  });

  it('still fails when the surviving citation is the one missing', async () => {
    // Not the same case: a merge into a citation that does not exist has
    // nowhere to put anything, and saying nothing happened would be a lie.
    await expect(mergeCitations(db, 999_999, loserId)).rejects.toThrow(/does not exist/);
  });

  it('repoints an admitted cohort rather than failing on it', async () => {
    const cohortId = await seedCohort(loserId);

    await mergeCitations(db, winnerId, loserId);

    const [cohort] = await db
      .select({ citationId: patternReferenceCohorts.citationId })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, cohortId));
    // Intact and pointing at the surviving citation. The cohort is atlas data a
    // named admin took responsibility for; a merge is not an admission decision.
    expect(cohort?.citationId).toBe(winnerId);
    // And the loser is gone, which is what the repoint made possible.
    expect(
      await db.select({ id: citations.id }).from(citations).where(eq(citations.id, loserId)),
    ).toEqual([]);
  });

  it('counts an admitted cohort as usage, so a preview cannot read as nothing', async () => {
    // Measured as a difference, because the fixture's citation already carries
    // the read-in-full review admission requires (§34.4) and that is a usage
    // too. What this pins is that the cohort adds one — a citation whose only
    // atlas consumer is a cohort would otherwise preview as "0 usage(s)" in
    // `merge:split-citations` while the run is about to repoint, or delete,
    // data a named admin admitted.
    const before = await countCitationUsage(db, loserId);
    await seedCohort(loserId);
    expect(await countCitationUsage(db, loserId)).toBe(before + 1);
  });

  it('reconciles two cohorts that would collide on one identity tuple', async () => {
    // The same dataset admitted under each handle — which is exactly what the
    // merge asserts those handles were: one paper.
    const kept = await seedCohort(winnerId);
    const duplicate = await seedCohort(loserId);

    await mergeCitations(db, winnerId, loserId);

    const rows = await db
      .select({ id: patternReferenceCohorts.id })
      .from(patternReferenceCohorts);
    // One admission survives, and the merge completes: the alternative is the
    // identity index rejecting the repoint and taking the whole merge with it.
    expect(rows.map((row) => row.id)).toEqual([kept]);
    expect(rows.map((row) => row.id)).not.toContain(duplicate);
  });

  it('writes down what it folded away, rather than dropping it silently', async () => {
    // Identity equality is equality of dataset, not of description — and the
    // surviving row is whichever citation won on handle rank, which says
    // nothing about which cohort was better recorded.
    const kept = await seedCohort(winnerId, { cohortType: 'clinical', name: 'Kept' });
    await seedCohort(loserId, {
      cohortType: 'postmortem',
      name: 'Folded',
      evidenceTier: 'tier_2',
    });

    await mergeCitations(db, winnerId, loserId);

    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, kept));
    expect(survivor?.notes).toContain('cohortType');
    expect(survivor?.notes).toContain('postmortem');
    expect(survivor?.notes).toContain('evidenceTier');
  });

  it('keeps the folded row’s own notes, which no comparison can summarise', async () => {
    // Prose somebody wrote about this admission. Two rows describing the
    // dataset identically still have two of these, and the fold deletes one of
    // them — so the record is written whether or not anything else differs.
    const kept = await seedCohort(winnerId, { transformationNotes: 'Kept: units as published.' });
    await seedCohort(loserId, {
      transformationNotes: 'Folded: nmol/L converted from the table in the appendix.',
    });

    await mergeCitations(db, winnerId, loserId);

    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, kept));
    expect(survivor?.notes).toContain('Kept: units as published.');
    expect(survivor?.notes).toContain('converted from the table in the appendix');
  });

  it('appends the fold record once when the merge loses its response', async () => {
    // The http driver has no transaction, so a fold that commits and loses its
    // response leaves a retry to run the same statement over the same pair.
    // `mergeCitations` promises repeatability, and an unconditional append
    // would turn the audit prose into repetition of one paragraph.
    const kept = await seedCohort(winnerId);
    const folded = await seedCohort(loserId, { transformationNotes: 'Folded notes.' });
    const [before] = await db
      .select()
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, folded));

    await mergeCitations(db, winnerId, loserId);
    // The same row again, id and admission included, which is what the retry
    // sees when the response was lost rather than the write.
    const loserAgain = await seedCitation('doi', '10.1093/jat/bkt016');
    await db.insert(patternReferenceCohorts).values({ ...before!, citationId: loserAgain });
    await mergeCitations(db, winnerId, loserAgain);

    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, kept));
    // Counted on the complete marker, this cohort's id included: a count of
    // the shared prefix would read one occurrence and twenty alike.
    const occurrences = (survivor?.notes ?? '').split(`folded cohort ${folded} (`).length - 1;
    expect(occurrences).toBe(1);
    // And the row is gone both times, rather than surviving because its record
    // was already there.
    expect(
      await db
        .select({ id: patternReferenceCohorts.id })
        .from(patternReferenceCohorts)
        .where(eq(patternReferenceCohorts.id, folded)),
    ).toEqual([]);
  });

  it('moves the transcription under a folded cohort rather than cascading over it', async () => {
    // §18.2's chain cascades from the cohort, so the fold that deletes the
    // redundant row would take the cases, specimens, observations and
    // aggregates under it. Where only one side was imported those rows are the
    // only transcription of a dataset the survivor is identical to by
    // identity, so the answer is not ambiguous: they move.
    const kept = await seedCohort(winnerId);
    const folded = await seedCohort(loserId);
    const [subject] = await db
      .insert(patternReferenceCases)
      .values({ cohortId: folded, sourceSubjectKey: 'case 1', sourceLocator: 'Table 2' })
      .returning({ id: patternReferenceCases.id });
    await db
      .insert(patternReferenceAggregates)
      .values({
        cohortId: folded,
        statisticOf: 'feature',
        featureId: 'eddp_mtd_b',
        featureVersion: '1',
        sourceLocator: 'Table 1',
        n: 31,
      });

    const stats = await mergeCitations(db, winnerId, loserId);

    // Counted in the receipt the CLI prints: a merge that moved a study's
    // cases and reported "0 row(s)" tells the operator nothing happened.
    expect(stats.rowsRepointed).toBeGreaterThanOrEqual(2);
    const cases = await db
      .select({ id: patternReferenceCases.id, cohortId: patternReferenceCases.cohortId })
      .from(patternReferenceCases);
    expect(cases).toEqual([{ id: subject!.id, cohortId: kept }]);
    const aggregates = await db
      .select({ cohortId: patternReferenceAggregates.cohortId })
      .from(patternReferenceAggregates);
    expect(aggregates).toEqual([{ cohortId: kept }]);
    // And the fold still happened: one admission, and the loser citation gone.
    expect(await db.select({ id: patternReferenceCohorts.id }).from(patternReferenceCohorts)).toEqual(
      [{ id: kept }],
    );
  });

  it('refuses to fold two cohorts that have both been imported', async () => {
    // Two independent transcriptions of one dataset. Folding deletes one, and
    // there is no reading of a citation merge that decides which one the atlas
    // keeps — so it refuses rather than choosing.
    const kept = await seedCohort(winnerId);
    const folded = await seedCohort(loserId);
    await db
      .insert(patternReferenceCases)
      .values({ cohortId: kept, sourceSubjectKey: 'case 1', sourceLocator: 'Table 2' });
    await db
      .insert(patternReferenceCases)
      .values({ cohortId: folded, sourceSubjectKey: 'case 1', sourceLocator: 'Table 2' });

    await expect(mergeCitations(db, winnerId, loserId)).rejects.toThrow(/both have/);

    // Both transcriptions still on disk, and the merge can be run again once
    // the admission that should not stand is withdrawn.
    expect(await db.select({ id: patternReferenceCases.id }).from(patternReferenceCases)).toHaveLength(
      2,
    );
    expect(
      await db.select({ id: citations.id }).from(citations).where(eq(citations.id, loserId)),
    ).toHaveLength(1);
  });

  it('refuses a both-imported collision from the group preflight', async () => {
    // Before the first of the group's merges, like the URL baselines: the
    // refusal is the same, and reaching it late means reaching it after other
    // consumers have moved.
    const kept = await seedCohort(winnerId);
    const folded = await seedCohort(loserId);
    await db.insert(patternReferenceCases).values({ cohortId: kept, sourceSubjectKey: 'a', sourceLocator: 'Table 2' });
    await db.insert(patternReferenceAggregates).values({
      cohortId: folded,
      statisticOf: 'feature',
      featureId: 'eddp_mtd_b',
      featureVersion: '1',
      sourceLocator: 'Table 1',
      n: 31,
    });

    await expect(
      assertNoConflictingCohortBaselines(db, [winnerId, loserId]),
    ).rejects.toThrow(/both have/);
  });

  it('compares every pair in the group, not each against the first', async () => {
    // Three handles for one dataset, and the winner's row is empty. Anchored
    // on the first row seen, the two populated losers each look like a
    // one-sided move; the group passes, the first merge applies, and the
    // second refuses — the half-applied group this preflight exists to
    // prevent.
    const third = await seedCitation('doi', '10.1093/jat/bkt099');
    await seedCohort(winnerId);
    const first = await seedCohort(loserId);
    const second = await seedCohort(third);
    await db
      .insert(patternReferenceCases)
      .values({ cohortId: first, sourceSubjectKey: 'case 1', sourceLocator: 'Table 2' });
    await db
      .insert(patternReferenceCases)
      .values({ cohortId: second, sourceSubjectKey: 'case 1', sourceLocator: 'Table 2' });

    await expect(
      assertNoConflictingCohortBaselines(db, [winnerId, loserId, third]),
    ).rejects.toThrow(/both have/);
  });

  it('carries the notes the folded row has when the record is written', async () => {
    // The folded row's notes are the one part of the record another merge can
    // still be writing: folding a third cohort into this one appends to
    // exactly this column. A record built from a snapshot taken beforehand
    // copies the old prose onward and then deletes the row holding the new.
    const kept = await seedCohort(winnerId);
    const folded = await seedCohort(loserId, { transformationNotes: 'Folded notes.' });
    const racing = interleaving(
      () =>
        db
          .update(patternReferenceCohorts)
          .set({ transformationNotes: 'Folded notes.\n\nCitation merge folded cohort 999 (…).' })
          .where(eq(patternReferenceCohorts.id, folded)),
      'execute',
    );

    await mergeCitations(racing, winnerId, loserId);

    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, kept));
    expect(survivor?.notes).toContain('Folded notes.');
    // The record appended a moment before this one was written, which a
    // snapshot would have left behind on the deleted row.
    expect(survivor?.notes).toContain('folded cohort 999');
  });

  it('will not delete a cohort whose fold record had nowhere to land', async () => {
    // The row being folded into can itself be folded onward by another merge
    // and deleted first. The append then matches nothing, and deleting on top
    // of that would take this admission's actor, timestamp, description and
    // notes with it, leaving the eventual survivor holding a record for a
    // different cohort.
    const kept = await seedCohort(winnerId);
    const folded = await seedCohort(loserId, { transformationNotes: 'Folded notes.' });
    const racing = interleaving(
      () =>
        db.delete(patternReferenceCohorts).where(eq(patternReferenceCohorts.id, kept)),
      'execute',
    );

    await expect(mergeCitations(racing, winnerId, loserId)).rejects.toThrow(/could not fold/);

    // Still here, notes and all, for the re-run the error asks for.
    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, folded));
    expect(survivor?.notes).toBe('Folded notes.');
  });

  it('still refuses a conflicting baseline it only meets after losing the race', async () => {
    // The preflight reads once, and the row this fold is about to destroy was
    // put there afterwards by another merge — so its URL was never compared
    // with anything. Recovering from the index rejection without looking would
    // drop an import-verification baseline by exactly the route the preflight
    // was added to close.
    const folded = await seedCohort(loserId, { sourceDatasetUrl: 'https://example.org/b.csv' });
    const racing = interleaving(() =>
      seedCohort(winnerId, { sourceDatasetUrl: 'https://example.org/a.csv' }),
    );
    // A consumer of the loser that the merge would otherwise have moved before
    // reaching the cohorts. The preflight cannot have caught this conflict —
    // the row it is about is inserted after that read — so the ordering is the
    // only thing standing between a raced refusal and a half-applied merge.
    // The loser's own review, seeded with the citation: `paper_reviews` is
    // unique on `citation_id`, so this is the row a successful merge would move.
    const [review] = await db
      .select({ id: paperReviews.id })
      .from(paperReviews)
      .where(eq(paperReviews.citationId, loserId));

    await expect(mergeCitations(racing, winnerId, loserId)).rejects.toThrow(/dataset URLs/);

    // Both admissions still on disk: the repoint was rejected rather than
    // applied, so the refusal costs this cohort nothing.
    const rows = await db
      .select({ id: patternReferenceCohorts.id })
      .from(patternReferenceCohorts);
    expect(rows.map((row) => row.id)).toContain(folded);
    expect(rows).toHaveLength(2);
    // And the review never moved, so re-running the merge once the admissions
    // are sorted out starts from where it started.
    const [after] = await db
      .select({ citationId: paperReviews.citationId })
      .from(paperReviews)
      .where(eq(paperReviews.id, review!.id));
    expect(after?.citationId).toBe(loserId);
    expect(
      await db.select({ id: citations.id }).from(citations).where(eq(citations.id, loserId)),
    ).toHaveLength(1);
  });

  it('folds rather than failing when another merge takes the identity first', async () => {
    // Two `resolveCitation` calls merging two losers of one paper into a
    // winner that carries no cohort both read nothing taken, and both go to
    // repoint. There is no lock or snapshot over the http driver to prevent
    // it, so the index rejects the second — after that merge has already moved
    // reviews and consumers. What the rejection means is that the collision
    // case is now the true one.
    const folded = await seedCohort(loserId, { transformationNotes: 'Folded notes.' });
    const racing = interleaving(() => seedCohort(winnerId));

    await mergeCitations(racing, winnerId, loserId);

    const rows = await db
      .select({
        id: patternReferenceCohorts.id,
        citationId: patternReferenceCohorts.citationId,
        notes: patternReferenceCohorts.transformationNotes,
      })
      .from(patternReferenceCohorts);
    // One admission under the winner, the redundant row gone, and the fold
    // written down — the same outcome as if the two merges had not overlapped.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.citationId).toBe(winnerId);
    expect(rows[0]?.notes).toContain(`folded cohort ${folded} (`);
    expect(rows[0]?.notes).toContain('Folded notes.');
    // And the merge ran to completion rather than failing after moving the
    // consumers ahead of it.
    expect(
      await db.select({ id: citations.id }).from(citations).where(eq(citations.id, loserId)),
    ).toEqual([]);
  });

  it('refuses to fold two admissions verified from different URLs', async () => {
    // Both URLs were verified at admission and an import accepts only what its
    // cohort records, so folding one away narrows which bytes the atlas will
    // take — and the survivor is whichever citation won on handle rank.
    await seedCohort(winnerId, { sourceDatasetUrl: 'https://example.org/a.csv' });
    await seedCohort(loserId, { sourceDatasetUrl: 'https://example.org/b.csv' });

    await expect(mergeCitations(db, winnerId, loserId)).rejects.toThrow(/dataset URLs/);
  });

  it('refuses a null baseline against a recorded one, in both directions', async () => {
    // A no-URL admission replaced by one carrying a URL gains a baseline it
    // never had; the other way round loses the only machine-readable one.
    await seedCohort(winnerId, { sourceDatasetUrl: null });
    await seedCohort(loserId, { sourceDatasetUrl: 'https://example.org/b.csv' });
    await expect(mergeCitations(db, winnerId, loserId)).rejects.toThrow(/dataset URLs/);

    await resetIntegrationDb(db);
    userId = await seedUser(db);
    winnerId = await seedCitation('pmid', '24500275');
    loserId = await seedCitation('doi', '10.1093/jat/bkt016');
    await seedCohort(winnerId, { sourceDatasetUrl: 'https://example.org/a.csv' });
    await seedCohort(loserId, { sourceDatasetUrl: null });
    await expect(mergeCitations(db, winnerId, loserId)).rejects.toThrow(/dataset URLs/);
  });

  it('refuses before it has moved anything else', async () => {
    // The CLI runs without a transaction, so a throw halfway through leaves a
    // merge reported as refused and in fact half applied — reviews moved,
    // consumers repointed, and no way back by declining to re-admit.
    await seedCohort(winnerId, { sourceDatasetUrl: 'https://example.org/a.csv' });
    await seedCohort(loserId, { sourceDatasetUrl: 'https://example.org/b.csv' });
    // The loser's own review, seeded with the citation.
    const [review] = await db
      .select({ id: paperReviews.id })
      .from(paperReviews)
      .where(eq(paperReviews.citationId, loserId));

    await expect(mergeCitations(db, winnerId, loserId)).rejects.toThrow(/dataset URLs/);

    const [after] = await db
      .select({ citationId: paperReviews.citationId })
      .from(paperReviews)
      .where(eq(paperReviews.id, review!.id));
    expect(after?.citationId).toBe(loserId);
    // And the citation is still there to merge again once the cohorts are sorted.
    expect(
      await db.select({ id: citations.id }).from(citations).where(eq(citations.id, loserId)),
    ).toHaveLength(1);
  });

  it('refuses the whole group before the first of its merges', async () => {
    // Three handles for one paper are merged one loser at a time, by both
    // callers. A pair-at-a-time check passes on the first — the winner carries
    // no cohort yet — commits it, and only then meets the second loser's
    // conflicting baseline: a group reported as refused with one citation
    // already merged, which is the half-applied merge the preflight exists to
    // prevent, one step further out.
    const firstLoser = loserId;
    const secondLoser = await seedCitation('doi', '10.1093/jat/bkt099');
    await seedCohort(firstLoser, { sourceDatasetUrl: 'https://example.org/a.csv' });
    await seedCohort(secondLoser, { sourceDatasetUrl: 'https://example.org/b.csv' });

    await expect(
      assertNoConflictingCohortBaselines(db, [winnerId, firstLoser, secondLoser]),
    ).rejects.toThrow(/dataset URLs/);

    // The pair the first merge would have been given is not itself in conflict,
    // which is the point: checked pairwise, that merge runs.
    await expect(
      assertNoConflictingCohortBaselines(db, [winnerId, firstLoser]),
    ).resolves.toBeUndefined();
  });

  it('names the admin whose admission record the fold deletes', async () => {
    // The folded row is the only record that this admin admitted this dataset.
    // Deleting it without saying so leaves the survivor attributing both
    // admissions to whoever admitted the row that happened to win, and
    // invariant 31 stops being auditable for the other one.
    const otherAdmin = await seedUser(db, {
      email: 'other@example.com',
      username: 'other',
    });
    const kept = await seedCohort(winnerId);
    await seedCohort(loserId, { authorizedBy: otherAdmin });

    await mergeCitations(db, winnerId, loserId);

    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, kept));
    expect(survivor?.notes).toContain(`admitted by user ${otherAdmin}`);
  });

  it('keeps every fold record on a cohort that absorbs more than one', async () => {
    // Read-modify-write loses a record here: two merges folding different
    // losers into one survivor both read the same notes, both pass their own
    // marker check, and the second write overwrites the first — a cohort
    // deleted with no trace of where it went. The append is one statement, so
    // each record survives the next.
    const kept = await seedCohort(winnerId);
    const first = await seedCohort(loserId, { transformationNotes: 'First fold.' });
    const secondLoser = await seedCitation('doi', '10.1093/jat/bkt099');
    const second = await seedCohort(secondLoser, { transformationNotes: 'Second fold.' });

    await mergeCitations(db, winnerId, loserId);
    await mergeCitations(db, winnerId, secondLoser);

    const [survivor] = await db
      .select({ notes: patternReferenceCohorts.transformationNotes })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, kept));
    expect(survivor?.notes).toContain(`folded cohort ${first} (`);
    expect(survivor?.notes).toContain(`folded cohort ${second} (`);
    expect(survivor?.notes).toContain('First fold.');
    expect(survivor?.notes).toContain('Second fold.');
  });

  it('refuses to install a dataset URL the admission never had', async () => {
    // Invariant 32 aborts an import when the recomputed URL differs from the
    // admission record, so the URL is part of what the import verifies.
    const recorded = await seedCohort(winnerId, {
      sourceDatasetUrl: 'https://example.org/dataset.csv',
    });
    await expect(
      db
        .update(patternReferenceCohorts)
        .set({ sourceDatasetUrl: 'https://example.org/other.csv' })
        .where(eq(patternReferenceCohorts.id, recorded)),
    ).rejects.toThrow();

    // Including null → value: a cohort admitted with no URL was admitted with
    // nothing for an import to verify against, so supplying one afterwards
    // installs a baseline the admission never had. §34.3's answer is a new
    // admission.
    const blank = await seedCohort(winnerId, { subgroupKey: 'later-url' });
    await expect(
      db
        .update(patternReferenceCohorts)
        .set({ sourceDatasetUrl: 'https://example.org/first.csv' })
        .where(eq(patternReferenceCohorts.id, blank)),
    ).rejects.toThrow();
  });

  it('refuses to rewrite the dataset identity it was admitted under', async () => {
    const cohortId = await seedCohort(winnerId);

    // The importer verifies the file in hand against these values. Editable,
    // they verify nothing: move the baseline and changed input passes against
    // it. The comment saying "immutable" is not a constraint, so the database
    // carries one.
    await expect(
      db
        .update(patternReferenceCohorts)
        .set({ sourceDatasetHash: 'sha256:rewritten' })
        .where(eq(patternReferenceCohorts.id, cohortId)),
    ).rejects.toThrow();

    // What a merge does to the same row is untouched, because a merge says
    // which handle names the paper rather than which dataset was admitted.
    await db
      .update(patternReferenceCohorts)
      .set({ citationId: loserId })
      .where(eq(patternReferenceCohorts.id, cohortId));
    const [row] = await db
      .select({ citationId: patternReferenceCohorts.citationId })
      .from(patternReferenceCohorts)
      .where(eq(patternReferenceCohorts.id, cohortId));
    expect(row?.citationId).toBe(loserId);
  });

  it('keeps two cohorts that are different admissions', async () => {
    // Two subgroups of one paper, or two datasets: distinct identity tuples, so
    // both are real admissions and both survive under the winner.
    const first = await seedCohort(winnerId, { subgroupKey: 'living' });
    const second = await seedCohort(loserId, { subgroupKey: 'postmortem' });

    await mergeCitations(db, winnerId, loserId);

    const rows = await db
      .select({ id: patternReferenceCohorts.id, citationId: patternReferenceCohorts.citationId })
      .from(patternReferenceCohorts);
    expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [first, second].sort((a, b) => a - b),
    );
    expect(rows.every((row) => row.citationId === winnerId)).toBe(true);
  });
});
