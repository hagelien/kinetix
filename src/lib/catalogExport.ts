/**
 * Catalog projection: live DB → `data/components.ts`.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `data/components.ts` has always been a one-way *input*: `scripts/seed-drugs.ts`
 * reads `embeddedComponents` and upserts it into `drugs` / `drug_parameters`,
 * and `src/data/index.ts` re-imports it as the offline fallback when
 * `GET /api/drugs` is unreachable or empty. Nothing ever read the DB back into
 * the file, so every write path that landed after the last hand-edit — the
 * `/review` pending-edit queue, `parameter_entries` aggregation, the deep-research
 * importer, the scheduled maintainer agents — moved the database while the
 * fixture stood still. The fallback bundle silently aged.
 *
 * This module is the missing return leg. It is deliberately pure: it takes an
 * already-fetched projection of the catalog tables ({@link CatalogDrugRow}),
 * maps it onto the fixture's `RawComponent` shape, renders the TypeScript
 * source, and diffs two catalogs semantically. The DB read lives in
 * `api/_lib/catalogExportStore.ts` and the file I/O in
 * `scripts/export-components.ts`, so this half is testable with no database and
 * no filesystem.
 *
 * ── What is NOT claimed here ─────────────────────────────────────────────────
 * The fixture stays hand-editable. It is still the seed source for a fresh
 * database and still the pinned catalog the kinetics-core provenance gate reads
 * (`scripts/generate-registry-provenance.ts`), so this is a *sync*, not an
 * authoritative regeneration — which is exactly why {@link diffCatalogs}
 * compares meaning rather than bytes. Hand-formatted entries and generated ones
 * must be able to coexist without the drift check crying wolf.
 */
import { normalizeMetabolismName } from './metabolism.js';
import { isQualifierOperator } from '../types/index.js';
import type { RawComponent } from '../../data/components';

/**
 * The fixture's range shape. `data/components.ts` declares `RangeData` without
 * exporting it, so derive it from the public `RawComponent` rather than
 * widening that module's surface just for this consumer.
 */
export type CatalogRangeData = NonNullable<RawComponent['halfLife']>;

/**
 * Fixture keys carrying a `RangeData`, in the order they are emitted.
 * The left-hand side is the `drug_parameters.parameter` id; the right-hand side
 * is the `RawComponent` key. They differ for the three interpretive bands: the
 * registry calls them `therapeuticConcentration` / `toxicConcentration` /
 * `fatalConcentration`, the fixture calls them `therapeuticRange` / `toxicRange`
 * / `lethalRange`, and `src/data/index.ts` re-joins the two when it builds the
 * fallback `DrugComponent`.
 */
export const CATALOG_RANGE_PARAMETERS: ReadonlyArray<
  readonly [parameterId: string, field: keyof RawComponent]
> = [
  ['halfLife', 'halfLife'],
  ['volumeOfDistribution', 'volumeOfDistribution'],
  ['bioavailability', 'bioavailability'],
  ['proteinBinding', 'proteinBinding'],
  ['bloodPlasmaRatio', 'bloodPlasmaRatio'],
  ['tmax', 'tmax'],
  ['pKa', 'pKa'],
  ['therapeuticConcentration', 'therapeuticRange'],
  ['toxicConcentration', 'toxicRange'],
  ['fatalConcentration', 'lethalRange'],
];

/**
 * The fixture key a `drug_parameters.parameter` id is stored under, or the id
 * itself when the two agree.
 *
 * Shared with `scripts/seed-drugs.ts`: the seeder reads the fixture by registry
 * id, so without this map it silently misses the three interpretive bands on
 * the way IN, exactly as the exporter would on the way OUT. One mapping, both
 * directions.
 */
export function fixtureFieldForParameter(parameterId: string): string {
  for (const [id, field] of CATALOG_RANGE_PARAMETERS) {
    if (id === parameterId) return field as string;
  }
  return parameterId;
}

/** Emission order for a component's fields — mirrors the existing fixture. */
const FIELD_ORDER: ReadonlyArray<keyof RawComponent> = [
  'name',
  'nameEn',
  'pubchemCid',
  'molecularWeight',
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  'pKa',
  'metabolism',
  'therapeuticRange',
  'toxicRange',
  'lethalRange',
];

/** Key order inside a rendered range literal — mirrors `RangeData`. */
const RANGE_NUMERIC_FIELDS = ['min', 'max', 'mean', 'median'] as const;
const RANGE_TEXT_FIELDS = ['unit', 'qualifier', 'note'] as const;
const RANGE_FIELDS = [
  'min',
  'max',
  'mean',
  'median',
  'unit',
  'qualifier',
  'note',
] as const;

/** One drug as read from the catalog tables, before projection. */
export interface CatalogDrugRow {
  pubchemCid: number | null;
  names: Record<string, string> | null;
  /** `drug_parameters.parameter` → `drug_parameters.value` (raw jsonb). */
  parameters: Record<string, unknown>;
  /** `drug_elimination_routes` with `kind='enzyme'`, in sort order. */
  enzymes: string[];
  /** `drug_metabolites.metabolite_name`, in sort order. */
  metabolites: string[];
  /** `drug_elimination_routes` with any other `kind`, in sort order. */
  eliminationRoutes: string[];
}

/** A drug the projection could not represent, with the reason why. */
export interface SkippedRow {
  name: string;
  reason: 'no-pubchem-cid' | 'no-name';
}

export interface ProjectionResult {
  components: RawComponent[];
  skipped: SkippedRow[];
}

// ─── Value sanitizing ───────────────────────────────────────────────────────

/**
 * Coerce a stored parameter value into the fixture's `RangeData`.
 *
 * Drops anything the fixture has no field for — notably `derivedFromEntries`,
 * the machine marker the `parameter_entries` aggregation stamps on recomputed
 * caches. That flag is meaningful only next to the entries it was computed
 * from; carrying it into a static fixture would assert a provenance the file
 * cannot back up. Returns `undefined` for a value with nothing usable left, so
 * an empty `{}` never renders as a field.
 */
export function sanitizeRange(value: unknown): CatalogRangeData | undefined {
  if (value === null || value === undefined) return undefined;
  // A bare number is the legacy scalar shape (pre-#302 columns, and what a
  // `kind: 'scalar'` parameter may still hold). Median is the fixture's
  // representative slot, matching how legacy single values were migrated.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { median: value } : undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RANGE_NUMERIC_FIELDS) {
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  for (const key of RANGE_TEXT_FIELDS) {
    const v = src[key];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    // `qualifier` is a comparison operator, not free text — the fixture types it
    // as '<' | '>' | '≤' | '≥'. Live data does contain legacy free-text values
    // (migration 0078 deliberately preserved a `qualifier: "approximately"` row;
    // see tests/integration/migration-0078-qualifier.test.ts), and rendering one
    // into `data/components.ts` would produce a file that does not typecheck —
    // an exporter that breaks the build. Drop what the fixture cannot represent.
    if (key === 'qualifier' && !isQualifierOperator(trimmed)) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0
    ? (out as CatalogRangeData)
    : undefined;
}

/** Coerce a stored `kind: 'number'` parameter (molecularWeight) to a number. */
export function sanitizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A number-kind parameter is occasionally stored as a NumericRange by an
  // older write path; take its representative scalar rather than dropping it.
  const range = sanitizeRange(value);
  if (!range) return undefined;
  const candidate = range.median ?? range.mean;
  return typeof candidate === 'number' ? candidate : undefined;
}

/**
 * Trim, drop blanks, and de-duplicate a metabolism string list using the same
 * normalization the seeder applies on the way in, so a round trip through the
 * DB and back is idempotent instead of accreting case variants.
 */
export function sanitizeNameList(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    const key = normalizeMetabolismName(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// ─── Projection ─────────────────────────────────────────────────────────────

/**
 * Project one catalog row onto the fixture shape, or `null` with a reason when
 * it cannot be represented. `pubchemCid` is required and non-optional on
 * `RawComponent`; it is also the join key for the seeder's upsert, the diff
 * below, and `catalogLookup` in the provenance gate — a row without one has no
 * stable identity in the fixture and is reported rather than invented.
 */
export function toRawComponent(
  row: CatalogDrugRow,
): { component: RawComponent } | { skipped: SkippedRow } {
  const names = row.names ?? {};
  // Norwegian first, then English, then any language present. The final
  // fallback matters: `drugs.names` is keyed by arbitrary BCP-47 code, so a row
  // carrying only e.g. `da` would otherwise be dropped from the offline catalog
  // for having the "wrong" language rather than for missing data.
  const firstName = Object.values(names)
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  const name = (names.nb?.trim() || names.en?.trim() || firstName || '').trim();
  const nameEn = (names.en ?? '').trim();

  if (!name) {
    return { skipped: { name: `pubchem:${row.pubchemCid ?? '?'}`, reason: 'no-name' } };
  }
  if (row.pubchemCid === null || !Number.isInteger(row.pubchemCid)) {
    return { skipped: { name, reason: 'no-pubchem-cid' } };
  }

  const component: RawComponent = { name, pubchemCid: row.pubchemCid };
  if (nameEn) component.nameEn = nameEn;

  const molecularWeight = sanitizeNumber(row.parameters.molecularWeight);
  if (molecularWeight !== undefined) component.molecularWeight = molecularWeight;

  for (const [parameterId, field] of CATALOG_RANGE_PARAMETERS) {
    const range = sanitizeRange(row.parameters[parameterId]);
    if (range) {
      // Every mapped field is range-typed; the cast keeps the loop generic
      // without widening `RawComponent`.
      (component as unknown as Record<string, unknown>)[field] = range;
    }
  }

  const enzymes = sanitizeNameList(row.enzymes);
  const metabolites = sanitizeNameList(row.metabolites);
  const eliminationRoutes = sanitizeNameList(row.eliminationRoutes);
  if (enzymes.length || metabolites.length || eliminationRoutes.length) {
    component.metabolism = { enzymes, metabolites, eliminationRoutes };
  }

  return { component };
}

export function buildRawComponents(
  rows: readonly CatalogDrugRow[],
): ProjectionResult {
  const components: RawComponent[] = [];
  const skipped: SkippedRow[] = [];
  for (const row of rows) {
    const result = toRawComponent(row);
    if ('component' in result) components.push(result.component);
    else skipped.push(result.skipped);
  }
  return { components, skipped };
}

// ─── Semantic diff ──────────────────────────────────────────────────────────

export interface FieldDrift {
  field: string;
  /** Rendered current value in `data/components.ts` (`—` when absent). */
  file: string;
  /** Rendered current value in the database (`—` when absent). */
  db: string;
}

export interface DrugDrift {
  pubchemCid: number;
  name: string;
  fields: FieldDrift[];
}

export interface CatalogEntryRef {
  pubchemCid: number;
  name: string;
}

export interface CatalogDiff {
  /** In the database, absent from the fixture. */
  onlyInDb: CatalogEntryRef[];
  /** In the fixture, absent from the database. */
  onlyInFile: CatalogEntryRef[];
  /** Present in both, with at least one field differing. */
  changed: DrugDrift[];
  /** Count of entries that matched on every field. */
  unchanged: number;
}

export function isCatalogInSync(diff: CatalogDiff): boolean {
  return (
    diff.onlyInDb.length === 0 &&
    diff.onlyInFile.length === 0 &&
    diff.changed.length === 0
  );
}

export interface DuplicateCid {
  pubchemCid: number;
  /** Every fixture `name` sharing this CID, in file order. */
  names: string[];
}

/**
 * Find entries sharing a `pubchemCid`.
 *
 * The fixture is hand-editable and has no uniqueness constraint, so the same
 * substance can be entered twice under two Norwegian synonyms. That is a real
 * defect rather than a cosmetic one: `seed-drugs.ts` upserts on `pubchem_cid`,
 * so only the last of the duplicates survives into the database and the earlier
 * one's data is silently discarded. It also breaks the CID-as-identity
 * assumption every function above relies on, which is why the exporter reports
 * duplicates instead of quietly resolving them — choosing which name is
 * canonical is a terminology decision, not a mechanical one.
 */
export function findDuplicateCids(
  components: readonly RawComponent[],
): DuplicateCid[] {
  const byCid = new Map<number, string[]>();
  for (const c of components) {
    const names = byCid.get(c.pubchemCid);
    if (names) names.push(c.name);
    else byCid.set(c.pubchemCid, [c.name]);
  }
  const out: DuplicateCid[] = [];
  for (const [pubchemCid, names] of byCid) {
    if (names.length > 1) out.push({ pubchemCid, names });
  }
  return out.sort((a, b) => a.pubchemCid - b.pubchemCid);
}

/** Deterministic JSON with sorted keys, for value-equality comparison. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

/**
 * Normalize a component to comparable field values.
 *
 * Both sides go through the same sanitizer so a hand-authored entry and a
 * generated one are judged on meaning: key order, blank notes, a stray
 * `derivedFromEntries`, and an all-empty `metabolism` block (which several
 * hand-written entries carry and the projection omits) are not drift.
 */
export function canonicalComponent(
  component: RawComponent,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const name = component.name?.trim();
  if (name) out.set('name', name);
  const nameEn = component.nameEn?.trim();
  if (nameEn) out.set('nameEn', nameEn);

  const molecularWeight = sanitizeNumber(component.molecularWeight);
  if (molecularWeight !== undefined) out.set('molecularWeight', molecularWeight);

  for (const [, field] of CATALOG_RANGE_PARAMETERS) {
    const range = sanitizeRange(
      (component as unknown as Record<string, unknown>)[field as string],
    );
    if (range) out.set(field as string, range);
  }

  const enzymes = sanitizeNameList(component.metabolism?.enzymes ?? []);
  const metabolites = sanitizeNameList(component.metabolism?.metabolites ?? []);
  const eliminationRoutes = sanitizeNameList(
    component.metabolism?.eliminationRoutes ?? [],
  );
  if (enzymes.length) out.set('metabolism.enzymes', enzymes);
  if (metabolites.length) out.set('metabolism.metabolites', metabolites);
  if (eliminationRoutes.length) {
    out.set('metabolism.eliminationRoutes', eliminationRoutes);
  }
  return out;
}

function renderValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.join(', ') || '(empty)';
  return stableStringify(value);
}

/**
 * Compare the fixture against the database, keyed on `pubchemCid`.
 *
 * Keyed on the CID rather than the name because that is the seeder's upsert
 * target: a drug renamed in the DB is the same catalog entry with a changed
 * `name` field, not a delete plus an add.
 */
export function diffCatalogs(
  fileComponents: readonly RawComponent[],
  dbComponents: readonly RawComponent[],
): CatalogDiff {
  const fileByCid = new Map<number, RawComponent>();
  for (const c of fileComponents) fileByCid.set(c.pubchemCid, c);
  const dbByCid = new Map<number, RawComponent>();
  for (const c of dbComponents) dbByCid.set(c.pubchemCid, c);

  const diff: CatalogDiff = {
    onlyInDb: [],
    onlyInFile: [],
    changed: [],
    unchanged: 0,
  };

  for (const [cid, dbComponent] of dbByCid) {
    if (!fileByCid.has(cid)) {
      diff.onlyInDb.push({ pubchemCid: cid, name: dbComponent.name });
    }
  }
  for (const [cid, fileComponent] of fileByCid) {
    if (!dbByCid.has(cid)) {
      diff.onlyInFile.push({ pubchemCid: cid, name: fileComponent.name });
      continue;
    }
    const dbComponent = dbByCid.get(cid)!;
    const fileCanon = canonicalComponent(fileComponent);
    const dbCanon = canonicalComponent(dbComponent);
    const fields = new Set([...fileCanon.keys(), ...dbCanon.keys()]);
    const drifted: FieldDrift[] = [];
    for (const field of [...fields].sort()) {
      const a = fileCanon.get(field);
      const b = dbCanon.get(field);
      if (stableStringify(a ?? null) === stableStringify(b ?? null)) continue;
      drifted.push({ field, file: renderValue(a), db: renderValue(b) });
    }
    if (drifted.length > 0) {
      diff.changed.push({
        pubchemCid: cid,
        name: fileComponent.name,
        fields: drifted,
      });
    } else {
      diff.unchanged += 1;
    }
  }

  diff.onlyInDb.sort((a, b) => a.pubchemCid - b.pubchemCid);
  diff.onlyInFile.sort((a, b) => a.pubchemCid - b.pubchemCid);
  diff.changed.sort((a, b) => a.pubchemCid - b.pubchemCid);
  return diff;
}

// ─── Source rendering ───────────────────────────────────────────────────────

export const COMPONENTS_ARRAY_MARKER =
  'export const embeddedComponents: RawComponent[] = [';

/**
 * Split `data/components.ts` into the preamble (imports, `RangeData`,
 * `RawComponent` and their comments) and the array literal that follows.
 *
 * Only the array is ever regenerated — the type declarations above it are
 * hand-maintained and carry review commentary that no generator should own.
 */
export function splitComponentsSource(source: string): {
  preamble: string;
  arraySource: string;
} {
  const index = source.indexOf(COMPONENTS_ARRAY_MARKER);
  if (index === -1) {
    throw new Error(
      `Could not find "${COMPONENTS_ARRAY_MARKER}" in the components source; ` +
        'the file layout changed and the exporter needs updating.',
    );
  }
  return {
    preamble: source.slice(0, index),
    arraySource: source.slice(index),
  };
}

function quote(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`;
}

function renderRange(range: CatalogRangeData): string {
  const parts: string[] = [];
  for (const key of RANGE_FIELDS) {
    const value = (range as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    parts.push(
      `${key}: ${typeof value === 'number' ? String(value) : quote(String(value))}`,
    );
  }
  return `{ ${parts.join(', ')} }`;
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? '[]' : `[${values.map(quote).join(', ')}]`;
}

/**
 * Metabolism renders inline when it fits the fixture's ~80-column habit and as
 * a block otherwise — the same split the existing hand-written entries use, so
 * a refresh does not reflow every untouched line into a different shape.
 */
function renderMetabolism(
  metabolism: NonNullable<RawComponent['metabolism']>,
  indent: string,
): string {
  const enzymes = renderList(metabolism.enzymes ?? []);
  const metabolites = renderList(metabolism.metabolites ?? []);
  const routes = renderList(metabolism.eliminationRoutes ?? []);
  const inline = `{ enzymes: ${enzymes}, metabolites: ${metabolites}, eliminationRoutes: ${routes} }`;
  if (`${indent}metabolism: ${inline},`.length <= 80) return inline;
  const inner = `${indent}  `;
  return [
    '{',
    `${inner}enzymes: ${enzymes},`,
    `${inner}metabolites: ${metabolites},`,
    `${inner}eliminationRoutes: ${routes}`,
    `${indent}}`,
  ].join('\n');
}

export function renderComponent(component: RawComponent): string {
  const indent = '    ';
  const lines: string[] = [];
  for (const field of FIELD_ORDER) {
    const value = (component as unknown as Record<string, unknown>)[field as string];
    if (value === undefined || value === null) continue;
    if (field === 'name' || field === 'nameEn') {
      lines.push(`${indent}${field}: ${quote(String(value))}`);
    } else if (field === 'pubchemCid' || field === 'molecularWeight') {
      lines.push(`${indent}${field}: ${String(value)}`);
    } else if (field === 'metabolism') {
      lines.push(
        `${indent}metabolism: ${renderMetabolism(
          value as NonNullable<RawComponent['metabolism']>,
          indent,
        )}`,
      );
    } else {
      lines.push(
        `${indent}${field}: ${renderRange(value as CatalogRangeData)}`,
      );
    }
  }
  return `  {\n${lines.join(',\n')}\n  }`;
}

export interface MergeOptions {
  /**
   * Mirror the database exactly: drop fixture entries it has no row for, and
   * drop fixture field values it has no value for. Off by default — see
   * {@link mergeForRender}.
   */
  prune?: boolean;
}

export interface PreservedFields extends CatalogEntryRef {
  fields: string[];
}

export interface MergeResult {
  components: RawComponent[];
  /** Fixture-only entries carried through untouched (empty when pruning). */
  retained: CatalogEntryRef[];
  /** Fixture-only entries dropped (empty unless pruning). */
  dropped: CatalogEntryRef[];
  /**
   * Per-drug field values kept from the fixture because the database
   * projection had none (empty when pruning).
   */
  preservedFields: PreservedFields[];
}

/** Fields a merge may carry over; identity fields are always the DB's. */
const MERGEABLE_FIELDS = FIELD_ORDER.filter(
  (f) => f !== 'name' && f !== 'pubchemCid',
);

function hasMetabolismContent(value: unknown): boolean {
  const m = value as RawComponent['metabolism'];
  if (!m) return false;
  return Boolean(
    m.enzymes?.length || m.metabolites?.length || m.eliminationRoutes?.length,
  );
}

/**
 * Combine one fixture entry with its database row, field by field.
 *
 * The database wins wherever it has a value; the fixture's value survives where
 * the database has none. That asymmetry is not a nicety — it is required for
 * correctness, because the seeder does not round-trip every field.
 *
 * `seed-drugs.ts` reads the fixture by *registry parameter id*
 * (`therapeuticConcentration`, `toxicConcentration`, `fatalConcentration`), but
 * the fixture stores those three under different keys (`therapeuticRange`,
 * `toxicRange`, `lethalRange`). So for any drug whose data reached the database
 * only through seeding, the interpretive bands were never written — 68 of the
 * 171 committed entries carry at least one. A whole-object replacement would
 * therefore delete dozens of hand-curated forensic thresholds, which is exactly
 * the data this tool exists to surface. (The seeder now maps those keys, so a
 * fresh seed does round-trip them; this merge protects databases seeded before
 * that fix, and any field a future write path forgets.)
 *
 * The cost is that a refresh alone cannot *remove* a value — pass `prune: true`
 * to mirror the database exactly.
 */
function mergeComponent(
  fileComponent: RawComponent,
  dbComponent: RawComponent,
): { component: RawComponent; preserved: string[] } {
  const component: RawComponent = { ...dbComponent };
  const preserved: string[] = [];
  for (const field of MERGEABLE_FIELDS) {
    const key = field as string;
    const dbValue = (dbComponent as unknown as Record<string, unknown>)[key];
    if (dbValue !== undefined && dbValue !== null) continue;
    const fileValue = (fileComponent as unknown as Record<string, unknown>)[key];
    if (fileValue === undefined || fileValue === null) continue;
    // An all-empty metabolism block carries no information; leave it out rather
    // than reintroducing noise the projection deliberately omits.
    if (field === 'metabolism' && !hasMetabolismContent(fileValue)) continue;
    (component as unknown as Record<string, unknown>)[key] = fileValue;
    preserved.push(key);
  }
  return { component, preserved };
}

/**
 * Merge the database projection into the fixture for rendering.
 *
 * Three properties matter here, and all are about not destroying work:
 *
 * 1. **Fixture-only entries are kept by default.** The fixture is a seed
 *    *source*, so a drug it holds that the database does not is the ordinary
 *    case for any database that was never seeded (a fresh branch, a dev
 *    instance, a Neon preview). Dropping those on a refresh would quietly
 *    delete curated pharmacology because the exporter happened to be pointed at
 *    an under-populated database. Removal requires `prune: true`.
 * 2. **Fixture-only field values are kept by default** — see
 *    {@link mergeComponent} for why this is a correctness requirement rather
 *    than caution.
 * 3. **Existing entries keep their position.** Drugs already in the file stay
 *    where they are and new ones are appended in codepoint order by name, so a
 *    refresh produces a reviewable diff instead of reordering 170 entries.
 *
 * Codepoint rather than `localeCompare` on purpose — a locale-sensitive sort
 * makes the generated file depend on the runner's ICU data, which would turn
 * the CI drift check into a false alarm on a different machine.
 *
 * Duplicate fixture CIDs collapse onto the database row **only when there is
 * one**. With no database row to supply the canonical entry, every duplicate is
 * kept: silently picking one synonym and deleting the other would break
 * property 1 for the very entries most likely to need human attention.
 */
export function mergeForRender(
  fileComponents: readonly RawComponent[],
  dbComponents: readonly RawComponent[],
  options: MergeOptions = {},
): MergeResult {
  const dbByCid = new Map<number, RawComponent>();
  for (const c of dbComponents) dbByCid.set(c.pubchemCid, c);

  const out: RawComponent[] = [];
  const consumed = new Set<number>();
  const retained: CatalogEntryRef[] = [];
  const dropped: CatalogEntryRef[] = [];
  const preservedFields: PreservedFields[] = [];

  for (const fileComponent of fileComponents) {
    const cid = fileComponent.pubchemCid;
    // Only skip a repeat CID once a database row has actually replaced it.
    if (consumed.has(cid)) continue;
    const dbComponent = dbByCid.get(cid);
    if (dbComponent) {
      consumed.add(cid);
      if (options.prune) {
        out.push(dbComponent);
        continue;
      }
      const { component, preserved } = mergeComponent(
        fileComponent,
        dbComponent,
      );
      out.push(component);
      if (preserved.length > 0) {
        preservedFields.push({
          pubchemCid: cid,
          name: component.name,
          fields: preserved,
        });
      }
      continue;
    }
    const ref = { pubchemCid: cid, name: fileComponent.name };
    if (options.prune) {
      dropped.push(ref);
    } else {
      out.push(fileComponent);
      retained.push(ref);
    }
  }

  const appended = dbComponents
    .filter((c) => !consumed.has(c.pubchemCid))
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.pubchemCid - b.pubchemCid,
    );

  return {
    components: [...out, ...appended],
    retained,
    dropped,
    preservedFields,
  };
}

export function renderComponentsSource(
  preamble: string,
  components: readonly RawComponent[],
): string {
  const body = components.map(renderComponent).join(',\n');
  return `${preamble}${COMPONENTS_ARRAY_MARKER}\n${body}\n];\n`;
}
