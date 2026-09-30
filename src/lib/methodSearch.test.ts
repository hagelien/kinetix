import { describe, it, expect } from 'vitest';
import { searchMethods, formatMethodLabel } from '@/lib/methodSearch';
import type { AnalyticalMethod } from '@/types';

function method(partial: Partial<AnalyticalMethod>): AnalyticalMethod {
  return {
    id: '0000',
    name: 'Method',
    ...partial,
  };
}

const METHODS: AnalyticalMethod[] = [
  method({ id: '9001', name: '9001 SYNTHETIC PANEL A LC-MS/MS', componentCount: 46 }),
  method({ id: '9002', name: '9002 Synthetic panel A negative' }),
  method({ id: '9003', name: 'Toxicology screen B' }),
  method({ id: '9004', name: 'GHB confirmation C', description: 'Screening' }),
];

describe('searchMethods', () => {
  it('finds a method by its code — the case the drug search could not serve', () => {
    expect(searchMethods(METHODS, '9001').map((m) => m.id)).toEqual(['9001']);
  });

  it('finds methods by name, case-insensitively', () => {
    expect(searchMethods(METHODS, 'synthetic').map((m) => m.id)).toEqual([
      '9001',
      '9002',
    ]);
  });

  it('matches the description too', () => {
    expect(searchMethods(METHODS, 'screening').map((m) => m.id)).toEqual([
      '9004',
    ]);
  });

  it('requires every token to match, so extra words narrow the result', () => {
    expect(
      searchMethods(METHODS, 'synthetic negative').map((m) => m.id),
    ).toEqual(['9002']);
    expect(searchMethods(METHODS, 'synthetic ghb')).toEqual([]);
  });

  it('ignores surrounding whitespace', () => {
    expect(searchMethods(METHODS, '  9001  ').map((m) => m.id)).toEqual([
      '9001',
    ]);
  });

  it('returns nothing for a query shorter than two characters', () => {
    // "1" is a substring of every code here; suggesting all of them would
    // bury the drug results the user is far likelier to want.
    expect(searchMethods(METHODS, '1')).toEqual([]);
    expect(searchMethods(METHODS, '')).toEqual([]);
  });

  it('ranks an exact code match above a method that only mentions the code', () => {
    const withMention = [
      method({ id: '2100', name: 'Reflex confirmation after 9001' }),
      ...METHODS,
    ];
    expect(searchMethods(withMention, '9001').map((m) => m.id)).toEqual([
      '9001',
      '2100',
    ]);
  });

  it('ranks a name-prefix match above a mid-name match', () => {
    const list = [
      method({ id: '3002', name: 'Blood screen for opioids' }),
      method({ id: '3001', name: 'Opioids in urine' }),
    ];
    expect(searchMethods(list, 'opioids').map((m) => m.id)).toEqual([
      '3001',
      '3002',
    ]);
  });

  it('caps the number of suggestions', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      method({ id: `40${String(i).padStart(2, '0')}`, name: 'Synthetic panel' }),
    );
    expect(searchMethods(many, 'synthetic')).toHaveLength(5);
    expect(searchMethods(many, 'synthetic', 3)).toHaveLength(3);
  });

  it('returns nothing when no method matches a drug-name query', () => {
    expect(searchMethods(METHODS, 'morfin')).toEqual([]);
  });
});

describe('formatMethodLabel', () => {
  it('prefixes the code when the name does not already carry it', () => {
    expect(
      formatMethodLabel(method({ id: '9003', name: 'Toxicology screen B' })),
    ).toBe('9003 Toxicology screen B');
  });

  it('does not double-prefix a name that already leads with its code', () => {
    expect(
      formatMethodLabel(
        method({ id: '9001', name: '9001 SYNTHETIC PANEL A LC-MS/MS' }),
      ),
    ).toBe('9001 SYNTHETIC PANEL A LC-MS/MS');
  });
});
