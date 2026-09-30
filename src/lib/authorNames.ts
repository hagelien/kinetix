/**
 * Author-name parsing shared by the citation formatter (`citationFormat.ts`)
 * and the server-side reference index (`api/_lib/reference-index.ts`).
 *
 * Both surfaces need the same answer to "what does this author file under?" —
 * the inline marker renders "[Huertas 2020]" and the A–Å author axis buckets
 * and sorts by the same surname — so the heuristic lives in one pure module
 * rather than being reimplemented (and drifting) on either side.
 */

/**
 * Pull the surname out of an NLM-style author entry, e.g.
 *   "Huertas T"           → "Huertas"
 *   "Schmoldt-Andresen S" → "Schmoldt-Andresen"
 *   "Doe John"            → "Doe"
 * Returns the string trimmed if no whitespace boundary exists.
 */
export function authorSurname(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0] ?? trimmed;

  const normalizedParts = parts.map((part) => part.replace(/[.,;:]+$/g, ''));
  const isSingleInitial = (part: string) => /^[A-Z]\.?$/.test(part);
  const isInitialCluster = (part: string) => /^[A-Z]{1,3}\.?$/.test(part);
  const isAcronym = (part: string) => /^[A-Z]{2,}$/.test(part);
  const isSuffix = (part: string) => /^(jr|sr|ii|iii|iv|v)$/i.test(part);
  const isLikelyOrganization = normalizedParts.some((part) =>
    /^(agency|administration|association|authority|centre|center|college|committee|compendium|council|department|division|foundation|group|institute|laboratory|ministry|organization|organisation|society|union|university)$|^(ema|fda|who)$/i.test(
      part,
    ),
  );

  if (isLikelyOrganization || normalizedParts.every(isAcronym)) {
    return trimmed;
  }
  if (normalizedParts.slice(0, -1).every(isSingleInitial)) {
    return parts[parts.length - 1] ?? trimmed;
  }
  if (isInitialCluster(normalizedParts[parts.length - 1] ?? '')) {
    return parts[0] ?? trimmed;
  }
  if (
    parts.length >= 3 &&
    isSuffix(normalizedParts[parts.length - 1] ?? '') &&
    isInitialCluster(normalizedParts[parts.length - 2] ?? '')
  ) {
    return parts[0] ?? trimmed;
  }
  if (
    parts.length >= 3 &&
    !isSuffix(normalizedParts[parts.length - 1] ?? '') &&
    normalizedParts.slice(1, -1).some(isInitialCluster)
  ) {
    return parts[parts.length - 1] ?? trimmed;
  }
  if (parts.length === 2) {
    return parts[0] ?? trimmed;
  }

  return trimmed;
}

/**
 * The author list of a citation, from either shape `metadata.authors` takes:
 * the array current rows store, or the comma-separated string legacy rows
 * carry. Anything else — a number, an object, absent — is no author list.
 */
export function normalizeAuthorList(authorsRaw: unknown): string[] {
  if (Array.isArray(authorsRaw)) {
    return authorsRaw.filter(
      (a): a is string => typeof a === 'string' && a.trim().length > 0,
    );
  }
  if (typeof authorsRaw === 'string' && authorsRaw.trim()) {
    return authorsRaw.split(/,\s*/).filter((p) => p.trim().length > 0);
  }
  return [];
}

/**
 * Surname of the author a bibliography files a source under — the first named
 * author, skipping blank entries a hand-typed metadata blob may carry. Empty
 * when the source has no author at all (a standard, a dataset, a web page).
 */
export function firstAuthorSurname(authors: unknown): string {
  for (const entry of normalizeAuthorList(authors)) {
    const surname = authorSurname(entry);
    if (surname) return surname;
  }
  return '';
}
