/**
 * CV-1a — model-structure axes → engine family.
 *
 * The compose map is the single authority on which (disposition × elimination × absorption)
 * combinations the engine can run, and what each resulting family requires. Every supported
 * combination must map to the right family; every combination the engine does not implement
 * must resolve to `unsupported` (missing stays missing), never the nearest family.
 */
import { describe, it, expect } from 'vitest';
import {
  composeModelFamily,
  requiredParametersFor,
  forbiddenParametersFor,
  validateModelStructure,
  isIvAbsorptionKind,
  absorptionHasFirstOrderRate,
  absorptionCoherentWithRoute,
  DISPOSITION_KINDS,
  ELIMINATION_KINDS,
  type ModelStructure,
  type RequiredParam,
} from '../model-structure';
import type { ModelFamily } from '../types';

const struct = (
  disposition: ModelStructure['disposition'],
  elimination: ModelStructure['elimination'],
  absorption: ModelStructure['absorption'],
): ModelStructure => ({ disposition, elimination, absorption });

describe('CV-1a — composeModelFamily (supported combinations)', () => {
  const cases: Array<[ModelStructure, ModelFamily]> = [
    [struct('one-compartment', 'first-order', 'bolus'), 'iv-one-compartment'],
    [struct('one-compartment', 'first-order', 'iv-infusion'), 'iv-one-compartment'],
    [struct('one-compartment', 'first-order', 'first-order'), 'one-compartment-first-order'],
    [struct('one-compartment', 'first-order', 'zero-order'), 'one-compartment-zero-order'],
    [struct('one-compartment', 'first-order', 'mixed'), 'one-compartment-mixed-order'],
    [struct('one-compartment', 'clv-structural', 'first-order'), 'one-compartment-clv'],
    [struct('two-compartment', 'first-order', 'first-order'), 'two-compartment-first-order'],
    [struct('one-compartment', 'michaelis-menten', 'first-order'), 'michaelis-menten'],
  ];
  for (const [s, family] of cases) {
    it(`${s.disposition} + ${s.elimination} + ${s.absorption} → ${family}`, () => {
      const r = composeModelFamily(s);
      expect(r.supported).toBe(true);
      expect(r.supported && r.family).toBe(family);
    });
  }
});

describe('CV-1a — composeModelFamily (unsupported combinations resolve, not force)', () => {
  const unsupported: ModelStructure[] = [
    struct('two-compartment', 'michaelis-menten', 'first-order'),
    struct('two-compartment', 'first-order', 'zero-order'),
    struct('two-compartment', 'first-order', 'mixed'),
    struct('two-compartment', 'first-order', 'bolus'),
    struct('two-compartment', 'clv-structural', 'first-order'),
    struct('one-compartment', 'clv-structural', 'bolus'),
    struct('one-compartment', 'clv-structural', 'zero-order'),
    struct('one-compartment', 'michaelis-menten', 'mixed'),
    struct('one-compartment', 'michaelis-menten', 'bolus'),
    struct('one-compartment', 'first-order', 'transit'),
    struct('two-compartment', 'michaelis-menten', 'transit'),
  ];
  for (const s of unsupported) {
    it(`${s.disposition} + ${s.elimination} + ${s.absorption} → unsupported (with reason)`, () => {
      const r = composeModelFamily(s);
      expect(r.supported).toBe(false);
      expect(r.supported === false && r.reason.length).toBeGreaterThan(0);
    });
  }

  it('flags transit absorption as the specific SC-4B gap', () => {
    for (const disposition of DISPOSITION_KINDS) {
      for (const elimination of ELIMINATION_KINDS) {
        const r = composeModelFamily(struct(disposition, elimination, 'transit'));
        expect(r.supported).toBe(false);
        expect(r.supported === false && r.reason).toContain('SC-4B');
      }
    }
  });

  it('keeps the uncontracted two-compartment CL/V/Q form unsupported', () => {
    const r = composeModelFamily(
      struct('two-compartment', 'clv-structural', 'first-order'),
    );
    expect(r).toEqual({
      supported: false,
      reason:
        'the CL/V structural form is modelled only for one-compartment disposition with first-order absorption, not two-compartment + first-order absorption',
    });
  });

  it('rejects an unrecognized axis value instead of falling through to a default', () => {
    // A persisted / future vocabulary value must not slip through the first-order /
    // one-compartment fallback as a supported family.
    const bad = [
      { disposition: 'three-compartment', elimination: 'first-order', absorption: 'first-order' },
      { disposition: 'one-compartment', elimination: 'flip-flop', absorption: 'first-order' },
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'colonic' },
      { disposition: undefined, elimination: 'first-order', absorption: 'first-order' },
    ] as unknown as ModelStructure[];
    for (const s of bad) {
      const r = composeModelFamily(s);
      expect(r.supported).toBe(false);
      expect(r.supported === false && r.reason).toContain('unrecognized');
    }
  });
});

describe('CV-1a — requiredParametersFor', () => {
  it('couples a saturable family to Vmax/Km, not a half-life-only set', () => {
    const req = requiredParametersFor('michaelis-menten');
    expect(req).toContain('vmax');
    expect(req).toContain('km');
  });

  it('couples two-compartment to the inter-compartmental rates and central V1 (not generic vd)', () => {
    const req = requiredParametersFor('two-compartment-first-order');
    expect(req).toEqual(expect.arrayContaining(['k12', 'k21', 'ka', 'centralVolume', 'bioavailability']));
    expect(req).not.toContain('vd'); // V1 is central volume, distinct from a generic steady-state Vd
  });

  it('requires the nominal half-life for Michaelis–Menten (mandatory on the route params)', () => {
    expect(requiredParametersFor('michaelis-menten')).toContain('eliminationHalfLife');
  });

  it('requires the parent volume + both molar masses for parent/metabolite', () => {
    const req = requiredParametersFor('parent-metabolite-first-order');
    expect(req).toEqual(
      expect.arrayContaining(['vd', 'parentMolarMass', 'metaboliteMolarMass']),
    );
  });

  it('makes CL/V bioavailability basis-dependent (required absolute, forbidden apparent)', () => {
    const absolute = { clvClearanceBasis: 'absolute-f-supported', clvVolumeBasis: 'iv-anchored' } as const;
    const apparent = {
      clvClearanceBasis: 'apparent-extravascular',
      clvVolumeBasis: 'apparent-extravascular',
    } as const;
    // No bases: F is neither required (would false-flag the common apparent case) ...
    expect(requiredParametersFor('one-compartment-clv')).not.toContain('bioavailability');
    // ... coherent absolute pair: F is required ...
    expect(requiredParametersFor('one-compartment-clv', absolute)).toContain('bioavailability');
    // ... coherent apparent pair: F is forbidden (folded into Vc/F).
    expect(requiredParametersFor('one-compartment-clv', apparent)).not.toContain('bioavailability');
    expect(forbiddenParametersFor('one-compartment-clv', apparent)).toContain('bioavailability');
    expect(forbiddenParametersFor('one-compartment-clv', absolute)).toEqual([]);
    // A mixed-class pair yields neither a required nor a forbidden F (it is an error, flagged by
    // validateModelStructure).
    const mixed = { clvClearanceBasis: 'apparent-extravascular', clvVolumeBasis: 'iv-anchored' } as const;
    expect(requiredParametersFor('one-compartment-clv', mixed)).not.toContain('bioavailability');
    expect(forbiddenParametersFor('one-compartment-clv', mixed)).toEqual([]);
  });

  it('does not forbid ka family-wide (the shared-pool resolver would break)', () => {
    // The ka-on-IV/zero-order contradiction is enforced route-SCOPED (route-keyed resolver), not in
    // this family-wide validator the shape-keyed shared-pool resolver also uses.
    expect(forbiddenParametersFor('iv-one-compartment')).toEqual([]);
    expect(forbiddenParametersFor('one-compartment-zero-order')).toEqual([]);
    expect(forbiddenParametersFor('one-compartment-first-order')).toEqual([]);
  });

  it('returns a fresh array (callers cannot mutate the table)', () => {
    const a = requiredParametersFor('michaelis-menten');
    a.push('ka');
    expect(requiredParametersFor('michaelis-menten')).not.toContain(
      // the pushed duplicate must not leak back into the table
      undefined as unknown as RequiredParam,
    );
    expect(requiredParametersFor('michaelis-menten').filter((p) => p === 'ka')).toHaveLength(1);
  });
});

describe('CV-2c — absorption input predicates', () => {
  it('classifies the IV inputs vs the extravascular ones', () => {
    expect(isIvAbsorptionKind('bolus')).toBe(true);
    expect(isIvAbsorptionKind('iv-infusion')).toBe(true);
    for (const a of ['first-order', 'zero-order', 'mixed', 'transit'] as const) {
      expect(isIvAbsorptionKind(a)).toBe(false);
    }
  });

  it('marks only first-order and mixed inputs as carrying a first-order rate (ka)', () => {
    expect(absorptionHasFirstOrderRate('first-order')).toBe(true);
    expect(absorptionHasFirstOrderRate('mixed')).toBe(true);
    for (const a of ['bolus', 'iv-infusion', 'zero-order', 'transit'] as const) {
      expect(absorptionHasFirstOrderRate(a)).toBe(false);
    }
  });

  it('holds an iv route to IV inputs and an extravascular route to extravascular inputs', () => {
    expect(absorptionCoherentWithRoute('iv', 'bolus')).toBe(true);
    expect(absorptionCoherentWithRoute('iv', 'first-order')).toBe(false);
    expect(absorptionCoherentWithRoute('oral', 'first-order')).toBe(true);
    expect(absorptionCoherentWithRoute('oral', 'bolus')).toBe(false);
  });
});

describe('CV-1a — validateModelStructure', () => {
  it('is supported with no missing params when all required roles are present', () => {
    const s = struct('one-compartment', 'first-order', 'first-order');
    const present: RequiredParam[] = ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'];
    const v = validateModelStructure(s, present);
    expect(v.supported).toBe(true);
    expect(v.family).toBe('one-compartment-first-order');
    expect(v.missingParameters).toBeUndefined();
  });

  it('is supported but lists the missing required params (default+grade policy decides)', () => {
    const s = struct('one-compartment', 'michaelis-menten', 'first-order');
    const v = validateModelStructure(s, ['ka', 'vd', 'bioavailability']); // no Vmax/Km
    expect(v.supported).toBe(true);
    expect(v.family).toBe('michaelis-menten');
    expect(v.missingParameters).toEqual(expect.arrayContaining(['vmax', 'km']));
  });

  it('distinguishes an IV infusion (requires a duration) from a bolus (does not)', () => {
    const oneComp = 'one-compartment' as const;
    // Bolus: iv-one-compartment complete with just half-life + Vd (no infusion duration).
    const bolus = validateModelStructure(struct(oneComp, 'first-order', 'bolus'), [
      'eliminationHalfLife',
      'vd',
    ]);
    expect(bolus.family).toBe('iv-one-compartment');
    expect(bolus.missingParameters).toBeUndefined();
    // IV infusion: same params but missing the constant-rate duration → incomplete.
    const infusionMissing = validateModelStructure(struct(oneComp, 'first-order', 'iv-infusion'), [
      'eliminationHalfLife',
      'vd',
    ]);
    expect(infusionMissing.family).toBe('iv-one-compartment');
    expect(infusionMissing.missingParameters).toEqual(['infusionDuration']);
    // ...and complete once the duration is present. Neither IV input requires bioavailability.
    const infusionOk = validateModelStructure(struct(oneComp, 'first-order', 'iv-infusion'), [
      'eliminationHalfLife',
      'vd',
      'infusionDuration',
    ]);
    expect(infusionOk.missingParameters).toBeUndefined();
  });

  it('is unsupported (with a reason, no family) for a combination the engine cannot run', () => {
    const v = validateModelStructure(struct('two-compartment', 'michaelis-menten', 'first-order'), []);
    expect(v.supported).toBe(false);
    expect(v.family).toBeUndefined();
    expect(v.reason && v.reason.length).toBeGreaterThan(0);
  });

  it('accepts an apparent-extravascular CL/V model without a separate F, and flags a forbidden one', () => {
    const clv = struct('one-compartment', 'clv-structural', 'first-order');
    const apparent = {
      clvClearanceBasis: 'apparent-extravascular',
      clvVolumeBasis: 'apparent-extravascular',
    } as const;
    // Present ka/CL/Vc, no F → complete for the apparent pair (F is folded into Vc/F).
    const ok = validateModelStructure(clv, ['ka', 'clearance', 'centralVolume'], apparent);
    expect(ok.supported).toBe(true);
    expect(ok.missingParameters).toBeUndefined();
    expect(ok.forbiddenParameters).toBeUndefined();
    expect(ok.basisError).toBeUndefined();
    // Declaring F on the apparent pair is forbidden → flagged.
    const bad = validateModelStructure(
      clv,
      ['ka', 'clearance', 'centralVolume', 'bioavailability'],
      apparent,
    );
    expect(bad.forbiddenParameters).toEqual(['bioavailability']);
    // On a coherent absolute pair the same F-less declaration is incomplete.
    const abs = validateModelStructure(clv, ['ka', 'clearance', 'centralVolume'], {
      clvClearanceBasis: 'absolute-f-supported',
      clvVolumeBasis: 'iv-anchored',
    });
    expect(abs.missingParameters).toEqual(['bioavailability']);
  });

  it('reports a CL/V declaration without a coherent primitive basis pair as incomplete', () => {
    const clv = struct('one-compartment', 'clv-structural', 'first-order');
    const params: RequiredParam[] = ['ka', 'clearance', 'centralVolume'];
    // No bases → basisError (the engine cannot construct the route).
    expect(validateModelStructure(clv, params).basisError).toBeTruthy();
    // A non-primitive `derived` basis is rejected.
    expect(
      validateModelStructure(clv, params, {
        clvClearanceBasis: 'derived',
        clvVolumeBasis: 'derived',
      }).basisError,
    ).toBeTruthy();
    // A MIXED-class pair (apparent CL/F with an IV-anchored Vc) is rejected — the key r4 case.
    expect(
      validateModelStructure(clv, params, {
        clvClearanceBasis: 'apparent-extravascular',
        clvVolumeBasis: 'iv-anchored',
      }).basisError,
    ).toBeTruthy();
    // A coherent primitive pair clears it.
    expect(
      validateModelStructure(clv, params, {
        clvClearanceBasis: 'apparent-extravascular',
        clvVolumeBasis: 'apparent-extravascular',
      }).basisError,
    ).toBeUndefined();
    // A non-clv family never carries a basis error.
    expect(
      validateModelStructure(struct('one-compartment', 'first-order', 'bolus'), []).basisError,
    ).toBeUndefined();
  });
});
