import { describe, expect, it } from 'vitest';
import {
  affinityStrength,
  buildPdTargetComparison,
  collectPdTargets,
  formatPdValue,
  normalizePdUnit,
  pdHeadline,
  strengthDirection,
} from './pdComparison';
import type { DrugReceptorTargetSummary } from './receptorTargets';

const MOR = {
  id: 10,
  slug: 'oprm1',
  symbol: 'OPRM1',
  name: 'Mu opioid receptor',
  nameEn: 'Mu opioid receptor',
  targetClass: 'receptor',
  organism: 'Homo sapiens',
};
const KOR = { ...MOR, id: 11, slug: 'oprk1', symbol: 'OPRK1', name: 'Kappa' };

function mechanism(
  overrides: Partial<DrugReceptorTargetSummary>,
): DrugReceptorTargetSummary {
  return {
    id: 1,
    drugId: 1,
    receptorTargetId: MOR.id,
    interactionType: 'agonist',
    tier: 'primary',
    affinity: null,
    potency: null,
    efficacy: null,
    ki: null,
    ic50: null,
    ec50: null,
    emax: null,
    selectivityRatio: null,
    assaySpecies: null,
    referenceIds: [],
    evidenceNote: null,
    target: MOR,
    ...overrides,
  };
}

describe('normalizePdUnit', () => {
  it('converts every molar spelling to nM', () => {
    expect(normalizePdUnit('nM')).toEqual({ unit: 'nM', factor: 1 });
    expect(normalizePdUnit('nmol/L')).toEqual({ unit: 'nM', factor: 1 });
    expect(normalizePdUnit('µM')).toEqual({ unit: 'nM', factor: 1000 });
    expect(normalizePdUnit('μM')).toEqual({ unit: 'nM', factor: 1000 });
    expect(normalizePdUnit('uM')).toEqual({ unit: 'nM', factor: 1000 });
    expect(normalizePdUnit('pM')).toEqual({ unit: 'nM', factor: 0.001 });
  });

  it('keeps non-molar units as written', () => {
    expect(normalizePdUnit('%')).toEqual({ unit: '%', factor: 1 });
    expect(normalizePdUnit('fold')).toEqual({ unit: 'fold', factor: 1 });
    expect(normalizePdUnit(undefined)).toEqual({ unit: '', factor: 1 });
  });
});

describe('collectPdTargets', () => {
  it('lists shared targets first', () => {
    const targets = collectPdTargets([
      {
        id: 1,
        receptorTargets: [
          mechanism({ target: KOR }),
          mechanism({ target: MOR }),
        ],
      },
      { id: 2, receptorTargets: [mechanism({ drugId: 2, target: MOR })] },
    ]);
    expect(targets.map((t) => [t.symbol, t.drugCount])).toEqual([
      ['OPRM1', 2],
      ['OPRK1', 1],
    ]);
  });
});

describe('buildPdTargetComparison', () => {
  const drugs = [
    {
      id: 1,
      receptorTargets: [
        mechanism({
          ki: { median: 0.49, unit: 'nM' },
          ec50: { median: 0.033, unit: 'nM' },
          emax: { median: 105, unit: '%' },
        }),
      ],
    },
    {
      id: 2,
      receptorTargets: [
        mechanism({
          drugId: 2,
          ki: { median: 0.0012, unit: 'µM' },
          emax: { median: 100, unit: '%' },
        }),
      ],
    },
    { id: 3, receptorTargets: [] },
  ];

  it('lines drugs up in a shared unit and skips unreported metrics', () => {
    const comparison = buildPdTargetComparison(MOR.id, drugs);
    expect(comparison.metrics.map((m) => m.metric)).toEqual([
      'ki',
      'ec50',
      'emax',
    ]);
    const ki = comparison.metrics[0]!;
    expect(ki.commonUnit).toBe('nM');
    expect(ki.direction).toBe('inverse');
    expect(ki.values.map((v) => v.numeric)).toEqual([0.49, 1.2, null]);
    expect(formatPdValue(ki.values[1]!)).toBe('1.2 nM');
    expect(comparison.metrics[2]!.direction).toBe('direct');
  });

  it('prefers the ranked mechanism when a drug has several at one target', () => {
    const comparison = buildPdTargetComparison(MOR.id, [
      {
        id: 1,
        receptorTargets: [
          mechanism({ id: 2, tier: null, ki: { median: 50, unit: 'nM' } }),
          mechanism({ id: 3, tier: 'primary', ki: { median: 5, unit: 'nM' } }),
        ],
      },
    ]);
    expect(comparison.metrics[0]!.values[0]!.numeric).toBe(5);
  });

  it('flags mixed non-convertible units', () => {
    const comparison = buildPdTargetComparison(MOR.id, [
      { id: 1, receptorTargets: [mechanism({ potency: { median: 8.1, unit: 'pEC50' } })] },
      { id: 2, receptorTargets: [mechanism({ potency: { median: 3, unit: 'nM' } })] },
    ]);
    expect(comparison.metrics[0]!.hasUnitMismatch).toBe(true);
    expect(comparison.metrics[0]!.direction).toBeNull();
  });

  it('treats molar affinity/potency as lower-is-stronger', () => {
    const comparison = buildPdTargetComparison(MOR.id, [
      { id: 1, receptorTargets: [mechanism({ potency: { median: 1, unit: 'nM' } })] },
      { id: 2, receptorTargets: [mechanism({ potency: { median: 10, unit: 'nM' } })] },
    ]);
    expect(comparison.metrics[0]!.direction).toBe('inverse');
  });

  it('declines a direction for log-scale or free-text units', () => {
    expect(strengthDirection('potency', 'pEC50')).toBeNull();
    expect(strengthDirection('ki', 'pKi')).toBeNull();
    expect(strengthDirection('efficacy', 'fold')).toBeNull();
    expect(strengthDirection('efficacy', '%')).toBe('direct');
    expect(strengthDirection('emax', '%')).toBe('direct');
  });
});

describe('pdHeadline', () => {
  it('prefers Ki, then EC50', () => {
    expect(
      pdHeadline([
        mechanism({ ec50: { median: 2, unit: 'nM' }, ki: { median: 1, unit: 'µM' } }),
      ]),
    ).toMatchObject({ metric: 'ki', nanomolar: 1000 });
    expect(
      pdHeadline([mechanism({ ec50: { median: 2, unit: 'nM' } })]),
    ).toMatchObject({ metric: 'ec50', nanomolar: 2 });
    expect(pdHeadline([mechanism({})])).toBeNull();
  });
});

describe('affinityStrength', () => {
  it('maps sub-nanomolar to strong and micromolar to weak', () => {
    expect(affinityStrength(0.01)).toBe(1);
    expect(affinityStrength(10_000)).toBe(0);
    expect(affinityStrength(1)).toBeCloseTo(2 / 3);
    expect(affinityStrength(null)).toBeNull();
  });
});
