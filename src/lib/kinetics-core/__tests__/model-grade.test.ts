/**
 * CV-3a — grade a derived model (weakest-link A–D).
 *
 * The overall grade is the WORST of five factor sub-grades (structure, completeness,
 * parameterInference, sourceQuality, validation), with the limiting factor named. `A` is earned only by SC-7A validation; a
 * `not-modelable` derivation is `ungraded`. Everything modelable renders a curve (min render grade
 * `D`).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveModel,
  gradeDerivedModel,
  rendersCurve,
  gradeBandWidening,
  GRADE_BAND_WIDENING_CV,
  type RequiredParam,
} from '../index';

const ORAL_1C_PARAMS: RequiredParam[] = ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'];

describe('CV-3a — gradeDerivedModel weakest-link', () => {
  it('grades a fully-asserted, complete, validated, well-sourced model A', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    const graded = gradeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' });
    expect(graded.outcome).toBe('graded');
    expect(graded.grade).toBe('A');
    expect(graded.factors).toHaveLength(5);
    expect(rendersCurve(graded)).toBe(true);
  });

  it('caps at B on validation alone when a complete, asserted model is only literature-derived', () => {
    // A is earned by validation: an unvalidated (literature-derived) model cannot exceed B.
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    const graded = gradeDerivedModel(derived, { sourceQuality: 'A' }); // validation absent → literature-derived
    expect(graded.grade).toBe('B');
    expect(graded.limitingFactor).toBe('validation');
  });

  it('lets the weakest factor set the grade and names it (defaulted structure)', () => {
    // Every axis defaulted → structure D, even though the model is otherwise strong.
    const derived = deriveModel({}, ORAL_1C_PARAMS); // all axes defaulted, complete
    const graded = gradeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' });
    expect(graded.grade).toBe('D');
    expect(graded.limitingFactor).toBe('structure');
    const structure = graded.factors.find((f) => f.factor === 'structure');
    expect(structure?.grade).toBe('D');
  });

  it('downgrades on missing parameters (completeness factor)', () => {
    // One axis asserted (disposition), rest defaulted → 2 defaulted → structure C; ka missing →
    // completeness B. Validated + A source. Weakest link is the two defaulted axes (C).
    const derived = deriveModel({ disposition: 'one-compartment' }, [
      'eliminationHalfLife',
      'vd',
      'bioavailability',
    ]); // missing ka
    const graded = gradeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' });
    expect(graded.factors.find((f) => f.factor === 'completeness')?.grade).toBe('B');
    expect(graded.factors.find((f) => f.factor === 'structure')?.grade).toBe('C');
    expect(graded.grade).toBe('C');
    expect(graded.limitingFactor).toBe('structure');
  });

  it('grades source quality conservatively (C) when not assessed', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    const graded = gradeDerivedModel(derived, { validationStatus: 'validated' }); // no sourceQuality
    const sq = graded.factors.find((f) => f.factor === 'sourceQuality');
    expect(sq?.grade).toBe('C');
    expect(graded.grade).toBe('C');
    expect(graded.limitingFactor).toBe('sourceQuality');
  });

  it('reflects a weak (toy) validation status', () => {
    const derived = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
    const graded = gradeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'toy' });
    expect(graded.grade).toBe('D');
    expect(graded.limitingFactor).toBe('validation');
  });

  it('resolves ties to the first factor in evaluation order', () => {
    // structure C (2 defaulted) and sourceQuality C tie; structure is evaluated first.
    const derived = deriveModel({ disposition: 'one-compartment' }, [
      'ka',
      'eliminationHalfLife',
      'vd',
      'bioavailability',
    ]); // complete, 2 axes defaulted
    const graded = gradeDerivedModel(derived, { sourceQuality: 'C', validationStatus: 'validated' });
    expect(graded.grade).toBe('C');
    expect(graded.limitingFactor).toBe('structure');
  });
});

describe('CV-3a — ungraded and rendering gate', () => {
  it('is ungraded with no curve for a not-modelable derivation', () => {
    const derived = deriveModel({ absorption: 'transit' }, ORAL_1C_PARAMS);
    expect(derived.outcome).toBe('not-modelable');
    const graded = gradeDerivedModel(derived);
    expect(graded.outcome).toBe('ungraded');
    expect(graded.grade).toBeUndefined();
    expect(graded.factors).toEqual([]);
    expect(graded.reason).toMatch(/transit/i);
    expect(rendersCurve(graded)).toBe(false);
  });

  it('renders every gradable model at the default min grade (D)', () => {
    const derived = deriveModel({}, ['vd']); // fully defaulted, ka/t½/F missing → D somewhere
    const graded = gradeDerivedModel(derived);
    expect(graded.outcome).toBe('graded');
    expect(rendersCurve(graded)).toBe(true);
  });

  it('a tightened gate (min C) hides a D-grade curve', () => {
    const derived = deriveModel({}, ORAL_1C_PARAMS); // all axes defaulted → structure D
    const graded = gradeDerivedModel(derived, { sourceQuality: 'A', validationStatus: 'validated' });
    expect(graded.grade).toBe('D');
    expect(rendersCurve(graded, 'C')).toBe(false);
    expect(rendersCurve(graded, 'D')).toBe(true);
  });
});

describe('CV-3b — gradeBandWidening', () => {
  const complete = (): ReturnType<typeof gradeDerivedModel> =>
    gradeDerivedModel(
      deriveModel(
        { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
        ORAL_1C_PARAMS,
      ),
      { sourceQuality: 'A', validationStatus: 'validated' },
    );

  it('adds no widening for an A grade (nothing to disclose)', () => {
    const graded = complete();
    expect(graded.grade).toBe('A');
    expect(gradeBandWidening(graded)).toBeNull();
  });

  it('widens by the tabled CV, increasing as the grade falls, and names the limiting factor', () => {
    // B: complete + asserted, only literature-derived → validation caps at B.
    const b = gradeDerivedModel(
      deriveModel(
        { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
        ORAL_1C_PARAMS,
      ),
      { sourceQuality: 'A' },
    );
    expect(b.grade).toBe('B');
    const bw = gradeBandWidening(b);
    expect(bw?.proportionalCv).toBe(GRADE_BAND_WIDENING_CV.B);
    expect(bw?.rationale).toMatch(/grade B/);
    expect(bw?.rationale).toMatch(/validation/);

    // D: all axes defaulted → structure D.
    const d = gradeDerivedModel(deriveModel({}, ORAL_1C_PARAMS), {
      sourceQuality: 'A',
      validationStatus: 'validated',
    });
    expect(d.grade).toBe('D');
    const dw = gradeBandWidening(d);
    expect(dw?.proportionalCv).toBe(GRADE_BAND_WIDENING_CV.D);
    // Widening grows monotonically as the grade worsens.
    expect(dw!.proportionalCv).toBeGreaterThan(bw!.proportionalCv);
  });

  it('returns null for an ungraded (not-modelable) derivation', () => {
    const graded = gradeDerivedModel(deriveModel({ absorption: 'transit' }, ORAL_1C_PARAMS));
    expect(graded.outcome).toBe('ungraded');
    expect(gradeBandWidening(graded)).toBeNull();
  });

  it('keeps the widening CVs ordered A ≤ B ≤ C ≤ D', () => {
    const { A, B, C, D } = GRADE_BAND_WIDENING_CV;
    expect(A).toBe(0);
    expect(A).toBeLessThanOrEqual(B);
    expect(B).toBeLessThanOrEqual(C);
    expect(C).toBeLessThanOrEqual(D);
  });
});

describe('CV-3a — parameterInference factor', () => {
  const perfect = () =>
    deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
      ORAL_1C_PARAMS,
    );
  const otherwiseSpotless = { sourceQuality: 'A', validationStatus: 'validated' } as const;

  it('grades A when nothing was inferred', () => {
    const graded = gradeDerivedModel(perfect(), otherwiseSpotless);
    const factor = graded.factors.find((f) => f.factor === 'parameterInference');
    expect(factor?.grade).toBe('A');
    expect(graded.grade).toBe('A');
  });

  it('an empty inferred list is the same as none', () => {
    const graded = gradeDerivedModel(perfect(), { ...otherwiseSpotless, inferredParameters: [] });
    expect(graded.factors.find((f) => f.factor === 'parameterInference')?.grade).toBe('A');
    expect(graded.grade).toBe('A');
  });

  it('caps an otherwise-spotless model at C on a single inferred parameter', () => {
    // The point of the factor: an inferred ka cannot be laundered into an A model by everything
    // else being perfect. C is the exploratory tier, and that is what this model is.
    const graded = gradeDerivedModel(perfect(), {
      ...otherwiseSpotless,
      inferredParameters: ['ka'],
    });
    expect(graded.grade).toBe('C');
    expect(graded.limitingFactor).toBe('parameterInference');
    expect(graded.factors.find((f) => f.factor === 'parameterInference')?.detail).toMatch(
      /inferred from another stored observable/,
    );
  });

  it('drops to D on two or more inferred parameters', () => {
    const graded = gradeDerivedModel(perfect(), {
      ...otherwiseSpotless,
      inferredParameters: ['ka', 'bioavailability'],
    });
    expect(graded.grade).toBe('D');
    expect(graded.limitingFactor).toBe('parameterInference');
  });

  it('does not override a worse factor', () => {
    // Weakest-link: an inference caps at C, but a model already at D stays D and keeps naming the
    // factor that got it there.
    const derived = deriveModel({}, []);
    const graded = gradeDerivedModel(derived, {
      ...otherwiseSpotless,
      inferredParameters: ['ka'],
    });
    expect(graded.grade).toBe('D');
    expect(graded.limitingFactor).toBe('structure');
  });

  it('widens bands like any other C', () => {
    const graded = gradeDerivedModel(perfect(), {
      ...otherwiseSpotless,
      inferredParameters: ['ka'],
    });
    expect(gradeBandWidening(graded)?.proportionalCv).toBe(GRADE_BAND_WIDENING_CV.C);
  });
});
