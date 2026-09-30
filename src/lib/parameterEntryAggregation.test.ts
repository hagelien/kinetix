import { describe, it, expect } from 'vitest';
import {
  aggregateEntries,
  entryWeight,
  entryRepresentative,
  bloodRatioScalar,
  formatSummaryValue,
  summaryToNumericRange,
  isAggregateCacheValue,
  REVIEW_SCORE_WEIGHT_FLOOR,
  type ParameterEntryValue,
  type AggregationContext,
} from './parameterEntryAggregation';

describe('formatSummaryValue', () => {
  it('keeps significant figures for small, potent-drug concentrations', () => {
    expect(formatSummaryValue(0.002)).toBe('0.002');
    expect(formatSummaryValue(0.00123)).toBe('0.0012');
    expect(formatSummaryValue(22.456)).toBe('22.46');
    expect(formatSummaryValue(0)).toBe('0');
    expect(formatSummaryValue(null)).toBe('—');
  });
});

const CTX: AggregationContext = {
  targetUnit: 'mg/L',
  bloodPlasmaRatio: 1,
  molecularWeight: 300,
  matrixRelevant: true,
};

function entry(over: Partial<ParameterEntryValue>): ParameterEntryValue {
  return {
    citationId: null,
    low: null,
    high: null,
    median: null,
    qualifier: null,
    unit: 'mg/L',
    matrix: 'whole_blood',
    n: null,
    reviewScore: null,
    ...over,
  };
}

describe('entryWeight', () => {
  it('un-reviewed entry weights at the floor × n', () => {
    expect(entryWeight(entry({ n: 10, reviewScore: null }))).toBeCloseTo(
      10 * REVIEW_SCORE_WEIGHT_FLOOR,
    );
  });
  it('a fully-reviewed entry weights double an un-reviewed one of equal n', () => {
    const reviewed = entryWeight(entry({ n: 4, reviewScore: 100 }));
    const unreviewed = entryWeight(entry({ n: 4, reviewScore: 0 }));
    expect(reviewed / unreviewed).toBeCloseTo(2);
  });
  it('missing n counts as 1', () => {
    expect(entryWeight(entry({ n: null, reviewScore: 0 }))).toBeCloseTo(
      REVIEW_SCORE_WEIGHT_FLOOR,
    );
  });
});

describe('entryRepresentative', () => {
  it('prefers median, then interval midpoint; a lone bound has no estimate', () => {
    expect(entryRepresentative(entry({ median: 5, low: 1, high: 9 }))).toBe(5);
    expect(entryRepresentative(entry({ low: 10, high: 20 }))).toBe(15);
    // A one-sided bound ("≥ 7" / "≤ 7") is not a point observation.
    expect(entryRepresentative(entry({ high: 7 }))).toBeNull();
    expect(entryRepresentative(entry({ low: 7 }))).toBeNull();
    expect(entryRepresentative(entry({}))).toBeNull();
  });
});

describe('bloodRatioScalar', () => {
  it('uses a positive scalar directly and defaults to 1', () => {
    expect(bloodRatioScalar(0.55)).toBe(0.55);
    expect(bloodRatioScalar(null)).toBe(1);
    expect(bloodRatioScalar(0)).toBe(1);
  });
  it('resolves a NumericRange via its representative then midpoint', () => {
    expect(bloodRatioScalar({ median: 0.7 })).toBe(0.7);
    expect(bloodRatioScalar({ min: 0.4, max: 0.6 })).toBeCloseTo(0.5);
  });
});

describe('aggregateEntries — pooling', () => {
  it('returns null for an empty set', () => {
    expect(aggregateEntries([], CTX)).toBeNull();
  });

  it('weighted median of whole-blood entries', () => {
    const s = aggregateEntries(
      [
        entry({ median: 10, n: 1 }),
        entry({ median: 20, n: 1 }),
        entry({ median: 30, n: 1 }),
      ],
      CTX,
    )!;
    expect(s.representative).toBe(20);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.pooledCount).toBe(3);
    expect(s.entryCount).toBe(3);
  });

  it('sample size shifts the weighted median toward the heavier entry', () => {
    const s = aggregateEntries(
      [
        entry({ median: 10, n: 1, reviewScore: 0 }),
        entry({ median: 100, n: 500, reviewScore: 0 }),
      ],
      CTX,
    )!;
    expect(s.representative).toBe(100);
  });

  it('normalizes serum to whole blood via the blood:plasma ratio', () => {
    const s = aggregateEntries([entry({ median: 100, matrix: 'serum' })], {
      ...CTX,
      bloodPlasmaRatio: 0.5,
    })!;
    // blood = ratio × serum = 0.5 × 100
    expect(s.representative).toBe(50);
  });

  it('collects contributing citation ids, de-duplicated and sorted', () => {
    const s = aggregateEntries(
      [
        entry({ median: 1, citationId: 7 }),
        entry({ median: 2, citationId: 3 }),
        entry({ median: 3, citationId: 7 }),
      ],
      CTX,
    )!;
    expect(s.contributingCitationIds).toEqual([3, 7]);
  });
});

describe('aggregateEntries — censored thresholds & attribution', () => {
  it('excludes a qualified "< X" entry from the pool but keeps it per-matrix', () => {
    const s = aggregateEntries(
      [
        entry({ median: 20, matrix: 'whole_blood' }),
        entry({ high: 120, qualifier: '<', matrix: 'whole_blood', citationId: 9 }),
      ],
      CTX,
    )!;
    // The "< 120" bound is not pooled as a point.
    expect(s.pooledCount).toBe(1);
    expect(s.representative).toBe(20);
    // But it still counts and appears in byMatrix.
    expect(s.entryCount).toBe(2);
    expect(s.contributingCitationIds).not.toContain(9);
  });

  it('attributes citations only to pooled (contributing) entries', () => {
    const s = aggregateEntries(
      [
        entry({ median: 20, matrix: 'whole_blood', citationId: 1 }),
        entry({ median: 5, matrix: 'urine', citationId: 2 }),
      ],
      CTX,
    )!;
    // The urine entry did not affect the whole-blood pool, so its citation is
    // not claimed by the aggregate revision.
    expect(s.contributingCitationIds).toEqual([1]);
  });

  it('never normalizes serum to zero on a degenerate blood:plasma ratio', () => {
    const s = aggregateEntries([entry({ median: 40, matrix: 'serum' })], {
      ...CTX,
      bloodPlasmaRatio: { min: 0, max: 0 } as never,
    })!;
    // ratio falls back to 1 rather than 0.
    expect(s.representative).toBe(40);
  });
});

describe('aggregateEntries — interval bounds & matrix frame', () => {
  it('preserves source interval bounds in min/max, not just midpoints', () => {
    const s = aggregateEntries([entry({ low: 10, high: 30 })], CTX)!;
    // rep is the midpoint for the weighted median…
    expect(s.representative).toBe(20);
    // …but the cached range keeps the documented interval.
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
  });

  it('normalizes blood-matrix rows to the pooled whole-blood frame', () => {
    const s = aggregateEntries([entry({ median: 100, matrix: 'serum' })], {
      ...CTX,
      bloodPlasmaRatio: 0.5,
    })!;
    const serum = s.byMatrix.find((m) => m.matrix === 'serum')!;
    // The per-matrix marker is blood-normalized (50), matching the pooled value,
    // so both sit in the same frame on the axis.
    expect(serum.representative).toBe(50);
    expect(s.representative).toBe(50);
  });

  it('labels the per-matrix count as a source count, and omits censored markers', () => {
    const s = aggregateEntries(
      [
        entry({ median: 20, matrix: 'whole_blood', n: 100 }),
        entry({ high: 120, qualifier: '<', matrix: 'whole_blood', n: 200 }),
      ],
      CTX,
    )!;
    const wb = s.byMatrix.find((m) => m.matrix === 'whole_blood')!;
    // Two source entries (papers), not a summed biological n.
    expect(wb.sourceCount).toBe(2);
    // The censored row contributes no point marker.
    expect(wb.representative).toBe(20);
  });

  it('does not pool a lone bound as an exact observation but keeps it for display', () => {
    const s = aggregateEntries(
      [
        entry({ median: 20, matrix: 'whole_blood' }),
        // A one-sided "≥ 10" must not enter the weighted median as an exact 10…
        entry({ low: 10, matrix: 'whole_blood' }),
      ],
      CTX,
    )!;
    expect(s.pooledCount).toBe(1);
    expect(s.representative).toBe(20);
    // …but the bound is still shown per-source and per-matrix.
    expect(s.points.some((p) => p.low === 10 && p.representative == null)).toBe(
      true,
    );
    const wb = s.byMatrix.find((m) => m.matrix === 'whole_blood')!;
    expect(wb.min).toBe(10);
  });
});

describe('aggregateEntries — grandfathered rows', () => {
  it('excludes a synthetic grandfathered row once a real source exists', () => {
    const s = aggregateEntries(
      [
        entry({ median: 10, origin: 'grandfathered' }),
        entry({ median: 30, origin: 'contributor' }),
      ],
      CTX,
    )!;
    // Only the real source is pooled/counted; the placeholder is dropped.
    expect(s.pooledCount).toBe(1);
    expect(s.entryCount).toBe(1);
    expect(s.representative).toBe(30);
  });

  it('keeps the grandfathered row when it is the only evidence', () => {
    const s = aggregateEntries(
      [entry({ median: 10, origin: 'grandfathered' })],
      CTX,
    )!;
    expect(s.pooledCount).toBe(1);
    expect(s.representative).toBe(10);
  });

  it('flags whether values are normalized to whole blood', () => {
    expect(
      aggregateEntries([entry({ median: 10 })], CTX)!.normalizedToWholeBlood,
    ).toBe(true);
    expect(
      aggregateEntries([entry({ median: 10 })], {
        ...CTX,
        matrixRelevant: false,
      })!.normalizedToWholeBlood,
    ).toBe(false);
  });
});

describe('aggregateEntries — matrix handling', () => {
  it('excludes non-blood matrices from the pool but keeps them in byMatrix', () => {
    const s = aggregateEntries(
      [
        entry({ median: 20, matrix: 'whole_blood' }),
        entry({ median: 999, matrix: 'urine' }),
      ],
      CTX,
    )!;
    expect(s.representative).toBe(20);
    expect(s.pooledCount).toBe(1);
    expect(s.entryCount).toBe(2);
    const urine = s.byMatrix.find((m) => m.matrix === 'urine');
    expect(urine?.representative).toBe(999);
  });

  it('drops a molar entry with no molecular weight from the pool', () => {
    const s = aggregateEntries(
      [
        entry({ median: 5, unit: 'mg/L' }),
        entry({ median: 10, unit: 'µmol/L' }),
      ],
      { ...CTX, molecularWeight: null },
    )!;
    // The molar entry can't convert without MW → excluded from the pool.
    expect(s.pooledCount).toBe(1);
    expect(s.representative).toBe(5);
    expect(s.entryCount).toBe(2);
  });
});

describe('aggregateEntries — matrixRelevant=false', () => {
  it('pools every entry regardless of matrix with no blood scaling', () => {
    const s = aggregateEntries(
      [
        entry({ median: 4, matrix: 'serum' }),
        entry({ median: 8, matrix: 'urine' }),
      ],
      { ...CTX, matrixRelevant: false, bloodPlasmaRatio: 0.5 },
    )!;
    // No matrix scaling applied; both pooled.
    expect(s.pooledCount).toBe(2);
    // Weighted median of {4,8} at equal weight resolves to the lower point
    // (the 50% mass boundary lands exactly on it).
    expect(s.representative).toBe(4);
  });

  it('pools matrix-free entries for a non-concentration parameter', () => {
    // Half-life, logP, B/P … store no matrix at all: every source is pooled and
    // byMatrix is empty rather than bucketed under a fabricated matrix.
    const s = aggregateEntries(
      [
        entry({ median: 4, matrix: null, unit: 'h' }),
        entry({ low: 6, high: 10, matrix: null, unit: 'h' }),
      ],
      { targetUnit: 'h', matrixRelevant: false },
    )!;
    expect(s.pooledCount).toBe(2);
    expect(s.byMatrix).toEqual([]);
    expect(s.points).toHaveLength(2);
    expect(s.min).toBe(4);
    expect(s.max).toBe(10);
  });

  it('converts clearance units within their family and drops cross-family ones', () => {
    const s = aggregateEntries(
      [
        entry({ median: 6, matrix: null, unit: 'L/h' }),
        entry({ median: 100, matrix: null, unit: 'mL/min' }),
        // Weight-normalized clearance is a different quantity — no body weight
        // is available to convert it, so it must not be pooled as if it were.
        entry({ median: 0.1, matrix: null, unit: 'L/h/kg' }),
      ],
      { targetUnit: 'L/h', matrixRelevant: false },
    )!;
    expect(s.pooledCount).toBe(2);
    expect(s.representative).toBeCloseTo(6, 10);
    expect(s.entryCount).toBe(3);
  });

  it('keeps a negative dimensionless value (logP) in the pool', () => {
    const s = aggregateEntries(
      [
        entry({ median: -1.2, matrix: null, unit: '' }),
        entry({ median: 0.8, matrix: null, unit: '' }),
      ],
      { targetUnit: '', matrixRelevant: false },
    )!;
    expect(s.pooledCount).toBe(2);
    expect(s.min).toBe(-1.2);
    expect(s.representative).toBe(-1.2);
  });
});

describe('summaryToNumericRange', () => {
  it('maps to full min/max + weighted median with a provenance note', () => {
    const s = aggregateEntries(
      [entry({ low: 10, high: 30, median: 20 })],
      CTX,
    )!;
    const nr = summaryToNumericRange(s)!;
    expect(nr.median).toBe(20);
    expect(nr.unit).toBe('mg/L');
    expect(nr.note).toContain('1 source entry');
    // The structured marker (not the note prose) identifies a derived cache.
    expect(nr.derivedFromEntries).toBe(true);
    expect(isAggregateCacheValue(nr)).toBe(true);
    // A hand-authored value whose note merely starts with the same prose is NOT
    // treated as a cache, so a recompute can never clear it (grandfather rule).
    expect(
      isAggregateCacheValue({ median: 5, note: 'Aggregated from Baselt' }),
    ).toBe(false);
  });

  it('returns null when nothing was pooled', () => {
    const s = aggregateEntries([entry({ median: 5, matrix: 'urine' })], CTX)!;
    expect(s.pooledCount).toBe(0);
    expect(summaryToNumericRange(s)).toBeNull();
  });
});

describe('aggregateEntries — source identity', () => {
  it('carries each entry id onto its summary point', () => {
    // The plot and the source list are ordered differently and one citation can
    // back several entries, so the entry id is what lets a hovered marker and
    // its row find each other.
    const s = aggregateEntries(
      [
        entry({ entryId: 91, median: 4, matrix: null, unit: 'h' }),
        entry({ entryId: 92, median: 8, matrix: null, unit: 'h' }),
      ],
      { targetUnit: 'h', matrixRelevant: false },
    )!;
    expect(s.points.map((p) => p.entryId)).toEqual([91, 92]);
  });

  it('leaves the id null when the caller supplied none', () => {
    const s = aggregateEntries([entry({ median: 4, matrix: null, unit: 'h' })], {
      targetUnit: 'h',
      matrixRelevant: false,
    })!;
    expect(s.points[0]!.entryId).toBeNull();
  });
});

/**
 * A labelled source value (migration 0135) keeps its centre in `centralValue`
 * and names its bounds with `intervalKind`. The pool reads that centre, and an
 * arithmetic interval's bound that crosses zero is not a value any subject had.
 */
describe('aggregateEntries — the reported statistic', () => {
  const H: AggregationContext = { targetUnit: 'h', matrixRelevant: false };

  it('pools a labelled centre, not the bound midpoint', () => {
    const e = entry({
      unit: 'h',
      matrix: null,
      low: 0.3,
      high: 0.9,
      centralValue: 0.4,
      intervalKind: 'range',
    });
    expect(entryRepresentative(e)).toBe(0.4);
    const s = aggregateEntries([e], H)!;
    expect(s.representative).toBe(0.4);
    expect(s.min).toBe(0.3);
    expect(s.max).toBe(0.9);
  });

  it('keeps an SD bound outside the parameter range out of the pooled envelope, not the forest plot', () => {
    const e = entry({
      unit: 'h',
      matrix: null,
      low: -0.1,
      high: 0.7,
      centralValue: 0.3,
      intervalKind: 'sd',
    });
    const s = aggregateEntries([e], { ...H, valueBounds: { min: 0.01, max: 1000 } })!;
    expect(s.min).toBe(0.3);
    expect(s.max).toBe(0.7);
    expect(s.points[0]!.low).toBe(-0.1);
  });

  // Codex on #1452: a signed parameter's CI may legitimately cross zero; the
  // filter is the parameter's declared range, not the sign of the centre.
  it('keeps a signed parameter\'s CI across zero when it is within the declared range', () => {
    const e = entry({
      unit: '',
      matrix: null,
      low: -0.4,
      high: 0.2,
      centralValue: -0.1,
      intervalKind: 'ci95',
    });
    const s = aggregateEntries([e], {
      targetUnit: '',
      matrixRelevant: false,
      valueBounds: { min: -5, max: 10 },
    })!;
    expect(s.min).toBe(-0.4);
    expect(s.max).toBe(0.2);
  });

  it('keeps an observed range bound below zero, which a subject did have', () => {
    const e = entry({
      unit: '',
      matrix: null,
      low: -0.5,
      high: 1.5,
      centralValue: 0.8,
      intervalKind: 'range',
    });
    const s = aggregateEntries([e], { targetUnit: '', matrixRelevant: false })!;
    expect(s.min).toBe(-0.5);
  });
});
