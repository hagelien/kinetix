import { describe, expect, it, vi } from 'vitest';

import {
  MAX_REFERENCE_QUERY_LENGTH,
  MAX_REFERENCE_QUERY_TERMS,
  parseReferenceQuery,
  searchCitationRows,
  stripReferenceIdentifierPrefixes,
} from '../../api/_lib/reference-search.ts';

describe('stripReferenceIdentifierPrefixes', () => {
  it.each([
    ['doi:10.1093/jat/bkaa107', '10.1093/jat/bkaa107'],
    ['DOI: 10.1093/jat/bkaa107', '10.1093/jat/bkaa107'],
    ['https://doi.org/10.1093/jat/bkaa107', '10.1093/jat/bkaa107'],
    ['http://dx.doi.org/10.1093/jat/bkaa107', '10.1093/jat/bkaa107'],
    ['doi.org/10.1093/jat/bkaa107', '10.1093/jat/bkaa107'],
    ['PMID: 33245119', '33245119'],
    ['pmid33245119', '33245119'],
    ['pubmed 33245119', '33245119'],
    ['https://pubmed.ncbi.nlm.nih.gov/33245119/', '33245119'],
    // A resolver link copied from the address bar keeps its query string or
    // fragment; neither is part of the stored identifier.
    ['https://pubmed.ncbi.nlm.nih.gov/33245119/?format=pubmed', '33245119'],
    ['https://doi.org/10.1093/jat/bkaa107?utm_source=chrome', '10.1093/jat/bkaa107'],
    ['https://doi.org/10.1093/jat/bkaa107#abstract', '10.1093/jat/bkaa107'],
  ])('strips %s', (input, expected) => {
    expect(stripReferenceIdentifierPrefixes(input)).toBe(expected);
  });

  it.each(['doi:', 'DOI: ', 'doi=', 'pmid:', 'https://doi.org/'])(
    'strips %s to nothing — unfinished identifier syntax, not a search term',
    (input) => {
      expect(stripReferenceIdentifierPrefixes(input)).toBe('');
    },
  );

  it('keeps a bare wrapper word without a separator as prose', () => {
    // "PubMed" alone is a word someone may be searching for; "PubMed:" is
    // syntax the user has not finished typing.
    expect(stripReferenceIdentifierPrefixes('PubMed')).toBe('PubMed');
    expect(stripReferenceIdentifierPrefixes('PMID')).toBe('PMID');
  });

  it('leaves ordinary prose alone', () => {
    expect(stripReferenceIdentifierPrefixes('postmortem redistribution')).toBe(
      'postmortem redistribution',
    );
  });

  it.each([
    // "pubmed" and "doi" are also ordinary words in titles, journals, and
    // review prose. Stripping them there turned a search for "PubMed indexing"
    // into a search for "indexing".
    'PubMed',
    'PubMed indexing',
    'pubmed coverage of forensic journals',
    'doi metadata quality',
    'PMID assignment',
  ])('leaves %s intact — the remainder is not an identifier', (input) => {
    expect(stripReferenceIdentifierPrefixes(input)).toBe(input);
  });
});

describe('parseReferenceQuery', () => {
  it('reads a pasted DOI as an identifier', () => {
    const parsed = parseReferenceQuery('doi:10.1093/JAT/bkaa107');
    expect(parsed.identifier).toBe('10.1093/jat/bkaa107');
    expect(parsed.terms).toEqual(['10.1093/jat/bkaa107']);
    expect(parsed.raw).toBe('doi:10.1093/JAT/bkaa107');
  });

  it('reads a bare PubMed ID as an identifier', () => {
    expect(parseReferenceQuery('PMID 33245119').identifier).toBe('33245119');
  });

  it('accepts the same PMID range the write boundary does', () => {
    // validateReferenceIdentifier allows a positive integer up to 8 digits, so
    // a short PMID must be searchable through its wrapper too.
    expect(parseReferenceQuery('PMID 123').terms).toEqual(['123']);
    expect(parseReferenceQuery('pmid:7').identifier).toBe('7');
    expect(parseReferenceQuery('PMID 123456789').terms).toEqual([
      'pmid',
      '123456789',
    ]);
  });

  it('yields no terms for an unfinished identifier wrapper', () => {
    expect(parseReferenceQuery('doi:').terms).toEqual([]);
    expect(parseReferenceQuery('PMID:').terms).toEqual([]);
  });

  it('keeps a prose query that merely starts with a wrapper word', () => {
    const parsed = parseReferenceQuery('PubMed indexing');
    expect(parsed.identifier).toBeNull();
    expect(parsed.terms).toEqual(['pubmed', 'indexing']);
  });

  it('treats prose as AND-ed terms, not an identifier', () => {
    const parsed = parseReferenceQuery('  Postmortem   Redistribution ');
    expect(parsed.identifier).toBeNull();
    expect(parsed.terms).toEqual(['postmortem', 'redistribution']);
  });

  it('de-duplicates repeated terms', () => {
    expect(parseReferenceQuery('blood blood').terms).toEqual(['blood']);
  });

  it('caps the number of terms so one query cannot author unbounded SQL', () => {
    const many = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
    const parsed = parseReferenceQuery(many);
    expect(parsed.terms).toHaveLength(MAX_REFERENCE_QUERY_TERMS);
    expect(parsed.terms[0]).toBe('term0');
  });

  it('caps the raw query length', () => {
    const parsed = parseReferenceQuery('x'.repeat(MAX_REFERENCE_QUERY_LENGTH + 50));
    expect(parsed.raw).toHaveLength(MAX_REFERENCE_QUERY_LENGTH);
    expect(parsed.terms[0]).toHaveLength(MAX_REFERENCE_QUERY_LENGTH);
  });

  it('still reads a DOI URL with tracking parameters as an identifier', () => {
    const parsed = parseReferenceQuery(
      'https://doi.org/10.1093/jat/bkaa107?utm_source=chrome',
    );
    expect(parsed.identifier).toBe('10.1093/jat/bkaa107');
    expect(parsed.terms).toEqual(['10.1093/jat/bkaa107']);
  });

  it('yields nothing to search on for an empty query', () => {
    expect(parseReferenceQuery('   ')).toEqual({
      raw: '',
      terms: [],
      identifier: null,
    });
  });
});

describe('searchCitationRows', () => {
  function mockDb(rows: unknown[]) {
    const execute = vi.fn().mockResolvedValue({ rows });
    return {
      db: { execute } as never,
      execute,
    };
  }

  it('does not query at all for an empty query', async () => {
    const { db, execute } = mockDb([]);
    expect(await searchCitationRows(db, parseReferenceQuery(''))).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits one scan arm per term, never more than the cap', async () => {
    const { db, execute } = mockDb([]);
    const many = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');

    await searchCitationRows(db, parseReferenceQuery(many), 5);

    const query = execute.mock.calls[0]![0] as { queryChunks?: unknown[] };
    const sqlText = JSON.stringify(query.queryChunks ?? query);
    const arms = sqlText.split('INTERSECT').length - 1;
    expect(arms).toBe(MAX_REFERENCE_QUERY_TERMS - 1);
  });

  it('searches identifiers, metadata, and the review body', async () => {
    const { db, execute } = mockDb([{ id: 7 }]);

    await searchCitationRows(db, parseReferenceQuery('redistribution'), 5);

    const query = execute.mock.calls[0]![0] as { queryChunks?: unknown[] };
    const sqlText = JSON.stringify(query.queryChunks ?? query);
    expect(sqlText).toContain('review_markdown');
    expect(sqlText).toContain('paper_reviews');
    expect(sqlText).toContain('identifier');
    expect(sqlText).toContain('%redistribution%');
  });
});
