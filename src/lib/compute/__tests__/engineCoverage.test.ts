import { describe, it, expect } from 'vitest';
import { embeddedComponents } from '../../../../data/components';
import { computeEngineCoverage, coverageSlug } from '../engineCoverage';
import {
  hasFirstOrderEngineData,
  hasIvEngineData,
  hasEngineData,
} from '../drugPriors';

describe('computeEngineCoverage', () => {
  const cov = computeEngineCoverage(embeddedComponents);

  it('classifies every component into exactly one tier', () => {
    expect(cov.total).toBe(embeddedComponents.length);
    expect(
      cov.firstOrder.length +
        cov.ivOnly.length +
        cov.zeroOrder.length +
        cov.fallbackOnly.length,
    ).toBe(cov.total);
  });

  it('reflects the real engine reach — far more than the curated 4', () => {
    // The historical "supported" list had 4 entries. The engine actually runs
    // on every component with the priors it consumes. Guard that the honest
    // count stays an order of magnitude larger; a drop here means a catalog
    // edit stripped PK params from many rows and deserves review.
    expect(cov.firstOrder.length).toBeGreaterThanOrEqual(50);
    expect(cov.engineReady).toBeGreaterThanOrEqual(70);
    expect(cov.engineReady).toBe(
      cov.firstOrder.length + cov.ivOnly.length + cov.zeroOrder.length,
    );
  });

  it('pins the current coverage snapshot (update deliberately on catalog edits)', () => {
    // These exact numbers document today's catalog. Changing them should be a
    // conscious act tied to a data edit, not a silent drift.
    //
    // They last moved when 16 auto-extracted `volumeOfDistribution` values in
    // absolute litres were removed from the fixture (migration 0117): the
    // parameter is declared `L/kg`, and `hasFirstOrderEngineData` asks only
    // whether a Vd is PRESENT, so all 16 counted as data-complete on a number
    // no reviewer had seen. Graded against the curated `L/kg` values the live
    // catalog has since aggregated from cited entries, only 5 of the 15 with
    // one land inside it; the rest miss by 1.4–10× and duloxetine's is
    // negative.
    //
    // So the drop here is a correction of this file's claim, not a loss of
    // catalog data — for 15 of the 16 the database already holds a better
    // value, and only the offline fixture was stale. Those drugs are now
    // `fallback-only`: the synthesized Vd is tagged `fallback` in the prior
    // summary, which is a weaker claim honestly labelled rather than an
    // unreviewed one presented as the catalog's, and the pair goes back into
    // the curation gap queue. firstOrder 72→57, ivOnly 17→16,
    // fallbackOnly 81→97, engineReady 90→74.
    expect(cov.firstOrder.length).toBe(57);
    expect(cov.ivOnly.length).toBe(16);
    expect(cov.zeroOrder.length).toBe(1);
    expect(cov.fallbackOnly.length).toBe(97);
    expect(cov.engineReady).toBe(74);
  });

  it('routes ethanol to the zero-order (Widmark) branch', () => {
    expect(cov.zeroOrder.map((e) => e.slug)).toEqual(['ethanol']);
  });

  it('places well-known data-complete analytes in the first-order tier', () => {
    const firstOrderSlugs = new Set(cov.firstOrder.map((e) => e.slug));
    for (const slug of [
      'diazepam',
      'morphine',
      'ketamine',
      'amphetamine',
      'oxycodone',
      'alprazolam',
    ]) {
      expect(firstOrderSlugs).toContain(slug);
    }
  });

  it('excludes the analytes whose only Vd was an absolute-litre extraction', () => {
    // The other half of the snapshot above, named rather than counted: these
    // are data-INcomplete in the fixture now, and saying so is the point.
    // Olanzapine sat in the list above until migration 0117 removed its
    // `{ median: 1000, unit: 'L' }` row — a value the parameter's declared
    // `L/kg` does not admit, from an extraction pass whose figures miss the
    // curated range two times in three. Each returns to the first-order tier
    // when the fixture is re-exported from a database that has the curated
    // L/kg value (the live one already does for all three), which is the
    // outcome this test should start failing for.
    const firstOrderSlugs = new Set(cov.firstOrder.map((e) => e.slug));
    for (const slug of ['olanzapine', 'clozapine', 'mirtazapine']) {
      expect(firstOrderSlugs).not.toContain(slug);
    }
  });
});

describe('coverageSlug', () => {
  it('slugifies from the English name, matching the seeder', () => {
    expect(coverageSlug({ name: 'Etanol', nameEn: 'Ethanol' })).toBe('ethanol');
    expect(coverageSlug({ name: 'Amfetamin', nameEn: 'Amphetamine' })).toBe(
      'amphetamine',
    );
  });

  it('falls back to the Norwegian name when no English name is present', () => {
    expect(coverageSlug({ name: 'Teststoff' })).toBe('teststoff');
  });
});

describe('engine-readiness predicates', () => {
  const complete = {
    halfLife: { min: 2, max: 4 },
    volumeOfDistribution: { median: 1.2 },
    bioavailability: { median: 0.8 },
  };

  it('hasFirstOrderEngineData requires half-life, Vd and F', () => {
    expect(hasFirstOrderEngineData(complete)).toBe(true);
    expect(
      hasFirstOrderEngineData({ ...complete, bioavailability: null }),
    ).toBe(false);
    expect(hasFirstOrderEngineData({ ...complete, halfLife: null })).toBe(
      false,
    );
  });

  it('hasIvEngineData needs only half-life and Vd', () => {
    expect(hasIvEngineData({ ...complete, bioavailability: null })).toBe(true);
    expect(
      hasIvEngineData({ halfLife: null, volumeOfDistribution: { median: 1 } }),
    ).toBe(false);
  });

  it('accepts plain numbers as well as range objects', () => {
    expect(
      hasFirstOrderEngineData({
        halfLife: 3,
        volumeOfDistribution: 1.1,
        bioavailability: 0.9,
      }),
    ).toBe(true);
    expect(hasFirstOrderEngineData({ halfLife: NaN })).toBe(false);
  });

  it('hasEngineData treats zero-order as always ready and honours the IV flag', () => {
    const noF = { ...complete, bioavailability: null };
    expect(hasEngineData(noF, { modelType: 'zero_order' })).toBe(true);
    expect(hasEngineData(noF, { isIv: true })).toBe(true);
    expect(hasEngineData(noF, { isIv: false })).toBe(false);
  });
});
