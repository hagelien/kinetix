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
