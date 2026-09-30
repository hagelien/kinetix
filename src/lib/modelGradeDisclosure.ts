/**
 * Turn a derived, graded model into the disclosure a disclaimer surface renders (CV-3c).
 *
 * CV-3a grades a `DerivedModel`; CV-3b widens its bands. CV-3c is the "prominent disclaimer" the
 * plan requires: the honest, user-facing statement that a catalog-derived curve is a disclosed
 * assumption. This module is the single **data contract** for that — it packages, from one
 * derivation, everything every surface needs (the curve caption, a hover tooltip, the monograph
 * panel) so they all disclose the SAME thing:
 *
 *   - the grade and the factor that limited it,
 *   - whether a curve renders at all (`rendersCurve`), or the model is not-modelable,
 *   - the structured CAVEATS — which axes fell back to a disclosed default, which required
 *     parameters the catalog could not supply, which were SOLVED from another observable rather
 *     than cited, a weak source pool, a not-yet-validated model,
 *   - the band-widening the grade applies (so a caption can say "bands widened 30%").
 *
 * Deliberately locale-agnostic: caveats are emitted as CODES plus their values, never as prose, so
 * this stays pure and unit-testable and the React layer owns the Norwegian/English translation
 * (`parameters.*` / a `modelGrade.*` namespace). It reads no DB and renders no markup — a caller
 * supplies the `DerivedModel` (from CV-2) and the grade inputs, and the UI translates the result.
 */
import {
  gradeDerivedModel,
  gradeBandWidening,
  rendersCurve,
  type DerivedModel,
  type GradeFactor,
  type GradeInputs,
  type ModelGrade,
  type RequiredParam,
} from './kinetics-core/index.js';

/** The model-structure axes, in disclosure order. */
const AXES = ['disposition', 'elimination', 'absorption'] as const;
type Axis = (typeof AXES)[number];

/**
 * One user-facing caveat, as a translatable CODE plus its values. The React layer maps each `code`
 * to a localized string and interpolates the values. New reasons get a new code, never prose here.
 */
export type GradeCaveat =
  | { code: 'defaulted-axes'; axes: Axis[] }
  | { code: 'missing-parameters'; parameters: RequiredParam[] }
  | { code: 'inferred-parameters'; parameters: RequiredParam[] }
  | { code: 'weak-source-quality'; grade: ModelGrade }
  | { code: 'not-validated' }
  | { code: 'not-modelable'; reason?: string };

/** Everything a disclaimer surface needs to disclose one derived model. */
export interface GradeDisclosure {
  /** Whether a curve renders at all. `false` for a `not-modelable` derivation (disclaimer only). */
  rendersCurve: boolean;
  /** The A–D grade, or `null` when the model is not-modelable (ungraded). */
  grade: ModelGrade | null;
  /** The factor that set the grade (the weakest link), or `null` when ungraded. */
  limitingFactor: GradeFactor | null;
  /** The proportional band-widening the grade applies (0.3 = 30%), or `null` when none. */
  bandWideningCv: number | null;
  /** The structured caveats to show, most-load-bearing first. Empty for a spotless A model. */
  caveats: GradeCaveat[];
}

/** Which axes fell back to the disclosed default rather than being asserted (CV-2a). */
function defaultedAxes(derived: DerivedModel): Axis[] {
  return AXES.filter((axis) => derived.axisProvenance[axis] === 'defaulted');
}

/**
 * Build the disclosure for a derived model. Grades it (CV-3a) and derives its band widening
 * (CV-3b), then assembles the structured caveats from the derivation and the grade inputs. Pure.
 *
 * A `not-modelable` derivation yields `rendersCurve: false`, no grade, and a single `not-modelable`
 * caveat carrying the reason. A modelable model yields its grade, band widening, and one caveat per
 * live deficiency (defaulted axes, missing parameters, inferred parameters, a weak source pool, a
 * not-yet-validated model) — a fully-validated, complete, asserted, well-sourced A model with no
 * inferred values yields no caveats.
 */
export function describeDerivedModel(
  derived: DerivedModel,
  gradeInputs: GradeInputs = {},
): GradeDisclosure {
  const graded = gradeDerivedModel(derived, gradeInputs);

  if (graded.outcome !== 'graded') {
    return {
      rendersCurve: false,
      grade: null,
      limitingFactor: null,
      bandWideningCv: null,
      caveats: [{ code: 'not-modelable', reason: graded.reason }],
    };
  }

  const caveats: GradeCaveat[] = [];
  const defaulted = defaultedAxes(derived);
  if (defaulted.length > 0) caveats.push({ code: 'defaulted-axes', axes: defaulted });
  if (derived.missingParameters && derived.missingParameters.length > 0) {
    caveats.push({ code: 'missing-parameters', parameters: derived.missingParameters });
  }
  // An INFERRED parameter is disclosed separately from a missing one, and deliberately not folded
  // into it: a missing parameter produces no number, whereas an inferred one produces a number that
  // reads exactly like a cited value on the chart. The caveat is the only thing that distinguishes
  // them for the reader, so it is never suppressed.
  if (gradeInputs.inferredParameters && gradeInputs.inferredParameters.length > 0) {
    caveats.push({ code: 'inferred-parameters', parameters: [...gradeInputs.inferredParameters] });
  }
  // A weak source pool is a caveat only when it is actually assessed and not top-grade; an
  // unassessed pool (no `sourceQuality`) is already reflected in the grade, and re-stating "not
  // assessed" as a caveat would be noise on every catalog model until aggregation is wired.
  if (gradeInputs.sourceQuality && gradeInputs.sourceQuality !== 'A') {
    caveats.push({ code: 'weak-source-quality', grade: gradeInputs.sourceQuality });
  }
  // Not externally validated (SC-7A): true whenever validation was not `validated`. The default
  // (no status supplied) is a freshly-derived, unvalidated catalog model — so it carries the caveat.
  if (gradeInputs.validationStatus !== 'validated') {
    caveats.push({ code: 'not-validated' });
  }

  return {
    rendersCurve: rendersCurve(graded),
    grade: graded.grade ?? null,
    limitingFactor: graded.limitingFactor ?? null,
    bandWideningCv: gradeBandWidening(graded)?.proportionalCv ?? null,
    caveats,
  };
}
