/**
 * CV-2a — derive a runnable model from a drug's DB declarations.
 *
 * `deriveModel` sits on top of CV-1a's `validateModelStructure` and adds the two things the
 * catalog derivation needs: the disclosed default policy (an unstated axis becomes linear
 * one-compartment, recorded as `defaulted`) and the runnability outcome (`modelable` vs
 * `not-modelable`, "missing stays missing"). A stated axis is never overridden; a stated-but-
 * unrecognized value composes to `not-modelable` rather than being replaced by the default.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveModel,
  MODEL_STRUCTURE_DEFAULTS,
  type ModelStructureDeclaration,
  type RequiredParam,
} from '../index';

// Parameters present for a fully-specified linear one-compartment oral drug.
const ORAL_1C_PARAMS: RequiredParam[] = ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'];

describe('CV-2a — deriveModel default policy', () => {
  it('defaults every unstated axis to linear one-compartment, flagged', () => {
    const d = deriveModel({}, ORAL_1C_PARAMS);
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('one-compartment-first-order');
    expect(d.structure).toEqual(MODEL_STRUCTURE_DEFAULTS);
    expect(d.axisProvenance).toEqual({
      disposition: 'defaulted',
      elimination: 'defaulted',
      absorption: 'defaulted',
    });
    expect(d.defaulted).toBe(true);
  });

  it('keeps a stated axis and marks only the unstated ones defaulted', () => {
    const d = deriveModel({ disposition: 'two-compartment' }, [
      'ka',
      'eliminationHalfLife',
      'k12',
      'k21',
      'centralVolume',
      'bioavailability',
    ]);
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('two-compartment-first-order');
    expect(d.axisProvenance.disposition).toBe('asserted');
    expect(d.axisProvenance.elimination).toBe('defaulted');
    expect(d.axisProvenance.absorption).toBe('defaulted');
    expect(d.defaulted).toBe(true);
  });

  it('flags nothing as defaulted when all three axes are stated', () => {
    const d = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'bolus' },
      ['eliminationHalfLife', 'vd'],
    );
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('iv-one-compartment');
    expect(d.defaulted).toBe(false);
    expect(d.axisProvenance).toEqual({
      disposition: 'asserted',
      elimination: 'asserted',
      absorption: 'asserted',
    });
  });
});

describe('CV-2a — deriveModel runnability outcome', () => {
  it('reports missing parameters without withholding a modelable family', () => {
    const d = deriveModel({}, ['vd']); // missing ka, eliminationHalfLife, bioavailability
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('one-compartment-first-order');
    expect(d.missingParameters).toEqual(
      expect.arrayContaining(['ka', 'eliminationHalfLife', 'bioavailability']),
    );
    expect(d.missingParameters).not.toContain('vd');
  });

  it('is not-modelable for an unsupported axis combination', () => {
    // two-compartment is modelled only with first-order absorption.
    const d = deriveModel(
      { disposition: 'two-compartment', absorption: 'zero-order' },
      ORAL_1C_PARAMS,
    );
    expect(d.outcome).toBe('not-modelable');
    expect(d.family).toBeUndefined();
    expect(d.reason).toMatch(/two-compartment/);
  });

  it('is not-modelable for a transit absorption (no engine family yet)', () => {
    const d = deriveModel({ absorption: 'transit' }, ORAL_1C_PARAMS);
    expect(d.outcome).toBe('not-modelable');
    expect(d.reason).toMatch(/transit/i);
  });

  it('does not default a stated-but-unrecognized axis value', () => {
    const d = deriveModel(
      { disposition: 'three-compartment' as unknown as ModelStructureDeclaration['disposition'] },
      ORAL_1C_PARAMS,
    );
    expect(d.outcome).toBe('not-modelable');
    // The bad value is kept (not silently replaced by the default), so it surfaces as a gap.
    expect(d.structure.disposition).toBe('three-compartment');
    expect(d.axisProvenance.disposition).toBe('asserted');
    expect(d.reason).toMatch(/disposition/);
  });

  it('is not-modelable for a CL/V declaration with no coherent basis', () => {
    // clv-structural composes (one-compartment + first-order absorption) but needs a coherent
    // CL/Vc identifiability basis to be runnable; without opts it cannot be constructed.
    const d = deriveModel({ elimination: 'clv-structural' }, ['ka', 'clearance', 'centralVolume']);
    expect(d.outcome).toBe('not-modelable');
    expect(d.reason).toMatch(/basis/i);
  });

  it('is not-modelable when a forbidden parameter is present (contradictory declaration)', () => {
    // Apparent-extravascular CL/V folds F into Vc/F, so a separately-declared bioavailability is
    // forbidden. Running it would silently drop the declared F — surface the contradiction instead.
    const d = deriveModel(
      { elimination: 'clv-structural' },
      ['ka', 'clearance', 'centralVolume', 'bioavailability'],
      { clvClearanceBasis: 'apparent-extravascular', clvVolumeBasis: 'apparent-extravascular' },
    );
    expect(d.outcome).toBe('not-modelable');
    expect(d.family).toBeUndefined();
    expect(d.forbiddenParameters).toEqual(['bioavailability']);
    expect(d.reason).toMatch(/forbid/i);
  });

  it('is modelable for a CL/V declaration with a coherent absolute basis', () => {
    const d = deriveModel(
      { elimination: 'clv-structural' },
      ['ka', 'clearance', 'centralVolume', 'bioavailability'],
      { clvClearanceBasis: 'iv-anchored', clvVolumeBasis: 'iv-anchored' },
    );
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('one-compartment-clv');
    expect(d.missingParameters).toBeUndefined();
  });

  it('requires an infusion duration for an IV infusion', () => {
    const withoutDuration = deriveModel(
      { absorption: 'iv-infusion' },
      ['eliminationHalfLife', 'vd'],
    );
    expect(withoutDuration.outcome).toBe('modelable');
    expect(withoutDuration.missingParameters).toEqual(['infusionDuration']);
    const withDuration = deriveModel(
      { absorption: 'iv-infusion' },
      ['eliminationHalfLife', 'vd', 'infusionDuration'],
    );
    expect(withDuration.missingParameters).toBeUndefined();
  });

  it('ignores an extra absorption-phase param the family does not use (shared-pool safe)', () => {
    // `deriveModel` is family-wide and shared by the shape-keyed resolver, whose sibling shapes share
    // one parameter pool. A `ka` present for a first-order sibling must NOT sink the IV/zero-order
    // shape here — it is harmlessly ignored (the route-keyed resolver enforces a route-SCOPED ka
    // contradiction instead). Same for a pooled F on IV.
    const ivWithKa = deriveModel(
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'bolus' },
      ['eliminationHalfLife', 'vd', 'ka', 'bioavailability'],
    );
    expect(ivWithKa.outcome).toBe('modelable');
    expect(ivWithKa.family).toBe('iv-one-compartment');
    expect(ivWithKa.forbiddenParameters).toBeUndefined();

    const zeroOrderWithKa = deriveModel(
      { absorption: 'zero-order' },
      ['eliminationHalfLife', 'vd', 'zeroOrderDuration', 'bioavailability', 'ka'],
    );
    expect(zeroOrderWithKa.outcome).toBe('modelable');
    expect(zeroOrderWithKa.family).toBe('one-compartment-zero-order');
  });
});
