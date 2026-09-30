import { describe, expect, it } from 'vitest';
import {
  citationExternalHref,
  citationShortLabel,
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import type { CitationRow } from '@/lib/referencesApi';

function row(partial: Partial<CitationRow>): CitationRow {
  return {
    id: 1,
    drugId: null,
    type: 'doi',
    identifier: '10.1093/jat/bkaa044',
    metadata: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('citationShortLabel', () => {
  it('renders "Surname Year" for a single-author NLM citation', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['Huertas T'] as unknown as string,
            year: 2020,
          },
        }),
      ),
    ).toBe('Huertas 2020');
  });

  it('uses "Surname et al. Year" once there are two or more authors', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: [
              'Huertas T',
              'Jurado C',
              'Salguero M',
            ] as unknown as string,
            year: 2020,
          },
        }),
      ),
    ).toBe('Huertas et al. 2020');
  });

  it('parses comma-separated string authors (legacy rows)', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: 'Huertas T, Jurado C',
            year: '2020',
          },
        }),
      ),
    ).toBe('Huertas et al. 2020');
  });

  it('handles legacy authors stored as initials before surname', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: 'S H Wan, S B Matin, D L Azarnoff',
            year: 1978,
          },
        }),
      ),
    ).toBe('Wan et al. 1978');
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: 'A H Beckett, J A Salmon, M Mitchard',
            year: 1969,
          },
        }),
      ),
    ).toBe('Beckett et al. 1969');
  });

  it('keeps organization names instead of truncating to the first word', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['European Union Drugs Agency'] as unknown as string,
            year: 2026,
          },
        }),
      ),
    ).toBe('European Union Drugs Agency 2026');
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['electronic Medicines Compendium'] as unknown as string,
            year: 2026,
          },
        }),
      ),
    ).toBe('electronic Medicines Compendium 2026');
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['US FDA'] as unknown as string,
            year: 2026,
          },
        }),
      ),
    ).toBe('US FDA 2026');
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['World Health Organization WHO'] as unknown as string,
            year: 2026,
          },
        }),
      ),
    ).toBe('World Health Organization WHO 2026');
  });

  it('keeps full-name personal authors compact', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['Natalia B Ivanova'] as unknown as string,
            year: 2020,
          },
        }),
      ),
    ).toBe('Ivanova 2020');
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['Doe John'] as unknown as string,
            year: 2020,
          },
        }),
      ),
    ).toBe('Doe 2020');
  });

  it('does not use suffix tokens as the surname', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            authors: ['Smith JA Jr.'] as unknown as string,
            year: 2020,
          },
        }),
      ),
    ).toBe('Smith 2020');
  });

  it('falls back to the surname when only the year is missing', () => {
    expect(
      citationShortLabel(
        row({
          metadata: { authors: ['Huertas T'] as unknown as string },
        }),
      ),
    ).toBe('Huertas');
  });

  it('falls back to the year when the author is missing', () => {
    expect(citationShortLabel(row({ metadata: { year: 2020 } }))).toBe('2020');
  });

  it('uses the title (truncated) when neither author nor year is set', () => {
    expect(
      citationShortLabel(
        row({
          metadata: {
            title:
              'Some really very long title that exceeds the 40-character truncation budget',
          },
        }),
      ),
    ).toBe('Some really very long title that exce…');
  });

  it('falls through to the identifier for freetext rows with no metadata', () => {
    expect(
      citationShortLabel(
        row({ type: 'freetext', identifier: 'Baselt 2020', metadata: null }),
      ),
    ).toBe('Baselt 2020');
  });
});

describe('citationExternalHref', () => {
  it('produces a doi.org URL for DOI rows', () => {
    expect(
      citationExternalHref(
        row({ type: 'doi', identifier: '10.1093/jat/bkaa044' }),
      ),
    ).toBe('https://doi.org/10.1093/jat/bkaa044');
  });

  it('strips a leading "doi:" prefix users may have pasted', () => {
    expect(
      citationExternalHref(
        row({ type: 'doi', identifier: 'doi: 10.1093/jat/bkaa044' }),
      ),
    ).toBe('https://doi.org/10.1093/jat/bkaa044');
  });

  it('produces a PubMed URL for PMID rows', () => {
    expect(
      citationExternalHref(row({ type: 'pmid', identifier: '33313886' })),
    ).toBe('https://pubmed.ncbi.nlm.nih.gov/33313886/');
  });

  it('returns the identifier verbatim for url-type rows', () => {
    expect(
      citationExternalHref(
        row({ type: 'url', identifier: 'https://example.org/x' }),
      ),
    ).toBe('https://example.org/x');
  });

  it('does not link unsafe URL schemes', () => {
    expect(
      citationExternalHref(
        row({ type: 'url', identifier: 'javascript:alert(1)' }),
      ),
    ).toBe(null);
  });

  it('does not link malformed URL identifiers', () => {
    expect(
      citationExternalHref(row({ type: 'url', identifier: 'not a url' })),
    ).toBe(null);
  });

  it('percent-escapes DOI query and fragment delimiters', () => {
    expect(
      citationExternalHref(
        row({ type: 'doi', identifier: '10.1000/example?query#section' }),
      ),
    ).toBe('https://doi.org/10.1000/example%3Fquery%23section');
  });

  it('returns null for freetext rows so the caller falls back to the in-page anchor', () => {
    expect(
      citationExternalHref(
        row({ type: 'freetext', identifier: 'Baselt 2020' }),
      ),
    ).toBe(null);
  });

  it('links freetext rows whose identifier is a bare http(s) URL', () => {
    expect(
      citationExternalHref(
        row({
          type: 'freetext',
          identifier:
            'https://www.diakonhjemmetsykehus.no/avdelinger/legemiddelanalyser/',
        }),
      ),
    ).toBe(
      'https://www.diakonhjemmetsykehus.no/avdelinger/legemiddelanalyser/',
    );
  });

  it('does not link freetext identifiers with unsafe schemes', () => {
    expect(
      citationExternalHref(
        row({ type: 'freetext', identifier: 'javascript:alert(1)' }),
      ),
    ).toBe(null);
  });
});

describe('citation tooltip formatting', () => {
  it('formats one, two, and three-or-more authors for compact tooltips', () => {
    expect(
      citationTooltipLabel(
        row({
          metadata: { authors: ['Baselt RC'] as unknown as string, year: 2020 },
        }),
      ),
    ).toBe('Baselt, 2020');
    expect(
      citationTooltipLabel(
        row({
          metadata: {
            authors: ['Moriya F', 'Hashimoto Y'] as unknown as string,
            year: 1996,
          },
        }),
      ),
    ).toBe('Moriya & Hashimoto, 1996');
    expect(
      citationTooltipLabel(
        row({
          metadata: {
            authors: ['Huestis MA', 'Cone EJ', 'Wong CJ'] as unknown as string,
            year: 2011,
          },
        }),
      ),
    ).toBe('Huestis et al., 2011');
  });

  it('uses the title line or identifier for tooltip titles', () => {
    expect(
      citationTooltipTitle(
        row({ metadata: { title: 'Oral fluid drug testing', year: 2011 } }),
      ),
    ).toBe('Oral fluid drug testing');
    expect(
      citationTooltipTitle(
        row({ type: 'freetext', identifier: 'Baselt 2020' }),
      ),
    ).toBe('Baselt 2020');
  });
});
