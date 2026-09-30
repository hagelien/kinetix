import { describe, expect, it } from 'vitest';
import { fixed } from '../param.js';
import { buildRegistrySnapshot } from '../registry-snapshot.js';
import {
  derivedRouteGrade,
  isDerivedAnalyte,
  loadGeneratedRegistry,
  type GeneratedRegistryArtifact,
} from '../generated-registry-loader.js';
import { derivedModelFromGrade } from '../derived-grade.js';
import { describeDerivedModel } from '../../modelGradeDisclosure.js';
import type { DrugModelDefinition } from '../types.js';

const model = (analyte: string, halfLife: number): DrugModelDefinition => ({
  analyte, displayName: analyte, modelId: `${analyte}-model`, matrix: 'plasma',
  validationStatus: 'literature-derived', supportedBases: ['parent'],
  supportedCovariates: [],
  routes: { oral: { family: 'one-compartment-first-order', kaPerHour: fixed(1),
    eliminationHalfLifeHours: fixed(halfLife), vdLitersPerKg: fixed(1), bioavailability: fixed(1) } },
});

describe('generated registry offline loader', () => {
  it('always keeps reviewed overrides and exposes not-modelable diagnostics', () => {
    const override = model('shared', 10);
    const derived = [model('shared', 1), model('derived', 2)];
    const built = buildRegistrySnapshot([override], derived, 'test');
    const artifact: GeneratedRegistryArtifact = {
      formatVersion: 1, generatedAt: 'snapshot-content-addressed', registryVersion: 'test',
      checksum: built.checksum, derivedDefinitions: derived, derivedGrades: [],
      supersededByOverride: ['shared'],
      notModelable: [{ slug: 'missing-drug', reason: 'no route could be assembled',
        routes: [{ route: 'oral', outcome: 'incomplete', missing: ['vd'] }] }],
    };
    const loaded = loadGeneratedRegistry([override], artifact);
    expect(loaded.snapshot.definitions.find((d) => d.analyte === 'shared')).toEqual(override);
    expect(loaded.snapshot.definitions.some((d) => d.analyte === 'derived')).toBe(true);
    expect(loaded.notModelable[0]).toMatchObject({ slug: 'missing-drug', routes: [{ missing: ['vd'] }] });
  });

  it('resolves a derived route grade and tells derived apart from reviewed', () => {
    const override = model('reviewed-one', 10);
    const derived = [model('derived-one', 2)];
    const built = buildRegistrySnapshot([override], derived, 'test');
    const artifact: GeneratedRegistryArtifact = {
      formatVersion: 1, generatedAt: 'snapshot-content-addressed', registryVersion: 'test',
      checksum: built.checksum, derivedDefinitions: derived,
      derivedGrades: [{
        analyte: 'derived-one',
        routes: [{
          route: 'oral',
          structure: { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' },
          axisProvenance: { disposition: 'defaulted', elimination: 'defaulted', absorption: 'asserted' },
          family: 'one-compartment-first-order',
          inferredParameters: ['ka'],
        }],
      }],
      supersededByOverride: [],
      notModelable: [],
    };

    const grade = derivedRouteGrade('derived-one', 'oral', artifact);
    expect(grade?.inferredParameters).toEqual(['ka']);
    expect(grade?.axisProvenance.absorption).toBe('asserted');
    // A reviewed override carries no derived grade — it has its own reviewed-tier assessment.
    expect(derivedRouteGrade('reviewed-one', 'oral', artifact)).toBeUndefined();
    // And a route the derived model does not declare resolves to nothing rather than the wrong one.
    expect(derivedRouteGrade('derived-one', 'intranasal', artifact)).toBeUndefined();

    expect(isDerivedAnalyte('derived-one', artifact)).toBe(true);
    expect(isDerivedAnalyte('reviewed-one', artifact)).toBe(false);
  });

  it('rebuilds a gradeable DerivedModel from a committed route grade', () => {
    const record = {
      route: 'oral' as const,
      structure: { disposition: 'one-compartment', elimination: 'first-order', absorption: 'first-order' } as const,
      axisProvenance: { disposition: 'defaulted', elimination: 'defaulted', absorption: 'asserted' } as const,
      family: 'one-compartment-first-order' as const,
      inferredParameters: ['ka'] as const,
    };
    const rebuilt = derivedModelFromGrade(record);
    expect(rebuilt.outcome).toBe('modelable');
    expect(rebuilt.defaulted).toBe(true); // two axes took the disclosed default
    expect(rebuilt.family).toBe('one-compartment-first-order');

    // The whole point: the ordinary CV-3 path grades it without re-reading the catalog, and the
    // inferred ka caps it at C.
    const disclosure = describeDerivedModel(rebuilt, {
      sourceQuality: 'A',
      validationStatus: 'validated',
      inferredParameters: [...record.inferredParameters],
    });
    expect(disclosure.grade).toBe('C');
    expect(disclosure.caveats).toContainEqual({ code: 'inferred-parameters', parameters: ['ka'] });
    expect(disclosure.caveats).toContainEqual({ code: 'defaulted-axes', axes: ['disposition', 'elimination'] });
  });
});
