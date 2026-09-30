/**
 * Structured dose context and reported statistic on a source entry
 * (`parameter_entries`, migration 0127) — the Cmax dose-context RFC,
 * docs/plans/2026-09-17-cmax-dose-context.md, sections 1a–5 and *Validation
 * invariants*.
 *
 * One module owns the field list, the vocabularies and the write-time rules,
 * because the RFC's recurring failure was enumerations drifting apart: a
 * value-carrying column missing from a bounds loop, a context column missing
 * from a duplicate predicate. Everything that has to enumerate these fields —
 * the zod shapes, the store's insert and update, serialization, the dedup
 * identity, the merge — reads `DOSE_CONTEXT_FIELDS` rather than restating it.
 *
 * What this module does NOT decide is normalization or pooling eligibility.
 * Most context the source may omit is storable as `'unknown'` (or null) and
 * refused later, by the normalizer, with a named reason; rejecting it here
 * would discard evidence the design promises to keep. The rules below are
 * only the ones whose violation makes the row itself ill-formed.
 */
import { z } from 'zod';
import type { DoseBasis } from './kinetics-core/index.js';

// ─── Vocabularies ───────────────────────────────────────────────────────────

/** What `centralValue` is (section 1a). */
export const CENTRAL_STATISTICS = [
  'arithmetic_mean',
  'geometric_mean',
  'median',
  'single_subject',
  'unknown',
] as const;
export type CentralStatistic = (typeof CENTRAL_STATISTICS)[number];

/** What `low`/`high` are (section 1a). */
export const INTERVAL_KINDS = [
  'sd',
  'sem',
  'ci95',
  'iqr',
  'range',
  'unknown',
] as const;
export type IntervalKind = (typeof INTERVAL_KINDS)[number];

/**
 * Interval kinds whose endpoints arithmetic produced rather than a subject
 * exhibited: `centre ± SD` can legitimately be negative, so the registry
 * bounds apply to the centre only.
 */
export const ARITHMETIC_INTERVAL_KINDS: ReadonlySet<string> = new Set([
  'sd',
  'sem',
  'ci95',
]);

/**
 * Dose units a Cmax dose may be stated in: absolute mass and weight-normalized
 * mass. Daily-rate units (`mg/day`) are deliberately absent — a rate is not a
 * dose, and cannot be the denominator of a peak concentration.
 */
export const DOSE_CONTEXT_DOSE_UNITS = ['µg', 'mg', 'g', 'µg/kg', 'mg/kg'] as const;
export type DoseContextDoseUnit = (typeof DOSE_CONTEXT_DOSE_UNITS)[number];

/** Absolute-mass or weight-normalized — the two dose families never pool. */
export function doseUnitFamily(unit: string): 'absolute' | 'weight' | null {
  if (unit === 'µg' || unit === 'mg' || unit === 'g') return 'absolute';
  if (unit === 'µg/kg' || unit === 'mg/kg') return 'weight';
  return null;
}

/** What the stated mass is a mass OF (section 3) — kinetics-core's `DoseBasis`. */
export const DOSE_BASES = [
  'active-moiety',
  'parent',
  'salt',
  'free-base',
] as const satisfies readonly DoseBasis[];

export const DOSE_REGIMENS = ['single', 'multiple', 'steady_state', 'unknown'] as const;
export type DoseRegimen = (typeof DOSE_REGIMENS)[number];

export const IV_INPUT_MODES = ['bolus', 'infusion', 'unknown'] as const;

export const RELEASE_PROFILES = [
  'immediate',
  'modified',
  'not_applicable',
  'unknown',
] as const;

/**
 * No `'parenteral'` member, on purpose (RFC 4a): an IV solution is
 * `{ not_applicable, solution }` and an IM depot is `{ modified, suspension }`.
 * A route class in the form vocabulary is how the two overlapped before.
 */
export const PHYSICAL_FORMS = [
  'tablet_capsule',
  'solution',
  'suspension',
  'other',
  'unknown',
] as const;

export const PRANDIAL_STATES = ['fasted', 'fed', 'unspecified'] as const;

export const COADMINISTRATION_STATES = [
  'monotherapy',
  'with_interacting_drug',
  'unknown',
] as const;

export const PK_POPULATIONS = [
  'healthy_adult',
  'patients_unspecified',
  'hepatic_impairment',
  'renal_impairment',
  'metabolizer_phenotype',
  'paediatric',
  'elderly',
  'pregnancy',
  'other',
  'unknown',
] as const;

/** Whether the stored number is a concentration or a source-reported Cmax/dose. */
export const VALUE_BASES = ['concentration', 'dose_normalized'] as const;
export type ValueBasis = (typeof VALUE_BASES)[number];

/**
 * How a parameter relates to dose context (registry `doseContext`).
 *
 * `'forbidden'` forbids the DOSE context only. The reported statistic —
 * `centralValue`, `centralStatistic`, `intervalKind` — is not about the dose:
 * a half-life reported as "0.54 (0.12) h, mean (SD)" needs it exactly as a
 * Cmax does, and without it the only slot for the central number was the
 * `median` column, so a mean was stored as a median. On a `'forbidden'`
 * parameter the statistic is therefore OPTIONAL (see
 * `REPORTED_STATISTIC_FIELD_KEYS` and `validateDoseContext`).
 */
export type DoseContextMode = 'required' | 'optional' | 'forbidden';

// ─── Units ──────────────────────────────────────────────────────────────────

/** Concentration units a `'concentration'` Cmax may carry. */
export const CMAX_CONCENTRATION_UNITS = [
  'mg/L',
  'µg/mL',
  'ng/mL',
  'µg/L',
  'ng/L',
  'mg/dL',
  'mmol/L',
  'µmol/L',
  'nmol/L',
] as const;

/**
 * Concentration-per-dose units a `'dose_normalized'` Cmax may carry: every
 * concentration unit over every dose unit, the weight-normalized denominator
 * parenthesised (`µmol/L/(mg/kg)`). All fit the 20-character `unit` column.
 */
export const DOSE_NORMALIZED_UNITS: readonly string[] =
  CMAX_CONCENTRATION_UNITS.flatMap((c) =>
    DOSE_CONTEXT_DOSE_UNITS.map((d) =>
      doseUnitFamily(d) === 'weight' ? `${c}/(${d})` : `${c}/${d}`,
    ),
  );

/** The dose unit a dose-normalized unit divides by, or null if it is not one. */
export function doseNormalizedDenominator(unit: string): DoseContextDoseUnit | null {
  if (!DOSE_NORMALIZED_UNITS.includes(unit)) return null;
  for (const d of DOSE_CONTEXT_DOSE_UNITS) {
    const suffix = doseUnitFamily(d) === 'weight' ? `/(${d})` : `/${d}`;
    if (unit.endsWith(suffix)) return d;
  }
  return null;
}

// ─── The field list ─────────────────────────────────────────────────────────

/**
 * Every dose-context / reported-statistic field, keyed by its entry property
 * (which is also its `parameterEntries` column key), with its value kind.
 * Adding a field here is how it joins every enumeration; adding it anywhere
 * else is how the RFC's defects happened.
 */
export const DOSE_CONTEXT_FIELDS = {
  centralValue: 'numeric',
  centralStatistic: 'text',
  intervalKind: 'text',
  doseValue: 'numeric',
  doseLow: 'numeric',
  doseHigh: 'numeric',
  doseUnit: 'text',
  doseBasis: 'text',
  doseSaltForm: 'text',
  doseRegimen: 'text',
  doseIntervalHours: 'numeric',
  doseNumber: 'integer',
  regimenDurationHours: 'numeric',
  priorDosingRegular: 'boolean',
  ivInputMode: 'text',
  administrationDurationMin: 'numeric',
  releaseProfile: 'text',
  physicalForm: 'text',
  prandialState: 'text',
  administeredDrugId: 'drug',
  coadministrationState: 'text',
  interactingDrugId: 'drug',
  pkPopulation: 'text',
  populationQualifier: 'text',
  valueBasis: 'text',
} as const;

export type DoseContextFieldKey = keyof typeof DOSE_CONTEXT_FIELDS;

/**
 * The keys as a literal tuple, for a caller that needs them in a `const`
 * list of its own (`SOURCE_QUOTE_EVIDENCE_FIELDS`). The assertion below keeps
 * it equal to the object's keys, in order.
 */
export const DOSE_CONTEXT_FIELD_KEYS_TUPLE = [
  'centralValue',
  'centralStatistic',
  'intervalKind',
  'doseValue',
  'doseLow',
  'doseHigh',
  'doseUnit',
  'doseBasis',
  'doseSaltForm',
  'doseRegimen',
  'doseIntervalHours',
  'doseNumber',
  'regimenDurationHours',
  'priorDosingRegular',
  'ivInputMode',
  'administrationDurationMin',
  'releaseProfile',
  'physicalForm',
  'prandialState',
  'administeredDrugId',
  'coadministrationState',
  'interactingDrugId',
  'pkPopulation',
  'populationQualifier',
  'valueBasis',
] as const satisfies readonly DoseContextFieldKey[];

export const DOSE_CONTEXT_FIELD_KEYS: readonly DoseContextFieldKey[] =
  DOSE_CONTEXT_FIELD_KEYS_TUPLE;

/**
 * The reported-statistic fields: what the central number is and what the
 * bounds are. Unlike the rest of the dose context these are meaningful for
 * every numeric source value — a half-life, a Vd or a protein binding is
 * reported as a mean, a median or a single subject just as a Cmax is — so a
 * parameter that forbids dose context still accepts them (optionally).
 */
export const REPORTED_STATISTIC_FIELD_KEYS = [
  'centralValue',
  'centralStatistic',
  'intervalKind',
] as const satisfies readonly DoseContextFieldKey[];

const REPORTED_STATISTIC_FIELDS: ReadonlySet<DoseContextFieldKey> = new Set(
  REPORTED_STATISTIC_FIELD_KEYS,
);

if (
  Object.keys(DOSE_CONTEXT_FIELDS).join() !== DOSE_CONTEXT_FIELD_KEYS_TUPLE.join()
) {
  throw new Error('DOSE_CONTEXT_FIELD_KEYS_TUPLE must list DOSE_CONTEXT_FIELDS in order');
}

/**
 * Every dose-context field stated as null — "this entry has none". For a
 * caller that must PIN the absence (a guarded write matching a row by its
 * evidence), where leaving the keys out would stop them being compared.
 */
export const NO_DOSE_CONTEXT: { readonly [K in DoseContextFieldKey]: null } =
  Object.freeze(
    Object.fromEntries(DOSE_CONTEXT_FIELD_KEYS.map((k) => [k, null])) as {
      [K in DoseContextFieldKey]: null;
    },
  );

/**
 * A stable string for an entry's dose context, for an in-memory duplicate
 * identity (the research importer's reconciliation key). Equal exactly when
 * every field is equal: null and absent both read as "not recorded", and a
 * numeric column's string form (`'2.000000'`) equals the number it stores.
 *
 * `centralValue` is left out: it is the READING, compared with low/high/median
 * by the caller's same-reading test, not part of which observation this is.
 *
 * On a parameter without dose context (`mode: 'forbidden'`) the whole
 * reported statistic is left out for the same reason: there it is only ever a
 * label on the reading, and every row stored before migration 0135 lacks it.
 * Keyed on it, a document re-imported with labels would find no counterpart
 * for the unlabelled row it wrote earlier and insert the paper a second time.
 */
export function doseContextIdentityKey(
  entry: { [K in DoseContextFieldKey]?: unknown },
  mode: DoseContextMode = 'required',
): string {
  return DOSE_CONTEXT_FIELD_KEYS.filter((k) =>
    mode === 'forbidden' ? !REPORTED_STATISTIC_FIELDS.has(k) : k !== 'centralValue',
  )
    .map((k) => {
      const v = entry[k];
      if (v === null || v === undefined) return '';
      if (DOSE_CONTEXT_FIELDS[k] !== 'numeric') return String(v);
      // Rounded to the column's scale, as the stored value is.
      return String(roundToScale(Number(v), storedScaleOf(k)));
    })
    .join('\u0001');
}

/**
 * The scale (digits after the point) of each numeric dose-context column —
 * `numeric(14, 6)` or `numeric(10, 4)`. Postgres rounds a written value to it,
 * so anything COMPARING an incoming value against stored ones has to round the
 * same way, or a retry carrying one digit more than the column keeps misses
 * the row it wrote and is stored twice.
 */
export const DOSE_CONTEXT_NUMERIC_SCALE = {
  centralValue: 6,
  doseValue: 6,
  doseLow: 6,
  doseHigh: 6,
  doseIntervalHours: 4,
  regimenDurationHours: 4,
  administrationDurationMin: 4,
} as const satisfies Partial<Record<DoseContextFieldKey, number>>;

/** A numeric column's scale: its entry above, or 6 for `low`/`high`/`median`. */
export function storedScaleOf(key: string): number {
  return (DOSE_CONTEXT_NUMERIC_SCALE as Record<string, number | undefined>)[key] ?? 6;
}

/** A numeric column's SQL type, for casting a compared value to what is stored. */
export function doseContextNumericType(key: DoseContextFieldKey): string {
  return storedScaleOf(key) === 4 ? 'numeric(10, 4)' : 'numeric(14, 6)';
}

/**
 * `value` rounded to `scale` digits exactly as Postgres rounds it into a
 * `numeric(p, scale)` column: from the decimal text the value is bound as
 * (`String(value)`), half away from zero.
 *
 * Not `toFixed`, which rounds the binary double rather than the decimal text:
 * `(0.0000005).toFixed(6)` is `'0.000000'` where Postgres stores `0.000001`,
 * so a comparison built on it misses the row it is meant to find (Codex P1 on
 * #1360).
 */
export function roundToScale(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value;
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!m) return value;
  const [, sign = '', int = '0', frac = '', exp = '0'] = m;
  let digits = int + frac;
  let point = int.length + Number(exp);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const keep = point + scale;
  if (digits.length <= keep) return value;
  let kept = BigInt(digits.slice(0, keep) || '0');
  if (digits[keep]! >= '5') kept += BigInt(1);
  const text = kept.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale);
  const fraction = scale > 0 ? `.${text.slice(text.length - scale)}` : '';
  return Number(`${sign}${whole}${fraction}`);
}

/** The numeric fields a Cmax entry validates, other than the dose context's own. */
const CORE_NUMERIC_FIELDS = ['low', 'high', 'median'] as const;

/**
 * An entry with every numeric field rounded to its column's scale — the values
 * the write will actually store. Validating these rather than the input keeps
 * a payload with excess digits from passing as one shape and persisting as a
 * forbidden one (`doseLow: 1.0000001, doseHigh: 1.0000002` both store as
 * `1.000000`; a tiny positive dose stores as zero).
 */
function atStoredScale<T extends DoseContextFields & DoseContextCoreFields>(entry: T): T {
  const out: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const key of [...NUMERIC_DOSE_CONTEXT_FIELDS, ...CORE_NUMERIC_FIELDS]) {
    const v = out[key];
    if (typeof v === 'number') out[key] = roundToScale(v, storedScaleOf(key));
  }
  return out as T;
}

/** The fields stored in `numeric` columns, which bind as strings. */
export const NUMERIC_DOSE_CONTEXT_FIELDS: ReadonlySet<DoseContextFieldKey> = new Set(
  DOSE_CONTEXT_FIELD_KEYS.filter((k) => DOSE_CONTEXT_FIELDS[k] === 'numeric'),
);

/**
 * The dose-context values as a caller holds them. Three states per field,
 * like `observationContext`: absent (`undefined`) says nothing, `null` states
 * "not recorded", a value states the value.
 */
export interface DoseContextFields {
  centralValue?: number | null;
  centralStatistic?: CentralStatistic | null;
  intervalKind?: IntervalKind | null;
  doseValue?: number | null;
  doseLow?: number | null;
  doseHigh?: number | null;
  doseUnit?: DoseContextDoseUnit | null;
  doseBasis?: (typeof DOSE_BASES)[number] | null;
  doseSaltForm?: string | null;
  doseRegimen?: DoseRegimen | null;
  doseIntervalHours?: number | null;
  doseNumber?: number | null;
  regimenDurationHours?: number | null;
  priorDosingRegular?: boolean | null;
  ivInputMode?: (typeof IV_INPUT_MODES)[number] | null;
  administrationDurationMin?: number | null;
  releaseProfile?: (typeof RELEASE_PROFILES)[number] | null;
  physicalForm?: (typeof PHYSICAL_FORMS)[number] | null;
  prandialState?: (typeof PRANDIAL_STATES)[number] | null;
  administeredDrugId?: number | null;
  coadministrationState?: (typeof COADMINISTRATION_STATES)[number] | null;
  interactingDrugId?: number | null;
  pkPopulation?: (typeof PK_POPULATIONS)[number] | null;
  populationQualifier?: string | null;
  valueBasis?: ValueBasis | null;
}

// ─── zod shape ──────────────────────────────────────────────────────────────

/** `numeric(14, 6)`: |value| < 1e8. */
const numeric14 = z.number().finite().min(-99_999_999).max(99_999_999);
/** `numeric(10, 4)`: |value| < 1e6. */
const numeric10 = z.number().finite().min(-999_999).max(999_999);
const trimmedText = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((v) => v.trim())
    .refine((v) => v.length <= max, { message: `At most ${max} characters` })
    .transform((v) => (v === '' ? null : v));
const drugRef = z.number().int().positive().max(2_147_483_647);
const vocab = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

/**
 * The zod shape of the dose-context fields, every one `.nullable().optional()`.
 *
 * Spread into every entry schema that parses a payload, because zod STRIPS
 * unknown keys: a schema without these fields would parse a release-C payload
 * into one with no dose context at all, and a release-B approval would then
 * persist the truncated shape (RFC *Migration strategy*, release B).
 */
export const doseContextShape = {
  centralValue: numeric14.nullable().optional(),
  centralStatistic: vocab(CENTRAL_STATISTICS).nullable().optional(),
  intervalKind: vocab(INTERVAL_KINDS).nullable().optional(),
  doseValue: numeric14.nullable().optional(),
  doseLow: numeric14.nullable().optional(),
  doseHigh: numeric14.nullable().optional(),
  doseUnit: vocab(DOSE_CONTEXT_DOSE_UNITS).nullable().optional(),
  doseBasis: vocab(DOSE_BASES).nullable().optional(),
  doseSaltForm: trimmedText(60).nullable().optional(),
  doseRegimen: vocab(DOSE_REGIMENS).nullable().optional(),
  doseIntervalHours: numeric10.nullable().optional(),
  doseNumber: z.number().int().max(2_147_483_647).nullable().optional(),
  regimenDurationHours: numeric10.nullable().optional(),
  priorDosingRegular: z.boolean().nullable().optional(),
  ivInputMode: vocab(IV_INPUT_MODES).nullable().optional(),
  administrationDurationMin: numeric10.nullable().optional(),
  releaseProfile: vocab(RELEASE_PROFILES).nullable().optional(),
  physicalForm: vocab(PHYSICAL_FORMS).nullable().optional(),
  prandialState: vocab(PRANDIAL_STATES).nullable().optional(),
  administeredDrugId: drugRef.nullable().optional(),
  coadministrationState: vocab(COADMINISTRATION_STATES).nullable().optional(),
  interactingDrugId: drugRef.nullable().optional(),
  pkPopulation: vocab(PK_POPULATIONS).nullable().optional(),
  populationQualifier: trimmedText(80).nullable().optional(),
  valueBasis: vocab(VALUE_BASES).nullable().optional(),
} satisfies Record<DoseContextFieldKey, z.ZodTypeAny>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function present<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

/** Does this entry state any dose-context field at all? */
export function hasAnyDoseContext(entry: DoseContextFields): boolean {
  return DOSE_CONTEXT_FIELD_KEYS.some((k) => present(entry[k]));
}

/** Does this entry state any part of its reported statistic? */
export function hasReportedStatistic(entry: DoseContextFields): boolean {
  return REPORTED_STATISTIC_FIELD_KEYS.some((k) => present(entry[k]));
}

/**
 * An entry's central estimate: the labelled `centralValue` when there is one,
 * else the legacy `median` column. Every reader that pools, plots or shows
 * "the number" of a source value goes through this, so a labelled entry is
 * never read as having no centre.
 */
export function entryCentralValue(entry: {
  median?: number | null;
  centralValue?: number | null;
}): number | null {
  return entry.centralValue ?? entry.median ?? null;
}

/**
 * The stored form of an entry's reported statistic (RFC 1a): the `median`
 * shorthand becomes `centralValue` with `centralStatistic: 'median'`, so the
 * same cohort authored either way is ONE row shape — and collides with itself
 * on the duplicate check instead of being counted twice.
 *
 * Applied to an entry that carries a `valueBasis` (every dose-context entry:
 * required there, forbidden everywhere else) or that states any part of the
 * reported statistic — a labelled entry of any parameter. A plain legacy
 * entry (`median` with no label) keeps `median` untouched: its number was
 * "median preferred, mean fallback", and folding it into a `'median'` label
 * would assert what nobody checked. Contradictions (a `median` beside a
 * different `centralValue`, or beside a non-median label) are left in place
 * for `validateDoseContext` to reject, never resolved silently.
 */
export function canonicalizeReportedStatistic<
  T extends DoseContextFields & { median?: number | null },
>(entry: T): T {
  if (!present(entry.median)) return entry;
  if (!present(entry.valueBasis) && !hasReportedStatistic(entry)) return entry;
  if (present(entry.centralValue) && entry.centralValue !== entry.median) return entry;
  if (present(entry.centralStatistic) && entry.centralStatistic !== 'median') return entry;
  return {
    ...entry,
    centralValue: entry.median,
    centralStatistic: 'median',
    median: undefined,
  };
}

/** The fields `validateDoseContext` reads besides the dose context itself. */
export interface DoseContextCoreFields {
  low?: number | null;
  high?: number | null;
  median?: number | null;
  qualifier?: string | null;
  n?: number | null;
  unit?: string | null;
  route?: string | null;
}

/** Stored precision of `numeric(14, 6)`, for the SD/SEM symmetry rule. */
const SYMMETRY_TOLERANCE = 1e-6;

/**
 * Whether low..high is symmetric around `centre`, as an SD/SEM interval must
 * be. Compared in whole ticks of the stored scale, not binary-float
 * differences: the three values are already rounded to six decimals, and
 * 0.200001 − 0.100001 against 0.100001 − 0 is 1e-6 in decimal but a hair over
 * it in floats, which refused a valid half-tick interval (Codex P1 on #1368).
 * One tick of slack absorbs the rounding of an odd-width interval. Shared by
 * the server rule and the editor so the two cannot disagree.
 */
export function isSymmetricInterval(low: number, centre: number, high: number): boolean {
  const tick = (v: number) => Math.round(v / SYMMETRY_TOLERANCE);
  return Math.abs(tick(high) - tick(centre) - (tick(centre) - tick(low))) <= 1;
}

/**
 * The reported statistic's shape rules (RFC 1a): a central value says what it
 * is, an interval says what its bounds are, an SD/SEM is symmetric around the
 * centre it disperses, and the centre lies within its bounds. `input` is the
 * entry as sent, `entry` the same at stored scale.
 *
 * `'required'` is a dose-context parameter, whose reading IS its statistic;
 * `'optional'` every other numeric parameter, where the statistic is checked
 * only as far as it is stated.
 */
function validateReportedStatistic(
  input: DoseContextFields & DoseContextCoreFields,
  entry: DoseContextFields & DoseContextCoreFields,
  mode: 'required' | 'optional',
): string | null {
  const hasBounds = present(entry.low) || present(entry.high);
  if (present(entry.median)) {
    // Compared as SENT, not as stored: `canonicalizeReportedStatistic` folds
    // the median shorthand into `centralValue` only when the two are equal as
    // sent, so two that differ only past the column's scale would pass here
    // rounded, skip the fold, and persist as both (Codex P1 on #1368).
    if (present(input.centralValue) && input.centralValue !== input.median) {
      return 'median and centralValue disagree; state the central value once';
    }
    if (present(entry.centralStatistic) && entry.centralStatistic !== 'median') {
      return `median is shorthand for a median; it cannot label a ${entry.centralStatistic}`;
    }
  }
  if (present(entry.qualifier)) {
    // An optional-statistic parameter keeps ONE censored shape — the legacy
    // low/high/median threshold every such row already has — so a labelled
    // entry is never censored. (Only reached when a statistic is stated.)
    if (mode === 'optional') {
      return 'A censored (qualified) value takes no centralValue, centralStatistic or intervalKind; state its threshold as low/high/median';
    }
    // A censored threshold is not a central estimate and has no interval.
    if (present(entry.centralStatistic) || present(entry.intervalKind)) {
      return 'A censored (qualified) value takes no centralStatistic or intervalKind';
    }
    if (present(entry.median) || hasBounds) {
      return 'A censored (qualified) value is stated as centralValue, without bounds or median';
    }
    if (!present(entry.centralValue)) {
      return 'A censored (qualified) value needs its threshold in centralValue';
    }
  }
  // An interval is two endpoints. One alone — a "range" with only a low —
  // has no defined reading: it is neither the interval its kind names nor a
  // censored threshold (that is `qualifier` + `centralValue`, above).
  //
  // On an optional-statistic parameter a lone bound stays legal (a legacy
  // "≥ 10" reading), but not once it is labelled as an interval.
  if (
    present(entry.low) !== present(entry.high) &&
    (mode === 'required' || present(entry.intervalKind))
  ) {
    return 'An interval needs both low and high';
  }
  // A central value that is not a censored threshold must say what it is:
  // an unlabelled number is exactly the relabelling hazard section 1a exists
  // for. `'unknown'` is a legal answer — the source's silence is storable and
  // refused later, at normalization.
  if (present(entry.centralValue) && !present(entry.qualifier) && !present(entry.centralStatistic)) {
    return 'A central value needs its centralStatistic (use "unknown" if the source does not say)';
  }
  if (present(entry.centralStatistic) && !present(entry.centralValue)) {
    return 'centralStatistic labels a centralValue; there is none';
  }
  // Required only where the statistic is: a legacy entry of an optional
  // parameter states its reading as low/high/median and is checked by
  // `validateEntryValueInvariants`, and its bounds were never labelled.
  if (mode === 'required' && !present(entry.centralValue) && !hasBounds) {
    return 'At least a centralValue or a low/high interval is required';
  }
  // On an optional-statistic parameter too, once the reading states its
  // statistic: a labelled centre beside bounds nobody named (SD? CI? range?)
  // is still half-unlabelled. `'unknown'` answers for a source that does not
  // say. A wholly unlabelled legacy entry never reaches here.
  if (
    (mode === 'required' || present(entry.centralStatistic)) &&
    hasBounds &&
    !present(entry.qualifier) &&
    !present(entry.intervalKind)
  ) {
    return 'An interval needs an intervalKind saying what its bounds are (use "unknown" if the source does not say)';
  }
  if (!hasBounds && present(entry.intervalKind)) {
    return 'intervalKind names bounds that are not there';
  }
  if (entry.intervalKind === 'sd' || entry.intervalKind === 'sem') {
    if (!present(entry.centralValue)) {
      return `An ${entry.intervalKind.toUpperCase()} interval needs the central value it is a dispersion around`;
    }
    if (!present(entry.low) || !present(entry.high)) {
      return `An ${entry.intervalKind.toUpperCase()} interval needs both bounds`;
    }
    if (!isSymmetricInterval(entry.low, entry.centralValue, entry.high)) {
      return `An ${entry.intervalKind.toUpperCase()} interval is symmetric around its centre`;
    }
  }
  if (present(entry.centralValue)) {
    if (present(entry.low) && entry.centralValue < entry.low) {
      return 'centralValue must lie within low..high';
    }
    if (present(entry.high) && entry.centralValue > entry.high) {
      return 'centralValue must lie within low..high';
    }
  }
  if (entry.centralStatistic === 'single_subject' && present(entry.n) && entry.n !== 1) {
    return 'A single-subject value cannot also claim a cohort of n > 1';
  }
  return null;
}

/**
 * The write-time rules for an entry's dose context, given how the parameter
 * relates to it. Returns the first violated rule's message, or null.
 *
 * `'forbidden'` (every parameter today but the dose-context ones): no dose
 * field may carry a value, and the reported statistic is optional — held to
 * the same shape rules as a Cmax's when stated, but never required, because
 * every entry written before it existed has none. `'required'` (Cmax): the
 * RFC's *Validation invariants* and the storage column of *Required to store
 * is not required to normalize*.
 * Expects the entry already through `canonicalizeReportedStatistic`.
 */
export function validateDoseContext(
  parameter: string,
  mode: DoseContextMode,
  input: DoseContextFields & DoseContextCoreFields,
): string | null {
  if (mode === 'forbidden') {
    const stray = DOSE_CONTEXT_FIELD_KEYS.find(
      (k) => !REPORTED_STATISTIC_FIELDS.has(k) && present(input[k]),
    );
    if (stray) return `${parameter} takes no dose context; "${stray}" must not be set`;
    if (!hasReportedStatistic(input)) return null;
    return validateReportedStatistic(input, atStoredScale(input), 'optional');
  }
  const entry = atStoredScale(input);
  const statisticMessage = validateReportedStatistic(input, entry, 'required');
  if (statisticMessage) return statisticMessage;

  // ── What the number is ──
  if (!present(entry.valueBasis)) {
    return 'valueBasis is required: say whether the value is a concentration or a dose-normalized ratio';
  }
  const unit = entry.unit ?? '';
  if (entry.valueBasis === 'concentration') {
    if (!(CMAX_CONCENTRATION_UNITS as readonly string[]).includes(unit)) {
      return `A concentration needs a concentration unit, not "${unit}"`;
    }
  } else if (!DOSE_NORMALIZED_UNITS.includes(unit)) {
    return `A dose-normalized value needs a concentration-per-dose unit such as µmol/L/mg, not "${unit}"`;
  }

  // ── The dose ──
  const hasExact = present(entry.doseValue);
  const hasLow = present(entry.doseLow);
  const hasHigh = present(entry.doseHigh);
  if (hasLow !== hasHigh) {
    return 'A dose range needs both doseLow and doseHigh';
  }
  if (hasExact && hasLow) {
    return 'State either an exact doseValue or a doseLow–doseHigh range, not both';
  }
  for (const d of [entry.doseValue, entry.doseLow, entry.doseHigh]) {
    if (present(d) && !(d > 0)) return 'Dose values must be positive';
  }
  if (hasLow && hasHigh) {
    if (entry.doseLow! === entry.doseHigh!) {
      return 'A dose range with equal ends is one dose; state it as doseValue';
    }
    if (entry.doseLow! > entry.doseHigh!) return 'doseLow cannot be greater than doseHigh';
  }
  const hasDose = hasExact || hasLow;
  if (hasDose && !present(entry.doseUnit)) {
    return 'A dose needs a doseUnit';
  }
  if (entry.valueBasis === 'concentration' && !hasDose) {
    return 'A concentration Cmax needs the dose it followed (doseValue or a dose range)';
  }
  if (entry.valueBasis === 'dose_normalized' && present(entry.doseUnit)) {
    const denominator = doseNormalizedDenominator(unit);
    if (denominator && doseUnitFamily(denominator) !== doseUnitFamily(entry.doseUnit)) {
      return `The ratio's unit (${unit}) and the dose unit (${entry.doseUnit}) are in different dose families`;
    }
  }
  if (present(entry.doseSaltForm) && entry.doseBasis !== 'salt') {
    return 'doseSaltForm is only meaningful with doseBasis "salt"';
  }

  // ── Regimen ──
  const regimen = entry.doseRegimen;
  if (present(entry.doseIntervalHours)) {
    if (!(entry.doseIntervalHours > 0)) return 'doseIntervalHours must be positive';
    if (regimen === 'single') return 'A single dose has no dosing interval';
  }
  if (present(entry.doseNumber)) {
    if (entry.doseNumber < 1) return 'doseNumber counts from 1';
    if (regimen !== 'multiple') return 'doseNumber is meaningful only for a "multiple" regimen';
  }
  if (present(entry.regimenDurationHours)) {
    if (entry.regimenDurationHours < 0) return 'regimenDurationHours cannot be negative';
    if (regimen !== 'multiple') {
      return 'regimenDurationHours is meaningful only for a "multiple" regimen';
    }
  }
  if (
    present(entry.priorDosingRegular) &&
    regimen !== 'multiple' &&
    regimen !== 'steady_state'
  ) {
    return 'priorDosingRegular is meaningful only for a "multiple" or "steady_state" regimen';
  }

  // ── Administration ──
  if (present(entry.ivInputMode) && present(entry.route) && entry.route !== 'iv') {
    return 'ivInputMode applies to intravenous administration only';
  }
  if (entry.ivInputMode === 'infusion' && !present(entry.administrationDurationMin)) {
    return 'An infusion needs its duration (administrationDurationMin)';
  }
  if (present(entry.administrationDurationMin)) {
    if (!(entry.administrationDurationMin > 0)) {
      return 'administrationDurationMin must be positive';
    }
    if (entry.ivInputMode !== 'infusion') {
      return 'administrationDurationMin is only meaningful for an infusion';
    }
  }

  // ── Who was dosed, with what, in whom ──
  if (mode === 'required' && !present(entry.administeredDrugId)) {
    return 'administeredDrugId is required: name the substance that was dosed (the entry\'s own drug when it was given directly)';
  }
  if (
    present(entry.interactingDrugId) &&
    entry.coadministrationState !== 'with_interacting_drug'
  ) {
    return 'interactingDrugId is only meaningful with coadministrationState "with_interacting_drug"';
  }
  if (
    present(entry.populationQualifier) &&
    (!present(entry.pkPopulation) || entry.pkPopulation === 'healthy_adult')
  ) {
    return 'populationQualifier qualifies a non-healthy-adult pkPopulation';
  }
  return null;
}
