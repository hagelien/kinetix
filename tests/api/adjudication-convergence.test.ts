import { describe, expect, it } from 'vitest';
import {
  compareOpinions,
  normaliseScopeKey,
  type ComparableOpinion,
} from '../../api/_lib/adjudication/convergence';

const clearance = { canonicalUnit: 'L/h', molecularWeight: null };
const concentration = { canonicalUnit: 'mg/L', molecularWeight: 303.4 };
const nonNumeric = { canonicalUnit: null, molecularWeight: null };

function opinion(extra: Partial<ComparableOpinion> = {}): ComparableOpinion {
  return {
    id: 1,
    resolution: 'approve',
    scopeKey: { population: 'adults', route: 'iv' },
    resolvedValue: null,
    resolvedLow: null,
    resolvedHigh: null,
    resolvedUnit: null,
    humanRequired: false,
    ...extra,
  };
}

describe('T3 convergence', () => {
  it('converges on the same value in different units of one family (L/h vs L/min)', () => {
    const r = compareOpinions(
      opinion({ id: 1, resolvedValue: 60, resolvedUnit: 'L/h' }),
      opinion({ id: 2, resolvedValue: 1, resolvedUnit: 'L/min' }),
      clearance,
    );
    expect(r.convergence).toMatchObject({ converged: true, reason: null, canonicalUnit: 'L/h' });
    expect(r.recommendation).toMatchObject({
      resolution: 'approve',
      value: { kind: 'scalar', value: 60, unit: 'L/h' },
      opinionIds: [1, 2],
    });
  });

  it('diverges on the same label and scope with different values', () => {
    const r = compareOpinions(
      opinion({ resolvedValue: 60, resolvedUnit: 'L/h' }),
      opinion({ resolvedValue: 75, resolvedUnit: 'L/h' }),
      clearance,
    );
    expect(r.convergence).toMatchObject({ converged: false, reason: 'value_differs' });
    expect(r.recommendation).toBeNull();
  });

  it('records a different unit family as a disagreement, not an error', () => {
    const r = compareOpinions(
      opinion({ resolvedValue: 60, resolvedUnit: 'L/h' }),
      opinion({ resolvedValue: 0.8, resolvedUnit: 'mL/min/kg' }),
      clearance,
    );
    expect(r.convergence.reason).toBe('unit_family_differs');
  });

  it('converts mass and molar concentrations through the molecular weight', () => {
    const r = compareOpinions(
      opinion({ resolvedValue: 0.3034, resolvedUnit: 'mg/L' }),
      opinion({ resolvedValue: 1, resolvedUnit: 'µmol/L' }),
      concentration,
    );
    expect(r.convergence.converged).toBe(true);
    // Without one, the pair cannot be compared and does not converge.
    expect(
      compareOpinions(
        opinion({ resolvedValue: 0.3034, resolvedUnit: 'mg/L' }),
        opinion({ resolvedValue: 1, resolvedUnit: 'µmol/L' }),
        { ...concentration, molecularWeight: null },
      ).convergence.reason,
    ).toBe('unit_not_convertible');
  });

  it('compares ranges end to end, and a scalar against a range is a shape difference', () => {
    const range = (low: number, high: number, unit: string) =>
      opinion({ resolvedLow: low, resolvedHigh: high, resolvedUnit: unit });
    expect(
      compareOpinions(range(60, 120, 'L/h'), range(1, 2, 'L/min'), clearance).convergence.converged,
    ).toBe(true);
    expect(
      compareOpinions(range(60, 120, 'L/h'), range(60, 130, 'L/h'), clearance).convergence.reason,
    ).toBe('value_differs');
    expect(
      compareOpinions(
        range(60, 120, 'L/h'),
        opinion({ resolvedValue: 60, resolvedUnit: 'L/h' }),
        clearance,
      ).convergence.reason,
    ).toBe('value_shape_differs');
  });

  it('diverges on the same label about different scopes', () => {
    const r = compareOpinions(
      opinion({ scopeKey: { population: 'adults' } }),
      opinion({ scopeKey: { population: 'neonates' } }),
      nonNumeric,
    );
    expect(r.convergence.reason).toBe('scope_differs');
  });

  it('normalises scope keys before comparing them', () => {
    expect(normaliseScopeKey({ Route: ' IV ', population: 'Adults', empty: '' })).toBe(
      normaliseScopeKey({ population: 'adults', route: 'iv' }),
    );
  });

  it('diverges on different resolutions, and never reads the prose', () => {
    expect(
      compareOpinions(opinion({ resolution: 'approve' }), opinion({ resolution: 'return' }), nonNumeric)
        .convergence.reason,
    ).toBe('resolution_differs');
  });

  it('compares valueless outcomes on resolution and scope alone', () => {
    const r = compareOpinions(
      opinion({ resolution: 'abstain' }),
      opinion({ resolution: 'abstain' }),
      clearance,
    );
    expect(r.convergence.converged).toBe(true);
    expect(r.recommendation?.value).toBeNull();
  });

  it('never recommends when a panelist asks for a human, even on agreement', () => {
    const r = compareOpinions(
      opinion({ resolution: 'human' }),
      opinion({ resolution: 'human' }),
      nonNumeric,
    );
    expect(r.convergence).toMatchObject({ converged: true, humanRequested: true });
    expect(r.recommendation).toBeNull();
    const flagged = compareOpinions(
      opinion({ resolution: 'abstain', humanRequired: true }),
      opinion({ resolution: 'abstain' }),
      nonNumeric,
    );
    expect(flagged.convergence.humanRequested).toBe(true);
    expect(flagged.recommendation).toBeNull();
  });
});
