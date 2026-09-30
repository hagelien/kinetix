/**
 * Unit handling for multi-value parameter entries.
 *
 * A `parameter_entries` row stores the value exactly as the source reported it —
 * its own unit — and conversion happens at read time. Concentrations pivot
 * through `convertConcentration` (mass ↔ molar needs a molecular weight); every
 * other parameter family is a plain linear rescale (or has a single unit and
 * needs no conversion at all). This module is the one place that knows which
 * units an entry may carry for a given parameter and how to move between them.
 */
import {
  DRUG_PARAMETERS,
  isRangeSpec,
  type DrugParameterId,
} from './drugParameters.js';
import {
  convertConcentration,
  isConcentrationUnit,
  type ConcentrationUnit,
} from './unitConversion.js';
import { REFERENCE_UNITS } from './referenceConcentrations.js';
import { convertLinearUnit, LINEAR_UNITS } from './unitFamilies.js';

/**
 * Stored unit for a dimensionless parameter (logP, logD, pKa). The registry's
 * `canonicalUnit` for those is the empty string, and `parameter_entries.unit` is
 * NOT NULL, so the empty string is the value that round-trips through storage,
 * exact-match conversion and the aggregate's `unit` field unchanged.
 */
export const DIMENSIONLESS_UNIT = '';

/**
 * Units a per-source entry may carry for a parameter.
 *
 * A concentration parameter accepts the full canonical source-unit set
 * (`REFERENCE_UNITS` — every mass/molar prefix × mL/dL/L), because a paper
 * reports in whatever unit it likes and everything in that set converts to the
 * canonical unit at read time. This is also the set legacy
 * `reference_concentrations` rows were written with, so existing entries stay
 * re-validatable. Every other parameter is limited to its own `allowedUnits`,
 * and a dimensionless one (logP, logD, pKa) accepts only `DIMENSIONLESS_UNIT`.
 */
export function entryUnitsForParameter(
  id: DrugParameterId,
): readonly string[] {
  const spec = DRUG_PARAMETERS[id];
  if (!isRangeSpec(spec)) return [];
  // A dose-context parameter (Cmax) takes concentration-per-dose units beside
  // the concentrations, which the shared concentration list does not carry.
  if (spec.doseContext === 'required') return spec.allowedUnits;
  if (isConcentrationUnit(spec.canonicalUnit)) return REFERENCE_UNITS;
  return spec.allowedUnits.length
    ? spec.allowedUnits
    : [spec.canonicalUnit || DIMENSIONLESS_UNIT];
}

/**
 * Convert a parameter value between units. Returns null when the conversion is
 * not defined (different families, or a molar↔mass concentration conversion with
 * no molecular weight) so callers can exclude the value rather than pool a wrong
 * number. Identical units always pass straight through, which covers every
 * single-unit parameter (h, fraction, ratio) and the dimensionless ones.
 */
export function convertParameterValue(
  value: number,
  from: string,
  to: string,
  molecularWeight?: number | null,
): number | null {
  if (from === to) return value;
  if (isConcentrationUnit(from) && isConcentrationUnit(to)) {
    try {
      return convertConcentration(
        value,
        from as ConcentrationUnit,
        to as ConcentrationUnit,
        molecularWeight ?? undefined,
      );
    } catch {
      return null;
    }
  }
  return convertLinearUnit(value, from, to);
}

/**
 * The family a unit can be pooled within — the answer to "would two values in
 * these units ever end up in one aggregate?".
 *
 * Every concentration unit is one family: mass↔molar needs a molecular weight,
 * which no single entry carries but the aggregate does. A linear unit keys by
 * its declared family, so `L/h` and `L/h/kg` stay apart. Anything else keys by
 * itself, which is exactly the exact-match-only behaviour of `mg/kg`, `mg/day`
 * and `mg/kg/day` — and the trivially correct answer for the single-unit
 * parameters (`h`, `fraction`, `ratio`) and the dimensionless ones.
 */
export function parameterUnitFamily(unit: string): string {
  if (isConcentrationUnit(unit)) return 'concentration';
  return LINEAR_UNITS[unit]?.family ?? `unit:${unit}`;
}

/**
 * The unit a value stored in `sourceUnit` should be DISPLAYED in for this
 * reader: their primary unit (`enabledUnits[0]`, the #306 preference) when the
 * value can actually be converted into it, and the authored unit otherwise.
 *
 * One display unit per view, resolved from the summary's unit, keeps a source
 * list comparable: rows authored in ng/mL, µg/L and µmol/L all land on the same
 * axis and the same column of figures, instead of each row arguing in its own
 * unit. A parameter with no concentration dimension (h, fraction, ratio, logP)
 * converts to nothing else and is returned unchanged.
 */
export function preferredDisplayUnit(
  sourceUnit: string,
  enabledUnits: readonly string[] | null | undefined,
  molecularWeight?: number | null,
): string {
  const preferred = enabledUnits?.[0];
  if (!preferred || preferred === sourceUnit) return sourceUnit;
  const probe = convertParameterValue(1, sourceUnit, preferred, molecularWeight);
  return probe != null && Number.isFinite(probe) ? preferred : sourceUnit;
}

/**
 * Display suffix for a unit — a leading space plus the unit, or nothing at all
 * for a dimensionless parameter, so a logP renders as `2.1` rather than `2.1 `.
 */
export function formatUnitSuffix(unit: string | null | undefined): string {
  return unit ? ` ${unit}` : '';
}
