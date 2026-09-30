import type {
  Assumption,
  Limitation,
  Matrix,
  PKModelType,
} from './types';

// ─── Model card registry ────────────────────────────────────────────────────
//
// A model card describes which analytic Lite model is appropriate for an
// analyte and what assumptions/limitations apply. Concrete numeric priors
// (half-life, Vd, F) are NOT stored here — they are pulled from the live
// `drugs` table at compute time so wiki/parameter edits flow through to the
// engine without having to update this file.
//
// `analyteSlug` mirrors `drugs.slug`. The first six analytes match the spec.

export type ValidationStatus =
  | 'toy'
  | 'literature-derived'
  | 'validated'
  | 'experimental';

export interface PKModelCard {
  id: string;
  analyteSlug: string;
  modelType: PKModelType;
  description: string;
  supportedMatrices: Matrix[];
  assumptions: Assumption[];
  limitations: Limitation[];
  validationStatus: ValidationStatus;
}

const sharedLiteLimitation: Limitation = {
  id: 'lite-engine-disclaimer',
  text: 'Lite engine uses simplified analytic PK and grid/Monte-Carlo inference. Output is scenario exploration, not a definitive forensic conclusion.',
  severity: 'warning',
};

// The Lite oral model has no absorption-rate constant (ka): absorption is
// treated as instantaneous and the curve is post-absorption only. Make that
// explicit on every card that previously claimed "first-order absorption".
const instantaneousAbsorptionAssumption: Assumption = {
  id: 'instantaneous-absorption',
  text: 'Absorption is treated as instantaneous (no ka). The model is a post-absorption approximation and is not valid around Tmax. A true first-order (Bateman) absorption model is planned.',
};

export const modelCards: PKModelCard[] = [
  {
    id: 'ethanol-zero-order-v0',
    analyteSlug: 'ethanol',
    modelType: 'ethanol_zero_order',
    description:
      'Widmark-style zero-order ethanol elimination. Extends the existing /simulator/ethanol math to the KineLab inverse-inference flow.',
    supportedMatrices: ['whole_blood', 'serum', 'plasma'],
    assumptions: [
      {
        id: 'widmark-distribution',
        text: 'Distribution volume (Vd) treated as a single subject-level constant. KineLab computes Vd from the subject panel via Widmark r·weight when both body weight and biological sex are supplied (r ≈ 0.68 male / 0.55 female; sex-unknown spans the male–female range). When the subject panel is empty the engine falls back to a typical-adult uniform Vd of 35–70 L. A Vd override on the priors panel takes precedence over both.',
        i18nKey: 'kinelab.modelCard.ethanol.widmarkDistribution',
      },
      {
        id: 'linear-elimination',
        text: 'Elimination is linear (zero-order) in mg/L per hour throughout the modelled window. The KineLab inverse-inference engine and the priors / report / override surfaces all use mg/L/h; the forward Widmark calculator at /modeling?mode=ethanol presents the same parameter as g/dL/hour for clinical readability.',
        i18nKey: 'kinelab.modelCard.ethanol.linearElimination',
      },
    ],
    limitations: [sharedLiteLimitation],
    validationStatus: 'literature-derived',
  },
  {
    id: 'ghb-one-comp-v0',
    analyteSlug: 'ghb',
    modelType: 'one_comp_first_order_elimination',
    description:
      'One-compartment first-order elimination; absorption treated as instantaneous (no ka).',
    supportedMatrices: ['whole_blood', 'serum', 'urine'],
    assumptions: [
      {
        id: 'first-order-elimination',
        text: 'GHB modelled as first-order even though saturation is documented at high doses; valid only at low/moderate plasma levels.',
      },
    ],
    limitations: [
      sharedLiteLimitation,
      {
        id: 'ghb-saturation',
        text: 'Saturation kinetics not modelled. Inference at high concentrations is unreliable.',
        severity: 'critical',
      },
    ],
    validationStatus: 'toy',
  },
  {
    id: 'ketamine-one-comp-v0',
    analyteSlug: 'ketamine',
    modelType: 'one_comp_first_order_absorption',
    description:
      'One-compartment, instantaneous absorption (no ka): exact for IV, a rough post-absorption approximation for oral.',
    supportedMatrices: ['whole_blood', 'serum', 'plasma'],
    assumptions: [
      instantaneousAbsorptionAssumption,
      {
        id: 'norketamine-not-modelled',
        text: 'Active metabolite norketamine is not modelled; concentrations refer to ketamine only.',
      },
    ],
    limitations: [sharedLiteLimitation],
    validationStatus: 'literature-derived',
  },
  {
    id: 'diazepam-one-comp-v0',
    analyteSlug: 'diazepam',
    modelType: 'one_comp_first_order_absorption',
    description:
      'One-compartment, instantaneous absorption (no ka) with first-order elimination.',
    supportedMatrices: ['whole_blood', 'serum', 'plasma'],
    assumptions: [
      instantaneousAbsorptionAssumption,
      {
        id: 'metabolites-not-modelled',
        text: 'Nordazepam and other long-half-life metabolites are not modelled.',
      },
    ],
    limitations: [
      sharedLiteLimitation,
      {
        id: 'metabolite-confounding',
        text: 'Long-acting metabolites mean parent diazepam alone may underestimate cumulative exposure.',
        severity: 'warning',
      },
    ],
    validationStatus: 'literature-derived',
  },
  {
    id: 'amphetamine-one-comp-v0',
    analyteSlug: 'amphetamine',
    modelType: 'one_comp_first_order_absorption',
    description:
      'One-compartment, instantaneous absorption (no ka) with first-order elimination.',
    supportedMatrices: ['whole_blood', 'serum', 'plasma', 'urine'],
    assumptions: [
      instantaneousAbsorptionAssumption,
      {
        id: 'ph-effect-ignored',
        text: 'Urinary-pH-dependent renal clearance variability is not modelled.',
      },
    ],
    limitations: [sharedLiteLimitation],
    validationStatus: 'toy',
  },
  {
    id: 'morphine-parent-metabolite-v0',
    // Slug must match the analyte id the app derives from `nameEn || name`
    // ('Morphine' → 'morphine'), not the Norwegian 'morfin' — otherwise the
    // card never matches and morphine runs card-less (no matrix policy, no
    // assumptions/limitations surfaced).
    analyteSlug: 'morphine',
    modelType: 'parent_metabolite_simple',
    description: 'Simple parent/metabolite chain (morphine → M3G/M6G).',
    supportedMatrices: ['whole_blood', 'serum', 'plasma'],
    assumptions: [
      {
        id: 'metabolite-fixed-fraction',
        text: 'Metabolite fractions are sampled from a wide prior and assumed time-invariant.',
      },
    ],
    limitations: [
      sharedLiteLimitation,
      {
        id: 'glucuronidation-variability',
        text: 'Inter-individual UGT2B7 variability is encoded only via the Vd/half-life priors, not modelled mechanistically.',
        severity: 'warning',
      },
    ],
    validationStatus: 'toy',
  },
];

const cardsBySlug = new Map(modelCards.map((c) => [c.analyteSlug, c]));
const cardsById = new Map(modelCards.map((c) => [c.id, c]));

export function findModelCardByAnalyte(slug: string): PKModelCard | undefined {
  return cardsBySlug.get(slug);
}

export function findModelCardById(id: string): PKModelCard | undefined {
  return cardsById.get(id);
}
