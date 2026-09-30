import { describe, expect, it } from 'vitest';
import {
  analyticalMethodsForDrug,
  methodIncludesDrug,
} from '@/lib/analyticalMethods';
import type { AnalyticalMethod, DrugComponent } from '@/types';

const diazepam: DrugComponent = {
  id: '3016',
  names: { nb: 'Diazepam' },
  _dbId: 12,
};

describe('analyticalMethods', () => {
  it('matches fallback methods by PubChem CID component id', () => {
    const method: AnalyticalMethod = {
      id: '9001',
      name: 'Benzodiazepines',
      components: ['3016'],
    };

    expect(methodIncludesDrug(method, diazepam)).toBe(true);
  });

  it('matches API methods by internal DB id when a drug has no PubChem CID', () => {
    const method: AnalyticalMethod = {
      id: '2040',
      name: 'Custom panel',
      components: [],
      drugIds: [42],
    };
    const customDrug: DrugComponent = {
      id: '42',
      names: { nb: 'Custom drug' },
      _dbId: 42,
    };

    expect(methodIncludesDrug(method, customDrug)).toBe(true);
  });

  it('does not treat a DB fallback id as a PubChem CID match', () => {
    const method: AnalyticalMethod = {
      id: '2040',
      name: 'Custom panel',
      components: ['42'],
      drugIds: [99],
    };
    const customDrug: DrugComponent = {
      id: '42',
      names: { nb: 'Custom drug' },
      _dbId: 42,
    };

    expect(methodIncludesDrug(method, customDrug)).toBe(false);
  });

  it('sorts matching methods numerically by method code', () => {
    const methods: AnalyticalMethod[] = [
      { id: '20', name: 'Later', components: ['3016'] },
      { id: '3', name: 'Earlier', components: ['3016'] },
      { id: '99', name: 'Other', components: ['999'] },
    ];

    expect(
      analyticalMethodsForDrug(methods, diazepam).map((m) => m.id),
    ).toEqual(['3', '20']);
  });
});
