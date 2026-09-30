import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnswerCard } from './AnswerCard';
import type { DrugSimResult } from '@/types/simulator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.defaultValue ? String(options.defaultValue) : key,
  }),
}));

function kinelabResult(ess: number, sampleCount = 1000): DrugSimResult {
  return {
    drugConfigId: 'cfg-1',
    engine: 'kinelab-bayes',
    questionMode: 'dose-from-concentration',
    median: 0.9,
    p05: 0.7,
    p25: 0.8,
    p75: 1,
    p95: 1.1,
    unit: 'mg/L',
    timeSeries: [],
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
    drawCount: sampleCount,
    kinelab: {
      posterior: {
        intervals: { dose: { p05: 120, median: 180, p95: 260, unit: 'mg' } },
      },
      diagnostics: {
        sampleCount,
        rejectedNonphysical: 0,
        rejectedImpossible: 0,
        effectiveSampleSize: ess,
      },
    },
  };
}

function renderCard(result: DrugSimResult) {
  return render(
    <AnswerCard
      results={{ 'cfg-1': result }}
      drugLabels={{ 'cfg-1': 'Morphine' }}
      drugColors={{ 'cfg-1': '#2563eb' }}
    />,
  );
}

describe('AnswerCard robustness gate', () => {
  it('shows the credible interval for a robust posterior', () => {
    renderCard(kinelabResult(800));
    expect(screen.getByText(/answer\.interval\.credible/)).toBeTruthy();
    expect(screen.queryByText('answer.notRobust.title')).toBeNull();
  });

  it('shows the median and confidence bands (moved from Resultater)', () => {
    renderCard(kinelabResult(800));
    // The relocated distribution grid: median label + 25–75% / 5–95% bands.
    expect(screen.getByText('results.median')).toBeTruthy();
    expect(screen.getByText('25–75%')).toBeTruthy();
    expect(screen.getByText('5–95%')).toBeTruthy();
    expect(screen.getByText(/0\.8\s*–\s*1\s*mg\/L/)).toBeTruthy();
  });

  it('hides the distribution grid when the posterior is not robust', () => {
    renderCard(kinelabResult(10));
    expect(screen.queryByText('results.median')).toBeNull();
    expect(screen.queryByText('5–95%')).toBeNull();
  });

  it('blocks the median/CI with a not-robust notice when ESS is critically low', () => {
    renderCard(kinelabResult(10)); // ratio 0.01 < 2% critical
    expect(screen.getByText('answer.notRobust.title')).toBeTruthy();
    expect(screen.getByText('answer.notRobust.badge')).toBeTruthy();
    expect(screen.getByText('answer.notRobust.criticalEss')).toBeTruthy();
    // The authoritative credible-interval line must NOT render.
    expect(screen.queryByText(/answer\.interval\.credible/)).toBeNull();
  });

  it('blocks an empty posterior', () => {
    const empty = kinelabResult(0, 0);
    empty.kinelab!.posterior.intervals = {};
    renderCard(empty);
    expect(screen.getByText('answer.notRobust.title')).toBeTruthy();
    expect(screen.getByText('answer.notRobust.emptyPosterior')).toBeTruthy();
  });
});

describe('AnswerCard with a deterministic run', () => {
  // A reviewed kinetics-core model declares fixed parameters, so the Monte
  // Carlo run collapses onto one curve. The card used to render that as
  // "2.839 – 2.839" three times over — a range, a quartile band and a 5–95%
  // band, none of which the run produced.
  function flatResult(): DrugSimResult {
    return {
      drugConfigId: 'cfg-1',
      engine: 'pk-montecarlo',
      questionMode: 'later-from-earlier',
      median: 2.839,
      p05: 2.839,
      p25: 2.839,
      p75: 2.839,
      p95: 2.839,
      unit: 'µmol/L',
      timeSeries: [],
      assumptions: {
        model: 'one-compartment, first-order elimination',
        route: 'oral',
        halfLife: { type: 'fixed', value: 11 },
        vd: { type: 'fixed', value: 280 },
        f: { type: 'fixed', value: 0.8 },
        weightScaling: false,
      },
      sensitivity: [],
      warnings: [],
      seed: 42,
      drawCount: 10000,
    };
  }

  it('states the point estimate and why there is no interval', () => {
    renderCard(flatResult());
    expect(screen.getByText('results.median')).toBeTruthy();
    expect(screen.getByText('answer.deterministic')).toBeTruthy();
    // No collapsed range anywhere: neither the named interval line nor the
    // quartile / 5–95% rows.
    expect(screen.queryByText(/answer\.interval\.model/)).toBeNull();
    expect(screen.queryByText('25–75%')).toBeNull();
    expect(screen.queryByText('5–95%')).toBeNull();
    expect(screen.queryByText(/2\.839\s*–\s*2\.839/)).toBeNull();
  });

  it('keeps the full distribution when the run did spread', () => {
    const spread = { ...flatResult(), p05: 2, p25: 2.5, p75: 3.2, p95: 3.8 };
    renderCard(spread);
    expect(screen.getByText('25–75%')).toBeTruthy();
    expect(screen.getByText('5–95%')).toBeTruthy();
    expect(screen.queryByText('answer.deterministic')).toBeNull();
  });
});

describe('AnswerCard with a run that produced no answer', () => {
  // A refused or failed core run carries placeholder zeros in every percentile.
  // Rendering them would put a confident "0" in the headline — worse now that a
  // collapsed band reads as a deterministic point estimate.
  function failedResult(): DrugSimResult {
    return {
      drugConfigId: 'cfg-1',
      engine: 'pk-montecarlo',
      questionMode: 'dose-from-concentration',
      median: 0,
      p05: 0,
      p25: 0,
      p75: 0,
      p95: 0,
      unit: 'mg/L',
      timeSeries: [],
      failure: {
        message: 'simulator.warnings.nonlinearDoseSolve',
        messageKey: 'simulator.warnings.nonlinearDoseSolve',
      },
      assumptions: {
        model: 'michaelis-menten',
        route: 'oral',
        halfLife: { type: 'fixed', value: 8 },
        vd: { type: 'fixed', value: 250 },
        f: { type: 'fixed', value: 0.75 },
        weightScaling: false,
      },
      sensitivity: [],
      warnings: [],
      seed: 42,
      drawCount: 0,
    };
  }

  it('shows no figure at all, and says why', () => {
    renderCard(failedResult());
    expect(screen.getByText('answer.failed.title')).toBeTruthy();
    expect(screen.getByText('answer.failed.badge')).toBeTruthy();
    expect(
      screen.getByText('simulator.warnings.nonlinearDoseSolve'),
    ).toBeTruthy();
    // Neither the headline number, nor the struck-through reference value a
    // weak posterior gets, nor the deterministic-run explanation.
    expect(screen.queryByText(/\b0\s*mg\/L/)).toBeNull();
    expect(screen.queryByText('results.median')).toBeNull();
    expect(screen.queryByText('answer.deterministic')).toBeNull();
  });

  it('still shows the struck-through value for a merely weak posterior', () => {
    // The two states are distinct: a weak posterior HAS a value.
    renderCard(kinelabResult(10));
    expect(screen.getByText('answer.notRobust.title')).toBeTruthy();
    expect(screen.queryByText('answer.failed.title')).toBeNull();
  });
});
