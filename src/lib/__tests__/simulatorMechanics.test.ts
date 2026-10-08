/**
 * The drift guard for `/modeling/how-it-works`.
 *
 * `docs/simulator-mechanics.md` is a public statement about what the simulator assumes and
 * refuses. A document like that is only worth reading if it cannot quietly fall behind the
 * code, so every claim in it that a code change could invalidate is asserted here against
 * the code itself.
 *
 * Two kinds of assertion:
 *
 *  1. **Vocabulary and inventory** — the engines, model families, routes, analytes and
 *     numeric guardrails the page publishes come from `simulatorMechanics.ts`, which reads
 *     `kinetics-core`. These tests pin THAT module to the engine, so an added family or a
 *     changed cap either appears on the page or fails here.
 *  2. **Prose claims** — the specific refusals and limitations §3/§7/§8 name are asserted
 *     against the engine's actual behaviour by running scenarios through it. When one of
 *     these starts failing, the simulator has been improved and the document is now wrong:
 *     fix the document, do not weaken the test.
 *
 * If you add a `{{live:…}}` token to the document, add it to `LIVE_BLOCK_IDS` and render
 * it on the page — the token test below fails otherwise, rather than the page shipping a
 * literal `{{live:…}}` to a reviewer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleRouteParams,
  ENGINE_LIMITS,
  MODEL_FAMILIES,
  MODEL_FAMILY_EVALUATION,
  ROUTE_IDS,
  SCENARIO_SCHEMA_VERSION,
  simulateScenario,
  type CanonicalScenario,
} from '@/lib/kinetics-core';
import {
  LIVE_BLOCK_IDS,
  MECHANICS_ENGINE_IDS,
  mechanicsFamilies,
  mechanicsLimits,
  mechanicsModels,
  mechanicsVersions,
  splitMechanicsDocument,
} from '@/lib/simulatorMechanics';
import { coreAnalyteFor } from '@/lib/forwardCoreAdapter';
import { loadGeneratedRegistry } from '@/lib/kinetics-core/generated-registry-loader';
import { GENERATED_REGISTRY_ARTIFACT } from '@/lib/kinetics-core/generated-registry';
import { findModel as findReviewedModel, registeredAnalytes as reviewedAnalytes } from '@/lib/kinetics-core';
import { DEFAULT_DRAW_COUNT, DEFAULT_SEED } from '@/stores/simulatorStore';
import {
  applyCautiousDefaults,
  applyKaInference,
  CAUTIOUS_DEFAULT_BIOAVAILABILITY,
  resolveDrugModelsByRoute,
} from '@/lib/modelDerivation';

const DOC_PATH = resolve(__dirname, '../../../docs/simulator-mechanics.md');
const doc = readFileSync(DOC_PATH, 'utf8');

/** A minimal runnable scenario, so the prose claims can be checked against real behaviour. */
function scenario(
  overrides: Partial<CanonicalScenario> = {},
): CanonicalScenario {
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    analyte: 'amphetamine',
    subject: { weightKg: 70 },
    doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'parent' }],
    timeGrid: { startHours: 0, endHours: 24, stepHours: 0.5 },
    ...overrides,
  } as CanonicalScenario;
}

describe('mechanics document — structure', () => {
  it('requests only live blocks the page implements', () => {
    const requested = splitMechanicsDocument(doc)
      .filter((p): p is { kind: 'live'; id: string } => p.kind === 'live')
      .map((p) => p.id);
    expect(requested.length).toBeGreaterThan(0);
    for (const id of requested) {
      expect(LIVE_BLOCK_IDS as readonly string[]).toContain(id);
    }
  });

  it('leaves no unresolved token in the prose chunks', () => {
    for (const part of splitMechanicsDocument(doc)) {
      if (part.kind === 'prose') expect(part.text).not.toMatch(/\{\{live:/);
    }
  });

  it('names the files that keep it honest, so the contract is discoverable', () => {
    expect(doc).toContain('src/lib/__tests__/simulatorMechanics.test.ts');
    expect(doc).toContain('/modeling/how-it-works');
  });
});

describe('mechanics document — engine vocabulary', () => {
  it('describes every compute engine a component can select', () => {
    // The document's §1 table is the reader's map of the module; an engine missing from it
    // is a whole capability the reviewer never learns exists.
    for (const engine of MECHANICS_ENGINE_IDS) {
      expect(doc).toContain(engine);
    }
  });

  it('publishes every implemented model family', () => {
    const published = mechanicsFamilies().map((f) => f.family);
    expect(published).toEqual([...MODEL_FAMILIES]);
    for (const family of MODEL_FAMILIES) {
      expect(MODEL_FAMILY_EVALUATION[family]).toMatch(/^(closed-form|ode)$/);
    }
  });

  it('classifies the ODE families the document names as numerically integrated', () => {
    // §3 step 4 states these three are integrated rather than superposed. If a family
    // moves between the two evaluation strategies, that paragraph is wrong.
    expect(MODEL_FAMILY_EVALUATION['two-compartment-first-order']).toBe('ode');
    expect(MODEL_FAMILY_EVALUATION['michaelis-menten']).toBe('ode');
    expect(MODEL_FAMILY_EVALUATION['parent-metabolite-first-order']).toBe(
      'ode',
    );
    expect(MODEL_FAMILY_EVALUATION['one-compartment-first-order']).toBe(
      'closed-form',
    );
  });

  it('publishes the engine route vocabulary', () => {
    const routes = new Set(
      mechanicsModels().flatMap((m) => m.routes.map((r) => r.route)),
    );
    for (const route of routes) {
      expect(ROUTE_IDS as readonly string[]).toContain(route);
    }
  });
});

describe('mechanics document — published inventory', () => {
  it('lists at least one resolvable model, with an id, matrix and validation status', () => {
    const models = mechanicsModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.modelId).toBeTruthy();
      expect(m.matrix).toBeTruthy();
      expect(m.validationStatus).toBeTruthy();
      expect(m.routes.length).toBeGreaterThan(0);
    }
  });

  it('marks a model needing more than body weight as not runnable from the UI', () => {
    // §8.1 is the document's sharpest claim about the current build. It is only honest if
    // the page's own "runs from the simulator UI" column is computed the same way the
    // engine gates the run — so check the column against the engine, model by model.
    for (const model of mechanicsModels()) {
      for (const route of model.routes) {
        const result = simulateScenario(
          scenario({
            analyte: model.analyte,
            doses: [
              { tHours: 0, amountMg: 10, route: route.route, basis: 'parent' },
            ],
          }),
        );
        const failedForCovariate =
          !result.ok &&
          result.failure === 'invalid-input' &&
          /requires the subject/.test(result.detail ?? '');
        expect(failedForCovariate).toBe(route.requiredCovariates.length > 0);
      }
    }
  });

  it('reports the release identifiers a run manifest is stamped with', () => {
    const v = mechanicsVersions();
    expect(v.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.registryVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.registryChecksum).toBeTruthy();
    expect(v.scenarioSchemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
    expect(simulateScenario(scenario()).manifest.registryChecksum).toBe(
      v.registryChecksum,
    );
  });

  it('publishes the guardrails straight from the engine and the store', () => {
    const byId = Object.fromEntries(
      mechanicsLimits().map((l) => [l.id, l.value]),
    );
    expect(byId.maxDraws).toBe(ENGINE_LIMITS.maxDraws);
    expect(byId.maxGridPoints).toBe(ENGINE_LIMITS.maxGridPoints);
    expect(byId.maxSimCells).toBe(ENGINE_LIMITS.maxSimCells);
    expect(byId.maxOdeWork).toBe(ENGINE_LIMITS.maxOdeWork);
    expect(byId.maxOdeDoses).toBe(ENGINE_LIMITS.maxOdeDoses);
    expect(byId.notRobustSurvivingDrawRatio).toBe(
      ENGINE_LIMITS.notRobustSurvivingDrawRatio,
    );
    expect(byId.minSubjectWeightKg).toBe(ENGINE_LIMITS.minSubjectWeightKg);
    expect(byId.defaultDraws).toBe(DEFAULT_DRAW_COUNT);
    expect(byId.defaultSeed).toBe(DEFAULT_SEED);
    expect(byId.peakRefineStepHours).toBe(ENGINE_LIMITS.peakRefineStepHours);
    expect(byId.maxPeakRefineSamples).toBe(ENGINE_LIMITS.maxPeakRefineSamples);
    expect(byId.maxPeakRefineEvals).toBe(ENGINE_LIMITS.maxPeakRefineEvals);
    expect(byId.minPeakRefineScan).toBe(ENGINE_LIMITS.minPeakRefineScan);
  });

  it('publishes EVERY guardrail the engine exports, not a chosen subset', () => {
    // The page introduces this table as "every number that configures or bounds a run".
    // That is an exhaustiveness claim, so it has to be checked as one: a guardrail added
    // to `ENGINE_LIMITS` and not published here would quietly falsify the page. Keying on
    // the exported record rather than a hand-listed set is what makes the check survive a
    // constant nobody thought to add to a test.
    const published = new Set(mechanicsLimits().map((l) => l.id));
    for (const key of Object.keys(ENGINE_LIMITS)) {
      expect(published.has(key)).toBe(true);
    }
  });
});

describe('mechanics document — draw-count normalisation', () => {
  it('states that a draw-count override is clamped to the engine cap, not rejected (§8)', () => {
    expect(doc).toMatch(/draw-count override is normalised/);
    expect(doc).toMatch(/clamped to it/);
    expect(doc).toMatch(/reverts\s+to the default/);
  });
});

describe('mechanics document — the refusals it promises', () => {
  it('refuses an analyte the resolved release has no model for, rather than improvising one (§2)', () => {
    const result = simulateScenario(
      scenario({ analyte: 'a-drug-with-no-model-in-any-tier' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('insufficient-model-data');
  });

  it('refuses a route the model does not declare (§3 step 1)', () => {
    const model = mechanicsModels()[0]!;
    const undeclared = ROUTE_IDS.find(
      (r) => !model.routes.some((mr) => mr.route === r),
    );
    expect(undeclared).toBeDefined();
    const result = simulateScenario(
      scenario({
        analyte: model.analyte,
        doses: [
          { tHours: 0, amountMg: 10, route: undeclared!, basis: 'parent' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unsupported-scenario');
  });

  it('refuses a subject below the minimum weight rather than extrapolating (§8)', () => {
    const result = simulateScenario(
      scenario({
        subject: { weightKg: ENGINE_LIMITS.minSubjectWeightKg / 2 },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('invalid-input');
  });

  it('reports the median as the deterministic curve, not the sampled p50 (§3 step 4)', () => {
    const deterministic = simulateScenario(scenario());
    const sampled = simulateScenario(
      scenario({ uncertainty: { seed: DEFAULT_SEED, draws: 500 } }),
    );
    expect(deterministic.ok && sampled.ok).toBe(true);
    if (!deterministic.ok || !sampled.ok) return;
    for (let i = 0; i < deterministic.timeSeries.length; i++) {
      expect(sampled.timeSeries[i]!.median).toBeCloseTo(
        deterministic.timeSeries[i]!.median,
        12,
      );
    }
  });

  it('collapses every band onto the median on a deterministic run (§3 step 5)', () => {
    const result = simulateScenario(scenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const point of result.timeSeries) {
      expect(point.p05).toBe(point.median);
      expect(point.p95).toBe(point.median);
    }
  });

  it('reports a band no wider than the median when a model carries no spread (§8)', () => {
    // §8 tells a reviewer that a curve with no visible band is an UNCHARACTERISED
    // prediction, not a precise one, and the page's "uncertainty bands" column says which
    // models are in that state. Check the column against a real Monte-Carlo run: if a
    // model gains a parameter distribution, this flips and the column follows — and if it
    // flips WITHOUT the column following, that is the drift this guard exists to catch.
    for (const model of mechanicsModels()) {
      if (!model.runsOnWeightOnlySubject) continue;
      const result = simulateScenario(
        scenario({
          analyte: model.analyte,
          doses: [
            {
              tHours: 0,
              amountMg: 20,
              route: model.routes[0]!.route,
              basis: 'parent',
            },
          ],
          uncertainty: { seed: DEFAULT_SEED, draws: 300 },
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const spreads = result.timeSeries.some(
        (p) => Math.abs(p.p95 - p.p05) > 1e-12,
      );
      expect(spreads).toBe(model.bandsCarryUncertainty);
    }
  });

  it('is reproducible for a fixed seed (§9 strengths)', () => {
    const run = () =>
      simulateScenario(
        scenario({ uncertainty: { seed: DEFAULT_SEED, draws: 200 } }),
      );
    const a = run();
    const b = run();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.timeSeries).toEqual(a.timeSeries);
    expect(b.peak).toEqual(a.peak);
  });

  it('surfaces a recorded-but-unmodelled covariate as a limitation (§3 step 3)', () => {
    const result = simulateScenario(
      scenario({
        subject: { weightKg: 70, liverImpairment: 'severe' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.limitations.some((l) => l.code === 'covariate-not-modelled'),
    ).toBe(true);
  });

  it('refuses a cross-matrix request with no reviewed transform (§3 step 7)', () => {
    const model = mechanicsModels().find(
      (m) => m.matrixTransforms.length === 0 && m.runsOnWeightOnlySubject,
    );
    expect(model).toBeDefined();
    const other = model!.matrix === 'plasma' ? 'whole_blood' : 'plasma';
    const result = simulateScenario(
      scenario({
        analyte: model!.analyte,
        doses: [
          {
            tHours: 0,
            amountMg: 10,
            route: model!.routes[0]!.route,
            basis: 'parent',
          },
        ],
        matrix: other as CanonicalScenario['matrix'],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unsupported-scenario');
  });

  it('refuses a dose basis the model cannot consume (§3 step 1)', () => {
    const model = mechanicsModels().find((m) => m.runsOnWeightOnlySubject)!;
    const result = simulateScenario(
      scenario({
        analyte: model.analyte,
        doses: [
          {
            tHours: 0,
            amountMg: 10,
            route: model.routes[0]!.route,
            basis: 'salt',
          },
        ],
      }),
    );
    // Only meaningful for a model that does NOT declare the salt basis; every model in the
    // release today declares parent/active-moiety only, which is what §3 describes.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unsupported-scenario');
  });
});

describe('mechanics document — resolving the model (§3 step 1)', () => {
  it('tries the catalogue slug before the name-derived id, as step 1 states', () => {
    expect(doc).toContain(
      '**A drug picked from the catalogue is tried\nunder its catalogue slug first, then under an id formed from its English name.**',
    );
    // A slug the build does not resolve falls through to the name-derived id a reviewed model uses.
    expect(coreAnalyteFor(['etanol', 'ethanol'])).toBe('ethanol');
    // A slug the build does resolve wins over the name.
    expect(coreAnalyteFor(['ethanol', 'not-a-model'])).toBe('ethanol');
  });
});

describe('mechanics document — live derived tier (§2)', () => {
  const reviewed = reviewedAnalytes().map((analyte) => findReviewedModel(analyte)!);
  const committed = GENERATED_REGISTRY_ARTIFACT.derivedDefinitions[0]!;

  it('builds the derived tier live and stamps a +live release, as §2 states', () => {
    expect(doc).toContain(
      '**The derived tier is built live from the catalogue; the reviewed tier stays pinned.**',
    );
    expect(doc).toContain('versioned `<version>+live`');
    expect(doc).toContain('each live build carries its own model id (`<id>+live.<hash>`)');
    const replaced = { ...committed, displayName: 'live answer' };
    const release = loadGeneratedRegistry(reviewed, GENERATED_REGISTRY_ARTIFACT, [
      { analyte: committed.analyte, definition: replaced, grade: null },
    ]);
    expect(release.snapshot.version).toBe(`${GENERATED_REGISTRY_ARTIFACT.registryVersion}+live`);
    expect(release.snapshot.checksum).not.toBe(GENERATED_REGISTRY_ARTIFACT.checksum);
    expect(
      release.snapshot.definitions.find((d) => d.analyte === committed.analyte)?.displayName,
    ).toBe('live answer');
  });

  it('withdraws a drug whose data no longer builds a model, as §2 states', () => {
    expect(doc).toContain('stops resolving, rather than running on what it used to have');
    const release = loadGeneratedRegistry(reviewed, GENERATED_REGISTRY_ARTIFACT, [
      { analyte: committed.analyte, definition: null, grade: null },
    ]);
    expect(release.snapshot.definitions.some((d) => d.analyte === committed.analyte)).toBe(false);
  });

  it('never lets a live answer displace a reviewed model, as §2 states', () => {
    expect(doc).toContain('a live answer can never displace one');
    const ethanol = findReviewedModel('ethanol')!;
    const release = loadGeneratedRegistry(reviewed, GENERATED_REGISTRY_ARTIFACT, [
      { analyte: 'ethanol', definition: { ...committed, analyte: 'ethanol' }, grade: null },
    ]);
    expect(release.snapshot.definitions.find((d) => d.analyte === 'ethanol')).toEqual(ethanol);
  });
});

describe('mechanics document — catalogue-derived structure (§5)', () => {
  const derive = (dispositionModels: string[], eliminationModels: string[] = []) =>
    resolveDrugModelsByRoute({
      dispositionModels,
      eliminationModels,
      routes: { oral: { absorption: 'first-order' } },
      presentParameters: ['halfLife', 'volumeOfDistribution'],
    })[0]!;

  it('simplifies a cited two-compartment disposition to one-compartment, as §5 states', () => {
    expect(doc).toContain('**A declared structure can also be simplified.**');
    const fallback = derive(['two-compartment']).dispositionFallback;
    expect(fallback?.structure.disposition).toBe('one-compartment');
    expect(fallback?.family).toBe('one-compartment-first-order');
  });

  it('never simplifies a saturable elimination to first-order, as §5 states', () => {
    expect(doc).toContain('Only disposition is ever simplified this way');
    const saturable = derive([], ['michaelis-menten']);
    expect(saturable.dispositionFallback).toBeUndefined();
    expect(saturable.family).toBe('michaelis-menten');
  });

  it('builds a saturable curve only from a stored Vmax and Km, as §5 states', () => {
    expect(doc).toContain('**A saturable elimination is built from its own two numbers.**');
    const saturable = derive([], ['michaelis-menten']);
    const base = { ka: 1, eliminationHalfLife: 4, vd: 0.6, bioavailability: 0.8 };
    expect(assembleRouteParams(saturable, { ...base, vmax: 15, km: 12 })).toMatchObject({
      outcome: 'assembled',
      family: 'michaelis-menten',
    });
    // "Until both are stored, the drug gets no curve."
    expect(assembleRouteParams(saturable, { ...base, vmax: 15 }).outcome).toBe('incomplete');
    // "A recorded Tmax is never solved for an absorption rate."
    expect(doc).toContain('a recorded Tmax is\n  never solved for an absorption rate');
    const withoutKa = applyKaInference(saturable, { eliminationHalfLife: 4, vd: 0.6 }, 1);
    expect(withoutKa.values.ka).toBeUndefined();
  });

  it('defaults only a missing F, to 100 %, as §5 states', () => {
    expect(doc).toContain('**A missing bioavailability takes a cautious default.**');
    expect(doc).toContain('(F = 100 %)');
    expect(CAUTIOUS_DEFAULT_BIOAVAILABILITY).toBe(1);
    const oral = derive([]);
    expect(
      applyCautiousDefaults(oral, { eliminationHalfLife: 4, vd: 1 }).defaultedParameters,
    ).toEqual(['bioavailability']);
    // "Nothing else is defaulted": not the absorption rate, the half-life or the volume.
    expect(doc).toContain('Nothing else is defaulted');
    const sparse = applyCautiousDefaults(oral, {});
    expect(sparse.values.ka).toBeUndefined();
    expect(sparse.values.vd).toBeUndefined();
    expect(sparse.values.eliminationHalfLife).toBeUndefined();
  });

  it('draws an input across its published spread, peaked at the median, as §5 states', () => {
    expect(doc).toContain('**Each input is drawn across its published spread.**');
    expect(doc).toContain('An input with only one reported value stays fixed at it.');
    const assembled = assembleRouteParams(
      derive([]),
      { ka: 1, eliminationHalfLife: 4, vd: 1, bioavailability: 0.8 },
      { ranges: { eliminationHalfLife: { low: 2, high: 9 } } },
    );
    expect(assembled.outcome).toBe('assembled');
    if (assembled.outcome !== 'assembled' || assembled.params.family !== 'one-compartment-first-order') {
      return;
    }
    expect(assembled.params.eliminationHalfLifeHours).toMatchObject({
      kind: 'triangular',
      min: 2,
      mode: 4,
      max: 9,
      bounds: { kind: 'extrema' },
    });
    expect(assembled.params.vdLitersPerKg).toEqual({ kind: 'fixed', value: 1 });
  });
});
