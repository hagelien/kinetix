/**
 * Pure parsing helpers for the Farmakologiportalen importer
 * (scripts/import-farmakologiportalen.ts).
 *
 * Farmakologiportalen (https://farmakologiportalen.no) publishes one
 * server-rendered HTML page per substance. The pharmacokinetic parameters
 * live in a two-column table (label → value); the therapeutic reference
 * range, its comment, and the list of related metabolites live in their own
 * sections. These helpers turn that HTML — and the Norwegian-formatted value
 * strings inside it — into the shapes Kinetix stores in `drug_parameters`
 * (NumericRange jsonb / plain numbers) and `drug_metabolites`.
 *
 * Everything here is deliberately network- and DB-free so it can be unit
 * tested against captured HTML fixtures.
 */
import { JSDOM } from 'jsdom';

/** RangeData shape mirrored from data/components.ts / NumericRange jsonb. */
export interface ParsedRange {
  min?: number;
  max?: number;
  median?: number;
  unit?: string;
  qualifier?: string;
  note?: string;
}

export interface ParsedMetabolite {
  name: string;
  /** Farmakologiportalen content path, e.g. "/content/757/Morfin-3-glukuronid-M3G". */
  url?: string;
}

export interface ParsedSubstancePage {
  /** CAS registry number, e.g. "28981-97-7", when present. */
  cas: string | null;
  molecularWeight: number | null;
  bioavailability: ParsedRange | null;
  tmax: ParsedRange | null;
  proteinBinding: ParsedRange | null;
  volumeOfDistribution: ParsedRange | null;
  bloodPlasmaRatio: ParsedRange | null;
  halfLife: ParsedRange | null;
  /** Therapeutic reference range ("Referanseområde"). */
  therapeuticConcentration: ParsedRange | null;
  metabolites: ParsedMetabolite[];
}

const NOTE_MAX = 500;

/** Round away binary-float noise while keeping legitimate precision. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function clip(text: string, max = NOTE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/**
 * Norwegian decimals use a comma (`324,39`). Convert a decimal comma sitting
 * between two digits to a period, leaving list commas (`a, b`) untouched.
 */
export function normalizeDecimals(s: string): string {
  return s.replace(/(\d),(\d)/g, '$1.$2');
}

/**
 * Extract all non-negative magnitudes from a value string. A hyphen between
 * two numbers is a range separator, never a sign, so signs are intentionally
 * not matched (no Farmakologiportalen PK value is negative).
 */
export function extractNumbers(s: string): number[] {
  const m = normalizeDecimals(s).match(/\d+(?:\.\d+)?/g);
  return m ? m.map(Number).filter((n) => Number.isFinite(n)) : [];
}

export function detectQualifier(s: string): '<' | '>' | undefined {
  if (/[<≤]/.test(s)) return '<';
  if (/[>≥]/.test(s)) return '>';
  return undefined;
}

const RANGE_SEP_RE = /\d\s*[-–—]\s*\d/;

interface Magnitude {
  min?: number;
  max?: number;
  median?: number;
  qualifier?: '<' | '>';
}

/**
 * Parse the leading numeric regime of a Farmakologiportalen value cell into
 * min/max/value. Handles four shapes:
 *   - "x ± y"      → central value x (uncertainty dropped; kept in note)
 *   - "a - b"      → range [a, b]
 *   - "< x" / "> x"→ bounded (max / min) with a qualifier
 *   - "x"          → single value
 * Trailing regimes ("0,5-3 timer(tbl) 2-6 timer(depot)") are ignored here —
 * the caller preserves the full original text in the parameter note.
 */
export function parseMagnitude(raw: string): Magnitude | null {
  const s = normalizeDecimals(raw);
  const qualifier = detectQualifier(s);
  const nums = extractNumbers(s);
  if (nums.length === 0) return null;

  if (/±/.test(s)) {
    return { median: nums[0], min: nums[0], max: nums[0] };
  }
  if (RANGE_SEP_RE.test(s) && nums.length >= 2) {
    const min = Math.min(nums[0]!, nums[1]!);
    const max = Math.max(nums[0]!, nums[1]!);
    return { min, max };
  }
  if (qualifier === '<') return { max: nums[0], qualifier };
  if (qualifier === '>') return { min: nums[0], qualifier };
  return { median: nums[0], min: nums[0], max: nums[0] };
}

/** Multiplier to convert a time value to hours based on its unit word. */
export function timeFactorToHours(lower: string): number {
  if (/minut/.test(lower) || /(^|\d|\s)min\b/.test(lower)) return 1 / 60;
  if (/døgn|dager|\bdag\b/.test(lower)) return 24;
  return 1; // timer / time / t
}

function applyFactor(m: Magnitude, factor: number): ParsedRange {
  const r: ParsedRange = {};
  if (m.min != null) r.min = round(m.min * factor);
  if (m.max != null) r.max = round(m.max * factor);
  if (m.median != null) r.median = round(m.median * factor);
  if (m.qualifier) r.qualifier = m.qualifier;
  return r;
}

/** Ensure a requiresMinMax parameter has both bounds (degenerate min=max). */
function ensureMinMax(r: ParsedRange): ParsedRange {
  if (r.min == null && r.median != null) r.min = r.median;
  if (r.max == null && r.median != null) r.max = r.median;
  // Last-resort mirror so a lone one-sided bound (e.g. a "> x" half-life)
  // still yields both bounds rather than being rejected and dropped.
  if (r.min == null && r.max != null) r.min = r.max;
  if (r.max == null && r.min != null) r.max = r.min;
  return r;
}

/** Half-life / Tmax → NumericRange in hours. */
export function buildTimeRange(raw: string, requireMinMax: boolean): ParsedRange | null {
  const m = parseMagnitude(raw);
  if (!m) return null;
  const r = applyFactor(m, timeFactorToHours(raw.toLowerCase()));
  r.unit = 'h';
  r.note = clip(raw);
  return requireMinMax ? ensureMinMax(r) : r;
}

/**
 * Bioavailability / protein binding → fraction in [0, 1]. A trailing "%" (or
 * a magnitude clearly above 1) is treated as a percentage and divided by 100.
 */
export function buildFraction(raw: string): ParsedRange | null {
  const m = parseMagnitude(raw);
  if (!m) return null;
  const magnitudes = [m.min, m.max, m.median].filter((n): n is number => n != null);
  const looksPercent = /%/.test(raw) || magnitudes.some((n) => n > 1.5);
  const factor = looksPercent ? 1 / 100 : 1;
  const r = applyFactor(m, factor);
  r.unit = 'fraction';
  r.note = clip(raw);
  // A fraction is bounded in [0, 1], so a one-sided bound is a real range:
  // ">x" → [x, 1] and "<x" → [0, x]. Fill the open side with the natural
  // bound so these satisfy the requiresMinMax rule instead of being dropped.
  if (r.qualifier === '>' && r.min != null && r.max == null) r.max = 1;
  if (r.qualifier === '<' && r.max != null && r.min == null) r.min = 0;
  return ensureMinMax(r);
}

/** Volume of distribution → NumericRange in L/kg. */
export function buildVolumeOfDistribution(raw: string): ParsedRange | null {
  const m = parseMagnitude(raw);
  if (!m) return null;
  const r = applyFactor(m, 1);
  r.unit = 'L/kg';
  r.note = clip(raw);
  return ensureMinMax(r);
}

/** Blood/plasma ratio → dimensionless NumericRange (unit "ratio"). */
export function buildRatio(raw: string): ParsedRange | null {
  const m = parseMagnitude(raw);
  if (!m) return null;
  const r = applyFactor(m, 1);
  r.unit = 'ratio';
  r.note = clip(raw);
  return r;
}

const CONCENTRATION_UNIT_PATTERNS: Array<[RegExp, string]> = [
  [/nmol\/l/i, 'nmol/L'],
  [/µmol\/l|umol\/l/i, 'µmol/L'],
  [/mmol\/l/i, 'mmol/L'],
  [/mg\/dl/i, 'mg/dL'],
  [/mg\/l/i, 'mg/L'],
  [/µg\/ml|ug\/ml/i, 'µg/mL'],
  [/ng\/ml/i, 'ng/mL'],
  [/µg\/l|ug\/l/i, 'µg/L'],
  [/ng\/l/i, 'ng/L'],
];

export function detectConcentrationUnit(s: string): string | undefined {
  // Farmakologiportalen mixes the micro sign (µ, U+00B5) and a visually
  // identical Greek small letter mu (μ, U+03BC) — e.g. "μmol/L" on the
  // antiepileptic pages. Normalize the Greek mu to the micro sign so both
  // match and the canonical unit string (which uses U+00B5, matching the
  // drugParameters enum) is emitted; otherwise the unit is silently dropped
  // and the concentration is stored uninterpretable.
  const normalized = s.replace(/μ/g, 'µ');
  for (const [re, unit] of CONCENTRATION_UNIT_PATTERNS) {
    if (re.test(normalized)) return unit;
  }
  return undefined;
}

/**
 * Therapeutic reference range ("Referanseområde") → NumericRange in its
 * source concentration unit. `comment` (the "Kommentar til referanseområdet"
 * prose) is attached as the note when present, otherwise the raw value text.
 */
export function buildConcentration(raw: string, comment?: string | null): ParsedRange | null {
  const m = parseMagnitude(raw);
  if (!m) return null;
  const r = applyFactor(m, 1);
  const unit = detectConcentrationUnit(raw);
  if (unit) r.unit = unit;
  const note = comment?.trim() ? comment : raw;
  r.note = clip(note);
  return r;
}

export function parseMolecularWeight(raw: string): number | null {
  const nums = extractNumbers(raw);
  return nums.length ? round(nums[0]!) : null;
}

// ─── HTML extraction ─────────────────────────────────────────────────────────

const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

function cellText(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a label → value map from every two-cell row on the page. The
 * Farmakologiportalen substance table is `<tr><td>label</td><td>value</td>`;
 * jsdom repairs the (malformed) trailing reference-range row so its value
 * cell text resolves cleanly.
 */
function rowMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const tr of Array.from(doc.querySelectorAll('tr'))) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 2) continue;
    const label = cellText(tds[0]);
    if (!label) continue;
    if (!map.has(label)) map.set(label, cellText(tds[1]));
  }
  return map;
}

function nonEmpty(v: string | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

/** Extract the "Kommentar til referanseområdet" prose, if present. */
function extractReferenceComment(doc: Document): string | null {
  for (const h of Array.from(doc.querySelectorAll('h3'))) {
    if (/Kommentar til referanseområdet/i.test(h.textContent ?? '')) {
      // Collect the consecutive paragraph siblings that make up the comment
      // prose; stop at the next heading/section/table boundary.
      const parts: string[] = [];
      let node = h.nextElementSibling;
      while (node && node.tagName === 'P') {
        const t = cellText(node);
        if (t) parts.push(t);
        node = node.nextElementSibling;
      }
      const text = parts.join(' ').trim();
      return text || null;
    }
  }
  return null;
}

/**
 * Locate the element scoping the metabolite links. Prefers the
 * `#metaboliter` section used by current pages; falls back to the
 * "Metabolitter / Relaterte substanser" heading's containing section (or its
 * following siblings) so the importer is robust to markup that omits the id.
 */
function metaboliteScope(doc: Document): Element[] {
  const section = doc.querySelector('#metaboliter');
  if (section) return [section];
  for (const h of Array.from(doc.querySelectorAll('h3, h2'))) {
    if (!/Metabolitter\s*\/\s*Relaterte substanser/i.test(h.textContent ?? '')) {
      continue;
    }
    const containing = h.closest('section, div');
    if (containing && containing !== doc.body) return [containing];
    const sibs: Element[] = [];
    let node = h.nextElementSibling;
    while (node && node.tagName !== 'H3' && node.tagName !== 'H2') {
      sibs.push(node);
      node = node.nextElementSibling;
    }
    return sibs;
  }
  return [];
}

function extractMetabolites(doc: Document): ParsedMetabolite[] {
  const seen = new Set<string>();
  const out: ParsedMetabolite[] = [];
  for (const scope of metaboliteScope(doc)) {
    for (const a of Array.from(scope.querySelectorAll('a[href]'))) {
      const name = cellText(a);
      const href = a.getAttribute('href') ?? undefined;
      // Only follow links into other substance pages; skip nav/util links.
      if (!name || (href && !href.includes('/content/'))) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, url: href });
    }
  }
  return out;
}

/** The reference-range value may also surface as a row labelled "Referanseområde". */
function extractReferenceRange(doc: Document, rows: Map<string, string>): string | null {
  const fromRow = nonEmpty(rows.get('Referanseområde'));
  if (fromRow) return fromRow;
  // Fallback: the standalone reference-range block before the comment.
  const block = doc.querySelector('.referencearea, #referanseomraade');
  return block ? nonEmpty(cellText(block)) : null;
}

/**
 * Parse a full Farmakologiportalen substance page into structured values.
 * Missing fields come back as null / empty arrays.
 */
export function parseSubstancePage(html: string): ParsedSubstancePage {
  const doc = new JSDOM(html).window.document;
  const rows = rowMap(doc);

  let cas: string | null = null;
  for (const value of rows.values()) {
    const v = value.trim();
    if (CAS_RE.test(v)) {
      cas = v;
      break;
    }
  }

  const mw = nonEmpty(rows.get('Molekylvekt'));
  const bio = nonEmpty(rows.get('Biotilgjengelighet'));
  const tmax = nonEmpty(rows.get('Tmax'));
  const pb = nonEmpty(rows.get('Proteinbinding'));
  const vd = nonEmpty(rows.get('Distribusjonsvolum'));
  const bp = nonEmpty(rows.get('Blod/plasma-ratio'));
  const t12 = nonEmpty(rows.get('Halveringstid'));

  const refRaw = extractReferenceRange(doc, rows);
  const refComment = extractReferenceComment(doc);

  return {
    cas,
    molecularWeight: mw ? parseMolecularWeight(mw) : null,
    bioavailability: bio ? buildFraction(bio) : null,
    tmax: tmax ? buildTimeRange(tmax, false) : null,
    proteinBinding: pb ? buildFraction(pb) : null,
    volumeOfDistribution: vd ? buildVolumeOfDistribution(vd) : null,
    bloodPlasmaRatio: bp ? buildRatio(bp) : null,
    halfLife: t12 ? buildTimeRange(t12, true) : null,
    therapeuticConcentration: refRaw ? buildConcentration(refRaw, refComment) : null,
    metabolites: extractMetabolites(doc),
  };
}

// ─── Substance-list helpers ────────────────────────────────────────────────

export interface SubstanceListItem {
  title: string;
  url: string;
  associationId: number;
}

/**
 * The /farma/search/substances endpoint returns `{ substances: "<json>" }`
 * where the inner value is itself a JSON-encoded array. Decode both layers.
 */
export function parseSubstanceList(payload: unknown): SubstanceListItem[] {
  const raw = (payload as { substances?: unknown })?.substances;
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (s): s is SubstanceListItem =>
        !!s && typeof s.title === 'string' && typeof s.url === 'string',
    )
    .map((s) => ({
      title: s.title.trim(),
      url: s.url,
      associationId: Number(s.associationId) || 0,
    }));
}

/**
 * Split a Farmakologiportalen title into the base name and a trailing
 * parenthetical abbreviation/synonym, e.g.
 *   "2,5-Dimetoksy-4-jodamfetamin (DOI)" → { base, alias: "DOI" }
 */
export function splitTitle(title: string): { base: string; alias: string | null } {
  const m = title.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  const base = m?.[1]?.trim();
  // Group 2 is `[^()]+`, so it is non-empty whenever the pattern matched at
  // all — the base is the only part that can come back blank.
  const alias = m?.[2]?.trim();
  if (base && alias) {
    return { base, alias };
  }
  return { base: title.trim(), alias: null };
}
