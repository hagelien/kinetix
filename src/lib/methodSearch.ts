import type { AnalyticalMethod } from '@/types';

/**
 * Shortest query that may match a method.
 *
 * Method codes are four digits, so a one-character query ("1") would match
 * essentially every method and bury the drug results the user is far more
 * likely to be after. Two characters is enough to be intentional.
 */
const MIN_QUERY_LENGTH = 2;

/** Default cap on the number of suggested methods shown for a query. */
const DEFAULT_LIMIT = 5;

/**
 * Human-readable method label: the method code followed by its name.
 *
 * Guards against double-prefixing — DB-sourced names frequently already lead
 * with their code (e.g. "9001 Synthetic LC-MS/MS panel A"), while others
 * store a bare name.
 */
export function formatMethodLabel(method: AnalyticalMethod): string {
  return method.name.startsWith(method.id)
    ? method.name
    : `${method.id} ${method.name}`;
}

function haystack(method: AnalyticalMethod): string {
  return [method.id, method.name, method.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function rank(method: AnalyticalMethod, query: string): number {
  const id = method.id.toLowerCase();
  const name = method.name.toLowerCase();
  if (id === query) return 0;
  if (id.startsWith(query)) return 1;
  if (name.startsWith(query)) return 2;
  return 3;
}

/**
 * Search analytical methods by code, name or description.
 *
 * Drives the method suggestions in the drug table's search box, so a query
 * like "9001" or "panel" surfaces the matching method(s) instead of an
 * empty drug list — the drug `_searchKey` spans names and aliases only, and
 * no drug is named after the method that measures it.
 *
 * Every whitespace-separated token must appear somewhere in the method's
 * code/name/description, so "9001 lc-ms" narrows rather than widens. Results
 * are ranked exact-code → code-prefix → name-prefix → substring, then by
 * code (numerically, since codes are numeric strings).
 */
export function searchMethods(
  methods: AnalyticalMethod[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): AnalyticalMethod[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = methods.filter((method) => {
    const text = haystack(method);
    return tokens.every((token) => text.includes(token));
  });

  matches.sort((a, b) => {
    const byRank = rank(a, q) - rank(b, q);
    if (byRank !== 0) return byRank;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  return limit > 0 ? matches.slice(0, limit) : matches;
}
