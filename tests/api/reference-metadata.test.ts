import { describe, expect, it } from 'vitest';
import { createReferenceSchema, resolveReferenceSchema } from '../../api/_lib/schemas.ts';
import { normalizeReferenceMetadata } from '../../api/_lib/reference-metadata.ts';

describe('createReferenceSchema metadata contract', () => {
  it('rejects a URL that is only a site front page', () => {
    for (const identifier of [
      'https://www.noklus.no',
      'https://www.guidetopharmacology.org/',
      'https://www.ebi.ac.uk/chembl/',
    ]) {
      const parsed = createReferenceSchema.safeParse({ type: 'url', identifier });
      expect(parsed.success, identifier).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/front page/);
    }
  });

  it('accepts a URL that points to a specific page', () => {
    for (const identifier of [
      'https://www.noklus.no/peth-veileder/',
      'https://example.org/?id=3',
      'https://www.ebi.ac.uk/chembl/compound_report_card/CHEMBL160/',
    ]) {
      const parsed = createReferenceSchema.safeParse({ type: 'url', identifier });
      expect(parsed.success, identifier).toBe(true);
    }
  });

  it('rejects malformed metadata authors as a comma-separated string', () => {
    const parsed = createReferenceSchema.safeParse({
      type: 'doi',
      identifier: '10.1000/test',
      metadata: {
        authors: 'A, B',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects unexpected object keys', () => {
    const parsed = createReferenceSchema.safeParse({
      type: 'doi',
      identifier: '10.1000/test',
      metadata: {
        title: 'Paper',
        extra: 'not-allowed',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects an alt handle that is not valid for its type', () => {
    // An alt id is a canonicalization candidate, not a note: `resolveCitation`
    // files the paper under the strongest handle it is given, so this would
    // promote a perfectly good DOI row into an unresolvable `pmid`.
    const parsed = createReferenceSchema.safeParse({
      type: 'doi',
      identifier: '10.1000/test',
      metadata: { altIds: { pmid: 'not-a-pmid' } },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts alt handles that are well formed', () => {
    const parsed = createReferenceSchema.safeParse({
      type: 'doi',
      identifier: '10.1000/test',
      metadata: {
        altIds: {
          pmid: '33245119',
          pmcid: 'PMC7654321',
          url: 'https://example.org/paper',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts an alt handle that only needs normalizing', () => {
    // `PMID: 123…` is the same handle in a different spelling, not junk.
    const parsed = createReferenceSchema.safeParse({
      type: 'doi',
      identifier: '10.1000/test',
      metadata: { altIds: { pmid: 'PMID: 33245119' } },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts nullable year/volume/pages with strict shape', () => {
    const parsed = createReferenceSchema.safeParse({
      type: 'pmid',
      identifier: '12345',
      metadata: {
        title: ' Example title ',
        authors: ['A', 'B'],
        journal: ' Journal ',
        year: null,
        volume: null,
        pages: null,
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe('reference identifier format validation', () => {
  it('accepts a well-formed DOI', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'doi', identifier: '10.1000/xyz123' }).success,
    ).toBe(true);
  });

  it('rejects a DOI without the 10. prefix', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'doi', identifier: 'not-a-doi' }).success,
    ).toBe(false);
  });

  it('rejects a DOI missing the slash-separated suffix', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'doi', identifier: '10.1000' }).success,
    ).toBe(false);
  });

  it('accepts a purely numeric PMID', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'pmid', identifier: '38000000' }).success,
    ).toBe(true);
  });

  it('rejects a non-numeric PMID', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'pmid', identifier: 'abc123' }).success,
    ).toBe(false);
  });

  it('rejects a PMID with more than 8 digits', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'pmid', identifier: '123456789' }).success,
    ).toBe(false);
  });

  it('accepts a freetext identifier without format constraints', () => {
    expect(
      resolveReferenceSchema.safeParse({ type: 'freetext', identifier: 'Any string is fine' }).success,
    ).toBe(true);
  });
});

describe('reference identifier normalization', () => {
  it('accepts a DOI pasted as its resolver URL and strips the prefix', () => {
    // The exact input a user pastes out of a journal page — full doi.org URL,
    // parenthesised legacy suffix. Before normalization this failed DOI_RE and
    // the lookup 400'd, surfacing to the picker as a bare "network error".
    const parsed = resolveReferenceSchema.safeParse({
      type: 'doi',
      identifier: 'https://doi.org/10.1016/S0928-0987(99)00012-3',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('10.1016/s0928-0987(99)00012-3');
    }
  });

  it('strips a doi: wrapper and lower-cases the DOI', () => {
    const parsed = resolveReferenceSchema.safeParse({
      type: 'doi',
      identifier: 'doi:10.1093/JAT/BKAA107',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('10.1093/jat/bkaa107');
    }
  });

  it('strips a PMID: wrapper and leading zeros before validating', () => {
    const parsed = resolveReferenceSchema.safeParse({
      type: 'pmid',
      identifier: 'PMID: 033245119',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('33245119');
    }
  });

  it('drops a tracking query string and fragment from a pasted DOI URL', () => {
    // Prefix-stripping alone would leave `?utm_source=x#sec2` glued to the DOI,
    // which still passes DOI_RE (`.+`) but is sent to CrossRef verbatim and
    // fails the lookup. resolverHandleFromUrl decodes the path and discards the
    // decoration.
    const parsed = resolveReferenceSchema.safeParse({
      type: 'doi',
      identifier: 'https://doi.org/10.1234/abc.5?utm_source=x#sec2',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('10.1234/abc.5');
    }
  });

  it('extracts the PMID from a pasted PubMed URL', () => {
    const parsed = resolveReferenceSchema.safeParse({
      type: 'pmid',
      identifier: 'https://pubmed.ncbi.nlm.nih.gov/33245119/?from=x',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('33245119');
    }
  });

  it('strips leading zeros from a PMID extracted from a PubMed URL', () => {
    // The URL parser keeps the path digits as-is; the extracted PMID must fold
    // to the same canonical handle as `PMID: 01234567` so both hit one cache
    // row instead of forcing a redundant NCBI round-trip.
    const parsed = resolveReferenceSchema.safeParse({
      type: 'pmid',
      identifier: 'https://pubmed.ncbi.nlm.nih.gov/01234567/',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('1234567');
    }
  });

  it('does not switch type when a resolver URL is pasted into the wrong tab', () => {
    // A PubMed URL in the DOI tab must not be silently reinterpreted as a PMID;
    // it falls through to prefix normalization and fails DOI validation.
    const parsed = resolveReferenceSchema.safeParse({
      type: 'doi',
      identifier: 'https://pubmed.ncbi.nlm.nih.gov/33245119/',
    });
    expect(parsed.success).toBe(false);
  });

  it('normalizes the DOI on the create boundary too', () => {
    const parsed = createReferenceSchema.safeParse({
      type: 'doi',
      identifier: 'https://doi.org/10.1016/S0928-0987(99)00012-3',
      metadata: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identifier).toBe('10.1016/s0928-0987(99)00012-3');
    }
  });
});

describe('normalizeReferenceMetadata', () => {
  it('trims strings and drops empty strings', () => {
    expect(
      normalizeReferenceMetadata({
        title: '  Example title  ',
        journal: '   ',
        volume: ' 42 ',
        pages: ' ',
      }),
    ).toEqual({
      title: 'Example title',
      volume: '42',
    });
  });

  it('drops null authors and invalid object authors', () => {
    expect(
      normalizeReferenceMetadata({
        authors: null as unknown as string[],
      }),
    ).toEqual(null);

    expect(
      normalizeReferenceMetadata({
        authors: [{ name: 'A' }] as unknown as string[],
      }),
    ).toEqual(null);
  });

  it('keeps only non-empty author strings', () => {
    expect(
      normalizeReferenceMetadata({
        authors: [' A ', '  ', '\nB\n'],
      }),
    ).toEqual({
      authors: ['A', 'B'],
    });
  });
});


describe('normalizeReferenceMetadata year handling', () => {
  it('keeps an integer year', () => {
    expect(normalizeReferenceMetadata({ year: 2021 })).toEqual({ year: 2021 });
  });

  it('preserves an explicit null', () => {
    expect(normalizeReferenceMetadata({ year: null })).toEqual({ year: null });
  });

  it('recovers a legacy four-digit string year', () => {
    // Pre-schema rows store `"2020"`. Dropping it cost the citation its year
    // in every rendered label and filed it under "undated" on the reference
    // index's year axis.
    expect(normalizeReferenceMetadata({ year: '2020' })).toEqual({
      year: 2020,
    });
    expect(normalizeReferenceMetadata({ year: ' 1998 ' })).toEqual({
      year: 1998,
    });
  });

  it('still drops a year it cannot read', () => {
    expect(normalizeReferenceMetadata({ year: 'in press' })).toBeNull();
    expect(normalizeReferenceMetadata({ year: 2021.5 })).toBeNull();
    expect(normalizeReferenceMetadata({ year: '20' })).toBeNull();
  });
});
