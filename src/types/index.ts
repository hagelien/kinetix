import type { MethodMatrix } from '@/lib/drugApi';

// Numeric range types for PK/PD calculations

/**
 * The only values a NumericRange `qualifier` may hold: comparison
 * operators for one-sided bounds (e.g. "> 5", "≤ 0.1"). It is NOT a
 * free-text field — route/population/context labels ("voksen po", "adult
 * oral") belong in `note`, never here. Numeric/tabular pharmacology data
 * must stay numeric; arbitrary strings in `qualifier` leak into the
 * formatted value and shadow the real min/max range.
 */
export type QualifierOperator = '<' | '>' | '≤' | '≥';

export const QUALIFIER_OPERATORS: readonly QualifierOperator[] = [
  '<',
  '>',
  '≤',
  '≥',
];

export function isQualifierOperator(
  value: unknown,
): value is QualifierOperator {
  return (
    typeof value === 'string' &&
    (QUALIFIER_OPERATORS as readonly string[]).includes(value)
  );
}

export interface NumericRange {
  min?: number;
  max?: number;
  /** Arithmetic mean of the reported observations, when known. */
  mean?: number;
  /**
   * Median of the reported observations, when known. This replaces the
   * former standalone `value` field; legacy single values were migrated
   * into `median`. It is the preferred representative scalar — single-
   * number consumers (sorting, distributions, formatted display) fall
   * back to `mean`, then to the min/max midpoint.
   */
  median?: number;
  unit?: string;
  qualifier?: QualifierOperator;
  note?: string;
  /**
   * Machine marker: true when this value is a DERIVED CACHE recomputed from
   * `parameter_entries`, not a hand-authored value. Set only by the aggregation
   * pipeline; used to decide whether a recompute may clear the value when no
   * entries remain. Kept out of the user-editable `note` so authored prose can
   * never be misclassified as an aggregate. See isAggregateCacheValue.
   */
  derivedFromEntries?: boolean;
}

// Drug component data
export interface DrugComponent {
  id: string;
  /** Per-language names keyed by BCP-47 code (e.g. { nb: "...", en: "..." }). */
  names: Record<string, string>;
  /** Optional shortname / abbreviation, language-agnostic. */
  nameShort?: string;
  /** Literature variants, brand names, and street names. */
  aliases?: string[];
  pubchemCid?: number;
  molecularWeight?: number;
  halfLife?: NumericRange | number;
  volumeOfDistribution?: NumericRange | number;
  bioavailability?: NumericRange | number;
  proteinBinding?: NumericRange | number;
  bloodPlasmaRatio?: NumericRange | number;
  tmax?: NumericRange | number;
  pKa?: NumericRange | number;
  /** Structured ionization profile; supersedes the scalar `pKa`. */
  ionizationConstants?: import('@/lib/ionizationConstants').IonizationConstant[];
  therapeuticConcentration?: NumericRange | number;
  supratherapeuticConcentration?: NumericRange | number;
  impairmentConcentration?: NumericRange | number;
  toxicConcentration?: NumericRange | number;
  fatalConcentration?: NumericRange | number;
  methods?: string[];
  /** Pre-computed lowercase search key (all language names + aliases + shortname). */
  _searchKey?: string;
  /** Database id (set when loaded from /api/drugs) */
  _dbId?: number;
  /** Wiki page slug for the drug's monograph, when included by the API. */
  _monographSlug?: string;
  /** Popularity score, used for default sort order */
  _popularityScore?: number;
}

// Analytical method data
export interface AnalyticalMethod {
  id: string;
  /** Database primary key, used to link to the method detail page. */
  dbId?: number;
  name: string;
  description?: string;
  components?: string[];
  drugIds?: number[];
  /** Number of components on the method, as reported by the API. */
  componentCount?: number;
  /** Sample matrices the method runs in; drives method-badge colour coding. */
  matrices?: MethodMatrix[];
}

// Unit conversion types
export type UnitType = 'molar' | 'mass';

export interface ConversionUnit {
  id: string;
  label: string;
  type: UnitType;
  factor: number;
}

// Table column configuration
export interface TableColumn {
  id: string;
  label: string;
  sortable?: boolean;
  width?: string;
  minWidth?: string;
  visible?: boolean;
}

// Sort state
export interface SortState {
  column: string;
  direction: 'asc' | 'desc';
}

// Storage keys
export const STORAGE_KEYS = {
  textScale: 'kinetix.textScale',
  values: 'kinetix.values',
  drugTableColumns: 'kinetix.drugTable.columns',
  drugTableConversionColumnRetired: 'kinetix.drugTable.conversionRetired',
} as const;
