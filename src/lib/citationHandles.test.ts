import { describe, it, expect } from 'vitest';
import {
  addressableHandles,
  canonicalCitationHandle,
  citationHandleRank,
  citationIdentityKey,
  mergeAltIds,
  normalizeAltIds,
  normalizeHandleIdentifier,
  resolverHandleFromUrl,
  rewriteCitationIdsInJson,
} from './citationHandles';

describe('resolverHandleFromUrl', () => {
  it('reads the DOI behind a doi.org URL', () => {
    expect(resolverHandleFromUrl('https://doi.org/10.1234/ABC.5')).toEqual({
      type: 'doi',
      identifier: '10.1234/abc.5',
    });
    expect(resolverHandleFromUrl('http://dx.doi.org/10.1234/abc.5')).toEqual({
      type: 'doi',
      identifier: '10.1234/abc.5',
    });
  });

  it('reads the PMID behind a PubMed URL', () => {
    expect(
      resolverHandleFromUrl('https://pubmed.ncbi.nlm.nih.gov/33245119/'),
    ).toEqual({ type: 'pmid', identifier: '33245119' });
    expect(
      resolverHandleFromUrl('https://www.ncbi.nlm.nih.gov/pubmed/33245119'),
    ).toEqual({ type: 'pmid', identifier: '33245119' });
  });

  it('reads the PMCID behind a PMC article URL', () => {
    expect(
      resolverHandleFromUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC1379730/'),
    ).toEqual({ type: 'pmcid', identifier: 'PMC1379730' });
    expect(
      resolverHandleFromUrl(
        'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1379730/',
      ),
    ).toEqual({ type: 'pmcid', identifier: 'PMC1379730' });
  });

  it('ignores query strings and fragments', () => {
    // A tracking parameter is decoration, not part of the identifier.
    expect(
      resolverHandleFromUrl('https://doi.org/10.1234/abc.5?utm_source=x#sec2'),
    ).toEqual({ type: 'doi', identifier: '10.1234/abc.5' });
    expect(
      resolverHandleFromUrl('https://pubmed.ncbi.nlm.nih.gov/33245119/?from=x'),
    ).toEqual({ type: 'pmid', identifier: '33245119' });
  });

  it('returns null for a URL that identifies nothing but itself', () => {
    expect(resolverHandleFromUrl('https://example.org/label.pdf')).toBeNull();
    expect(resolverHandleFromUrl('https://doi.org/not-a-doi')).toBeNull();
    expect(resolverHandleFromUrl('not a url at all')).toBeNull();
  });
});

describe('normalizeHandleIdentifier', () => {
  it('reduces a PMID to its bare number', () => {
    expect(normalizeHandleIdentifier('pmid', ' PMID: 33245119 ')).toBe(
      '33245119',
    );
    expect(normalizeHandleIdentifier('pmid', 'pubmed 33245119')).toBe(
      '33245119',
    );
    expect(normalizeHandleIdentifier('pmid', '033245119')).toBe('33245119');
  });

  it('unwraps and lower-cases a DOI (DOIs are case-insensitive)', () => {
    expect(
      normalizeHandleIdentifier('doi', 'https://doi.org/10.1093/JAT/BKAA107'),
    ).toBe('10.1093/jat/bkaa107');
    expect(normalizeHandleIdentifier('doi', 'doi:10.1093/jat/bkaa107')).toBe(
      '10.1093/jat/bkaa107',
    );
  });

  it('leaves an identifier that does not match its type alone', () => {
    // Mangling it would cost the row its only handle.
    expect(normalizeHandleIdentifier('pmid', 'not-a-pmid')).toBe('not-a-pmid');
    expect(normalizeHandleIdentifier('url', ' https://example.org/a ')).toBe(
      'https://example.org/a',
    );
  });
});

describe('canonicalCitationHandle', () => {
  it('files a paper under the strongest handle it knows', () => {
    const canonical = canonicalCitationHandle(
      { type: 'doi', identifier: '10.1093/jat/bkaa107' },
      { pmid: '33245119' },
    );
    expect(canonical).toEqual({
      type: 'pmid',
      identifier: '33245119',
      altIds: { doi: '10.1093/jat/bkaa107' },
    });
  });

  it('keeps the declared handle when nothing stronger is known', () => {
    expect(
      canonicalCitationHandle({ type: 'doi', identifier: '10.1000/xyz' }),
    ).toEqual({ type: 'doi', identifier: '10.1000/xyz', altIds: {} });
  });

  it('never lists the winning handle in altIds as well', () => {
    const canonical = canonicalCitationHandle(
      { type: 'pmid', identifier: '33245119' },
      { pmid: '33245119', doi: '10.1000/xyz' },
    );
    expect(canonical.altIds).toEqual({ doi: '10.1000/xyz' });
  });

  it('does not promote free text — it identifies nothing resolvable', () => {
    const canonical = canonicalCitationHandle(
      { type: 'freetext', identifier: 'Personal communication, 2024' },
      { pmid: '33245119' },
    );
    expect(canonical.type).toBe('freetext');
    expect(canonical.altIds.pmid).toBe('33245119');
  });

  it('carries a PMCID as a searchable alias, never as the row handle', () => {
    const canonical = canonicalCitationHandle(
      { type: 'doi', identifier: '10.1000/xyz' },
      { pmcid: 'pmc7654321' },
    );
    expect(canonical.type).toBe('doi');
    expect(canonical.altIds.pmcid).toBe('PMC7654321');
  });
});

describe('addressableHandles', () => {
  // This is the lookup set that closes the bug: the write path checks every
  // handle the paper is known by before it inserts, not just the declared one.
  it('lists every handle a row for this paper could already sit under', () => {
    const canonical = canonicalCitationHandle(
      { type: 'doi', identifier: '10.1093/jat/bkaa107' },
      { pmid: '33245119', url: 'https://example.org/paper' },
    );
    expect(addressableHandles(canonical)).toEqual([
      { type: 'pmid', identifier: '33245119' },
      { type: 'doi', identifier: '10.1093/jat/bkaa107' },
      { type: 'url', identifier: 'https://example.org/paper' },
    ]);
  });
});

describe('citationIdentityKey', () => {
  it('gives the two halves of a split pair the same key', () => {
    const asPmid = citationIdentityKey({ type: 'pmid', identifier: '33245119' });
    const asDoi = citationIdentityKey(
      { type: 'doi', identifier: '10.1093/jat/bkaa107' },
      { pmid: '33245119' },
    );
    expect(asDoi).toBe(asPmid);
  });

  it('keeps genuinely different papers apart', () => {
    expect(
      citationIdentityKey({ type: 'pmid', identifier: '33245119' }),
    ).not.toBe(citationIdentityKey({ type: 'pmid', identifier: '33245120' }));
  });
});

describe('mergeAltIds / normalizeAltIds', () => {
  it('fills gaps without overwriting what the row already resolved', () => {
    expect(
      mergeAltIds({ doi: '10.1000/known' }, { doi: '10.1000/guess', pmid: '1' }),
    ).toEqual({ doi: '10.1000/known', pmid: '1' });
  });

  it('drops blanks and non-strings', () => {
    expect(
      normalizeAltIds({
        doi: '   ',
        pmid: undefined,
        url: 'https://example.org',
      }),
    ).toEqual({ url: 'https://example.org' });
  });

  it('drops handles that do not look like their type', () => {
    expect(
      normalizeAltIds({
        pmid: 'not-a-pmid',
        doi: 'nonsense',
        pmcid: '12345',
        url: 'javascript:alert(1)',
      }),
    ).toEqual({});
  });

  it('keeps well-formed handles alongside malformed ones', () => {
    expect(
      normalizeAltIds({ pmid: '33245119', doi: 'nonsense' }),
    ).toEqual({ pmid: '33245119' });
  });

  it('does not let a malformed alt handle promote the row', () => {
    // An alt id is a canonicalization candidate, so a junk `pmid` would beat a
    // valid DOI on handle strength and file the paper under an identifier that
    // resolves to nothing.
    const canonical = canonicalCitationHandle(
      { type: 'doi', identifier: '10.1093/jat/bkaa107' },
      { pmid: 'not-a-pmid' },
    );
    expect(canonical.type).toBe('doi');
    expect(canonical.identifier).toBe('10.1093/jat/bkaa107');
    expect(canonical.altIds.pmid).toBeUndefined();
  });
});

describe('citationHandleRank', () => {
  it('orders PMID > DOI > URL > free text', () => {
    expect(citationHandleRank('pmid')).toBeLessThan(citationHandleRank('doi'));
    expect(citationHandleRank('doi')).toBeLessThan(citationHandleRank('url'));
    expect(citationHandleRank('url')).toBeLessThan(
      citationHandleRank('freetext'),
    );
  });

  it('ranks an unknown type last rather than first', () => {
    expect(citationHandleRank('isbn')).toBeGreaterThan(
      citationHandleRank('freetext'),
    );
  });
});

describe('rewriteCitationIdsInJson', () => {
  const doc = {
    version: 2,
    sections: {
      pharmacology: {
        body: {
          type: 'doc',
          content: [
            { type: 'fact', attrs: { referenceIds: [4, 9] } },
            { type: 'footnote', attrs: { referenceId: 4 } },
            // A number that is NOT a citation id and must survive untouched.
            { type: 'paragraph', attrs: { year: 4, doseMg: 4 } },
          ],
        },
        fields: { halfLife: { refs: [4] } },
      },
    },
  };

  it('rewrites ids only under citation-bearing keys', () => {
    const { value, changed } = rewriteCitationIdsInJson(doc, 4, 7);
    expect(changed).toBe(true);
    const body = value.sections.pharmacology.body.content;
    expect(body[0]!.attrs).toEqual({ referenceIds: [7, 9] });
    expect(body[1]!.attrs).toEqual({ referenceId: 7 });
    // The year and the dose are still 4 — a blind numeric replace would have
    // silently changed both.
    expect(body[2]!.attrs).toEqual({ year: 4, doseMg: 4 });
    expect(value.sections.pharmacology.fields.halfLife.refs).toEqual([7]);
  });

  it('reports no change when the id is absent', () => {
    expect(rewriteCitationIdsInJson(doc, 999, 7).changed).toBe(false);
  });

  it('tolerates null and primitive documents', () => {
    expect(rewriteCitationIdsInJson(null, 4, 7)).toEqual({
      value: null,
      changed: false,
    });
  });
});
