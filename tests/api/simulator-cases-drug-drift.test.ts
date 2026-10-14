/**
 * `caseDrugResolutionDrift` decides whether a simulator case save may go on
 * after re-resolving its drug refs under the per-drug lock. Anything other
 * than "every ref still names the same drug(s)" must come back non-null, so
 * the save is refused rather than written under locks held for other drugs.
 */
import { describe, expect, it } from 'vitest';
import { caseDrugResolutionDrift } from '../../api/simulator/cases.js';

function resolution(
  keys: Record<string, number[]>,
  slugs: Record<string, number[]> = {},
) {
  const all = [...Object.values(keys), ...Object.values(slugs)].flat();
  return {
    drugIds: [...new Set(all)].sort((a, b) => a - b),
    keyIds: new Map(Object.entries(keys)),
    slugIds: new Map(Object.entries(slugs)),
  };
}

describe('caseDrugResolutionDrift', () => {
  it('is null when every ref resolves to the same drugs', () => {
    const r = resolution({ '111': [7], 'drug:9': [9] }, { koffein: [7] });
    expect(caseDrugResolutionDrift(r, resolution({ '111': [7], 'drug:9': [9] }, { koffein: [7] }))).toBeNull();
  });

  it('reports a key that no longer resolves (CID moved away)', () => {
    expect(caseDrugResolutionDrift(resolution({ '111': [7] }), resolution({ '111': [] }))).toEqual({
      changedKeys: ['111'],
      changedSlugs: [],
    });
  });

  it('reports a key that now resolves to a different drug', () => {
    expect(caseDrugResolutionDrift(resolution({ '111': [7] }), resolution({ '111': [8] }))).toEqual({
      changedKeys: ['111'],
      changedSlugs: [],
    });
  });

  it('reports a bare numeric key that gained a second match', () => {
    // Legacy dual lookup: `5` is drug 5's id and, after the move, drug 8's CID.
    expect(caseDrugResolutionDrift(resolution({ '5': [5] }), resolution({ '5': [5, 8] }))).toEqual({
      changedKeys: ['5'],
      changedSlugs: [],
    });
  });

  it('catches two keys swapping drugs even though the id set is unchanged', () => {
    const before = resolution({ '111': [7], '333': [8] });
    const after = resolution({ '111': [8], '333': [7] });
    expect(before.drugIds).toEqual(after.drugIds);
    expect(caseDrugResolutionDrift(before, after)).toEqual({
      changedKeys: ['111', '333'],
      changedSlugs: [],
    });
  });

  it('reports a slug that moved to another drug', () => {
    expect(
      caseDrugResolutionDrift(resolution({}, { koffein: [7] }), resolution({}, { koffein: [9] })),
    ).toEqual({ changedKeys: [], changedSlugs: ['koffein'] });
  });

  it('is non-null when only the id sets differ', () => {
    const before = { drugIds: [7], keyIds: new Map(), slugIds: new Map() };
    const after = { drugIds: [8], keyIds: new Map(), slugIds: new Map() };
    expect(caseDrugResolutionDrift(before, after)).toEqual({ changedKeys: [], changedSlugs: [] });
  });
});
