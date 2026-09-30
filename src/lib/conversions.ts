import type { DrugComponent, NumericRange, UnitType } from '@/types';
import { meanRange, rangeMax, rangeMin } from './rangeUtils';
import { parseLocaleNumber } from './parseNumber';

/**
 * Round to N significant digits rather than N decimal places.
 *
 * `molarUnits`/`massUnits` now span unit pairs whose factors differ by up to
 * 7 orders of magnitude (e.g. `ng/L` at 1e-3 to `mg/dL` at 1e4, #1209), so a
 * fixed decimal-place round can erase a legitimate small nonzero result —
 * 1 ng/L expressed in mg/dL is 1e-7, which `Math.round(x * 1e6) / 1e6` turns
 * into 0 (Codex P1, #1287).
 */
function roundSignificant(num: number, sigDigits = 6): number {
  if (num === 0 || !Number.isFinite(num)) return num;
  const magnitude = Math.floor(Math.log10(Math.abs(num)));
  const factor = Math.pow(10, sigDigits - magnitude - 1);
  return Math.round(num * factor) / factor;
}

// Factors are mol/L per 1 unit. Includes every unit the preferences UI can
// enable (`PreferencesPage.tsx`'s MOLAR_UNITS) — not just the primary-eligible
// subset — so the row/tooltip converter always has a matching option (#1209).
// A /dL unit is 10x its /L counterpart (1 dL = 0.1 L).
export const molarUnits: Record<string, number> = {
  'mmol/L': 1e-3,
  'µmol/L': 1e-6,
  'nmol/L': 1e-9,
  'mmol/dL': 1e-2,
  'µmol/dL': 1e-5,
  'nmol/dL': 1e-8,
};

// Factors are µg/L per 1 unit (mirrors `MASS_TO_MG_PER_L` in
// `unitConversion.ts`, scaled ×1000 onto a µg/L base instead of mg/L).
// Includes every unit PreferencesPage.tsx's MASS_UNITS can enable, for the
// same reason as `molarUnits` above.
export const massUnits: Record<string, number> = {
  'mg/L': 1e3,
  'µg/mL': 1e3,
  'ng/mL': 1,
  'µg/L': 1,
  'ng/L': 1e-3,
  'mg/dL': 1e4,
  'µg/dL': 10,
  'ng/dL': 1e-2,
};

export const matrixOptions = ['blood', 'plasma/serum'] as const;
export type MatrixType = (typeof matrixOptions)[number];

export const molarUnitOptions = Object.keys(molarUnits);
export const massUnitOptions = Object.keys(massUnits);

export function parseRatio(range: NumericRange | number | null | undefined): number {
  if (typeof range === 'number') {
    return Number.isFinite(range) && range > 0 ? range : 1;
  }
  const numeric = meanRange(range);
  return Number.isFinite(numeric) && numeric !== null && numeric > 0 ? numeric : 1;
}

export interface RatioInfo {
  /** The single scalar actually applied in the matrix conversion (midpoint of a range). */
  applied: number;
  /** Lower/upper bounds when the ratio is a range; null when unknown. */
  min: number | null;
  max: number | null;
  /** True when min/max differ — i.e. the applied value is a midpoint of a real range. */
  isRange: boolean;
  /** True when the drug actually carries B/P data (vs. falling back to 1). */
  defined: boolean;
}

/**
 * Describe the blood/plasma ratio for display: the midpoint that is actually
 * applied plus the underlying range it was collapsed from. Accepts both a bare
 * number and a `NumericRange` so callers don't have to normalise first.
 */
export function describeRatio(
  range: NumericRange | number | null | undefined
): RatioInfo {
  const applied = parseRatio(range);
  if (typeof range === 'number') {
    const defined = Number.isFinite(range) && range > 0;
    return { applied, min: range, max: range, isRange: false, defined };
  }
  const min = rangeMin(range);
  const max = rangeMax(range);
  return {
    applied,
    min,
    max,
    isRange: min !== null && max !== null && min !== max,
    defined: min !== null || max !== null,
  };
}

function toCanonicalMass(
  value: string | number | null | undefined,
  kind: UnitType,
  unit: string,
  molecularWeight: number
): number | null {
  if (value === '' || value === null || value === undefined) return null;
  // Accept both ',' and '.' as decimal separators (Norwegian keyboards
  // default to comma) so "0,76" converts just like "0.76".
  const numericValue = typeof value === 'number' ? value : parseLocaleNumber(value);
  if (!Number.isFinite(numericValue)) return null;

  const factor = kind === 'molar' ? molarUnits[unit] : massUnits[unit];
  if (factor === undefined) return null;

  if (kind === 'molar') {
    const mol = numericValue * factor;
    return mol * molecularWeight * 1e6;
  }
  return numericValue * factor;
}

function applyMatrixConversion(
  value: number | null,
  fromMatrix: MatrixType,
  toMatrix: MatrixType,
  ratio: number
): number | null {
  if (value === null) return null;
  if (fromMatrix === toMatrix) return value;
  if (fromMatrix === 'plasma/serum' && toMatrix === 'blood') {
    return value * ratio;
  }
  if (fromMatrix === 'blood' && toMatrix === 'plasma/serum') {
    return value / ratio;
  }
  return value;
}

export function convertBetweenKinds(
  value: string | number,
  sourceKind: UnitType,
  sourceUnit: string,
  sourceMatrix: MatrixType,
  targetKind: UnitType,
  targetUnit: string,
  targetMatrix: MatrixType,
  drug: Pick<DrugComponent, 'molecularWeight' | 'bloodPlasmaRatio'>
): string | number {
  const canonicalMass = toCanonicalMass(
    value,
    sourceKind,
    sourceUnit,
    drug.molecularWeight ?? 0
  );
  if (canonicalMass === null) return '';

  const ratio = parseRatio(drug.bloodPlasmaRatio);
  const adjustedMass = applyMatrixConversion(canonicalMass, sourceMatrix, targetMatrix, ratio);
  if (adjustedMass === null) return '';

  if (targetKind === 'mass') {
    return roundSignificant(adjustedMass / (massUnits[targetUnit] ?? 1));
  }

  const mol = (adjustedMass * 1e-6) / (drug.molecularWeight ?? 1);
  return roundSignificant(mol / (molarUnits[targetUnit] ?? 1e-6));
}

export function getUnitKind(unit: string | null | undefined): UnitType | null {
  if (unit && molarUnits[unit] !== undefined) return 'molar';
  if (unit && massUnits[unit] !== undefined) return 'mass';
  return null;
}

export interface UnitConfig {
  unit: string;
  type: UnitType;
  matrix: MatrixType;
}

export function getUnitConfig(
  prefs: Record<string, string | undefined>,
  key: string
): UnitConfig {
  const unitValue = prefs[key] ?? 'µmol/L';
  const explicitType = prefs[`${key}Type`] as UnitType | undefined;
  const inferredType = getUnitKind(unitValue) ?? (key.includes('mass') ? 'mass' : 'molar');
  const matrixKey = `${key}Matrix`;

  return {
    unit: unitValue,
    type: explicitType ?? inferredType,
    matrix: (prefs[matrixKey] as MatrixType) ?? 'blood',
  };
}

export function convertBetweenConfigs(
  value: string | number,
  fromConfig: UnitConfig,
  toConfig: UnitConfig,
  drug: Pick<DrugComponent, 'molecularWeight' | 'bloodPlasmaRatio'>
): string | number {
  return convertBetweenKinds(
    value,
    fromConfig.type,
    fromConfig.unit,
    fromConfig.matrix,
    toConfig.type,
    toConfig.unit,
    toConfig.matrix,
    drug
  );
}
