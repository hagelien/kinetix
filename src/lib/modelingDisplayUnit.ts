import type { DrugSimResult } from '@/types/simulator';
import {
  convertConcentration,
  isConcentrationUnit,
  type ConcentrationUnit,
} from '@/lib/unitConversion';

/**
 * Re-express a simulation result in the user's preferred concentration unit so
 * the whole results surface (graph axis, median/confidence bands, and the Svar
 * headline) reads in one unit — instead of mixing the drug's authored input
 * unit with the preferred unit. Applies to the concentration point estimates
 * and the full time series.
 *
 * Left untouched (returned as-is) when:
 *  - the result unit is not a concentration unit (inferred dose in mg, ethanol
 *    BAC in g/dL) — those quantities are not concentrations;
 *  - the preferred unit is not a concentration unit, or already equals the
 *    result unit;
 *  - a mass↔molar conversion is needed but no molecular weight is available.
 *
 * The KineLab posterior (`result.kinelab`) is intentionally not converted: its
 * intervals are parameter-space quantities (dose, Vd, …), and the inferred-dose
 * answer must stay in its own unit.
 *
 * This is a UNIT change only. The chart's display MATRIX (whole blood / serum /
 * plasma) is applied separately, on the plotted curve in the series adapter, so
 * it never leaks into the canonical answer readouts — see
 * `simulatorResultsToModelingSeries` and `src/lib/matrixDisplay.ts`.
 */
export function toPreferredUnitResult(
  result: DrugSimResult,
  molecularWeight: number | null | undefined,
  preferredUnit: string | undefined,
): DrugSimResult {
  const sourceUnit = result.unit;
  const mw = molecularWeight ?? undefined;
  if (
    !preferredUnit ||
    !isConcentrationUnit(sourceUnit) ||
    !isConcentrationUnit(preferredUnit) ||
    sourceUnit === preferredUnit
  ) {
    // The scalar answer is not a concentration (an inferred dose in mg, a BAC
    // in g/dL) or needs no change — but a dose answer still plots a
    // concentration curve, named by `curveUnit`. Convert that curve on its own
    // so the graph axis honours the preference even when the headline cannot.
    return convertCurveOnly(result, mw, preferredUnit);
  }

  const from = sourceUnit as ConcentrationUnit;
  const to = preferredUnit as ConcentrationUnit;

  try {
    const conv = (n: number) => convertConcentration(n, from, to, mw);
    return {
      ...result,
      // The scalar and the curve share a unit here; `curveUnit` would only
      // restate it, so it is cleared rather than left naming the old unit.
      curveUnit: undefined,
      median: conv(result.median),
      p05: conv(result.p05),
      p25: conv(result.p25),
      p75: conv(result.p75),
      p95: conv(result.p95),
      unit: preferredUnit,
      timeSeries: result.timeSeries.map((p) => ({
        t: p.t,
        median: conv(p.median),
        p05: conv(p.p05),
        p25: conv(p.p25),
        p75: conv(p.p75),
        p95: conv(p.p95),
      })),
    };
  } catch {
    // Cross-kind conversion without a molecular weight — keep the source unit.
    return result;
  }
}

/**
 * Convert only the plotted curve, for a result whose SCALAR answer is not a
 * concentration. `dose-from-concentration` reports a dose in mg while its curve
 * is a concentration; without this the axis, threshold lines and postmortem
 * overlays would stay in the engine's unit while every other mode followed the
 * preference.
 */
function convertCurveOnly(
  result: DrugSimResult,
  molecularWeight: number | undefined,
  preferredUnit: string | undefined,
): DrugSimResult {
  const sourceUnit = result.curveUnit;
  if (
    sourceUnit == null ||
    !preferredUnit ||
    !isConcentrationUnit(sourceUnit) ||
    !isConcentrationUnit(preferredUnit) ||
    sourceUnit === preferredUnit
  ) {
    return result;
  }
  try {
    const conv = (n: number) =>
      convertConcentration(
        n,
        sourceUnit as ConcentrationUnit,
        preferredUnit as ConcentrationUnit,
        molecularWeight,
      );
    return {
      ...result,
      curveUnit: preferredUnit,
      timeSeries: result.timeSeries.map((p) => ({
        t: p.t,
        median: conv(p.median),
        p05: conv(p.p05),
        p25: conv(p.p25),
        p75: conv(p.p75),
        p95: conv(p.p95),
      })),
    };
  } catch {
    // Cross-kind conversion without a molecular weight — keep the source unit.
    return result;
  }
}

/**
 * The concentration unit a result's plotted curve is in, or `undefined` when the
 * result carries no curve unit at all. Prefer this over `result.unit` anywhere
 * the CURVE is being described (axis label, threshold lines, PM/forensic
 * overlays): `unit` names the scalar answer, which is a dose in
 * `dose-from-concentration`.
 */
export function curveUnitOf(
  result: DrugSimResult | undefined,
): string | undefined {
  return result?.curveUnit ?? result?.unit;
}
