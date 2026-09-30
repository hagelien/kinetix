/**
 * Reviewed drug-parameter registry — the versioned scientific release.
 *
 * Kinetix owns these values; Redose consumes an exact, checksummed copy. Every
 * parameter is expressed in the core's canonical units (hours, L/kg, 0-1) so the
 * shared engine reproduces a curve independent of either app's internal
 * conventions.
 *
 * Parameters are chosen to reproduce Redose's legacy one-compartment curves for
 * the healthy reference subject, so migrating a substance is a numerically
 * traceable step rather than a silent re-parameterisation. Where legacy Redose
 * applied a behaviour the review does NOT bless (e.g. generic liver/kidney
 * scaling of every drug), the model simply does not declare that covariate —
 * the difference is intentional and documented in the migration report.
 *
 * REGISTRY_VERSION is independent of CORE_VERSION: a parameter-only change bumps
 * the registry version + checksum without a core release.
 *
 * ── Relationship to `data/components.ts` (the live drug catalog) ──────────────
 * This registry is deliberately a PINNED, CHECKSUMMED SNAPSHOT, not a live view
 * of `data/components.ts`. The harmonization plan requires exactly this: "Pin
 * immutable registry releases, never live database/catalog values" (plan §18) so
 * a catalog correction/enrichment can never silently change a curve that a
 * shipped app (or an open Redose session) is pinned to. Consuming the catalog
 * live would reintroduce the drift the pinning exists to prevent.
 *
 * The values here are the reviewed release for the FIRST migration slice, chosen
 * to reproduce Redose's legacy curves for numerical traceability — they are not
 * guaranteed to equal the catalog's current amphetamine entry. Every
 * catalog-checkable parameter now carries a reviewed provenance decision in
 * `provenance.ts` (either `catalog`, enforced to stay within tolerance of
 * `data/components.ts`, or `reviewed-override` with a rationale); the
 * `registry-provenance` cross-check + `scripts/generate-registry-provenance.ts`
 * turn any silent drift into a test failure. This file therefore remains the
 * single reviewed, hand-authored source the portable engine runs against — the
 * catalog cannot fully author it (no absorption rate, single un-split F, noisy
 * auto-extractions) — while the cross-check keeps it honest against the catalog.
 * Its checksum is what Redose pins.
 */
import type { DrugModelDefinition } from './types.js';
import { fixed } from './param.js';
import { hashValue } from './hash.js';
import {
  generatedRegistryCoverageReport,
  loadGeneratedRegistry,
} from './generated-registry-loader.js';
import { buildRegistrySnapshot, type RegistrySnapshot } from './registry-snapshot.js';

export const REGISTRY_VERSION = '0.9.0';

/**
 * Legacy Redose amphetamine one-compartment parameters (both routes share Vd
 * 4.0 L/kg and elimination t½ 660 min = 11 h; only F and absorption differ):
 *   oral       — F 0.80, absorption t½ 60 min  → ka = ln2 / 1.0 h
 *   intranasal — F 0.70, absorption t½ 10 min  → ka = ln2 / (10/60) h
 * Vd is lipophilic (Vd/kg > 2.5), i.e. scaled by total body weight, matching
 * both Redose `scaleVd(..., lipophilic=true)` and Kinetix `resolveFirstOrderVd`.
 */
const AMPHETAMINE: DrugModelDefinition = {
  analyte: 'amphetamine',
  displayName: 'Amphetamine',
  modelId: 'amphetamine-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / 1.0),
      eliminationHalfLifeHours: fixed(11.0),
      vdLitersPerKg: fixed(4.0),
      bioavailability: fixed(0.8),
    },
    intranasal: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (10 / 60)),
      eliminationHalfLifeHours: fixed(11.0),
      vdLitersPerKg: fixed(4.0),
      bioavailability: fixed(0.7),
    },
  },
  references: [
    'Redose legacy one-compartment amphetamine parameters (harmonization baseline).',
  ],
  notes:
    'Vd scaled by total body weight (lipophilic). Generic liver/kidney scaling ' +
    'from the legacy engine is intentionally NOT applied — see migration report.',
};

/**
 * Cocaine — the FULL reviewed model (plan B1 adjudication: ship the reviewed
 * literature values, NOT a mirror of Redose's legacy parameters). This is a
 * DELIBERATE, documented curve change from legacy:
 *   - Vd 2.7 L/kg (Jeffcoat 1989 Vβ = 2.70 L/kg) vs legacy 2.0; and 2.7 > 2.5 →
 *     lipophilic → `total-weight` scaling (default), vs legacy's lean-body-mass;
 *   - terminal t½ 1.5 h (upper end of the catalog 0.5–1.5 h range; Jeffcoat's
 *     elimination t½ is ~1.1–1.3 h, Chow ~1 h) vs legacy 1.0 h;
 *   - intranasal F 0.80 (Jeffcoat 1989 measured) vs legacy 0.30.
 * The smoked (→ `inhalation`) and oral routes are added so every Redose cocaine
 * route resolves through the shared core.
 *
 * All bioavailability and absorption values are the reviewed literature values
 * (plan B1: ship the evidence, not a legacy mirror), with each parameter traceable
 * to a named paper (see `references` below and `provenance.ts`).
 *
 * Routes (disposition shared: Vd 2.7 L/kg total-weight, terminal t½ 1.5 h):
 *   - intranasal   — F 0.80, absorption t½ 11.7 min (Jeffcoat 1989 nasal insufflation)
 *   - inhalation   — F 0.57 (smoked/crack; Jeffcoat 1989 observed smoked
 *     bioavailability, reduced from the ~0.80 of intact drug by pyrolytic
 *     degradation on heating), absorption t½ 1.1 min (Jeffcoat smoke inhalation).
 *     Redose's `smoked` route normalises to this canonical `inhalation` route.
 *   - oral         — F 0.33 (extensive first-pass; Wilkinson 1980), absorption
 *     t½ 30 min (route-typical oral, Wilkinson oral kinetics tmax ~1 h)
 *   - iv           — the reviewed `iv-one-compartment` family (bolus C(0)=dose/Vd,
 *     then first-order decay; F = 1). An IV bolus is NOT a rising Bateman curve, so
 *     it must not share the absorption family.
 */
const COCAINE: DrugModelDefinition = {
  analyte: 'cocaine',
  displayName: 'Cocaine',
  modelId: 'cocaine-one-comp-v2',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    intranasal: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (11.7 / 60)),
      eliminationHalfLifeHours: fixed(1.5),
      vdLitersPerKg: fixed(2.7),
      bioavailability: fixed(0.8),
    },
    inhalation: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (1.1 / 60)),
      eliminationHalfLifeHours: fixed(1.5),
      vdLitersPerKg: fixed(2.7),
      bioavailability: fixed(0.57),
    },
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (30 / 60)),
      eliminationHalfLifeHours: fixed(1.5),
      vdLitersPerKg: fixed(2.7),
      bioavailability: fixed(0.33),
    },
    iv: {
      family: 'iv-one-compartment',
      eliminationHalfLifeHours: fixed(1.5),
      vdLitersPerKg: fixed(2.7),
    },
  },
  references: [
    // Multi-route disposition; the primary source for intranasal + smoked
    // bioavailability, per-route absorption rates, and the distribution volume:
    'Jeffcoat AR, Perez-Reyes M, Hill JM, Sadler BM, Cook CE. Cocaine disposition in humans after intravenous injection, nasal insufflation (snorting), or smoking. Drug Metab Dispos. 1989;17(2):153-159. (Vβ 2.70 L/kg; intranasal F 0.80, absorption t½ 11.7 min; smoked F ~0.57, absorption t½ 1.1 min; elimination t½ ~69-78 min)',
    // Intranasal + oral kinetics; oral first-pass bioavailability + absorption:
    'Wilkinson P, Van Dyke C, Jatlow P, Barash P, Byck R. Intranasal and oral cocaine kinetics. Clin Pharmacol Ther. 1980;27(3):386-394. (oral F ~0.32; oral absorption tmax ~1 h)',
    // Corroborating distribution volume + elimination half-life:
    'Chow MJ, Ambre JJ, Ruo TI, Atkinson AJ, Bowsher DJ, Fischman MW. Kinetics of cocaine distribution, elimination, and chronotropic effects. Clin Pharmacol Ther. 1985;38(3):318-324. (Vd ~1.6-2.7 L/kg; t½ ~1 h)',
    'Cone EJ. Pharmacokinetics and pharmacodynamics of cocaine. J Anal Toxicol. 1995;19(6):459-478. (review; corroborates rapid smoked absorption)',
  ],
  notes:
    'Reviewed model — a deliberate curve change from Redose legacy (Vd 2.0→2.7, ' +
    'lean-body-mass→total-weight, t½ 1.0→1.5 h, intranasal F 0.30→0.80). Vd 2.7 L/kg ' +
    'lipophilic → total-weight scaling. Generic liver/kidney scaling NOT applied. ' +
    'Every bioavailability + absorption value is the reviewed literature value: ' +
    'intranasal F 0.80 / t½ 11.7 min and smoked F 0.57 / t½ 1.1 min from Jeffcoat 1989 ' +
    '(smoked bioavailability is the OBSERVED value, reduced from intact-drug absorption ' +
    'by pyrolytic degradation on heating — NOT rounded up to a conservative estimate); ' +
    'oral F 0.33 / absorption tmax ~1 h from Wilkinson 1980.',
};

/**
 * Linear-model migration wave (plan K6 / Redose R5). Each entry MIRRORS Redose's
 * legacy one-compartment parameters so migrating the substance is a numerically
 * traceable step (identical curve for a healthy subject), not a silent
 * re-parameterisation. Legacy absorption/elimination half-lives are in MINUTES;
 * they are converted to the core's canonical hours here (ka = ln2 / t½_abs).
 *
 * All three are hydrophilic (Vd ≤ 2.5 L/kg), so their Vd uses `lean-body-mass`
 * scaling — reproducing legacy `scaleVd(..., lipophilic=false)` exactly (Vd·70·
 * LBM/56) rather than the total-weight scaling amphetamine uses. As with
 * amphetamine, the generic liver/kidney disease scaling the legacy engine applied
 * is intentionally NOT modelled (declared covariates are weight/height/sex only).
 */
const METHYLPHENIDATE: DrugModelDefinition = {
  analyte: 'methylphenidate',
  displayName: 'Methylphenidate',
  modelId: 'methylphenidate-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg', 'heightCm', 'sex'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (45 / 60)),
      eliminationHalfLifeHours: fixed(150 / 60),
      vdLitersPerKg: fixed(2.5),
      bioavailability: fixed(0.3),
      vdScaling: 'lean-body-mass',
    },
    intranasal: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (8 / 60)),
      eliminationHalfLifeHours: fixed(150 / 60),
      vdLitersPerKg: fixed(2.5),
      bioavailability: fixed(0.55),
      vdScaling: 'lean-body-mass',
    },
  },
  references: [
    'Redose legacy one-compartment methylphenidate parameters (harmonization baseline).',
  ],
  notes:
    'Vd uses lean-body-mass scaling (hydrophilic). Generic liver/kidney scaling ' +
    'from the legacy engine is intentionally NOT applied — see migration report.',
};

const LSD: DrugModelDefinition = {
  analyte: 'lsd',
  displayName: 'LSD',
  modelId: 'lsd-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg', 'heightCm', 'sex'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    sublingual: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (45 / 60)),
      eliminationHalfLifeHours: fixed(180 / 60),
      vdLitersPerKg: fixed(0.65),
      bioavailability: fixed(0.7),
      vdScaling: 'lean-body-mass',
    },
  },
  references: [
    'Redose legacy one-compartment LSD parameters (harmonization baseline).',
  ],
  notes:
    'Vd uses lean-body-mass scaling (hydrophilic). Generic liver/kidney scaling ' +
    'from the legacy engine is intentionally NOT applied — see migration report.',
};

const TWO_CB: DrugModelDefinition = {
  analyte: '2cb',
  displayName: '2C-B',
  modelId: '2cb-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg', 'heightCm', 'sex'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (45 / 60)),
      eliminationHalfLifeHours: fixed(180 / 60),
      vdLitersPerKg: fixed(2.0),
      bioavailability: fixed(0.7),
      vdScaling: 'lean-body-mass',
    },
    intranasal: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (8 / 60)),
      eliminationHalfLifeHours: fixed(180 / 60),
      vdLitersPerKg: fixed(2.0),
      bioavailability: fixed(0.65),
      vdScaling: 'lean-body-mass',
    },
  },
  references: [
    'Redose legacy one-compartment 2C-B parameters (harmonization baseline).',
  ],
  notes:
    'Vd uses lean-body-mass scaling (hydrophilic). Generic liver/kidney scaling ' +
    'from the legacy engine is intentionally NOT applied — see migration report.',
};

/** Recursively freeze an object so a returned model cannot be mutated in place. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * THC — two-compartment model with first-order absorption (nonlinear/ODE family,
 * plan K8). MIRRORS Redose's legacy `lib/pk/models/two-compartment.ts` parameters
 * so the migration is numerically traceable. Legacy k12/k21 are per MINUTE and
 * absorption/elimination half-lives per minute; converted to the core's canonical
 * per-hour / hour here. Disposition (k12/k21/terminal t½/central V1) is shared
 * across routes (a drug property); only absorption and F differ by route. Central
 * V1 (0.27 L/kg) scales by total body weight, matching legacy `scaleVd(..., true)`.
 */
const THC: DrugModelDefinition = {
  analyte: 'thc',
  displayName: 'THC',
  modelId: 'thc-two-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    inhalation: {
      family: 'two-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (2 / 60)),
      eliminationHalfLifeHours: fixed(1680 / 60),
      k12PerHour: fixed(0.152 * 60),
      k21PerHour: fixed(0.0173 * 60),
      vdLitersPerKg: fixed(0.27),
      bioavailability: fixed(0.25),
    },
    oral: {
      family: 'two-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (60 / 60)),
      eliminationHalfLifeHours: fixed(1680 / 60),
      k12PerHour: fixed(0.152 * 60),
      k21PerHour: fixed(0.0173 * 60),
      vdLitersPerKg: fixed(0.27),
      bioavailability: fixed(0.06),
    },
  },
  references: [
    'Redose legacy two-compartment THC parameters (harmonization baseline; Huestis 2007, Grotenhermen 2003).',
  ],
  notes:
    'Central V1 (0.27 L/kg) scaled by total body weight; tissue loading is in ' +
    'k12/k21, not V1. Generic liver/kidney scaling intentionally NOT applied.',
};

/**
 * GHB — Michaelis–Menten (saturable) elimination. Ported from Redose's
 * `simulateGHB`. Legacy params are ng/mL + minutes; the canonical registry carries
 * mg/L + hours, converted once here (1 ng/mL = 0.001 mg/L, ×60 for min→h rates):
 *   Vmax 833 ng/mL/min → 833·0.001·60 = 49.98 mg/L/h
 *   Km   40000 ng/mL   → 40000·0.001  = 40 mg/L
 *   ka   ln2 / (10 min) ; F 0.60 ; nominal terminal t½ 72 min (display/horizon).
 * Vd 0.4 L/kg is hydrophilic → `lean-body-mass` scaling (legacy `scaleVd(..,false)`).
 * Not switched in production (Redose registers it via a later re-vendor); landed
 * here with a fixture-tested route so the family has a real substance.
 */
const GHB: DrugModelDefinition = {
  analyte: 'ghb',
  displayName: 'GHB',
  modelId: 'ghb-michaelis-menten-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg', 'heightCm', 'sex'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    oral: {
      family: 'michaelis-menten',
      kaPerHour: fixed(Math.LN2 / (10 / 60)),
      vmaxMgPerLPerHour: fixed(833 * 0.001 * 60),
      kmMgPerL: fixed(40000 * 0.001),
      eliminationHalfLifeHours: fixed(72 / 60),
      vdLitersPerKg: fixed(0.4),
      bioavailability: fixed(0.6),
      vdScaling: 'lean-body-mass',
    },
  },
  references: [
    'Redose legacy Michaelis–Menten GHB parameters (harmonization baseline; Brenneisen 2004).',
  ],
  notes:
    'Saturable elimination (Vmax/Km); the terminal half-life is nominal (horizon ' +
    'only). Vd uses lean-body-mass scaling (hydrophilic). Generic liver/kidney ' +
    'scaling intentionally NOT applied.',
};

/**
 * Ethanol — Michaelis–Menten (zero-order at typical BAC). Ported from Redose's
 * `simulateEthanol`. Legacy params are g/dL + minutes; the canonical registry
 * carries mg/L + hours (1 g/dL = 10000 mg/L, ×60 for min→h):
 *   Vmax 0.000283 g/dL/min → 0.000283·10000·60 = 169.8 mg/L/h (≈ 0.017 g/dL/h)
 *   Km   0.008 g/dL        → 0.008·10000        = 80 mg/L
 *   ka   ln2 / (15 min) ; F 0.85 ; nominal terminal t½ 360 min (display/horizon).
 * Ethanol Vd is the Widmark volume weight·r, so it uses `widmark` scaling with
 * `vdLitersPerKg = 1` (the subject-derived r-factor carries the composition).
 * Not switched in production (fed/fasted handling is a later Redose migration).
 */
const ETHANOL: DrugModelDefinition = {
  analyte: 'ethanol',
  displayName: 'Ethanol',
  modelId: 'ethanol-michaelis-menten-v1',
  matrix: 'whole_blood',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg', 'heightCm', 'age', 'sex'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    oral: {
      family: 'michaelis-menten',
      kaPerHour: fixed(Math.LN2 / (15 / 60)),
      vmaxMgPerLPerHour: fixed(0.000283 * 10000 * 60),
      kmMgPerL: fixed(0.008 * 10000),
      eliminationHalfLifeHours: fixed(360 / 60),
      vdLitersPerKg: fixed(1),
      bioavailability: fixed(0.85),
      vdScaling: 'widmark',
    },
  },
  references: [
    'Redose legacy Michaelis–Menten ethanol parameters (harmonization baseline; Widmark; Holford 1987).',
  ],
  notes:
    'Zero-order-like saturable elimination (Vmax/Km); terminal half-life is nominal ' +
    '(horizon only). Vd uses Widmark scaling (weight·r); vdLitersPerKg = 1 carries ' +
    'the subject r-factor. Fed/fasted absorption context not yet modelled.',
};

/**
 * MDMA — Michaelis–Menten (saturable) elimination via CYP2D6 auto-inhibition.
 * Ported from Redose's `simulateMDMA`. The reviewed Redose model implements the
 * auto-inhibition as PLAIN Michaelis–Menten clearance (Vmax·C/(Km+C), identical
 * math to ethanol/GHB) — clearance saturates as concentration rises, so a redose
 * produces a disproportionate concentration bump. It therefore reuses the same
 * `michaelis-menten` family rather than a separate one (master plan §4:
 * consolidate, don't duplicate). Legacy ng/mL + minutes → canonical mg/L + hours:
 *   Vmax 100 ng/mL/min → 100·0.001·60 = 6.0 mg/L/h ; Km 250 ng/mL → 0.25 mg/L
 *   ka   ln2 / (45 min) ; F 0.70 ; nominal terminal t½ 480 min (display/horizon).
 * Vd 6.5 L/kg is lipophilic → `total-weight` scaling (legacy `scaleVd(..,true)`).
 */
const MDMA: DrugModelDefinition = {
  analyte: 'mdma',
  displayName: 'MDMA',
  modelId: 'mdma-michaelis-menten-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    oral: {
      family: 'michaelis-menten',
      kaPerHour: fixed(Math.LN2 / (45 / 60)),
      vmaxMgPerLPerHour: fixed(100 * 0.001 * 60),
      kmMgPerL: fixed(250 * 0.001),
      eliminationHalfLifeHours: fixed(480 / 60),
      vdLitersPerKg: fixed(6.5),
      bioavailability: fixed(0.7),
      vdScaling: 'total-weight',
    },
  },
  references: [
    'Redose legacy Michaelis–Menten MDMA parameters (harmonization baseline; de la Torre 2004 — CYP2D6 auto-inhibition).',
  ],
  notes:
    'CYP2D6 auto-inhibition modelled as saturable Michaelis–Menten clearance ' +
    '(same math as ethanol/GHB); the terminal half-life is nominal (horizon only). ' +
    'Vd 6.5 L/kg lipophilic → total-weight scaling. Generic liver/kidney scaling NOT applied.',
};

/**
 * Lisdexamfetamine — an inactive prodrug of dextroamphetamine. The reviewed Redose
 * model does NOT implement an explicit parent→metabolite hydrolysis ODE: red-blood-
 * cell hydrolysis is rate-limited but near-complete, so the reviewed engine models
 * the RELEASED d-amphetamine curve with a plain one-compartment model whose slow
 * "absorption" (t½ 75 min) reproduces the rate-limited conversion (later Tmax ~4.4 h,
 * flatter peak) and whose F (0.30) folds the ~0.295 mg-amphetamine-per-mg-prodrug
 * mass conversion together with near-complete availability. The released
 * d-amphetamine then shares amphetamine's disposition (Vd 4.0 L/kg, t½ 11 h).
 *
 * It therefore registers on the existing `one-compartment-first-order` family — a
 * faithful port of the reviewed curve. Building an explicit prodrug-transformation
 * ODE (RBC hydrolysis + separate parent/metabolite disposition) would be UNREVIEWED
 * new science requiring clinical PK validation, which the harmonization plan's
 * "port reviewed models, don't invent" rule (plan §17) excludes. The amphetamine-
 * class cumulative-dose combination (activeMoiety / moietyEquivalentFactor) is a
 * Redose app-level SAFETY concern, not a core curve transformation.
 *
 * The dose basis is `parent` (mg of lisdexamfetamine dimesylate, the capsule
 * number); F folds the conversion to circulating d-amphetamine.
 */
const LISDEXAMFETAMINE: DrugModelDefinition = {
  analyte: 'lisdexamfetamine',
  displayName: 'Lisdexamfetamine',
  modelId: 'lisdexamfetamine-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg'],
  supportedBases: ['parent'],
  routes: {
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (75 / 60)),
      eliminationHalfLifeHours: fixed(660 / 60),
      vdLitersPerKg: fixed(4.0),
      bioavailability: fixed(0.3),
    },
  },
  references: [
    'Redose legacy one-compartment lisdexamfetamine parameters (harmonization baseline; prodrug of d-amphetamine).',
  ],
  notes:
    'Prodrug modelled as the released d-amphetamine one-compartment curve: slow ' +
    'absorption (t½ 75 min) = rate-limited RBC hydrolysis; F 0.30 folds the ~0.295 ' +
    'mass conversion. Vd 4.0 L/kg lipophilic → total-weight. No explicit ' +
    'parent/metabolite ODE (unreviewed); amphetamine-class dose summation is app-level.',
};

/**
 * Ketamine — one-compartment, mirrored from Redose. Vd 3.0 L/kg is lipophilic
 * (> 2.5) → total-weight scaling. Shared disposition across routes: terminal
 * elimination t½ 2.5 h (150 min). Three reviewed routes: intranasal (F 0.35,
 * absorption t½ 5 min), IM (F 0.93, t½ 3 min), oral (F 0.20, t½ 15 min).
 *
 * The catalog's auto-extracted 0.17–0.25 h half-life is the α (distribution)
 * phase; the reviewed terminal t½ (2.5 h) is what a one-compartment elimination
 * model uses — a documented reviewed-override (the "half-life discrepancy" the
 * completion plan flags), not drift.
 */
const KETAMINE: DrugModelDefinition = {
  analyte: 'ketamine',
  displayName: 'Ketamine',
  modelId: 'ketamine-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg'],
  supportedBases: ['active-moiety', 'parent'],
  routes: {
    intranasal: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (5 / 60)),
      eliminationHalfLifeHours: fixed(150 / 60),
      vdLitersPerKg: fixed(3.0),
      bioavailability: fixed(0.35),
    },
    im: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (3 / 60)),
      eliminationHalfLifeHours: fixed(150 / 60),
      vdLitersPerKg: fixed(3.0),
      bioavailability: fixed(0.93),
    },
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (15 / 60)),
      eliminationHalfLifeHours: fixed(150 / 60),
      vdLitersPerKg: fixed(3.0),
      bioavailability: fixed(0.2),
    },
  },
  references: [
    'Redose legacy one-compartment ketamine parameters (harmonization baseline; terminal t½ 2.5 h).',
  ],
  notes:
    'Vd 3.0 L/kg lipophilic → total-weight scaling. Terminal t½ 2.5 h (the catalog ' +
    'α-phase 0.17–0.25 h is a distribution phase, not terminal elimination). Generic ' +
    'liver/kidney scaling intentionally NOT applied.',
};

/**
 * Psilocybin — one-compartment, mirrored from Redose. Psilocybin is itself a
 * prodrug dephosphorylated to psilocin (the active moiety); like lisdexamfetamine,
 * the reviewed engine models the active-moiety-equivalent curve directly with a
 * single one-compartment model (F 0.50 folds oral availability + conversion),
 * NOT an explicit prodrug ODE. Vd 1.0 L/kg is hydrophilic (≤ 2.5) → lean-body-mass
 * scaling; terminal t½ 2.5 h, oral absorption t½ 30 min. The catalog identity is
 * `psilocin` (pubchem 4980) — psilocybin itself is not a catalog row.
 */
const PSILOCYBIN: DrugModelDefinition = {
  analyte: 'psilocybin',
  // The curve is the psilocin active moiety; the catalog/analytical identity is
  // `psilocin` (pubchem 4980), so resolve it under that id too.
  aliases: ['psilocin'],
  displayName: 'Psilocybin',
  modelId: 'psilocybin-one-comp-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedCovariates: ['weightKg', 'heightCm', 'sex'],
  // Parent-dose basis ONLY: F 0.50 folds the psilocybin→psilocin conversion (like
  // lisdexamfetamine). Accepting `active-moiety` would let a caller pass
  // psilocin-equivalent mg and have the conversion applied a second time,
  // underestimating concentrations — so the psilocin moiety basis is not supported.
  supportedBases: ['parent'],
  routes: {
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(Math.LN2 / (30 / 60)),
      eliminationHalfLifeHours: fixed(150 / 60),
      vdLitersPerKg: fixed(1.0),
      bioavailability: fixed(0.5),
      vdScaling: 'lean-body-mass',
    },
  },
  references: [
    'Redose legacy one-compartment psilocybin parameters (harmonization baseline; modelled as psilocin-equivalent).',
  ],
  notes:
    'Psilocybin → psilocin prodrug modelled directly as the psilocin-equivalent ' +
    'one-compartment curve (F 0.50 folds conversion + oral availability), no explicit ' +
    'prodrug ODE. Vd 1.0 L/kg hydrophilic → lean-body-mass scaling. Generic ' +
    'liver/kidney scaling intentionally NOT applied.',
};

// Freeze the reviewed release so `findModel()` hands out immutable models — a
// consumer cannot silently alter parameters for later simulations while the
// manifest's REGISTRY_CHECKSUM still claims the original reviewed release.
const DEFINITIONS: DrugModelDefinition[] = [
  AMPHETAMINE,
  COCAINE,
  METHYLPHENIDATE,
  LSD,
  TWO_CB,
  THC,
  GHB,
  ETHANOL,
  MDMA,
  LISDEXAMFETAMINE,
  KETAMINE,
  PSILOCYBIN,
].map(deepFreeze);

// Keyed by primary analyte AND any declared aliases, so a consumer resolving by a
// catalog/analytical-method identity (e.g. `psilocin` for the psilocybin model)
// finds the same curve. A collision (an alias equal to another model's analyte or
// alias) is a registry authoring error and throws at module load.
const BY_ANALYTE: Map<string, DrugModelDefinition> = new Map();
for (const d of DEFINITIONS) {
  for (const key of [d.analyte, ...(d.aliases ?? [])]) {
    if (BY_ANALYTE.has(key)) {
      throw new Error(`Registry key collision: "${key}" is used by more than one model`);
    }
    BY_ANALYTE.set(key, d);
  }
}

/** Look up a reviewed model by canonical analyte id (or a declared alias). */
export function findModel(analyte: string): DrugModelDefinition | undefined {
  return BY_ANALYTE.get(analyte);
}

/**
 * PRIMARY analyte ids only (one per model), for provenance / reporting where each
 * model must be visited exactly once. For the full set a consumer can resolve —
 * primary ids plus aliases — use `supportedAnalyteIds()`.
 */
export function registeredAnalytes(): string[] {
  return DEFINITIONS.map((d) => d.analyte);
}

/**
 * Every analyte id `findModel()` resolves — each model's primary analyte AND its
 * aliases (e.g. both `psilocybin` and `psilocin`). A consumer building its
 * supported-analyte set (to decide what it can simulate) should use THIS, so a
 * model is not treated as unsupported under its catalog/analytical identity.
 */
export function supportedAnalyteIds(): string[] {
  return DEFINITIONS.flatMap((d) => [d.analyte, ...(d.aliases ?? [])]);
}

/**
 * Checksum of the full registry release (version + all definitions). Any change
 * to a parameter changes this fingerprint, so a session pinned to a checksum can
 * detect it is looking at a different release.
 */
export const REGISTRY_CHECKSUM: string = hashValue({
  version: REGISTRY_VERSION,
  definitions: DEFINITIONS,
});


/**
 * Rollout switch; false/default retains the reviewed-only release.
 *
 * **`import.meta.env` MUST be written as one literal member expression here.** Vite replaces
 * `import.meta.env` statically at build time by matching that expression in the source. Reading it
 * through an alias (`const meta = import.meta; meta.env?.X`) does not match, so nothing is
 * replaced — and the minifier then inlines the alias back, emitting a live `import.meta.env` into
 * the bundle. A browser ES module has no `env` on `import.meta`, so the optional chain
 * short-circuits and this returns `false` however the environment variable is set: the flag is
 * silently dead in production while every test passes, because vitest provides a real
 * `import.meta.env` for `vi.stubEnv` to write to. That is exactly how this shipped once.
 * `tests/env-flag-static-replacement.test.ts` pins the form.
 *
 * Outside a Vite build (the API, the generation script, a plain Node import) `import.meta.env` is
 * undefined and the optional chain answers `false` — the reviewed-only release, which is the
 * correct default for a consumer with no build-time flag.
 */
export function derivedRegistryRolloutEnabled(): boolean {
  return import.meta.env?.VITE_DERIVED_REGISTRY_ENABLED === 'true';
}

// ─── CV-5 — what the APP resolves ───────────────────────────────────────────────
//
// `DEFINITIONS`, `findModel`, `registeredAnalytes` and `supportedAnalyteIds` are the
// REVIEWED tier and stay that way: the generation step reconstructs the override tier
// from them, so widening them would feed derived models back into their own input.
// The accessors below are what a RENDERING consumer resolves through — the reviewed
// tier alone, or the reviewed tier plus the committed derived entries when the rollout
// flag is on. The release is memoised because the flag is a build-time constant and
// `buildRegistrySnapshot` deep-clones and freezes on every call.

let RESOLVABLE_SNAPSHOT: RegistrySnapshot | null = null;
let RESOLVABLE_BY_ANALYTE: Map<string, DrugModelDefinition> | null = null;

function resolvableSnapshot(): RegistrySnapshot {
  if (RESOLVABLE_SNAPSHOT === null) {
    RESOLVABLE_SNAPSHOT = loadOfflineRegistry().snapshot;
  }
  return RESOLVABLE_SNAPSHOT;
}

function resolvableRelease(): DrugModelDefinition[] {
  return resolvableSnapshot().definitions;
}

/**
 * Version and checksum of the release a rendering consumer actually resolves through.
 *
 * NOT `REGISTRY_CHECKSUM`, and the difference is only observable once the derived tier is
 * non-empty. That constant fingerprints the REVIEWED tier alone; with the rollout flag on,
 * `resolveModel` hands back models from a release that also carries the committed derived
 * entries and therefore hashes differently. A run manifest stamped with the reviewed
 * constant while serving a derived model claims a release that does not contain that model
 * — which defeats checksum-based replay exactly when someone tries to reproduce the curve
 * they are least sure about.
 *
 * While both tiers hashed to the same value (an empty derived tier) the two were
 * indistinguishable, so this could not be caught by inspection; it is pinned by tests
 * instead.
 */
export function resolvedRegistryRelease(): { version: string; checksum: string } {
  const snapshot = resolvableSnapshot();
  return { version: snapshot.version, checksum: snapshot.checksum };
}

function resolvableByAnalyte(): Map<string, DrugModelDefinition> {
  if (RESOLVABLE_BY_ANALYTE === null) {
    const map = new Map<string, DrugModelDefinition>();
    for (const d of resolvableRelease()) {
      for (const key of [d.analyte, ...(d.aliases ?? [])]) map.set(key, d);
    }
    RESOLVABLE_BY_ANALYTE = map;
  }
  return RESOLVABLE_BY_ANALYTE;
}

/**
 * Resolve a model a RENDERING consumer may simulate: the reviewed tier, plus the
 * committed derived tier when the rollout flag is on. An override always wins a shared
 * analyte (the merge primitive guarantees it), so this can never hand back a derived
 * model where a reviewed one exists.
 */
export function resolveModel(analyte: string): DrugModelDefinition | undefined {
  return resolvableByAnalyte().get(analyte);
}

/** Every analyte id `resolveModel()` resolves — primary ids plus aliases. */
export function resolvableAnalyteIds(): string[] {
  return [...resolvableByAnalyte().keys()];
}

/** Offline registry release selected by the rollout flag, including explicit coverage diagnostics. */
export function loadOfflineRegistry() {
  if (!derivedRegistryRolloutEnabled()) {
    return {
      snapshot: buildRegistrySnapshot(DEFINITIONS, [], REGISTRY_VERSION),
      notModelable: generatedRegistryCoverageReport(),
    };
  }
  return loadGeneratedRegistry(DEFINITIONS);
}
