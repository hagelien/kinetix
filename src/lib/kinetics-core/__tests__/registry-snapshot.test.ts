/**
 * CV-4a — the registry snapshot merge primitive.
 *
 * `buildRegistrySnapshot(overrides, derived, version)` merges the reviewed override tier with
 * DB-derived models into one checksummed release. The override tier ALWAYS wins a shared analyte;
 * the checksum matches `registry.ts`, so the current definitions with no derived entries reproduce
 * `REGISTRY_CHECKSUM` exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRegistrySnapshot,
  findModel,
  registeredAnalytes,
  REGISTRY_VERSION,
  REGISTRY_CHECKSUM,
  hashValue,
  type DrugModelDefinition,
} from '../index';

/** The current reviewed release, reconstructed from the registry's public surface. */
function currentDefinitions(): DrugModelDefinition[] {
  return registeredAnalytes().map((analyte) => {
    const model = findModel(analyte);
    if (!model) throw new Error(`registeredAnalytes() named a model findModel() cannot resolve: ${analyte}`);
    return model;
  });
}

/** A minimal but structurally valid one-compartment model for an arbitrary analyte. */
function fakeModel(analyte: string, aliases?: string[]): DrugModelDefinition {
  return {
    analyte,
    ...(aliases ? { aliases } : {}),
    displayName: analyte,
    modelId: `${analyte}-fake-v1`,
    matrix: 'plasma',
    validationStatus: 'literature-derived',
    routes: {
      oral: {
        family: 'one-compartment-first-order',
        kaPerHour: { kind: 'fixed', value: 1 },
        eliminationHalfLifeHours: { kind: 'fixed', value: 2 },
        vdLitersPerKg: { kind: 'fixed', value: 1 },
        bioavailability: { kind: 'fixed', value: 0.9 },
      },
    },
    supportedCovariates: ['weightKg'],
    supportedBases: ['parent'],
  };
}

describe('CV-4a — buildRegistrySnapshot', () => {
  it('reproduces the pinned registry checksum from the current definitions with no derived entries', () => {
    const snapshot = buildRegistrySnapshot(currentDefinitions(), [], REGISTRY_VERSION);
    expect(snapshot.checksum).toBe(REGISTRY_CHECKSUM);
    expect(snapshot.version).toBe(REGISTRY_VERSION);
    expect(snapshot.definitions).toHaveLength(registeredAnalytes().length);
    expect(snapshot.supersededByOverride).toEqual([]);
  });

  it('computes the checksum with the same scheme as registry.ts', () => {
    const overrides = [fakeModel('alpha'), fakeModel('beta')];
    const snapshot = buildRegistrySnapshot(overrides, [], '1.2.3');
    expect(snapshot.checksum).toBe(hashValue({ version: '1.2.3', definitions: overrides }));
  });

  it('keeps a derived entry that no override claims', () => {
    const overrides = [fakeModel('alpha')];
    const derived = [fakeModel('gamma')];
    const snapshot = buildRegistrySnapshot(overrides, derived, REGISTRY_VERSION);
    expect(snapshot.definitions.map((d) => d.analyte)).toEqual(['alpha', 'gamma']);
    expect(snapshot.supersededByOverride).toEqual([]);
  });

  it('drops a derived entry the override tier already claims (override always wins)', () => {
    const override = fakeModel('cocaine');
    const derived = fakeModel('cocaine'); // a naive DB derivation of a reviewed nonlinear drug
    const snapshot = buildRegistrySnapshot([override], [derived], REGISTRY_VERSION);
    expect(snapshot.definitions).toEqual([override]); // the reviewed model, unchanged
    expect(snapshot.supersededByOverride).toEqual(['cocaine']);
  });

  it('drops a derived entry that collides with an override only through an ALIAS', () => {
    const override = fakeModel('psilocybin', ['psilocin']);
    const derived = fakeModel('psilocin'); // resolves under an id the override already claims
    const snapshot = buildRegistrySnapshot([override], [derived], REGISTRY_VERSION);
    expect(snapshot.definitions).toEqual([override]);
    expect(snapshot.supersededByOverride).toEqual(['psilocin']);
  });

  it('preserves order: overrides first, then surviving derived, each in input order', () => {
    const overrides = [fakeModel('b'), fakeModel('a')];
    const derived = [fakeModel('d'), fakeModel('c')];
    const snapshot = buildRegistrySnapshot(overrides, derived, REGISTRY_VERSION);
    expect(snapshot.definitions.map((d) => d.analyte)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('throws on a collision within the override tier', () => {
    expect(() => buildRegistrySnapshot([fakeModel('x'), fakeModel('x')], [], REGISTRY_VERSION)).toThrow(
      /override key collision/i,
    );
  });

  it('throws on a collision between two surviving derived entries', () => {
    expect(() =>
      buildRegistrySnapshot([], [fakeModel('y'), fakeModel('y')], REGISTRY_VERSION),
    ).toThrow(/derived key collision/i);
  });

  it('freezes the release so a later mutation cannot desync the payload from the checksum', () => {
    const source = fakeModel('delta');
    const snapshot = buildRegistrySnapshot([source], [], REGISTRY_VERSION);
    const checksumAtBuild = snapshot.checksum;

    // The array and every nested model are frozen (like registry.ts's own definitions).
    expect(Object.isFrozen(snapshot.definitions)).toBe(true);
    expect(Object.isFrozen(snapshot.definitions[0])).toBe(true);
    expect(Object.isFrozen(snapshot.definitions[0]!.routes.oral)).toBe(true);

    // Mutating the SOURCE model after the build must not reach into the pinned release: the snapshot
    // owns an independent deep copy, so its payload — and thus its checksum's meaning — is unchanged.
    const sourceOral = source.routes.oral!;
    const snapshotOral = snapshot.definitions[0]!.routes.oral!;
    if (
      sourceOral.family !== 'one-compartment-first-order' ||
      snapshotOral.family !== 'one-compartment-first-order'
    ) {
      throw new Error('fakeModel should build a one-compartment-first-order oral route');
    }
    sourceOral.eliminationHalfLifeHours = { kind: 'fixed', value: 999 };
    expect(snapshotOral.eliminationHalfLifeHours).toEqual({ kind: 'fixed', value: 2 });
    expect(snapshot.checksum).toBe(checksumAtBuild);
    // The checksum still describes the actual payload.
    expect(snapshot.checksum).toBe(
      hashValue({ version: REGISTRY_VERSION, definitions: snapshot.definitions }),
    );
  });

  it('a superseded derived entry does not count as a derived-vs-derived collision', () => {
    // Two derived entries share `cocaine`; an override also claims it. Both derived are superseded by
    // the override before they can collide with each other — supersession is not an error.
    const override = fakeModel('cocaine');
    const derived = [fakeModel('cocaine'), fakeModel('cocaine')];
    const snapshot = buildRegistrySnapshot([override], derived, REGISTRY_VERSION);
    expect(snapshot.definitions).toEqual([override]);
    expect(snapshot.supersededByOverride).toEqual(['cocaine', 'cocaine']);
  });
});
