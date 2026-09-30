import { describe, it, expect } from 'vitest';
import { searchDrugs, drugComponentKey } from '@/lib/drugSearch';
import type { DrugComponent } from '@/types';

function component(partial: Partial<DrugComponent>): DrugComponent {
  return {
    id: '0',
    names: {},
    ...partial,
  } as DrugComponent;
}

describe('drugComponentKey', () => {
  it('prefers the unique _dbId so CID/db-id namespaces cannot collide', () => {
    // Real-world collision: a CID-less drug whose id falls back to its db id
    // (Canakinumab, db id 401 -> id "401") and a different drug whose
    // pubchemCid is 401 (Sykloserin, db id 690 -> id "401") share `id`.
    const canakinumab = component({
      id: '401',
      _dbId: 401,
      names: { nb: 'Canakinumab' },
    });
    const sykloserin = component({
      id: '401',
      _dbId: 690,
      names: { nb: 'Sykloserin' },
    });

    expect(canakinumab.id).toBe(sykloserin.id);
    expect(drugComponentKey(canakinumab)).not.toBe(
      drugComponentKey(sykloserin),
    );
  });

  it('produces unique keys across a list of CID-less and CID-bearing drugs', () => {
    const drugs = [
      component({ id: '401', _dbId: 401 }), // CID-less, falls back to db id
      component({ id: '401', _dbId: 690 }), // pubchemCid 401
      component({ id: '588', _dbId: 588 }), // CID-less
      component({ id: '588', _dbId: 541 }), // pubchemCid 588
    ];
    const keys = drugs.map(drugComponentKey);
    expect(new Set(keys).size).toBe(drugs.length);
  });

  it('falls back to id when _dbId is absent (embedded-bundle components)', () => {
    expect(drugComponentKey(component({ id: '338', _dbId: undefined }))).toBe(
      '338',
    );
  });
});

describe('searchDrugs', () => {
  it('matches on the precomputed _searchKey across languages and aliases', () => {
    const salisylsyre = component({
      id: '338',
      _dbId: 108,
      names: { en: 'Salicylic Acid', nb: 'Salisylsyre' },
      _searchKey: 'salicylic acid\tsalisylsyre\t\t\tessential medicine',
    });
    const mdea = component({
      id: '588',
      _dbId: 588,
      names: { nb: 'Metylendioksyetylamfetamin' },
      _searchKey: 'metylendioksyetylamfetamin\tmdea',
    });

    expect(searchDrugs([salisylsyre, mdea], 'salisyl')).toEqual([salisylsyre]);
    expect(searchDrugs([salisylsyre, mdea], 'mdea')).toEqual([mdea]);
  });

  it('returns all components for an empty query', () => {
    const list = [component({ id: '1' }), component({ id: '2' })];
    expect(searchDrugs(list, '   ')).toEqual(list);
  });

  it('caps empty-query results without mutating the source list', () => {
    const list = [
      component({ id: '1' }),
      component({ id: '2' }),
      component({ id: '3' }),
    ];

    expect(searchDrugs(list, '   ', 2)).toEqual(list.slice(0, 2));
    expect(list).toHaveLength(3);
  });

  it('stops scanning once enough matches are found for a capped search', () => {
    const list = [
      component({ id: '1', _searchKey: 'alpha' }),
      component({ id: '2', _searchKey: 'alpha beta' }),
      component({ id: '3', _searchKey: 'alpha gamma' }),
    ];
    Object.defineProperty(list[2], '_searchKey', {
      get: () => {
        throw new Error('third row should not be inspected');
      },
    });

    expect(searchDrugs(list, 'alpha', 2)).toEqual([list[0], list[1]]);
  });
});
