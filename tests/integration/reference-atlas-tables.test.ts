/**
 * The atlas below the admission record (spec §18.2–18.6).
 *
 * These are constraint tests, and they are worth having because every one of
 * them is a rule the codebase would otherwise state only in prose. A comment
 * saying a censored count cannot exceed n does not stop a transcription error
 * from inflating a denominator; a check constraint does.
 *
 * The cascade tests are the other half: withdrawing an admission has to take
 * its data, because an observation that outlived the admission it arrived
 * under is exactly the row invariant 31 forbids.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  analyticalMethodComponents,
  analyticalMethods,
  patternReferenceAggregates,
  patternReferenceCases,
  patternReferenceCohorts,
  patternReferenceExposures,
  patternReferenceObservations,
  patternReferenceSpecimens,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;
let cohortId: number;

let handle = 0;

async function seedCohort(over: Record<string, unknown> = {}): Promise<number> {
  const citationId = await seedAdmissibleCitation(db, {
    identifier: `${24500275 + (handle += 1)}`,
  });
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

async function seedCase(over: Record<string, unknown> = {}): Promise<number> {
  const [row] = await db
    .insert(patternReferenceCases)
    .values({ cohortId, sourceSubjectKey: 'case 1', sourceLocator: 'Table 2', ...over })
    .returning({ id: patternReferenceCases.id });
  return row!.id;
}

async function seedSpecimen(caseId: number, over: Record<string, unknown> = {}): Promise<number> {
  const [row] = await db
    .insert(patternReferenceSpecimens)
    .values({ caseId, matrix: 'whole_blood', sourceLocator: 'Methods, p. 3', ...over })
    .returning({ id: patternReferenceSpecimens.id });
  return row!.id;
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
  drugId = await seedDrug(db);
  cohortId = await seedCohort();
});

describe('the reference atlas tables', () => {
  it('anchors a case on the cohort, and lets one case override it', async () => {
    // §18.2: the cohort carries the origin because a cohort is normally one
    // study with one design; a cohort assembled from case reports that
    // genuinely differ sets it per case.
    const shared = await seedCase();
    const overridden = await seedCase({ sourceSubjectKey: 'case 2', timeOrigin: 'death' });

    const rows = await db
      .select({ id: patternReferenceCases.id, origin: patternReferenceCases.timeOrigin })
      .from(patternReferenceCases);
    expect(rows.find((row) => row.id === shared)?.origin).toBeNull();
    expect(rows.find((row) => row.id === overridden)?.origin).toBe('death');
  });

  it('refuses a time origin outside the vocabulary a case is compared in', async () => {
    // Not a stricter origin — an origin the matcher cannot read. Stored, it
    // would drop the case out of every time-conditioned comparison silently
    // instead of failing here (§7.3).
    await expect(seedCase({ timeOrigin: 'since_last_dose' })).rejects.toThrow();
    await expect(
      seedCohort({ timeOrigin: 'ingestion' }),
    ).rejects.toThrow();
  });

  it('refuses the same subject twice under one admission', async () => {
    // A second import of one dataset is the same subjects, and counted twice
    // they are a wrong denominator under every percentile the ladder reports.
    await seedCase({ sourceSubjectKey: 'subject B' });
    await expect(seedCase({ sourceSubjectKey: 'subject B' })).rejects.toThrow();
    // The same key under a different admission is a different study's subject.
    const other = await seedCohort({ sourceDatasetHash: 'sha256:def' });
    await expect(
      seedCase({ cohortId: other, sourceSubjectKey: 'subject B' }),
    ).resolves.toBeGreaterThan(0);
  });

  it('takes the whole chain when an admission is withdrawn', async () => {
    // Invariant 31 the other way round: an observation that outlived the
    // admission it arrived under is atlas data nobody admitted.
    const caseId = await seedCase();
    const specimenId = await seedSpecimen(caseId);
    await db
      .insert(patternReferenceObservations)
      .values({ specimenId, drugId, value: '120', unit: 'nmol/L', qualifier: 'quantified', sourceLocator: 'Table 3' });
    await db
      .insert(patternReferenceExposures)
      .values({ caseId, drugId, certainty: 'confirmed', sourceLocator: 'Case narrative' });
    await db
      .insert(patternReferenceAggregates)
      .values({ cohortId, drugId, matrix: 'whole_blood', statisticOf: 'concentration', n: 40, sourceLocator: 'Table 1' });

    await db.delete(patternReferenceCohorts).where(eq(patternReferenceCohorts.id, cohortId));

    expect(await db.select().from(patternReferenceCases)).toEqual([]);
    expect(await db.select().from(patternReferenceSpecimens)).toEqual([]);
    expect(await db.select().from(patternReferenceObservations)).toEqual([]);
    expect(await db.select().from(patternReferenceExposures)).toEqual([]);
    expect(await db.select().from(patternReferenceAggregates)).toEqual([]);
  });

  it('refuses a transcribed row that cannot be located in its source', async () => {
    // Invariant 29: reference imports carry a locator. Nullable, the column
    // reads as provenance and is not — and a blank string satisfies NOT NULL
    // while locating exactly as little as a null.
    await expect(
      db
        .insert(patternReferenceCases)
        .values({ cohortId, sourceSubjectKey: 'case 9' } as never),
    ).rejects.toThrow();
    await expect(seedCase({ sourceSubjectKey: 'case 9', sourceLocator: '   ' })).rejects.toThrow();
    const caseId = await seedCase();
    await expect(
      db
        .insert(patternReferenceSpecimens)
        .values({ caseId, matrix: 'whole_blood', sourceLocator: '' }),
    ).rejects.toThrow();
  });

  it('refuses a censored observation that does not say what it is below', async () => {
    // "< LOQ" with no limit cannot be turned into the interval matching needs,
    // nor counted as censored against a threshold — it sits in the atlas
    // looking like a measurement and answering nothing.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db
        .insert(patternReferenceObservations)
        .values({ specimenId, drugId, qualifier: 'below_limit', sourceLocator: 'Table 3' }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        qualifier: 'below_limit',
        sourceLocator: 'Table 3',
        limitLabel: 'LOQ',
        limitValue: '5',
        limitUnit: 'nmol/L',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a threshold nobody named', async () => {
    // "LOD", "LOQ" and "cutoff" are not synonyms: a value below an LOD and a
    // value below an administrative cutoff say different things about what was
    // in the sample, and a bare number cannot be read back as either (§9.1).
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        qualifier: 'below_limit',
        limitValue: '5',
        limitUnit: 'ng/mL',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
        lowerLimitValue: '1',
        lowerLimitUnit: 'nmol/L',
        lowerLimitLabel: '  ',
      }),
    ).rejects.toThrow();
  });

  it('refuses an exposure whose stated time is outside its own window', async () => {
    // Two answers in one row, and which one a consumer gets depends on which
    // column it happens to read.
    const caseId = await seedCase();
    await expect(
      db.insert(patternReferenceExposures).values({
        caseId,
        drugId,
        certainty: 'reported',
        sourceLocator: 'Table 1',
        timeRelativeHours: '10',
        timeLowHours: '2',
        timeHighHours: '6',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceExposures).values({
        caseId,
        drugId,
        certainty: 'reported',
        sourceLocator: 'Table 1',
        timeRelativeHours: '4',
        timeLowHours: '2',
        timeHighHours: '6',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a feature aggregate with no definition behind it', async () => {
    // A feature is a formula that changes. Named without a version, the
    // envelope cannot be checked against the active definition, so it would be
    // pooled with envelopes computed a different way and read as one
    // population.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        featureId: 'eddp_mtd_b',
        sourceLocator: 'Table 1',
        median: '0.4',
      }),
    ).rejects.toThrow();
  });

  it('refuses a concentration envelope whose numbers have no unit', async () => {
    // It cannot be converted to the basis an observation is held in, and a
    // drug, a matrix and a bare number read as though already canonical.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        median: '120',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        median: '120',
        unit: 'nmol/L',
      }),
    ).resolves.toBeDefined();
    // An envelope reporting only counts has no magnitude to put a unit on.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'urine',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        n: 40,
        nCensored: 12,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a blank unit as firmly as a missing one', async () => {
    // Whitespace passes a null check and converts to nothing; later matching
    // code would read it as though the value were already canonical.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db
        .insert(patternReferenceObservations)
        .values({
          specimenId,
          drugId,
          sourceLocator: 'T3',
          value: '10',
          unit: '   ',
          qualifier: 'quantified',
        }),
    ).rejects.toThrow();
  });

  it('refuses a censored count with no total behind it', async () => {
    // "12 below the limit" out of nothing gives neither the quantified count
    // nor the censoring fraction, which is why §21.1 asks for it at all.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        nCensored: 12,
      }),
    ).rejects.toThrow();
  });

  it('refuses a method that does not measure the analyte', async () => {
    // Two separate keys say only that both rows exist. Bound that loosely, an
    // observation could name a method that measures something else and inherit
    // its reporting limits and uncertainty.
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'BZD1', name: 'LC-MS/MS, benzodiazepines' })
      .returning({ id: analyticalMethods.id });
    const other = await seedDrug(db, { slug: 'other-drug', names: { nb: 'Annet', en: 'Other' } });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: other });
    const specimenId = await seedSpecimen(await seedCase());

    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        analyticalMethodId: method!.id,
        sourceLocator: 'T3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
      }),
    ).rejects.toThrow();

    // The analyte the method does measure is fine, and so is the ordinary
    // case: a published reference naming no method at all.
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId });
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        analyticalMethodId: method!.id,
        sourceLocator: 'T3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a blank where a null would be refused', async () => {
    // Whitespace passes a null check and names nothing. Swept across the
    // columns that identify something rather than fixed one at a time: a
    // subject key, a matrix, a dose unit, a feature id.
    const caseId = await seedCase();
    await expect(seedCase({ sourceSubjectKey: '  ' })).rejects.toThrow();
    await expect(
      db
        .insert(patternReferenceSpecimens)
        .values({ caseId, matrix: ' ', sourceLocator: 'M' }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceExposures).values({
        caseId,
        drugId,
        certainty: 'confirmed',
        sourceLocator: 'T1',
        amount: '10',
        amountUnit: ' ',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        featureId: '  ',
        featureVersion: '1',
        sourceLocator: 'T1',
        n: 31,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: ' ',
        statisticOf: 'concentration',
        sourceLocator: 'T1',
        n: 31,
      }),
    ).rejects.toThrow();
  });

  it('refuses a summary that is not one', async () => {
    // A negative spread, a maximum below its own minimum, a third quartile
    // below the first: transcription errors that reach the screen as an
    // envelope drawn backwards rather than as anything that looks wrong.
    const envelope = (over: Record<string, unknown>) =>
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        unit: 'nmol/L',
        ...over,
      } as never);
    await expect(envelope({ median: '10', sd: '-1' })).rejects.toThrow();
    await expect(envelope({ min: '10', max: '2' })).rejects.toThrow();
    await expect(envelope({ p25: '10', p75: '2' })).rejects.toThrow();
    await expect(envelope({ min: '2', max: '10', p25: '3', p75: '8', sd: '1' })).resolves.toBeDefined();
  });

  it('refuses an aggregate that reports no statistic at all', async () => {
    // Backs no envelope and no count — but it is atlas data to everything
    // that asks whether a cohort was imported, the citation merge included.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        featureId: 'eddp_mtd_b',
        featureVersion: '1',
        sourceLocator: 'Table 1',
      }),
    ).rejects.toThrow();
  });

  it('keeps observations in the vocabularies matching is written against', async () => {
    // A mode or a qualifier outside them is not a stricter statement about the
    // assay — it is one no rule in §20 covers, so the reference drops out of
    // compatible-reference matching without ever failing.
    const specimenId = await seedSpecimen(await seedCase());
    const observation = (over: Record<string, unknown>) =>
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
        ...over,
      } as never);
    await expect(observation({ measurandMode: 'total_after_hydrolsis' })).rejects.toThrow();
    // A transcribed glyph is not a state: the atlas records the state, and the
    // "<" is a rendering decision §9.1 makes at the screen.
    await expect(observation({ qualifier: '<' })).rejects.toThrow();
    // And the longest canonical qualifier fits, which a VARCHAR(20) refused.
    // It is a censored state, so it carries its threshold and no value.
    await expect(
      observation({
        measurandMode: 'total_after_hydrolysis',
        qualifier: 'detected_not_quantified',
        value: null,
        unit: null,
        limitLabel: 'LOQ',
        limitValue: '0.01',
        limitUnit: 'µmol/L',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a bound at or below zero', async () => {
    // `resolveValue` already reads one as indeterminate, so the row would
    // contribute no interval while looking like a censored result that should.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        qualifier: 'below_limit',
        limitLabel: 'LOQ',
        limitValue: '0',
        limitUnit: 'nmol/L',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
        lowerLimitLabel: 'LOD',
        lowerLimitValue: '-1',
        lowerLimitUnit: 'nmol/L',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        n: 40,
        limitLabel: 'LOQ',
        limitValue: '0',
        limitUnit: 'nmol/L',
      }),
    ).rejects.toThrow();
  });

  it('asks each observation for what its own state resolves from', async () => {
    // `resolveValue` reads the value for a quantified result and the limit for
    // a censored one, so a quantified row holding only a threshold and a
    // censored row holding only a number both resolve to indeterminate while
    // looking on the page like complete observations.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'quantified',
        limitLabel: 'LOQ',
        limitValue: '5',
        limitUnit: 'nmol/L',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'below_limit',
        value: '3',
        unit: 'nmol/L',
        limitLabel: 'LOQ',
        limitValue: '5',
        limitUnit: 'nmol/L',
      }),
    ).rejects.toThrow();
    // A row that does not say which state it is in falls to `resolveValue`'s
    // default branch and resolves to nothing.
    await expect(
      db
        .insert(patternReferenceObservations)
        .values({ specimenId, drugId, sourceLocator: 'T3', value: '10', unit: 'nmol/L' } as never),
    ).rejects.toThrow();
    // A negative concentration is not a measurement; a quantified zero is
    // (§8.1), so it stays.
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'quantified',
        value: '-1',
        unit: 'nmol/L',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'quantified',
        value: '0',
        unit: 'nmol/L',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses magnitudes that cannot be negative', async () => {
    // Swept rather than fixed one at a time: a dose, an age, a duration from
    // death, a volume. `collection_relative_hours` is deliberately not among
    // them — it is measured from the case's origin and is negative before it,
    // which is the ordinary case for a specimen taken before a declared
    // exposure.
    const caseId = await seedCase();
    await expect(seedCase({ sourceSubjectKey: 'c9', age: '-1' })).rejects.toThrow();
    await expect(
      db.insert(patternReferenceExposures).values({
        caseId,
        drugId,
        certainty: 'confirmed',
        sourceLocator: 'T1',
        amount: '-10',
        amountUnit: 'mg',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceSpecimens).values({
        caseId,
        matrix: 'femoral_blood',
        sourceLocator: 'M',
        postmortemIntervalHours: '-1',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceSpecimens).values({
        caseId,
        matrix: 'urine',
        sourceLocator: 'M',
        urinePh: '15',
      }),
    ).rejects.toThrow();
    // Creatinine is a denominator, and `creatinineFactor` returns null at or
    // below zero — stored as 0 the specimen shows an impossible measurement
    // and drops out of every creatinine-normalized comparison it was recorded
    // for.
    await expect(
      db.insert(patternReferenceSpecimens).values({
        caseId,
        matrix: 'urine',
        sourceLocator: 'M',
        urineCreatinineMmolL: '0',
      }),
    ).rejects.toThrow();
    // A specimen taken before the origin is ordinary, and stays allowed.
    await expect(
      db.insert(patternReferenceSpecimens).values({
        caseId,
        matrix: 'whole_blood',
        sourceLocator: 'M',
        collectionRelativeHours: '-3',
      }),
    ).resolves.toBeDefined();
  });

  it('stores subject keys unpadded, so uniqueness means one subject', async () => {
    // The index compares bytes, so 'case 1' and 'case 1 ' are two subjects to
    // it and one to everyone else — a re-import with incidental whitespace
    // would double every count the atlas reports for that study.
    await seedCase({ sourceSubjectKey: 'case 1' });
    await expect(seedCase({ sourceSubjectKey: 'case 1 ' })).rejects.toThrow();
    // And the padding a CSV column or a copied table cell actually brings:
    // one-argument btrim strips ordinary spaces and nothing else, so a tab or
    // a newline slipped past the first version of this rule.
    await expect(seedCase({ sourceSubjectKey: 'case 1\t' })).rejects.toThrow();
    await expect(seedCase({ sourceSubjectKey: 'case 1\n' })).rejects.toThrow();
    await expect(seedCase({ sourceSubjectKey: '\tcase 1' })).rejects.toThrow();
    // A locator of nothing but a tab locates as little as a blank one.
    await expect(
      seedCase({ sourceSubjectKey: 'case 2', sourceLocator: '\t' }),
    ).rejects.toThrow();
  });

  it('refuses an aggregate of no subjects', async () => {
    // n = 0 satisfies the has-content rule while representing nobody and
    // providing no denominator: an empty row wearing a number.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        n: 0,
      }),
    ).rejects.toThrow();
  });

  it('refuses NaN and infinity, which a lower bound lets through', async () => {
    // NUMERIC admits both, and NaN sorts above every finite value — so
    // `value >= 0` is true for it, and `resolveValue` only rejects what is
    // below zero. Either would travel into an interval as a real number.
    const specimenId = await seedSpecimen(await seedCase());
    for (const value of ['NaN', 'Infinity']) {
      await expect(
        db.insert(patternReferenceObservations).values({
          specimenId,
          drugId,
          sourceLocator: 'T3',
          qualifier: 'quantified',
          value,
          unit: 'nmol/L',
        }),
      ).rejects.toThrow();
    }
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        unit: 'nmol/L',
        median: 'Infinity',
      }),
    ).rejects.toThrow();
    await expect(seedCase({ sourceSubjectKey: 'c8', age: 'NaN' })).rejects.toThrow();
  });

  it('stores identifiers and units trimmed, since both are matched exactly', async () => {
    // A padded feature id names no feature and a padded unit converts to
    // nothing, each looking like a value that is simply unmatched.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        featureId: 'eddp_mtd_b ',
        featureVersion: '1',
        sourceLocator: 'Table 1',
        n: 31,
      }),
    ).rejects.toThrow();
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'quantified',
        value: '10',
        unit: 'nmol/L ',
      }),
    ).rejects.toThrow();
  });

  it('refuses a lower threshold that sits above the primary one', async () => {
    // Reversed, the pair reconstructs no interval — a detected-but-not-
    // quantified result bounded below by a number above its own upper bound.
    const specimenId = await seedSpecimen(await seedCase());
    const observation = (over: Record<string, unknown>) =>
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'detected_not_quantified',
        limitLabel: 'LOQ',
        limitValue: '5',
        limitUnit: 'nmol/L',
        lowerLimitLabel: 'LOD',
        ...over,
      } as never);
    await expect(observation({ lowerLimitValue: '10', lowerLimitUnit: 'nmol/L' })).rejects.toThrow();
    await expect(observation({ lowerLimitValue: '5', lowerLimitUnit: 'nmol/L' })).rejects.toThrow();
    await expect(
      observation({ lowerLimitValue: '1', lowerLimitUnit: 'nmol/L' }),
    ).resolves.toBeDefined();
    // Two units the database cannot compare without a molecular weight: §9.1
    // allows the pair, and checking it belongs to the importer.
    await expect(
      observation({ lowerLimitValue: '10', lowerLimitUnit: 'ng/mL' }),
    ).resolves.toBeDefined();
  });

  it('refuses a second threshold with no first one', async () => {
    // §9.1's lower limit is second to something; alone it is a bound the row
    // cannot place, and `resolveValue` reads `limitRef` — nothing looks here
    // on its own.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'T3',
        qualifier: 'quantified',
        value: '10',
        unit: 'nmol/L',
        lowerLimitLabel: 'LOD',
        lowerLimitValue: '1',
        lowerLimitUnit: 'nmol/L',
      }),
    ).rejects.toThrow();
  });

  it('keeps matrices in the vocabulary matching compares', async () => {
    // 'blood' is not a coarser statement than 'whole_blood' — it is a string
    // `PatternMatrix` has no case for, so the specimen misses every
    // blood-compatible reference set without anything failing.
    const caseId = await seedCase();
    await expect(
      db.insert(patternReferenceSpecimens).values({ caseId, matrix: 'blood', sourceLocator: 'M' }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        n: 40,
      }),
    ).rejects.toThrow();
    // 'other' is the escape value for a matrix the vocabulary cannot name.
    await expect(
      db.insert(patternReferenceSpecimens).values({ caseId, matrix: 'other', sourceLocator: 'M' }),
    ).resolves.toBeDefined();
  });

  it('refuses a negative concentration envelope', async () => {
    // A concentration is a magnitude. A feature can be signed — a log ratio
    // is — so this asks only of concentrations.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        unit: 'nmol/L',
        median: '-5',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        featureId: 'log_eddp_mtd_b',
        featureVersion: '1',
        sourceLocator: 'Table 1',
        median: '-0.4',
      }),
    ).resolves.toBeDefined();
    // A geometric mean is the exponential of a mean of logarithms, so it is
    // the one summary that cannot be signed even where the feature can.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        featureId: 'log_eddp_mtd_b',
        featureVersion: '1',
        sourceLocator: 'Table 1',
        geometricMean: '-1',
      }),
    ).rejects.toThrow();
  });

  it('keeps a mean inside the extrema it is summarising', async () => {
    // A sample mean outside its own observed range is not a summary of that
    // sample, and left out of the chain it passes every other comparison.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        unit: 'nmol/L',
        min: '10',
        mean: '5',
        max: '20',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        unit: 'nmol/L',
        min: '10',
        geometricMean: '25',
        max: '20',
      }),
    ).rejects.toThrow();
  });

  it('orders the whole summary, not just its endpoints', async () => {
    // Every pair sound in isolation and the envelope drawn backwards:
    // min 10, p25 5, median 20, p75 15, max 30.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        statisticOf: 'concentration',
        sourceLocator: 'Table 1',
        unit: 'nmol/L',
        min: '10',
        p25: '5',
        median: '20',
        p75: '15',
        max: '30',
      }),
    ).rejects.toThrow();
  });

  it('keeps an observation\u2019s method when its component row is rewritten', async () => {
    // The composite key clears `analytical_method_id` when the component row
    // goes, so any path that rebuilds a method's membership by deleting it
    // first strips every atlas observation of its method — including for
    // components it immediately puts back, since the row that returns is a
    // different row as far as the key is concerned. `replaceComponents` and
    // the seeder therefore delete only what is actually removed and upsert
    // the rest; this asserts the property they exist to preserve.
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'BZD2', name: 'LC-MS/MS' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId, lor: 1 });
    const specimenId = await seedSpecimen(await seedCase());
    const [observation] = await db
      .insert(patternReferenceObservations)
      .values({
        specimenId,
        drugId,
        analyticalMethodId: method!.id,
        sourceLocator: 'T3',
        qualifier: 'quantified',
        value: '10',
        unit: 'nmol/L',
      })
      .returning({ id: patternReferenceObservations.id });

    // An edit that keeps this component and changes its reporting limit.
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId, lor: 2 })
      .onConflictDoUpdate({
        target: [analyticalMethodComponents.methodId, analyticalMethodComponents.drugId],
        set: { lor: 2 },
      });

    const [after] = await db
      .select({ methodId: patternReferenceObservations.analyticalMethodId })
      .from(patternReferenceObservations)
      .where(eq(patternReferenceObservations.id, observation!.id));
    expect(after?.methodId).toBe(method!.id);

    // And a component genuinely removed does clear it, which is the behaviour
    // the key is for.
    await db
      .delete(analyticalMethodComponents)
      .where(eq(analyticalMethodComponents.methodId, method!.id));
    const [cleared] = await db
      .select({ methodId: patternReferenceObservations.analyticalMethodId })
      .from(patternReferenceObservations)
      .where(eq(patternReferenceObservations.id, observation!.id));
    expect(cleared?.methodId).toBeNull();
  });

  it('refuses a negative sample size', async () => {
    // The denominator every eligibility threshold and displayed count reads.
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        n: -1,
      }),
    ).rejects.toThrow();
  });

  it('refuses an exposure window with one end', async () => {
    // A row carrying only a low bound reads as "from here on", which is not
    // what a paper reporting a window said, and nothing downstream can tell
    // the two apart afterwards.
    const caseId = await seedCase();
    await expect(
      db
        .insert(patternReferenceExposures)
        .values({ caseId, drugId, certainty: 'reported', timeLowHours: '2', sourceLocator: 'Table 1' }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceExposures).values({
        caseId,
        drugId,
        certainty: 'reported',
        sourceLocator: 'Table 1',
        timeLowHours: '6',
        timeHighHours: '2',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceExposures).values({
        caseId,
        drugId,
        certainty: 'reported',
        sourceLocator: 'Table 1',
        timeLowHours: '2',
        timeHighHours: '6',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses an amount with no unit', async () => {
    // A number somebody will read as milligrams.
    const caseId = await seedCase();
    await expect(
      db
        .insert(patternReferenceExposures)
        .values({ caseId, drugId, certainty: 'confirmed', amount: '10', sourceLocator: 'Table 1' }),
    ).rejects.toThrow();
  });

  it('refuses an observation that reports nothing', async () => {
    // Neither a value nor a censoring qualifier. Stored, it is counted as an
    // observation by every denominator that touches it.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db.insert(patternReferenceObservations).values({ specimenId, drugId, sourceLocator: 'T3' }),
    ).rejects.toThrow();
    // A censored result is a result: "< LOQ" with the limit beside it.
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        qualifier: 'below_limit',
        limitLabel: 'LOQ',
        limitValue: '5',
        limitUnit: 'nmol/L',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a limit with no unit, on either threshold', async () => {
    // §9.1: each threshold carries its own unit and they need not agree, so
    // neither can inherit the other's.
    const specimenId = await seedSpecimen(await seedCase());
    await expect(
      db
        .insert(patternReferenceObservations)
        .values({
          specimenId,
          drugId,
          value: '10',
          unit: 'nmol/L',
          qualifier: 'quantified',
          limitValue: '5',
          sourceLocator: 'T3',
        }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
        lowerLimitValue: '1',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceObservations).values({
        specimenId,
        drugId,
        sourceLocator: 'Table 3',
        value: '10',
        unit: 'nmol/L',
        qualifier: 'quantified',
        limitLabel: 'cutoff',
        limitValue: '5',
        limitUnit: 'ng/mL',
        lowerLimitLabel: 'LOD',
        lowerLimitValue: '1',
        lowerLimitUnit: 'nmol/L',
      }),
    ).resolves.toBeDefined();
  });

  it('transcribes the measurand rather than inheriting it', async () => {
    // A published reference was not measured by one of this installation's
    // methods, so the method is null and the mode is what the paper said —
    // 'unknown' where it said nothing, which downgrades rather than matching.
    const specimenId = await seedSpecimen(await seedCase());
    const [row] = await db
      .insert(patternReferenceObservations)
      .values({ specimenId, drugId, value: '120', unit: 'nmol/L', qualifier: 'quantified', sourceLocator: 'Table 3' })
      .returning({
        method: patternReferenceObservations.analyticalMethodId,
        mode: patternReferenceObservations.measurandMode,
      });
    expect(row?.method).toBeNull();
    expect(row?.mode).toBe('unknown');
  });

  it('ties a feature aggregate to a feature, in both directions', async () => {
    // A feature row with no feature names no statistic; a concentration row
    // carrying one claims a feature the study did not report (invariant 17).
    await expect(
      db
        .insert(patternReferenceAggregates)
        .values({ cohortId, statisticOf: 'feature', median: '0.4', sourceLocator: 'T1' }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        featureId: 'eddp_mtd_b',
        median: '0.4',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        statisticOf: 'feature',
        sourceLocator: 'Table 1',
        featureId: 'eddp_mtd_b',
        featureVersion: '1',
        median: '0.4',
        n: 31,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a concentration envelope with no substance or no matrix', async () => {
    // Unmatchable: §20 cannot compare an envelope whose subject nobody stated.
    await expect(
      db
        .insert(patternReferenceAggregates)
        .values({ cohortId, matrix: 'whole_blood', statisticOf: 'concentration', sourceLocator: 'T1' }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(patternReferenceAggregates)
        .values({ cohortId, drugId, statisticOf: 'concentration', sourceLocator: 'T1' }),
    ).rejects.toThrow();
  });

  it('keeps the censored count inside the n it belongs to', async () => {
    // "12 of 40 were below the limit" says something the median cannot, and a
    // count larger than n inflates the quantified denominator (§21.1).
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        n: 40,
        nCensored: 41,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        n: 40,
        nCensored: -1,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(patternReferenceAggregates).values({
        cohortId,
        drugId,
        matrix: 'whole_blood',
        sourceLocator: 'Table 1',
        statisticOf: 'concentration',
        n: 40,
        nCensored: 12,
      }),
    ).resolves.toBeDefined();
  });
});
