import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultsSummary } from './ResultsSummary';
import type { DrugSimResult } from '@/types/simulator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.defaultValue ? String(options.defaultValue) : key,
  }),
}));

const result: DrugSimResult = {
  drugConfigId: 'cfg-1',
  engine: 'kinelab-bayes',
  questionMode: 'dose-from-concentration',
  median: 1.2,
  p05: 0.8,
  p25: 1,
  p75: 1.4,
  p95: 1.6,
  unit: 'mg/L',
  timeSeries: [{ t: 5, p05: 0.8, p25: 1, median: 1.2, p75: 1.4, p95: 1.6 }],
  assumptions: {
    model: 'KineLab Bayesian inference',
    route: 'oral',
    halfLife: { type: 'fixed', value: 0 },
    vd: { type: 'fixed', value: 0 },
    f: { type: 'fixed', value: 1 },
    weightScaling: true,
  },
  sensitivity: [],
  warnings: [],
  seed: 42,
  drawCount: 2000,
  kinelab: {
    posterior: {
      intervals: {
        dose: { p05: 120, median: 180, p95: 260, unit: 'mg' },
      },
    },
    diagnostics: {
      sampleCount: 1000,
      rejectedNonphysical: 0,
      rejectedImpossible: 0,
      effectiveSampleSize: 800,
    },
  },
};

describe('ResultsSummary', () => {
  it('renders KineLab posterior parameter intervals', () => {
    render(
      <ResultsSummary
        results={{ 'cfg-1': result }}
        drugLabels={{ 'cfg-1': 'Diazepam' }}
        drugColors={{ 'cfg-1': '#2563eb' }}
      />,
    );

    expect(screen.getByText('results.posteriorPredictivePeak')).toBeTruthy();
    expect(screen.getByText('results.posteriorIntervals')).toBeTruthy();
    expect(screen.getByText('dose (mg)')).toBeTruthy();
    expect(screen.getByText('180')).toBeTruthy();
  });
});
