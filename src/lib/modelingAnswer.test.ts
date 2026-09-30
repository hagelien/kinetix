import { describe, expect, it } from 'vitest';
import {
  deriveAnswer,
  hasUncertaintyBand,
  kinelabRobustness,
} from './modelingAnswer';
import type { DrugSimResult, QuestionMode } from '@/types/simulator';

function result(overrides: Partial<DrugSimResult> = {}): DrugSimResult {
  return {
    drugConfigId: 'c1',
    questionMode: 'later-from-earlier' as QuestionMode,
    median: 10,
    p05: 8,
    p25: 9,
    p75: 11,
    p95: 12,
    unit: 'mg/L',
    timeSeries: [],
    assumptions: {
      model: 'm',
      route: 'oral',
      halfLife: { type: 'fixed', value: 4 },
      vd: { type: 'fixed', value: 50 },
      f: { type: 'fixed', value: 1 },
      weightScaling: false,
    },
    sensitivity: [],
    warnings: [],
    seed: 1,
    drawCount: 100,
    ...overrides,
  };
}

describe('deriveAnswer', () => {
  it('reports the inferred dose with a credible interval for KineLab', () => {
    const a = deriveAnswer(
      result({
        engine: 'kinelab-bayes',
        questionMode: 'dose-from-concentration',
        median: 0.9, // predictive peak concentration — must NOT be the answer
        unit: 'mg/L',
        kinelab: {
          posterior: {
            intervals: {
              dose: { median: 120, p05: 80, p95: 180, unit: 'mg' },
            },
          },
          diagnostics: {
            sampleCount: 2000,
            rejectedNonphysical: 0,
            rejectedImpossible: 0,
            effectiveSampleSize: 900,
          },
        },
      }),
    );
    expect(a.labelKey).toBe('answer.inferredDose');
    expect(a.value).toBe(120);
    expect(a.low).toBe(80);
    expect(a.high).toBe(180);
    expect(a.unit).toBe('mg');
    expect(a.intervalKey).toBe('answer.interval.credible');
  });

  it('reports a deterministic BAC (no interval) for ethanol', () => {
    const a = deriveAnswer(
      result({ engine: 'ethanol-widmark', median: 0.8, unit: 'g/dL' }),
    );
    expect(a.labelKey).toBe('answer.bac');
    expect(a.value).toBe(0.8);
    expect(a.intervalKey).toBeUndefined();
  });

  it('labels a dose-from-concentration Monte Carlo result as inferred dose', () => {
    const a = deriveAnswer(
      result({ engine: 'pk-montecarlo', questionMode: 'dose-from-concentration', unit: 'mg' }),
    );
    expect(a.labelKey).toBe('answer.inferredDose');
    expect(a.intervalKey).toBe('answer.interval.model');
  });

  it('labels earlier-from-later as back-extrapolated concentration', () => {
    const a = deriveAnswer(result({ questionMode: 'earlier-from-later' }));
    expect(a.labelKey).toBe('answer.backExtrapolated');
    expect(a.intervalKey).toBe('answer.interval.model');
  });

  it('labels a forward concentration question as predicted concentration', () => {
    const a = deriveAnswer(result({ questionMode: 'concentration-from-dose' }));
    expect(a.labelKey).toBe('answer.predictedConcentration');
    expect(a.value).toBe(10);
    expect(a.low).toBe(8);
    expect(a.high).toBe(12);
  });
});

describe('kinelabRobustness', () => {
  function kinelab(
    diagnostics: {
      sampleCount: number;
      rejectedNonphysical?: number;
      rejectedImpossible?: number;
      effectiveSampleSize: number;
    },
    hasDose = true,
  ): DrugSimResult {
    return result({
      engine: 'kinelab-bayes',
      questionMode: 'dose-from-concentration',
      kinelab: {
        posterior: {
          intervals: hasDose
            ? { dose: { median: 120, p05: 80, p95: 180, unit: 'mg' } }
            : {},
        },
        diagnostics: {
          rejectedNonphysical: 0,
          rejectedImpossible: 0,
          ...diagnostics,
        },
      },
    });
  }

  it('is robust for a healthy ESS ratio', () => {
    expect(
      kinelabRobustness(
        kinelab({ sampleCount: 2000, effectiveSampleSize: 900 }),
      ),
    ).toEqual({ robust: true });
  });

  it('blocks a critically low ESS (ratio < 2%)', () => {
    const r = kinelabRobustness(
      kinelab({ sampleCount: 2000, effectiveSampleSize: 20 }),
    );
    expect(r.robust).toBe(false);
    expect(r).toMatchObject({ reasonKey: 'answer.notRobust.criticalEss' });
  });

  it('blocks an empty posterior (no surviving draws)', () => {
    const r = kinelabRobustness(
      kinelab({ sampleCount: 0, effectiveSampleSize: 0 }, false),
    );
    expect(r.robust).toBe(false);
    expect(r).toMatchObject({ reasonKey: 'answer.notRobust.emptyPosterior' });
  });

  it('blocks when the posterior carries no dose interval', () => {
    const r = kinelabRobustness(
      kinelab({ sampleCount: 500, effectiveSampleSize: 300 }, false),
    );
    expect(r.robust).toBe(false);
    expect(r).toMatchObject({ reasonKey: 'answer.notRobust.emptyPosterior' });
  });

  it('treats non-KineLab results as robust (own warnings surface)', () => {
    expect(
      kinelabRobustness(result({ engine: 'pk-montecarlo' })),
    ).toEqual({ robust: true });
  });
});

describe('deterministic runs carry no interval', () => {
  // Every reviewed kinetics-core model declares `fixed` parameters, so a Monte
  // Carlo run over them reproduces one curve and returns p05 === p95. The UI
  // used to print that as "2.839 – 2.839, pointwise 90% model interval",
  // which claims a precision the run never established.
  const flat = { median: 2.839, p05: 2.839, p25: 2.839, p75: 2.839, p95: 2.839 };

  it('recognises a collapsed band as no band at all', () => {
    expect(hasUncertaintyBand(result(flat))).toBe(false);
    expect(hasUncertaintyBand(result())).toBe(true);
  });

  it('reports the point estimate without naming an interval', () => {
    const a = deriveAnswer(result(flat));
    expect(a.value).toBe(2.839);
    expect(a.low).toBeUndefined();
    expect(a.high).toBeUndefined();
    expect(a.intervalKey).toBeUndefined();
  });

  it('still names the interval when the run genuinely spread', () => {
    const a = deriveAnswer(result());
    expect(a.low).toBe(8);
    expect(a.high).toBe(12);
    expect(a.intervalKey).toBe('answer.interval.model');
  });
});
