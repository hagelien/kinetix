/**
 * The laboratory's own urine detection times ("påvisningstider i urin").
 *
 * The pooled windows in `detectionWindows.ts` are the literature: every number
 * there is an aggregate of cited source values, and every reader of Kinetix
 * gets to see them. This module is the OTHER answer to the same question — the
 * one a laboratory case is actually interpreted against: the table in the
 * section's own approved urine-interpretation guideline. It is not a pooled
 * estimate at all: it is the band the section has agreed to state, for the
 * section's own cut-offs, in the section's own case categories.
 *
 * The two must never merge into one number. A pooled literature window and a
 * laboratory's agreed band disagree by design — a lower cut-off buys a longer
 * window, and the section's cut-offs are not the ones behind the published
 * studies. So the guideline's readings are carried here in their own
 * vocabulary, rendered in their own section, and always shown with the
 * document they come from.
 *
 * This file holds the *shape* and the *matching*, never the data. The guideline
 * is an internal, restricted document: its table lives in the
 * `refs_detection_guidelines` database table (loaded by an operator from outside
 * the repository) and is served only by `api/refs-detection-times.ts`, behind a
 * gate, rather than shipped in the client bundle where a gate would only be
 * cosmetic.
 */
import type { DetectionBand } from './detectionWindows';

/**
 * The bands the guideline's table actually uses. A subset of `DetectionBand`:
 * the guideline never says "siste ukene" or longer in this table, and adding
 * bands it does not use would invite a reading it does not support.
 */
export type RefsDetectionBand = Extract<
  DetectionBand,
  'halfDay' | 'day' | 'days' | 'week' | 'twoWeeks'
>;

/**
 * What one cell of the "Påvisningstid i urin etter inntak" column says.
 *
 * Three of the four kinds are not bands, and flattening them into one would
 * lose the distinction that matters most: "Ingen dokumentasjon" (the section
 * has looked and found nothing) is a different statement from an empty cell
 * (the component is not part of this table's answer), and both are different
 * from THC, where the answer is a curve rather than a band.
 */
export type RefsDetectionStatement =
  /** A band, optionally straddling two ("Siste uken/siste par ukene"). */
  | { kind: 'band'; band: RefsDetectionBand; upper?: RefsDetectionBand }
  /** THC-syre: read off the elimination curves, not off a band. */
  | { kind: 'curves' }
  /** The guideline says, in as many words, that documentation is lacking. */
  | { kind: 'noDocumentation' }
  /** The cell is empty — no detection time is stated for this component. */
  | { kind: 'notStated' };

/** Which half of a parent/metabolite pair a reading speaks about. */
export type RefsReadingScope = 'both' | 'parent' | 'metabolite';

export interface RefsDetectionReading {
  scope: RefsReadingScope;
  statement: RefsDetectionStatement;
}

/** One row of the guideline's table. */
export interface RefsUrineDetectionRow {
  /** Stable key for React lists and test ids. */
  key: string;
  /** Parent substance, spelled as the guideline spells it. */
  parent: string;
  /** Metabolites the guideline lists next to that parent. */
  metabolites: string[];
  /** One entry per statement the cell makes; usually exactly one. */
  readings: RefsDetectionReading[];
  /** The table's own "Kommentar" cell, verbatim (Norwegian). */
  comment?: string;
  /**
   * The fuller statement from the substance's own chapter, verbatim
   * (Norwegian), where the chapter says more than the band does — e.g. the
   * actual day counts behind "Siste uken".
   */
  detail?: string;
  /**
   * Extra spellings of the PARENT that must resolve to this row — English
   * names, brand names, synonyms the guideline does not use.
   *
   * Parent only. A metabolite's synonyms go in `metaboliteAliases`, because the
   * role a match carries decides which half of the row's answer it is given:
   * an alias filed here is told the parent's reading, and for a metabolite that
   * is the wrong half (etanol's parent is "siste døgnet", EtG is "siste uken").
   */
  aliases?: string[];
  /**
   * Extra spellings of a METABOLITE, keyed by the guideline's own spelling of
   * it. The key must be one of `metabolites` — `refsDetectionTimes.test.ts`
   * asserts it, so a metabolite renamed in the table cannot leave its synonyms
   * pointing at nothing.
   */
  metaboliteAliases?: Record<string, string[]>;
}

/** Provenance of the table — shown wherever a reading from it is shown. */
export interface RefsGuidelineSource {
  /** Document title, as printed on the guideline. */
  title: string;
  documentId: string;
  version: string;
  /** ISO date the version is approved from. */
  approvedFrom: string;
  /** Owning unit, as printed on the guideline. */
  unit: string;
  /** Classification line printed in the guideline's header. */
  classification: string;
}

export interface RefsUrineDetectionPayload {
  source: RefsGuidelineSource;
  /** The table's own preamble, verbatim; empty for a gated caller. */
  preamble: string;
  rows: RefsUrineDetectionRow[];
  /** True when the caller may not read the guideline; `rows` is then empty. */
  gated: boolean;
}

/** How a substance ended up matching a row. */
export type RefsMatchRole = 'parent' | 'metabolite';

export interface RefsRowMatch {
  row: RefsUrineDetectionRow;
  /** Whether the substance is the row's parent or one of its metabolites. */
  role: RefsMatchRole;
  /** The guideline's own spelling of the name that matched. */
  matchedName: string;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Is this really the guideline payload?
 *
 * The client is the last place that can ask. Everything downstream trusts the
 * shape completely: the index walks `row.parent` and `row.metabolites`, and the
 * section reads five fields off `source` during render. A 200 that is *almost*
 * the payload — the right `rows` and `gated`, no `source` — therefore does not
 * degrade, it throws inside a render with no error boundary above it and takes
 * the page with it. Checking two fields was enough to parse our own server's
 * answer and not enough to survive anything else answering.
 *
 * A payload that fails is rejected WHOLE rather than repaired row by row.
 * Dropping the rows that do not parse would quietly shorten a forensic table,
 * and a reader cannot see the difference between a substance the guideline
 * omits and one this function threw away.
 */
function isStringRecord(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => typeof record[key] === 'string');
}

const SOURCE_KEYS = [
  'title',
  'documentId',
  'version',
  'approvedFrom',
  'unit',
  'classification',
] as const;

const READING_SCOPES: readonly string[] = ['both', 'parent', 'metabolite'];
const STATEMENT_KINDS: readonly string[] = [
  'band',
  'curves',
  'noDocumentation',
  'notStated',
];
const BAND_VALUES: readonly string[] = [
  'halfDay',
  'day',
  'days',
  'week',
  'twoWeeks',
];

function isStatement(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const statement = value as Record<string, unknown>;
  if (typeof statement.kind !== 'string') return false;
  if (!STATEMENT_KINDS.includes(statement.kind)) return false;
  if (statement.kind !== 'band') return true;
  // A band naming a value the module has no label for would render as a raw
  // i18n key in a forensic table.
  if (typeof statement.band !== 'string') return false;
  if (!BAND_VALUES.includes(statement.band)) return false;
  if (statement.upper === undefined) return true;
  return (
    typeof statement.upper === 'string' && BAND_VALUES.includes(statement.upper)
  );
}

function isReading(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const reading = value as Record<string, unknown>;
  return (
    typeof reading.scope === 'string' &&
    READING_SCOPES.includes(reading.scope) &&
    isStatement(reading.statement)
  );
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function isRefsUrineDetectionRow(
  value: unknown,
): value is RefsUrineDetectionRow {
  if (!isStringRecord(value, ['key', 'parent'])) return false;
  const row = value as Record<string, unknown>;
  if (!isStringArray(row.metabolites)) return false;
  if (!Array.isArray(row.readings) || row.readings.length === 0) return false;
  if (!row.readings.every(isReading)) return false;
  for (const optional of ['comment', 'detail'] as const) {
    if (row[optional] !== undefined && typeof row[optional] !== 'string') {
      return false;
    }
  }
  if (row.aliases !== undefined && !isStringArray(row.aliases)) return false;
  if (row.metaboliteAliases !== undefined) {
    if (!row.metaboliteAliases || typeof row.metaboliteAliases !== 'object') {
      return false;
    }
    const byMetabolite = row.metaboliteAliases as Record<string, unknown>;
    if (!Object.values(byMetabolite).every(isStringArray)) return false;
  }
  return true;
}

/** What the route and the client answer when no guideline is available. */
export const EMPTY_REFS_SOURCE: RefsGuidelineSource = {
  title: '',
  documentId: '',
  version: '',
  approvedFrom: '',
  unit: '',
  classification: '',
};

export function isRefsGuidelineSource(
  value: unknown,
): value is RefsGuidelineSource {
  return isStringRecord(value, SOURCE_KEYS);
}

export function isRefsUrineDetectionPayload(
  value: unknown,
): value is RefsUrineDetectionPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.gated !== 'boolean') return false;
  if (typeof payload.preamble !== 'string') return false;
  if (!isStringRecord(payload.source, SOURCE_KEYS)) return false;
  return (
    Array.isArray(payload.rows) && payload.rows.every(isRefsUrineDetectionRow)
  );
}

/**
 * Fold a name to the form matching compares on: lower case, accents dropped,
 * everything that is not a letter or digit removed.
 *
 * The last part is what makes "6-MAM" meet "6 MAM", "THC-syre" meet "THCsyre"
 * and "Morfin-3-glukuronid" meet "morfin 3 glukuronid". It also means the fold
 * is deliberately lossy — it is only ever used to compare two names that are
 * already known to be substance names, never to display one.
 */
export function foldSubstanceName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Every fold one written name should answer to.
 *
 * The guideline writes some cells as a compound of several names — "MDMA/MDA
 * (Ecstacy)", "Fencyklidin (PCP)", "Morfin-3-glukuronid, Morfin-6-glukuronid".
 * A reader looking up "PCP" is looking up that row, so the separators the
 * guideline uses (slash, comma, parentheses) are split on, and both the whole
 * cell and each of its parts become a key.
 */
export function nameMatchKeys(name: string): string[] {
  const keys = new Set<string>();
  const add = (value: string) => {
    const folded = foldSubstanceName(value);
    if (folded) keys.add(folded);
  };

  add(name);
  // Drop the parenthesised part, then keep it separately: "Fencyklidin (PCP)"
  // has to answer to both "fencyklidin" and "pcp".
  add(name.replace(/\([^)]*\)/g, ' '));
  for (const inner of name.matchAll(/\(([^)]*)\)/g)) add(inner[1] ?? '');
  for (const part of name.split(/[/,]/)) {
    add(part);
    add(part.replace(/\([^)]*\)/g, ' '));
  }

  return [...keys];
}

interface IndexEntry {
  row: RefsUrineDetectionRow;
  role: RefsMatchRole;
  matchedName: string;
}

/**
 * Fold → the rows that name it, built once per table.
 *
 * A fold can legitimately point at several entries: oxazepam is a row of its
 * own AND a metabolite of diazepam, amfetamin is a row of its own AND the
 * metabolite the metamfetamin row lists. Those cross-references are the
 * guideline's own, and losing them would hide the very ambiguity a case is
 * interpreted around — so the index keeps every entry a fold hits.
 */
export function buildRefsNameIndex(
  rows: readonly RefsUrineDetectionRow[],
): Map<string, IndexEntry[]> {
  const index = new Map<string, IndexEntry[]>();

  const record = (key: string, entry: IndexEntry) => {
    const existing = index.get(key);
    if (!existing) {
      index.set(key, [entry]);
      return;
    }
    // Same row, same role, already recorded through another spelling.
    if (
      existing.some((e) => e.row.key === entry.row.key && e.role === entry.role)
    ) {
      return;
    }
    existing.push(entry);
  };

  for (const row of rows) {
    for (const key of nameMatchKeys(row.parent)) {
      record(key, { row, role: 'parent', matchedName: row.parent });
    }
    for (const alias of row.aliases ?? []) {
      for (const key of nameMatchKeys(alias)) {
        record(key, { row, role: 'parent', matchedName: row.parent });
      }
    }
    for (const metabolite of row.metabolites) {
      for (const key of nameMatchKeys(metabolite)) {
        record(key, { row, role: 'metabolite', matchedName: metabolite });
      }
    }
    // Keyed by the guideline's spelling, so a synonym reports the name the
    // document uses rather than the one the catalog happened to be searched by.
    for (const [metabolite, aliases] of Object.entries(
      row.metaboliteAliases ?? {},
    )) {
      for (const alias of aliases) {
        for (const key of nameMatchKeys(alias)) {
          record(key, { row, role: 'metabolite', matchedName: metabolite });
        }
      }
    }
  }

  return index;
}

/**
 * The guideline rows a substance is named in, given every name Kinetix knows it
 * by (all languages, short name, aliases).
 *
 * Parent matches come first: a substance that IS a row of the table is
 * answered by that row, and the rows that merely list it as a metabolite are
 * context after the fact. Within each role, the table's own order is kept.
 */
export function matchRefsRows(
  index: Map<string, IndexEntry[]>,
  names: readonly (string | null | undefined)[],
): RefsRowMatch[] {
  const seen = new Set<string>();
  const parents: RefsRowMatch[] = [];
  const metabolites: RefsRowMatch[] = [];

  for (const name of names) {
    if (!name) continue;
    for (const key of nameMatchKeys(name)) {
      for (const entry of index.get(key) ?? []) {
        const dedupeKey = `${entry.row.key}:${entry.role}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const match: RefsRowMatch = {
          row: entry.row,
          role: entry.role,
          matchedName: entry.matchedName,
        };
        (entry.role === 'parent' ? parents : metabolites).push(match);
      }
    }
  }

  return [...parents, ...metabolites];
}

/** Every name Kinetix holds for a substance, in no particular order. */
export function substanceNameCandidates(substance: {
  names?: Record<string, string> | null;
  nameShort?: string | null;
  aliases?: string[] | null;
}): string[] {
  return [
    ...Object.values(substance.names ?? {}),
    substance.nameShort ?? '',
    ...(substance.aliases ?? []),
  ].filter((name): name is string => Boolean(name));
}

/**
 * The one statement a row makes ABOUT the half of it the reader arrived
 * through, or null when it makes more than one.
 *
 * Used where there is room for a chip and nothing more — the substance
 * register's column — and the role is not optional context. A row whose cell
 * splits by scope (etanol: the parent for a day, the metabolites for a week)
 * says two different things, and handing a reader who searched for EtG the
 * parent's reading is the wrong one of the two.
 *
 * Where the row's only reading is scoped to the OTHER half, the answer is
 * `notStated` rather than that reading: the metadon row states "siste par
 * ukene (moderstoff)" and lists EDDP beside it, so the guideline says nothing
 * at all about how long EDDP is found — and saying "siste par ukene" for it
 * would be this module inventing a forensic statement.
 *
 * Null means "more than one applies"; the caller sends the reader to the full
 * row instead of picking.
 */
export function refsStatementForRole(
  row: RefsUrineDetectionRow,
  role: RefsMatchRole,
): RefsDetectionStatement | null {
  const applicable = row.readings.filter(
    (reading) => reading.scope === 'both' || reading.scope === role,
  );
  if (applicable.length === 1) return applicable[0]?.statement ?? null;
  if (applicable.length === 0) return { kind: 'notStated' };
  return null;
}
