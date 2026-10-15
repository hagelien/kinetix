import { describe, expect, it } from 'vitest';
import {
  buildActivityPlot,
  classifyAssaySpecies,
  countLigandsBySpecies,
  filterLigandsBySpecies,
  normalizeInteractionType,
  plottableMetrics,
  rangeScalar,
  resolvePlotMetric,
  sortLigands,
  toNanomolar,
} from '@/lib/entityTargetLigands';
import type { EntityTargetLigand } from '@/lib/receptorTargets';

function ligand(
  overrides: Partial<EntityTargetLigand> & { relationshipId: number },
): EntityTargetLigand {
  return {
    drugId: overrides.relationshipId,
    drugSlug: `drug-${overrides.relationshipId}`,
    drugNames: { nb: `Drug ${overrides.relationshipId}` },
    drugMonographSlug: null,
    interactionType: 'agonist',
    tier: null,
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
    ...overrides,
  };
}

describe('normalizeInteractionType', () => {
  it('maps the explicit aliases to their presentation group', () => {
    expect(normalizeInteractionType('agonist')).toEqual({
      group: 'agonist',
      label: 'agonist',
    });
    expect(normalizeInteractionType('partial agonist')).toEqual({
      group: 'partial_agonist',
      label: 'partial agonist',
    });
    expect(normalizeInteractionType('partial_agonist').group).toBe(
      'partial_agonist',
    );
    expect(normalizeInteractionType('  Partial-Agonist ').group).toBe(
      'partial_agonist',
    );
    expect(normalizeInteractionType('competitive_antagonist').group).toBe(
      'antagonist',
    );
    expect(normalizeInteractionType('positive_allosteric_modulator').group).toBe(
      'positive_allosteric_modulator',
    );
    expect(normalizeInteractionType('channel_blocker').group).toBe('inhibitor');
  });

  it('sends unknown terminology to other and keeps its label', () => {
    expect(normalizeInteractionType('biased_agonist')).toEqual({
      group: 'other',
      label: 'biased agonist',
    });
    // No substring inference: "agonist" inside an unlisted term is not enough.
    expect(normalizeInteractionType('superagonist').group).toBe('other');
    expect(normalizeInteractionType('unspecified').group).toBe('other');
  });
});

describe('classifyAssaySpecies', () => {
  it('recognises explicit human assays', () => {
    expect(classifyAssaySpecies('Homo sapiens')).toBe('human');
    expect(classifyAssaySpecies('recombinant human (HEK293)')).toBe('human');
    expect(classifyAssaySpecies('human platelets')).toBe('human');
  });

  it('keeps everything else non-human, without guessing', () => {
    expect(classifyAssaySpecies('Rattus norvegicus')).toBe('non_human');
    expect(classifyAssaySpecies('HEK293')).toBe('non_human');
    expect(classifyAssaySpecies('humanized mouse')).toBe('non_human');
  });

  it('never classifies an explicitly non-human assay as human', () => {
    for (const label of [
      'non-human primate',
      'Non-Human tissue',
      'nonhuman primate',
      'non human primate',
      'not human',
      'non_human',
      'non\u2011human primate',
      'non–human primate',
    ]) {
      expect([label, classifyAssaySpecies(label)]).toEqual([label, 'non_human']);
    }
  });

  it('treats null and blank as unstated, never human', () => {
    expect(classifyAssaySpecies(null)).toBe('unstated');
    expect(classifyAssaySpecies('')).toBe('unstated');
    expect(classifyAssaySpecies('   ')).toBe('unstated');
  });

  it('counts and filters by class', () => {
    const rows = [
      ligand({ relationshipId: 1, assaySpecies: 'Homo sapiens' }),
      ligand({ relationshipId: 2, assaySpecies: 'Rattus norvegicus' }),
      ligand({ relationshipId: 3, assaySpecies: null }),
      ligand({ relationshipId: 4, assaySpecies: 'human cortex' }),
    ];
    expect(countLigandsBySpecies(rows)).toEqual({
      all: 4,
      human: 2,
      non_human: 1,
      unstated: 1,
    });
    expect(
      filterLigandsBySpecies(rows, 'human').map((r) => r.relationshipId),
    ).toEqual([1, 4]);
    expect(filterLigandsBySpecies(rows, 'all')).toHaveLength(4);
  });
});

describe('rangeScalar', () => {
  it('prefers the median over mean and bounds', () => {
    expect(rangeScalar({ median: 4, mean: 5, min: 1, max: 12 })).toEqual({
      value: 4,
      exact: true,
      low: 1,
      high: 12,
    });
  });

  it('falls back to the mean when the median is absent', () => {
    expect(rangeScalar({ mean: 5, min: 1, max: 12 })?.value).toBe(5);
  });

  it('uses the midpoint of min and max', () => {
    expect(rangeScalar({ min: 3, max: 12, unit: 'nM' })).toEqual({
      value: 7.5,
      exact: true,
      low: 3,
      high: 12,
    });
  });

  it('flags one-sided bounds as non-exact', () => {
    expect(rangeScalar({ min: 10 })).toEqual({
      value: 10,
      exact: false,
      low: null,
      high: null,
    });
    expect(rangeScalar({ max: 10 })?.exact).toBe(false);
    expect(rangeScalar({ median: 10, qualifier: '<' })?.exact).toBe(false);
    expect(rangeScalar({ median: 10, qualifier: '≥' })?.exact).toBe(false);
  });

  it('returns null without a reading', () => {
    expect(rangeScalar(null)).toBeNull();
    expect(rangeScalar({ unit: 'nM' })).toBeNull();
  });
});

describe('toNanomolar', () => {
  it('normalises compatible molar units to nM', () => {
    expect(toNanomolar(1, 'µM')).toBe(1000);
    expect(toNanomolar(1, 'uM')).toBe(1000);
    expect(toNanomolar(1, 'nM')).toBe(1);
    expect(toNanomolar(1, 'pM')).toBe(0.001);
    expect(toNanomolar(1, 'mM')).toBe(1e6);
    expect(toNanomolar(1, 'M')).toBe(1e9);
    expect(toNanomolar(2, 'nmol/L')).toBe(2);
  });

  it('leaves unsupported units non-plottable', () => {
    expect(toNanomolar(1, 'ng/mL')).toBeNull();
    expect(toNanomolar(1, '%')).toBeNull();
    expect(toNanomolar(1, undefined)).toBeNull();
  });
});

describe('buildActivityPlot', () => {
  const rows = [
    ligand({
      relationshipId: 1,
      interactionType: 'agonist',
      ki: { median: 2, unit: 'µM' },
    }),
    ligand({
      relationshipId: 2,
      interactionType: 'agonist',
      ki: { min: 3, max: 12, unit: 'nM' },
    }),
    ligand({
      relationshipId: 3,
      interactionType: 'antagonist',
      ki: { median: 0.5, unit: 'nM' },
      ec50: { median: 40, unit: 'nM' },
    }),
    ligand({
      relationshipId: 4,
      interactionType: 'biased_agonist',
      ki: { median: 9, unit: 'nM' },
    }),
    ligand({ relationshipId: 5, ki: { median: 1, unit: 'ng/mL' } }),
    ligand({ relationshipId: 6, ki: { max: 5, unit: 'nM' } }),
    ligand({ relationshipId: 7, interactionType: 'antagonist' }),
  ];

  it('plots concentrations in nM on a log axis, grouped by activity', () => {
    const plot = buildActivityPlot(rows, 'ki');
    expect(plot.scale).toBe('log');
    expect(plot.unit).toBe('nM');
    expect(plot.groups.map((g) => g.group)).toEqual([
      'agonist',
      'antagonist',
      'other',
    ]);
    // Smallest concentration first within a group; units converted.
    const agonists = plot.groups[0]!.points;
    expect(agonists.map((p) => p.ligand.relationshipId)).toEqual([2, 1]);
    expect(agonists[0]).toMatchObject({ value: 7.5, low: 3, high: 12 });
    expect(agonists[1]).toMatchObject({ value: 2000, low: null, high: null });
    // Unknown interaction types are plotted under "other", not dropped.
    expect(plot.groups[2]!.points[0]!.ligand.relationshipId).toBe(4);
  });

  it('lists unsupported units and one-sided bounds as omitted', () => {
    const plot = buildActivityPlot(rows, 'ki');
    expect(plot.omitted.map((o) => [o.ligand.relationshipId, o.reason])).toEqual([
      [5, 'unsupported_unit'],
      [6, 'one_sided'],
    ]);
    expect(plot.pointCount).toBe(4);
  });

  it('never mixes metrics: EC50 plots only rows that carry an EC50', () => {
    const plot = buildActivityPlot(rows, 'ec50');
    expect(plot.groups.flatMap((g) => g.points).map((p) => p.ligand.relationshipId)).toEqual([3]);
  });

  it('uses a linear axis in the stored unit for Emax', () => {
    const plot = buildActivityPlot(
      [
        ligand({ relationshipId: 1, emax: { median: 60, unit: '%' } }),
        ligand({ relationshipId: 2, emax: { median: 95, unit: '%' } }),
      ],
      'emax',
    );
    expect(plot.scale).toBe('linear');
    expect(plot.unit).toBe('%');
    // Largest first on a linear metric.
    expect(plot.groups[0]!.points.map((p) => p.value)).toEqual([95, 60]);
  });

  it('disables a linear plot whose units are heterogeneous', () => {
    const plot = buildActivityPlot(
      [
        ligand({ relationshipId: 1, emax: { median: 60, unit: '%' } }),
        ligand({ relationshipId: 2, emax: { median: 0.9, unit: 'fraction' } }),
      ],
      'emax',
    );
    expect(plot.pointCount).toBe(0);
    expect(plot.omitted.map((o) => o.reason)).toEqual([
      'heterogeneous_units',
      'heterogeneous_units',
    ]);
  });

  it('treats affinity as a concentration only when recorded in a molar unit', () => {
    expect(
      buildActivityPlot(
        [ligand({ relationshipId: 1, affinity: { median: 3, unit: 'nM' } })],
        'affinity',
      ).scale,
    ).toBe('log');
    const pKi = buildActivityPlot(
      [ligand({ relationshipId: 1, affinity: { median: 8.5, unit: 'pKi' } })],
      'affinity',
    );
    expect(pKi.scale).toBe('linear');
    expect(pKi.unit).toBe('pKi');
  });
});

describe('metric selection', () => {
  it('offers only metrics with a plottable value, Ki first', () => {
    const rows = [
      ligand({ relationshipId: 1, ec50: { median: 4, unit: 'nM' } }),
      ligand({ relationshipId: 2, ki: { median: 1, unit: 'nM' } }),
      ligand({ relationshipId: 3, ic50: { min: 10, unit: 'nM' } }),
    ];
    const available = plottableMetrics(rows);
    expect(available).toEqual(['ki', 'ec50']);
    expect(resolvePlotMetric(available, null)).toBe('ki');
    expect(resolvePlotMetric(available, 'ec50')).toBe('ec50');
    // A choice that is no longer plottable falls back.
    expect(resolvePlotMetric(available, 'ic50')).toBe('ki');
    expect(resolvePlotMetric([], 'ki')).toBeNull();
  });
});

describe('sortLigands', () => {
  const name = (l: EntityTargetLigand) => l.drugSlug;
  const rows = [
    ligand({ relationshipId: 1, drugSlug: 'b', ki: { median: 1, unit: 'µM' } }),
    ligand({ relationshipId: 2, drugSlug: 'a', ki: { median: 50, unit: 'nM' } }),
    ligand({ relationshipId: 3, drugSlug: 'c' }),
  ];

  it('keeps server order by default', () => {
    expect(sortLigands(rows, 'default', 'asc', name).map((r) => r.relationshipId)).toEqual([1, 2, 3]);
  });

  it('sorts measurements in a common unit with missing values last', () => {
    expect(sortLigands(rows, 'ki', 'asc', name).map((r) => r.relationshipId)).toEqual([2, 1, 3]);
    expect(sortLigands(rows, 'ki', 'desc', name).map((r) => r.relationshipId)).toEqual([1, 2, 3]);
  });

  it('never ranks a non-molar Ki against molar values', () => {
    const mixed = [
      ligand({ relationshipId: 1, ki: { median: 0.2, unit: 'nM' } }),
      ligand({ relationshipId: 2, ki: { median: 2.4, unit: 'ng/mL' } }),
      ligand({ relationshipId: 3, ki: { median: 1, unit: 'µM' } }),
      ligand({ relationshipId: 4 }),
      ligand({ relationshipId: 5, ki: { median: 8 } }),
    ];
    // The ng/mL and unitless rows are unsortable: they go last with the
    // value-less row, in original order, whichever way the column sorts.
    expect(sortLigands(mixed, 'ki', 'asc', name).map((r) => r.relationshipId)).toEqual([1, 3, 2, 4, 5]);
    expect(sortLigands(mixed, 'ki', 'desc', name).map((r) => r.relationshipId)).toEqual([3, 1, 2, 4, 5]);
  });

  it('sorts by drug name', () => {
    expect(sortLigands(rows, 'drug', 'asc', name).map((r) => r.drugSlug)).toEqual(['a', 'b', 'c']);
  });
});
