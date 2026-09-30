/**
 * The uncertainty-layer contract (types for correlated IIV and scenario/input
 * uncertainty) landed ahead of the sampling that consumes it. These tests pin
 * the rule that closes the gap: a layer is REPORTED only when it was applied,
 * and a declaration the engine cannot yet sample is refused rather than run.
 */
import { describe, it, expect } from 'vitest';
import { simulateScenario } from '../simulate.js';
import type { CanonicalScenario } from '../types.js';

const NOW = '2026-01-01T00:00:00.000Z';

function scenario(overrides: Partial<CanonicalScenario> = {}): CanonicalScenario {
  return {
    schemaVersion: '1',
    analyte: 'amphetamine',
    subject: { weightKg: 70 },
    doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
    timeGrid: { startHours: 0, endHours: 12, stepHours: 0.5 },
    ...overrides,
  } as CanonicalScenario;
}

describe('uncertainty layers are reported only when applied', () => {
  it('omits uncertaintyLayers when no layer beyond the parameter specs applies', () => {
    const result = simulateScenario(scenario(), NOW);
    expect(result.ok).toBe(true);
    // Not `{fixedEffects, iiv: null, scenarioInputs: [], observationError: []}`:
    // a run that separated nothing must not claim a separation.
    expect(result.manifest.uncertaintyLayers).toBeUndefined();
  });

  it('refuses a scenario declaring dose uncertainty it cannot propagate', () => {
    const result = simulateScenario(
      scenario({
        doses: [
          {
            tHours: 0,
            amountMg: 30,
            route: 'oral',
            basis: 'active-moiety',
            uncertainty: { dose: { kind: 'uniform', min: 25, max: 35 } },
          },
        ],
      }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('unsupported-scenario');
    expect(result.detail).toContain('not implemented');
    // The refusal names the dose, so a caller can point at the input.
    expect(result.detail).toContain('dose 0');
  });

  it('refuses input uncertainty on any dose, not just the first', () => {
    const result = simulateScenario(
      scenario({
        doses: [
          { tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' },
          {
            tHours: 6,
            amountMg: 30,
            route: 'oral',
            basis: 'active-moiety',
            uncertainty: { administrationTime: { kind: 'uniform', min: 5, max: 7 } },
          },
        ],
      }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('dose 1');
  });
});
