import { describe, expect, it } from 'vitest';
import { hashRunInputs, isResultStale } from './resultStaleness';
import type { DrugSimConfig, DrugSimResult } from '@/types/simulator';

function baseConfig(overrides: Partial<DrugSimConfig> = {}): DrugSimConfig {
  return {
    id: 'cfg1',
    drugId: 'drug1',
    drugName: 'Test',
    label: 'Test',
    events: [
      { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
      { id: 'q', type: 'query', t: 2, solveFor: 'concentration' },
    ],
    route: 'oral',
    questionMode: 'concentration-from-dose',
    inputs: {},
    overrides: {},
    display: { visible: true },
    ...overrides,
  };
}

const result = (inputHash?: string): DrugSimResult =>
  ({ drugConfigId: 'cfg1', inputHash }) as DrugSimResult;

describe('hashRunInputs', () => {
  it('is stable across calls for identical inputs', () => {
    expect(hashRunInputs(baseConfig())).toBe(hashRunInputs(baseConfig()));
  });

  it('ignores display-only fields (label, colour, visibility)', () => {
    const a = hashRunInputs(baseConfig({ label: 'A' }));
    const b = hashRunInputs(
      baseConfig({ label: 'B', display: { visible: false, color: '#f00' } }),
    );
    expect(a).toBe(b);
  });

  it('changes when an event moves', () => {
    const a = hashRunInputs(baseConfig());
    const b = hashRunInputs(
      baseConfig({
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
          { id: 'q', type: 'query', t: 5, solveFor: 'concentration' },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it('changes when an override changes', () => {
    const a = hashRunInputs(baseConfig());
    const b = hashRunInputs(
      baseConfig({ overrides: { vd: { type: 'fixed', value: 60 } } }),
    );
    expect(a).not.toBe(b);
  });

  it('is insensitive to object key order', () => {
    const a = hashRunInputs(baseConfig({ overrides: { vd: { type: 'fixed', value: 60 }, f: { type: 'fixed', value: 0.8 } } }));
    const b = hashRunInputs(baseConfig({ overrides: { f: { type: 'fixed', value: 0.8 }, vd: { type: 'fixed', value: 60 } } }));
    expect(a).toBe(b);
  });
});

describe('isResultStale', () => {
  it('is false when the stamped hash matches current inputs', () => {
    const cfg = baseConfig();
    expect(isResultStale(cfg, result(hashRunInputs(cfg)))).toBe(false);
  });

  it('is true when inputs changed after the result was stamped', () => {
    const original = baseConfig();
    const stamped = result(hashRunInputs(original));
    const edited = baseConfig({
      overrides: { halfLife: { type: 'fixed', value: 9 } },
    });
    expect(isResultStale(edited, stamped)).toBe(true);
  });

  it('is false for results without a stamp (older saved cases)', () => {
    expect(isResultStale(baseConfig(), result(undefined))).toBe(false);
  });

  it('is false when there is no result', () => {
    expect(isResultStale(baseConfig(), undefined)).toBe(false);
  });
});
