import { politeUserAgent } from './polite-user-agent.js';

export interface CrossRefMetadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
  /**
   * Crossref's own `work.type`, unmapped and unvalidated (§13.3). The record
   * already carries it and the classifier needs it, so it rides along rather
   * than costing a second call — but it is a raw provider string, so nothing
   * compares or stores it before `workKindFromCrossrefType` has canonicalised
   * it. `normalizeReferenceMetadata` does not carry this field, so it cannot
   * reach `citations.metadata` by accident.
   */
  workType: string | null;
}

export async function fetchCrossRefMetadata(
  doi: string,
): Promise<CrossRefMetadata | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': politeUserAgent(),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`CrossRef lookup failed with status ${res.status}`);
    }
    return null;
  }

  const data = await res.json();
  const work = data?.message;
  if (!work) return null;

  return {
    title: Array.isArray(work.title) ? (work.title[0] ?? '') : '',
    authors: (work.author ?? []).map((a: { given?: string; family?: string }) =>
      [a.family, a.given].filter(Boolean).join(' '),
    ),
    journal: Array.isArray(work['container-title'])
      ? (work['container-title'][0] ?? '')
      : '',
    year: work.published?.['date-parts']?.[0]?.[0] ?? null,
    volume: work.volume || null,
    pages: work.page || null,
    workType: typeof work.type === 'string' ? work.type : null,
  };
}
