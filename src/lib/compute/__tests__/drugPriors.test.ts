import { describe, it, expect } from 'vitest';
import {
  buildPriorsFromDrug,
  isSupportedAnalyteSlug,
  KINELAB_SUPPORTED_ANALYTE_SLUGS,
  priorsToModelType,
  summarizePriors,
} from '../drugPriors';
import { inferenceInputSchema } from '../types';
import type { DrugRow } from '@/lib/drugApi';

const STUB_TIMESTAMPS = {
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
};

function makeDrug(overrides: Partial<DrugRow> = {}): DrugRow {
  return {
    id: 1,
    slug: 'ketamine',
    names: { nb: 'Ketamin', en: 'Ketamine' },
    nameShort: null,
    aliases: null,
    pubchemCid: null,
    molecularWeight: 237.7,
    halfLife: null,
    volumeOfDistribution: null,
    bioavailability: null,
    proteinBinding: null,
    bloodPlasmaRatio: null,
    tmax: null,
    pKa: null,
    popularityScore: 0,
    searchKey: null,
    ...STUB_TIMESTAMPS,
    ...overrides,
  };
}

describe('priorsToModelType', () => {
  it('returns zero_order when priors carry eliminationRate', () => {
    // Mirrors the engine-side `deriveModelType` so the page picks
    // the same branch the worker will use at runtime.
    expect(
      priorsToModelType({
        dose: { type: 'fixed', value: 70_000 },
        vd: { type: 'fixed', value: 50 },
        eliminationRate: { type: 'uniform', min: 100, max: 200 },
      }),
    ).toBe('zero_order');
  });

  it('returns first_order when priors carry halfLife but no eliminationRate', () => {
    expect(
      priorsToModelType({
        dose: { type: 'uniform', min: 20, max: 500 },
        halfLife: { type: 'fixed', value: 2.5 },
        vd: { type: 'fixed', value: 210 },
        f: { type: 'fixed', value: 0.2 },
      }),
    ).toBe('first_order');
  });

  it('protects loaded ethanol cases whose saved priors are first-order-shaped', () => {
    // Defensive: a hand-edited JSONB row or test fixture where
    // analyte === 'ethanol' but priors are first-order would, before
    // the helper, emit a payload with `eliminationRate: undefined`
    // that the schema rejects. The helper makes the page render the
    // first-order form so rerun stays valid.
    expect(
      priorsToModelType({
        dose: { type: 'uniform', min: 100, max: 1000 },
        halfLife: { type: 'fixed', value: 0.25 },
        vd: { type: 'fixed', value: 50 },
      }),
    ).toBe('first_order');
  });
});

describe('isSupportedAnalyteSlug', () => {
  it('accepts the engine-supported analytes', () => {
    // First-order: ketamine, diazepam, amphetamine. Zero-order: ethanol
    // (Widmark; phase 2f-2). Each one has a matching engine dispatch
    // path in `inference.ts`.
    expect(isSupportedAnalyteSlug('ketamine')).toBe(true);
    expect(isSupportedAnalyteSlug('diazepam')).toBe(true);
    expect(isSupportedAnalyteSlug('amphetamine')).toBe(true);
    expect(isSupportedAnalyteSlug('ethanol')).toBe(true);
  });

  it('uses the English-derived seeded slug, not the Norwegian name', () => {
    // The seeder slugifies `nameEn || name`, and the API resolves slugs by
    // exact match — the production API returns "Drug not found" for the
    // Norwegian slugs, so the curated set must use the English forms.
    expect(isSupportedAnalyteSlug('ketamin')).toBe(false);
    expect(isSupportedAnalyteSlug('amfetamin')).toBe(false);
  });

  it('rejects analytes whose model card requires unsupported engine equations', () => {
    // morphine/parent-metabolite and GHB/saturable each need new code
    // paths inside `inference.ts` and shouldn't be selectable until then.
    expect(isSupportedAnalyteSlug('morfin')).toBe(false);
    expect(isSupportedAnalyteSlug('ghb')).toBe(false);
    expect(isSupportedAnalyteSlug('not-a-real-slug')).toBe(false);
  });

  it('uses the slug that `seed-drugs.ts` writes for ethanol (regression: round 5)', () => {
    // The seeder slugifies `nameEn || name`; the seeded ethanol row has
    // `nameEn: 'Ethanol'` so its slug is `ethanol`. Using `etanol` here
    // would 404 every drug-priors fetch on a freshly seeded database
    // and leave KineLab unable to run the ethanol picker selection.
    expect(KINELAB_SUPPORTED_ANALYTE_SLUGS).toContain('ethanol');
    expect(KINELAB_SUPPORTED_ANALYTE_SLUGS as readonly string[]).not.toContain('etanol');
  });

  it('keeps the supported set small and explicit', () => {
    // Documenting the current contract via the test so any additions to the
    // set need a matching test update.
    expect(KINELAB_SUPPORTED_ANALYTE_SLUGS).toEqual([
      'ketamine',
      'diazepam',
      'amphetamine',
      'ethanol',
    ]);
  });
});

describe('buildPriorsFromDrug', () => {
  it('maps min+max half-life to a uniform prior', () => {
    const drug = makeDrug({
      halfLife: { min: 2, max: 3, unit: 'h' },
      volumeOfDistribution: { median: 200, unit: 'L' },
      bioavailability: { median: 0.2, unit: 'fraction' },
    });
    const out = buildPriorsFromDrug(drug, false);
    expect(out.priors.halfLife).toEqual({ type: 'uniform', min: 2, max: 3 });
    expect(out.priors.vd).toEqual({ type: 'fixed', value: 200 });
    expect(out.priors.f).toEqual({ type: 'fixed', value: 0.2 });
    expect(out.summary.halfLife.source).toBe('drug-db');
    expect(out.summary.vd.source).toBe('drug-db');
    expect(out.summary.f.source).toBe('drug-db');
    expect(out.summary.halfLife.display).toContain('h');
  });

  it('maps min+max+value to a triangular prior', () => {
    const drug = makeDrug({
      halfLife: { min: 1, max: 4, median: 2.5, unit: 'h' },
      volumeOfDistribution: { median: 100, unit: 'L' },
      bioavailability: { median: 0.5 },
    });
    const out = buildPriorsFromDrug(drug, false);
    expect(out.priors.halfLife).toEqual({
      type: 'triangular',
      min: 1,
      mode: 2.5,
      max: 4,
    });
  });

  it('uses fallbacks when a field is missing AND tags the source', () => {
    const drug = makeDrug({}); // all PK fields null
    const out = buildPriorsFromDrug(drug, false);
    expect(out.priors.halfLife).toEqual({ type: 'fixed', value: 4 });
    expect(out.priors.vd).toEqual({ type: 'fixed', value: 100 });
    expect(out.priors.f).toEqual({ type: 'fixed', value: 0.5 });
    expect(out.summary.halfLife.source).toBe('fallback');
    expect(out.summary.vd.source).toBe('fallback');
    expect(out.summary.f.source).toBe('fallback');
  });

  it('IV route forces F to fixed-1 and tags it drug-db (not fallback)', () => {
    // For IV, the engine's simulate path forces f=1 anyway. The summary
    // should not paint a misleading "fallback" tag just because the drug
    // row had no bioavailability — bioavailability is irrelevant for IV.
    const drug = makeDrug({
      halfLife: { median: 2 },
      volumeOfDistribution: { median: 100 },
      bioavailability: null,
    });
    const out = buildPriorsFromDrug(drug, true);
    expect(out.priors.f).toEqual({ type: 'fixed', value: 1 });
    expect(out.summary.f.source).toBe('drug-db');
  });

  it('returns priors that round-trip through inferenceInputSchema', () => {
    // Integration-y check: the priors must be a valid `InferencePriors`
    // value the engine accepts. If `rangeToDistribution` ever shape-shifts,
    // this catches it before the page tries to call infer().
    const drug = makeDrug({
      halfLife: { min: 2, max: 3 },
      volumeOfDistribution: { min: 100, max: 200 },
      bioavailability: { median: 0.2 },
    });
    const { priors } = buildPriorsFromDrug(drug, false);
    const minimalInput = inferenceInputSchema.parse({
      modelId: 'ketamine-one-comp-v0',
      analyte: 'ketamine',
      route: 'oral',
      observations: [
        {
          id: 'o1',
          analyte: 'ketamine',
          concentration: { value: 0.2, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: '2030-01-01T03:00:00.000Z',
        },
      ],
      priors: {
        ...priors,
        // Dose comes from the page form, not the drug row.
        dose: { type: 'uniform', min: 20, max: 500 },
      },
      defaultAssayCV: 0.15,
      drawCount: 100,
      gridResolution: 40,
      seed: 1,
    });
    expect(minimalInput.priors.halfLife).toEqual({
      type: 'uniform',
      min: 2,
      max: 3,
    });
  });
});

describe('summarizePriors', () => {
  it('renders display strings from already-built priors', () => {
    const summary = summarizePriors(
      {
        dose: { type: 'fixed', value: 0 }, // ignored by summarizePriors
        halfLife: { type: 'uniform', min: 2, max: 3 },
        vd: { type: 'fixed', value: 200 },
        f: { type: 'fixed', value: 0.2 },
      },
      false,
    );
    expect(summary.halfLife.display).toContain('h');
    expect(summary.vd.display).toContain('L');
    // No unit suffix on F (dimensionless 0–1).
    expect(summary.f.display).toBe('0.200');
    expect(summary.halfLife.source).toBe('drug-db');
  });

  it('forces F to "1" for IV regardless of stored value', () => {
    const summary = summarizePriors(
      {
        dose: { type: 'fixed', value: 0 },
        halfLife: { type: 'fixed', value: 2 },
        vd: { type: 'fixed', value: 100 },
        f: { type: 'fixed', value: 0.5 },
      },
      true,
    );
    expect(summary.f.display).toBe('1.00');
  });
});

describe('buildPriorsFromDrug (ethanol zero-order)', () => {
  it('emits an eliminationRate prior with literature defaults', () => {
    // Ethanol's drugs row in production today has no
    // `eliminationRate` column; the helper must still produce a usable
    // prior. Literature default is uniform(100, 200) mg/L/h
    // (= 0.10–0.20 g/L/h, the canonical Widmark range).
    const drug = makeDrug({
      slug: 'ethanol',
      volumeOfDistribution: { median: 50, unit: 'L' },
    });
    const out = buildPriorsFromDrug(drug, false, 'zero_order');
    expect(out.priors.eliminationRate).toEqual({
      type: 'uniform',
      min: 100,
      max: 200,
    });
    // halfLife/F are intentionally omitted from the priors object — the
    // engine's zero-order dispatch reads `eliminationRate` and never
    // looks at them.
    expect(out.priors.halfLife).toBeUndefined();
    expect(out.priors.f).toBeUndefined();
  });

  it('uses the drug rows Vd when present, else a Widmark adult range', () => {
    const withVd = buildPriorsFromDrug(
      makeDrug({ volumeOfDistribution: { median: 42, unit: 'L' } }),
      false,
      'zero_order',
    );
    expect(withVd.priors.vd).toEqual({ type: 'fixed', value: 42 });
    expect(withVd.summary.vd.source).toBe('drug-db');

    const fallbackVd = buildPriorsFromDrug(
      makeDrug({ volumeOfDistribution: null }),
      false,
      'zero_order',
    );
    expect(fallbackVd.priors.vd).toEqual({
      type: 'uniform',
      min: 35,
      max: 70,
    });
    expect(fallbackVd.summary.vd.source).toBe('fallback');
  });

  it('falls back to the adult Widmark range when the drug row stores Vd in L/kg and the subject panel is empty', () => {
    // The seeded ethanol row in `data/components.ts` carries
    // `{min: 0.53, max: 0.6, unit: 'L/kg'}`; passing that straight
    // through would make the engine divide by ~0.6 L instead of an
    // adult ~50 L. Without subject info to scale by weight, the
    // engine falls back to the Widmark adult uniform range.
    const drug = makeDrug({
      slug: 'ethanol',
      volumeOfDistribution: { min: 0.53, max: 0.6, unit: 'L/kg' },
    });
    const out = buildPriorsFromDrug(drug, false, 'zero_order');
    expect(out.priors.vd).toEqual({ type: 'uniform', min: 35, max: 70 });
    expect(out.summary.vd.source).toBe('fallback');
  });

  it('computes Widmark r·weight Vd when subject panel supplies weight + sex (zero-order)', () => {
    // Phase 2g: with both weight and sex, Vd = r * weight as a fixed
    // point estimate. Male r ≈ 0.68, female r ≈ 0.55; sex-unknown
    // collapses to a uniform spanning both. Source tag is `drug-db`
    // because the computed value is more authoritative than the
    // literature fallback range, even though it's not literally read
    // from the drug row.
    const drug = makeDrug({ slug: 'ethanol' });
    const male = buildPriorsFromDrug(drug, false, 'zero_order', {
      weightKg: 80,
      sex: 'male',
    });
    expect(male.priors.vd).toEqual({ type: 'fixed', value: 0.68 * 80 });
    expect(male.summary.vd.source).toBe('drug-db');

    const female = buildPriorsFromDrug(drug, false, 'zero_order', {
      weightKg: 60,
      sex: 'female',
    });
    expect(female.priors.vd).toEqual({ type: 'fixed', value: 0.55 * 60 });

    const unknown = buildPriorsFromDrug(drug, false, 'zero_order', {
      weightKg: 70,
      sex: 'unknown',
    });
    expect(unknown.priors.vd).toEqual({
      type: 'uniform',
      min: 0.55 * 70,
      max: 0.68 * 70,
    });
  });

  it('uses Widmark r·weight even when the drug row carries L/kg Vd (zero-order)', () => {
    // The Widmark r·weight calculation is more authoritative than the
    // L/kg drug row for forensic ethanol inverse inference, so it
    // wins when both are available.
    const drug = makeDrug({
      slug: 'ethanol',
      volumeOfDistribution: { min: 0.53, max: 0.6, unit: 'L/kg' },
    });
    const out = buildPriorsFromDrug(drug, false, 'zero_order', {
      weightKg: 75,
      sex: 'male',
    });
    expect(out.priors.vd).toEqual({ type: 'fixed', value: 0.68 * 75 });
    expect(out.summary.vd.source).toBe('drug-db');
  });

  it('weight-without-sex still uses Widmark with the unknown-r uniform (zero-order)', () => {
    // Operators may know the weight but have no recorded sex; the
    // engine treats that as sex='unknown' rather than dropping back
    // to the population fallback range.
    const drug = makeDrug({ slug: 'ethanol' });
    const out = buildPriorsFromDrug(drug, false, 'zero_order', {
      weightKg: 70,
    });
    expect(out.priors.vd).toEqual({
      type: 'uniform',
      min: 0.55 * 70,
      max: 0.68 * 70,
    });
    expect(out.summary.vd.source).toBe('drug-db');
  });

  it('scales L/kg drug-row Vd to litres by subject weight (first-order)', () => {
    // The seeded first-order analytes (ketamine, diazepam, amphetamine)
    // all store Vd in L/kg. Without subject weight the engine
    // historically treated those numbers as litres directly — off by
    // a body-weight factor. With weight provided, the row is scaled
    // properly and tagged drug-db.
    const drug = makeDrug({
      volumeOfDistribution: { min: 2.3, max: 5, unit: 'L/kg' },
    });
    const out = buildPriorsFromDrug(drug, false, 'first_order', {
      weightKg: 70,
    });
    expect(out.priors.vd).toEqual({
      type: 'uniform',
      min: 2.3 * 70,
      max: 5 * 70,
    });
    expect(out.summary.vd.source).toBe('drug-db');
  });

  it('scales first-order L/kg Vd by a default weight (not raw litres) when subject weight is missing', () => {
    // Without a subject weight the engine used to treat the per-kilogram
    // numbers as litres directly — off by ~a body weight (e.g. morphine
    // 4 L/kg read as 4 L instead of ~280 L). It now scales by an explicit
    // typical-adult default weight (70 kg) so the Vd order of magnitude is
    // right, still tagged `fallback` because a weight was assumed.
    const drug = makeDrug({
      volumeOfDistribution: { min: 2.3, max: 5, unit: 'L/kg' },
    });
    const out = buildPriorsFromDrug(drug, false, 'first_order');
    expect(out.priors.vd).toEqual({
      type: 'uniform',
      min: 2.3 * 70,
      max: 5 * 70,
    });
    expect(out.summary.vd.source).toBe('fallback');
  });

  it('exposes eliminationRate in the priors panel summary', () => {
    // The phase 2f-1 helper extends `PriorSummary` with an optional
    // `eliminationRate` row so the future phase 2f-2 panel can render
    // it without another shape change.
    const drug = makeDrug({ slug: 'ethanol' });
    const out = buildPriorsFromDrug(drug, false, 'zero_order');
    expect(out.summary.eliminationRate).toBeDefined();
    expect(out.summary.eliminationRate?.display).toContain('mg/L/h');
  });

  it('round-trips through inferenceInputSchema', () => {
    // The full ethanol prior shape must satisfy `inferencePriorsSchema`
    // so the engine accepts it without parse errors.
    const drug = makeDrug({ slug: 'ethanol' });
    const { priors } = buildPriorsFromDrug(drug, false, 'zero_order');
    const minimalInput = inferenceInputSchema.parse({
      modelId: 'ethanol-zero-order-v0',
      analyte: 'ethanol',
      route: 'oral',
      observations: [
        {
          id: 'o1',
          analyte: 'ethanol',
          concentration: { value: 800, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: '2030-01-01T04:00:00.000Z',
        },
      ],
      priors: {
        ...priors,
        // Caller supplies the dose prior independently.
        dose: { type: 'uniform', min: 10_000, max: 200_000 },
      },
      defaultAssayCV: 0.05,
      drawCount: 100,
      gridResolution: 40,
      seed: 1,
    });
    expect(minimalInput.priors.eliminationRate).toEqual({
      type: 'uniform',
      min: 100,
      max: 200,
    });
  });

  it('preserves the fallback tag for Vd + eliminationRate when summarizing loaded zero-order priors', () => {
    // Saved priors carry no provenance metadata, so we cannot tell
    // on load whether the saved Vd came from a drug row in litres or
    // from the L/kg-fallback Widmark adult range. The hardcoded
    // 100–200 mg/L/h elimination prior is similarly always
    // synthesized today (no drug row carries it). The summarizer
    // mirrors `buildZeroOrderPriors` and tags both as `fallback` so
    // a reload doesn't silently drop the warning the fresh-run
    // panel showed for the same calculation inputs.
    const summary = summarizePriors(
      {
        dose: { type: 'uniform', min: 10_000, max: 200_000 },
        vd: { type: 'fixed', value: 50 },
        eliminationRate: { type: 'uniform', min: 100, max: 200 },
      },
      false,
    );
    expect(summary.eliminationRate?.source).toBe('fallback');
    expect(summary.vd.source).toBe('fallback');
    // Halflife and F rows stay drug-db-tagged (placeholder display).
    expect(summary.halfLife.source).toBe('drug-db');
    expect(summary.f.source).toBe('drug-db');
  });
});
