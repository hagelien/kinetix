/**
 * CV-4c — assemble a full DrugModelDefinition from a drug's per-route derivations.
 *
 * Each route is assembled independently (CV-4b); runnable routes go into the routes map, the rest
 * are reported (`routeOutcomes`) and left out — missing stays missing. `not-modelable` only when no
 * route is runnable.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveModel,
  assembleDrugDefinition,
  fixed,
  type DrugDefinitionMetadata,
  type RouteAssemblyInput,
} from '../index';

const META: DrugDefinitionMetadata = {
  analyte: 'examplinib',
  displayName: 'Examplinib',
  modelId: 'derived:examplinib',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedBases: ['active-moiety'],
};

const ivBolus = (): RouteAssemblyInput => ({
  route: 'iv',
  derived: deriveModel({ disposition: 'one-compartment', absorption: 'bolus' }, [
    'eliminationHalfLife',
    'vd',
  ]),
  values: { eliminationHalfLife: 4, vd: 0.7 },
});

const oralComplete = (): RouteAssemblyInput => ({
  route: 'oral',
  derived: deriveModel(
    { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
    ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'],
  ),
  values: { ka: 1.1, eliminationHalfLife: 4, vd: 0.7, bioavailability: 0.8 },
});

const oralMissingKa = (): RouteAssemblyInput => ({
  route: 'oral',
  derived: deriveModel(
    { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
    ['eliminationHalfLife', 'vd', 'bioavailability'],
  ),
  values: { eliminationHalfLife: 4, vd: 0.7, bioavailability: 0.8 },
});

describe('CV-4c — assembleDrugDefinition', () => {
  it('assembles a one-route (IV bolus) definition and carries the catalog metadata', () => {
    const result = assembleDrugDefinition(META, [ivBolus()]);
    expect(result.outcome).toBe('assembled');
    if (result.outcome === 'assembled') {
      expect(result.definition.analyte).toBe('examplinib');
      expect(result.definition.displayName).toBe('Examplinib');
      expect(result.definition.matrix).toBe('plasma');
      expect(result.definition.validationStatus).toBe('literature-derived');
      expect(result.definition.supportedBases).toEqual(['active-moiety']);
      expect(result.definition.supportedCovariates).toEqual([]);
      expect(Object.keys(result.definition.routes)).toEqual(['iv']);
      expect(result.definition.routes.iv?.family).toBe('iv-one-compartment');
      expect(result.routeOutcomes).toEqual([{ route: 'iv', outcome: 'assembled' }]);
    }
  });

  it('assembles multiple routes and keys them by RouteId', () => {
    const result = assembleDrugDefinition(META, [ivBolus(), oralComplete()]);
    expect(result.outcome).toBe('assembled');
    if (result.outcome === 'assembled') {
      expect(Object.keys(result.definition.routes).sort()).toEqual(['iv', 'oral']);
      expect(result.definition.routes.oral?.family).toBe('one-compartment-first-order');
    }
  });

  it('includes only the runnable routes and reports the incomplete ones', () => {
    // IV is complete; oral is missing ka — the definition holds only IV, oral is reported.
    const result = assembleDrugDefinition(META, [ivBolus(), oralMissingKa()]);
    expect(result.outcome).toBe('assembled');
    if (result.outcome === 'assembled') {
      expect(Object.keys(result.definition.routes)).toEqual(['iv']);
      const oral = result.routeOutcomes.find((r) => r.route === 'oral');
      expect(oral?.outcome).toBe('incomplete');
      expect(oral?.missing).toEqual(['ka']);
    }
  });

  it('is not-modelable when no route is runnable', () => {
    const result = assembleDrugDefinition(META, [oralMissingKa()]);
    expect(result.outcome).toBe('not-modelable');
    if (result.outcome === 'not-modelable') {
      expect(result.reason).toMatch(/no administration route could be assembled/);
      expect(result.routeOutcomes[0]!.outcome).toBe('incomplete');
    }
  });

  it('reports a not-modelable derivation as an unsupported route', () => {
    const transit: RouteAssemblyInput = {
      route: 'oral',
      derived: deriveModel({ absorption: 'transit' }, ['eliminationHalfLife', 'vd']),
      values: { eliminationHalfLife: 4, vd: 0.7 },
    };
    const result = assembleDrugDefinition(META, [transit]);
    expect(result.outcome).toBe('not-modelable');
    if (result.outcome === 'not-modelable') {
      expect(result.routeOutcomes[0]!.outcome).toBe('unsupported');
      expect(result.routeOutcomes[0]!.reason).toMatch(/transit/i);
    }
  });

  it('is not-modelable with no routes supplied', () => {
    const result = assembleDrugDefinition(META, []);
    expect(result.outcome).toBe('not-modelable');
    if (result.outcome === 'not-modelable') {
      expect(result.reason).toMatch(/no administration route was supplied/);
    }
  });

  it('carries aliases and references through when supplied, and passes vdScaling to the route', () => {
    const result = assembleDrugDefinition(
      { ...META, aliases: ['example-moiety'], references: ['PMID:1'] },
      [{ ...ivBolus(), vdScaling: 'lean-body-mass' }],
    );
    expect(result.outcome).toBe('assembled');
    if (result.outcome === 'assembled') {
      expect(result.definition.aliases).toEqual(['example-moiety']);
      expect(result.definition.references).toEqual(['PMID:1']);
      if (result.definition.routes.iv?.family === 'iv-one-compartment') {
        expect(result.definition.routes.iv.vdScaling).toBe('lean-body-mass');
        expect(result.definition.routes.iv.eliminationHalfLifeHours).toEqual(fixed(4));
      }
      // lean-body-mass Vd scaling consumes height + sex, so the definition must declare them —
      // otherwise the engine uses them for Vd yet flags them covariate-not-modelled.
      expect(result.definition.supportedCovariates).toEqual(['heightCm', 'sex']);
    }
  });

  it('declares the covariates each Vd scaling consumes (widmark → age + height + sex)', () => {
    const result = assembleDrugDefinition(META, [{ ...ivBolus(), vdScaling: 'widmark' }]);
    if (result.outcome === 'assembled') {
      expect(result.definition.supportedCovariates).toEqual(['age', 'heightCm', 'sex']);
    }
  });

  it('declares no covariates for total-weight scaling', () => {
    // ivBolus() has no vdScaling → total-weight, which consumes only weight (never flagged).
    const result = assembleDrugDefinition(META, [ivBolus()]);
    if (result.outcome === 'assembled') {
      expect(result.definition.supportedCovariates).toEqual([]);
    }
  });

  it('throws on a duplicate route id', () => {
    expect(() => assembleDrugDefinition(META, [ivBolus(), ivBolus()])).toThrow(/duplicate route/);
  });

  it('rejects a duplicate route even when the first occurrence was incomplete', () => {
    // The first oral input is incomplete (missing ka), so it never enters the routes map; the
    // duplicate must still be surfaced rather than silently assembled.
    expect(() => assembleDrugDefinition(META, [oralMissingKa(), oralComplete()])).toThrow(
      /duplicate route/,
    );
  });
});
