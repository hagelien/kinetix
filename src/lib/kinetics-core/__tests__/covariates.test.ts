/**
 * SC-2A declarative covariate-function evaluation.
 *
 * Asserts the pure `resolveCovariateFactors` contract (plan §4.2/§5.4): allometric /
 * linear / categorical functions produce the right per-parameter factor, several
 * functions on one parameter multiply, a category the model does not list has no
 * effect, and a required covariate the subject omits is an explicit `missing` result
 * rather than a silent default.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCovariateFactors,
  individualisesDisposition,
  covariateOf,
} from '../covariates';
import type { CanonicalSubject, CovariateFunction } from '../types';

const subject: CanonicalSubject = { weightKg: 85, age: 40, sex: 'male' };

describe('resolveCovariateFactors — function kinds', () => {
  it('allometric: factor = (value/reference)^exponent', () => {
    const fn: CovariateFunction = {
      kind: 'allometric',
      covariate: 'weightKg',
      target: 'CL',
      exponent: 0.75,
      reference: 70,
    };
    const res = resolveCovariateFactors([fn], subject);
    if (!res.ok) throw new Error('expected ok');
    expect(res.factors.CL).toBeCloseTo((85 / 70) ** 0.75, 12);
    expect(res.applied).toEqual([{ covariate: 'weightKg', target: 'CL', factor: (85 / 70) ** 0.75 }]);
  });

  it('linear: factor = 1 + slope*(value - reference)', () => {
    const fn: CovariateFunction = {
      kind: 'linear',
      covariate: 'age',
      target: 'ka',
      slope: -0.01,
      reference: 30,
    };
    const res = resolveCovariateFactors([fn], subject);
    if (!res.ok) throw new Error('expected ok');
    expect(res.factors.ka).toBeCloseTo(1 + -0.01 * (40 - 30), 12); // 0.9
  });

  it('categorical: listed category multiplies; unlisted has NO effect (factor 1)', () => {
    const male: CovariateFunction = {
      kind: 'categorical',
      covariate: 'sex',
      target: 'CL',
      multipliers: { female: 0.85 }, // male not listed
    };
    const res = resolveCovariateFactors([male], subject);
    if (!res.ok) throw new Error('expected ok');
    // Subject is male, not in the map → factor 1 → CL factor recorded as 1.
    expect(res.factors.CL).toBe(1);
    expect(res.applied).toEqual([{ covariate: 'sex', target: 'CL', factor: 1 }]);

    const female = resolveCovariateFactors([male], { ...subject, sex: 'female' });
    if (!female.ok) throw new Error('expected ok');
    expect(female.factors.CL).toBe(0.85);
  });

  it('several functions on one parameter multiply', () => {
    const fns: CovariateFunction[] = [
      { kind: 'allometric', covariate: 'weightKg', target: 'CL', exponent: 0.75, reference: 70 },
      { kind: 'categorical', covariate: 'sex', target: 'CL', multipliers: { male: 1.1 } },
    ];
    const res = resolveCovariateFactors(fns, subject);
    if (!res.ok) throw new Error('expected ok');
    expect(res.factors.CL).toBeCloseTo((85 / 70) ** 0.75 * 1.1, 12);
    expect(res.applied).toHaveLength(2);
  });
});

describe('resolveCovariateFactors — missing required covariate', () => {
  it('reports a missing continuous covariate rather than defaulting', () => {
    const fn: CovariateFunction = {
      kind: 'allometric',
      covariate: 'age',
      target: 'CL',
      exponent: 1,
      reference: 30,
    };
    const res = resolveCovariateFactors([fn], { weightKg: 70 }); // no age
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected missing');
    expect(res.missing).toEqual(['age']);
  });

  it('reports a missing categorical covariate', () => {
    const fn: CovariateFunction = {
      kind: 'categorical',
      covariate: 'sex',
      target: 'Vc',
      multipliers: { female: 0.9 },
    };
    const res = resolveCovariateFactors([fn], { weightKg: 70 }); // no sex
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected missing');
    expect(res.missing).toEqual(['sex']);
  });

  it('deduplicates the missing list across functions', () => {
    const fns: CovariateFunction[] = [
      { kind: 'allometric', covariate: 'age', target: 'CL', exponent: 1, reference: 30 },
      { kind: 'linear', covariate: 'age', target: 'Vc', slope: 0.01, reference: 30 },
    ];
    const res = resolveCovariateFactors(fns, { weightKg: 70 });
    if (res.ok) throw new Error('expected missing');
    expect(res.missing).toEqual(['age']); // once, not twice
  });
});

describe('individualisesDisposition / covariateOf', () => {
  it('is true when a function targets CL or Vc, false for ka-only or empty', () => {
    expect(individualisesDisposition([])).toBe(false);
    expect(
      individualisesDisposition([
        { kind: 'linear', covariate: 'age', target: 'ka', slope: 0, reference: 0 },
      ]),
    ).toBe(false);
    expect(
      individualisesDisposition([
        { kind: 'allometric', covariate: 'weightKg', target: 'Vc', exponent: 1, reference: 70 },
      ]),
    ).toBe(true);
  });

  it('covariateOf returns the function covariate', () => {
    expect(
      covariateOf({ kind: 'allometric', covariate: 'weightKg', target: 'CL', exponent: 0.75, reference: 70 }),
    ).toBe('weightKg');
  });
});
