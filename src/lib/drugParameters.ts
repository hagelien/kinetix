import { z } from 'zod';
import { QUALIFIER_OPERATORS, type NumericRange } from '../types/index.js';
import { formatRange } from './rangeUtils.js';
import {
  CMAX_CONCENTRATION_UNITS,
  DOSE_NORMALIZED_UNITS,
  type DoseContextMode,
} from './entryDoseContext.js';
import { convertLinearUnit } from './unitFamilies.js';
import {
  DISPOSITION_KINDS,
  ELIMINATION_KINDS,
  ABSORPTION_KINDS,
} from './kinetics-core/index.js';

// ─── Parameter groups (#302) ────────────────────────────────────────────────
//
// Numeric/tabular parameters in monograph sidebars are grouped into the
// six categories specified in #302. Order here is the rendering order in
// the sidebar; metadata (names, aliases, pubchem id) is handled
// separately and is not part of this grouping.

export const PARAMETER_GROUP_IDS = [
  'chemistry',
  'pharmacodynamics',
  'pharmacokinetics',
  'dose_exposure',
  'interpretive_concentrations',
  'analytics_detection',
  'postmortem',
] as const;

export type ParameterGroupId = (typeof PARAMETER_GROUP_IDS)[number];

interface ParameterGroupDef {
  id: ParameterGroupId;
  /** i18n key under `parameterGroups.*` for the section heading. */
  i18nKey: string;
}

export const PARAMETER_GROUPS: readonly ParameterGroupDef[] = [
  { id: 'chemistry', i18nKey: 'parameterGroups.chemistry' },
  { id: 'pharmacodynamics', i18nKey: 'parameterGroups.pharmacodynamics' },
  { id: 'pharmacokinetics', i18nKey: 'parameterGroups.pharmacokinetics' },
  { id: 'dose_exposure', i18nKey: 'parameterGroups.doseExposure' },
  {
    id: 'interpretive_concentrations',
    i18nKey: 'parameterGroups.interpretiveConcentrations',
  },
  { id: 'analytics_detection', i18nKey: 'parameterGroups.analyticsDetection' },
  { id: 'postmortem', i18nKey: 'parameterGroups.postmortem' },
];

export function isParameterGroupId(id: string): id is ParameterGroupId {
  return (PARAMETER_GROUP_IDS as readonly string[]).includes(id);
}

// ─── Parameter identifiers ──────────────────────────────────────────────────

export const DRUG_PARAMETER_IDS = [
  // PK/PD parameters (NumericRange)
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  // Peak concentration as a dose-contextualized source measurement (Cmax
  // dose-context RFC). Entry-backed with no drug-level value; authoring is
  // gated until release C (`DOSE_CONTEXT_AUTHORING_OPEN`).
  'cmax',
  'pKa',
  // Editable drug metadata (text + number + list)
  'nameNb',
  'nameEn',
  'nameShort',
  'aliases',
  'molecularWeight',
  'pubchemCid',
  // #302 P3 — additional grouped parameters from #276's list.
  // Chemistry
  'logP',
  'logD',
  // Pharmacodynamics is no longer a drug-level parameter group: the drug's
  // mechanism of action is modelled as ranked (primary/secondary/tertiary)
  // receptor-target relationships on `drug_receptor_targets`, surfaced in the
  // monograph's pharmacodynamics box, rather than as flat numeric parameters.
  // Pharmacokinetics
  'clearance',
  // First-order absorption rate constant (CV-2c): route-specific and
  // reviewer-authored — a drug absorbs at a different rate intranasally than
  // orally — so it is stored per administration route (`routeScoped`), not as a
  // drug-level value. The catalog's `tmax` cannot supply it (see modelDerivation).
  'ka',
  // Saturable (Michaelis–Menten) elimination: the maximum elimination rate and
  // the concentration at which it runs at half that rate. Molecule-level, so
  // they pool across sources like the half-life; the auto-built model runs the
  // saturable family only when a drug declares it AND both are present.
  'vmax',
  'km',
  'postmortemRedistribution',
  'pmAmRatio',
  // Model structure (CV-1b): the drug's PK model shape, as cited pick-from-a-list
  // declarations the engine composes into a model family. Categorical, not numeric.
  'dispositionModel',
  'eliminationModel',
  'absorptionModel',
  // Dose & exposure
  'therapeuticDose',
  'maxRecommendedDose',
  'nonMedicalDose',
  'overdoseDose',
  'fatalDose',
  // Interpretive concentrations
  'therapeuticConcentration',
  'supratherapeuticConcentration',
  'impairmentConcentration',
  'toxicConcentration',
  'fatalConcentration',
  // Analytics & detection
  // `loq`/`lod` are retired: an analytical limit is a
  // property of a validated method in a named laboratory, not of the
  // substance, so there is no drug-level value to hold. The real numbers are
  // already carried per analyte per method on `analytical_method_components`
  // (`lor`/`mkk`) and are surfaced in the monograph's analytics box.
  'bloodDetectionWindow',
  'oralFluidDetectionWindow',
  'urineDetectionWindow',
  'analyteStability',
] as const;

export type DrugParameterId = (typeof DRUG_PARAMETER_IDS)[number];

export type ParameterKind =
  | 'range'
  | 'fraction'
  | 'ratio'
  | 'scalar'
  | 'struct'
  | 'text'
  | 'number'
  | 'list'
  | 'enum';

/** Subset of kinds whose value is a NumericRange. */
const RANGE_KINDS = ['range', 'fraction', 'ratio', 'scalar'] as const;
type RangeKind = (typeof RANGE_KINDS)[number];

export function isRangeKind(kind: ParameterKind): kind is RangeKind {
  return (RANGE_KINDS as readonly string[]).includes(kind);
}

// ─── Zod helpers ────────────────────────────────────────────────────────────

/**
 * Build a zod schema for a RangeData-shaped parameter, bounded and
 * constrained to an allowedUnits list. min/max inclusive, and either
 * {min,max} or {value} is required.
 *
 * The bounds are stated in the parameter's CANONICAL unit, so the value is
 * canonicalized before they are applied. Comparing the number as typed lets a
 * unit denser than the canonical one through at its own scale: a clearance of
 * 99 999 `L/min` is 6 000 000 L/h, sixty times over a bound that reads
 * `0 – 100 000`. That stayed invisible while every clearance unit happened to be
 * no denser than `L/h`, which made the raw check accidentally the stricter one;
 * it stops being true the moment a unit like `L/min` or `g` is accepted. Entry
 * validation already canonicalizes (`validateEntryForParameter`), and this is
 * the same guarantee for the drug-level value that `deepResearchImport`,
 * `seed-drugs` and the parameter PUT write.
 *
 * Only factor-only families convert here. A concentration in `µmol/L` needs a
 * molecular weight, which is a property of the drug and not of the registry, so
 * those keep the raw check — as does any unit the linear table does not
 * describe (`mg/kg`, `mg/day`). Falling back to the raw number is the
 * conservative direction: it is the bound that has always applied.
 */
function rangeSchema(opts: {
  min: number;
  max: number;
  allowedUnits: readonly string[];
  requiresMinMax?: boolean;
}): z.ZodType<NumericRange> {
  // Empty allowedUnits means the parameter is dimensionless (e.g. pKa);
  // any explicit unit string is invalid, not "free text".
  const unitSchema = opts.allowedUnits.length
    ? z.enum(opts.allowedUnits as [string, ...string[]])
    : z.undefined();
  // The canonical unit leads every allow-list, and `canonicalUnitLeadsAllowedUnits`
  // in the registry test holds the two in step, so it needs no second parameter
  // here — one that 26 call sites could each get wrong on their own.
  const canonicalUnit = opts.allowedUnits[0] ?? '';
  // Bounds are applied by `boundsCheck` below, against the canonicalized value.
  const numberInBounds = z.number().finite();

  const VALUE_FIELDS = ['min', 'max', 'mean', 'median'] as const;

  const boundsCheck = (
    v: Partial<Record<(typeof VALUE_FIELDS)[number], number> & { unit: string }>,
    ctx: z.RefinementCtx,
  ): void => {
    const unit = v.unit ?? canonicalUnit;
    for (const field of VALUE_FIELDS) {
      const raw = v[field];
      if (typeof raw !== 'number') continue;
      const canonical = convertLinearUnit(raw, unit, canonicalUnit) ?? raw;
      if (canonical < opts.min || canonical > opts.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Value ${raw}${unit ? ` ${unit}` : ''} is outside the allowed range (${opts.min}–${opts.max}${canonicalUnit ? ` ${canonicalUnit}` : ''})`,
        });
      }
    }
  };

  const base = z
    .object({
      min: numberInBounds.optional(),
      max: numberInBounds.optional(),
      // `value` was split into `mean` + `median` (#numeric-params). The
      // legacy single value was migrated into `median`.
      mean: numberInBounds.optional(),
      median: numberInBounds.optional(),
      unit: unitSchema.optional(),
      // Numeric pharmacology data stays numeric: a qualifier is a
      // comparison operator for one-sided bounds, never a free-text
      // route/population label (those belong in `note`). Rejecting
      // arbitrary strings here is what stops values like "voksen po"
      // from being stored and then shadowing the real min–max range.
      qualifier: z.enum(QUALIFIER_OPERATORS as unknown as [string, ...string[]]).optional(),
      note: z.string().max(500).optional(),
    })
    .refine(
      (v) =>
        v.min !== undefined ||
        v.max !== undefined ||
        v.mean !== undefined ||
        v.median !== undefined,
      { message: 'At least one of min, max, mean, or median is required' },
    )
    .refine(
      (v) =>
        !(
          typeof v.min === 'number' &&
          typeof v.max === 'number' &&
          v.min > v.max
        ),
      { message: 'min cannot be greater than max' },
    )
    .superRefine(boundsCheck);

  if (opts.requiresMinMax) {
    return base.refine(
      (v) => typeof v.min === 'number' && typeof v.max === 'number',
      { message: 'Both min and max are required for this parameter' },
    ) as unknown as z.ZodType<NumericRange>;
  }
  return base as unknown as z.ZodType<NumericRange>;
}

// ─── Parameter spec shape ───────────────────────────────────────────────────

interface BaseParameterSpec {
  id: DrugParameterId;
  label: string;
  longLabel: string;
  /**
   * Conventional scientific symbol/abbreviation for the parameter (e.g.
   * `t½` for elimination half-life, `Vd` for volume of distribution).
   * Rendered as a prefix in front of the value in monograph surfaces so
   * a glance at the number tells you which quantity it is. Language-
   * independent notation — like the unit strings, it is not translated.
   * Omitted for parameters that have no widely-recognised symbol (most
   * dose/concentration ranges, detection windows, free-text metadata).
   * For Nordic/Northern-European usage the most common variant is chosen
   * (e.g. `t½` rather than `t1/2`).
   */
  symbol?: string;
  /**
   * Sidebar group this parameter belongs to (#302). `null` means the
   * parameter is metadata (drug names, aliases, pubchem id) handled
   * outside the grouped sidebar — e.g. the page title and admin row.
   */
  group: ParameterGroupId | null;
  /** Columns hidden until a dedicated forensic module ships */
  forensic: boolean;
  /**
   * Whether this parameter's value is specific to an ADMINISTRATION ROUTE rather
   * than the drug as a whole (CV-2c) — the first-order absorption rate `ka` (and,
   * later, a route-specific bioavailability) differ by route. A route-scoped
   * parameter has NO single drug-level value: it is stored per route in
   * `parameter_entries` (keyed by the `route` column) and read by the per-route
   * derivation, so it is excluded from the drug-level surfaces (the Drug Table
   * column set, the generic drug-value pickers, the grouped monograph sidebar) and
   * rendered only in the per-route editor section. Absent/false is an ordinary
   * drug-level parameter.
   */
  routeScoped?: boolean;
  /**
   * Whether this parameter's value MAY be scoped to an administration route, without
   * requiring it (CV-2c-4). Unlike `routeScoped` (route REQUIRED, no drug-level value —
   * `ka`), a route-optional parameter keeps its ordinary drug-level meaning AND accepts
   * additional per-route entries: absorption shape and bioavailability are genuinely
   * per-route (a drug absorbs differently intranasally vs orally), but a drug-level
   * declaration is still valid where a route was never specified. So a route-optional
   * parameter is NOT excluded from the drug-level surfaces the way a route-scoped one is;
   * the route is simply permitted on its `parameter_entries` rows. Absent/false forbids a
   * route entirely (an ordinary drug-level parameter).
   */
  routeOptional?: boolean;
  /**
   * Whether the biological matrix (serum / plasma / whole blood / …) is a
   * meaningful dimension of this parameter's value. True for concentration
   * quantities whose number changes with the sampled matrix (interpretive
   * concentrations, LOQ/LOD); false/absent for matrix-independent quantities
   * (half-life, Vd, pKa). Drives whether a per-source `parameter_entries` row
   * must carry a `matrix`. See `parameter_entries` (multi-value store).
   */
  matrixRelevant?: boolean;
  /**
   * Whether the interpretive `scenario` (living therapeutic / postmortem mono
   * intoxication / …) is a meaningful dimension of a per-source entry. True only
   * for the interpretive concentration parameters, whose value means nothing
   * without the population it was observed in. False/absent for parameters whose
   * between-source spread is measurement/population variance rather than an
   * interpretive context (half-life, logP, B/P, protein binding, …) — those
   * record their context in the entry's free-text `comments`.
   */
  scenarioRelevant?: boolean;
  /**
   * Whether the parameter's values are THEMSELVES on a logarithmic scale — logP,
   * logD and pKa are logarithms of a partition coefficient / dissociation
   * constant. Plotting them on a log axis would apply a second log transform and
   * squash the real spread between sources, so their charts stay linear no
   * matter how many decades the underlying quantity spans.
   */
  alreadyLogarithmic?: boolean;
  /**
   * Whether this parameter's single displayed value is derived by aggregating
   * one-or-more per-source entries in `parameter_entries` (weighted median +
   * IQR, matrix-normalized) rather than being hand-authored. The `drug_parameters`
   * row for a summarizable parameter is a recomputed cache of that aggregate.
   */
  summarizable?: boolean;
  /**
   * Whether the quantity needs a dose **of this substance** to be defined at
   * all.
   *
   * That is a narrower test than "describes absorption", and the difference
   * decides real data. Absolute bioavailability is a ratio against an
   * intravenous reference dose *of the same compound*: for a metabolite formed
   * in vivo nobody has ever given that reference dose, so F has no referent and
   * no literature search will ever find one. The dose parameters are the dose
   * itself, so likewise. `src/lib/parameterApplicability.ts` turns this flag
   * plus the drug's `substanceClass` into the applicability rule that keeps
   * such pairs out of the maintenance agent's gap queue.
   *
   * **Tmax deliberately does not carry this flag**, although it reads like it
   * should. A metabolite's time to peak is measured after the *parent* is
   * dosed, and it is a routine published endpoint — cocaine studies report
   * benzoylecgonine's tmax, heroin studies 6-MAM's, nicotine studies
   * cotinine's. Flagging it made all that valid data unwritable and hid the
   * gaps, which is strictly worse than serving a gap that turns out to be
   * fillable. "Some dose, somewhere upstream" is enough for tmax; only
   * bioavailability and the dose ranges need the dose to be of this substance.
   *
   * False/absent for quantities that stay meaningful however the substance got
   * into the body: half-life, Vd, clearance, protein binding, B/P ratio, tmax,
   * the chemistry constants, the interpretive concentrations, detection
   * windows.
   */
  requiresAdministration?: boolean;
  /**
   * Whether a source entry for this parameter carries structured dose context
   * (dose, regimen, formulation, population, reported statistic, …) — the
   * Cmax dose-context RFC, docs/plans/2026-09-17-cmax-dose-context.md.
   * `'required'` makes the context part of what the entry IS, with the write
   * rules in `validateDoseContext` (src/lib/entryDoseContext.ts); `'forbidden'`
   * (the default, absent) rejects every dose field but leaves the reported
   * statistic (`centralValue` / `centralStatistic` / `intervalKind`) optional,
   * because what a number IS (mean, median, …) is not dose context.
   */
  doseContext?: DoseContextMode;
  /**
   * Whether the parameter's value lives ONLY as cited `parameter_entries`
   * rows, with no drug-level value of any kind — neither authored nor a
   * summarized cache. Set for Cmax, whose source entries are concentrations
   * while its useful headline is dose-normalized, so an ordinary aggregate in
   * `drug_parameters` would mix two dimensions (RFC *Registry contract*). An
   * entry-only parameter is edited through `/api/parameter-entries` and is
   * absent from every drug-level surface (`parameterHasDrugLevelValue`).
   */
  entryBacked?: boolean;
  /**
   * Context that must be known before an entry may be normalized or pooled
   * (RFC *Registry contract*). What satisfies each requirement is the
   * parameter's own contract, answered by its normalizer — not a null check.
   */
  normalizationRequires?: readonly NormalizationRequirement[];
  format: (value: unknown) => string;
}

/** A dimension an entry must resolve before it can be normalized or pooled. */
export type NormalizationRequirement =
  | 'route'
  | 'dose'
  | 'matrix'
  | 'iv_input'
  | 'formulation'
  | 'prandial'
  | 'regimen'
  | 'coadministration'
  | 'population'
  | 'dose_basis'
  | 'statistic';

export interface RangeParameterSpec extends BaseParameterSpec {
  kind: RangeKind | 'struct';
  allowedUnits: readonly string[];
  canonicalUnit: string;
  bounds: { min: number; max: number };
  requiresMinMax: boolean;
  zod: z.ZodType<NumericRange>;
}

export interface TextParameterSpec extends BaseParameterSpec {
  kind: 'text';
  /** Hard upper bound from the database column. */
  maxLength: number;
  /** When true, an empty string is rejected at validation time. */
  required: boolean;
  zod: z.ZodType<string>;
}

export interface NumberParameterSpec extends BaseParameterSpec {
  kind: 'number';
  bounds: { min: number; max: number };
  /** When true, only integer values are allowed. */
  isInteger: boolean;
  /** When true, the approval handler must guard against UNIQUE violations. */
  unique: boolean;
  /**
   * When true, the parameter may be cleared back to `null`. The edit
   * form treats an empty input as "set to null"; the API/zod accept
   * null and the column is set to NULL on the drug row. Use for
   * optional fields where a known-bad value is worse than no value
   * (e.g. molecularWeight pulled from a noisy upstream source).
   */
  nullable: boolean;
  /** Display unit appended to the formatted value (e.g. "g/mol"). Empty for none. */
  unitLabel: string;
  zod: z.ZodType<number | null>;
}

export interface ListParameterSpec extends BaseParameterSpec {
  kind: 'list';
  /** Maximum allowed entries; entries beyond this length are rejected. */
  maxItems: number;
  /** Maximum length of any single entry. */
  maxItemLength: number;
  zod: z.ZodType<string[]>;
}

export interface EnumParameterSpec extends BaseParameterSpec {
  kind: 'enum';
  /** The pick-from-a-list vocabulary — the kinetics-core model-structure axis
   * values, so a stored declaration is always one the engine understands. */
  allowedValues: readonly string[];
  zod: z.ZodType<string>;
}

export type ParameterSpec =
  | RangeParameterSpec
  | TextParameterSpec
  | NumberParameterSpec
  | ListParameterSpec
  | EnumParameterSpec;

function rangeFormatter(value: unknown): string {
  if (value === null || value === undefined) return '';
  return formatRange(value as NumericRange);
}

function textFormatter(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function numberFormatter(unitLabel: string): (value: unknown) => string {
  return (value: unknown) => {
    if (value === null || value === undefined || value === '') return '';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '';
    return unitLabel ? `${n} ${unitLabel}` : String(n);
  };
}

function listFormatter(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((v): v is string => typeof v === 'string' && !!v).join(', ');
}

// ─── Shared unit sets for grouped parameters (#302 P3) ─────────────────────
// These are the unit families parameters across pharmacodynamics, dose &
// exposure, and interpretive concentrations share. Listing them here
// keeps the registry below readable and lets future parameters opt in
// without restating the same allow-list.

const CONCENTRATION_UNITS = [
  'mg/L', 'µg/mL', 'ng/mL', 'µg/L', 'ng/L', 'mg/dL',
  'mmol/L', 'µmol/L', 'nmol/L',
] as const;

const DOSE_UNITS = [
  'mg', 'g', 'µg',
  'mg/kg',
  'mg/day', 'mg/kg/day',
] as const;

// Absolute clearance first (canonical leading), then the weight-normalized
// family. `L/min` is included because the classic PK literature reports a rapidly
// cleared drug that way — cocaine's systemic clearance is stated as ~2 L/min far
// more often than as 120 L/h — and a unit missing here is not a rejected import
// but a silently dropped reading, leaving the parameter to aggregate from
// whichever papers happened to use an hour. `L/min/kg` is deliberately absent:
// weight-normalized clearance is reported per minute in mL, never in litres.
const CLEARANCE_UNITS = ['L/h', 'L/min', 'mL/min', 'L/h/kg', 'mL/min/kg'] as const;

// Saturable elimination. Vmax is the concentration fall per hour at saturation
// (canonical mg/L/h, the engine's unit); Km the concentration at which
// elimination runs at half that rate (canonical mg/L). Km takes every
// concentration unit, as the entry path does for any concentration: a molar Km
// converts with the drug's molecular weight, and stays out of the model when the
// drug has none recorded.
const VMAX_UNITS = ['mg/L/h', 'µg/mL/h', 'mg/dL/h', 'g/L/h', 'mg/L/min'] as const;

// ─── Registry ───────────────────────────────────────────────────────────────

export const DRUG_PARAMETERS: Record<DrugParameterId, ParameterSpec> = {
  halfLife: {
    id: 'halfLife',
    label: 'Half-life',
    longLabel: 'Elimination half-life',
    symbol: 't½',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: ['h'],
    canonicalUnit: 'h',
    bounds: { min: 0, max: 10000 },
    requiresMinMax: true,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({
      min: 0,
      max: 10000,
      allowedUnits: ['h'],
      requiresMinMax: true,
    }),
    format: rangeFormatter,
  },
  volumeOfDistribution: {
    id: 'volumeOfDistribution',
    label: 'Vd',
    longLabel: 'Volume of distribution',
    symbol: 'Vd',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: ['L/kg'],
    canonicalUnit: 'L/kg',
    bounds: { min: 0.01, max: 1000 },
    requiresMinMax: true,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({
      min: 0.01,
      max: 1000,
      allowedUnits: ['L/kg'],
      requiresMinMax: true,
    }),
    format: rangeFormatter,
  },
  bioavailability: {
    id: 'bioavailability',
    label: 'F',
    // Route-neutral: F is route-optional (CV-2c-4), so the selected administration route qualifies it
    // (a per-route F may be intranasal/IM/rectal/…, not only oral).
    longLabel: 'Bioavailability',
    symbol: 'F',
    kind: 'fraction',
    group: 'pharmacokinetics',
    allowedUnits: ['fraction'],
    canonicalUnit: 'fraction',
    bounds: { min: 0, max: 1 },
    requiresMinMax: true,
    forensic: false,
    summarizable: true,
    // F is genuinely per-route (a drug's intranasal F ≠ its oral F), so an entry MAY carry a route
    // (CV-2c-4). Unlike a route-scoped parameter it keeps a meaningful drug-level value: the drug-level
    // aggregate pools only the route-less entries (see loadEntryValuesForParameter), and the per-route
    // derivation reads the route-specific ones — so a route-specific F never mixes into the drug-level F.
    routeOptional: true,
    requiresAdministration: true,
    zod: rangeSchema({
      min: 0,
      max: 1,
      allowedUnits: ['fraction'],
      requiresMinMax: true,
    }),
    format: rangeFormatter,
  },
  proteinBinding: {
    id: 'proteinBinding',
    label: 'Fb',
    longLabel: 'Plasma protein binding',
    symbol: 'PPB',
    kind: 'fraction',
    group: 'pharmacokinetics',
    allowedUnits: ['fraction'],
    canonicalUnit: 'fraction',
    bounds: { min: 0, max: 1 },
    requiresMinMax: true,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({
      min: 0,
      max: 1,
      allowedUnits: ['fraction'],
      requiresMinMax: true,
    }),
    format: rangeFormatter,
  },
  bloodPlasmaRatio: {
    id: 'bloodPlasmaRatio',
    label: 'B/P',
    longLabel: 'Blood-to-plasma ratio',
    symbol: 'B/P',
    kind: 'ratio',
    group: 'pharmacokinetics',
    allowedUnits: ['ratio'],
    canonicalUnit: 'ratio',
    bounds: { min: 0, max: 100 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({
      min: 0,
      max: 100,
      allowedUnits: ['ratio'],
      requiresMinMax: false,
    }),
    format: rangeFormatter,
  },
  // Time to peak is a per-ROUTE observable — an oral Tmax and an insufflated one
  // describe different absorption phases of the same molecule — so it is
  // `routeOptional` on the same terms as `absorptionModel` and `bioavailability`:
  // a route-scoped entry states the Tmax for that route, and a route-less one
  // stays valid as the drug's overall figure. A route-scoped Tmax is what lets the
  // per-route derivation solve `ka` (`kinetics-core/ka-inference.ts`) for the
  // extravascular routes, which have no catalog `ka` of their own.
  tmax: {
    id: 'tmax',
    label: 'Tmax',
    longLabel: 'Time to peak concentration',
    symbol: 'Tmax',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: ['h'],
    canonicalUnit: 'h',
    bounds: { min: 0, max: 240 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    routeOptional: true,
    zod: rangeSchema({
      min: 0,
      max: 240,
      allowedUnits: ['h'],
      requiresMinMax: false,
    }),
    format: rangeFormatter,
  },
  // Cmax dose-context RFC (docs/plans/2026-09-17-cmax-dose-context.md). A raw
  // peak concentration means nothing without the dose, regimen, formulation,
  // population and statistic it was reported under, so every source entry
  // carries that context (`doseContext: 'required'`) and there is no
  // drug-level value: the headline is a dose-normalized summary computed from
  // the entries (a later release), never a cached concentration.
  // `routeOptional`, not required: a route-less reading is storable evidence,
  // excluded from normalization by `normalizationRequires`.
  cmax: {
    id: 'cmax',
    label: 'Cmax',
    longLabel: 'Peak concentration',
    symbol: 'Cmax',
    kind: 'range',
    group: 'dose_exposure',
    allowedUnits: [...CMAX_CONCENTRATION_UNITS, ...DOSE_NORMALIZED_UNITS],
    canonicalUnit: 'mg/L',
    // Checked in the canonical unit where one converts (a concentration);
    // a dose-normalized ratio has no conversion to mg/L and is checked raw.
    bounds: { min: 0, max: 100_000 },
    requiresMinMax: false,
    forensic: false,
    matrixRelevant: true,
    routeOptional: true,
    summarizable: false,
    entryBacked: true,
    doseContext: 'required',
    normalizationRequires: [
      'route',
      'dose',
      'matrix',
      'iv_input',
      'formulation',
      'prandial',
      'regimen',
      'coadministration',
      'population',
      'dose_basis',
      'statistic',
    ],
    zod: rangeSchema({
      min: 0,
      max: 100_000,
      allowedUnits: [...CMAX_CONCENTRATION_UNITS],
      requiresMinMax: false,
    }),
    format: rangeFormatter,
  },
  pKa: {
    id: 'pKa',
    label: 'pKa',
    longLabel: 'Acid dissociation constant',
    symbol: 'pKa',
    kind: 'scalar',
    group: 'chemistry',
    allowedUnits: [],
    canonicalUnit: '',
    bounds: { min: -10, max: 20 },
    requiresMinMax: false,
    forensic: false,
    alreadyLogarithmic: true,
    summarizable: true,
    zod: rangeSchema({
      min: -10,
      max: 20,
      allowedUnits: [],
      requiresMinMax: false,
    }),
    format: rangeFormatter,
  },

  // ── Editable drug metadata ───────────────────────────────────────────────

  nameNb: {
    id: 'nameNb',
    label: 'Name (NO)',
    longLabel: 'Norwegian name',
    kind: 'text',
    group: null,
    maxLength: 300,
    // At least one language name must exist on the drug, but Norwegian
    // specifically may be cleared if another language is set. Required-state
    // is enforced at the API boundary against the resulting `names` jsonb,
    // not at the per-language field level.
    required: false,
    forensic: false,
    zod: z.string().trim().max(300),
    format: textFormatter,
  },
  nameEn: {
    id: 'nameEn',
    label: 'Name (EN)',
    longLabel: 'English name',
    kind: 'text',
    group: null,
    maxLength: 300,
    required: false,
    forensic: false,
    zod: z.string().trim().max(300),
    format: textFormatter,
  },
  nameShort: {
    id: 'nameShort',
    label: 'Short name',
    longLabel: 'Short name',
    kind: 'text',
    group: null,
    maxLength: 50,
    required: false,
    forensic: false,
    // Coerce undefined → '' so reviewers can clear an optional field. Empty
    // string is normalised to NULL at the approval boundary.
    zod: z.string().trim().max(50),
    format: textFormatter,
  },
  aliases: {
    id: 'aliases',
    label: 'Aliases',
    longLabel: 'Aliases (literature variants, brand and street names)',
    kind: 'list',
    group: null,
    maxItems: 50,
    maxItemLength: 200,
    forensic: false,
    zod: z
      .array(z.string().trim().min(1).max(200))
      .max(50),
    format: listFormatter,
  },
  molecularWeight: {
    id: 'molecularWeight',
    label: 'MW',
    longLabel: 'Molecular weight',
    symbol: 'Mw',
    kind: 'number',
    group: 'chemistry',
    bounds: { min: 0.0001, max: 100_000 },
    isInteger: false,
    unique: false,
    // The drugs.molecular_weight column is nullable, and the value can
    // be wrong on first import (#302 grouped MW into the sidebar where
    // contributors will notice). Allow clearing back to NULL via the
    // standard edit flow rather than only by direct DB write.
    nullable: true,
    unitLabel: 'g/mol',
    forensic: false,
    zod: z.number().positive().max(100_000).nullable(),
    format: numberFormatter('g/mol'),
  },
  pubchemCid: {
    id: 'pubchemCid',
    label: 'PubChem CID',
    longLabel: 'PubChem Compound ID',
    kind: 'number',
    group: null,
    bounds: { min: 1, max: 999_999_999 },
    isInteger: true,
    unique: true,
    nullable: false,
    unitLabel: '',
    forensic: false,
    zod: z.number().int().positive().max(999_999_999),
    format: numberFormatter(''),
  },

  // ── #302 P3 — Chemistry & matrix conversion ──────────────────────────────

  logP: {
    id: 'logP',
    label: 'logP',
    longLabel: 'Lipophilicity (logP)',
    symbol: 'logP',
    kind: 'scalar',
    group: 'chemistry',
    allowedUnits: [],
    canonicalUnit: '',
    bounds: { min: -10, max: 15 },
    requiresMinMax: false,
    forensic: false,
    alreadyLogarithmic: true,
    summarizable: true,
    zod: rangeSchema({ min: -10, max: 15, allowedUnits: [], requiresMinMax: false }),
    format: rangeFormatter,
  },
  logD: {
    id: 'logD',
    label: 'logD',
    longLabel: 'Lipophilicity (logD pH 7.4)',
    symbol: 'logD',
    kind: 'scalar',
    group: 'chemistry',
    allowedUnits: [],
    canonicalUnit: '',
    bounds: { min: -10, max: 15 },
    requiresMinMax: false,
    forensic: false,
    alreadyLogarithmic: true,
    summarizable: true,
    zod: rangeSchema({ min: -10, max: 15, allowedUnits: [], requiresMinMax: false }),
    format: rangeFormatter,
  },

  // ── Pharmacodynamics ──────────────────────────────────────────────────────
  // Pharmacodynamics has no drug-level parameters: the mechanism of action is
  // modelled as ranked receptor-target relationships (see
  // drug_receptor_targets / the monograph pharmacodynamics box), not as flat
  // numeric/text parameters.

  // ── #302 P3 — Pharmacokinetics ────────────────────────────────────────────

  clearance: {
    id: 'clearance',
    label: 'CL',
    longLabel: 'Clearance',
    symbol: 'CL',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: CLEARANCE_UNITS,
    canonicalUnit: 'L/h',
    bounds: { min: 0, max: 100_000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 100_000, allowedUnits: CLEARANCE_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  ka: {
    id: 'ka',
    label: 'ka',
    longLabel: 'Absorption rate constant',
    symbol: 'ka',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: ['1/h'],
    canonicalUnit: '1/h',
    // First-order absorption rate; oral ka is commonly ~0.1–5 /h. Bounds are
    // generous so an unusually fast or slow route is not rejected at the boundary.
    bounds: { min: 0.001, max: 100 },
    // A reviewer may author a point estimate (median only) or a range.
    requiresMinMax: false,
    forensic: false,
    // Route-specific, so there is no single drug-level aggregate to cache: it is
    // stored per route in `parameter_entries` and read by the per-route derivation.
    summarizable: false,
    routeScoped: true,
    // ka describes absorption AFTER dosing this substance, so it is undefined for
    // a never-administered analyte (a metabolite formed in vivo, an endogenous
    // compound) — the substance-class barrier must reject it, exactly as it does
    // bioavailability and the dose quantities.
    requiresAdministration: true,
    zod: rangeSchema({ min: 0.001, max: 100, allowedUnits: ['1/h'], requiresMinMax: false }),
    format: rangeFormatter,
  },
  vmax: {
    id: 'vmax',
    label: 'Vmax',
    longLabel: 'Maximum elimination rate (saturable)',
    symbol: 'Vmax',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: VMAX_UNITS,
    canonicalUnit: 'mg/L/h',
    // Ethanol's ~150 mg/L/h sits mid-range; the bounds only catch a unit slip.
    bounds: { min: 0.0001, max: 100_000 },
    requiresMinMax: false,
    forensic: false,
    // A concentration scale: the value means nothing without the matrix it was measured in
    // (the auto-built model uses plasma/serum entries only).
    matrixRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0.0001, max: 100_000, allowedUnits: VMAX_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  km: {
    id: 'km',
    label: 'Km',
    longLabel: 'Michaelis constant (saturable elimination)',
    symbol: 'Km',
    kind: 'range',
    group: 'pharmacokinetics',
    allowedUnits: CONCENTRATION_UNITS,
    canonicalUnit: 'mg/L',
    bounds: { min: 0.000001, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    // A concentration scale: the value means nothing without the matrix it was measured in
    // (the auto-built model uses plasma/serum entries only).
    matrixRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0.000001, max: 1_000_000, allowedUnits: CONCENTRATION_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  postmortemRedistribution: {
    id: 'postmortemRedistribution',
    label: 'C/P',
    longLabel: 'C/P (central–peripheral concentration ratio)',
    symbol: 'C/P',
    kind: 'ratio',
    group: 'postmortem',
    allowedUnits: ['ratio'],
    canonicalUnit: 'ratio',
    bounds: { min: 0, max: 100 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 100, allowedUnits: ['ratio'], requiresMinMax: false }),
    format: rangeFormatter,
  },
  // Distinct quantity from the C/P ratio above, and the two must never be
  // pooled. C/P is a within-body gradient: two SITES sampled after death at the
  // same time (cardiac vs femoral blood). PM/AM is a PAIRED-SPECIMEN ratio
  // ACROSS DEATH — an antemortem clinical specimen against postmortem femoral
  // blood from the same decedent.
  //
  // "Paired specimens", not "the same site over time". Only the postmortem
  // member is defined: femoral whole blood at mortuary admission. The
  // antemortem member is whatever routine hospital draw exists — venous, of
  // unstated site, and whole blood, plasma or serum. So the ratio embeds
  // specimen-site and matrix differences alongside the postmortem change, and
  // must not be read as isolating the latter.
  //
  // NOT `matrixRelevant`, deliberately. `matrix` is a single column whose only
  // aggregation effect is `matrixToWholeBlood`: multiply a serum/plasma value
  // by the blood:plasma ratio. That transform is defined for a concentration
  // and is wrong for this parameter in two ways. First, a PM/AM value has TWO
  // matrices — the postmortem numerator (femoral whole blood) and the
  // antemortem denominator — which one column cannot express. Second, the
  // correction runs the other way: with a plasma denominator the measured
  // ratio is `true × B/P`, so recovering the whole-blood-equivalent ratio means
  // DIVIDING by B/P, and flagging the entry matrix-relevant would multiply
  // instead, compounding the very error it was meant to remove.
  //
  // The AM-specimen composition is therefore curation context, recorded in the
  // entry's `comments` (Mantinieks et al. 2021 report a mixed cohort — about
  // 35% plasma/serum — and their whole-blood-only sub-analyses where they gave
  // them). It follows that entries whose AM matrix composition is not
  // comparable should not be pooled as one summary; that is a sourcing
  // judgement made when an entry is added, not something this column can
  // enforce. See docs/pm-am-ratio-seeding.md.
  pmAmRatio: {
    id: 'pmAmRatio',
    label: 'PM/AM',
    longLabel: 'PM/AM (postmortem/antemortem concentration ratio)',
    symbol: 'PM/AM',
    kind: 'ratio',
    group: 'postmortem',
    allowedUnits: ['ratio'],
    canonicalUnit: 'ratio',
    // Individual-case PM/AM ratios reach into the hundreds (amitriptyline
    // 0.37–224, morphine 0.04–122 in Mantinieks et al. 2021), so the bound is
    // well above the C/P parameter's.
    bounds: { min: 0, max: 1000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 1000, allowedUnits: ['ratio'], requiresMinMax: false }),
    format: rangeFormatter,
  },

  // ── Model structure (CV-1b) ───────────────────────────────────────────────
  // A drug's PK model shape, declared as cited pick-from-a-list values the engine
  // composes into a model family (kinetics-core `composeModelFamily`). Categorical,
  // so they carry no unit/matrix and are not summarizable (a shape is not
  // aggregated across sources — it is asserted with a citation).
  dispositionModel: {
    id: 'dispositionModel',
    label: 'Disposition',
    longLabel: 'Disposition model (compartments)',
    kind: 'enum',
    group: 'pharmacokinetics',
    allowedValues: DISPOSITION_KINDS,
    forensic: false,
    zod: z.enum([...DISPOSITION_KINDS] as [string, ...string[]]),
    format: textFormatter,
  },
  eliminationModel: {
    id: 'eliminationModel',
    label: 'Elimination',
    longLabel: 'Elimination kinetics',
    kind: 'enum',
    group: 'pharmacokinetics',
    allowedValues: ELIMINATION_KINDS,
    forensic: false,
    zod: z.enum([...ELIMINATION_KINDS] as [string, ...string[]]),
    format: textFormatter,
  },
  // Absorption is a per-ROUTE property in the engine (`ModelStructure` is "the
  // three orthogonal axes for one route"), unlike disposition and elimination,
  // which are drug-level molecule properties. CV-2c-4 makes it `routeOptional`:
  // an absorption declaration MAY carry an administration route (a multi-route
  // drug — e.g. IV bolus + oral first-order — declares the shape per route, which
  // the per-route derivation reads), while a route-less declaration stays valid as
  // the drug's overall input shape. The route vocabulary is the kinetics-core
  // `ROUTE_IDS`, enforced by the write schema and the DB CHECK (migration 0111).
  absorptionModel: {
    id: 'absorptionModel',
    label: 'Absorption',
    longLabel: 'Absorption / input model',
    kind: 'enum',
    group: 'pharmacokinetics',
    allowedValues: ABSORPTION_KINDS,
    forensic: false,
    routeOptional: true,
    // An absorption shape describes how an administered dose ENTERS the body,
    // so — like `bioavailability` and `ka`, and unlike disposition and
    // elimination, which a metabolite has as much as its parent — it has no
    // referent for a substance nobody administers. Without this the gap queue
    // would offer "absorption model" for every metabolite on a screening panel
    // and re-offer it forever, since no study can ever answer it.
    requiresAdministration: true,
    zod: z.enum([...ABSORPTION_KINDS] as [string, ...string[]]),
    format: textFormatter,
  },

  // ── #302 P3 — Dose & exposure ─────────────────────────────────────────────

  therapeuticDose: {
    id: 'therapeuticDose',
    label: 'Therapeutic dose',
    longLabel: 'Therapeutic dose range',
    kind: 'range',
    group: 'dose_exposure',
    allowedUnits: DOSE_UNITS,
    canonicalUnit: 'mg',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    requiresAdministration: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: DOSE_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  maxRecommendedDose: {
    id: 'maxRecommendedDose',
    label: 'Max recommended dose',
    longLabel: 'Maximum recommended dose',
    kind: 'range',
    group: 'dose_exposure',
    allowedUnits: DOSE_UNITS,
    canonicalUnit: 'mg',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    requiresAdministration: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: DOSE_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  nonMedicalDose: {
    id: 'nonMedicalDose',
    label: 'Non-medical dose',
    longLabel: 'Non-medical / recreational dose range',
    kind: 'range',
    group: 'dose_exposure',
    allowedUnits: DOSE_UNITS,
    canonicalUnit: 'mg',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    requiresAdministration: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: DOSE_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  overdoseDose: {
    id: 'overdoseDose',
    label: 'Overdose dose',
    longLabel: 'High-risk / overdose dose range',
    kind: 'range',
    group: 'dose_exposure',
    allowedUnits: DOSE_UNITS,
    canonicalUnit: 'mg',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    requiresAdministration: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: DOSE_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  fatalDose: {
    id: 'fatalDose',
    label: 'Fatal dose',
    longLabel: 'Reported fatal dose range',
    kind: 'range',
    group: 'dose_exposure',
    allowedUnits: DOSE_UNITS,
    canonicalUnit: 'mg',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    requiresAdministration: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: DOSE_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },

  // ── #302 P3 — Interpretive concentrations ─────────────────────────────────

  therapeuticConcentration: {
    id: 'therapeuticConcentration',
    label: 'Therapeutic conc.',
    longLabel: 'Therapeutic concentration range',
    kind: 'range',
    group: 'interpretive_concentrations',
    allowedUnits: CONCENTRATION_UNITS,
    canonicalUnit: 'mg/L',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    matrixRelevant: true,
    scenarioRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: CONCENTRATION_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  supratherapeuticConcentration: {
    id: 'supratherapeuticConcentration',
    label: 'Supratherapeutic conc.',
    longLabel: 'Supratherapeutic concentration range',
    kind: 'range',
    group: 'interpretive_concentrations',
    allowedUnits: CONCENTRATION_UNITS,
    canonicalUnit: 'mg/L',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    matrixRelevant: true,
    scenarioRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: CONCENTRATION_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  impairmentConcentration: {
    id: 'impairmentConcentration',
    label: 'Impairment conc.',
    longLabel: 'Impairment-associated concentration range',
    kind: 'range',
    group: 'interpretive_concentrations',
    allowedUnits: CONCENTRATION_UNITS,
    canonicalUnit: 'mg/L',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    matrixRelevant: true,
    scenarioRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: CONCENTRATION_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  toxicConcentration: {
    id: 'toxicConcentration',
    label: 'Toxic conc.',
    longLabel: 'Toxic concentration range',
    kind: 'range',
    group: 'interpretive_concentrations',
    allowedUnits: CONCENTRATION_UNITS,
    canonicalUnit: 'mg/L',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    matrixRelevant: true,
    scenarioRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: CONCENTRATION_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },
  fatalConcentration: {
    id: 'fatalConcentration',
    label: 'Fatal conc.',
    longLabel: 'Fatal concentration range',
    kind: 'range',
    group: 'postmortem',
    allowedUnits: CONCENTRATION_UNITS,
    canonicalUnit: 'mg/L',
    bounds: { min: 0, max: 1_000_000 },
    requiresMinMax: false,
    forensic: false,
    matrixRelevant: true,
    scenarioRelevant: true,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 1_000_000, allowedUnits: CONCENTRATION_UNITS, requiresMinMax: false }),
    format: rangeFormatter,
  },

  // ── #302 P3 — Analytics & detection ───────────────────────────────────────
  // `loq` and `lod` used to sit here as drug-level parameters. They are retired
  // (`npm run retire:loq-lod` clears the stored rows): a limit of quantification or
  // detection is a property of a **validated method in a particular
  // laboratory** — its instrument, extraction, calibrators and matrix — not of
  // the substance, so there is no one number a monograph can carry and no pool
  // of published limits that says anything about the next lab's assay. Kinetix
  // already holds the real figures where they belong: per analyte per method on
  // `analytical_method_components` (`lor` / `mkk` / `lod`, under the sheet's
  // own limit-type names), which the monograph's analytics box renders as read-only
  // "from methods" rows next to the parameters below.
  //
  // `analyteStability` stays: an analyte's degradation half-life in a stored
  // specimen is a property of the substance in that matrix, not of the assay.
  // It is NOT `summarizable` — degradation in urine and in whole blood are
  // different quantities with no conversion between them, so a single
  // cross-matrix aggregate would be valid for no sample type. The matrix is
  // stated in the value's note rather than carried as a column.

  // Blood, oral fluid and urine each get their own window. They were once a
  // single blood/oral-fluid parameter, but the two matrices behave differently
  // enough — oral fluid tracks the free parent drug and typically falls off
  // sooner, blood is the matrix impairment is read from — that a shared value
  // was accurate for neither, and a source almost always reports one or the
  // other rather than a combined figure.
  bloodDetectionWindow: {
    id: 'bloodDetectionWindow',
    label: 'Blood window',
    longLabel: 'Blood detection window',
    kind: 'range',
    group: 'analytics_detection',
    allowedUnits: ['h'],
    canonicalUnit: 'h',
    bounds: { min: 0, max: 8760 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 8760, allowedUnits: ['h'], requiresMinMax: false }),
    format: rangeFormatter,
  },
  oralFluidDetectionWindow: {
    id: 'oralFluidDetectionWindow',
    label: 'Oral-fluid window',
    longLabel: 'Oral-fluid detection window',
    kind: 'range',
    group: 'analytics_detection',
    allowedUnits: ['h'],
    canonicalUnit: 'h',
    bounds: { min: 0, max: 8760 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 8760, allowedUnits: ['h'], requiresMinMax: false }),
    format: rangeFormatter,
  },
  urineDetectionWindow: {
    id: 'urineDetectionWindow',
    label: 'Urine window',
    longLabel: 'Urine detection window',
    kind: 'range',
    group: 'analytics_detection',
    allowedUnits: ['h'],
    canonicalUnit: 'h',
    bounds: { min: 0, max: 8760 },
    requiresMinMax: false,
    forensic: false,
    summarizable: true,
    zod: rangeSchema({ min: 0, max: 8760, allowedUnits: ['h'], requiresMinMax: false }),
    format: rangeFormatter,
  },
  analyteStability: {
    id: 'analyteStability',
    label: 'Stability',
    longLabel: 'Analyte stability / degradation half-life (by matrix)',
    kind: 'range',
    group: 'analytics_detection',
    allowedUnits: ['h'],
    canonicalUnit: 'h',
    bounds: { min: 0, max: 87600 },
    requiresMinMax: false,
    forensic: false,
    zod: rangeSchema({ min: 0, max: 87600, allowedUnits: ['h'], requiresMinMax: false }),
    format: rangeFormatter,
  },
};

export function getParameterSpec(id: string): ParameterSpec | null {
  if ((DRUG_PARAMETER_IDS as readonly string[]).includes(id)) {
    return DRUG_PARAMETERS[id as DrugParameterId];
  }
  return null;
}

export function isRangeSpec(spec: ParameterSpec): spec is RangeParameterSpec {
  return isRangeKind(spec.kind) || spec.kind === 'struct';
}

/**
 * Look up the spec for a parameter id and assert it is a range-shaped param.
 * Used by callers (e.g. PK input grids) that only meaningfully handle the
 * NumericRange family.
 */
export function getRangeSpec(id: DrugParameterId): RangeParameterSpec {
  const spec = DRUG_PARAMETERS[id];
  if (!isRangeSpec(spec)) {
    throw new Error(`Parameter "${id}" is not a range parameter`);
  }
  return spec;
}

export function isDrugParameterId(id: string): id is DrugParameterId {
  return (DRUG_PARAMETER_IDS as readonly string[]).includes(id);
}

/**
 * Whether the biological matrix is a meaningful dimension of this parameter,
 * i.e. a per-source `parameter_entries` row for it must carry a `matrix`.
 */
export function parameterIsMatrixRelevant(id: DrugParameterId): boolean {
  return DRUG_PARAMETERS[id].matrixRelevant === true;
}

/**
 * Whether this parameter's `drug_parameters` value is a recomputed aggregate of
 * per-source `parameter_entries` rows rather than a hand-authored single value.
 */
export function parameterIsSummarizable(id: DrugParameterId): boolean {
  return DRUG_PARAMETERS[id].summarizable === true;
}

/** Whether the parameter is stored per administration route (CV-2c, e.g. `ka`). */
export function parameterIsRouteScoped(id: DrugParameterId): boolean {
  return DRUG_PARAMETERS[id].routeScoped === true;
}

/**
 * Whether the parameter MAY carry an administration route without requiring one (CV-2c-4, e.g.
 * `absorptionModel`). A route-optional parameter accepts both a drug-level entry (route null) and
 * per-route entries; `parameterIsRouteScoped` (route required) is the stricter, mutually-exclusive
 * case.
 */
export function parameterIsRouteOptional(id: DrugParameterId): boolean {
  return DRUG_PARAMETERS[id].routeOptional === true;
}

/**
 * How a parameter's source entries relate to structured dose context. An
 * unknown id is `'forbidden'`: nothing may attach dose context to a parameter
 * the registry does not describe.
 */
/**
 * The Cmax-authoring gate (RFC *Migration strategy*). Registering a parameter
 * is not inert: every generic producer admits whatever the registry
 * recognises, so release B registered Cmax closed, so an approval could
 * ACCEPT a release-C payload while no instance could yet CREATE one. Release C
 * opens it, once every instance runs release B's handlers.
 *
 * Kept as a switch rather than deleted so the next parameter that adopts dose
 * context can ship registered-but-closed the same way.
 */
export const DOSE_CONTEXT_AUTHORING_OPEN = true;

/**
 * Whether creating source entries for this parameter is refused by the gate
 * above: a dose-context parameter while authoring is closed. Approval, update
 * and every read path are deliberately NOT gated.
 */
export function parameterAuthoringGated(id: string): boolean {
  return !DOSE_CONTEXT_AUTHORING_OPEN && parameterDoseContextMode(id) === 'required';
}

/** The refusal message a gated producer returns (stable, code `parameter_authoring_gated`). */
export function parameterAuthoringGatedMessage(id: string): string {
  return `${id} source values cannot be created yet: the dose-context release that authors them has not shipped`;
}

export function parameterDoseContextMode(id: string): DoseContextMode {
  return isDrugParameterId(id)
    ? DRUG_PARAMETERS[id].doseContext ?? 'forbidden'
    : 'forbidden';
}

/**
 * Whether this parameter's value may be authored directly — a single number or
 * range typed into the parameter editor — or must come from its source values.
 *
 * A summarizable parameter's `drug_parameters.value` is a recomputed aggregate
 * of its `parameter_entries`, so a hand-authored number there is not a value
 * anyone can trace: it carries no per-source spread, does not appear in the
 * forest plot or the entry list, cannot be weighted by source quality, and is
 * replaced wholesale the moment a real entry arrives. For those parameters the
 * only way in is a source value (`POST /api/parameter-entries`), and the
 * displayed number is always something the pool produced.
 *
 * The rule is deliberately unconditional — it does NOT wait for the first entry
 * to exist. An empty parameter is exactly where a typed-in number is most
 * tempting and least traceable, and letting one in there is what left values
 * sitting beside the source-value system instead of inside it. Legacy values
 * migration 0078 grandfathered stay displayed and read-only until source values
 * supersede them (see `recomputeAndCacheParameterSummary`).
 *
 * Everything else — analyte stability (matrix-specific, no valid cross-matrix
 * pool) and the identity metadata (names, aliases, MW, CID) — is still authored
 * directly: those are not pooled measurements.
 *
 * The model-structure axes (CV-1b) are also refused: they are not summarizable
 * (a shape is not numerically aggregated) but they ARE entry-backed — a cited
 * `parameter_entries` declaration, never a hand-authored drug-row value. See
 * `parameterIsEntryBacked`.
 */
export function parameterAcceptsAuthoredValue(id: DrugParameterId): boolean {
  return !parameterIsEntryBacked(id);
}

/**
 * Whether the parameter's value lives in `parameter_entries` (as cited per-source
 * rows) rather than as a hand-authored value on the drug row. True for the
 * summarizable numeric parameters (whose displayed value is a recomputed
 * aggregate), the categorical model-structure axes (CV-1b, whose value is an
 * asserted, cited shape), AND the route-scoped parameters (CV-2c, e.g. `ka`,
 * whose value is cited per administration route). All are edited through
 * `/api/parameter-entries`, not `/api/drug-parameter` — a route-scoped parameter
 * has no drug-level value at all, so it must never be accepted by the generic
 * drug-value path (where it would be stored as one drug-level number and then
 * read as present for every route).
 */
export function parameterIsEntryBacked(id: DrugParameterId): boolean {
  return (
    parameterIsSummarizable(id) ||
    isModelStructureParameter(id) ||
    DRUG_PARAMETERS[id].routeScoped === true ||
    // Entry-only (Cmax): cited rows and nothing else. Without this it would
    // read as an authored parameter and open every drug-level write path.
    DRUG_PARAMETERS[id].entryBacked === true
  );
}

/**
 * Whether the parameter has ANY drug-level value — authored, or a summarized
 * cache — that the drug-level surfaces (Drug Table, grouped sidebar,
 * comparison and value pickers, `drug_parameters`) can show. False for a
 * route-scoped parameter (its values are per route) and for an entry-only one
 * that is not summarized (Cmax: per-dose-context source values only).
 */
export function parameterHasDrugLevelValue(id: DrugParameterId): boolean {
  const spec = DRUG_PARAMETERS[id];
  if (spec.routeScoped) return false;
  return !(spec.entryBacked === true && spec.summarizable !== true);
}

/**
 * Whether the parameter's own values are logarithms (logP, logD, pKa), so charts
 * must NOT apply a further log transform.
 */
export function parameterIsAlreadyLogarithmic(id: DrugParameterId): boolean {
  return DRUG_PARAMETERS[id].alreadyLogarithmic === true;
}

/**
 * Whether an interpretive `scenario` is a meaningful dimension of a per-source
 * entry for this parameter. Only the interpretive concentrations qualify; every
 * other summarizable parameter records study context in `comments` instead.
 */
export function parameterIsScenarioRelevant(id: DrugParameterId): boolean {
  return DRUG_PARAMETERS[id].scenarioRelevant === true;
}

/**
 * Parameter ids whose values are backed by the multi-value `parameter_entries`
 * store and displayed as a recomputed aggregate. This is the single source of
 * truth shared by the migration, the entry write/read paths, and the review
 * pipeline.
 *
 * The set is every range parameter whose reported value legitimately varies
 * BETWEEN SOURCES — not only the interpretive concentrations. A half-life, logP,
 * blood:plasma ratio or plasma protein binding figure differs from paper to
 * paper (method, population, assay), so the literature spread IS the range, and
 * a single hand-authored number hides which studies it came from.
 *
 * Deliberately excluded: `analyteStability`. Degradation in urine and in whole
 * blood are different quantities with no blood:plasma conversion between them,
 * so there is no valid cross-matrix pool and it stays per-matrix. Metadata
 * parameters (names, aliases, MW, CID) are excluded because they are identity
 * constants, not measurements. (`loq`/`lod` were excluded for the same
 * per-matrix reason until they were retired outright — see the analytics &
 * detection block above.)
 */
export const SUMMARIZED_PARAMETER_IDS: DrugParameterId[] =
  DRUG_PARAMETER_IDS.filter((id) =>
    parameterIsSummarizable(id),
  ) as DrugParameterId[];

/** Parameter ids visible in the current (non-forensic) Drug Table. Route-scoped
 *  parameters (CV-2c) have no drug-level value, so they are not table columns. */
export const VISIBLE_PARAMETER_IDS: DrugParameterId[] = DRUG_PARAMETER_IDS.filter(
  (id) =>
    !DRUG_PARAMETERS[id].forensic &&
    parameterHasDrugLevelValue(id) &&
    isRangeKind(DRUG_PARAMETERS[id].kind),
) as DrugParameterId[];

/**
 * Route-scoped parameter ids (CV-2c): stored per administration route in
 * `parameter_entries` and read by the per-route derivation, with no drug-level
 * value. The per-route editor section renders these; the drug-level surfaces
 * (Drug Table, drug-value pickers, grouped sidebar) exclude them.
 */
export const ROUTE_SCOPED_PARAMETER_IDS: DrugParameterId[] = DRUG_PARAMETER_IDS.filter(
  (id) => DRUG_PARAMETERS[id].routeScoped === true,
) as DrugParameterId[];

/**
 * Entry-only parameter ids (Cmax): cited `parameter_entries` rows with no
 * drug-level value and no summarized cache. Accepted by the entry schemas;
 * excluded from every drug-level surface (`parameterHasDrugLevelValue`).
 */
export const ENTRY_ONLY_PARAMETER_IDS: DrugParameterId[] = DRUG_PARAMETER_IDS.filter(
  (id) => DRUG_PARAMETERS[id].entryBacked === true && DRUG_PARAMETERS[id].summarizable !== true,
) as DrugParameterId[];

/**
 * Parameter ids that carry a readable DRUG-LEVEL value — everything except the
 * categorical model-structure axes (CV-1b), whose value lives only in
 * `parameter_entries` and has no `drug_parameters`/`DrugRow` field. Generic
 * drug-value surfaces (the comparison picker, the Drug Table column/sort picker)
 * read values via `readDrugMetadataValue`, so an axis offered there would always
 * render blank; enumerate this set instead of `DRUG_PARAMETER_IDS`.
 */
export const DRUG_VALUE_PARAMETER_IDS: DrugParameterId[] = DRUG_PARAMETER_IDS.filter(
  (id) => DRUG_PARAMETERS[id].kind !== 'enum' && parameterHasDrugLevelValue(id),
) as DrugParameterId[];

/** Parameter ids that represent editable drug metadata (text/number/list). */
export const METADATA_PARAMETER_IDS: DrugParameterId[] = DRUG_PARAMETER_IDS.filter(
  (id) =>
    !isRangeKind(DRUG_PARAMETERS[id].kind) &&
    DRUG_PARAMETERS[id].kind !== 'struct' &&
    // Model-structure axes are categorical (`enum`), not free metadata — they are
    // cited source entries (CV-1b), so they are not part of the metadata editor.
    DRUG_PARAMETERS[id].kind !== 'enum',
) as DrugParameterId[];

/**
 * The model-structure axes (CV-1b): categorical (`enum`) parameters whose value
 * is the drug's PK model shape, stored as cited `parameter_entries` rows and
 * composed into a model family by kinetics-core. Not summarizable (a shape is
 * asserted with a citation, not aggregated across sources).
 */
export const MODEL_STRUCTURE_PARAMETER_IDS: DrugParameterId[] = DRUG_PARAMETER_IDS.filter(
  (id) => DRUG_PARAMETERS[id].kind === 'enum',
) as DrugParameterId[];

/**
 * Whether `id` is a categorical model-structure axis (dispositionModel / …).
 *
 * Deliberately a plain `boolean`, not an `id is DrugParameterId` predicate:
 * every axis is already a DrugParameterId, so such a predicate would narrow the
 * FALSE branch to `never` (a caller that `continue`s on the true case would lose
 * the type on the rest). Callers that need the narrower id use an explicit cast.
 */
export function isModelStructureParameter(id: string): boolean {
  return (
    isDrugParameterId(id) && DRUG_PARAMETERS[id as DrugParameterId].kind === 'enum'
  );
}

/** The `EnumParameterSpec` for a model-structure axis; throws for a non-enum id. */
export function getEnumSpec(id: DrugParameterId): EnumParameterSpec {
  const spec = DRUG_PARAMETERS[id];
  if (spec.kind !== 'enum') throw new Error(`Parameter "${id}" is not an enum parameter`);
  return spec;
}

/** The pick-from-a-list vocabulary for a model-structure axis (empty for a non-enum id). */
export function allowedValuesForParameter(id: DrugParameterId): readonly string[] {
  const spec = DRUG_PARAMETERS[id];
  return spec.kind === 'enum' ? spec.allowedValues : [];
}

/**
 * Whether editing this parameter requires citing a source reference.
 *
 * Drug identity and intrinsic-constant metadata — the language names, short
 * name, aliases, molecular mass and PubChem CID — have a fixed, self-evident
 * provenance (the compound itself / PubChem), so the value "is always going to
 * be the same anyway" and a per-edit citation adds noise rather than evidence.
 * These are exactly the editable-metadata fields. Every pharmacokinetic value,
 * by contrast, still has to cite a judged reference before it can be saved or
 * submitted for review.
 */
export function parameterRequiresReference(id: DrugParameterId): boolean {
  return !METADATA_PARAMETER_IDS.includes(id);
}

/**
 * Parameter ids assigned to a sidebar group, in registry order. Drives the
 * grouped rendering in DrugMonographSidebar (#302). Metadata parameters
 * (group=null) are excluded — they live outside the grouped sidebar.
 */
export function getParametersInGroup(group: ParameterGroupId): DrugParameterId[] {
  return DRUG_PARAMETER_IDS.filter(
    // Route-scoped parameters (CV-2c) have no drug-level value, so they are not
    // shown in the grouped drug-level sidebar even when they carry a group.
    (id) => DRUG_PARAMETERS[id].group === group && parameterHasDrugLevelValue(id),
  ) as DrugParameterId[];
}

/**
 * Groups, in render order, that currently have at least one parameter
 * registered. Empty groups are hidden so the sidebar doesn't show a sea
 * of empty section headers until later PRs add their parameters.
 */
export function getNonEmptyParameterGroups(): ParameterGroupId[] {
  return PARAMETER_GROUPS.map((g) => g.id).filter(
    (id) => getParametersInGroup(id).length > 0,
  );
}

/**
 * i18n key for a parameter's long label, used by surfaces (e.g. the
 * grouped monograph sidebar) that render the label to end users.
 * Translations live under `parameters.<id>.longLabel`. Call sites
 * should fall back to `spec.longLabel` when the key is missing so
 * not-yet-translated parameters degrade to English instead of a raw
 * key string.
 */
export function getParameterLongLabelKey(id: DrugParameterId): string {
  return `parameters.${id}.longLabel`;
}

/**
 * i18n key for a parameter's short label. Mirrors
 * `getParameterLongLabelKey`; same fallback contract.
 */
export function getParameterLabelKey(id: DrugParameterId): string {
  return `parameters.${id}.label`;
}
