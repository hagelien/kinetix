import {
  DRUG_PARAMETERS,
  type DrugParameterId,
  type ParameterSpec,
} from '@/lib/drugParameters';
import { readDrugMetadataValue } from '@/lib/drugNames';
import {
  DEFAULT_FRACTION_DISPLAY,
  formatRange,
  formatUnit,
  formatWithMaxDecimals,
  hasRangeData,
  rangeMax,
  rangeMin,
  isPercentUnit,
  rangeRepresentative,
  showFractionAsPercent,
  type FractionDisplay,
} from '@/lib/rangeUtils';
import type { DrugRow } from '@/lib/drugApi';
import type { NumericRange } from '@/types';

export interface ComparisonValue {
  parameterId: DrugParameterId;
  drugId: number;
  raw: unknown;
  formatted: string;
  unit: string;
  numeric: number | null;
  min: number | null;
  max: number | null;
  valueType: 'point' | 'range' | 'text' | 'missing';
}

export interface ParameterComparison {
  parameterId: DrugParameterId;
  spec: ParameterSpec;
  values: ComparisonValue[];
  commonUnit: string | null;
  hasUnitMismatch: boolean;
  inverseStrength: boolean;
}

// Parameters where a lower value means a stronger effect (binding/potency
// constants). The drug-level Ki/IC50/EC50 parameters were retired in favour
// of the free-text mechanism fields; those quantities now live on the
// receptor-target relationship and are not compared through this table.
const INVERSE_STRENGTH_PARAMETERS = new Set<DrugParameterId>([]);

export function isInverseStrengthParameter(
  parameterId: DrugParameterId,
): boolean {
  return INVERSE_STRENGTH_PARAMETERS.has(parameterId);
}

export function extractComparisonValue(
  drug: DrugRow,
  parameterId: DrugParameterId,
): ComparisonValue {
  const spec = DRUG_PARAMETERS[parameterId];
  const raw = readDrugMetadataValue(
    drug as unknown as Record<string, unknown>,
    parameterId,
  );

  if (spec.kind === 'number') {
    const numeric =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return {
      parameterId,
      drugId: drug.id,
      raw,
      formatted: spec.format(raw),
      unit: formatUnit(spec.unitLabel),
      numeric,
      min: numeric,
      max: numeric,
      valueType: numeric === null ? 'missing' : 'point',
    };
  }

  if (
    spec.kind === 'range' ||
    spec.kind === 'fraction' ||
    spec.kind === 'ratio' ||
    spec.kind === 'scalar' ||
    spec.kind === 'struct'
  ) {
    const range = raw as NumericRange | null | undefined;
    const hasData = hasRangeData(range);
    return {
      parameterId,
      drugId: drug.id,
      raw,
      formatted: spec.format(raw),
      unit: formatUnit(range?.unit ?? spec.canonicalUnit),
      numeric: hasData ? rangeRepresentative(range) : null,
      min: hasData ? rangeMin(range) : null,
      max: hasData ? rangeMax(range) : null,
      valueType:
        hasData &&
        (typeof range?.min === 'number' || typeof range?.max === 'number')
          ? 'range'
          : hasData
            ? 'point'
            : 'missing',
    };
  }

  const formatted = spec.format(raw);
  return {
    parameterId,
    drugId: drug.id,
    raw,
    formatted,
    unit: '',
    numeric: null,
    min: null,
    max: null,
    valueType: formatted ? 'text' : 'missing',
  };
}

export function buildParameterComparison(
  parameterId: DrugParameterId,
  drugs: DrugRow[],
): ParameterComparison {
  const values = drugs.map((drug) => extractComparisonValue(drug, parameterId));
  const populatedUnits = Array.from(
    new Set(
      values
        .filter((value) => value.numeric !== null)
        .map((value) => value.unit)
        .filter(Boolean),
    ),
  );

  return {
    parameterId,
    spec: DRUG_PARAMETERS[parameterId],
    values,
    commonUnit: populatedUnits.length === 1 ? populatedUnits[0]! : null,
    hasUnitMismatch: populatedUnits.length > 1,
    inverseStrength: isInverseStrengthParameter(parameterId),
  };
}

export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  return `${formatWithMaxDecimals(value, 2)}x`;
}

/**
 * Render a comparison cell. `fractionDisplay` writes the fraction-kind
 * parameters (F, plasma protein binding) as percentages when the user asked
 * for that; it defaults to the stored decimal so non-UI callers are unchanged.
 */
export function formatComparisonValue(
  value: ComparisonValue,
  fractionDisplay: FractionDisplay = DEFAULT_FRACTION_DISPLAY,
): string {
  if (value.valueType === 'missing') return '';
  const asPercent = showFractionAsPercent(
    DRUG_PARAMETERS[value.parameterId]?.kind,
    fractionDisplay,
  );
  if (
    value.raw &&
    typeof value.raw === 'object' &&
    // Every scalar a NumericRange can carry, not only the bounds: a
    // median-only range is the common shape for a catalog fraction, and
    // falling through to `formatted` below would print it as the decimal
    // while the representative column beside it reads as a percentage.
    // (`value` is a legacy key kept for pre-migration blobs.)
    ('min' in value.raw ||
      'max' in value.raw ||
      'median' in value.raw ||
      'mean' in value.raw ||
      'value' in value.raw)
  ) {
    return formatRange(value.raw as NumericRange, { asPercent });
  }
  // `formatted` is the registry's own rendering, which knows nothing of the
  // preference — re-render a fraction scalar through formatRange so a
  // percentage cell never falls back to the decimal.
  if (asPercent && typeof value.raw === 'number') {
    return formatRange({ median: value.raw }, { asPercent });
  }
  return value.formatted;
}

/**
 * The bare representative scalar shown in the comparison table's own column.
 * Mirrors `formatComparisonValue`'s percent rule so the two columns of a
 * fraction parameter can never disagree about the notation.
 */
export function formatComparisonRepresentative(
  value: ComparisonValue,
  fractionDisplay: FractionDisplay = DEFAULT_FRACTION_DISPLAY,
): string {
  if (value.numeric === null) return '';
  if (
    showFractionAsPercent(
      DRUG_PARAMETERS[value.parameterId]?.kind,
      fractionDisplay,
    )
  ) {
    // A value already stored in `%` is the percentage — see `isPercentUnit`.
    const scaled = isPercentUnit(value.unit)
      ? value.numeric
      : value.numeric * 100;
    return `${formatWithMaxDecimals(scaled)}%`;
  }
  return `${formatWithMaxDecimals(value.numeric)}${value.unit ? ` ${value.unit}` : ''}`;
}

export function relativeRatio(
  value: number | null,
  reference: number | null,
  inverseStrength: boolean,
): number | null {
  if (
    value === null ||
    reference === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(reference) ||
    value <= 0 ||
    reference <= 0
  ) {
    return null;
  }
  return inverseStrength ? reference / value : value / reference;
}
