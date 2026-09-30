import { describe, expect, it } from 'vitest';

import { mapEnrichedFlag } from '../../api/parameter-priority-flags.ts';

type Row = Parameters<typeof mapEnrichedFlag>[0];
type DrugMap = Parameters<typeof mapEnrichedFlag>[1];
type UserMap = Parameters<typeof mapEnrichedFlag>[2];

// Regression sibling to pending-edits-drug-name-locale: the priority-flags
// admin panel is a Norwegian-default moderation surface, so a flagged drug
// must surface its Norwegian (`nb`) name, not English. resolveDrugName still
// falls back to English when no `nb` name exists.
describe('parameter-priority-flags enrichment — drug name localisation', () => {
  function makeRow(drugId: number): Row {
    return {
      id: 1,
      drugId,
      parameter: null,
      note: null,
      status: 'active',
      flaggedBy: null,
      resolvedBy: null,
    } as unknown as Row;
  }

  function makeDrugMap(
    drug: { id: number; names: Record<string, string> },
  ): DrugMap {
    return new Map([[drug.id, drug]]) as unknown as DrugMap;
  }

  const emptyUsers = new Map() as unknown as UserMap;

  it('resolves the flagged drug name in Norwegian, not English', () => {
    const drug = {
      id: 42,
      names: { nb: 'Etylglukuronid', en: 'Ethyl glucuronide' },
    };
    const enriched = mapEnrichedFlag(makeRow(42), makeDrugMap(drug), emptyUsers);
    expect(enriched.drugName).toBe('Etylglukuronid');
  });

  it('falls back to English when no Norwegian name exists', () => {
    const drug = { id: 7, names: { en: 'Ethyl glucuronide' } };
    const enriched = mapEnrichedFlag(makeRow(7), makeDrugMap(drug), emptyUsers);
    expect(enriched.drugName).toBe('Ethyl glucuronide');
  });

  it('returns null drugName when the drug is missing from the map', () => {
    const enriched = mapEnrichedFlag(
      makeRow(99),
      makeDrugMap({ id: 1, names: { nb: 'Morfin' } }),
      emptyUsers,
    );
    expect(enriched.drugName).toBeNull();
  });
});
