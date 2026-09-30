import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugParameters, parameterEntries } from '../../db/schema.js';
import {
  bucketFor,
  renderMarkdown,
  reviewDrug,
  type RouteReview,
} from '../../scripts/derived-model-review-queue.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

/**
 * CV-5 preparation — the derived-model review-queue tool. The classification (`bucketFor`) and the
 * report (`renderMarkdown`) are pure and tested directly across every bucket, since the live catalog
 * is empty today and cannot exercise the non-empty paths. `reviewDrug` is exercised against PGlite
 * for the real read: a drug with no route data, a fully-asserted rendering drug, a drug whose family
 * axes fall back to the disclosed default, a structurally-supported route missing a required value
 * (which does NOT render — the assembly is the authority, not the grade), and the citation evidence
 * surfaced for asserted axes (including an asserted-but-uncited flag).
 */

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

async function insertAxis(
  drugId: number,
  userId: number,
  parameter: string,
  categoricalValue: string,
  route: string | null = null,
  citationId: number | null = null,
): Promise<void> {
  await db.insert(parameterEntries).values({
    drugId,
    parameter,
    categoricalValue,
    unit: '',
    route,
    citationId,
    createdBy: userId,
    origin: 'contributor',
  } as never);
}

async function insertNumeric(
  drugId: number,
  userId: number,
  parameter: string,
  route: string | null,
  over: { low?: number; high?: number; median?: number; unit?: string } = {},
): Promise<void> {
  await db.insert(parameterEntries).values({
    drugId,
    parameter,
    low: String(over.low ?? 1),
    high: over.high != null ? String(over.high) : null,
    median: over.median != null ? String(over.median) : null,
    unit: over.unit ?? '',
    route,
    createdBy: userId,
    origin: 'contributor',
  } as never);
}

async function setDrugLevelParameter(
  drugId: number,
  userId: number,
  parameter: string,
  value: unknown,
): Promise<void> {
  await db.insert(drugParameters).values({
    drugId,
    parameter,
    value: value as never,
    updatedBy: userId,
  });
}

/** A RouteReview with sensible defaults, overridable per test — for the pure classification cases. */
function route(over: Partial<RouteReview> = {}): RouteReview {
  return {
    route: 'oral',
    outcome: 'modelable',
    rendersCurve: true,
    family: 'one-compartment-first-order',
    structure: { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
    defaultedAxes: [],
    simplifiedFrom: {},
    defaultedParameters: [],
    grade: 'B',
    limitingFactor: null,
    missingParameters: [],
    sources: [],
    uncitedAxes: [],
    reason: null,
    ...over,
  };
}

describe('bucketFor — review priority classification', () => {
  it('buckets a drug with no derived routes as no-route-data', () => {
    expect(bucketFor([])).toBe('no-route-data');
  });

  it('buckets a drug whose only routes render no curve as not-modelable', () => {
    expect(
      bucketFor([route({ rendersCurve: false, outcome: 'not-modelable', family: null })]),
    ).toBe('not-modelable');
  });

  it('buckets a rendering curve with a guessed family axis as default-family-curve (highest)', () => {
    // Disposition defaulted → the family itself is a guess. Most dangerous.
    expect(bucketFor([route({ defaultedAxes: ['disposition'] })])).toBe('default-family-curve');
    expect(bucketFor([route({ defaultedAxes: ['elimination', 'absorption'] })])).toBe(
      'default-family-curve',
    );
  });

  it('buckets a curve running a simpler family than declared as simplified-family-curve', () => {
    const simplified = route({ simplifiedFrom: { disposition: 'two-compartment' } });
    expect(bucketFor([simplified])).toBe('simplified-family-curve');
    // Ranked below a guessed family, above everything a declared family can land in.
    expect(bucketFor([simplified, route({ defaultedAxes: ['elimination'] })])).toBe(
      'default-family-curve',
    );
    expect(bucketFor([simplified, route({ family: 'michaelis-menten' })])).toBe(
      'simplified-family-curve',
    );
  });

  it('buckets a curve on a cautious default as default-parameter-curve, below a simplified family', () => {
    const defaulted = route({ defaultedParameters: ['bioavailability'] });
    expect(bucketFor([defaulted])).toBe('default-parameter-curve');
    expect(
      bucketFor([defaulted, route({ simplifiedFrom: { disposition: 'two-compartment' } })]),
    ).toBe('simplified-family-curve');
    expect(bucketFor([defaulted, route({ family: 'michaelis-menten' })])).toBe(
      'default-parameter-curve',
    );
  });

  it('buckets a rendering non-linear family as asserted-complex', () => {
    expect(bucketFor([route({ family: 'two-compartment-first-order' })])).toBe('asserted-complex');
    expect(bucketFor([route({ family: 'michaelis-menten' })])).toBe('asserted-complex');
  });

  it('buckets a rendering, fully-asserted curve with an uncited axis as uncited-asserted', () => {
    expect(bucketFor([route({ uncitedAxes: ['disposition'] })])).toBe('uncited-asserted');
  });

  it('ranks uncited-asserted ahead of default-absorption — an uncited claim beats a disclosed default', () => {
    expect(
      bucketFor([route({ defaultedAxes: ['absorption'], uncitedAxes: ['disposition'] })]),
    ).toBe('uncited-asserted');
  });

  it('buckets a rendering curve with only absorption defaulted (and everything else cited) as default-absorption', () => {
    expect(bucketFor([route({ defaultedAxes: ['absorption'] })])).toBe('default-absorption');
  });

  it('buckets a fully-asserted, fully-cited linear one-compartment curve as simple-asserted', () => {
    expect(bucketFor([route()])).toBe('simple-asserted');
  });

  it('takes the most dangerous bucket across a drug’s several routes', () => {
    // One simple route + one guessed-family route → the guessed family dominates.
    expect(
      bucketFor([route({ route: 'iv' }), route({ route: 'oral', defaultedAxes: ['elimination'] })]),
    ).toBe('default-family-curve');
  });
});

describe('renderMarkdown', () => {
  it('renders a summary table and one section per bucket', () => {
    const md = renderMarkdown([
      {
        slug: 'aspirin',
        displayName: 'Aspirin',
        bucket: 'simple-asserted',
        routes: [route()],
        moleculeAxes: { disposition: ['one-compartment'], elimination: ['first-order'] },
      },
      {
        slug: 'zzz-unknown',
        displayName: 'Unknown',
        bucket: 'no-route-data',
        routes: [],
        moleculeAxes: { disposition: [], elimination: [] },
      },
    ]);
    expect(md).toContain('# Derived-model review queue');
    expect(md).toContain('## Summary');
    expect(md).toContain('`simple-asserted`');
    expect(md).toContain('Aspirin');
    // The no-route-data split reports the undeclared drug.
    expect(md).toContain('No family declaration yet');
    expect(md).toContain('`zzz-unknown`');
  });
});

describe('reviewDrug — real DB read', () => {
  it('reports a drug with no route data as no-route-data, capturing declared family axes', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    // Molecule-level family declared, but no route-scoped row → nothing derives yet.
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    expect(review.bucket).toBe('no-route-data');
    expect(review.routes).toEqual([]);
    expect(review.moleculeAxes).toEqual({
      disposition: ['one-compartment'],
      elimination: ['first-order'],
    });
  });

  it('reports a fully-asserted, fully-cited oral first-order drug as simple-asserted, rendering a curve', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const dispositionCite = await seedAdmissibleCitation(db, { identifier: '66666666' });
    const eliminationCite = await seedAdmissibleCitation(db, { identifier: '77777777' });
    const absorptionCite = await seedAdmissibleCitation(db, { identifier: '88888888' });
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment', null, dispositionCite);
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order', null, eliminationCite);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral', absorptionCite);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    expect(review.bucket).toBe('simple-asserted');
    expect(review.routes).toHaveLength(1);
    const [r] = review.routes;
    expect(r.route).toBe('oral');
    expect(r.rendersCurve).toBe(true);
    expect(r.family).toBe('one-compartment-first-order');
    expect(r.defaultedAxes).toEqual([]);
    expect(r.uncitedAxes).toEqual([]);
  });

  it('reports a route with an undeclared family as default-family-curve', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    // No disposition/elimination declared — both fall back to the disclosed default. Only the route's
    // absorption + the numbers are authored, so a curve renders on a GUESSED family.
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    expect(review.bucket).toBe('default-family-curve');
    const [r] = review.routes;
    expect(r.rendersCurve).toBe(true);
    expect(r.defaultedAxes).toEqual(expect.arrayContaining(['disposition', 'elimination']));
  });

  it('reports an asserted two-compartment drug run one-compartment as simplified-family-curve', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const dispositionCite = await seedAdmissibleCitation(db, { identifier: '33333333' });
    const eliminationCite = await seedAdmissibleCitation(db, { identifier: '44444444' });
    const absorptionCite = await seedAdmissibleCitation(db, { identifier: '55555555' });
    await insertAxis(drugId, userId, 'dispositionModel', 'two-compartment', null, dispositionCite);
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order', null, eliminationCite);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral', absorptionCite);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    // Not `simple-asserted`: the curve drawn is not the family the evidence declares.
    expect(review.bucket).toBe('simplified-family-curve');
    const [r] = review.routes;
    expect(r.rendersCurve).toBe(true);
    expect(r.structure.disposition).toBe('one-compartment');
    expect(r.simplifiedFrom).toEqual({ disposition: 'two-compartment' });
    // The two-compartment citation backs the declared family, not the one drawn.
    expect(r.sources).not.toContain(dispositionCite);
    expect(r.sources).toEqual([eliminationCite, absorptionCite].sort((a, b) => a - b));
    // Graded like a defaulted axis, as the derived tier grades it — not as a fully-asserted A.
    expect(r.grade).not.toBe('A');
    expect(renderMarkdown([review])).toContain('(simplified from two-compartment)');
  });

  it('does not render a curve for a structurally-supported route that lacks a required value', async () => {
    // The rendering authority is the assembly, not the grade: an oral first-order route with no Vd
    // is `incomplete` — a volume has no cautious direction, so it is never defaulted — and the
    // artifact would contain no curve even though the derivation still grades it.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    expect(review.routes).toHaveLength(1);
    const [r] = review.routes;
    expect(r.rendersCurve).toBe(false);
    expect(r.missingParameters).toContain('vd');
    // No route renders a curve → the drug is not-modelable, not a curve-rendering bucket.
    expect(review.bucket).toBe('not-modelable');
  });

  it('reports a curve standing on a cautious default as default-parameter-curve', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const cite = await seedAdmissibleCitation(db, { identifier: '99999999' });
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment', null, cite);
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order', null, cite);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral', cite);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    // No F anywhere: the route runs on F = 1, and the reviewer is told.

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    expect(review.bucket).toBe('default-parameter-curve');
    const [r] = review.routes;
    expect(r.rendersCurve).toBe(true);
    expect(r.defaultedParameters).toEqual(['bioavailability']);
    expect(r.grade).not.toBe('A');
    expect(renderMarkdown([review])).toContain('cautious default: bioavailability');
  });

  it('surfaces the citations backing asserted axes, and flags an uncited one', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const dispositionCite = await seedAdmissibleCitation(db, { identifier: '11111111' });
    const absorptionCite = await seedAdmissibleCitation(db, { identifier: '22222222' });
    // disposition + absorption are cited; elimination is asserted with NO citation.
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment', null, dispositionCite);
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order'); // uncited
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral', absorptionCite);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    const [r] = review.routes;
    expect(r.rendersCurve).toBe(true);
    // Both cited axes' sources are surfaced, sorted and deduped.
    expect(r.sources).toEqual([dispositionCite, absorptionCite].sort((a, b) => a - b));
    // The asserted-but-uncited elimination axis is flagged.
    expect(r.uncitedAxes).toEqual(['elimination']);
  });

  it('retains BOTH citations on a conflicting axis, not just the one matching the resolved default', async () => {
    // Two conflicting disposition declarations, each cited. The axis resolves to the disclosed default
    // (`one-compartment`) with `asserted` provenance (the conflict itself was asserted), so a
    // value-keyed evidence lookup would surface only the citation for `one-compartment` — dropping the
    // two-compartment citation and potentially mislabelling the axis "uncited" if the default happened
    // to be the UNcited value. Evidence must be aggregated across every declared value for the axis.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const oneCompCite = await seedAdmissibleCitation(db, { identifier: '33333333' });
    const twoCompCite = await seedAdmissibleCitation(db, { identifier: '44444444' });
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment', null, oneCompCite);
    await insertAxis(drugId, userId, 'dispositionModel', 'two-compartment', null, twoCompCite);
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    // A conflict makes the whole drug not-modelable — no route renders — but the evidence lookup is
    // exercised the same way regardless, so assert directly on the (non-rendering) route's evidence.
    const [r] = review.routes;
    expect(r.rendersCurve).toBe(false);
    expect(r.sources).toEqual(expect.arrayContaining([oneCompCite, twoCompCite]));
    expect(r.uncitedAxes).not.toContain('disposition');
  });

  it('flags a conflicting axis where one declared value is cited and the other is not', async () => {
    // One source cites `one-compartment`; a competing `two-compartment` declaration carries NO
    // citation (e.g. its source was deleted). The axis has SOME evidence — a citation-count check
    // alone would call it covered — but the uncited side is exactly what the human gate needs to see,
    // so the axis must still be flagged.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const oneCompCite = await seedAdmissibleCitation(db, { identifier: '55555555' });
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment', null, oneCompCite);
    await insertAxis(drugId, userId, 'dispositionModel', 'two-compartment'); // no citation
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    const review = await reviewDrug(drugId, 'testdrug', { en: 'Test Drug' });
    const [r] = review.routes;
    // The one citation that does exist is still surfaced...
    expect(r.sources).toContain(oneCompCite);
    // ...but the axis is flagged: not every declared value is backed.
    expect(r.uncitedAxes).toContain('disposition');
  });

  it('buckets a drug whose slug is claimed by the reviewed override tier as superseded-by-override', async () => {
    // `buildRegistrySnapshot` always keeps the override when a slug collides, so a fully-asserted,
    // rendering derivation for a registered analyte never ships — it must not land in a
    // curve-rendering review bucket alongside derivations that DO ship.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9, unit: 'fraction' });

    // 'amphetamine' is a real reviewed-registry analyte (see src/lib/kinetics-core/registry.ts).
    const review = await reviewDrug(drugId, 'amphetamine', { en: 'Amphetamine' });
    expect(review.bucket).toBe('superseded-by-override');
  });
});
