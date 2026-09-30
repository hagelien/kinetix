export interface PubMedMetadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
  /**
   * esummary's `pubtype`, exactly as PubMed returns it (§13.3): a mixed list of
   * object kind and study design. Canonicalised by `workKindFromPubMedTypes`
   * before anything reads it as a kind; never stored raw.
   */
  publicationTypes: string[];
}

export async function fetchPubMedMetadata(
  pmid: string,
): Promise<PubMedMetadata | null> {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`PubMed lookup failed with status ${res.status}`);
    }
    return null;
  }

  const data = await res.json();
  const doc = data?.result?.[pmid];
  if (!doc || doc.error) return null;

  return {
    title: doc.title ?? '',
    authors: (doc.authors ?? []).map((a: { name: string }) => a.name),
    journal: doc.source ?? '',
    year: doc.pubdate ? parseInt(doc.pubdate, 10) || null : null,
    volume: doc.volume || null,
    pages: doc.pages || null,
    publicationTypes: Array.isArray(doc.pubtype)
      ? doc.pubtype.filter((type: unknown): type is string => typeof type === 'string')
      : [],
  };
}
