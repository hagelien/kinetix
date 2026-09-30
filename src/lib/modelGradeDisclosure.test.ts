/**
 * CV-3c — the disclaimer disclosure builder.
 *
 * `describeDerivedModel` turns a derived, graded model into the locale-agnostic data every
 * disclaimer surface renders: grade, limiting factor, band widening, render-eligibility, and the
 * structured caveats (defaulted axes, missing parameters, weak source pool, not-validated, or
 * not-modelable).
 */
import { describe, it, expect } from 'vitest';
import { describeDerivedModel } from './modelGradeDisclosure';
import { deriveModel, GRADE_BAND_WIDENING_CV, type RequiredParam } from './kinetics-core/index';

const ORAL_1C_PARAMS: RequiredParam[] = ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'];

describe('CV-3c — describeDerivedModel', () => {
  it('discloses nothing for a spotless, validated A model', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    const d = describeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' });
    expect(d.rendersCurve).toBe(true);
    expect(d.grade).toBe('A');
    expect(d.limitingFactor).toBe('structure'); // ties resolve to structure, but grade is A
    expect(d.bandWideningCv).toBeNull(); // A widens nothing
    expect(d.caveats).toEqual([]);
  });

  it('lists the defaulted axes and the band widening for a fully-defaulted model', () => {
    const derived = deriveModel({}, ORAL_1C_PARAMS); // all three axes defaulted, complete
    const d = describeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' });
    expect(d.rendersCurve).toBe(true);
    expect(d.grade).toBe('D'); // 3 defaulted axes → structure D
    expect(d.limitingFactor).toBe('structure');
    expect(d.bandWideningCv).toBe(GRADE_BAND_WIDENING_CV.D);
    expect(d.caveats).toContainEqual({
      code: 'defaulted-axes',
      axes: ['disposition', 'elimination', 'absorption'],
    });
  });

  it('lists missing parameters as a caveat', () => {
    const derived = deriveModel({}, ['vd']); // ka, eliminationHalfLife, bioavailability missing
    const d = describeDerivedModel(derived);
    const missing = d.caveats.find((c) => c.code === 'missing-parameters');
    expect(missing).toBeDefined();
    if (missing?.code === 'missing-parameters') {
      expect(missing.parameters).toEqual(
        expect.arrayContaining(['ka', 'eliminationHalfLife', 'bioavailability']),
      );
    }
  });

  it('flags a weak (assessed) source pool but not an unassessed one', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    const weak = describeDerivedModel(derived, { sourceQuality: 'C', validationStatus: 'validated' });
    expect(weak.caveats).toContainEqual({ code: 'weak-source-quality', grade: 'C' });

    const unassessed = describeDerivedModel(derived, { validationStatus: 'validated' });
    expect(unassessed.caveats.some((c) => c.code === 'weak-source-quality')).toBe(false);
  });

  it('carries a not-validated caveat until the model is validated', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    expect(
      describeDerivedModel(derived, { sourceQuality: 'A' }).caveats.some(
        (c) => c.code === 'not-validated',
      ),
    ).toBe(true);
    expect(
      describeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' }).caveats.some(
        (c) => c.code === 'not-validated',
      ),
    ).toBe(false);
  });

  it('discloses a not-modelable derivation as disclaimer-only, no curve, no grade', () => {
    const derived = deriveModel({ absorption: 'transit' }, ORAL_1C_PARAMS);
    const d = describeDerivedModel(derived);
    expect(d.rendersCurve).toBe(false);
    expect(d.grade).toBeNull();
    expect(d.limitingFactor).toBeNull();
    expect(d.bandWideningCv).toBeNull();
    expect(d.caveats).toHaveLength(1);
    expect(d.caveats[0]!.code).toBe('not-modelable');
    if (d.caveats[0]!.code === 'not-modelable') {
      expect(d.caveats[0]!.reason).toMatch(/transit/i);
    }
  });

  it('orders caveats structure → parameters → source → validation', () => {
    // 2 defaulted axes + missing ka + weak source + unvalidated → all four caveats, in order.
    const derived = deriveModel({ disposition: 'one-compartment' }, [
      'eliminationHalfLife',
      'vd',
      'bioavailability',
    ]); // missing ka; elimination + absorption defaulted
    const d = describeDerivedModel(derived, { sourceQuality: 'C' });
    expect(d.caveats.map((c) => c.code)).toEqual([
      'defaulted-axes',
      'missing-parameters',
      'weak-source-quality',
      'not-validated',
    ]);
  });
});

describe('CV-3c — inferred-parameters caveat', () => {
  const spotlessOral = () =>
    deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );

  it('discloses an inferred ka and grades the model down to C', () => {
    const d = describeDerivedModel(spotlessOral(), {
      sourceQuality: 'A',
      validationStatus: 'validated',
      inferredParameters: ['ka'],
    });
    expect(d.grade).toBe('C');
    expect(d.limitingFactor).toBe('parameterInference');
    expect(d.bandWideningCv).toBe(GRADE_BAND_WIDENING_CV.C);
    expect(d.caveats).toContainEqual({ code: 'inferred-parameters', parameters: ['ka'] });
  });

  it('keeps inferred and missing separate — an inferred value is not a missing one', () => {
    // The distinction the caveat exists for: a missing parameter shows no number, an inferred one
    // shows a number that reads like any other. Folding them together would hide that.
    const partial = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ['eliminationHalfLife', 'vd', 'ka'], // F absent from the catalog
    );
    const d = describeDerivedModel(partial, { inferredParameters: ['ka'] });
    const codes = d.caveats.map((c) => c.code);
    expect(codes).toContain('missing-parameters');
    expect(codes).toContain('inferred-parameters');
    expect(d.caveats).toContainEqual({ code: 'missing-parameters', parameters: ['bioavailability'] });
  });

  it('adds no caveat when nothing was inferred', () => {
    const d = describeDerivedModel(spotlessOral(), {
      sourceQuality: 'A',
      validationStatus: 'validated',
      inferredParameters: [],
    });
    expect(d.caveats).toEqual([]);
  });
});
