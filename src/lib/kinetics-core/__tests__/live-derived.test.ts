/**
 * The live overlay: what the catalogue builds NOW, laid over the committed derived tier.
 *
 * Needs a fresh module graph per test: `derivedRegistryRolloutEnabled` reads `import.meta.env`,
 * and both the resolved release and the live answers are module state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_REGISTRY_ARTIFACT } from '../generated-registry.js';
import type { DerivedModelGrade } from '../derived-grade.js';
import type { CanonicalScenario, DrugModelDefinition } from '../types.js';

type Core = typeof import('../index.js');

async function loadCore(): Promise<Core> {
  vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
  return import('../index.js');
}

function committed(analyte: string): { definition: DrugModelDefinition; grade: DerivedModelGrade } {
  const definition = GENERATED_REGISTRY_ARTIFACT.derivedDefinitions.find((d) => d.analyte === analyte);
  const grade = GENERATED_REGISTRY_ARTIFACT.derivedGrades.find((g) => g.analyte === analyte);
  if (!definition || !grade) throw new Error(`fixture: ${analyte} is not in the committed artifact`);
  return {
    definition: JSON.parse(JSON.stringify(definition)) as DrugModelDefinition,
    grade: JSON.parse(JSON.stringify(grade)) as DerivedModelGrade,
  };
}

/** A copy of a committed model under a new slug, as the server would build for a drug the
 *  committed artifact does not have yet. */
function renamed(analyte: string, slug: string) {
  const { definition, grade } = committed(analyte);
  return {
    definition: { ...definition, analyte: slug, modelId: `${slug}-derived-v1`, displayName: slug },
    grade: { ...grade, analyte: slug },
  };
}

function scenarioFor(analyte: string): CanonicalScenario {
  return {
    schemaVersion: '1',
    analyte,
    subject: { weightKg: 70, age: 30, sex: 'male' },
    doses: [{ tHours: 0, amountMg: 1, route: 'oral', basis: 'active-moiety' }],
    timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('live derived overlay', () => {
  it('resolves a drug the committed artifact lacks once the catalogue builds it', async () => {
    const core = await loadCore();
    const slug = 'live-only-drug';
    expect(core.resolveModel(slug)).toBeUndefined();

    const live = renamed('alprazolam', slug);
    core.installLiveDerivedEntry({ analyte: slug, ...live });

    expect(core.resolveModel(slug)?.modelId).toMatch(new RegExp(`^${slug}-derived-v1\\+live\\.[0-9a-f]+$`));
    expect(core.resolvableAnalyteIds()).toContain(slug);
    expect(core.isDerivedAnalyte(slug)).toBe(true);
    expect(core.derivedRouteGrade(slug, 'oral')).toEqual(live.grade.routes[0]);
    const res = core.simulateScenario(scenarioFor(slug), '2026-01-01T00:00:00.000Z');
    expect(res.ok).toBe(true);
  });

  it('replaces the committed model and grade with what the catalogue builds now', async () => {
    const core = await loadCore();
    const { definition, grade } = committed('alprazolam');
    const oral = definition.routes.oral as unknown as Record<string, unknown>;
    oral.eliminationHalfLifeHours = { kind: 'fixed', value: 20 };
    core.installLiveDerivedEntry({ analyte: 'alprazolam', definition, grade });

    const resolved = core.resolveModel('alprazolam')?.routes.oral as unknown as Record<string, unknown>;
    expect(resolved.eliminationHalfLifeHours).toEqual({ kind: 'fixed', value: 20 });
  });

  it('withdraws a committed model the catalogue no longer builds', async () => {
    const core = await loadCore();
    expect(core.resolveModel('alprazolam')).toBeDefined();
    core.installLiveDerivedEntry({ analyte: 'alprazolam', definition: null, grade: null });

    expect(core.resolveModel('alprazolam')).toBeUndefined();
    expect(core.isDerivedAnalyte('alprazolam')).toBe(false);
    expect(core.derivedRouteGrade('alprazolam', 'oral')).toBeUndefined();
  });

  it('stamps a run with the live release, distinct from the committed one', async () => {
    const core = await loadCore();
    const before = core.resolvedRegistryRelease();
    expect(before.checksum).toBe(GENERATED_REGISTRY_ARTIFACT.checksum);

    const slug = 'live-only-drug';
    core.installLiveDerivedEntry({ analyte: slug, ...renamed('alprazolam', slug) });
    const after = core.resolvedRegistryRelease();
    expect(after.version).toBe(`${GENERATED_REGISTRY_ARTIFACT.registryVersion}+live`);
    expect(after.checksum).not.toBe(before.checksum);

    const res = core.simulateScenario(scenarioFor(slug), '2026-01-01T00:00:00.000Z');
    if (!res.ok) throw new Error('expected ok');
    expect(res.manifest.registryChecksum).toBe(after.checksum);
    expect(res.manifest.registryVersion).toBe(after.version);
  });

  it('never displaces a reviewed model', async () => {
    const core = await loadCore();
    const reviewed = core.findModel('ethanol');
    const { definition, grade } = renamed('alprazolam', 'ethanol');
    core.installLiveDerivedEntry({ analyte: 'ethanol', definition, grade });
    expect(core.resolveModel('ethanol')).toEqual(reviewed);
  });

  it('treats a repeated identical answer as no change', async () => {
    const core = await loadCore();
    const slug = 'live-only-drug';
    const live = renamed('alprazolam', slug);
    expect(core.installLiveDerivedEntry({ analyte: slug, ...live })).toBe(true);
    expect(core.installLiveDerivedEntry({ analyte: slug, ...JSON.parse(JSON.stringify(live)) })).toBe(false);
  });

  it('versions the model id per build, so a curve is only graded by the build that produced it', async () => {
    const core = await loadCore();
    const first = committed('alprazolam');
    core.installLiveDerivedEntry({ analyte: 'alprazolam', ...first });
    const firstId = core.resolveModel('alprazolam')!.modelId;
    expect(firstId).not.toBe(first.definition.modelId);

    // The worker re-installs the held (already versioned) entry: same build, same id, no change.
    expect(core.installLiveDerivedEntry(core.liveDerivedEntry('alprazolam')!)).toBe(false);
    expect(core.resolveModel('alprazolam')!.modelId).toBe(firstId);

    // New parameters are a new build with a new id; the old id no longer resolves.
    const refreshed = committed('alprazolam');
    (refreshed.definition.routes.oral as unknown as Record<string, unknown>).eliminationHalfLifeHours =
      { kind: 'fixed', value: 20 };
    core.installLiveDerivedEntry({ analyte: 'alprazolam', ...refreshed });
    const refreshedId = core.resolveModel('alprazolam')!.modelId;
    expect(refreshedId).not.toBe(firstId);
    expect(core.resolvableAnalyteIds().map((a) => core.resolveModel(a)?.modelId)).not.toContain(firstId);

    // So do new grade facts alone: the curve's disclosure belongs to its build too.
    const regraded = committed('alprazolam');
    core.installLiveDerivedEntry({
      analyte: 'alprazolam',
      definition: refreshed.definition,
      grade: { ...regraded.grade, routes: regraded.grade.routes.map((r) => ({ ...r, inputSources: {} })) },
    });
    expect(core.resolveModel('alprazolam')!.modelId).not.toBe(refreshedId);
  });

  it('rejects an answer whose model belongs to another analyte', async () => {
    const core = await loadCore();
    const { definition, grade } = committed('alprazolam');
    expect(() => core.installLiveDerivedEntry({ analyte: 'other', definition, grade: null })).toThrow();
    expect(() =>
      core.installLiveDerivedEntry({ analyte: 'alprazolam', definition, grade: { ...grade, analyte: 'x' } }),
    ).toThrow();
  });

  it('is ignored while the derived tier is switched off', async () => {
    const core = await import('../index.js');
    const slug = 'live-only-drug';
    core.installLiveDerivedEntry({ analyte: slug, ...renamed('alprazolam', slug) });
    expect(core.resolveModel(slug)).toBeUndefined();
    expect(core.resolvedRegistryRelease().checksum).toBe(core.REGISTRY_CHECKSUM);
  });
});
