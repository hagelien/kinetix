import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProfileComparison } from './ProfileComparison';
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

describe('ProfileComparison', () => {
  it('uses actual specimen identity and unit to separate axes, and limits the selected specimen', () => {
    const { container, rerender } = render(<ProfileComparison model={modelOf(
      measurement,
      { ...measurement, id: 'value-2', specimenId: 'urine-2', value: 10, valueText: '10' },
      { ...measurement, id: 'value-3', unit: 'ng/mL' },
    )} />);
    // Three measured panels, followed by one supported study per observation.
    expect(container.querySelectorAll('figure')).toHaveLength(6);
    rerender(<ProfileComparison specimenId="urine-2" model={modelOf(
      measurement, { ...measurement, id: 'value-2', specimenId: 'urine-2', value: 10, valueText: '10' },
    )} />);
    expect(container.querySelectorAll('figure')).toHaveLength(2);
  });

  it('never draws a reporting threshold as a measured point', () => {
    render(<ProfileComparison model={modelOf({
      ...measurement, qualifier: 'below_limit', value: undefined,
      limit: { label: 'LOQ', value: 5, valueText: '5', unit: 'ng/mL' },
    })} />);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByText(/pattern.profile.qualifier.below_limit 5 ng\/mL/)).toBeInTheDocument();
  });

  it('keeps zero as a measured point and does not replace it with a missing value', () => {
    render(<ProfileComparison model={modelOf({ ...measurement, value: 0, valueText: '0', matrix: 'plasma' })} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('0 nmol/L');
    expect(screen.getByText('0 nmol/L')).toBeInTheDocument();
  });

  it('changes units on normalization and withholds unnormalized study comparisons', () => {
    render(<ProfileComparison model={modelOf({
      ...measurement, creatinineNormalized: { value: 0.1, valueText: '0,1', unit: 'nmol/mmol' },
    })} />);
    expect(screen.getByRole('img', { name: /study.chartLabel/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'pattern.profile.comparison.normalized' }));
    expect(screen.queryByRole('img', { name: /study.chartLabel/ })).toBeNull();
    expect(screen.getByText('0,1 nmol/mmol')).toBeInTheDocument();
    expect(screen.getByText('pattern.profile.comparison.study.noNormalizedStudy')).toBeInTheDocument();
  });

  it('shows exact source observations and SD separately from the mean line', () => {
    const { container } = render(<ProfileComparison model={modelOf(measurement)} />);
    const chart = screen.getByRole('img', { name: /study.chartLabel/ });
    expect(chart.querySelectorAll('circle')).toHaveLength(11);
    expect(chart.querySelector('line[stroke-dasharray]')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://doi.org/10.1007/s40268-021-00375-y');
    const sourceDetails = container.querySelector('details')!;
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
