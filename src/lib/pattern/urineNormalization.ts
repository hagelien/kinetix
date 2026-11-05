/**
 * Creatinine normalisation (§8.1, spec §11).
 *
 * `k` scales a urine concentration to a standard creatinine reference so two
 * urine samples of different dilution can be compared. It applies **only** where
 * a feature's operands come from different specimens; within a specimen it
 * cancels algebraically, and the engine enforces that from the resolved
 * operands' specimen ids rather than from per-feature configuration — a curator
 * cannot get it wrong because a curator cannot state it.
 */

import type { PatternSpecimen } from '../../types/patternCase.js';

/**
 * Scale factor for one urine specimen, or `null` when it cannot be computed.
 *
 * Null rather than 1: a missing or zero creatinine is an unknown dilution, and
 * silently normalising by 1 would present an uncorrected value as a corrected
 * one. Callers degrade the normalised variant instead.
 */
export function creatinineFactor(
  specimen: PatternSpecimen,
  referenceMmolL: number,
): number | null {
  const measured = specimen.urine?.creatinineMmolL;
  if (measured === undefined || !Number.isFinite(measured) || measured <= 0) return null;
  if (!Number.isFinite(referenceMmolL) || referenceMmolL <= 0) return null;
  return referenceMmolL / measured;
}

/**
 * Whether `k` bears on a ratio at all: true only when the operands come from
 * different specimens. This is the plan's central invariant — the four
 * within-matrix diazepam ratios are unchanged by dilution and the two
 * cross-matrix ones are not — and it is asserted as a property over the whole
 * registry rather than per fixture (§11).
 */
export function normalizationApplies(
  numeratorSpecimenId: string,
  denominatorSpecimenId: string | undefined,
): boolean {
  if (denominatorSpecimenId === undefined) return false;
  return numeratorSpecimenId !== denominatorSpecimenId;
}

/**
 * Analyte amount per mmol of measured creatinine, distinct from a concentration
 * standardized to a reference creatinine. Unit volume must cancel explicitly;
 * an unfamiliar unit is left unnormalized rather than guessed.
 */
export function concentrationPerCreatinine(
  value: number | undefined,
  unit: string | undefined,
  specimen: PatternSpecimen | undefined,
): { value: number; unit: string } | undefined {
  const creatinine = specimen?.urine?.creatinineMmolL;
  if (
    specimen?.matrix !== 'urine' ||
    value === undefined || !Number.isFinite(value) || value < 0 ||
    creatinine === undefined || !Number.isFinite(creatinine) || creatinine <= 0 ||
    !unit
  ) return undefined;

  // The coefficient is identical for these equivalent numerator/volume pairs.
  const units: Record<string, string> = {
    'nmol/L': 'nmol/mmol', 'µmol/L': 'µmol/mmol', 'umol/L': 'µmol/mmol',
    'μmol/L': 'µmol/mmol', 'mmol/L': 'mmol/mmol', 'pmol/L': 'pmol/mmol',
    'ng/mL': 'µg/mmol', 'µg/L': 'µg/mmol', 'ug/L': 'µg/mmol',
    'μg/L': 'µg/mmol', 'mg/L': 'mg/mmol', 'µg/mL': 'mg/mmol',
    'ug/mL': 'mg/mmol', 'μg/mL': 'mg/mmol', 'ng/L': 'ng/mmol',
    'g/L': 'g/mmol', 'mg/mL': 'g/mmol',
  };
  const normalizedUnit = Object.prototype.hasOwnProperty.call(units, unit) ? units[unit] : undefined;
  const normalizedValue = value / creatinine;
  return normalizedUnit && Number.isFinite(normalizedValue)
    ? { value: normalizedValue, unit: normalizedUnit }
    : undefined;
}
