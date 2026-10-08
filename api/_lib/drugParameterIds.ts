/**
 * Drug parameter identifiers for API-side validation.
 * Mirrors the list in src/lib/drugParameters.ts but without
 * frontend dependencies (@/ path aliases, zod schemas, formatters).
 *
 * Keep this list in sync with `DRUG_PARAMETER_IDS` in
 * src/lib/drugParameters.ts. A canonical-source approach is
 * intentionally avoided to keep API bundles free of zod and the
 * spec registry's other frontend imports — the trade-off is the
 * manual sync. drugParameters.test.ts asserts both lists agree.
 */
export const DRUG_PARAMETER_IDS = [
  // PK/PD parameters (NumericRange)
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  // Peak concentration as a dose-contextualized source measurement (Cmax
  // dose-context RFC). Entry-backed with no drug-level value; authoring is
  // gated until release C (`DOSE_CONTEXT_AUTHORING_OPEN`).
  'cmax',
  'pKa',
  // Editable drug metadata (text + number + list)
  'nameNb',
  'nameEn',
  'nameShort',
  'aliases',
  'molecularWeight',
  'pubchemCid',
  // #302 P3 — additional grouped parameters from #276's list.
  // Chemistry
  'logP',
  'logD',
  // Pharmacodynamics has no drug-level parameters: the mechanism of action is
  // modelled as ranked receptor-target relationships on drug_receptor_targets.
  // Pharmacokinetics
  'clearance',
  // Route-specific first-order absorption rate (CV-2c), stored per route.
  'ka',
  // Saturable (Michaelis–Menten) elimination pair, molecule-level.
  'vmax',
  'km',
  'postmortemRedistribution',
  'pmAmRatio',
  // Model structure (CV-1b): categorical PK model-shape axes.
  'dispositionModel',
  'eliminationModel',
  'absorptionModel',
  // Dose & exposure
  'therapeuticDose',
  'maxRecommendedDose',
  'nonMedicalDose',
  'overdoseDose',
  'fatalDose',
  // Interpretive concentrations
  'therapeuticConcentration',
  'supratherapeuticConcentration',
  'impairmentConcentration',
  'toxicConcentration',
  'fatalConcentration',
  // Analytics & detection
  // `loq`/`lod` are retired — an analytical limit belongs to
  // a method in a lab, not to the substance, and the real values already live
  // per analyte per method on `analytical_method_components`.
  'bloodDetectionWindow',
  'oralFluidDetectionWindow',
  'urineDetectionWindow',
  'analyteStability',
] as const;

export type DrugParameterId = (typeof DRUG_PARAMETER_IDS)[number];

export function isDrugParameterId(id: string): id is DrugParameterId {
  return (DRUG_PARAMETER_IDS as readonly string[]).includes(id);
}
