/**
 * Score a DERIVED catalog model against the eight §5.1 evidence dimensions.
 *
 * `reviewed-model-grade.ts` scores the hand-authored override tier; this is its
 * counterpart for the catalog-derived tier, producing the same
 * `DimensionAssessment[]` so both tiers are judged by one rulebook and reach
 * `renderDisposition` through the same door.
 *
 * **Why a derived model needs its own scorer.** CV-3a already grades a derived
 * model on its own four-plus-one factors, but that scale is not §5.1's. The
 * render gate is defined in terms of the eight dimensions and their per-user-class
 * floors, so a derived model has to be expressed in that vocabulary or it cannot
 * be gated at all — and an ungatable model is one that either renders to everyone
 * or to nobody. Neither is the policy.
 *
 * **The mapping is read off facts about the derived tier, not chosen.** Every
 * dimension below is fixed by something structural about how a derived model is
 * built, and each is recorded here with the fact that fixes it. It inherits the
 * reviewed scorer's discipline: an unknown is never an A, and improving a grade
 * means recording evidence rather than softening a rule.
 *
 * **What this produces, on today's implementation: D.** Several dimensions sit at
 * C for reasons no curation can lift (the derivation is automatic, so no reviewer
 * has attested it; the catalog records no source population for a pooled value;
 * the derived tier's native matrix is a disclosed default). Two sit at **D** for
 * reasons that are about the CODE rather than the data, and they are the honest
 * blockers on this tier ever rendering:
 *
 *   - **uncertainty-semantics** — a derived route is `fixed(median)` with no
 *     observation-error layer, so the engine emits a bare point estimate. CV-3b's
 *     band widening reaches the disclosure but no simulation path applies it.
 *   - **parameter-provenance**, for a route any of whose values is uncited — a
 *     drug-level value can come from a seeded or backfilled cache row with nothing
 *     cited behind it. Generation records each input's source (`inputSources`), so
 *     a route whose every catalog value pools cited entries reaches C here; the
 *     others stay D until a curator cites their values.
 *
 * Weakest-link therefore lands every derived model at **D**, which §5.1 admits only
 * to a reviewer holding a recorded per-model acknowledgement. That acknowledgement
 * IS now implemented (`modelAcknowledgementStore`, the review-workspace state of
 * `ModelGradeNotice`), so a derived curve can be looked at by a reviewer who
 * explicitly accepts its stated deficiencies — and by nobody else. Saying so plainly
 * is the point: the gate is correct and the tier is not yet fit for a general
 * audience. Closing either D is a code change, not an owner decision; §5.2's public
 * tier is a separate question that only matters once they are closed.
 *
 * Pure and portable: no DB, no engine change, no `CORE_VERSION` bump.
 */
import type { DerivedRouteGrade, InputSource } from './derived-grade.js';
import type { RequiredParam } from './model-structure.js';
import type { DimensionAssessment, DimensionGrade } from './grade-policy.js';

type LetterGrade = Exclude<DimensionGrade, 'hard-stop'>;
import type { DrugModelDefinition } from './types.js';

/** View- and subject-dependent facts the definition itself cannot answer. */
export interface DerivedModelEvidence {
  /**
   * The displayed matrix was reached from the model's native matrix by an
   * UNVALIDATED bridge (the catalog blood:plasma ratio) — a property of this
   * view, not of the model.
   */
  matrixBridgedWithoutValidation?: boolean;
  /**
   * The requested route or analyte basis is not one this model declares. A hard
   * stop, not a low grade. A derived definition carries only routes that
   * assembled, so this is a caller/view error rather than a derivation outcome.
   */
  routeOrAnalyteMismatch?: boolean;
  /** The evidence is contraindicated for the selected population. A hard stop. */
  populationNonTransferable?: boolean;
  /**
   * A material contradiction is collapsed into one curve. A hard stop. The
   * derivation normally prevents this from reaching here at all — a molecule-axis
   * conflict, or two disagreeing absorption shapes on one route, is surfaced as
   * not-modelable rather than resolved — so this covers a contradiction detected
   * downstream of the derivation.
   */
  contradictionCollapsed?: boolean;
}

/**
 * Completeness sub-grade from the count of model inputs that took a disclosed default rather than
 * being asserted: the three structure axes, plus the administration ROUTE when the catalog never
 * named it and the read adapter attributed it. §5.1 counts an input "filled from a conservative
 * default" against completeness, and an attributed route is one — the same kind of assumption as a
 * defaulted axis, made about which route the drug's absorption evidence describes.
 */
function defaultedAxisCount(route: DerivedRouteGrade): number {
  const axes = (['disposition', 'elimination', 'absorption'] as const).filter(
    (axis) => route.axisProvenance[axis] === 'defaulted' || simplifiedAxes(route).includes(axis),
  ).length;
  return axes + (route.routeProvenance === 'attributed' ? 1 : 0);
}

/**
 * The asserted axes this route runs in a simpler form than declared. A simplified axis counts
 * against completeness exactly as a defaulted one does — the curve's shape is not the one the
 * evidence asserts — so declaring a richer model than the catalog can yet run never lowers a grade
 * below what leaving the axis unstated would give, and never raises it either.
 */
/** The worse of two dimension grades (A best, D worst). */
function worseGrade(a: LetterGrade, b: LetterGrade): LetterGrade {
  const order: readonly LetterGrade[] = ['A', 'B', 'C', 'D'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
}

function simplifiedAxes(route: DerivedRouteGrade): ('disposition' | 'elimination' | 'absorption')[] {
  return (['disposition', 'elimination', 'absorption'] as const).filter(
    (axis) => route.simplifiedFrom?.[axis] !== undefined,
  );
}

const UNCITED_REASON_TEXT: Record<Extract<InputSource, { basis: 'uncited' }>['reason'], string> = {
  'authored-value': 'a hand-entered catalog value with no source entry behind it',
  'uncited-entry': 'pooled from at least one entry that names no citation',
  'stale-cache': 'a cached value that no longer matches its source entries',
};

/**
 * The parameter-provenance assessment for one derived route (see step 3 of
 * `assessDerivedModel`). The inputs judged are the roles the catalog supplied:
 * every role with a recorded source, plus any inferred role, minus the defaulted
 * ones.
 */
function assessParameterProvenance(route: DerivedRouteGrade): DimensionAssessment {
  const inferred = route.inferredParameters ?? [];
  const inferredNote =
    inferred.length > 0
      ? ` ${inferred.join(', ')} was solved from another stored observable rather than measured, and is judged by that observable’s source.`
      : '';
  const sources = route.inputSources;
  if (!sources) {
    return {
      dimension: 'parameter-provenance',
      grade: 'D',
      reason: `This model was generated before per-input sources were recorded, so no value can be shown to trace to a source.${inferredNote}`,
    };
  }
  const defaulted = new Set(route.defaultedParameters ?? []);
  const judged = [
    ...new Set([...(Object.keys(sources) as RequiredParam[]), ...inferred]),
  ]
    .filter((role) => !defaulted.has(role))
    .sort();
  const unsourced = judged.filter((role) => sources[role]?.basis !== 'cited');
  if (judged.length === 0 || unsourced.length > 0) {
    const detail = unsourced
      .map((role) => {
        const source = sources[role];
        return source?.basis === 'uncited'
          ? `${role} (${UNCITED_REASON_TEXT[source.reason]})`
          : `${role} (no source recorded)`;
      })
      .join('; ');
    return {
      dimension: 'parameter-provenance',
      grade: 'D',
      reason:
        judged.length === 0
          ? 'No input of this curve has a recorded source.'
          : `Not every value this curve runs on traces to a cited source: ${detail}.${inferredNote}`,
    };
  }
  return {
    dimension: 'parameter-provenance',
    grade: 'C',
    reason: `Every catalog value this curve runs on (${judged.join(', ')}) is pooled from source entries that each cite a reference, but only to study level: no per-input extraction record (table or page, unit conversion, population) is kept, and several sources may pool into one number.${inferredNote}`,
  };
}

/**
 * The eight assessments for one route of a derived model.
 *
 * `route` is the committed grade record for the route being rendered (CV-4c-2c),
 * so this scores the curve the user is actually looking at rather than the drug
 * in general — a drug modelable on two routes can be better evidenced on one.
 */
export function assessDerivedModel(
  model: DrugModelDefinition,
  route: DerivedRouteGrade,
  evidence: DerivedModelEvidence = {},
): DimensionAssessment[] {
  const assessments: DimensionAssessment[] = [];

  // 1. Completeness. A route is only recorded once it ASSEMBLED, so every
  //    parameter the family requires has a value — but a value may be a labelled
  //    cautious default rather than a catalog one, and the model SHAPE may be a
  //    disclosed default. §5.1 counts both against this dimension: a defaulted axis
  //    by count (A/B/C/D for 0/1/2/3+), and a defaulted PARAMETER by §5.1's own
  //    wording — C when "one input uses an explicitly conservative default", D when
  //    more do. The worse of the two stands.
  const defaulted = defaultedAxisCount(route);
  const defaultedParams = route.defaultedParameters ?? [];
  const axisGrade: LetterGrade =
    defaulted === 0 ? 'A' : defaulted === 1 ? 'B' : defaulted === 2 ? 'C' : 'D';
  const parameterGrade: LetterGrade =
    defaultedParams.length === 0 ? 'A' : defaultedParams.length === 1 ? 'C' : 'D';
  const axisReason =
    defaulted === 0
      ? 'all three model-structure axes were asserted from the drug’s declarations'
      : `${defaulted} model input(s) fell back to a disclosed default or a simplified form — the linear one-compartment structure axes${
          simplifiedAxes(route).length > 0
            ? `. ${simplifiedAxes(route)
                .map(
                  (axis) =>
                    `The drug declares a ${route.simplifiedFrom![axis]} ${axis}, but this curve runs ${route.structure[axis]}: the catalog cannot yet supply the parameters the declared form needs`,
                )
                .join('. ')}`
            : ''
        }${
          route.routeProvenance === 'attributed'
            ? '. The administration route was also assumed: the catalog named none, so the route-specific values this curve uses (bioavailability, and the Tmax any absorption rate was solved from) carry no route label and may describe a different extravascular route than the one shown'
            : ''
        }`;
  assessments.push({
    dimension: 'completeness',
    grade: worseGrade(axisGrade, parameterGrade),
    reason:
      defaultedParams.length === 0
        ? `Every family-required parameter has a catalog value, and ${axisReason}.`
        : `The catalog holds no value for ${defaultedParams.join(', ')}, so this curve runs on a labelled cautious default for ${defaultedParams.length === 1 ? 'it' : 'them'} (${defaultedParams
            .map((p) => (p === 'bioavailability' ? 'complete absorption, F = 1' : p))
            .join('; ')}), which pushes the curve toward higher concentrations; and ${axisReason}.`,
  });

  // 2. Primary-source review. A derived model is assembled automatically from
  //    catalog declarations; no named reviewer attests it, and none can without
  //    ceasing to be a derivation. The plan's own route to a reviewed model is
  //    promotion INTO the override tier, so this dimension does not lift here.
  assessments.push({
    dimension: 'primary-source-review',
    grade: 'C',
    reason:
      'Assembled automatically from catalog declarations; no named qualified reviewer has attested this model. A reviewed model is one promoted into the override tier.',
  });

  // 3. Parameter provenance, judged input by input from the sources generation
  //    recorded (`inputSources`). Every value the curve runs on and the catalog
  //    supplied must trace to cited entries; a defaulted role took no catalog
  //    value and is graded under completeness instead.
  //
  //    D when any such input is uncited, or when the record predates sources
  //    being recorded: §5.1 scores an unsourced decisive numeric input D, and an
  //    input that MIGHT be unsourced cannot be told apart from one that is.
  //
  //    C, not better, when every input is cited. A pooled value traces to the
  //    studies behind it, but the catalog keeps no per-input extraction record
  //    (table or page, unit conversion, population), and several sources pool
  //    into one number — §5.1's "traceable only to a study/table level, or
  //    aggregation lineage incomplete but auditable".
  assessments.push(assessParameterProvenance(route));

  // 4. Population applicability. The catalog pools a parameter across sources
  //    without recording the population each came from, so a derived model cannot
  //    state the population it applies to — unknown, scored conservatively.
  assessments.push(
    evidence.populationNonTransferable
      ? {
          dimension: 'population-applicability',
          grade: 'hard-stop',
          reason:
            'The evidence is contraindicated for, or non-transferable to, the selected population.',
        }
      : {
          dimension: 'population-applicability',
          grade: 'C',
          reason:
            'The catalog records no source population for a pooled value, so the population this model applies to is not established.',
        },
  );

  // 5. Matrix and route match. The derived tier has no catalog column for a
  //    native matrix, so `plasma` is a DISCLOSED DEFAULT rather than a recorded
  //    fact — which caps this dimension even when no bridge is applied.
  if (evidence.routeOrAnalyteMismatch) {
    assessments.push({
      dimension: 'matrix-route-match',
      grade: 'hard-stop',
      reason:
        'The requested route or analyte basis is not one this derived model declares.',
    });
  } else {
    assessments.push({
      dimension: 'matrix-route-match',
      grade: 'C',
      reason: evidence.matrixBridgedWithoutValidation
        ? `Shown in a matrix other than the assumed native ${model.matrix}, via the catalog blood:plasma ratio — a plausible but unvalidated bridge.`
        : `Reported on a declared route, but the native matrix (${model.matrix}) is a disclosed default: the catalog records none for a derived model.`,
    });
  }

  // 6. Validation status. A derived model is literature-derived by construction
  //    and carries no external-validation fixture; `validated` is earned by a
  //    fixture, which belongs to a reviewed model.
  assessments.push(
    model.validationStatus === 'literature-derived'
      ? {
          dimension: 'validation-status',
          grade: 'C',
          reason: 'Literature-derived with no external-validation fixture on record.',
        }
      : {
          dimension: 'validation-status',
          grade: 'D',
          reason: `Validation status is "${model.validationStatus}"; no external validation is on record for a derived model.`,
        },
  );

  // 7. Uncertainty semantics. A derived route is assembled as `fixed(median)`
  //    (CV-4b) and declares no observation-error layer, so every draw is identical
  //    and the engine emits p05 = p25 = median = p75 = p95. CV-3b's grade band
  //    widening exists but no simulation path applies it — it reaches the
  //    DISCLOSURE only. So there is no interval here at all, not a pooled one:
  //    the output is a bare point estimate, which §5.1 scores D.
  //
  //    Lifting this needs the grade's proportional CV composed into the emitted
  //    bands (or a real parameter-variability layer, SC-1B) before the curve is
  //    rendered. Until then, calling this a "plausible range" would be the
  //    mislabelled interval §5.1 makes a hard stop.
  assessments.push({
    dimension: 'uncertainty-semantics',
    grade: 'D',
    reason:
      'Every parameter is fixed at its median and no uncertainty layer reaches the curve, so the output is a single point estimate with no interval — not a range of any kind.',
  });

  // 8. Unresolved contradictions. The derivation refuses to resolve one — a
  //    molecule-axis conflict, or two disagreeing absorption shapes for a route,
  //    is not-modelable and never assembles — so reaching here means none was
  //    detected at derivation time.
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
          reason:
            'The derivation surfaces a declaration conflict as not-modelable rather than resolving it, and none was recorded for this route.',
        },
  );

  return assessments;
}
