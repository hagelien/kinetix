import { resolveIdentifiers } from './pubmed-eutils.js';
import {
  normalizeAltIds,
  resolverHandleFromUrl,
  type CitationAltIds,
  type CitationHandle,
} from '../../src/lib/citationHandles.js';

/**
 * Ask NCBI which handles belong to the same article (#1018).
 *
 * The write path decides where a paper is filed from the handles it is given;
 * this is what supplies the ones the caller did not declare — the PMID behind a
 * DOI, or the DOI behind a PMID. It lives outside the store deliberately: the
 * store must stay deterministic and network-free, the way
 * `resolveAuthoritativeMetadata` sits in the route rather than in the DB layer.
 *
 * **Best effort by design.** A citation write must not fail because NCBI is
 * slow, rate-limiting, or down; an unresolved crosswalk just means the paper is
 * filed under the handle the caller declared, which is the pre-#1018 behaviour
 * and no worse. Nothing here throws.
 */

/** Handle types the ID converter can actually resolve. */
function resolvable(handle: CitationHandle): boolean {
  return handle.type === 'pmid' || handle.type === 'doi';
}

/**
 * Resolve the alternate handles for a batch of citation handles.
 *
 * Returns a map keyed by `type:identifier` — the caller's own handle spelling,
 * so a lookup needs no re-normalization. Handles the converter did not place
 * are simply absent.
 */
export async function resolveCitationCrosswalk(
  handles: ReadonlyArray<CitationHandle>,
): Promise<Map<string, CitationAltIds>> {
  const out = new Map<string, CitationAltIds>();
  const lookups = handles.filter(resolvable);
  if (lookups.length === 0) return out;

  // The converter is queried by identifier, and `resolveIdentifiers` keys its
  // answer by the id as supplied — so identical identifiers under different
  // declared types collapse to one lookup.
  const byIdentifier = new Map<string, CitationHandle[]>();
  for (const handle of lookups) {
    const list = byIdentifier.get(handle.identifier) ?? [];
    list.push(handle);
    byIdentifier.set(handle.identifier, list);
  }

  let resolved: Awaited<ReturnType<typeof resolveIdentifiers>>;
  try {
    resolved = await resolveIdentifiers([...byIdentifier.keys()]);
  } catch {
    // Silent: an unresolved crosswalk is a missing enrichment, not an error the
    // caller can act on. The row still gets written under its declared handle.
    return out;
  }

  for (const record of resolved) {
    const alt = normalizeAltIds({
      pmid: record.pmid ?? undefined,
      doi: record.doi ?? undefined,
      pmcid: record.pmcid ?? undefined,
    });
    if (Object.keys(alt).length === 0) continue;
    for (const handle of byIdentifier.get(record.requestedId) ?? []) {
      out.set(`${handle.type}:${handle.identifier}`, alt);
    }
  }
  return out;
}

/** Single-handle convenience wrapper. */
export async function resolveOneCrosswalk(
  handle: CitationHandle,
): Promise<CitationAltIds> {
  const map = await resolveCitationCrosswalk([handle]);
  return map.get(`${handle.type}:${handle.identifier}`) ?? {};
}

/**
 * Crosswalk every source in a parsed research document, keyed by `sourceId` —
 * the shape `runImport` takes as `opts.crosswalk`. Sources that already declare
 * both a PMID and a DOI are skipped: the document is its own crosswalk there,
 * and asking NCBI would only spend rate budget to learn what we know.
 */
export async function resolveImportCrosswalk(
  sources: ReadonlyArray<{
    sourceId: string;
    type: string;
    identifier: string;
    altIds: CitationAltIds;
  }>,
): Promise<Map<string, CitationAltIds>> {
  const needing = sources.filter(
    (source) =>
      (source.type === 'pmid' || source.type === 'doi') &&
      !source.altIds.pmid &&
      !source.altIds.doi,
  );
  const byHandle = await resolveCitationCrosswalk(
    needing.map((source) => ({
      type: source.type as CitationHandle['type'],
      identifier: source.identifier,
    })),
  );

  const bySourceId = new Map<string, CitationAltIds>();
  for (const source of needing) {
    const alt = byHandle.get(`${source.type}:${source.identifier}`);
    if (alt) bySourceId.set(source.sourceId, alt);
  }
  return bySourceId;
}

/**
 * Crosswalk every source in a conversation-ingestion bundle, keyed by the
 * bundle's own source key.
 *
 * Deliberately does NOT skip sources that already declare alternate handles,
 * which is where this differs from {@link resolveImportCrosswalk}. That one
 * trusts the document as its own crosswalk because a pinned research prompt
 * produced it; an ingestion bundle comes from an unpinned model in someone
 * else's chat window, and a well-formed but wrong `altIds.doi` is exactly the
 * kind of thing such a model emits. Since `resolveCitation` treats a crosswalk
 * as authoritative — up to merging two rows into one — an unverified alias
 * could fold two genuinely different papers together, repointing their
 * references and reviews. So the alternate handles used on the write path come
 * from the ID converter or from nowhere.
 */
export async function resolveIngestionCrosswalk(
  sources: ReadonlyArray<{ key: string; type: string; identifier: string }>,
): Promise<Map<string, CitationAltIds>> {
  // A `url` source can be a resolver address — `https://doi.org/10.x/y` is a
  // DOI wearing a URL — and asking the converter about the URL gets nothing.
  // Unwrap first, so the paper behind the link is looked up and its other
  // handles come back; otherwise an existing DOI row is missed and the write
  // mints a second citation for the same paper.
  const lookupOf = (source: { type: string; identifier: string }) => {
    const unwrapped = resolverHandleFromUrl(source.identifier);
    if (unwrapped && (unwrapped.type === 'pmid' || unwrapped.type === 'doi')) {
      return unwrapped;
    }
    return source.type === 'pmid' || source.type === 'doi'
      ? { type: source.type as CitationHandle['type'], identifier: source.identifier }
      : null;
  };

  const lookups = sources
    .map(lookupOf)
    .filter((handle): handle is CitationHandle => handle !== null);
  const byHandle = await resolveCitationCrosswalk(lookups);

  const byKey = new Map<string, CitationAltIds>();
  for (const source of sources) {
    const handle = lookupOf(source);
    if (!handle) continue;
    const alt = byHandle.get(`${handle.type}:${handle.identifier}`);
    // The unwrapped handle itself is knowledge the write path needs: without
    // it, a doi.org URL is filed as a URL even when the converter says nothing.
    const merged = { ...(alt ?? {}), [handle.type]: handle.identifier };
    byKey.set(source.key, merged as CitationAltIds);
  }
  return byKey;
}
