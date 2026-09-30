import type { NumericRange } from '../types/index.js';

// --- Concentration unit types ---

export type MassConcentrationUnit =
  | 'mg/L'
  | 'mg/mL'
  | 'µg/mL'
  | 'ng/mL'
  | 'µg/L'
  | 'ng/L'
  | 'mg/dL'
  | 'µg/dL'
  | 'ng/dL';
export type MolarConcentrationUnit =
  | 'mmol/L'
  | 'mmol/mL'
  | 'µmol/mL'
  | 'nmol/mL'
  | 'µmol/L'
  | 'nmol/L'
  | 'mmol/dL'
  | 'µmol/dL'
  | 'nmol/dL';
export type ConcentrationUnit = MassConcentrationUnit | MolarConcentrationUnit;

export type DoseUnit = 'mg' | 'g' | 'µg';

// --- Conversion factors to canonical units ---

// All mass concentrations normalized to mg/L.
// 1 dL = 0.1 L, so a per-dL value is 10x the per-L value.
const MASS_TO_MG_PER_L: Record<MassConcentrationUnit, number> = {
  'mg/L': 1,
  'mg/mL': 1000,     // 1 mg/mL = 1000 mg/L
  'µg/mL': 1,        // 1 µg/mL = 1 mg/L
  'ng/mL': 0.001,    // 1 ng/mL = 0.001 mg/L
  'µg/L': 0.001,     // 1 µg/L = 0.001 mg/L
  'ng/L': 0.000001,
  'mg/dL': 10,       // 1 mg/dL = 10 mg/L
  'µg/dL': 0.01,     // 1 µg/dL = 0.01 mg/L
  'ng/dL': 0.00001,  // 1 ng/dL = 1e-5 mg/L
};

// All molar concentrations normalized to mmol/L.
const MOLAR_TO_MMOL_PER_L: Record<MolarConcentrationUnit, number> = {
  'mmol/L': 1,
  'mmol/mL': 1000,   // 1 mmol/mL = 1000 mmol/L
  'µmol/mL': 1,      // 1 µmol/mL = 1 mmol/L
  'nmol/mL': 0.001,  // 1 nmol/mL = 0.001 mmol/L
  'µmol/L': 0.001,
  'nmol/L': 0.000001,
  'mmol/dL': 10,
  'µmol/dL': 0.01,
  'nmol/dL': 0.00001,
};

// All dose units normalized to mg
const DOSE_TO_MG: Record<DoseUnit, number> = {
  'g': 1000,
  'mg': 1,
  'µg': 0.001,
};

// --- Type guards ---

const MASS_UNITS = new Set<string>(Object.keys(MASS_TO_MG_PER_L));
const MOLAR_UNITS = new Set<string>(Object.keys(MOLAR_TO_MMOL_PER_L));

export function isMassUnit(unit: ConcentrationUnit): unit is MassConcentrationUnit {
  return MASS_UNITS.has(unit);
}

export function isMolarUnit(unit: ConcentrationUnit): unit is MolarConcentrationUnit {
  return MOLAR_UNITS.has(unit);
}

// --- Conversion functions ---

/**
 * Convert between any two concentration units.
 * Requires molecularWeight (g/mol) for mass <-> molar conversion.
 */
export function convertConcentration(
  value: number,
  from: ConcentrationUnit,
  to: ConcentrationUnit,
  molecularWeight?: number,
): number {
  if (from === to) return value;

  const fromIsMass = isMassUnit(from);
  const toIsMass = isMassUnit(to);

  // Same category: straightforward ratio
  if (fromIsMass && toIsMass) {
    const mgPerL = value * MASS_TO_MG_PER_L[from];
    return mgPerL / MASS_TO_MG_PER_L[to];
  }
  if (!fromIsMass && !toIsMass) {
    const mmolPerL = value * MOLAR_TO_MMOL_PER_L[from as MolarConcentrationUnit];
    return mmolPerL / MOLAR_TO_MMOL_PER_L[to as MolarConcentrationUnit];
  }

  // Cross-category: need molecular weight
  if (!molecularWeight || molecularWeight <= 0) {
    throw new Error('Molecular weight required for mass <-> molar conversion');
  }

  if (fromIsMass && !toIsMass) {
    // mass -> molar: mg/L -> mmol/L = (mg/L) / MW
    const mgPerL = value * MASS_TO_MG_PER_L[from];
    const mmolPerL = mgPerL / molecularWeight;
    return mmolPerL / MOLAR_TO_MMOL_PER_L[to as MolarConcentrationUnit];
  }

  // molar -> mass: mmol/L -> mg/L = (mmol/L) * MW
  const mmolPerL = value * MOLAR_TO_MMOL_PER_L[from as MolarConcentrationUnit];
  const mgPerL = mmolPerL * molecularWeight;
  return mgPerL / MASS_TO_MG_PER_L[to as MassConcentrationUnit];
}

/** Convert between dose units. */
export function convertDose(value: number, from: DoseUnit, to: DoseUnit): number {
  if (from === to) return value;
  const mg = value * DOSE_TO_MG[from];
  return mg / DOSE_TO_MG[to];
}

/** Get available concentration units, including molar only if MW is known. */
export function getAvailableConcentrationUnits(hasMolecularWeight: boolean): ConcentrationUnit[] {
  const mass: ConcentrationUnit[] = ['mg/L', 'µg/mL', 'ng/mL', 'µg/L'];
  if (!hasMolecularWeight) return mass;
  return [...mass, 'mmol/L', 'µmol/L', 'nmol/L'];
}

/**
 * The concentration unit a NEW measurement should start in: the user's primary
 * display unit (`enabledUnits[0]`) when the drug can actually offer it, else
 * `mg/L`. Molar units need a molecular weight to convert, so
 * `getAvailableConcentrationUnits` omits them for a drug without one — falling
 * back keeps the picker's value in its own option list rather than seeding an
 * event with a unit the field cannot show. Later entries in `enabledUnits` are
 * the user's declared alternates, so a drug that cannot serve the primary unit
 * takes the first alternate it can before defaulting.
 */
export function defaultConcentrationUnit(
  enabledUnits: readonly string[],
  molecularWeight: number | null | undefined,
): ConcentrationUnit {
  const available = getAvailableConcentrationUnits(
    molecularWeight != null && Number.isFinite(molecularWeight),
  );
  for (const unit of enabledUnits) {
    const normalized = normalizeUnit(unit);
    if (
      isConcentrationUnit(normalized) &&
      available.includes(normalized)
    ) {
      return normalized;
    }
  }
  return 'mg/L';
}

/** Get available dose units. */
export function getAvailableDoseUnits(): DoseUnit[] {
  return ['mg', 'g', 'µg'];
}

/** Check if a string is a valid ConcentrationUnit. */
export function isConcentrationUnit(s: string): s is ConcentrationUnit {
  return MASS_UNITS.has(s) || MOLAR_UNITS.has(s);
}

/** Check if a string is a valid DoseUnit. */
export function isDoseUnit(s: string): s is DoseUnit {
  return s === 'mg' || s === 'g' || s === 'µg';
}

/**
 * Normalize a unit string so that any micro-prefix variant
 * (ASCII 'u', Greek mu U+03BC, Latin mu U+00B5) becomes the
 * canonical Latin µ (U+00B5).
 */
export function normalizeUnit(unit: string): string {
  // Replace Greek small letter mu (μ, U+03BC) or ASCII 'u' before
  // known SI suffixes with the canonical Latin micro sign (µ, U+00B5).
  return unit
    .replace(/\u03BCmol/g, 'µmol')
    .replace(/\u03BCg/g, 'µg')
    .replace(/\bumol/g, 'µmol')
    .replace(/\bug\b/g, 'µg');
}

/**
 * Convert every numeric endpoint of a concentration range to a target unit.
 * Returns null when conversion isn't possible — either the source unit
 * isn't a recognised concentration unit, or a cross-kind conversion was
 * requested without a molecular weight. The returned object always carries
 * the resolved target unit.
 */
export function convertConcentrationRange(
  range: NumericRange,
  targetUnit: ConcentrationUnit,
  molecularWeight?: number | null,
): NumericRange | null {
  if (!range.unit) return null;
  const source = normalizeUnit(range.unit);
  if (!isConcentrationUnit(source)) return null;
  if (source === targetUnit) return range;
  try {
    const out: NumericRange = { ...range, unit: targetUnit };
    const mw = molecularWeight ?? undefined;
    if (typeof range.min === 'number') {
      out.min = convertConcentration(range.min, source, targetUnit, mw);
    }
    if (typeof range.max === 'number') {
      out.max = convertConcentration(range.max, source, targetUnit, mw);
    }
    if (typeof range.mean === 'number') {
      out.mean = convertConcentration(range.mean, source, targetUnit, mw);
    }
    if (typeof range.median === 'number') {
      out.median = convertConcentration(range.median, source, targetUnit, mw);
    }
    return out;
  } catch {
    return null;
  }
}
