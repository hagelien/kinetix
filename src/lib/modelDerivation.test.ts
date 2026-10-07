/**
 * CV-2b — bridge the drug catalog to the engine's model derivation.
 *
 * Covers the two responsibilities of `modelDerivation.ts`: mapping catalog parameter ids onto
 * engine roles (a direct 1:1 for the four quantities the catalog holds; NO manufactured `ka`), and
 * resolving a drug's stored axis value SETS into one derivation per absorption input shape (with a
 * molecule-axis disagreement surfaced as `not-modelable`, never silently resolved).
 */
import { describe, it, expect } from 'vitest';
import {
  applyCautiousDefaults,
  CAUTIOUS_DEFAULT_BIOAVAILABILITY,
  applyKaInference,
  parameterRoleFor,
  deriveDrugModel,
  tmaxHoursFrom,
  resolveDrugModels,
  resolveDrugModelsByRoute,
  canonicalUnitFor,
  toAssemblyValues,
  toAssemblyRanges,
  inferredKaRange,
  inferVdScaling,
  derivedDefinitionMetadata,
  MODEL_STRUCTURE_AXIS_PARAMETERS,
  isRouteAssemblyParameter,
} from './modelDerivation';
import type { DrugParameterId } from './drugParameters';

describe('CV-2b — parameterRoleFor', () => {
  it('keeps only ka and bioavailability in route value pools', () => {
    expect(isRouteAssemblyParameter('ka')).toBe(true);
    expect(isRouteAssemblyParameter('bioavailability')).toBe(true);
    expect(isRouteAssemblyParameter('halfLife')).toBe(false);
  });
  it('maps the directly-stored catalog quantities onto their engine roles', () => {
    expect(parameterRoleFor('halfLife')).toBe('eliminationHalfLife');
    expect(parameterRoleFor('volumeOfDistribution')).toBe('vd');
    expect(parameterRoleFor('clearance')).toBe('clearance');
    expect(parameterRoleFor('bioavailability')).toBe('bioavailability');
    // CV-2c: ka now has a route-scoped catalog home and maps to the engine's ka role.
    expect(parameterRoleFor('ka')).toBe('ka');
  });

  it('does NOT manufacture ka from tmax — the catalog cannot supply the absorption rate', () => {
    // tmax is the time of peak, not an absorption half-life; ka (kaPerHour) is reviewer-authored
    // per route with no catalog field. So tmax feeds no engine role and ka stays missing.
    expect(parameterRoleFor('tmax')).toBeNull();
  });

  it('has no engine role for non-structural catalog parameters', () => {
    for (const id of [
      'proteinBinding',
      'toxicConcentration',
      'therapeuticDose',
      'logP',
      'pKa',
      'molecularWeight',
    ] as DrugParameterId[]) {
      expect(parameterRoleFor(id)).toBeNull();
    }
  });

  it('points each axis at its catalog enum parameter', () => {
    expect(MODEL_STRUCTURE_AXIS_PARAMETERS).toEqual({
      disposition: 'dispositionModel',
      elimination: 'eliminationModel',
      absorption: 'absorptionModel',
    });
  });
});

describe('CV-2b — deriveDrugModel role mapping', () => {
  it('fully parameterises an IV one-compartment drug from halfLife + vd', () => {
    const d = deriveDrugModel({
      declaration: { absorption: 'bolus' },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('iv-one-compartment');
    expect(d.missingParameters).toBeUndefined();
  });

  it('leaves ka missing for an oral first-order drug (no catalog absorption rate)', () => {
    // Even with tmax present, ka is not manufactured — it stays missing and grades down.
    const d = deriveDrugModel({
      declaration: {}, // defaults → linear one-compartment first-order
      presentParameters: ['halfLife', 'volumeOfDistribution', 'bioavailability', 'tmax'],
    });
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('one-compartment-first-order');
    expect(d.missingParameters).toEqual(['ka']);
  });

  it('reports the roles a family needs but the catalog cannot supply as missing', () => {
    // A two-compartment drug needs ka/k12/k21/centralVolume, none of which the catalog stores.
    const d = deriveDrugModel({
      declaration: { disposition: 'two-compartment' },
      presentParameters: ['halfLife', 'volumeOfDistribution', 'bioavailability'],
    });
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('two-compartment-first-order');
    expect(d.missingParameters).toEqual(
      expect.arrayContaining(['ka', 'k12', 'k21', 'centralVolume']),
    );
  });

  it('ignores catalog parameters with no engine role', () => {
    const d = deriveDrugModel({
      declaration: { absorption: 'bolus' },
      presentParameters: ['halfLife', 'volumeOfDistribution', 'toxicConcentration', 'logP', 'tmax'],
    });
    expect(d.outcome).toBe('modelable');
    expect(d.family).toBe('iv-one-compartment');
    expect(d.missingParameters).toBeUndefined();
  });
});

describe('CV-2b — resolveDrugModels per-shape resolution', () => {
  const PRESENT: DrugParameterId[] = ['halfLife', 'volumeOfDistribution', 'bioavailability'];

  it('derives the single disclosed-default shape when no absorption is declared', () => {
    const models = resolveDrugModels({
      dispositionModels: [],
      eliminationModels: [],
      absorptionModels: [],
      presentParameters: PRESENT,
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.absorptionShape).toBeNull();
    expect(models[0]!.outcome).toBe('modelable');
    expect(models[0]!.family).toBe('one-compartment-first-order');
    expect(models[0]!.axisProvenance.absorption).toBe('defaulted');
    // ka has no catalog source, so the oral first-order default is incomplete.
    expect(models[0]!.missingParameters).toEqual(['ka']);
  });

  it('derives one model per distinct absorption shape, sharing the molecule axes', () => {
    const models = resolveDrugModels({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      absorptionModels: ['bolus', 'first-order'],
      presentParameters: PRESENT,
    });
    expect(models).toHaveLength(2);
    const byShape = new Map(models.map((m) => [m.absorptionShape, m]));
    // IV bolus into a one-compartment space is fully parameterised (needs only t½ + Vd).
    expect(byShape.get('bolus')!.family).toBe('iv-one-compartment');
    expect(byShape.get('bolus')!.missingParameters).toBeUndefined();
    // Oral first-order absorption is missing ka.
    expect(byShape.get('first-order')!.family).toBe('one-compartment-first-order');
    expect(byShape.get('first-order')!.missingParameters).toEqual(['ka']);
    expect(byShape.get('bolus')!.defaulted).toBe(false);
  });

  it('shares one parameter pool across shapes: a sibling shape ka does not sink the bolus shape', () => {
    // Regression guard: the shape-keyed resolver pools parameters across all shapes, so a `ka`
    // (needed by the first-order sibling) is shared with the bolus shape. It must NOT make the bolus
    // shape not-modelable — that `ka` belongs to the sibling and iv-one-compartment simply ignores
    // it. (The ka-vs-input contradiction is enforced only in the route-keyed resolver.)
    const models = resolveDrugModels({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      absorptionModels: ['bolus', 'first-order'],
      presentParameters: [...PRESENT, 'ka'],
    });
    const byShape = new Map(models.map((m) => [m.absorptionShape, m]));
    expect(byShape.get('bolus')!.outcome).toBe('modelable');
    expect(byShape.get('bolus')!.family).toBe('iv-one-compartment');
    expect(byShape.get('first-order')!.outcome).toBe('modelable');
    expect(byShape.get('first-order')!.family).toBe('one-compartment-first-order');
    expect(byShape.get('first-order')!.missingParameters).toBeUndefined();
  });

  it('collapses duplicate declarations of the same value to a single asserted shape', () => {
    const models = resolveDrugModels({
      dispositionModels: ['one-compartment', 'one-compartment'],
      eliminationModels: ['first-order'],
      absorptionModels: ['first-order', 'first-order'],
      presentParameters: PRESENT,
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.axisProvenance.disposition).toBe('asserted');
    expect(models[0]!.outcome).toBe('modelable');
  });

  it('is not-modelable on every shape when a molecule axis has conflicting declarations', () => {
    const models = resolveDrugModels({
      dispositionModels: ['one-compartment', 'two-compartment'],
      eliminationModels: [],
      absorptionModels: ['bolus', 'first-order'],
      presentParameters: PRESENT,
    });
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.outcome).toBe('not-modelable');
      expect(m.family).toBeUndefined();
      expect(m.reason).toMatch(/conflicting disposition/);
      // The conflicting axis was asserted (values disagree), not defaulted.
      expect(m.axisProvenance.disposition).toBe('asserted');
    }
  });

  it('surfaces an elimination conflict too', () => {
    const models = resolveDrugModels({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order', 'michaelis-menten'],
      absorptionModels: [],
      presentParameters: PRESENT,
    });
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.reason).toMatch(/conflicting elimination/);
  });

  it('is not-modelable for a shape whose absorption axis the engine does not model', () => {
    const models = resolveDrugModels({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      absorptionModels: ['transit'],
      presentParameters: PRESENT,
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.absorptionShape).toBe('transit');
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.reason).toMatch(/transit/i);
  });

  it('reports missing roles per shape without withholding the family', () => {
    const models = resolveDrugModels({
      dispositionModels: [],
      eliminationModels: [],
      absorptionModels: ['first-order'],
      presentParameters: ['volumeOfDistribution'], // missing ka, eliminationHalfLife, bioavailability
    });
    expect(models[0]!.outcome).toBe('modelable');
    expect(models[0]!.missingParameters).toEqual(
      expect.arrayContaining(['ka', 'eliminationHalfLife', 'bioavailability']),
    );
  });
});

describe('CV-2c — resolveDrugModelsByRoute per-route resolution', () => {
  const DRUG_LEVEL: DrugParameterId[] = ['halfLife', 'volumeOfDistribution'];

  it('yields no derivation when no route is declared (missing stays missing)', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: {},
      presentParameters: DRUG_LEVEL,
    });
    expect(models).toEqual([]);
  });

  it('offers a one-compartment fallback for an asserted two-compartment disposition', () => {
    // The catalog cannot supply k12/k21/central volume, so without a fallback a drug that gains a
    // cited two-compartment fact would lose its curve. The declared derivation is still primary.
    const [model] = resolveDrugModelsByRoute({
      dispositionModels: ['two-compartment'],
      eliminationModels: [],
      routes: { oral: { absorption: 'first-order', presentParameters: ['bioavailability'] } },
      presentParameters: DRUG_LEVEL,
    });
    expect(model!.family).toBe('two-compartment-first-order');
    expect(model!.dispositionFallback?.outcome).toBe('modelable');
    expect(model!.dispositionFallback?.family).toBe('one-compartment-first-order');
    expect(model!.dispositionFallback?.structure.disposition).toBe('one-compartment');
    // The drug DID declare a disposition, and the other axes keep their own provenance.
    expect(model!.dispositionFallback?.axisProvenance).toEqual({
      disposition: 'asserted',
      elimination: 'defaulted',
      absorption: 'asserted',
    });
  });

  it('offers no disposition fallback when there is nothing to simplify or the route is in conflict', () => {
    const fallbackFor = (dispositionModels: string[]) =>
      resolveDrugModelsByRoute({
        dispositionModels,
        eliminationModels: [],
        routes: { oral: { absorption: 'first-order' } },
        presentParameters: DRUG_LEVEL,
      })[0]!.dispositionFallback;
    expect(fallbackFor([])).toBeUndefined(); // unstated: the default already is one-compartment
    expect(fallbackFor(['one-compartment'])).toBeUndefined();
    // Unknown science must not masquerade as a supported family, and a contradiction stays one.
    expect(fallbackFor(['three-compartment'])).toBeUndefined();
    expect(fallbackFor(['one-compartment', 'two-compartment'])).toBeUndefined();
  });

  it('carries a route declaration’s provenance onto its derivation', () => {
    // A route the read adapter attributed rather than read must stay distinguishable all the way
    // to the grade record — the resolver is the only thing between the two.
    const models = resolveDrugModelsByRoute({
      dispositionModels: [],
      eliminationModels: [],
      routes: {
        oral: { provenance: 'attributed', presentParameters: ['bioavailability'] },
      },
      presentParameters: DRUG_LEVEL,
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('oral');
    expect(models[0]!.routeProvenance).toBe('attributed');
    // Attribution says nothing about the model shape: the axes default as they always would.
    expect(models[0]!.family).toBe('one-compartment-first-order');
  });

  it('defaults a route’s provenance to asserted', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { oral: { absorption: 'first-order' } },
      presentParameters: DRUG_LEVEL,
    });
    expect(models[0]!.routeProvenance).toBe('asserted');
  });

  it('derives one model per declared route, keyed by RouteId', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: {
        iv: { absorption: 'bolus' },
        oral: { absorption: 'first-order', presentParameters: ['bioavailability'] },
      },
      presentParameters: DRUG_LEVEL,
    });
    const byRoute = new Map(models.map((m) => [m.route, m]));
    // IV bolus fully parameterises from the drug-level t½ + Vd.
    expect(byRoute.get('iv')!.family).toBe('iv-one-compartment');
    expect(byRoute.get('iv')!.missingParameters).toBeUndefined();
    // Oral first-order carries its own bioavailability; only ka (no catalog source) is missing.
    expect(byRoute.get('oral')!.family).toBe('one-compartment-first-order');
    expect(byRoute.get('oral')!.missingParameters).toEqual(['ka']);
  });

  it('keeps two routes that share a shape distinct via route-specific parameters', () => {
    // Both routes are first-order, but bioavailability is declared only for the oral route — so the
    // two no longer collapse (the shape-keyed resolver would have merged them into one entry).
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: {
        oral: { absorption: 'first-order', presentParameters: ['bioavailability'] },
        intranasal: { absorption: 'first-order' },
      },
      presentParameters: DRUG_LEVEL,
    });
    expect(models).toHaveLength(2);
    const byRoute = new Map(models.map((m) => [m.route, m]));
    // Oral has F; only ka is missing.
    expect(byRoute.get('oral')!.missingParameters).toEqual(['ka']);
    // Intranasal lacks its own F, so both ka and bioavailability are missing.
    expect(byRoute.get('intranasal')!.missingParameters).toEqual(
      expect.arrayContaining(['ka', 'bioavailability']),
    );
  });

  it('processes routes in a stable sorted order', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { oral: { absorption: 'first-order' }, intranasal: { absorption: 'first-order' }, iv: { absorption: 'bolus' } },
      presentParameters: DRUG_LEVEL,
    });
    expect(models.map((m) => m.route)).toEqual(['intranasal', 'iv', 'oral']);
  });

  it('applies the disclosed default when a route declares no absorption shape', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: [],
      eliminationModels: [],
      routes: { oral: {} },
      presentParameters: DRUG_LEVEL,
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('oral');
    expect(models[0]!.absorptionShape).toBeNull();
    expect(models[0]!.axisProvenance.absorption).toBe('defaulted');
    expect(models[0]!.family).toBe('one-compartment-first-order');
  });

  it('treats an explicitly-undefined route declaration as absent, not declared', () => {
    // `Partial<Record<RouteId, RouteDeclaration>>` admits an undefined value; it must not throw.
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { oral: undefined, iv: { absorption: 'bolus' } },
      presentParameters: DRUG_LEVEL,
    });
    expect(models.map((m) => m.route)).toEqual(['iv']);
  });

  it('is not-modelable on every route when a molecule axis conflicts', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment', 'two-compartment'],
      eliminationModels: [],
      routes: { iv: { absorption: 'bolus' }, oral: { absorption: 'first-order' } },
      presentParameters: DRUG_LEVEL,
    });
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.outcome).toBe('not-modelable');
      expect(m.reason).toMatch(/conflicting disposition/);
    }
  });

  it('dedups corroborating absorption rows for a route to a single shape', () => {
    // A read adapter passes the deduped SET when several cited rows agree on one shape.
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { oral: { absorption: ['first-order', 'first-order'] } },
      presentParameters: DRUG_LEVEL,
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.outcome).toBe('modelable');
    expect(models[0]!.absorptionShape).toBe('first-order');
    expect(models[0]!.family).toBe('one-compartment-first-order');
    expect(models[0]!.axisProvenance.absorption).toBe('asserted');
  });

  it('is not-modelable for a single route whose absorption declarations conflict', () => {
    // Two DIFFERENT shapes for ONE route are a curation contradiction; only that route sinks, and
    // its absorption axis is still marked asserted (the values were declared, they merely disagree).
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: {
        oral: { absorption: ['first-order', 'zero-order'] },
        iv: { absorption: 'bolus' },
      },
      presentParameters: DRUG_LEVEL,
    });
    const byRoute = new Map(models.map((m) => [m.route, m]));
    // Oral is the only conflicting route.
    expect(byRoute.get('oral')!.outcome).toBe('not-modelable');
    expect(byRoute.get('oral')!.reason).toMatch(/conflicting absorption declarations for route oral/);
    expect(byRoute.get('oral')!.absorptionShape).toBeNull();
    expect(byRoute.get('oral')!.axisProvenance.absorption).toBe('asserted');
    // IV is unaffected — a per-route conflict does not sink the whole drug (unlike a molecule axis).
    expect(byRoute.get('iv')!.outcome).toBe('modelable');
    expect(byRoute.get('iv')!.family).toBe('iv-one-compartment');
  });

  it('rejects an iv route left to the extravascular default (no IV-labelled extravascular model)', () => {
    // A route-scoped ka stored against route: 'iv' declares the route with no absorption shape; the
    // extravascular default must NOT stand in for an IV route.
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { iv: { presentParameters: ['ka'] } },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('iv');
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.family).toBeUndefined();
    expect(models[0]!.reason).toMatch(/route iv is incompatible with absorption shape/);
  });

  it('rejects an extravascular route declared as an IV bolus', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { oral: { absorption: 'bolus' } },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.reason).toMatch(/route oral is incompatible with absorption shape "bolus"/);
  });

  it('accepts an iv route that declares an IV input shape', () => {
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { iv: { absorption: 'iv-infusion' } },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    expect(models[0]!.outcome).toBe('modelable');
    expect(models[0]!.family).toBe('iv-one-compartment');
  });

  it('rejects a route-specific ka on an input with no first-order phase (coherent shape)', () => {
    // iv+bolus is coherent, but a ka authored FOR the iv route is contradictory — an IV bolus has no
    // first-order absorption rate. Enforced route-scoped, so the shape-keyed pool is unaffected.
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: {
        iv: { absorption: 'bolus', presentParameters: ['ka'] },
        oral: { absorption: 'first-order', presentParameters: ['ka', 'bioavailability'] },
      },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    const byRoute = new Map(models.map((m) => [m.route, m]));
    // The IV route's own ka is a contradiction on a bolus input.
    expect(byRoute.get('iv')!.outcome).toBe('not-modelable');
    expect(byRoute.get('iv')!.family).toBeUndefined();
    expect(byRoute.get('iv')!.reason).toMatch(/absorption rate \(ka\).*no first-order absorption phase/);
    // The oral route's ka is legitimate (first-order absorption) — unaffected.
    expect(byRoute.get('oral')!.outcome).toBe('modelable');
    expect(byRoute.get('oral')!.family).toBe('one-compartment-first-order');
    expect(byRoute.get('oral')!.missingParameters).toBeUndefined();
  });

  it('rejects a route-specific bioavailability on an IV input (F is fixed at 1)', () => {
    // A route-scoped F authored FOR an IV route is a contradiction — IV fixes F = 1, so a stored F
    // (possibly ≠ 1) would be silently discarded. Scoped to the route's own params.
    const models = resolveDrugModelsByRoute({
      dispositionModels: ['one-compartment'],
      eliminationModels: ['first-order'],
      routes: { iv: { absorption: 'bolus', presentParameters: ['bioavailability'] } },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('iv');
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.family).toBeUndefined();
    expect(models[0]!.reason).toMatch(/bioavailability \(F\).*fixes F = 1/);
  });
});

describe('CV-4c-2 — canonicalUnitFor', () => {
  it('reports the engine-canonical unit for each role-bearing catalog parameter', () => {
    // The catalog canonical units were chosen to equal the engine's.
    expect(canonicalUnitFor('halfLife')).toBe('h');
    expect(canonicalUnitFor('volumeOfDistribution')).toBe('L/kg');
    expect(canonicalUnitFor('ka')).toBe('1/h');
    expect(canonicalUnitFor('bioavailability')).toBe('fraction');
    expect(canonicalUnitFor('clearance')).toBe('L/h');
  });

  it('is null for a parameter with no ranged/canonical unit (a categorical axis)', () => {
    expect(canonicalUnitFor('dispositionModel')).toBeNull();
  });
});

describe('CV-4c-2 — toAssemblyValues', () => {
  it('maps catalog values onto engine roles, converting to canonical units', () => {
    const values = toAssemblyValues([
      { parameter: 'halfLife', value: 4, unit: 'h' },
      { parameter: 'volumeOfDistribution', value: 0.7, unit: 'L/kg' },
      { parameter: 'ka', value: 1.2, unit: '1/h' },
      { parameter: 'bioavailability', value: 0.8, unit: 'fraction' },
    ]);
    // Canonical catalog units equal the engine's, so these are identity conversions.
    expect(values).toEqual({
      eliminationHalfLife: 4,
      vd: 0.7,
      ka: 1.2,
      bioavailability: 0.8,
    });
  });

  it('rescales a non-canonical unit (clearance L/min → L/h)', () => {
    const values = toAssemblyValues([{ parameter: 'clearance', value: 2, unit: 'L/min' }]);
    expect(values.clearance).toBeCloseTo(120, 6);
  });

  it('skips a parameter with no engine role', () => {
    expect(toAssemblyValues([{ parameter: 'tmax', value: 1.5, unit: 'h' }])).toEqual({});
  });

  it('skips a non-finite value (missing stays missing, never a fixed(NaN))', () => {
    expect(
      toAssemblyValues([{ parameter: 'halfLife', value: Number.NaN, unit: 'h' }]),
    ).toEqual({});
  });

  it('skips a value whose unit cannot convert to canonical rather than pooling a wrong number', () => {
    // mL/min is a concentration-less mismatch for half-life's `h` — convertParameterValue returns
    // null (different families), so the role stays absent.
    expect(
      toAssemblyValues([{ parameter: 'halfLife', value: 4, unit: 'mL/min' }]),
    ).toEqual({});
  });
});

describe('CV-4c-2 — inferVdScaling', () => {
  it('returns undefined for the catalog L/kg unit (the total-weight default, left unset)', () => {
    // Omitting vdScaling for total-weight keeps an assembled model byte-identical to a hand-authored
    // one that omits it — the CV-4a snapshot-checksum reproducibility guarantee.
    expect(inferVdScaling('L/kg')).toBeUndefined();
  });

  it('returns undefined for an unrecognized unit (default, never a guessed scaling)', () => {
    // lean-body-mass / widmark are reviewed clinical judgements, not a unit distinction.
    expect(inferVdScaling('L')).toBeUndefined();
    expect(inferVdScaling('')).toBeUndefined();
  });
});

describe('CV-4c-2b — derivedDefinitionMetadata', () => {
  it('fills the identity fields and the disclosed defaults', () => {
    const meta = derivedDefinitionMetadata({ slug: 'cocaine', displayName: 'Cocaine' });
    expect(meta).toEqual({
      analyte: 'cocaine',
      displayName: 'Cocaine',
      modelId: 'cocaine-derived-v1',
      matrix: 'plasma',
      validationStatus: 'literature-derived',
      supportedBases: ['active-moiety', 'parent'],
    });
    // A derived model resolves only under its analyte — no aliases (catalog labels are not
    // analyte ids).
    expect('aliases' in meta).toBe(false);
  });

  it('uses a derived-tier modelId distinct from the hand-authored convention', () => {
    // Hand-authored ids are `<slug>-one-comp-v1`; a derived one is `<slug>-derived-v1`, so the two
    // tiers are never confused in a run manifest.
    expect(derivedDefinitionMetadata({ slug: 'amphetamine', displayName: 'Amphetamine' }).modelId)
      .toBe('amphetamine-derived-v1');
  });
});

describe('applyCautiousDefaults — a labelled F = 1 for a missing bioavailability', () => {
  const derive = (absorption: 'first-order' | 'bolus') =>
    deriveDrugModel({
      declaration: { disposition: 'one-compartment', elimination: 'first-order', absorption },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });

  it('fills a missing F with complete absorption and names it', () => {
    const out = applyCautiousDefaults(derive('first-order'), { eliminationHalfLife: 4, vd: 1, ka: 1 });
    expect(out.values.bioavailability).toBe(CAUTIOUS_DEFAULT_BIOAVAILABILITY);
    expect(out.defaultedParameters).toEqual(['bioavailability']);
  });

  it('never defaults ka: no absorption rate bounds the curve from one side at every time', () => {
    // A faster ka raises the early peak and lowers every late concentration, so any "cautious"
    // ka would be wrong in one direction or the other depending on the time asked about.
    const out = applyCautiousDefaults(derive('first-order'), {
      eliminationHalfLife: 4,
      vd: 1,
      bioavailability: 0.7,
    });
    expect(out.values.ka).toBeUndefined();
    expect(out.defaultedParameters).toEqual([]);
  });

  it('never replaces a value that is present', () => {
    const values = { eliminationHalfLife: 4, vd: 1, ka: 1, bioavailability: 0.5 };
    const out = applyCautiousDefaults(derive('first-order'), values);
    expect(out.values).toBe(values);
    expect(out.defaultedParameters).toEqual([]);
  });

  it('leaves a blocked F missing — curated evidence or a non-administered substance', () => {
    const out = applyCautiousDefaults(
      derive('first-order'),
      { eliminationHalfLife: 4, vd: 1, ka: 1 },
      new Set(['bioavailability'] as const),
    );
    expect(out.values.bioavailability).toBeUndefined();
    expect(out.defaultedParameters).toEqual([]);
  });

  it('gives an IV route nothing, and never defaults a half-life or a volume', () => {
    expect(applyCautiousDefaults(derive('bolus'), { eliminationHalfLife: 4, vd: 1 }).defaultedParameters).toEqual([]);
    const sparse = applyCautiousDefaults(derive('first-order'), {});
    expect(sparse.values.eliminationHalfLife).toBeUndefined();
    expect(sparse.values.vd).toBeUndefined();
  });
});

describe('applyKaInference — ka solved from a route Tmax', () => {
  /** A modelable oral first-order derivation: the shape that actually carries a `ka`. */
  const oral = () =>
    deriveDrugModel({
      declaration: {
        disposition: 'one-compartment',
        elimination: 'first-order',
        absorption: 'first-order',
      },
      presentParameters: ['halfLife', 'volumeOfDistribution', 'bioavailability'],
    });

  /** t½ = 4 h → ke = 0.1733/h, so any Tmax below 5.77 h is inferable. */
  const VALUES = { eliminationHalfLife: 4, vd: 3, bioavailability: 0.8 } as const;

  it('fills ka and reports it as inferred', () => {
    const out = applyKaInference(oral(), { ...VALUES }, 1);
    expect(out.inferredParameters).toEqual(['ka']);
    expect(out.values.ka).toBeGreaterThan(0);
    expect(out.declined).toBeUndefined();
    // The inferred rate reproduces the Tmax it came from.
    const ke = Math.LN2 / 4;
    expect(Math.log(out.values.ka! / ke) / (out.values.ka! - ke)).toBeCloseTo(1, 8);
  });

  it('never overwrites a cited ka — authored evidence wins over an inference', () => {
    const out = applyKaInference(oral(), { ...VALUES, ka: 0.9 }, 1);
    expect(out.values.ka).toBe(0.9);
    expect(out.inferredParameters).toEqual([]);
  });

  it('does not mutate the caller’s values', () => {
    const values = { ...VALUES };
    applyKaInference(oral(), values, 1);
    expect('ka' in values).toBe(false);
  });

  it('leaves ka missing in the flip-flop regime, with the reason recorded', () => {
    // Tmax 8 h against a 4 h half-life: absorption is the slower process, so the stored half-life
    // cannot be read as elimination and no ka is manufactured from it.
    const out = applyKaInference(oral(), { ...VALUES }, 8);
    expect(out.values.ka).toBeUndefined();
    expect(out.inferredParameters).toEqual([]);
    expect(out.declined).toMatch(/absorption-rate-limited/);
  });

  it('declines when there is no half-life to solve against', () => {
    const out = applyKaInference(oral(), { vd: 3 }, 1);
    expect(out.values.ka).toBeUndefined();
    expect(out.declined).toMatch(/no elimination half-life/);
  });

  it('does nothing without a Tmax', () => {
    const out = applyKaInference(oral(), { ...VALUES }, undefined);
    expect(out.values.ka).toBeUndefined();
    expect(out.inferredParameters).toEqual([]);
    expect(out.declined).toBeUndefined();
  });

  it('does not infer a ka for an input shape that has none', () => {
    // An IV bolus has no absorption phase; a `ka` on it would be a contradiction, not a gap.
    const iv = deriveDrugModel({
      declaration: {
        disposition: 'one-compartment',
        elimination: 'first-order',
        absorption: 'bolus',
      },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    });
    const out = applyKaInference(iv, { ...VALUES }, 1);
    expect(out.values.ka).toBeUndefined();
    expect(out.inferredParameters).toEqual([]);
  });

  it('does not infer for a zero-order input, which has no first-order rate', () => {
    const zeroOrder = deriveDrugModel({
      declaration: {
        disposition: 'one-compartment',
        elimination: 'first-order',
        absorption: 'zero-order',
      },
      presentParameters: ['halfLife', 'volumeOfDistribution', 'bioavailability'],
    });
    const out = applyKaInference(zeroOrder, { ...VALUES }, 1);
    expect(out.inferredParameters).toEqual([]);
  });

  it('does infer for a mixed input, which has a parallel first-order component', () => {
    const mixed = deriveDrugModel({
      declaration: {
        disposition: 'one-compartment',
        elimination: 'first-order',
        absorption: 'mixed',
      },
      presentParameters: ['halfLife', 'volumeOfDistribution', 'bioavailability'],
    });
    const out = applyKaInference(mixed, { ...VALUES }, 1);
    expect(out.inferredParameters).toEqual(['ka']);
  });

  it('does nothing for a not-modelable derivation', () => {
    const broken = deriveDrugModel({
      declaration: { disposition: 'not-a-real-axis' as never },
      presentParameters: ['halfLife'],
    });
    const out = applyKaInference(broken, { ...VALUES }, 1);
    expect(out.inferredParameters).toEqual([]);
  });
});

describe('tmaxHoursFrom', () => {
  it('reads a Tmax in canonical hours', () => {
    expect(tmaxHoursFrom([{ parameter: 'tmax', value: 1.5, unit: 'h' }])).toBe(1.5);
  });

  it('ignores every other parameter', () => {
    expect(
      tmaxHoursFrom([
        { parameter: 'halfLife', value: 4, unit: 'h' },
        { parameter: 'volumeOfDistribution', value: 3, unit: 'L/kg' },
      ]),
    ).toBeUndefined();
  });

  it('rejects a non-positive or non-finite Tmax rather than passing it on', () => {
    expect(tmaxHoursFrom([{ parameter: 'tmax', value: 0, unit: 'h' }])).toBeUndefined();
    expect(tmaxHoursFrom([{ parameter: 'tmax', value: -1, unit: 'h' }])).toBeUndefined();
    expect(tmaxHoursFrom([{ parameter: 'tmax', value: Number.NaN, unit: 'h' }])).toBeUndefined();
  });

  it('is undefined when no Tmax is present', () => {
    expect(tmaxHoursFrom([])).toBeUndefined();
  });
});

describe('toAssemblyRanges', () => {
  it('converts a reported spread to the canonical unit alongside its value', () => {
    expect(
      toAssemblyRanges([
        { parameter: 'clearance', value: 2, unit: 'L/min', low: 1, high: 4 },
      ]),
    ).toEqual({ clearance: { low: 60, high: 240 } });
  });

  it('lets a later value replace, or clear, an earlier value’s spread for the same role', () => {
    expect(
      toAssemblyRanges([
        { parameter: 'bioavailability', value: 0.5, unit: 'fraction', low: 0.2, high: 0.9 },
        { parameter: 'bioavailability', value: 0.7, unit: 'fraction' },
      ]),
    ).toEqual({});
    expect(
      toAssemblyRanges([
        { parameter: 'bioavailability', value: 0.5, unit: 'fraction', low: 0.2, high: 0.9 },
        { parameter: 'bioavailability', value: 0.7, unit: 'fraction', low: 0.6, high: 0.8 },
      ]),
    ).toEqual({ bioavailability: { low: 0.6, high: 0.8 } });
  });
});

describe('inferredKaRange', () => {
  const tmax = (low: number, high: number) => ({
    parameter: 'tmax' as const,
    value: (low + high) / 2,
    unit: 'h',
    low,
    high,
  });

  it('maps the shortest Tmax to the highest ka and the longest to the lowest', () => {
    const range = inferredKaRange(tmax(0.5, 2), 10);
    expect(range).toBeDefined();
    expect(range!.low).toBeLessThan(range!.high);
    const fast = inferredKaRange(tmax(0.5, 0.6), 10)!;
    const slow = inferredKaRange(tmax(1.9, 2), 10)!;
    expect(fast.high).toBeCloseTo(range!.high, 10);
    expect(slow.low).toBeCloseTo(range!.low, 10);
  });

  it('gives no range when the longest Tmax falls in the flip-flop regime', () => {
    // t½ = 1 h → ke ≈ 0.69/h, so any Tmax at or above 1/ke ≈ 1.44 h cannot be solved.
    expect(inferredKaRange(tmax(0.5, 3), 1)).toBeUndefined();
  });

  it('gives no range for a Tmax with no reported spread', () => {
    expect(inferredKaRange({ parameter: 'tmax', value: 1, unit: 'h' }, 10)).toBeUndefined();
  });
});
