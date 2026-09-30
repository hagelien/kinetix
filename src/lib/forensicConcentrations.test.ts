import { describe, it, expect } from 'vitest';
import {
  buildForensicCategories,
  evidenceAlpha,
  hasUnconvertibleForensicRows,
  normalizeForensicLineSettings,
  withAlpha,
  DEFAULT_FORENSIC_LINE_SETTINGS,
  EVIDENCE_ALPHA_MAX,
  EVIDENCE_ALPHA_MIN,
  type ForensicEntryInput,
  type ForensicLineSettings,
} from './forensicConcentrations';

const CTX = { targetUnit: 'mg/L', displayMatrix: 'whole_blood' } as const;

function entry(over: Partial<ForensicEntryInput>): ForensicEntryInput {
  return {
    scenario: 'postmortem_mono_intox',
    low: null,
    high: null,
    median: null,
    qualifier: null,
    unit: 'mg/L',
    matrix: 'whole_blood',
    n: null,
    origin: 'contributor',
    citationId: null,
    citationLabel: null,
    ...over,
  };
}

describe('evidenceAlpha', () => {
  it('is monotonic in n and clamped to [MIN, MAX]', () => {
    const a1 = evidenceAlpha(1);
    const a10 = evidenceAlpha(10);
    const a100 = evidenceAlpha(100);
    const a1000 = evidenceAlpha(1000);
    expect(a1).toBeLessThan(a10);
    expect(a10).toBeLessThan(a100);
    expect(a1).toBeGreaterThanOrEqual(EVIDENCE_ALPHA_MIN);
    expect(a1000).toBeLessThanOrEqual(EVIDENCE_ALPHA_MAX);
    // n=100 is the reference point → full strength.
    expect(a100).toBeCloseTo(EVIDENCE_ALPHA_MAX, 5);
  });

  it('treats missing/zero n as a single observation, never below the floor', () => {
    expect(evidenceAlpha(0)).toBeCloseTo(evidenceAlpha(1), 10);
    expect(evidenceAlpha(-5)).toBeCloseTo(evidenceAlpha(1), 10);
    expect(evidenceAlpha(Number.NaN)).toBeCloseTo(evidenceAlpha(1), 10);
  });
});

describe('withAlpha', () => {
  it('turns a hex colour into rgba and passes non-hex through', () => {
    expect(withAlpha('#dc2626', 0.5)).toBe('rgba(220,38,38,0.5)');
    expect(withAlpha('#abc', 1)).toBe('rgba(170,187,204,1)');
    expect(withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple');
  });
});

describe('normalizeForensicLineSettings', () => {
  it('fills missing fields from the defaults', () => {
    const out = normalizeForensicLineSettings({ enabled: false });
    expect(out.enabled).toBe(false);
    expect(out.showIndividual).toBe(
      DEFAULT_FORENSIC_LINE_SETTINGS.showIndividual,
    );
    expect(out.categories.postmortem_mono_intox).toBe(true);
  });

  it('ignores unknown category keys and non-booleans', () => {
    const out = normalizeForensicLineSettings({
      categories: { bogus: true, postmortem_non_intox: false },
    });
    expect(out.categories.postmortem_non_intox).toBe(false);
    expect('bogus' in out.categories).toBe(false);
  });
});

describe('buildForensicCategories', () => {
  it('keeps the three categories distinct and pools within each', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 3, n: 10 }),
      entry({ scenario: 'postmortem_mono_intox', median: 5, n: 30 }),
      entry({ scenario: 'postmortem_poly_intox', median: 1, n: 4 }),
      entry({ scenario: 'postmortem_non_intox', low: 0.1, high: 0.3, n: 2 }),
    ];
    const results = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    expect(results.map((r) => r.category)).toEqual([
      'postmortem_non_intox',
      'postmortem_mono_intox',
      'postmortem_poly_intox',
    ]);
    const mono = results.find((r) => r.category === 'postmortem_mono_intox')!;
    expect(mono.totalN).toBe(40);
    expect(mono.refCount).toBe(2);
    // n-weighted median leans toward the higher-n observation (5, n=30).
    expect(mono.representative).toBe(5);
    expect(mono.band).toEqual({ low: 3, high: 5 });
  });

  it('drops non-blood matrices and non-forensic scenarios', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'urine', n: 5 }),
      entry({ scenario: 'living_therapeutic', median: 1, n: 5 }),
    ];
    const results = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    expect(results).toHaveLength(0);
  });

  it('converts serum to whole blood via the blood:plasma ratio', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'serum', n: 1 }),
    ];
    const results = buildForensicCategories(
      entries,
      { targetUnit: 'mg/L', displayMatrix: 'whole_blood', bloodPlasmaRatio: 0.5 },
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    // blood = ratio × plasma = 0.5 × 2 = 1
    expect(results[0]!.representative).toBeCloseTo(1, 6);
  });

  it('uses a two-sided B/P range midpoint but declines a one-sided one', () => {
    const serum = [
      entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'serum', n: 1 }),
    ];
    // Two-sided range → midpoint 0.5 used.
    const twoSided = buildForensicCategories(
      serum,
      { targetUnit: 'mg/L', displayMatrix: 'whole_blood', bloodPlasmaRatio: { min: 0.4, max: 0.6 } },
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    expect(twoSided[0]!.representative).toBeCloseTo(1, 6);
    // One-sided bound is not a representative factor → serum row declined.
    const oneSided = buildForensicCategories(
      serum,
      { targetUnit: 'mg/L', displayMatrix: 'whole_blood', bloodPlasmaRatio: { min: 0.4 } },
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    expect(oneSided).toHaveLength(0);
  });

  it('excludes censored (qualified) thresholds from the band and representative', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 5, n: 10 }),
      // "> 2000" — a threshold, not a measurement; must not widen the band or
      // move the representative.
      entry({ scenario: 'postmortem_mono_intox', low: 2000, qualifier: '>', n: 50 }),
    ];
    const results = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    const mono = results.find((r) => r.category === 'postmortem_mono_intox')!;
    expect(mono.representative).toBe(5);
    expect(mono.band).toEqual({ low: 5, high: 5 });
    expect(mono.totalN).toBe(10);
    expect(mono.points).toHaveLength(1);
  });

  it('treats a lone bound as range-only — no representative, no exact point', () => {
    const entries = [
      // Only a high bound, no median: contributes to the band range but is not
      // a central estimate, so it neither moves the representative nor draws an
      // individual line.
      entry({ scenario: 'postmortem_mono_intox', high: 40, n: 7 }),
    ];
    const mono = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    )[0]!;
    expect(mono.representative).toBeNull();
    expect(mono.points).toHaveLength(0);
    expect(mono.band).toEqual({ low: 40, high: 40 });
    // A range-only row still counts as a reference behind the band, even though
    // it never becomes a representative point.
    expect(mono.refCount).toBe(1);
    expect(mono.totalN).toBe(7);
  });

  it('counts uncited rows alongside distinct cited references', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 3, citationId: 10, n: 5 }),
      entry({ scenario: 'postmortem_mono_intox', median: 3, citationId: 10, n: 5 }),
      entry({ scenario: 'postmortem_mono_intox', median: 4, citationId: null, n: 5 }),
      entry({ scenario: 'postmortem_mono_intox', median: 5, citationId: null, n: 5 }),
    ];
    // One distinct citation (10, de-duplicated) + two uncited rows = 3.
    const mono = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    )[0]!;
    expect(mono.refCount).toBe(3);
  });

  it('drops a grandfathered placeholder once a real source exists', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 9, origin: 'grandfathered', n: 1 }),
      entry({ scenario: 'postmortem_mono_intox', median: 3, origin: 'contributor', n: 20 }),
    ];
    const mono = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    )[0]!;
    // Only the real source counts — the grandfathered n=1 and its value are gone.
    expect(mono.totalN).toBe(20);
    expect(mono.representative).toBe(3);
    expect(mono.band).toEqual({ low: 3, high: 3 });
  });

  it('drops a grandfathered row even when it is the only source', () => {
    // Unlike the summary aggregation, this measured-evidence overlay never
    // shows a synthetic placeholder — a drug with only an authored fatal range
    // and no real forensic entries must draw no autopsy band.
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 9, origin: 'grandfathered', n: 1 }),
    ];
    expect(
      buildForensicCategories(entries, CTX, DEFAULT_FORENSIC_LINE_SETTINGS),
    ).toHaveLength(0);
  });

  it('reports forensic rows that cannot be converted onto the axis', () => {
    const serumNoRatio = [
      entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'serum', n: 5 }),
    ];
    // Serum value, no blood:plasma ratio → cannot place on the blood axis.
    expect(hasUnconvertibleForensicRows(serumNoRatio, { targetUnit: 'mg/L', displayMatrix: 'whole_blood' })).toBe(
      true,
    );
    // Whole blood needs no ratio → convertible.
    expect(
      hasUnconvertibleForensicRows(
        [entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'whole_blood', n: 5 })],
        { targetUnit: 'mg/L', displayMatrix: 'whole_blood' },
      ),
    ).toBe(false);
    // A censored-only row is not "unconvertible" — it is deliberately not drawn.
    expect(
      hasUnconvertibleForensicRows(
        [entry({ scenario: 'postmortem_mono_intox', low: 2000, qualifier: '>', matrix: 'serum' })],
        { targetUnit: 'mg/L', displayMatrix: 'whole_blood' },
      ),
    ).toBe(false);
  });

  it('spans distinct one-sided bounds into a visible band with no representative', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', high: 10, n: 3 }),
      entry({ scenario: 'postmortem_mono_intox', high: 40, n: 3 }),
    ];
    const mono = buildForensicCategories(
      entries,
      CTX,
      DEFAULT_FORENSIC_LINE_SETTINGS,
    )[0]!;
    // A real span (10–40), not a collapsed point — and no invented central value.
    expect(mono.band).toEqual({ low: 10, high: 40 });
    expect(mono.representative).toBeNull();
    expect(mono.points).toHaveLength(0);
  });

  it('reports drawable rows on an unsupported chart axis (e.g. g/dL)', () => {
    const rows = [
      entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'whole_blood', n: 5 }),
    ];
    // The ethanol axis unit is not one the overlay can target: nothing is drawn,
    // but the presence of data is reported so it does not look absent.
    expect(hasUnconvertibleForensicRows(rows, { targetUnit: 'g/dL', displayMatrix: 'whole_blood' })).toBe(true);
    expect(buildForensicCategories(rows, { targetUnit: 'g/dL', displayMatrix: 'whole_blood' }, DEFAULT_FORENSIC_LINE_SETTINGS)).toHaveLength(0);
    // No drawable rows (wrong matrix) → nothing to report.
    expect(
      hasUnconvertibleForensicRows(
        [entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'urine' })],
        { targetUnit: 'g/dL', displayMatrix: 'whole_blood' },
      ),
    ).toBe(false);
  });

  it('declines a plasma/serum row when the blood:plasma ratio is missing', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'serum', n: 5 }),
    ];
    // No bloodPlasmaRatio on the context — the serum value cannot be placed on
    // the blood axis, so the row is dropped rather than drawn at plasma height.
    const results = buildForensicCategories(
      entries,
      { targetUnit: 'mg/L', displayMatrix: 'whole_blood' },
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    expect(results).toHaveLength(0);

    // A whole-blood row needs no ratio and is kept.
    const wb = buildForensicCategories(
      [entry({ scenario: 'postmortem_mono_intox', median: 2, matrix: 'whole_blood', n: 5 })],
      { targetUnit: 'mg/L', displayMatrix: 'whole_blood' },
      DEFAULT_FORENSIC_LINE_SETTINGS,
    );
    expect(wb[0]!.representative).toBeCloseTo(2, 6);
  });

  it('omits a category the settings turn off, and everything when disabled', () => {
    const entries = [
      entry({ scenario: 'postmortem_mono_intox', median: 3, n: 10 }),
      entry({ scenario: 'postmortem_poly_intox', median: 1, n: 4 }),
    ];
    const partial: ForensicLineSettings = {
      ...DEFAULT_FORENSIC_LINE_SETTINGS,
      categories: {
        postmortem_non_intox: true,
        postmortem_mono_intox: false,
        postmortem_poly_intox: true,
      },
    };
    const results = buildForensicCategories(entries, CTX, partial);
    expect(results.map((r) => r.category)).toEqual(['postmortem_poly_intox']);

    const off = buildForensicCategories(entries, CTX, {
      ...DEFAULT_FORENSIC_LINE_SETTINGS,
      enabled: false,
    });
    expect(off).toHaveLength(0);
  });
});
