/**
 * #83 — the structural families assembled from catalog roles, pinned against closed forms.
 *
 * `assembleRouteParams` now builds the two-compartment family (k12, k21, central volume V1, terminal
 * half-life) and carries an optional absorption lag, and the zero-order and mixed families get their
 * duration and first-order fraction from catalog roles. These tests check two things:
 *
 *   1. the assembler's own rules — which role fills which field (V1 is never the generic Vd), when a
 *      route is incomplete, and when the values contradict the family (k21 ≤ ln2/t½);
 *   2. that what it builds RUNS as the model the numbers describe: each assembled definition is
 *      simulated through the same live-derived path the app uses, and the curve is compared with the
 *      textbook closed form written out here independently of the engine's own equations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assembleDrugDefinition,
  assembleRouteParams,
  deriveModel,
  fixed,
  triangular,
  type AssemblyValues,
  type CanonicalScenario,
  type DrugDefinitionMetadata,
  type DrugModelDefinition,
  type RequiredParam,
} from '../index';
import type { ModelStructureDeclaration } from '../derive-model';

const TWO_COMP: ModelStructureDeclaration = {
  disposition: 'two-compartment',
  elimination: 'first-order',
  absorption: 'first-order',
};

const TWO_COMP_ROLES: RequiredParam[] = [
  'ka',
  'eliminationHalfLife',
  'k12',
  'k21',
  'centralVolume',
  'bioavailability',
];

/** A two-compartment route: terminal t½ 10 h (β = 0.0693 /h), k12 0.5 /h, k21 0.3 /h, V1 0.2 L/kg. */
const TWO_COMP_VALUES: AssemblyValues = {
  ka: 1.2,
  eliminationHalfLife: 10,
  k12: 0.5,
  k21: 0.3,
  centralVolume: 0.2,
  bioavailability: 0.8,
  // A generic steady-state Vd the drug also carries; it must NOT become V1.
  vd: 3,
};

describe('assembleRouteParams — two-compartment from k12, k21 and V1', () => {
  it('fills every field from its own role, the volume from V1 and never from the generic Vd', () => {
    const derived = deriveModel(TWO_COMP, TWO_COMP_ROLES);
    expect(derived.family).toBe('two-compartment-first-order');
    const result = assembleRouteParams(derived, TWO_COMP_VALUES);
    expect(result.outcome).toBe('assembled');
    if (result.outcome !== 'assembled') return;
    expect(result.params).toEqual({
      family: 'two-compartment-first-order',
      kaPerHour: fixed(1.2),
      eliminationHalfLifeHours: fixed(10),
      k12PerHour: fixed(0.5),
      k21PerHour: fixed(0.3),
      vdLitersPerKg: fixed(0.2),
      bioavailability: fixed(0.8),
    });
  });

  it('is incomplete without the micro-constants and V1, naming each — a Vd does not stand in', () => {
    const derived = deriveModel(TWO_COMP, ['ka', 'eliminationHalfLife', 'vd', 'bioavailability']);
    const result = assembleRouteParams(derived, {
      ka: 1.2,
      eliminationHalfLife: 10,
      vd: 3,
      bioavailability: 0.8,
    });
    expect(result.outcome).toBe('incomplete');
    if (result.outcome === 'incomplete') {
      expect([...result.missing].sort()).toEqual(['centralVolume', 'k12', 'k21']);
    }
  });

  it('refuses rates that cannot produce the terminal half-life (k21 ≤ ln2/t½) as a contradiction', () => {
    const derived = deriveModel(TWO_COMP, TWO_COMP_ROLES);
    // β = ln2/10 = 0.0693 /h; a k21 at or below it has no two-compartment model with that terminal
    // phase, and the engine would silently run k10 = β instead.
    for (const k21 of [0.05, Math.LN2 / 10]) {
      for (const absorptionLag of [undefined, 0.5]) {
        for (const missing of [undefined, 'k12', 'centralVolume'] as const) {
          const values = { ...TWO_COMP_VALUES, k21, absorptionLag };
          if (missing) delete values[missing];
          const result = assembleRouteParams(derived, values);
          expect(result.outcome).toBe('unsupported');
          if (result.outcome === 'unsupported') {
            expect(result.contradiction).toBe(true);
            expect(result.reason).toMatch(/k21/);
          }
        }
      }
    }
  });

  it('draws k21 and t½ across their spreads only when every pair the draws can make is coherent', () => {
    const derived = deriveModel(TWO_COMP, TWO_COMP_ROLES);
    const coherent = assembleRouteParams(derived, TWO_COMP_VALUES, {
      ranges: { k21: { low: 0.2, high: 0.4 }, eliminationHalfLife: { low: 8, high: 14 } },
    });
    expect(coherent.outcome).toBe('assembled');
    if (coherent.outcome === 'assembled' && coherent.params.family === 'two-compartment-first-order') {
      expect(coherent.params.k21PerHour).toEqual(triangular(0.2, 0.3, 0.4));
      expect(coherent.params.eliminationHalfLifeHours).toEqual(triangular(8, 10, 14));
    }
    // The lowest k21 (0.06) with the shortest half-life (8 h, β = 0.087) is incoherent: both spreads
    // are dropped to their medians rather than clipped. Other roles keep theirs.
    const incoherent = assembleRouteParams(derived, TWO_COMP_VALUES, {
      ranges: {
        k21: { low: 0.06, high: 0.4 },
        eliminationHalfLife: { low: 8, high: 14 },
        k12: { low: 0.3, high: 0.7 },
      },
    });
    expect(incoherent.outcome).toBe('assembled');
    if (incoherent.outcome === 'assembled' && incoherent.params.family === 'two-compartment-first-order') {
      expect(incoherent.params.k21PerHour).toEqual(fixed(0.3));
      expect(incoherent.params.eliminationHalfLifeHours).toEqual(fixed(10));
      expect(incoherent.params.k12PerHour).toEqual(triangular(0.3, 0.5, 0.7));
    }
  });

  it('refuses a stored lag, which the two-compartment route has no field for', () => {
    const derived = deriveModel(TWO_COMP, TWO_COMP_ROLES);
    const result = assembleRouteParams(derived, { ...TWO_COMP_VALUES, absorptionLag: 0.5 });
    expect(result.outcome).toBe('unsupported');
    if (result.outcome === 'unsupported') {
      expect(result.contradiction).toBeUndefined();
      expect(result.reason).toMatch(/lag/);
    }
    // A lag that may be above zero is refused too, even with a median of zero.
    const spread = assembleRouteParams(derived, { ...TWO_COMP_VALUES, absorptionLag: 0 }, {
      ranges: { absorptionLag: { low: 0, high: 0.5 } },
    });
    expect(spread.outcome).toBe('unsupported');
    // A cited lag of exactly zero is "no lag", which the family honours by carrying none.
    const none = assembleRouteParams(derived, { ...TWO_COMP_VALUES, absorptionLag: 0 });
    expect(none.outcome).toBe('assembled');
    if (none.outcome === 'assembled') expect('absorptionLagHours' in none.params).toBe(false);
  });
});

describe('assembleRouteParams — the optional absorption lag', () => {
  const oral = () =>
    deriveModel({ disposition: 'one-compartment', absorption: 'first-order' }, [
      'ka',
      'eliminationHalfLife',
      'vd',
      'bioavailability',
    ]);
  const values = { ka: 1, eliminationHalfLife: 4, vd: 0.7, bioavailability: 0.8 };

  it('carries a stored lag, including a cited lag of zero, and omits one that is not stored', () => {
    for (const absorptionLag of [0.5, 0]) {
      const result = assembleRouteParams(oral(), { ...values, absorptionLag });
      expect(result.outcome).toBe('assembled');
      if (result.outcome === 'assembled' && result.params.family === 'one-compartment-first-order') {
        expect(result.params.absorptionLagHours).toEqual(fixed(absorptionLag));
      }
    }
    const none = assembleRouteParams(oral(), values);
    if (none.outcome === 'assembled') expect('absorptionLagHours' in none.params).toBe(false);
  });

  it('draws a lag spread that starts at zero, and treats a negative lag as unusable', () => {
    const ranged = assembleRouteParams(oral(), { ...values, absorptionLag: 0.25 }, {
      ranges: { absorptionLag: { low: 0, high: 0.5 } },
    });
    if (ranged.outcome === 'assembled' && ranged.params.family === 'one-compartment-first-order') {
      expect(ranged.params.absorptionLagHours).toEqual(triangular(0, 0.25, 0.5));
    }
    const negative = assembleRouteParams(oral(), { ...values, absorptionLag: -0.5 });
    expect(negative.outcome).toBe('incomplete');
    if (negative.outcome === 'incomplete') expect(negative.missing).toEqual(['absorptionLag']);
  });

  it('refuses a lag on the saturable family rather than drawing a curve without it', () => {
    const saturable = deriveModel(
      { disposition: 'one-compartment', elimination: 'michaelis-menten', absorption: 'first-order' },
      ['ka', 'vmax', 'km', 'vd', 'bioavailability', 'eliminationHalfLife'],
    );
    const result = assembleRouteParams(saturable, {
      ka: 1,
      vmax: 10,
      km: 20,
      eliminationHalfLife: 4,
      vd: 0.6,
      bioavailability: 0.8,
      absorptionLag: 0.5,
    });
    expect(result.outcome).toBe('unsupported');
  });
});

// ─── The assembled models, run, against their closed forms ──────────────────────

type Core = typeof import('../index.js');

const WEIGHT_KG = 70;
const DOSE_MG = 100;
const NOW = '2026-10-15T00:00:00.000Z';

const METADATA = (slug: string): DrugDefinitionMetadata => ({
  analyte: slug,
  displayName: slug,
  modelId: `${slug}-derived-v1`,
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedBases: ['active-moiety', 'parent'],
});

/** Assemble a one-route (oral) derived definition from a declaration and its values. */
function assembled(slug: string, declaration: ModelStructureDeclaration, values: AssemblyValues): DrugModelDefinition {
  const derived = deriveModel(declaration, Object.keys(values) as RequiredParam[]);
  const assembly = assembleDrugDefinition(METADATA(slug), [{ route: 'oral', derived, values }]);
  if (assembly.outcome !== 'assembled') {
    throw new Error(`fixture did not assemble: ${JSON.stringify(assembly.routeOutcomes)}`);
  }
  return assembly.definition;
}

/** Simulate one oral dose of an assembled definition through the live-derived registry path. */
async function simulate(definition: DrugModelDefinition, endHours: number, stepHours: number) {
  vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
  const core: Core = await import('../index.js');
  core.installLiveDerivedEntry({ analyte: definition.analyte, definition, grade: null });
  const scenario: CanonicalScenario = {
    schemaVersion: '1',
    analyte: definition.analyte,
    subject: { weightKg: WEIGHT_KG, age: 40, sex: 'male' },
    doses: [{ tHours: 0, amountMg: DOSE_MG, route: 'oral', basis: 'active-moiety' }],
    timeGrid: { startHours: 0, endHours, stepHours },
  };
  const result = core.simulateScenario(scenario, NOW);
  if (!result.ok) throw new Error(`simulation failed: ${result.failure} ${result.detail ?? ''}`);
  return result;
}

/** Oral one-compartment first-order input (Bateman), shifted by a lag. */
function bateman(f: number, dose: number, v: number, ka: number, ke: number, t: number): number {
  if (t <= 0) return 0;
  return ((f * dose * ka) / (v * (ka - ke))) * (Math.exp(-ke * t) - Math.exp(-ka * t));
}

/** Constant-rate input of `amount` over `duration` into a one-compartment space. */
function zeroOrderInput(amount: number, duration: number, v: number, ke: number, t: number): number {
  if (t <= 0) return 0;
  const plateau = amount / duration / (v * ke);
  if (t <= duration) return plateau * (1 - Math.exp(-ke * t));
  return plateau * (1 - Math.exp(-ke * duration)) * Math.exp(-ke * (t - duration));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('assembled structural families reproduce their closed forms', () => {
  it('two-compartment: the tri-exponential oral solution, with a visible distribution (alpha) phase', async () => {
    const { ka, eliminationHalfLife, k12, k21, centralVolume, bioavailability } = TWO_COMP_VALUES as Required<
      typeof TWO_COMP_VALUES
    >;
    const definition = assembled('two-comp-fixture', TWO_COMP, {
      ka,
      eliminationHalfLife,
      k12,
      k21,
      centralVolume,
      bioavailability,
    });
    const result = await simulate(definition, 24, 0.25);
    expect(result.modelSummary.routes[0]!.family).toBe('two-compartment-first-order');

    // Closed form (Gibaldi & Perrier): k10 from the terminal rate, then the two disposition roots.
    const beta = Math.LN2 / eliminationHalfLife;
    const k10 = (beta * (k12 + k21 - beta)) / (k21 - beta);
    const sum = k10 + k12 + k21;
    const root = Math.sqrt(sum * sum - 4 * k10 * k21);
    const alpha = (sum + root) / 2;
    const betaRoot = (sum - root) / 2;
    expect(betaRoot).toBeCloseTo(beta, 12); // the stored half-life IS the terminal phase
    const v1 = centralVolume * WEIGHT_KG;
    const a = (bioavailability * DOSE_MG * ka) / v1;
    const closedForm = (t: number) =>
      a *
      (((k21 - alpha) / ((ka - alpha) * (beta - alpha))) * Math.exp(-alpha * t) +
        ((k21 - beta) / ((ka - beta) * (alpha - beta))) * Math.exp(-beta * t) +
        ((k21 - ka) / ((alpha - ka) * (beta - ka))) * Math.exp(-ka * t));

    let checked = 0;
    for (const point of result.timeSeries) {
      if (point.tHours <= 0) continue;
      const expected = closedForm(point.tHours);
      expect(Math.abs(point.median - expected) / expected).toBeLessThan(1e-5);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(80);

    // The alpha phase is visible: the curve falls far faster soon after the peak than in the
    // terminal phase, which a one-compartment curve with the same half-life cannot do.
    const at = (t: number) => result.timeSeries.find((p) => Math.abs(p.tHours - t) < 1e-9)!.median;
    const earlySlope = Math.log(at(3) / at(4));
    const terminalSlope = Math.log(at(23) / at(24));
    expect(terminalSlope).toBeCloseTo(beta, 3);
    expect(earlySlope).toBeGreaterThan(3 * terminalSlope);
  });

  it('mixed parallel input with a lag: the superposed first-order and zero-order solutions', async () => {
    const values = {
      firstOrderFraction: 0.3,
      ka: 2,
      zeroOrderDuration: 8,
      eliminationHalfLife: 6,
      vd: 1.5,
      bioavailability: 0.7,
      absorptionLag: 0.75,
    };
    const definition = assembled(
      'mixed-fixture',
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'mixed' },
      values,
    );
    const result = await simulate(definition, 24, 0.25);
    const ke = Math.LN2 / values.eliminationHalfLife;
    const v = values.vd * WEIGHT_KG;
    for (const point of result.timeSeries) {
      const t = point.tHours - values.absorptionLag;
      const expected =
        bateman(values.bioavailability, values.firstOrderFraction * DOSE_MG, v, values.ka, ke, t) +
        zeroOrderInput(
          values.bioavailability * (1 - values.firstOrderFraction) * DOSE_MG,
          values.zeroOrderDuration,
          v,
          ke,
          t,
        );
      if (expected === 0) expect(point.median).toBe(0);
      else expect(Math.abs(point.median - expected) / expected).toBeLessThan(1e-9);
    }
  });

  it('zero-order input: the constant-rate solution, peaking at the end of input', async () => {
    const values = { zeroOrderDuration: 4, eliminationHalfLife: 5, vd: 0.8, bioavailability: 0.9 };
    const definition = assembled(
      'zero-order-fixture',
      { disposition: 'one-compartment', elimination: 'first-order', absorption: 'zero-order' },
      values,
    );
    const result = await simulate(definition, 16, 0.5);
    const ke = Math.LN2 / values.eliminationHalfLife;
    const v = values.vd * WEIGHT_KG;
    for (const point of result.timeSeries) {
      const expected = zeroOrderInput(values.bioavailability * DOSE_MG, values.zeroOrderDuration, v, ke, point.tHours);
      if (expected === 0) expect(point.median).toBe(0);
      else expect(Math.abs(point.median - expected) / expected).toBeLessThan(1e-9);
    }
    expect(result.peak.tHours).toBeCloseTo(values.zeroOrderDuration, 6);
  });
});
