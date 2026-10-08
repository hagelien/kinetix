/**
 * CV-4b — assemble a runnable engine route from a derived model + its median values.
 *
 * The `fixed(median)` policy (founder decision, 2026-08-24): each required role's median is wrapped
 * as a `fixed` `ParamSpec`. A not-modelable derivation or a not-yet-mapped family is `unsupported`;
 * an absent/non-finite required value is `incomplete` (missing stays missing); otherwise `assembled`.
 */
import { describe, it, expect } from 'vitest';
import { deriveModel, assembleRouteParams, fixed, type AssemblyValues } from '../index';

describe('CV-4b — assembleRouteParams (fixed(median))', () => {
  it('assembles an IV bolus one-compartment route from t½ + Vd', () => {
    const derived = deriveModel({ disposition: 'one-compartment', absorption: 'bolus' }, [
      'eliminationHalfLife',
      'vd',
    ]);
    expect(derived.outcome).toBe('modelable');
    const result = assembleRouteParams(derived, { eliminationHalfLife: 4, vd: 0.7 });
    expect(result.outcome).toBe('assembled');
    if (result.outcome === 'assembled') {
      expect(result.family).toBe('iv-one-compartment');
      expect(result.params).toEqual({
        family: 'iv-one-compartment',
        eliminationHalfLifeHours: fixed(4),
        vdLitersPerKg: fixed(0.7),
      });
      // A plain bolus carries no infusion duration.
      expect('infusionDurationHours' in result.params).toBe(false);
    }
  });

  it('requires an infusion duration for the constant-rate IV variant, then carries it as a number', () => {
    const derived = deriveModel({ disposition: 'one-compartment', absorption: 'iv-infusion' }, [
      'eliminationHalfLife',
      'vd',
    ]);
    // Without the duration the route is incomplete (the absorption axis makes it required).
    const incomplete = assembleRouteParams(derived, { eliminationHalfLife: 4, vd: 0.7 });
    expect(incomplete.outcome).toBe('incomplete');
    if (incomplete.outcome === 'incomplete') expect(incomplete.missing).toEqual(['infusionDuration']);

    const assembled = assembleRouteParams(derived, {
      eliminationHalfLife: 4,
      vd: 0.7,
      infusionDuration: 0.5,
    });
    expect(assembled.outcome).toBe('assembled');
    if (assembled.outcome === 'assembled' && assembled.params.family === 'iv-one-compartment') {
      // The duration is a plain number on this family, not a ParamSpec.
      expect(assembled.params.infusionDurationHours).toBe(0.5);
    }
  });

  it('rejects a non-positive infusion duration (would silently render an IV bolus)', () => {
    const derived = deriveModel({ disposition: 'one-compartment', absorption: 'iv-infusion' }, [
      'eliminationHalfLife',
      'vd',
    ]);
    for (const infusionDuration of [0, -1]) {
      const result = assembleRouteParams(derived, { eliminationHalfLife: 4, vd: 0.7, infusionDuration });
      expect(result.outcome).toBe('incomplete');
      if (result.outcome === 'incomplete') expect(result.missing).toEqual(['infusionDuration']);
    }
  });

  it('rejects a non-positive zero-order duration', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'zero-order' },
      ['zeroOrderDuration', 'eliminationHalfLife', 'vd', 'bioavailability'],
    );
    const result = assembleRouteParams(derived, {
      zeroOrderDuration: 0,
      eliminationHalfLife: 6,
      vd: 1.1,
      bioavailability: 0.9,
    });
    expect(result.outcome).toBe('incomplete');
    if (result.outcome === 'incomplete') expect(result.missing).toEqual(['zeroOrderDuration']);
  });

  it('assembles an oral first-order route when ka is supplied', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'],
    );
    const result = assembleRouteParams(derived, {
      ka: 1.2,
      eliminationHalfLife: 3,
      vd: 5,
      bioavailability: 0.8,
    });
    expect(result.outcome).toBe('assembled');
    if (result.outcome === 'assembled') {
      expect(result.params).toEqual({
        family: 'one-compartment-first-order',
        kaPerHour: fixed(1.2),
        eliminationHalfLifeHours: fixed(3),
        vdLitersPerKg: fixed(5),
        bioavailability: fixed(0.8),
      });
    }
  });

  it('reports the missing ka an oral first-order model needs (missing stays missing)', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ['eliminationHalfLife', 'vd', 'bioavailability'],
    );
    const result = assembleRouteParams(derived, {
      eliminationHalfLife: 3,
      vd: 5,
      bioavailability: 0.8,
    });
    expect(result.outcome).toBe('incomplete');
    if (result.outcome === 'incomplete') {
      expect(result.family).toBe('one-compartment-first-order');
      expect(result.missing).toEqual(['ka']);
    }
  });

  it('treats a non-finite required value as missing rather than a fixed(NaN) curve', () => {
    const derived = deriveModel({ disposition: 'one-compartment', absorption: 'bolus' }, [
      'eliminationHalfLife',
      'vd',
    ]);
    const result = assembleRouteParams(derived, { eliminationHalfLife: Number.NaN, vd: 0.7 });
    expect(result.outcome).toBe('incomplete');
    if (result.outcome === 'incomplete') expect(result.missing).toEqual(['eliminationHalfLife']);
  });

  it('passes vdScaling through when supplied and omits it otherwise', () => {
    const derived = deriveModel({ disposition: 'one-compartment', absorption: 'bolus' }, [
      'eliminationHalfLife',
      'vd',
    ]);
    const scaled = assembleRouteParams(
      derived,
      { eliminationHalfLife: 4, vd: 0.7 },
      { vdScaling: 'lean-body-mass' },
    );
    if (scaled.outcome === 'assembled' && scaled.params.family === 'iv-one-compartment') {
      expect(scaled.params.vdScaling).toBe('lean-body-mass');
    }

    const unscaled = assembleRouteParams(derived, { eliminationHalfLife: 4, vd: 0.7 });
    if (unscaled.outcome === 'assembled') {
      expect('vdScaling' in unscaled.params).toBe(false);
    }
  });

  it('assembles zero-order and mixed-order one-compartment routes', () => {
    const zeroOrder = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'zero-order' },
      ['zeroOrderDuration', 'eliminationHalfLife', 'vd', 'bioavailability'],
    );
    const zResult = assembleRouteParams(zeroOrder, {
      zeroOrderDuration: 2,
      eliminationHalfLife: 6,
      vd: 1.1,
      bioavailability: 0.9,
    });
    expect(zResult.outcome).toBe('assembled');
    if (zResult.outcome === 'assembled') expect(zResult.params.family).toBe('one-compartment-zero-order');

    const mixed = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'mixed' },
      ['firstOrderFraction', 'ka', 'zeroOrderDuration', 'eliminationHalfLife', 'vd', 'bioavailability'],
    );
    const mValues: AssemblyValues = {
      firstOrderFraction: 0.6,
      ka: 1.0,
      zeroOrderDuration: 3,
      eliminationHalfLife: 5,
      vd: 1.4,
      bioavailability: 0.75,
    };
    const mResult = assembleRouteParams(mixed, mValues);
    expect(mResult.outcome).toBe('assembled');
    if (mResult.outcome === 'assembled') {
      expect(mResult.params.family).toBe('one-compartment-mixed-order');
      if (mResult.params.family === 'one-compartment-mixed-order') {
        expect(mResult.params.firstOrderFraction).toEqual(fixed(0.6));
      }
    }
  });

  it('is unsupported for a not-modelable derivation, carrying its reason', () => {
    const derived = deriveModel({ absorption: 'transit' }, ['eliminationHalfLife', 'vd']);
    expect(derived.outcome).toBe('not-modelable');
    const result = assembleRouteParams(derived, { eliminationHalfLife: 4, vd: 0.7 });
    expect(result.outcome).toBe('unsupported');
    if (result.outcome === 'unsupported') expect(result.reason).toMatch(/transit/i);
  });

  it('is unsupported for a family whose inputs the catalog cannot yet supply', () => {
    // Saturable (Michaelis–Menten) elimination composes to a real family, but assembling it needs
    // canonical-unit Vmax/Km this primitive does not yet map.
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'michaelis-menten', absorption: 'first-order' },
      ['ka', 'vmax', 'km', 'vd', 'bioavailability', 'eliminationHalfLife'],
    );
    expect(derived.outcome).toBe('modelable');
    expect(derived.family).toBe('michaelis-menten');
    const result = assembleRouteParams(derived, {});
    expect(result.outcome).toBe('unsupported');
    if (result.outcome === 'unsupported') expect(result.reason).toMatch(/michaelis-menten/);
  });
});

describe('assembleRouteParams — reported spreads become triangular specs', () => {
  const oral = () =>
    deriveModel({ disposition: 'one-compartment', absorption: 'first-order' }, [
      'ka',
      'eliminationHalfLife',
      'vd',
      'bioavailability',
    ]);
  const values = { ka: 1, eliminationHalfLife: 4, vd: 0.7, bioavailability: 0.8 };

  it('draws a role across its reported spread, peaked at the median the fixed spec used', () => {
    const result = assembleRouteParams(oral(), values, {
      ranges: { eliminationHalfLife: { low: 2, high: 9 }, bioavailability: { low: 0.6, high: 0.9 } },
    });
    expect(result.outcome).toBe('assembled');
    if (result.outcome !== 'assembled' || result.params.family !== 'one-compartment-first-order') return;
    expect(result.params.eliminationHalfLifeHours).toEqual({
      kind: 'triangular',
      min: 2,
      mode: 4,
      max: 9,
      bounds: { kind: 'extrema' },
    });
    expect(result.params.bioavailability).toMatchObject({ kind: 'triangular', min: 0.6, mode: 0.8, max: 0.9 });
    // A role with no spread is unchanged.
    expect(result.params.vdLitersPerKg).toEqual(fixed(0.7));
  });

  it('keeps fixed(median) when a spread is unusable rather than clipping it', () => {
    const unusable = {
      eliminationHalfLife: { low: 5, high: 9 }, // excludes the median
      vd: { low: 0.7, high: 0.7 }, // not an interval
      ka: { low: 0, high: 3 }, // reaches a non-positive rate
      bioavailability: { low: 0.5, high: 1.2 }, // leaves [0, 1]
    };
    const result = assembleRouteParams(oral(), values, { ranges: unusable });
    expect(result.outcome).toBe('assembled');
    if (result.outcome !== 'assembled' || result.params.family !== 'one-compartment-first-order') return;
    expect(result.params.eliminationHalfLifeHours).toEqual(fixed(4));
    expect(result.params.vdLitersPerKg).toEqual(fixed(0.7));
    expect(result.params.kaPerHour).toEqual(fixed(1));
    expect(result.params.bioavailability).toEqual(fixed(0.8));
  });
});
