/**
 * The one registry two routes have to agree about.
 *
 * `/api/agent-focus` (what the agents work on globally) and
 * `/api/parameter-priority-flags` (what they work on next for one drug) both
 * store an id in a `parameter` column, and both validate it. When each held its
 * own test, the two lists could disagree — a focus naming a target the flag
 * route rejected, or the reverse. These pin the union and, more importantly,
 * that the relationship-shaped coverage areas are in it: `metabolism` and
 * `pharmacodynamics` have no parameter id, which is exactly why neither surface
 * would take them before.
 */
import { describe, expect, it } from 'vitest';
import { isAgentWorkTarget } from '../../api/_lib/agent-work-targets.js';
import { DRUG_PARAMETER_IDS } from '../../api/_lib/drugParameterIds.js';
import { parameterAuthoringGated } from '../../src/lib/drugParameters.js';
import { DRUG_COVERAGE_AREA_IDS } from '../../src/lib/drugCoverageAreas.js';

describe('isAgentWorkTarget', () => {
  it('accepts every registered drug parameter whose authoring is open', () => {
    for (const id of DRUG_PARAMETER_IDS) {
      expect(isAgentWorkTarget(id), id).toBe(!parameterAuthoringGated(id));
    }
  });

  // Release C opened Cmax authoring, so it is work an agent can be pointed at.
  it('accepts cmax now that its authoring is open', () => {
    expect(parameterAuthoringGated('cmax')).toBe(false);
    expect(isAgentWorkTarget('cmax')).toBe(true);
  });

  it('accepts every coverage area', () => {
    expect(DRUG_COVERAGE_AREA_IDS).toContain('metabolism');
    expect(DRUG_COVERAGE_AREA_IDS).toContain('pharmacodynamics');
    for (const id of DRUG_COVERAGE_AREA_IDS) {
      expect(isAgentWorkTarget(id)).toBe(true);
    }
  });

  it('still refuses anything in neither register', () => {
    // The guard the focus and flag routes lean on: an id that reaches the gap
    // queue with no fill test behind it is served forever and closed by
    // nothing.
    for (const id of ['', 'loq', 'half_life', 'metabolisme', 'Metabolism']) {
      expect(isAgentWorkTarget(id)).toBe(false);
    }
  });

  it('keeps the two registers disjoint', () => {
    // A coverage area that also became a parameter id would be written twice —
    // once as a relationship row, once as a `drug_parameters` aggregate — and
    // the gap queue would pick a fill test by lane rather than by meaning.
    const parameters = new Set<string>(DRUG_PARAMETER_IDS);
    for (const id of DRUG_COVERAGE_AREA_IDS) {
      expect(parameters.has(id)).toBe(false);
    }
  });
});
