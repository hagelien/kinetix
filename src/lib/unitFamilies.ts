/**
 * Linear (factor-only) unit families — the shared, dependency-free bottom of
 * the unit stack.
 *
 * This lives apart from `parameterUnits.ts` because BOTH the parameter registry
 * (`drugParameters.ts`, which bounds a value in its canonical unit) and the
 * entry-level conversion helpers need it, and `parameterUnits.ts` imports the
 * registry. Keeping the table in a leaf module with no imports of its own is
 * what lets the registry canonicalize without an import cycle.
 *
 * Concentrations are deliberately NOT here: mass ↔ molar needs a molecular
 * weight, so they are not a factor-only family and live in `unitConversion.ts`.
 */

/** A unit's family, and its factor toward that family's base unit. */
interface LinearUnitDef {
  family: string;
  toBase: number;
}

/**
 * Each entry maps a unit to its factor toward the family's base unit. Units in
 * DIFFERENT families are never interconvertible — notably `L/h` and `L/h/kg`,
 * which differ by a body weight that no entry carries.
 */
export const LINEAR_UNITS: Record<string, LinearUnitDef> = {
  // Clearance, absolute — base L/h. 1 mL/min = 60 mL/h = 0.06 L/h.
  'L/h': { family: 'clearance', toBase: 1 },
  'L/min': { family: 'clearance', toBase: 60 },
  'mL/min': { family: 'clearance', toBase: 0.06 },
  // Clearance, weight-normalized — base L/h/kg. Same factors, separate family.
  'L/h/kg': { family: 'clearance_per_kg', toBase: 1 },
  'mL/min/kg': { family: 'clearance_per_kg', toBase: 0.06 },
  // Saturable elimination capacity (Vmax) as a concentration fall per unit time
  // — base mg/L/h, the engine's own unit. 1 mg/dL = 10 mg/L; 1 µg/mL = 1 mg/L.
  // Vmax reported as an amount per time (mg/h, mg/kg/day) is deliberately
  // absent: turning it into a concentration rate needs the volume of
  // distribution, which is a separate parameter, not a unit factor.
  'mg/L/h': { family: 'elimination_capacity', toBase: 1 },
  'µg/mL/h': { family: 'elimination_capacity', toBase: 1 },
  'mg/dL/h': { family: 'elimination_capacity', toBase: 10 },
  'g/L/h': { family: 'elimination_capacity', toBase: 1000 },
  'mg/L/min': { family: 'elimination_capacity', toBase: 60 },
  // Absolute dose mass — base mg. A paper reporting a fatal dose in grams must
  // pool with one reporting milligrams, or it drops out of the aggregate and
  // the parameter keeps showing a stale hand-authored value.
  mg: { family: 'dose_mass', toBase: 1 },
  g: { family: 'dose_mass', toBase: 1000 },
  'µg': { family: 'dose_mass', toBase: 0.001 },
  // mg/kg, mg/day and mg/kg/day are deliberately absent: converting them to an
  // absolute dose needs a body weight or a dosing interval that no entry
  // carries. They stay exact-match-only, so such a source is excluded from the
  // pool and disclosed by the forest plot's "not shown" note rather than
  // silently rescaled.
};

/**
 * Rescale a value between two units of the same linear family. Returns null when
 * the pair is not a factor-only conversion — a different family, or a unit this
 * table does not describe (every concentration unit, and the exact-match-only
 * dose units) — so a caller can fall back rather than pool a wrong number.
 */
export function convertLinearUnit(
  value: number,
  from: string,
  to: string,
): number | null {
  if (from === to) return value;
  const f = LINEAR_UNITS[from];
  const t = LINEAR_UNITS[to];
  if (!f || !t || f.family !== t.family) return null;
  return (value * f.toBase) / t.toBase;
}
