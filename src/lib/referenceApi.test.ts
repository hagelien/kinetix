import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createReference,
  referenceExternalHref,
  type ReferenceRow,
} from '@/lib/referenceApi';
import { waitForCitationPdf } from '@/lib/referencesApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function row(partial: Partial<ReferenceRow>): ReferenceRow {
  return {
    id: 1,
    drugId: null,
    type: 'doi',
    identifier: '10.1093/jat/bkaa044',
    metadata: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('referenceExternalHref', () => {
  it('builds doi.org links for DOI rows', () => {
    expect(referenceExternalHref(row({ type: 'doi' }))).toBe(
      'https://doi.org/10.1093/jat/bkaa044',
    );
  });

  it('normalizes pasted DOI prefixes', () => {
    expect(
      referenceExternalHref(
        row({ type: 'doi', identifier: 'https://doi.org/10.1093/jat/bkaa044' }),
      ),
    ).toBe('https://doi.org/10.1093/jat/bkaa044');
  });

  it('percent-escapes DOI query and fragment delimiters', () => {
    expect(
      referenceExternalHref(
        row({ type: 'doi', identifier: '10.1000/example?query#section' }),
      ),
    ).toBe('https://doi.org/10.1000/example%3Fquery%23section');
  });

  it('preserves already percent-escaped DOI delimiters', () => {
    expect(
      referenceExternalHref(
        row({
          type: 'doi',
          identifier: 'https://doi.org/10.1000/example%3Fquery%23section',
        }),
      ),
    ).toBe('https://doi.org/10.1000/example%3Fquery%23section');
  });

  it('builds PubMed links for PMID rows', () => {
    expect(
      referenceExternalHref(
        row({ type: 'pmid', identifier: 'PMID: 33313886' }),
      ),
    ).toBe('https://pubmed.ncbi.nlm.nih.gov/33313886/');
  });

  it('returns URL identifiers directly', () => {
    expect(
      referenceExternalHref(
        row({ type: 'url', identifier: 'https://example.org' }),
      ),
    ).toBe('https://example.org');
  });

  it('does not link unsafe URL schemes', () => {
    expect(
      referenceExternalHref(
        row({ type: 'url', identifier: 'javascript:alert(1)' }),
      ),
    ).toBeNull();
  });

  it('leaves freetext rows unlinked', () => {
    expect(
      referenceExternalHref(
        row({ type: 'freetext', identifier: 'Baselt 2020' }),
      ),
    ).toBeNull();
  });
});

describe('createReference', () => {
  it('preserves stable API error codes for client translation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error:
              'Reference metadata does not match the resolved identifier title',
            code: 'reference_metadata_mismatch',
          }),
      }),
    );

    await expect(
      createReference({
        type: 'doi',
        identifier: '10.1000/test',
        metadata: null,
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'reference_metadata_mismatch',
    } satisfies Partial<ApiError>);
  });

  it('preserves the HTTP status when the error body is not JSON', async () => {
    // A gateway/proxy 429 can arrive as an HTML page. `res.json()` would throw
    // a SyntaxError before the status is read, masking the throttle as a
    // generic failure; `res.text()` + tolerant parse keeps the 429 intact.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => '<html><body>Too Many Requests</body></html>',
      }),
    );

    await expect(
      createReference({ type: 'pmid', identifier: '10425374', metadata: null }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: undefined,
    } satisfies Partial<ApiError>);
  });

  it('preserves the HTTP status when the error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => '',
      }),
    );

    await expect(
      createReference({ type: 'pmid', identifier: '10425374', metadata: null }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: undefined,
    } satisfies Partial<ApiError>);
  });
});

describe('waitForCitationPdf', () => {
  it('waits until the PDF request endpoint confirms storage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ request: { status: 'open' }, hasPdf: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ request: null, hasPdf: true }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      waitForCitationPdf(12, { attempts: 2, intervalMs: 0 }),
    ).resolves.toEqual({ request: null, hasPdf: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
