import { z } from 'zod';

export const REFERENCE_SCENARIOS = [
  'living_therapeutic',
  'living_toxic',
  'living_dui',
  'postmortem_non_intox',
  'postmortem_mono_intox',
  'postmortem_poly_intox',
  'case_report',
  'case_series',
] as const;
export type ReferenceScenario = (typeof REFERENCE_SCENARIOS)[number];

export const REFERENCE_MATRICES = [
  'serum',
  'plasma',
  'whole_blood',
  'urine',
  'vitreous',
  'hair',
  'other',
] as const;
export type ReferenceMatrix = (typeof REFERENCE_MATRICES)[number];

// Owner-approved canonical set (issue #172 comment 2026-04-22):
// nano/micro/milli prefix × {mL, dL, L} volume, for both mass and molar.
const MASS_PREFIXES = ['ng', 'µg', 'mg'] as const;
const MOLAR_PREFIXES = ['nmol', 'µmol', 'mmol'] as const;
const VOLUMES = ['mL', 'dL', 'L'] as const;

export const REFERENCE_UNITS = [
  ...MASS_PREFIXES.flatMap((m) => VOLUMES.map((v) => `${m}/${v}` as const)),
  ...MOLAR_PREFIXES.flatMap((m) => VOLUMES.map((v) => `${m}/${v}` as const)),
] as const;
export type ReferenceUnit = (typeof REFERENCE_UNITS)[number];

export const referenceScenarioSchema = z.enum(
  REFERENCE_SCENARIOS as unknown as [ReferenceScenario, ...ReferenceScenario[]],
);
export const referenceMatrixSchema = z.enum(
  REFERENCE_MATRICES as unknown as [ReferenceMatrix, ...ReferenceMatrix[]],
);
export const referenceUnitSchema = z.enum(
  REFERENCE_UNITS as unknown as [ReferenceUnit, ...ReferenceUnit[]],
);

export const referenceConcentrationInputSchema = z
  .object({
    drugId: z.number().int().positive(),
    low: z.number().finite().nonnegative().optional(),
    high: z.number().finite().nonnegative().optional(),
    unit: referenceUnitSchema,
    matrix: referenceMatrixSchema,
    scenario: referenceScenarioSchema,
    n: z.number().int().positive().optional(),
    comments: z.string().max(2000).optional(),
    citationId: z.number().int().positive().optional(),
  })
  .refine((v) => v.low !== undefined || v.high !== undefined, {
    message: 'At least one of low or high is required',
  })
  .refine(
    (v) => !(v.low !== undefined && v.high !== undefined && v.low > v.high),
    { message: 'low cannot be greater than high' },
  );

export type ReferenceConcentrationInput = z.infer<
  typeof referenceConcentrationInputSchema
>;

// PATCH payload: same shape as POST minus drugId (the drug a row is attached
// to is immutable). Cross-field invariants stay; the form always submits a
// complete row.
export const referenceConcentrationUpdateSchema = z
  .object({
    low: z.number().finite().nonnegative().optional(),
    high: z.number().finite().nonnegative().optional(),
    unit: referenceUnitSchema,
    matrix: referenceMatrixSchema,
    scenario: referenceScenarioSchema,
    n: z.number().int().positive().optional(),
    comments: z.string().max(2000).optional(),
    citationId: z.number().int().positive().optional(),
  })
  .refine((v) => v.low !== undefined || v.high !== undefined, {
    message: 'At least one of low or high is required',
  })
  .refine(
    (v) => !(v.low !== undefined && v.high !== undefined && v.low > v.high),
    { message: 'low cannot be greater than high' },
  );

export type ReferenceConcentrationUpdateInput = z.infer<
  typeof referenceConcentrationUpdateSchema
>;

/**
 * Maps a legacy interpretive `scenario` to the drug parameter its value backs
 * in the multi-value `parameter_entries` store (migration 0078). Kept in sync
 * with the CASE mapping in that migration. The three scenarios without a clean
 * interpretive bucket fall to their nearest home; `scenario` is retained on the
 * row as finer-grained context. Used by the legacy reference-concentrations
 * write path to populate the now-required `parameter` column during Phases 1–4.
 */
export const SCENARIO_TO_PARAMETER: Record<ReferenceScenario, string> = {
  living_therapeutic: 'therapeuticConcentration',
  living_toxic: 'toxicConcentration',
  living_dui: 'impairmentConcentration',
  postmortem_non_intox: 'fatalConcentration',
  postmortem_mono_intox: 'fatalConcentration',
  postmortem_poly_intox: 'fatalConcentration',
  case_report: 'toxicConcentration',
  case_series: 'toxicConcentration',
};

/**
 * Interpretive scenarios that back a given summarizable parameter (the inverse of
 * SCENARIO_TO_PARAMETER). Falls back to every scenario for a parameter with no
 * dedicated scenario (e.g. supratherapeuticConcentration) so its editor dropdown
 * is never empty. Lets the entry editor default to — and restrict itself to — a
 * parameter-appropriate scenario instead of always offering "therapeutic".
 */
export function scenariosForParameter(parameter: string): ReferenceScenario[] {
  const matched = REFERENCE_SCENARIOS.filter(
    (s) => SCENARIO_TO_PARAMETER[s] === parameter,
  );
  return matched.length ? matched : [...REFERENCE_SCENARIOS];
}

export function defaultScenarioForParameter(parameter: string): ReferenceScenario {
  return scenariosForParameter(parameter)[0]!;
}

export const REFERENCE_SCENARIO_LABELS: Record<ReferenceScenario, string> = {
  living_therapeutic: 'Therapeutic (living)',
  living_toxic: 'Toxic (living)',
  living_dui: 'DUI (living)',
  postmortem_non_intox: 'Postmortem (non-intoxication)',
  postmortem_mono_intox: 'Postmortem (mono intoxication)',
  postmortem_poly_intox: 'Postmortem (poly intoxication)',
  case_report: 'Case report',
  case_series: 'Case series',
};

export const REFERENCE_MATRIX_LABELS: Record<ReferenceMatrix, string> = {
  serum: 'serum',
  plasma: 'plasma',
  whole_blood: 'whole blood',
  urine: 'urine',
  vitreous: 'vitreous',
  hair: 'hair',
  other: 'other',
};

// i18n key maps — render these through `t(...)` so the scenario/matrix labels
// follow the user's language. The English `*_LABELS` maps above stay as the
// canonical source/default text (en.json mirrors them under `referenceConc.*`).
export const REFERENCE_SCENARIO_LABEL_KEYS: Record<ReferenceScenario, string> = {
  living_therapeutic: 'referenceConc.scenario.living_therapeutic',
  living_toxic: 'referenceConc.scenario.living_toxic',
  living_dui: 'referenceConc.scenario.living_dui',
  postmortem_non_intox: 'referenceConc.scenario.postmortem_non_intox',
  postmortem_mono_intox: 'referenceConc.scenario.postmortem_mono_intox',
  postmortem_poly_intox: 'referenceConc.scenario.postmortem_poly_intox',
  case_report: 'referenceConc.scenario.case_report',
  case_series: 'referenceConc.scenario.case_series',
};

export const REFERENCE_MATRIX_LABEL_KEYS: Record<ReferenceMatrix, string> = {
  serum: 'referenceConc.matrix.serum',
  plasma: 'referenceConc.matrix.plasma',
  whole_blood: 'referenceConc.matrix.whole_blood',
  urine: 'referenceConc.matrix.urine',
  vitreous: 'referenceConc.matrix.vitreous',
  hair: 'referenceConc.matrix.hair',
  other: 'referenceConc.matrix.other',
};
