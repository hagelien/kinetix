import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProfileComparison, measurementGroups } from './ProfileComparison';
import { studyComparisons } from './StudyCurveComparison';
import { buildProfileMeasurements } from '../../../lib/pattern/buildProfile';
import { DIAZEPAM_FIXTURE_CASE } from '../../../lib/pattern/fixtures';
import { BENZODIAZEPINE_MODULE } from '../../../lib/pattern/modules/benzodiazepines';
import type { ObservationRowVM } from '../../../lib/pattern/profileModel';
import type { PatternCaseData } from '../../../types/patternCase';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'nb' },
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key} ${Object.values(values).join(' ')}` : key,
  }),
}));

const measurement: ObservationRowVM = {
  id: 'value-1', labelKey: '', pubchemCid: 3016, slug: 'diazepam',
  specimenId: 'urine-1', specimenLabel: 'Urin', matrix: 'urine',
  qualifier: 'quantified', measurandMode: 'direct', value: 1, valueText: '1', unit: 'nmol/L',
};
const modelOf = (...observations: ObservationRowVM[]) => ({ observations, specimenMetrics: [] });

const samples = [
  { id: 'urine-1', matrix: 'urine' as const, relativeTimeHours: 0 },
  { id: 'urine-2', matrix: 'urine' as const, relativeTimeHours: 24 },
];
const second = { ...measurement, id: 'value-2', specimenId: 'urine-2', value: 0.5, valueText: '0,5' };

describe('ProfileComparison', () => {
  it('always plots both measured samples even with unknown assay and no eligible study', () => {
    render(<ProfileComparison matrix="urine" specimens={samples} model={modelOf(
      { ...measurement, measurandMode: 'unknown' }, { ...second, measurandMode: 'unknown' },
    )} />);
    const graph = screen.getByRole('img', { name: 'pattern.profile.comparison.graphLabel 2 nmol/L' });
    expect(graph.querySelectorAll('line')).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: /pointSeries/ })).toHaveLength(2);
    expect(screen.queryByText('pattern.profile.comparison.referenceDetails')).toBeNull();
    expect(screen.getByText('1 → 0,5 nmol/L')).toBeVisible();
  });

  it('converts compatible units onto one axis while keeping different matrices separate', () => {
    const groups = measurementGroups([
      measurement, { ...second, unit: 'µmol/L', value: 0.001 },
      { ...measurement, id: 'blood', specimenId: 'blood', matrix: 'whole_blood' },
    ], false);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.series[0]?.points.map((point) => point.value)).toEqual([1, 1]);
    expect(groups[0]?.unit).toBe('nmol/L');
    const { rerender } = render(<ProfileComparison matrix="urine" specimens={samples} model={modelOf(measurement, second)} />);
    expect(screen.getByRole('img', { name: /graphLabel 2 nmol/ })).toBeInTheDocument();
    rerender(<ProfileComparison specimenId="urine-2" model={modelOf(measurement, second)} />);
    expect(screen.getByRole('img', { name: /graphLabel 1 nmol/ })).toBeInTheDocument();
  });

  it('retains a useful scaffold but never draws a reporting threshold as a measured point', () => {
    render(<ProfileComparison matrix="urine" specimens={samples} model={modelOf({
      ...measurement, qualifier: 'below_limit', value: undefined,
      limit: { label: 'LOQ', value: 5, valueText: '5', unit: 'ng/mL' },
    })} />);
    expect(screen.getByRole('img', { name: /graphLabel 2/ })).toBeInTheDocument();
    expect(screen.queryAllByRole('img', { name: /pointSeries/ })).toHaveLength(0);
    expect(screen.getByText(/pattern.profile.qualifier.below_limit 5 ng\/mL/)).toBeInTheDocument();
  });

  it('keeps zero as a measured point', () => {
    render(<ProfileComparison model={modelOf({ ...measurement, value: 0, valueText: '0', matrix: 'plasma' })} />);
    expect(screen.getByRole('img', { name: /pointSeries.*0 nmol\/L/ })).toBeInTheDocument();
    expect(screen.getAllByText('0 nmol/L').some((node) => !node.closest('.sr-only'))).toBe(true);
  });

  it('normalizes both samples using their own creatinine, with visible numbers', () => {
    render(<ProfileComparison matrix="urine" specimens={samples} model={modelOf(
      { ...measurement, creatinineNormalized: { value: 0.1, valueText: '0,1', unit: 'nmol/mmol' } },
      { ...second, creatinineNormalized: { value: 0.025, valueText: '0,025', unit: 'nmol/mmol' } },
    )} />);
    fireEvent.click(screen.getByRole('button', { name: 'pattern.profile.comparison.normalized' }));
    expect(screen.getByRole('img', { name: /graphLabel 2 nmol\/mmol/ })).toBeInTheDocument();
    expect(screen.getByText('0,1 → 0,025 nmol/mmol')).toBeVisible();
    expect(screen.queryByText('pattern.profile.comparison.referenceDetails')).toBeNull();
  });

  it('refuses partial normalization and returns to raw if one sample loses its creatinine', () => {
    const corrected = { ...measurement, creatinineNormalized: { value: 0.1, valueText: '0,1', unit: 'nmol/mmol' } };
    const correctedSecond = { ...second, creatinineNormalized: { value: 0.025, valueText: '0,025', unit: 'nmol/mmol' } };
    const { rerender } = render(<ProfileComparison matrix="urine" specimens={samples} model={modelOf(corrected, correctedSecond)} />);
    fireEvent.click(screen.getByRole('button', { name: 'pattern.profile.comparison.normalized' }));
    rerender(<ProfileComparison matrix="urine" specimens={samples} model={modelOf(corrected, second)} />);
    expect(screen.getByRole('button', { name: 'pattern.profile.comparison.normalized' })).toBeDisabled();
    expect(screen.getByRole('img', { name: /graphLabel 2 nmol\/L/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /graphLabel.*nmol\/mmol/ })).toBeNull();
  });

  it('does not bridge an absent middle sample or a differing reported form', () => {
    const third = { ...second, id: 'value-3', specimenId: 'urine-3' };
    const threeSamples = [...samples, { id: 'urine-3', matrix: 'urine' as const, relativeTimeHours: 48 }];
    const { rerender } = render(<ProfileComparison matrix="urine" specimens={threeSamples} model={modelOf(measurement, third)} />);
    expect(screen.getByRole('img', { name: /graphLabel 3/ }).querySelectorAll('line')).toHaveLength(0);
    rerender(<ProfileComparison matrix="urine" specimens={samples} model={modelOf(measurement, { ...second, measurandMode: 'total_after_hydrolysis' })} />);
    expect(screen.getByRole('img', { name: /graphLabel 2/ }).querySelectorAll('line')).toHaveLength(0);
  });

  it('distinguishes alternate reported mass bases in repeated measurements', () => {
    const groups = measurementGroups([
      { ...measurement, reportedAsDifferentSubstance: true, reportedAsDrugId: 1 },
      { ...second, reportedAsDifferentSubstance: true, reportedAsDrugId: 2 },
    ], false, samples);
    expect(groups[0]?.series).toHaveLength(2);
  });

  it('uses true unequal time intervals, and categorical spacing when timing is unknown', () => {
    const threeSamples = [samples[0]!, { ...samples[1]!, relativeTimeHours: 2 }, { id: 'urine-3', matrix: 'urine' as const, relativeTimeHours: 10 }];
    const rows = modelOf(measurement, second, { ...second, id: 'value-3', specimenId: 'urine-3' });
    const { rerender } = render(<ProfileComparison matrix="urine" specimens={threeSamples} model={rows} />);
    const line = screen.getByRole('img', { name: /graphLabel 3/ }).querySelector('line')!;
    expect(Number(line.getAttribute('x2'))).toBeCloseTo(24.8);
    rerender(<ProfileComparison matrix="urine" specimens={threeSamples.map((sample) => ({ ...sample, relativeTimeHours: undefined }))} model={rows} />);
    expect(screen.getByRole('img', { name: /graphLabel 3/ }).querySelector('line')).toHaveAttribute('x2', '50');
    expect(screen.getByText('pattern.profile.comparison.sampleAxis')).toBeVisible();
  });

  it('keeps study means, SD and provenance in a separate expandable reference section', () => {
    const { container } = render(<ProfileComparison model={modelOf(measurement)} />);
    expect(screen.getByRole('img', { name: /study.chartLabel/ })).not.toBeVisible();
    fireEvent.click(screen.getByText('pattern.profile.comparison.referenceDetails'));
    const chart = screen.getByRole('img', { name: /study.chartLabel/ });
    expect(chart.querySelectorAll('circle')).toHaveLength(11);
    expect(chart.querySelector('line[stroke-dasharray]')).toBeInTheDocument();
    const sourceDetails = container.querySelector<HTMLDetailsElement>('details details')!;
    expect(within(sourceDetails).getByText('2,3')).toBeInTheDocument();
    expect(within(sourceDetails).getByText('1,36')).toBeInTheDocument();
    expect(screen.getByText('pattern.profile.comparison.study.limitations')).toBeInTheDocument();
  });
});

describe('study comparison matching', () => {
  it('converts molar input into the study mass unit using the catalogue molecular weight', () => {
    expect(studyComparisons([measurement], false)[0]?.measurement).toBeCloseTo(0.28474);
  });

  it('refuses differing assay, matrix, postmortem context and reported mass basis', () => {
    for (const patch of [
      { measurandMode: 'total_after_hydrolysis' as const }, { measurandMode: 'unknown' as const },
      { matrix: 'plasma' as const }, { postmortem: true }, { reportedAsDifferentSubstance: true },
      { hydrolysis: 'snail' }, { unit: 'unrecognized' }, { qualifier: 'below_limit' },
    ]) expect(studyComparisons([{ ...measurement, ...patch }], false)).toEqual([]);
    expect(studyComparisons([measurement], true)).toEqual([]);
  });
});

describe('measurement graph model without a metabolism graph', () => {
  it('preserves assay and PM qualifiers and normalizes using each specimen’s own creatinine', () => {
    const caseData: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        { id: 'u1', label: 'Urin', matrix: 'urine', urine: { creatinineMmolL: 5 } },
        { id: 'u2', label: 'Urin', matrix: 'urine', urine: { creatinineMmolL: 10 } },
      ],
      observations: [
        { id: 'a', specimenId: 'u1', analyte: { pubchemCid: 3016 }, qualifier: 'quantified', value: 100, unit: 'nmol/L', assay: { measurandMode: 'free' } },
        { id: 'b', specimenId: 'u2', analyte: { pubchemCid: 3016 }, qualifier: 'quantified', value: 100, unit: 'nmol/L', assay: { measurandMode: 'free' } },
      ],
      context: { ...DIAZEPAM_FIXTURE_CASE.context, postmortem: true },
    };
    const model = buildProfileMeasurements(caseData, [BENZODIAZEPINE_MODULE]);
    expect(model.observations.map((row) => row.creatinineNormalized?.value)).toEqual([20, 10]);
    expect(model.observations.map((row) => row.specimenId)).toEqual(['u1', 'u2']);
    expect(model.observations.every((row) => row.postmortem && row.measurandMode === 'free')).toBe(true);
    expect(studyComparisons(model.observations, false)).toEqual([]);
  });
});
