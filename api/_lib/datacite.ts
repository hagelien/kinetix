/**
 * What a DOI is, when Crossref has never heard of it (§13.3).
 *
 * This exists because of where datasets actually live. The admission gate
 * refuses an unpublished dataset admitted under a DOI, and a DOI is asked about
 * through the registrar that minted it — but research datasets are registered
 * almost entirely with DataCite, not Crossref, so `api.crossref.org` answers
 * `404` for precisely the objects the gate was written to catch. Asking
 * Crossref alone would leave the headline case answering "unknown" and the rule
 * resting on the few datasets a publisher happened to deposit with Crossref.
 *
 * Only the resource type is read. DataCite's metadata is rich, but nothing here
 * needs a title or an author: the citation's own metadata comes from the
 * handles Kinetix already resolves, and this call exists to answer one
 * question.
 */
import { politeUserAgent } from './polite-user-agent.js';

export interface DataCiteRecord {
  /**
   * `attributes.types.resourceTypeGeneral` as DataCite returns it — a raw
   * provider string, canonicalised by `workKindFromDataCiteType` before
   * anything reads it as a kind.
   */
  resourceTypeGeneral: string | null;
}

/**
 * The DataCite record for a DOI, or null when DataCite does not have it.
 *
 * Throws on a transient upstream failure, the same contract
 * `fetchCrossRefMetadata` uses, so the caller can tell "DataCite says no such
 * DOI" from "DataCite could not be reached" — the difference between a handle
 * that was examined and one that must be asked again.
 */
export async function fetchDataCiteRecord(
  doi: string,
): Promise<DataCiteRecord | null> {
  const url = `https://api.datacite.org/dois/${encodeURIComponent(doi)}`;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.api+json',
      'User-Agent': politeUserAgent(),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`DataCite lookup failed with status ${res.status}`);
    }
    return null;
  }

  const data = await res.json();
  const attributes = data?.data?.attributes;
  if (!attributes) return null;

  const general = attributes.types?.resourceTypeGeneral;
  return {
    resourceTypeGeneral: typeof general === 'string' ? general : null,
  };
}
