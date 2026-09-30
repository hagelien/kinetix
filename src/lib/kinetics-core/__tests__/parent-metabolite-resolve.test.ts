/**
 * SC-3A part 2 — parent/metabolite ENGINE WIRING (the resolve + summary contract).
 *
 * Part 1 (`parent-metabolite.test.ts`) validates the coupled curve/mass-balance/horizon
 * against closed forms. This file asserts the piece part 2 adds: how the engine RESOLVES
 * a `ParentMetaboliteRouteParams` block into a `ParentMetaboliteResolvedRoute` + a
 * `ResolvedRouteSummary`, through the same exported `resolveParentMetaboliteRoute` the
 * engine's ODE path uses. It is tested directly (not through `simulateScenario`) because
 * no parent/metabolite model ships in the registry yet — the first reviewed vertical is
 * evidence-gated (SC-3B) — exactly as the `one-compartment-clv` family is tested via
 * `resolveRouteKernel`.
 *
 *   - central resolution maps every field and DERIVES both `ke = ln2/t½`;
 *   - both volumes scale by the subject scale factor;
 *   - the top-level summary describes the PARENT (the scenario's primary analyte) and the
 *     `parentMetabolite` block carries the metabolite + molar↔mass stoichiometry;
 *   - the physicality gate rejects a non-physical draw (F>1, fm>1, F=0, Vd≤0, mw≤0)
 *     rather than emitting a clamped curve;
 *   - a fixed seed is deterministic (the per-parameter draw order is a parity contract).
 */
import { describe, it, expect } from 'vitest';
import { resolveParentMetaboliteRoute } from '../simulate';
import { fixed, uniform } from '../param';
import { eliminationConstant } from '../equations';
import { PRNG } from '../rng';
import type { ParentMetaboliteRouteParams } from '../types';

const base: ParentMetaboliteRouteParams = {
  family: 'parent-metabolite-first-order',
  kaPerHour: fixed(1.2),
  bioavailability: fixed(0.75),
  parentEliminationHalfLifeHours: fixed(2),
  parentVdLitersPerKg: fixed(0.7),
  formationFraction: fixed(0.6),
  parentMolarMass: 200,
  metaboliteMolarMass: 180,
  metaboliteEliminationHalfLifeHours: fixed(5),
  metaboliteVdLitersPerKg: fixed(0.5),
  metaboliteAnalyte: 'demo-metabolite',
};

describe('SC-3A part 2 — parent/metabolite resolve + summary contract', () => {
  it('maps every field, derives both ke, and scales both volumes by scaleKg', () => {
    const scaleKg = 70;
    const { resolved, valid } = resolveParentMetaboliteRoute('oral', base, scaleKg, undefined);
    expect(valid).toBe(true);
    expect(resolved.kaPerHour).toBeCloseTo(1.2, 12);
    expect(resolved.bioavailability).toBeCloseTo(0.75, 12);
    expect(resolved.keParentPerHour).toBeCloseTo(eliminationConstant(2), 12);
    expect(resolved.keMetabolitePerHour).toBeCloseTo(eliminationConstant(5), 12);
    expect(resolved.vdParentLiters).toBeCloseTo(0.7 * scaleKg, 12);
    expect(resolved.vdMetaboliteLiters).toBeCloseTo(0.5 * scaleKg, 12);
    expect(resolved.formationFraction).toBeCloseTo(0.6, 12);
    expect(resolved.molarMassParent).toBe(200);
    expect(resolved.molarMassMetabolite).toBe(180);
  });

  it('the top-level summary describes the PARENT; the metabolite lives in its own block', () => {
    const { summary } = resolveParentMetaboliteRoute('oral', base, 70, undefined);
    expect(summary.family).toBe('parent-metabolite-first-order');
    // Top-level = parent (the primary analyte the scenario names).
    expect(summary.kaPerHour).toBeCloseTo(1.2, 12);
    expect(summary.eliminationHalfLifeHours).toBeCloseTo(2, 12);
    expect(summary.vdLiters).toBeCloseTo(0.7 * 70, 12);
    expect(summary.bioavailability).toBeCloseTo(0.75, 12);
    // The metabolite + stoichiometry are diffable from the dedicated block.
    const pm = summary.parentMetabolite;
    expect(pm).toBeDefined();
    expect(pm!.metaboliteAnalyte).toBe('demo-metabolite');
    expect(pm!.formationFraction).toBeCloseTo(0.6, 12);
    expect(pm!.parentMolarMass).toBe(200);
    expect(pm!.metaboliteMolarMass).toBe(180);
    expect(pm!.metaboliteEliminationHalfLifeHours).toBeCloseTo(5, 12);
    expect(pm!.metaboliteVdLiters).toBeCloseTo(0.5 * 70, 12);
  });

  it('a fully unabsorbed metabolite (fm = 0) is a valid model, not a failure', () => {
    const { valid } = resolveParentMetaboliteRoute(
      'oral',
      { ...base, formationFraction: fixed(0) },
      70,
      undefined,
    );
    expect(valid).toBe(true);
  });

  it.each([
    ['bioavailability > 1', { bioavailability: fixed(1.5) }],
    ['bioavailability = 0', { bioavailability: fixed(0) }],
    ['formation fraction > 1', { formationFraction: fixed(1.4) }],
    ['non-positive parent Vd', { parentVdLitersPerKg: fixed(0) }],
    ['non-positive metabolite Vd', { metaboliteVdLitersPerKg: fixed(-0.1) }],
    ['non-positive parent molar mass', { parentMolarMass: 0 }],
    ['non-finite metabolite molar mass', { metaboliteMolarMass: Number.NaN }],
    ['non-positive parent half-life', { parentEliminationHalfLifeHours: fixed(0) }],
  ] as const)('rejects a non-physical route: %s', (_label, patch) => {
    const { valid } = resolveParentMetaboliteRoute(
      'oral',
      { ...base, ...patch } as ParentMetaboliteRouteParams,
      70,
      undefined,
    );
    expect(valid).toBe(false);
  });

  it('is deterministic for a fixed seed (the per-parameter draw order is a parity contract)', () => {
    // Distinct distributions per parameter so a reordered draw would change the values.
    const varied: ParentMetaboliteRouteParams = {
      ...base,
      kaPerHour: uniform(1.0, 1.4),
      bioavailability: uniform(0.6, 0.9),
      parentEliminationHalfLifeHours: uniform(1.5, 2.5),
      parentVdLitersPerKg: uniform(0.6, 0.8),
      formationFraction: uniform(0.4, 0.7),
      metaboliteEliminationHalfLifeHours: uniform(4, 6),
      metaboliteVdLitersPerKg: uniform(0.4, 0.6),
    };
    const a = resolveParentMetaboliteRoute('oral', varied, 70, new PRNG(12345)).resolved;
    const b = resolveParentMetaboliteRoute('oral', varied, 70, new PRNG(12345)).resolved;
    expect(b).toEqual(a);
    // A different seed must actually move the draw (guards against silently ignoring rng).
    const c = resolveParentMetaboliteRoute('oral', varied, 70, new PRNG(67890)).resolved;
    expect(c.kaPerHour).not.toBeCloseTo(a.kaPerHour, 9);
  });
});
