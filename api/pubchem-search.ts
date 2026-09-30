/**
 * PubChem compound search proxy.
 *
 *   GET /api/pubchem-search?q=<query>          — name / CID / CAS lookup
 *   GET /api/pubchem-search?expand=<cid>       — synonyms for a single CID
 *
 * The default `q` mode searches PubChem's autocomplete API for compound
 * name suggestions, then fetches CID + molecular weight for each match.
 * Returns an array of { cid, name, molecularWeight, molecularFormula }.
 * Numeric input (CIDs) and CAS Registry Numbers route through PubChem's
 * direct-name endpoint instead so authors who type a CID/CAS hit the
 * exact compound rather than falling through to fuzzy autocomplete.
 *
 * The `expand` mode is a follow-up call after the author picks a result
 * — it returns synonyms for the selected CID so the create form can
 * pre-fill the aliases field. Kept on a separate path so the search
 * stage stays fast (one fewer round-trip per autocomplete result).
 *
 * No auth required — PubChem data is public.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';

interface PubChemResult {
  cid: number;
  name: string;
  molecularWeight: number | null;
  molecularFormula: string | null;
}

const AUTOCOMPLETE_URL =
  'https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound';
const PUG_REST_URL =
  'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name';
const PUG_REST_CID_URL =
  'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid';

// CAS Registry Numbers have the format `dddddd-dd-d` (2–7 digits, dash,
// 2 digits, dash, 1 check digit). PubChem's PUG-REST `compound/name`
// endpoint resolves CAS strings, so the only thing this regex has to do
// is route the query down the direct-name path instead of the
// autocomplete path that ignores dashes. Exported for the unit test —
// keeping the route detection in one place avoids a frontend/backend
// mismatch where one accepts a string the other rejects.
export const CAS_PATTERN = /^\d{2,7}-\d{2}-\d$/;

const SYNONYM_LIMIT = 10;

/**
 * Filter and dedupe a raw PubChem synonyms list down to the shape
 * `aliases` consumes. PubChem mixes name variants with CAS numbers,
 * IUPAC strings, and outright noise; this trims to a manageable set
 * the create form can pre-fill without overwhelming the field.
 *
 * Exported for unit testing — the rules here decide what shows up
 * pre-checked in the aliases textarea, so changing them silently
 * would surprise authors.
 */
export function cleanSynonyms(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200) continue;
    // Pure-numeric strings are usually CAS numbers PubChem returns
    // among synonyms — those go in a dedicated CAS slot if/when we
    // add one, not the aliases field.
    if (/^\d+$/.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= SYNONYM_LIMIT) break;
  }
  return out;
}

function parseMolecularWeight(value: unknown): number | null {
  if (typeof value === 'string') return parseFloat(value);
  if (typeof value === 'number') return value;
  return null;
}

// 30 requests / 60 s per IP. Each search request fans out to up to 8 parallel
// PubChem calls, so this keeps outbound amplification bounded without
// affecting real users (typical usage is a handful of lookups per session).
const PUBCHEM_IP_LIMIT = 30;
const PUBCHEM_WINDOW_MS = 60 * 1000;

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const ipLimit = consumeRateLimit(
    'pubchem-search-ip',
    getClientAddressKey(req),
    PUBCHEM_IP_LIMIT,
    PUBCHEM_WINDOW_MS,
  );
  if (ipLimit.limited) {
    res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
    error(res, 429, 'Too many requests. Please wait before trying again.');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const expandRaw = url.searchParams.get('expand')?.trim() ?? '';

  // ─── expand=<cid> mode ────────────────────────────────────────────────
  // Returns the synonyms list for one CID, shaped for the create form's
  // aliases field. Lazy follow-up after the author picks a search result
  // (#329 / loose-thread #363).
  if (expandRaw) {
    if (!/^\d+$/.test(expandRaw)) {
      error(res, 400, 'expand must be a positive integer CID');
      return;
    }
    try {
      const synResponse = await fetch(
        `${PUG_REST_CID_URL}/${encodeURIComponent(expandRaw)}/synonyms/JSON`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!synResponse.ok) {
        json(res, 200, { cid: Number(expandRaw), synonyms: [] });
        return;
      }
      const synData = await synResponse.json();
      const info = synData?.InformationList?.Information;
      const raw = Array.isArray(info) && info[0]?.Synonym
        ? (info[0].Synonym as unknown[])
        : [];
      const synonyms = cleanSynonyms(raw);
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
      json(res, 200, { cid: Number(expandRaw), synonyms });
      return;
    } catch {
      json(res, 200, { cid: Number(expandRaw), synonyms: [] });
      return;
    }
  }

  const query = url.searchParams.get('q')?.trim() ?? '';
  const isAllDigits = query.length > 0 && /^\d+$/.test(query);
  const isCas = !isAllDigits && CAS_PATTERN.test(query);

  // Name autocomplete needs >=2 chars to be useful, but a digit-only
  // query is a PubChem CID and should resolve even at 1 char (CIDs 1–9
  // are valid records). CAS strings always satisfy >=5 chars (the
  // minimum CAS shape is `dd-dd-d` = 7 chars). Skip the minimum-length
  // guard for both direct-resolution branches.
  if (!isAllDigits && !isCas && query.length < 2) {
    json(res, 200, { results: [] });
    return;
  }
  if (query.length === 0) {
    json(res, 200, { results: [] });
    return;
  }

  // CAS query: PubChem's `compound/name/{cas}` endpoint resolves CAS
  // Registry Numbers (the same path the name lookup uses), but the
  // autocomplete endpoint does not — so without this branch a CAS
  // string falls through to fuzzy autocomplete that strips the dashes
  // and returns unrelated compounds. Look up directly to get the exact
  // record.
  if (isCas) {
    try {
      const propResponse = await fetch(
        `${PUG_REST_URL}/${encodeURIComponent(query)}/property/Title,MolecularWeight,MolecularFormula/JSON`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!propResponse.ok) {
        json(res, 200, { results: [] });
        return;
      }
      const propData = await propResponse.json();
      const props = propData?.PropertyTable?.Properties;
      if (!Array.isArray(props) || props.length === 0) {
        json(res, 200, { results: [] });
        return;
      }
      const p = props[0];
      const result: PubChemResult = {
        cid: typeof p.CID === 'number' ? p.CID : 0,
        name: typeof p.Title === 'string' && p.Title ? p.Title : query,
        molecularWeight: parseMolecularWeight(p.MolecularWeight),
        molecularFormula: p.MolecularFormula ?? null,
      };
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
      json(res, 200, { results: [result] });
      return;
    } catch {
      json(res, 200, { results: [] });
      return;
    }
  }

  // Numeric query: treat as a PubChem CID and look up the record
  // directly. The autocomplete endpoint is name-only and returns nothing
  // for digit-only input, so without this branch authors who type a CID
  // get the "no suggestions" path even when the compound exists.
  if (isAllDigits) {
    try {
      const propResponse = await fetch(
        `${PUG_REST_CID_URL}/${encodeURIComponent(query)}/property/Title,MolecularWeight,MolecularFormula/JSON`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!propResponse.ok) {
        json(res, 200, { results: [] });
        return;
      }
      const propData = await propResponse.json();
      const props = propData?.PropertyTable?.Properties;
      if (!Array.isArray(props) || props.length === 0) {
        json(res, 200, { results: [] });
        return;
      }
      const p = props[0];
      const result: PubChemResult = {
        cid: typeof p.CID === 'number' ? p.CID : Number(query),
        name: typeof p.Title === 'string' && p.Title ? p.Title : `CID ${query}`,
        molecularWeight: parseMolecularWeight(p.MolecularWeight),
        molecularFormula: p.MolecularFormula ?? null,
      };
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
      json(res, 200, { results: [result] });
      return;
    } catch {
      json(res, 200, { results: [] });
      return;
    }
  }

  // Step 1: Get compound name suggestions from PubChem autocomplete
  let suggestions: string[];
  try {
    const acResponse = await fetch(
      `${AUTOCOMPLETE_URL}/${encodeURIComponent(query)}/json?limit=8`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!acResponse.ok) {
      json(res, 200, { results: [] });
      return;
    }
    const acData = await acResponse.json();
    suggestions = acData?.dictionary_terms?.compound ?? [];
  } catch {
    json(res, 200, { results: [] });
    return;
  }

  if (suggestions.length === 0) {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    json(res, 200, { results: [] });
    return;
  }

  // Step 2: Fetch CID + properties for each suggestion (in parallel, max 8)
  const results: PubChemResult[] = [];

  await Promise.all(
    suggestions.map(async (name) => {
      try {
        const propResponse = await fetch(
          `${PUG_REST_URL}/${encodeURIComponent(name)}/property/MolecularWeight,MolecularFormula/JSON`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!propResponse.ok) return;
        const propData = await propResponse.json();
        const props = propData?.PropertyTable?.Properties;
        if (!Array.isArray(props) || props.length === 0) return;

        const p = props[0];
        results.push({
          cid: p.CID,
          name,
          molecularWeight: typeof p.MolecularWeight === 'string'
            ? parseFloat(p.MolecularWeight)
            : typeof p.MolecularWeight === 'number'
              ? p.MolecularWeight
              : null,
          molecularFormula: p.MolecularFormula ?? null,
        });
      } catch {
        // Skip this suggestion on error
      }
    }),
  );

  // Sort results to match the original autocomplete order
  const nameOrder = new Map(suggestions.map((n, i) => [n, i]));
  results.sort((a, b) => (nameOrder.get(a.name) ?? 99) - (nameOrder.get(b.name) ?? 99));

  // Cache for 1 hour — compound data doesn't change often
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  json(res, 200, { results });
});
