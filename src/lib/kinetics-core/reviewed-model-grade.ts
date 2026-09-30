/**
 * Score a REVIEWED registry model against the eight §5.1 evidence dimensions.
 *
 * `model-grade.ts` grades a DERIVED catalog model from its axis/parameter
 * derivation (CV-3a). That scorer cannot grade the hand-authored override tier:
 * a reviewed model has no `DerivedModel`, its parameters did not come from the
 * catalog, and its evidence questions are different ones. This module is the
 * override tier's scorer, and it produces the same `DimensionAssessment[]` the
 * shared policy evaluator consumes, so both tiers are judged by one rulebook.
 *
 * Its discipline is that **an unknown is not an A**. Every dimension the
 * repository cannot currently answer from recorded evidence scores the
 * conservative outcome and says so in `reason`, which is the text the user
 * eventually reads. Improving a grade means recording evidence, never softening
 * a rule here.
 */
import type { DimensionAssessment } from './grade-policy.js';
import type { DrugModelDefinition } from './types.js';

export interface ReviewedModelEvidence {
  /**
   * A named, credentialed reviewer has attested this model's decisive evidence
   * through the scientific-release gate. No model in the repository has one
   * today; the 2026-08-26 evidence audit records that its own author was an AI
   * agent and explicitly cannot satisfy this.
   */
  reviewerAttested?: boolean;
  /**
   * An external-validation fixture with literature landmarks exists AND passed
   * for this model. Implementation parity is not validation.
   */
  externallyValidated?: boolean;
  /**
   * The uncertainty layers reaching the curve are separated and named, so the
   * bands carry established probability semantics. False while parameter and
   * model-structural spread are pooled into one band.
   */
  uncertaintyLayersSeparated?: boolean;
  /**
   * The displayed matrix was reached from the model's native matrix by an
   * UNVALIDATED bridge (the catalog blood:plasma ratio). A reviewed
   * `matrixTransform` is not this.
   */
  matrixBridgedWithoutValidation?: boolean;
  /**
   * The requested route or input shape is one this model does not declare, or
   * the analyte basis does not match. A hard stop, not a low grade.
   */
  routeOrAnalyteMismatch?: boolean;
  /**
   * The evidence is contraindicated for, or non-transferable to, the selected
   * population. A hard stop.
   */
  populationNonTransferable?: boolean;
  /** A material population mismatch with unknown direction. Scores C. */
  populationMismatch?: boolean;
  /** An unresolved material contradiction collapsed to one curve. A hard stop. */
  contradictionCollapsed?: boolean;
}

/**
 * The eight assessments for a reviewed model.
 *
 * Dimensions the model definition itself can answer (completeness, provenance)
 * are read from the definition. The rest are evidence questions the definition
 * cannot answer, so they come from `evidence` — and default to the conservative
 * outcome when the caller does not supply them.
 */
export function assessReviewedModel(
  model: DrugModelDefinition,
  evidence: ReviewedModelEvidence = {},
): DimensionAssessment[] {
  const assessments: DimensionAssessment[] = [];

  // 1. Completeness — a reviewed model is authored with its family's required
  //    parameters or it would not run at all, so reaching here means complete.
  assessments.push({
    dimension: 'completeness',
    grade: 'A',
    reason: 'Reviewed model; every family-required parameter is authored.',
  });

  // 2. Primary-source review — the gate the whole registry currently fails.
  assessments.push(
    evidence.reviewerAttested
      ? {
          dimension: 'primary-source-review',
          grade: 'A',
          reason: 'Decisive evidence attested by a named qualified reviewer.',
        }
      : {
          dimension: 'primary-source-review',
          grade: 'C',
          reason:
            'No named qualified reviewer has attested the decisive evidence; the sources are recorded but the review is pending.',
        },
  );

  // 3. Parameter provenance — the registry records a citation per model and a
  //    reviewer rationale for every non-catalog route parameter, which is
  //    study/table-level traceability rather than per-value extraction records.
  assessments.push({
    dimension: 'parameter-provenance',
    grade: model.references && model.references.length > 0 ? 'B' : 'C',
    reason:
      model.references && model.references.length > 0
        ? 'Values trace to the cited model source; one declared derivation per reviewer-authored route parameter.'
        : 'No source is recorded on the model definition; values are traceable only to the registry entry.',
  });

  // 4. Population applicability.
  if (evidence.populationNonTransferable) {
    assessments.push({
      dimension: 'population-applicability',
      grade: 'hard-stop',
      reason:
        'The evidence is contraindicated for, or non-transferable to, the selected population.',
    });
  } else if (evidence.populationMismatch) {
    assessments.push({
      dimension: 'population-applicability',
      grade: 'C',
      reason:
        'Material population mismatch against the model’s source population, with unknown direction.',
    });
  } else {
    assessments.push({
      dimension: 'population-applicability',
      grade: 'B',
      reason:
        'Applied within, or by justified extrapolation from, the model’s stated population.',
    });
  }

  // 5. Matrix and route match.
  if (evidence.routeOrAnalyteMismatch) {
    assessments.push({
      dimension: 'matrix-route-match',
      grade: 'hard-stop',
      reason:
        'The requested route, input shape or analyte basis is not the one this model describes.',
    });
  } else if (evidence.matrixBridgedWithoutValidation) {
    assessments.push({
      dimension: 'matrix-route-match',
      grade: 'C',
      reason: `Shown in a matrix other than the model’s native ${model.matrix}, via the catalog blood:plasma ratio — a plausible but unvalidated bridge.`,
    });
  } else {
    assessments.push({
      dimension: 'matrix-route-match',
      grade: 'A',
      reason: `Reported in the model’s own matrix (${model.matrix}) and a declared route.`,
    });
  }

  // 6. Validation status. `validated` is EARNED by external validation, so a
  //    model claiming it without a passing fixture is not taken at its word.
  const externallyValidated =
    evidence.externallyValidated === true && model.validationStatus === 'validated';
  if (externallyValidated) {
    assessments.push({
      dimension: 'validation-status',
      grade: 'A',
      reason: 'Externally validated against independent observations.',
    });
  } else if (model.validationStatus === 'literature-derived') {
    assessments.push({
      dimension: 'validation-status',
      grade: evidence.externallyValidated ? 'B' : 'C',
      reason: evidence.externallyValidated
        ? 'Literature-derived and checked against an independent landmark, but not domain validated.'
        : 'Literature-derived with no external-validation fixture on record.',
    });
  } else {
    assessments.push({
      dimension: 'validation-status',
      grade: 'D',
      reason: `Validation status is "${model.validationStatus}"; no external validation is on record.`,
    });
  }

  // 7. Uncertainty semantics.
  assessments.push(
    evidence.uncertaintyLayersSeparated
      ? {
          dimension: 'uncertainty-semantics',
          grade: 'A',
          reason:
            'Parameter, population, residual and structural uncertainty are separated and the interval meaning is explicit.',
        }
      : {
          dimension: 'uncertainty-semantics',
          grade: 'C',
          reason:
            'The bands pool uncertainty components, so their probability semantics are not established: they are a plausible range, not a confidence or prediction interval.',
        },
  );

  // 8. Unresolved contradictions.
  assessments.push(
    evidence.contradictionCollapsed
      ? {
          dimension: 'unresolved-contradictions',
          grade: 'hard-stop',
          reason:
            'A material contradiction affecting family, route or magnitude is collapsed to a single curve.',
        }
      : {
          dimension: 'unresolved-contradictions',
          grade: 'B',
          reason: 'No unresolved material contradiction is recorded.',
        },
  );

  return assessments;
}
