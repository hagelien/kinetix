/**
 * Grade a derived model (CV-3, catalog-coverage track).
 *
 * CV-2 turns a drug's stored declarations + parameters into a `DerivedModel`: runnable or not, with
 * the disclosed-default axes and the missing parameters recorded. CV-3 puts a **grade** on that —
 * the honest, prominent signal that a catalog-derived curve is a disclosed assumption, not a
 * reviewed model. The grade drives the uncertainty-band widening (CV-3b, `gradeBandWidening` below)
 * and the disclaimer surface (CV-3c, a Redose UI slice), so "honesty is in the curve".
 *
 * **Weakest-link grading.** The overall grade is the WORST of five independent factor sub-grades —
 * a chain is only as strong as its weakest link, so a single serious deficiency caps the whole
 * grade and the report names the limiting factor. This is the conservative reading the plan's
 * "missing stays missing" asks for: a fully-parameterised model whose disposition axis was only a
 * disclosed default cannot score above what that defaulted structure earns. The five factors:
 *
 *   - **structure**   — how much of the model SHAPE was asserted vs a disclosed default (CV-2a).
 *   - **completeness** — how many of the family's required parameters the catalog could not supply.
 *   - **parameterInference** — how many required parameters were INFERRED from a different stored
 *     observable rather than read from a cited value of their own (today: `ka` solved from `tmax`
 *     and the elimination half-life, `ka-inference.ts`). An inferred parameter is present, so it
 *     does not count as missing — but it is an assumption wearing a number, and a model resting on
 *     one is capped at `C` so it can never read as reviewed evidence.
 *   - **sourceQuality** — the quality/agreement of the parameter pool the numbers came from (a
 *     Redose-aggregation judgement the caller supplies; this module stays portable and does not
 *     read the DB).
 *   - **validation**  — the model's SC-7A external-validation status. `A` is EARNED by validation:
 *     an unvalidated model is at best `literature-derived`, so the top grade is reserved for a model
 *     that has actually been checked against data.
 *
 * A `not-modelable` derivation is `ungraded` (no curve to grade). Everything modelable is graded
 * and — per the rollout decision — renders a curve however heavily disclaimed (the minimum render
 * grade is `D`); `rendersCurve` is where that gate lives if it is ever tightened.
 *
 * Pure and additive: no equation/solver/scenario change, so no `CORE_VERSION` bump. The A–D
 * thresholds are isolated as named tables below so the scheme stays tunable (plan §8).
 */
import type { DerivedModel } from './derive-model.js';
import type { RequiredParam } from './model-structure.js';
import type { ValidationStatus } from './types.js';

/** A–D model grade. `A` best (validated, complete, asserted, well-sourced); `D` worst but still a
 *  rendered, disclaimed curve. A `not-modelable` derivation has no grade (see `GradedModel`). */
export type ModelGrade = 'A' | 'B' | 'C' | 'D';

/** The five independent factors that each earn a sub-grade; the overall grade is the worst of them. */
export type GradeFactor =
  | 'structure'
  | 'completeness'
  | 'parameterInference'
  | 'sourceQuality'
  | 'validation';

/** Best→worst. Index is the "badness" rank used to pick the weakest link. */
const GRADE_ORDER: readonly ModelGrade[] = ['A', 'B', 'C', 'D'];

/** The minimum overall grade that still renders a curve to end users (plan §8 rollout decision:
 *  render everything gradable — only a `not-modelable` derivation shows no curve). */
export const MIN_RENDER_GRADE: ModelGrade = 'D';

function rankOf(g: ModelGrade): number {
  return GRADE_ORDER.indexOf(g);
}

/** One factor's contribution to the grade: its sub-grade and a human-readable reason. */
export interface GradeFactorResult {
  factor: GradeFactor;
  grade: ModelGrade;
  detail: string;
}

/** The graded outcome of a derived model. */
export interface GradedModel {
  /** `graded`: a modelable family with an A–D grade. `ungraded`: `not-modelable`, no curve. */
  outcome: 'graded' | 'ungraded';
  /** The overall (weakest-link) grade, when graded. */
  grade?: ModelGrade;
  /** Which factor set the overall grade (the weakest link), when graded. Ties resolve to the first
   *  factor in evaluation order (structure, completeness, parameterInference, sourceQuality,
   *  validation). */
  limitingFactor?: GradeFactor;
  /** Every factor's sub-grade, in evaluation order — the transparent breakdown behind the grade. */
  factors: GradeFactorResult[];
  /** Why there is no grade, when ungraded (carried from the derivation). */
  reason?: string;
}

/** Inputs the caller supplies alongside the derivation — judgements this portable module cannot
 *  make itself (the source pool's quality) or that live outside the derivation (validation). */
export interface GradeInputs {
  /**
   * The quality/agreement sub-grade of the parameter pool the numbers came from — a Redose
   * aggregation judgement (review scores + between-source agreement). Absent means "not assessed",
   * graded conservatively (`C`): an unquantified provenance must not earn an A/B.
   */
  sourceQuality?: ModelGrade;
  /**
   * The model's SC-7A external-validation status. Absent defaults to `literature-derived`: a
   * freshly-derived catalog model is built from literature but has not itself been validated, so it
   * is capped at `B` until it is — `A` is earned only by validation.
   */
  validationStatus?: ValidationStatus;
  /**
   * Required parameter roles whose value was INFERRED from another stored observable rather than
   * read from a cited value of their own. Absent/empty means every value came from the catalog
   * directly. The read adapter records these when it applies an inference (today only `ka`, solved
   * from `tmax`); they are graded here and disclosed at the curve, never silently absorbed.
   */
  inferredParameters?: readonly RequiredParam[];
}

/** Structure sub-grade from the count of axes that were a disclosed default rather than asserted. */
function structureGrade(defaultedAxisCount: number): GradeFactorResult {
  const grade: ModelGrade =
    defaultedAxisCount <= 0 ? 'A' : defaultedAxisCount === 1 ? 'B' : defaultedAxisCount === 2 ? 'C' : 'D';
  const detail =
    defaultedAxisCount <= 0
      ? 'all three model-structure axes were asserted from the drug’s declarations'
      : `${defaultedAxisCount} of 3 model-structure axes fell back to the disclosed linear one-compartment default`;
  return { factor: 'structure', grade, detail };
}

/** Completeness sub-grade from the count of required parameter roles the catalog could not supply. */
function completenessGrade(missingCount: number): GradeFactorResult {
  const grade: ModelGrade =
    missingCount <= 0 ? 'A' : missingCount === 1 ? 'B' : missingCount === 2 ? 'C' : 'D';
  const detail =
    missingCount <= 0
      ? 'every parameter the family requires has a catalog value'
      : `${missingCount} required parameter${missingCount === 1 ? '' : 's'} absent from the catalog`;
  return { factor: 'completeness', grade, detail };
}

/**
 * Parameter-inference sub-grade from the count of required roles solved from another observable.
 *
 * Capped at `C` for a single inference rather than `B`: an inferred parameter is a stronger claim
 * than an absent one (which grades `B` on completeness), because it produces a specific number that
 * a reader cannot tell apart from a cited one without the disclosure. `C` is the exploratory tier,
 * which is exactly what a model resting on a solved rate constant is.
 */
function parameterInferenceGrade(inferredCount: number): GradeFactorResult {
  const grade: ModelGrade = inferredCount <= 0 ? 'A' : inferredCount === 1 ? 'C' : 'D';
  const detail =
    inferredCount <= 0
      ? 'every parameter came from a catalog value of its own'
      : `${inferredCount} required parameter${inferredCount === 1 ? ' was' : 's were'} inferred from another stored observable rather than cited directly`;
  return { factor: 'parameterInference', grade, detail };
}

/** Source-quality sub-grade — the caller's judgement, or a conservative `C` when not assessed. */
function sourceQualityGrade(sourceQuality: ModelGrade | undefined): GradeFactorResult {
  if (sourceQuality === undefined) {
    return {
      factor: 'sourceQuality',
      grade: 'C',
      detail: 'source quality/agreement not assessed — graded conservatively',
    };
  }
  return {
    factor: 'sourceQuality',
    grade: sourceQuality,
    detail: `source pool quality/agreement graded ${sourceQuality}`,
  };
}

/** Validation sub-grade from the SC-7A status; `A` is reserved for a model actually validated. */
const VALIDATION_GRADE: Record<ValidationStatus, ModelGrade> = {
  validated: 'A',
  'literature-derived': 'B',
  experimental: 'C',
  toy: 'D',
};

function validationGrade(status: ValidationStatus | undefined): GradeFactorResult {
  const effective: ValidationStatus = status ?? 'literature-derived';
  return {
    factor: 'validation',
    grade: VALIDATION_GRADE[effective],
    detail:
      status === undefined
        ? 'not externally validated (SC-7A) — treated as literature-derived'
        : `SC-7A validation status: ${status}`,
  };
}

/**
 * Grade a derived model: the worst of the five factor sub-grades, with the limiting factor named.
 * A `not-modelable` derivation is `ungraded`. Pure.
 */
export function gradeDerivedModel(derived: DerivedModel, inputs: GradeInputs = {}): GradedModel {
  if (derived.outcome === 'not-modelable') {
    return { outcome: 'ungraded', factors: [], reason: derived.reason };
  }

  const defaultedAxisCount = (['disposition', 'elimination', 'absorption'] as const).filter(
    (axis) => derived.axisProvenance[axis] === 'defaulted',
  ).length;
  const missingCount = derived.missingParameters?.length ?? 0;

  // Evaluation order is also the tie-break order for the limiting factor.
  const factors: GradeFactorResult[] = [
    structureGrade(defaultedAxisCount),
    completenessGrade(missingCount),
    parameterInferenceGrade(inputs.inferredParameters?.length ?? 0),
    sourceQualityGrade(inputs.sourceQuality),
    validationGrade(inputs.validationStatus),
  ];

  // The weakest link: the strictly-worst sub-grade, first-in-order winning ties.
  let limiting = factors[0]!;
  for (const f of factors) {
    if (rankOf(f.grade) > rankOf(limiting.grade)) limiting = f;
  }

  return {
    outcome: 'graded',
    grade: limiting.grade,
    limitingFactor: limiting.factor,
    factors,
  };
}

/** Whether a graded model renders a curve to end users. Ungraded (`not-modelable`) never does;
 *  a graded model renders when its grade is at least `minGrade` (default: everything gradable). */
export function rendersCurve(graded: GradedModel, minGrade: ModelGrade = MIN_RENDER_GRADE): boolean {
  if (graded.outcome !== 'graded' || graded.grade === undefined) return false;
  return rankOf(graded.grade) <= rankOf(minGrade);
}

// ─── Band widening (CV-3b) ────────────────────────────────────────────────────────────────────
//
// "Honesty is in the curve": a lower-graded model is not just labelled less certain, its reported
// uncertainty BANDS are widened so the picture itself is less confident. This is a MODEL-STRUCTURAL
// uncertainty — a disclosed-default axis or a missing parameter means the latent model shape is less
// sure — and is DISTINCT from the SC-5B observation (measurement) residual error and from the
// SC-1B parameter/individual variability that produce the underlying bands. All three are
// independent sources, so they compose in variance the same way SC-5B layers do (`√Σcv²`); this
// primitive supplies the grade's proportional-CV term, and the engine wiring that folds it into the
// band variance alongside observation error arrives with the render path (CV-4/CV-5).

/**
 * The proportional CV each grade adds to the reported bands as a model-confidence penalty. `A`
 * earns none — a validated, complete, asserted, well-sourced model is as sure as a catalog model
 * gets; `B`/`C`/`D` widen by increasing amounts. Isolated as a named table so the magnitudes stay
 * tunable once real graded curves are visible across the catalog (plan §8), exactly like the A–D
 * thresholds above.
 */
export const GRADE_BAND_WIDENING_CV: Record<ModelGrade, number> = {
  A: 0,
  B: 0.15,
  C: 0.3,
  D: 0.5,
};

/** A grade's model-confidence band widening: a proportional CV plus why it applies. */
export interface GradeBandWidening {
  /** Fractional CV (0.3 = 30%) the grade adds to the reported bands. Composes in variance with the
   *  SC-5B observation layers and the SC-1B parameter spread (`√Σcv²`); the median is unchanged. */
  proportionalCv: number;
  /** Why this widening applies — the grade and the factor that limited it. */
  rationale: string;
}

/**
 * The band widening a graded model earns from its grade (CV-3b). Returns `null` when there is
 * nothing to widen: an `ungraded` (`not-modelable`) derivation has no curve, and an `A` grade adds
 * no model-confidence penalty. Otherwise the proportional CV comes from `GRADE_BAND_WIDENING_CV`,
 * with a rationale naming the grade and its limiting factor. Pure — the caller composes it into the
 * band variance alongside the SC-5B observation error.
 */
export function gradeBandWidening(graded: GradedModel): GradeBandWidening | null {
  if (graded.outcome !== 'graded' || graded.grade === undefined) return null;
  const proportionalCv = GRADE_BAND_WIDENING_CV[graded.grade];
  if (proportionalCv <= 0) return null;
  const limiting = graded.limitingFactor ? ` (limited by ${graded.limitingFactor})` : '';
  return {
    proportionalCv,
    rationale: `model grade ${graded.grade}${limiting}: bands widened by ${Math.round(
      proportionalCv * 100,
    )}% for model-structural uncertainty`,
  };
}
