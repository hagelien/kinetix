/**
 * NCBI E-utilities client for the PubMed MCP server (`api/mcp.ts`).
 *
 * Deliberately separate from `pubmed.ts`, which stays a single-purpose
 * esummary lookup used by the citation-resolution routes. This module is the
 * broader read-only client: search, record metadata, MEDLINE abstracts,
 * related articles, ID conversion and PMC open-access full text.
 *
 * NCBI usage rules (https://www.ncbi.nlm.nih.gov/books/NBK25497/):
 *  - identify yourself with `tool` and `email` on every request;
 *  - stay under 3 requests/second without an API key, 10/second with one.
 * Both are handled here: every outbound call goes through `schedule()`, which
 * serialises requests behind a minimum interval, and `NCBI_API_KEY` /
 * `NCBI_TOOL_EMAIL` are attached when configured.
 */

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
// NCBI moved the ID converter off www.ncbi.nlm.nih.gov in 2024; the old
// /pmc/utils/idconv/v1.0/ path only 301-redirects here.
const ID_CONVERTER_URL =
  'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/';
const TOOL_NAME = 'kinetix-pubmed-mcp';

/** NCBI caps a single esummary/efetch `id=` list at a few hundred UIDs. */
export const MAX_IDS_PER_REQUEST = 200;

export class PubMedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PubMedError';
  }
}

function apiKey(): string | null {
  return process.env.NCBI_API_KEY?.trim() || null;
}

function contactEmail(): string | null {
  return process.env.NCBI_TOOL_EMAIL?.trim() || null;
}

// ─── Politeness throttle ────────────────────────────────────────────────────
// Best-effort and per-instance (same contract as `_lib/rate-limit.ts`): a
// serverless deployment can run several instances concurrently, so this
// bounds our own burstiness rather than guaranteeing a global ceiling. The
// intervals sit under NCBI's published limits to leave headroom.
const MIN_INTERVAL_WITH_KEY_MS = 110; // ~9 req/s against a 10 req/s ceiling
const MIN_INTERVAL_NO_KEY_MS = 360; // ~2.8 req/s against a 3 req/s ceiling

let requestChain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedule<T>(run: () => Promise<T>): Promise<T> {
  const minInterval = apiKey()
    ? MIN_INTERVAL_WITH_KEY_MS
    : MIN_INTERVAL_NO_KEY_MS;

  const result = requestChain.then(async () => {
    const wait = lastRequestAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return run();
  });

  // Keep the chain alive after a failure so one bad call does not poison
  // every later request.
  requestChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Reset throttle bookkeeping. Test seam only. */
export function resetPubMedThrottle(): void {
  requestChain = Promise.resolve();
  lastRequestAt = 0;
}

// ─── Low-level request ──────────────────────────────────────────────────────

interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
}

/**
 * Longest `Retry-After` we will wait out. Beyond this, sleeping would blow a
 * serverless invocation budget while achieving nothing, so the wait is reported
 * to the caller instead — who can back off properly rather than have us burn
 * the remaining attempts against a throttle that is still in force.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/** `Retry-After` is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);

  return null;
}

/**
 * Above this, the request is sent form-encoded with POST instead. E-utilities
 * accepts every parameter either way, and a long systematic-review query or a
 * batch of long DOIs otherwise produces a URL that NCBI answers with 414 and an
 * HTML error page — a confusing "malformed JSON" failure two layers down.
 * 2000 is the conservative practical limit that intermediaries also honour.
 */
const MAX_GET_URL_LENGTH = 2000;

function buildParams(
  params: Record<string, string | number | undefined | null>,
): URLSearchParams {
  const search = new URLSearchParams();
  search.set('tool', TOOL_NAME);
  const email = contactEmail();
  if (email) search.set('email', email);
  const key = apiKey();
  if (key) search.set('api_key', key);

  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(name, String(value));
  }
  return search;
}

async function request(
  base: string,
  params: Record<string, string | number | undefined | null>,
  options: RequestOptions = {},
): Promise<string> {
  const { timeoutMs = 15_000, retries = 2 } = options;
  const search = buildParams(params);
  const url = `${base}?${search.toString()}`;
  const usePost = url.length > MAX_GET_URL_LENGTH;

  let lastError: PubMedError | null = null;
  // Set from a 429's Retry-After so the next attempt waits as long as NCBI
  // asked, rather than the fixed backoff it would otherwise use.
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(retryAfterMs ?? 400 * attempt);
      retryAfterMs = null;
    }

    let res: Response;
    try {
      res = await schedule(() =>
        fetch(usePost ? base : url, {
          ...(usePost
            ? {
                method: 'POST',
                body: search.toString(),
              }
            : {}),
          headers: {
            Accept: 'text/plain, application/json, application/xml',
            ...(usePost
              ? { 'Content-Type': 'application/x-www-form-urlencoded' }
              : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (err) {
      // A rejected fetch never reaches the status checks below: DNS failures,
      // socket resets and the AbortSignal timeout all throw instead of
      // returning a Response. They are the most transient failures there are,
      // so they have to be caught here to be retried at all.
      lastError = new PubMedError(
        `NCBI request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!res.ok) {
      // 429 (rate limit) and 5xx are transient; 4xx is a bad request we should
      // surface immediately rather than hammering NCBI with retries.
      if (res.status !== 429 && res.status < 500) {
        throw new PubMedError(
          `NCBI request failed with status ${res.status}`,
          res.status,
        );
      }

      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'));
        if (wait !== null && wait > MAX_RETRY_AFTER_MS) {
          // Retrying inside this window is pointless and impolite; hand the
          // caller a number they can act on.
          throw new PubMedError(
            `NCBI rate limit in force; Retry-After is ${Math.ceil(wait / 1000)}s. ` +
              'Set NCBI_API_KEY to raise the ceiling from 3 to 10 requests/second.',
            429,
          );
        }
        retryAfterMs = wait;
      }

      lastError = new PubMedError(
        `NCBI request failed with status ${res.status}`,
        res.status,
      );
      continue;
    }

    try {
      // Reading the body has to be inside the guarded attempt too: headers can
      // arrive fine and the stream still reset or time out afterwards, which is
      // most likely on the large PMC XML responses. Retrying re-issues the
      // whole request, which is safe — every E-utilities call here is a read.
      return await res.text();
    } catch (err) {
      lastError = new PubMedError(
        `NCBI response body could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  throw lastError ?? new PubMedError('NCBI request failed');
}

async function requestJson<T>(
  base: string,
  params: Record<string, string | number | undefined | null>,
  options?: RequestOptions,
): Promise<T> {
  const body = await request(base, { ...params, retmode: 'json' }, options);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new PubMedError('NCBI returned a malformed JSON response');
  }
}

// ─── Shared shapes ──────────────────────────────────────────────────────────

export interface PubMedRecord {
  pmid: string;
  title: string;
  authors: string[];
  /**
   * Subset of `authors` that esummary marks `CollectiveName` — consortia,
   * study groups, writing committees. Carried through so citation formatters
   * do not have to guess: a name like "Study Team ABC" ends in something that
   * looks exactly like initials, and inventing "Team, A. B. C." out of an
   * organisation is not a recoverable error downstream.
   */
  collectiveAuthors: string[];
  journal: string;
  journalAbbrev: string | null;
  year: number | null;
  publicationDate: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  pmcid: string | null;
  publicationTypes: string[];
  url: string;
}

export interface PubMedSearchResult {
  /**
   * The exact term string sent to esearch, including the publication-type and
   * date clauses. Self-contained: paste it into PubMed and the same result set
   * comes back. Quote this for reproducibility.
   */
  query: string;
  /** NCBI's own expansion of that term (MeSH mapping, synonyms). */
  translatedQuery: string | null;
  /**
   * The one constraint that cannot live inside the query string. Repeating the
   * query without it reproduces the result *set* but not its order.
   */
  sort: PubMedSort;
  /** Total hits for the query, which may exceed the records returned. */
  total: number;
  offset: number;
  warnings: string[];
  records: PubMedRecord[];
}

export interface PubMedAbstract {
  pmid: string;
  title: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmcid: string | null;
  publicationTypes: string[];
  meshTerms: string[];
  /** Null when PubMed indexes no abstract for the record (common pre-1975). */
  abstract: string | null;
  /**
   * Where `abstract` came from: 'medline' is the indexed abstract (MEDLINE
   * `AB`), 'publisher' the publisher-supplied one (`OAB`) used when there is no
   * indexed abstract. Null when there is no abstract at all.
   */
  abstractSource: 'medline' | 'publisher' | null;
  /**
   * Additional abstracts the record carries beyond `abstract` — usually empty.
   * Kept separate rather than concatenated: they are alternate versions, and
   * running them together reads as one continuous abstract with duplicated
   * claims.
   */
  otherAbstracts: string[];
  copyright: string | null;
}

export interface RelatedArticle {
  pmid: string;
  /** NCBI relatedness score; higher is closer. Null when unscored. */
  score: number | null;
}

export interface ResolvedIdentifier {
  /** The identifier as the caller supplied it. */
  requestedId: string;
  pmid: string | null;
  pmcid: string | null;
  doi: string | null;
  /** How the identifier was resolved, or why it was not. */
  status: string | null;
}

export interface PmcFullText {
  pmcid: string;
  /** Null when the article is outside the PMC open-access subset. */
  text: string | null;
  available: boolean;
  note: string;
}

// ─── esummary → PubMedRecord ────────────────────────────────────────────────

interface ESummaryDoc {
  uid?: string;
  title?: string;
  authors?: Array<{ name?: string; authtype?: string }>;
  source?: string;
  fulljournalname?: string;
  pubdate?: string;
  sortpubdate?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  pubtype?: string[];
  articleids?: Array<{ idtype?: string; value?: string }>;
  error?: string;
}

function parseYear(...candidates: Array<string | undefined>): number | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = /(\d{4})/.exec(candidate);
    if (match?.[1]) {
      const year = Number(match[1]);
      if (Number.isFinite(year)) return year;
    }
  }
  return null;
}

function normalizePmcid(value: string): string {
  const trimmed = value.trim();
  return trimmed.toUpperCase().startsWith('PMC') ? trimmed : `PMC${trimmed}`;
}

function docToRecord(uid: string, doc: ESummaryDoc): PubMedRecord {
  const ids = doc.articleids ?? [];
  const byType = (type: string): string | null => {
    const hit = ids.find(
      (id) => id.idtype?.toLowerCase() === type && id.value?.trim(),
    );
    return hit?.value?.trim() ?? null;
  };

  const pmc = byType('pmc') ?? byType('pmcid');

  // esummary sometimes appends a correspondence address to a collective name
  // ("GBD 2023 LMIC Mental Disorders Collaborators. Electronic address:
  // …@gmail.com"), which has no business in a citation.
  const cleanName = (name: string): string =>
    name
      .replace(/\.?\s*Electronic address:.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

  const authorEntries = (doc.authors ?? [])
    .map((a) => ({ name: cleanName(a.name ?? ''), authtype: a.authtype }))
    .filter((a) => a.name);

  return {
    pmid: uid,
    title: (doc.title ?? '').replace(/\s+/g, ' ').trim(),
    authors: authorEntries.map((a) => a.name),
    collectiveAuthors: authorEntries
      .filter((a) => a.authtype === 'CollectiveName')
      .map((a) => a.name),
    journal: doc.fulljournalname?.trim() || doc.source?.trim() || '',
    journalAbbrev: doc.source?.trim() || null,
    year: parseYear(doc.pubdate, doc.sortpubdate),
    publicationDate: doc.pubdate?.trim() || null,
    volume: doc.volume?.trim() || null,
    issue: doc.issue?.trim() || null,
    pages: doc.pages?.trim() || null,
    doi: byType('doi'),
    pmcid: pmc ? normalizePmcid(pmc) : null,
    publicationTypes: (doc.pubtype ?? []).filter(Boolean),
    url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function fetchRecords(pmids: string[]): Promise<PubMedRecord[]> {
  const unique = [...new Set(pmids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const records: PubMedRecord[] = [];
  for (const batch of chunk(unique, MAX_IDS_PER_REQUEST)) {
    const data = await requestJson<{
      result?: Record<string, ESummaryDoc | string[]> & { uids?: string[] };
    }>(`${EUTILS_BASE}/esummary.fcgi`, {
      db: 'pubmed',
      id: batch.join(','),
      version: '2.0',
    });

    const result = data.result ?? {};
    const uids = Array.isArray(result.uids) ? result.uids : batch;
    for (const uid of uids) {
      const doc = result[uid];
      if (!doc || Array.isArray(doc) || doc.error) continue;
      records.push(docToRecord(uid, doc));
    }
  }

  // Preserve caller order; esummary returns UIDs in its own order.
  const byPmid = new Map(records.map((r) => [r.pmid, r]));
  return unique
    .map((pmid) => byPmid.get(pmid))
    .filter((r): r is PubMedRecord => Boolean(r));
}

// ─── esearch ────────────────────────────────────────────────────────────────

export type PubMedSort = 'relevance' | 'pub_date' | 'author' | 'journal';

/**
 * Entrez sort values differ from the names we expose. Getting one wrong is
 * silent: esearch answers `"Unknown sort schema 'journal' ignored"` in
 * `warninglist.outputmessages` and returns default-ordered results, so a
 * mismatch looks like a successful search in the wrong order.
 *
 * Verified against esearch: `pub_date` and `author` are accepted verbatim
 * (`author` is case-insensitive), `journal` is not — it must be `JournalName`.
 * `relevance` is the default and is sent as no parameter at all.
 */
const ENTREZ_SORT: Record<PubMedSort, string | undefined> = {
  relevance: undefined,
  pub_date: 'pub_date',
  author: 'author',
  journal: 'JournalName',
};

/**
 * Entrez applies a date filter only when *both* bounds are present — given one,
 * it ignores the filter entirely and silently returns the unfiltered set. These
 * open the half-specified range instead of dropping it.
 */
const EARLIEST_ENTREZ_DATE = '1000';
const LATEST_ENTREZ_DATE = '3000';

export interface SearchInput {
  query: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  articleTypes?: string[];
  maxResults?: number;
  offset?: number;
  sort?: PubMedSort;
}

/**
 * Collapse an Entrez date to a comparable number, widening a partial date to
 * whichever end of its span the bound represents: `2020` as a lower bound is
 * 2020/01/01, as an upper bound 2020/12/31.
 */
function entrezDateKey(value: string, bound: 'lower' | 'upper'): number {
  const [year, month, day] = value.split('/');
  const fallbackMonth = bound === 'lower' ? '01' : '12';
  const fallbackDay = bound === 'lower' ? '01' : '31';
  return Number(
    `${year}${(month ?? fallbackMonth).padStart(2, '0')}${(day ?? fallbackDay).padStart(2, '0')}`,
  );
}

/**
 * Accepts YYYY, YYYY-MM or YYYY-MM-DD and emits NCBI's YYYY/MM/DD form.
 *
 * Shape alone is not enough: `2024-13` and `2023-02-31` both match the pattern,
 * and Entrez answers a `[PDAT]` clause containing one with zero hits and no
 * error — another silent "no such literature". Month and day are range-checked
 * against the actual calendar so a typo becomes an argument error instead.
 */
export function toEntrezDate(value: string): string | null {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  if (month) {
    const monthNumber = Number(month);
    if (monthNumber < 1 || monthNumber > 12) return null;

    if (day) {
      const dayNumber = Number(day);
      // Day 0 of the next month is the last day of this one, so this handles
      // 30-day months and leap years without a table.
      const daysInMonth = new Date(
        Number(year),
        monthNumber,
        0,
      ).getDate();
      if (dayNumber < 1 || dayNumber > daysInMonth) return null;
    }
  }

  return [year, month, day].filter(Boolean).join('/');
}

/**
 * Assemble the term actually sent to Entrez.
 *
 * The date range is embedded as a `[PDAT]` clause rather than passed as
 * `mindate`/`maxdate` parameters so that the echoed `query` is self-contained:
 * an agent told to quote the query for reproducibility can paste this string
 * into PubMed and get the same result set. Verified equivalent to the
 * parameter form (`aspirin` 1000–1990 returns 18,022 either way).
 */
export function buildSearchTerm(
  query: string,
  articleTypes: string[] = [],
  dateRange?: { from?: string | null; to?: string | null },
): string {
  let term = query.trim();

  const types = articleTypes.map((t) => t.trim()).filter(Boolean);
  if (types.length > 0) {
    const clause = types
      .map((type) => `"${type.replace(/"/g, '')}"[Publication Type]`)
      .join(' OR ');
    term = `(${term}) AND (${clause})`;
  }

  const from = dateRange?.from;
  const to = dateRange?.to;
  if (from || to) {
    // Entrez needs both ends of the range; a half-specified one is ignored
    // outright rather than rejected.
    term =
      `${types.length > 0 ? term : `(${term})`} AND ` +
      `("${from ?? EARLIEST_ENTREZ_DATE}"[PDAT] : "${to ?? LATEST_ENTREZ_DATE}"[PDAT])`;
  }

  return term;
}

export async function searchPubMed(
  input: SearchInput,
): Promise<PubMedSearchResult> {
  const maxResults = Math.min(Math.max(input.maxResults ?? 20, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);

  const mindate = input.dateFrom ? toEntrezDate(input.dateFrom) : null;
  const maxdate = input.dateTo ? toEntrezDate(input.dateTo) : null;
  if (input.dateFrom && !mindate) {
    throw new PubMedError(
      `Invalid date_from "${input.dateFrom}" (expected YYYY, YYYY-MM or YYYY-MM-DD)`,
    );
  }
  if (input.dateTo && !maxdate) {
    throw new PubMedError(
      `Invalid date_to "${input.dateTo}" (expected YYYY, YYYY-MM or YYYY-MM-DD)`,
    );
  }

  // A reversed range is not an error to Entrez: it answers count 0 with an
  // empty errorlist and no warnings, which reads as "no such literature
  // exists" rather than "your dates are backwards".
  if (
    mindate &&
    maxdate &&
    entrezDateKey(mindate, 'lower') > entrezDateKey(maxdate, 'upper')
  ) {
    throw new PubMedError(
      `date_from "${input.dateFrom}" is later than date_to "${input.dateTo}"; ` +
        'PubMed answers a reversed range with zero results and no warning',
    );
  }

  const term = buildSearchTerm(input.query, input.articleTypes, {
    from: mindate,
    to: maxdate,
  });

  const data = await requestJson<{
    esearchresult?: {
      count?: string;
      idlist?: string[];
      querytranslation?: string;
      // Two separate diagnostic objects, and the split is not intuitive:
      // unmatched *terms* and unknown *fields* are errors, while a quoted
      // phrase PubMed could not find is a warning — even though that is the
      // dangerous one, because the phrase is dropped and the search silently
      // broadens instead of returning nothing.
      errorlist?: { phrasesnotfound?: string[]; fieldsnotfound?: string[] };
      warninglist?: {
        phrasesignored?: string[];
        quotedphrasesnotfound?: string[];
        outputmessages?: string[];
      };
      ERROR?: string;
    };
  }>(`${EUTILS_BASE}/esearch.fcgi`, {
    db: 'pubmed',
    term,
    retmax: maxResults,
    retstart: offset,
    // Dates live in `term` (see buildSearchTerm), so the only thing that
    // cannot be expressed in the query string is the ordering.
    sort: input.sort ? ENTREZ_SORT[input.sort] : undefined,
  });

  const result = data.esearchresult;
  if (!result || result.ERROR) {
    throw new PubMedError(result?.ERROR ?? 'PubMed search failed');
  }

  const pmids = result.idlist ?? [];
  const warnings = [
    ...(result.errorlist?.phrasesnotfound ?? []).map(
      (phrase) => `Term not found in PubMed and dropped from the query: ${phrase}`,
    ),
    ...(result.errorlist?.fieldsnotfound ?? []).map(
      (field) => `Unknown search field, ignored: ${field}`,
    ),
    ...(result.warninglist?.quotedphrasesnotfound ?? []).map(
      (phrase) =>
        `Quoted phrase not found, so it did not constrain the search: ${phrase}`,
    ),
    ...(result.warninglist?.phrasesignored ?? []).map(
      (phrase) => `Phrase ignored: ${phrase}`,
    ),
    ...(result.warninglist?.outputmessages ?? []),
  ];

  return {
    query: term,
    translatedQuery: result.querytranslation?.trim() || null,
    sort: input.sort ?? 'relevance',
    total: Number(result.count ?? 0) || 0,
    offset,
    warnings,
    records: pmids.length > 0 ? await fetchRecords(pmids) : [],
  };
}

// ─── efetch (MEDLINE) → abstracts ───────────────────────────────────────────

/**
 * MEDLINE text is line-tagged (`AB  - text`) with six-space continuation
 * lines and a blank line between records. Parsing it avoids pulling in an XML
 * dependency for what is otherwise a trivially structured format.
 */
export function parseMedline(body: string): Array<Record<string, string[]>> {
  const records: Array<Record<string, string[]>> = [];
  let current: Record<string, string[]> = {};
  let lastTag: string | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.trim() === '') {
      if (Object.keys(current).length > 0) {
        records.push(current);
        current = {};
        lastTag = null;
      }
      continue;
    }

    const tagged = /^([A-Z][A-Z0-9]{1,3})\s*-\s?(.*)$/.exec(rawLine);
    if (tagged?.[1]) {
      const tag = tagged[1];
      const value = tagged[2] ?? '';
      (current[tag] ??= []).push(value.trim());
      lastTag = tag;
      continue;
    }

    // Continuation line: belongs to the previous tag.
    if (lastTag) {
      const values = current[lastTag];
      if (values && values.length > 0) {
        values[values.length - 1] =
          `${values[values.length - 1]} ${rawLine.trim()}`.trim();
      }
    }
  }

  if (Object.keys(current).length > 0) records.push(current);
  return records;
}

function medlineDoi(fields: Record<string, string[]>): string | null {
  for (const value of [...(fields.AID ?? []), ...(fields.LID ?? [])]) {
    if (value.toLowerCase().endsWith('[doi]')) {
      return value.slice(0, value.toLowerCase().lastIndexOf('[doi]')).trim();
    }
  }
  return null;
}

export async function fetchAbstracts(
  pmids: string[],
): Promise<PubMedAbstract[]> {
  const unique = [...new Set(pmids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const parsed: PubMedAbstract[] = [];
  for (const batch of chunk(unique, MAX_IDS_PER_REQUEST)) {
    const body = await request(`${EUTILS_BASE}/efetch.fcgi`, {
      db: 'pubmed',
      id: batch.join(','),
      rettype: 'medline',
      retmode: 'text',
    });

    for (const fields of parseMedline(body)) {
      const pmid = fields.PMID?.[0];
      if (!pmid) continue;

      // OAB carries publisher-supplied abstracts, and a record can have both,
      // or several of either. AB is the indexed one and wins; everything else
      // is an alternate — a different version or a translation — and is kept
      // apart. A structured abstract arrives as one AB with continuation
      // lines, already joined by parseMedline, so repeated tags really do mean
      // separate abstracts rather than sections of one.
      const indexed = fields.AB ?? [];
      const publisher = fields.OAB ?? [];
      const [primary, ...alternatesInPrimary] =
        indexed.length > 0 ? indexed : publisher;
      const pmc = fields.PMC?.[0];

      parsed.push({
        pmid,
        title: fields.TI?.join(' ').trim() || null,
        journal: fields.JT?.[0] ?? fields.TA?.[0] ?? null,
        year: parseYear(fields.DP?.[0], fields.DEP?.[0]),
        doi: medlineDoi(fields),
        pmcid: pmc ? normalizePmcid(pmc) : null,
        publicationTypes: fields.PT ?? [],
        meshTerms: (fields.MH ?? []).map((term) => term.replace(/^\*/, '')),
        abstract: primary ?? null,
        abstractSource: !primary
          ? null
          : indexed.length > 0
            ? 'medline'
            : 'publisher',
        otherAbstracts: [
          ...alternatesInPrimary,
          ...(indexed.length > 0 ? publisher : []),
        ],
        copyright: fields.CI?.[0] ?? null,
      });
    }
  }

  const byPmid = new Map(parsed.map((r) => [r.pmid, r]));
  return unique
    .map((pmid) => byPmid.get(pmid))
    .filter((r): r is PubMedAbstract => Boolean(r));
}

// ─── elink ──────────────────────────────────────────────────────────────────

/**
 * elink does not serialise scores uniformly. `pubmed_pubmed` — the neighbour
 * list this client reads — returns them as JSON numbers, but sibling link sets
 * in the same response do not: `pubmed_pubmed_citedin` returns `"score": ""`
 * for every entry. Accept either shape and treat anything non-numeric as
 * absent, so a serialisation change cannot silently null out every score.
 */
function parseRelatednessScore(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function findRelated(
  pmid: string,
  limit = 20,
): Promise<RelatedArticle[]> {
  const data = await requestJson<{
    linksets?: Array<{
      linksetdbs?: Array<{
        linkname?: string;
        // Score type varies by link set — see parseRelatednessScore.
        links?: Array<string | { id?: string; score?: number | string }>;
      }>;
    }>;
  }>(`${EUTILS_BASE}/elink.fcgi`, {
    dbfrom: 'pubmed',
    db: 'pubmed',
    id: pmid.trim(),
    cmd: 'neighbor_score',
  });

  const linksetdb = data.linksets?.[0]?.linksetdbs?.find(
    (db) => db.linkname === 'pubmed_pubmed',
  );

  const related: RelatedArticle[] = [];
  for (const link of linksetdb?.links ?? []) {
    const id = typeof link === 'string' ? link : link.id;
    if (!id || id === pmid) continue;
    related.push({
      pmid: String(id),
      score:
        typeof link === 'object' ? parseRelatednessScore(link.score) : null,
    });
    if (related.length >= limit) break;
  }
  return related;
}

// ─── ID conversion ──────────────────────────────────────────────────────────

type IdKind = 'pmid' | 'pmcid' | 'doi';

/**
 * The converter infers a single `idtype` per call from the ids it is given and
 * rejects a mixed list with 400, so callers' identifiers have to be grouped
 * before they go out.
 */
export function classifyIdentifier(raw: string): IdKind {
  const value = raw.trim();
  if (/^\d{1,9}$/.test(value)) return 'pmid';
  if (/^pmc\d+$/i.test(value)) return 'pmcid';
  return 'doi';
}

interface ConverterRecord {
  pmid?: string | number;
  pmcid?: string;
  doi?: string;
  'requested-id'?: string;
  status?: string;
  errmsg?: string;
}

/**
 * DOIs of articles with no PMC record are unknown to the converter, but the
 * article may still be in PubMed. One esearch over `[AID]` (Article
 * Identifier, which indexes DOIs) recovers those PMIDs in a single request.
 */
async function resolveDoisViaSearch(
  dois: string[],
): Promise<Map<string, PubMedRecord>> {
  const term = dois.map((doi) => `"${doi}"[AID]`).join(' OR ');
  const data = await requestJson<{
    esearchresult?: { idlist?: string[] };
  }>(`${EUTILS_BASE}/esearch.fcgi`, {
    db: 'pubmed',
    term,
    retmax: Math.min(dois.length * 2, 100),
  });

  const pmids = data.esearchresult?.idlist ?? [];
  if (pmids.length === 0) return new Map();

  const records = await fetchRecords(pmids);
  const byDoi = new Map<string, PubMedRecord>();
  for (const record of records) {
    if (record.doi) byDoi.set(record.doi.toLowerCase(), record);
  }
  return byDoi;
}

/**
 * `status` is how a client decides whether to try `fetch_pmc_full_text`, so it
 * has to follow the PMCID rather than whichever lookup happened to answer.
 */
function pmcAvailability(pmcid: string | null): string {
  return pmcid ? `PMC record ${pmcid}` : 'no PMC record';
}

export async function resolveIdentifiers(
  ids: string[],
): Promise<ResolvedIdentifier[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const groups = new Map<IdKind, string[]>();
  for (const id of unique) {
    const kind = classifyIdentifier(id);
    groups.set(kind, [...(groups.get(kind) ?? []), id]);
  }

  const byRequested = new Map<string, ResolvedIdentifier>();
  for (const [kind, groupIds] of groups) {
    const data = await requestJson<{ records?: ConverterRecord[] }>(
      ID_CONVERTER_URL,
      { ids: groupIds.join(','), idtype: kind, versions: 'no', format: 'json' },
    );

    const records = data.records ?? [];
    records.forEach((record, index) => {
      const requestedId = record['requested-id'] ?? groupIds[index] ?? '';
      byRequested.set(requestedId, {
        requestedId,
        pmid: record.pmid != null ? String(record.pmid) : null,
        pmcid: record.pmcid ? normalizePmcid(record.pmcid) : null,
        doi: record.doi ?? null,
        status: record.errmsg ?? record.status ?? 'ok',
      });
    });
  }

  // The converter only knows articles that reached PMC, so anything it could
  // not place is followed up against PubMed itself.
  const unresolvedDois = unique.filter(
    (id) => classifyIdentifier(id) === 'doi' && !byRequested.get(id)?.pmid,
  );
  if (unresolvedDois.length > 0) {
    const byDoi = await resolveDoisViaSearch(unresolvedDois);
    for (const doi of unresolvedDois) {
      const record = byDoi.get(doi.toLowerCase());
      // The converter may have found a PMCID without a PMID — PMC carries
      // content PubMed does not index. Overwriting that with the failed search
      // would discard a confirmed record and report it as not found.
      const fromConverter = byRequested.get(doi);
      const pmcid = record?.pmcid ?? fromConverter?.pmcid ?? null;
      byRequested.set(doi, {
        requestedId: doi,
        pmid: record?.pmid ?? fromConverter?.pmid ?? null,
        pmcid,
        doi: record?.doi ?? fromConverter?.doi ?? doi,
        status: record
          ? `resolved from PubMed ([AID]); ${pmcAvailability(pmcid)}`
          : pmcid
            ? `resolved from PMC (${pmcid}); not indexed in PubMed`
            : 'not found in PMC or PubMed',
      });
    }
  }

  // A PMID the converter rejected is still a PMID: keep it, and fill in the
  // DOI from esummary so the caller gets a usable crosswalk either way.
  const unresolvedPmids = unique.filter(
    (id) => classifyIdentifier(id) === 'pmid' && !byRequested.get(id)?.doi,
  );
  if (unresolvedPmids.length > 0) {
    const records = await fetchRecords(unresolvedPmids);
    const byPmid = new Map(records.map((r) => [r.pmid, r]));
    for (const pmid of unresolvedPmids) {
      const record = byPmid.get(pmid);
      // The converter may already have supplied a PMCID even when it could not
      // give us a DOI; keep it, and let it decide the status.
      const pmcid = record?.pmcid ?? byRequested.get(pmid)?.pmcid ?? null;
      byRequested.set(pmid, {
        requestedId: pmid,
        // Null when PubMed has no such record: callers read `unresolved` off
        // the absence of pmid/pmcid, so echoing the input back would make a
        // nonexistent PMID look resolved.
        pmid: record?.pmid ?? null,
        pmcid,
        doi: record?.doi ?? null,
        status: record
          ? `resolved from PubMed; ${pmcAvailability(pmcid)}`
          : 'not found in PubMed',
      });
    }
  }

  return unique.map(
    (id) =>
      byRequested.get(id) ?? {
        requestedId: id,
        // Every field stays null: nothing confirmed this identifier, and a
        // populated field here would read as a successful resolution.
        pmid: null,
        pmcid: null,
        doi: null,
        status: 'not found',
      },
  );
}

// ─── PMC open-access full text ──────────────────────────────────────────────

/**
 * Named character entities used in JATS bodies.
 *
 * The six XML built-ins are nowhere near enough: PMC prose leans on the ISO
 * entity sets, and in a pharmacokinetics corpus they land inside the numbers —
 * `&plusmn;`, `&le;`, `&ge;`, `&micro;`, `&deg;` all change what a reported
 * value means. Leaving them encoded would put "12.4 &plusmn; 3.1" in front of a
 * model as plain text.
 *
 * The Latin-1 and Greek blocks are contiguous in Unicode, so they are listed as
 * names in code-point order rather than a hundred hand-written pairs.
 */
const LATIN1_ENTITY_NAMES = [
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect',
  'uml', 'copy', 'ordf', 'laquo', 'not', 'shy', 'reg', 'macr',
  'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro', 'para', 'middot',
  'cedil', 'sup1', 'ordm', 'raquo', 'frac14', 'frac12', 'frac34', 'iquest',
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil',
  'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml',
  'ETH', 'Ntilde', 'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times',
  'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN', 'szlig',
  'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil',
  'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide',
  'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
];

/**
 * ISO 8879 `isogrk` aliases, which the JATS DTDs define alongside the HTML-style
 * names — `&agr;` for α, `&Dgr;` for Δ. Listed in the same code-point order as
 * the arrays below so one loop covers both spellings.
 */
const GREEK_CAPITAL_ISO_ALIASES = [
  'Agr', 'Bgr', 'Ggr', 'Dgr', 'Egr', 'Zgr', 'EEgr', 'THgr',
  'Igr', 'Kgr', 'Lgr', 'Mgr', 'Ngr', 'Xgr', 'Ogr', 'Pgr',
  'Rgr', '', 'Sgr', 'Tgr', 'Ugr', 'PHgr', 'KHgr', 'PSgr', 'OHgr',
];

const GREEK_SMALL_ISO_ALIASES = [
  'agr', 'bgr', 'ggr', 'dgr', 'egr', 'zgr', 'eegr', 'thgr',
  'igr', 'kgr', 'lgr', 'mgr', 'ngr', 'xgr', 'ogr', 'pgr',
  'rgr', 'sfgr', 'sgr', 'tgr', 'ugr', 'phgr', 'khgr', 'psgr', 'ohgr',
];

// U+0391..U+03A9 with the reserved U+03A2 slot left empty.
const GREEK_CAPITAL_NAMES = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
  'Rho', '', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
];

// U+03B1..U+03C9, contiguous (sigmaf at U+03C2 sits before sigma).
const GREEK_SMALL_NAMES = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi',
  'rho', 'sigmaf', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
];

function buildEntityTable(): Record<string, string> {
  const table: Record<string, string> = {
    // XML built-ins.
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    // Punctuation and spacing.
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    sbquo: '‚',
    ldquo: '“',
    rdquo: '”',
    bdquo: '„',
    dagger: '†',
    Dagger: '‡',
    bull: '•',
    hellip: '…',
    permil: '‰',
    prime: '′',
    Prime: '″',
    lsaquo: '‹',
    rsaquo: '›',
    oline: '‾',
    frasl: '⁄',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    zwnj: '‌',
    zwj: '‍',
    // Currency and marks.
    euro: '€',
    trade: '™',
    // Arrows.
    larr: '←',
    uarr: '↑',
    rarr: '→',
    darr: '↓',
    harr: '↔',
    lArr: '⇐',
    rArr: '⇒',
    hArr: '⇔',
    // Mathematics — the ones that carry meaning in a reported value.
    minus: '−',
    lowast: '∗',
    radic: '√',
    prop: '∝',
    infin: '∞',
    ang: '∠',
    and: '∧',
    or: '∨',
    cap: '∩',
    cup: '∪',
    int: '∫',
    there4: '∴',
    sim: '∼',
    cong: '≅',
    asymp: '≈',
    ne: '≠',
    equiv: '≡',
    le: '≤',
    ge: '≥',
    sub: '⊂',
    sup: '⊃',
    nsub: '⊄',
    sube: '⊆',
    supe: '⊇',
    oplus: '⊕',
    otimes: '⊗',
    perp: '⊥',
    sdot: '⋅',
    part: '∂',
    exist: '∃',
    empty: '∅',
    nabla: '∇',
    isin: '∈',
    notin: '∉',
    ni: '∋',
    prod: '∏',
    sum: '∑',
    forall: '∀',
    fnof: 'ƒ',
    // Letterlike.
    alefsym: 'ℵ',
    image: 'ℑ',
    real: 'ℜ',
    weierp: '℘',
    // Card suits and shapes seen in figure callouts.
    loz: '◊',
    spades: '♠',
    clubs: '♣',
    hearts: '♥',
    diams: '♦',
    // Latin extended used in names.
    OElig: 'Œ',
    oelig: 'œ',
    Scaron: 'Š',
    scaron: 'š',
    Yuml: 'Ÿ',
    circ: 'ˆ',
    tilde: '˜',
    // Greek variants.
    thetasym: 'ϑ',
    upsih: 'ϒ',
    piv: 'ϖ',
  };

  LATIN1_ENTITY_NAMES.forEach((name, index) => {
    table[name] = String.fromCodePoint(0x00a0 + index);
  });
  for (const names of [GREEK_CAPITAL_NAMES, GREEK_CAPITAL_ISO_ALIASES]) {
    names.forEach((name, index) => {
      if (name) table[name] = String.fromCodePoint(0x0391 + index);
    });
  }
  for (const names of [GREEK_SMALL_NAMES, GREEK_SMALL_ISO_ALIASES]) {
    names.forEach((name, index) => {
      table[name] = String.fromCodePoint(0x03b1 + index);
    });
  }

  return table;
}

const XML_ENTITIES: Record<string, string> = buildEntityTable();

function decodeEntities(value: string): string {
  // The named branch must accept digits after the first letter: `frac12`,
  // `sup2`, `frac14`, `there4` are all in the table above, and a letters-only
  // pattern makes every one of them unreachable — half-lives and squared units
  // are exactly where that shows up in this corpus.
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match: string, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return XML_ENTITIES[entity] ?? match;
    },
  );
}

/**
 * Lossy JATS-XML → plain text. Section titles become markdown headings and
 * paragraphs are kept; tables, figures, formulae and the reference list are
 * dropped because their XML does not survive flattening in a readable form.
 * Callers must present the output as a rendering of the article, not as the
 * article itself.
 *
 * Returns '' when the document has no `<body>`. PMC answers for articles
 * outside the open-access subset with front matter only, and flattening that
 * yields a few thousand characters of journal title, ISSNs, publisher name and
 * identifiers — text long enough to pass any length check while containing no
 * article at all. No body means no full text, full stop.
 */
export function jatsToText(xml: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xml);
  if (!bodyMatch?.[1]) return '';

  let body = bodyMatch[1];

  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(table-wrap|fig|disp-formula|inline-formula|ref-list|graphic|media|supplementary-material)\b[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '\n\n## $1\n\n')
    .replace(/<\/(p|sec|abstract|list-item)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(body)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export async function fetchPmcFullText(pmcid: string): Promise<PmcFullText> {
  const normalized = normalizePmcid(pmcid);
  const numeric = normalized.replace(/^PMC/i, '');

  const xml = await request(
    `${EUTILS_BASE}/efetch.fcgi`,
    { db: 'pmc', id: numeric, rettype: 'full', retmode: 'xml' },
    { timeoutMs: 25_000 },
  );

  // Closed-access records come back as a stub with no <body>, which
  // `jatsToText` renders as ''. Body presence is the whole test — no length
  // floor, because corrections, retraction notices and brief letters have
  // genuine bodies only a line or two long.
  const text = jatsToText(xml);
  if (!text) {
    return {
      pmcid: normalized,
      text: null,
      available: false,
      note:
        'No open-access full text returned for this PMCID. The article is ' +
        'probably outside the PMC open-access subset; use the abstract and ' +
        'obtain the full text through a licensed route.',
    };
  }

  return {
    pmcid: normalized,
    text,
    available: true,
    note:
      'Lossy plain-text rendering of the PMC open-access XML. Tables, ' +
      'figures, formulae and the reference list are omitted — quantitative ' +
      'values reported only in tables will not appear here.',
  };
}
