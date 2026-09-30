import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '@/lib/kinetics-core';
import {
  migrateDrugConfig,
} from '@/lib/eventDerivation';
import { runWithinComputeBudget } from '@/lib/modelingRun';
import type { CanonicalResult } from '@/lib/kinetics-core';
import type { DrugSimConfig } from '@/types/simulator';

describe('draw override normalisation on load', () => {
  const load = (drawCount: number) =>
    migrateDrugConfig({ id: 'a', overrides: { drawCount } } as unknown as DrugSimConfig)
      .overrides.drawCount;

  it('caps at the engine limit and truncates fractions', () => {
    expect(load(1_000_000)).toBe(ENGINE_LIMITS.maxDraws);
    expect(load(12.7)).toBe(12);
    expect(load(5000)).toBe(5000);
  });

  it('drops a non-positive or non-finite value so the default applies', () => {
    expect(load(0)).toBeUndefined();
    expect(load(NaN)).toBeUndefined();
  });
});

describe('runWithinComputeBudget', () => {
  const refused = {
    ok: false,
    failure: 'invalid-input',
    detail: 'Scenario exceeds the compute budget (...)',
  } as unknown as CanonicalResult;
  const ok = { ok: true } as unknown as CanonicalResult;

  it('backs off until the engine admits the run', async () => {
    const tried: number[] = [];
    const result = await runWithinComputeBudget(200_000, async (n) => {
      tried.push(n);
      return n > 100_000 ? refused : ok;
    });
    expect(result.ok).toBe(true);
    expect(tried[0]).toBe(200_000);
    expect(tried.at(-1)!).toBeLessThanOrEqual(100_000);
  });

  it('keeps backing off below 100 draws when the budget still refuses', async () => {
    const result = await runWithinComputeBudget(4000, async (n) =>
      n > 77 ? refused : ok,
    );
    expect(result.ok).toBe(true);
  });

  it('does not retry other failures', async () => {
    const other = { ok: false, failure: 'invalid-input', detail: 'bad dose' } as unknown as CanonicalResult;
    let calls = 0;
    const result = await runWithinComputeBudget(5000, async () => {
      calls++;
      return other;
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
