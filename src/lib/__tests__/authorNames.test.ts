import { describe, expect, it } from 'vitest';

import {
  authorSurname,
  firstAuthorSurname,
  normalizeAuthorList,
} from '@/lib/authorNames';

describe('normalizeAuthorList', () => {
  it('reads both shapes metadata.authors takes', () => {
    expect(normalizeAuthorList(['Huertas T', 'Aasen B'])).toEqual([
      'Huertas T',
      'Aasen B',
    ]);
    // Legacy rows store the list as one comma-separated string; dropping it
    // would file a paper with a known author under "no author".
    expect(normalizeAuthorList('Huertas T, Aasen B')).toEqual([
      'Huertas T',
      'Aasen B',
    ]);
  });

  it('treats anything else as no author list', () => {
    expect(normalizeAuthorList(undefined)).toEqual([]);
    expect(normalizeAuthorList('   ')).toEqual([]);
    expect(normalizeAuthorList(2019)).toEqual([]);
    expect(normalizeAuthorList([' ', 42, 'Huertas T'])).toEqual(['Huertas T']);
  });
});

describe('firstAuthorSurname', () => {
  it('takes the surname of the first named author, whatever the shape', () => {
    expect(firstAuthorSurname(['Huertas T', 'Aasen B'])).toBe('Huertas');
    expect(firstAuthorSurname('Huertas T, Aasen B')).toBe('Huertas');
    expect(firstAuthorSurname(['Doe John'])).toBe('Doe');
  });

  it('is empty for a source with no author', () => {
    expect(firstAuthorSurname(undefined)).toBe('');
    expect(firstAuthorSurname([])).toBe('');
    expect(firstAuthorSurname(['   '])).toBe('');
  });
});

describe('authorSurname', () => {
  it('keeps an organisation name whole rather than parsing a surname out', () => {
    expect(authorSurname('World Health Organization')).toBe(
      'World Health Organization',
    );
    expect(authorSurname('Schmoldt-Andresen S')).toBe('Schmoldt-Andresen');
  });
});
