/**
 * Golden cross-application parity test.
 *
 * Runs every scenario in parity-scenarios.json through the engine and asserts it
 * reproduces the committed golden result in parity-expected.json. The SAME two
 * fixture files are vendored into Redose, whose copy runs the SAME assertion
 * against its vendored kinetics-core — so if Kinetix and Redose ever diverge (or
 * either drifts from the golden), a test fails in that repo.
 *
 * To intentionally change the science: edit the engine/registry, run
 * `npx tsx src/lib/kinetics-core/fixtures/generate-expected.ts`, review the diff,
 * and re-vendor into Redose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simulateScenario } from '../simulate';
import type { CanonicalResult, CanonicalScenario } from '../types';

const dir = join(__dirname, '../fixtures');
const fixtures = JSON.parse(
  readFileSync(join(dir, 'parity-scenarios.json'), 'utf8'),
) as {
  nowIso: string;
  tolerance: { absolute: number; relative: number };
  scenarios: Array<{
    name: string;
    scenario: CanonicalScenario;
    /**
     * Optional per-scenario tolerance override. ODE (RK4) scenarios get a looser,
     * model-specific tolerance than the global analytic 1e-9, because RK4
     * accumulation can diverge slightly across runtimes (V8 vs Hermes) — the plan
     * mandates convergence-based, not bit-exact, tolerances for ODE models.
     */
    tolerance?: { absolute: number; relative: number };
  }>;
};
const expected = JSON.parse(
  readFileSync(join(dir, 'parity-expected.json'), 'utf8'),
) as Record<string, CanonicalResult>;

type Tol = { absolute: number; relative: number };

function closeEnough(a: number, b: number, tol: Tol) {
  const diff = Math.abs(a - b);
  return diff <= tol.absolute + tol.relative * Math.abs(b);
}

/**
 * Deep structural comparison of the FULL CanonicalResult against the golden.
 * Numbers must be within tolerance (so floats agree across runtimes); every
 * other field — status, limitations, modelSummary, the whole manifest
 * (seed/draws/acceptedDraws/createdAtIso/...), peak.tHours, ok/failure — must
 * match exactly, and the key sets must match so nothing can be added or dropped.
 * The entire golden CanonicalResult is the harmonization contract.
 */
function deepMatch(got: unknown, want: unknown, tol: Tol, path = 'result'): void {
  if (typeof want === 'number') {
    expect(typeof got, `${path}: expected a number`).toBe('number');
    expect(
      closeEnough(got as number, want, tol),
      `${path}: ${String(got)} vs ${String(want)}`,
    ).toBe(true);
    return;
  }
  if (want === null || typeof want !== 'object') {
    expect(got, path).toBe(want);
    return;
  }
  if (Array.isArray(want)) {
    expect(Array.isArray(got), `${path}: expected an array`).toBe(true);
    expect((got as unknown[]).length, `${path}: length`).toBe(want.length);
    for (let i = 0; i < want.length; i++) {
      deepMatch((got as unknown[])[i], want[i], tol, `${path}[${i}]`);
    }
    return;
  }
  expect(got !== null && typeof got === 'object', `${path}: expected an object`).toBe(true);
  const gotKeys = Object.keys(got as object).sort();
  const wantKeys = Object.keys(want as object).sort();
  expect(gotKeys, `${path}: key set`).toEqual(wantKeys);
  for (const key of wantKeys) {
    deepMatch(
      (got as Record<string, unknown>)[key],
      (want as Record<string, unknown>)[key],
      tol,
      `${path}.${key}`,
    );
  }
}

describe('cross-app parity fixtures', () => {
  for (const { name, scenario, tolerance } of fixtures.scenarios) {
    it(name, () => {
      const got = simulateScenario(scenario, fixtures.nowIso);
      const want = expected[name];
      expect(want, `${name}: missing golden`).toBeDefined();
      // Compare the entire CanonicalResult, not a hand-picked subset. ODE
      // scenarios may carry a looser per-scenario tolerance (see the type doc).
      deepMatch(got, want, tolerance ?? fixtures.tolerance, name);
    });
  }
});
