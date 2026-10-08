/**
 * The app-side bridge between a simulator result and the §5.1 grade policy.
 *
 * Turns a stored `DrugSimResult` into the evidence questions the right scorer
 * asks, so the disclosure at the curve describes the run the user is actually
 * looking at — including whether THIS view bridged matrices, which is a property
 * of the view rather than of the model.
 *
 * Two tiers reach this, and they are scored differently:
 *
 *  - a REVIEWED model goes to `assessReviewedModel`, and Amendment 1 (§5.2)
 *    applies — a C renders to every user class under its four conditions;
 *  - a DERIVED model goes to `assessDerivedModel`, and Amendment 1 explicitly
 *    does NOT apply, so §5.1's floors stand: B for anonymous/authenticated/
 *    contributor, C for editor/admin. On today's implementation even a fully
 *    asserted derived model is a **D** — the curve is a bare point estimate and no
 *    per-input provenance is recorded — so it clears no floor at all and reaches a
 *    reviewer only through the recorded acknowledgement `acknowledged` carries.
 *
 * The one case that must never happen quietly: a derived model the committed
 * artifact carries no grade for. Returning `null` there would be read by the
 * caller as "not governed by the policy" and would render an UNGRADED catalog
 * curve to everyone — the exact outcome §5.1 forbids. It resolves to `hidden`.
 */
import {
  hashValue,
  assessDerivedModel,
  assessReviewedModel,
  derivedRouteGrade,
  evaluateGradePolicy,
  isDerivedAnalyte,
  renderDisposition,
  resolvableAnalyteIds,
  resolveModel,
  type DimensionAssessment,
  type DrugModelDefinition,
  type GradePolicyResult,
  type OverallGrade,
  type RenderDisposition,
  type UserClass,
} from '@/lib/kinetics-core';
import { routeIdFor } from '@/lib/forwardCoreAdapter';
import { isDerivedModelId } from '@/lib/modelDerivation';
import { matrixConversionApplies, type ChartMatrix } from '@/lib/matrixDisplay';
import { tierForRole } from '@/lib/permissions';
import type { DrugSimResult } from '@/types/simulator';

/** Amendment 1 (plan §5.2) applies to the reviewed override tier. */
const PUBLIC_TIER_IN_FORCE = true;

/**
 * Bump when a change to the SCORERS or the policy could alter what an acknowledgement means
 * without altering the text a reviewer was shown.
 *
 * Belt and braces on top of `acknowledgementVersionFor`, which already covers every change that
 * surfaces in the policy result. A hand-bumped constant is exactly the sort of thing that goes
 * quietly stale, so it is the backstop and not the mechanism.
 */
const GRADE_POLICY_VERSION = '1';

export interface ResultGrade {
  policy: GradePolicyResult;
  disposition: RenderDisposition;
  /**
   * The version an acknowledgement of THIS grade is recorded against (§5.1's "per-model,
   * per-version"). See `acknowledgementVersionFor` for why it is not a release checksum.
   */
  acknowledgementVersion: string;
  /**
   * WHY this result may be shown, when it may.
   *
   * `grade` — it clears the floor for this viewer on its own merits.
   * `acknowledgement` — it does not, and is admitted only because this reviewer accepted it.
   * `withheld` — it may not be shown at all.
   *
   * The distinction is load-bearing rather than informational: §5.1 says an acknowledgement
   * "must not ... survive into exports/share links", so a surface that leaves the review
   * workspace has to tell the two admissions apart. A boolean disposition cannot.
   */
  admittedBy: 'grade' | 'acknowledgement' | 'withheld';
  /**
   * Structure axes a DERIVED curve runs in a simpler form than the drug's cited
   * declaration (from the committed grade record's `simplifiedFrom`). The grade
   * already counts them against completeness; this carries WHAT was simplified to
   * the surface, which states it in the viewer's language.
   */
  structureSimplifications?: readonly StructureSimplification[];
  /**
   * Inputs a DERIVED curve runs on a labelled cautious default because the catalog holds no value
   * (from the committed grade record's `defaultedParameters`). The grade counts them against
   * completeness; this carries WHICH ones to the surface, which states each in the viewer's language.
   */
  cautiousDefaults?: readonly string[];
}

/** One structure axis drawn in a simpler form than declared: `declared` is what the sources state. */
export interface StructureSimplification {
  axis: 'disposition' | 'elimination' | 'absorption';
  declared: string;
  runs: string;
}

/**
 * The version key an acknowledgement is filed under: a fingerprint of the evidence it was given for.
 *
 * The obvious key is the resolved release checksum, and it is WRONG. `buildRegistrySnapshot` hashes
 * `{version, definitions}`, and the generated artifact's `derivedGrades` sit deliberately outside it
 * — so a regeneration that changes only grade facts (an axis moving from asserted to defaulted, a
 * `ka` that stops being inferred) leaves the checksum identical while changing the very evidence the
 * reviewer accepted. A change to the scorers does the same. Either way a stale acknowledgement would
 * keep admitting a curve it was never given for.
 *
 * The next-most-obvious key is the DISCLOSED policy — grade plus every stated dimension — and it is
 * also wrong, more subtly. §5.1 discloses only dimensions below B, so completeness moving from A to
 * B (one model-structure axis falling back to the disclosed default) changes the model while leaving
 * `disclosable` byte-identical. The acknowledgement would survive a real change to the evidence.
 *
 * So this hashes the COMPLETE assessment set — every dimension the scorer produced, disclosed or not
 * — plus the resulting grade. The grade is redundant given the assessments under today's
 * weakest-link rule, and is included anyway to cover a policy that maps the same assessments to a
 * different letter.
 *
 * It is deliberately view-sensitive. Displaying a model through an unvalidated matrix bridge changes
 * a dimension, so it files under its own key and needs its own acknowledgement — and switching the
 * matrix back finds the original record intact, because each evidence state keeps its own.
 */
export function acknowledgementVersionFor(
  assessments: readonly DimensionAssessment[],
  grade: OverallGrade,
): string {
  return hashValue({
    policyVersion: GRADE_POLICY_VERSION,
    grade,
    // Sorted so a reordering inside a scorer is not mistaken for an evidence change.
    assessments: assessments
      .map((a) => ({ dimension: a.dimension, grade: a.grade, reason: a.reason ?? '' }))
      .sort((a, b) => a.dimension.localeCompare(b.dimension)),
  });
}

/** The permission tier vocabulary is the policy's user-class vocabulary. */
export function userClassForRole(role: string | null | undefined): UserClass {
  return tierForRole(role) as UserClass;
}

/**
 * Grade the model behind one result, for one viewer.
 *
 * Returns `null` when the result did not come from a registry model at all (the
 * ethanol/Widmark and KineLab engines, or an older saved case): those carry their
 * own assumption surfaces and are not governed by this policy, and inventing a
 * grade for them would be exactly the manufactured evidence the contract forbids.
 * `null` is NOT used for a registry model this cannot grade — see the module note.
 */
export function gradeResult(
  result: DrugSimResult | undefined,
  options: {
    role: string | null | undefined;
    displayMatrix: ChartMatrix;
    /**
     * Whether this viewer has a §5.1 acknowledgement on record for the evidence
     * described by `version` — the key `acknowledgementVersionFor` produces.
     *
     * A PREDICATE rather than a boolean because the version is derived from the
     * policy this call is about to evaluate, so the caller cannot know it in
     * advance. Only a reviewer class can use an acknowledgement, and it never
     * reaches a hard stop — `renderDisposition` enforces both, so a caller cannot
     * widen anything by answering `true`.
     */
    isAcknowledged?: (version: string) => boolean;
  },
): ResultGrade | null {
  const modelId = result?.assumptions.modelId;
  if (!result || !modelId) return null;

  // Resolve by the MODEL ID the run recorded, not by analyte: a saved case
  // pinned to a superseded model must not be graded as whatever currently
  // occupies its analyte. An id that no longer resolves grades nothing —
  // except a DERIVED one: derived models are built live and can be withdrawn
  // while a result they produced is still held, and that result must stay
  // withheld rather than fall through to "not governed", which renders.
  const model = modelById(modelId);
  if (!model) return isDerivedModelId(modelId) ? ungradeableDerived() : null;

  const nativeMatrix = result.assumptions.nativeMatrix ?? model.matrix;
  // Every other evidence flag is left unset deliberately: unset means "not on
  // record", which both scorers treat conservatively. Setting one to `true` here
  // would assert evidence nobody has recorded.
  const matrixBridgedWithoutValidation = matrixConversionApplies(
    nativeMatrix,
    options.displayMatrix,
  );
  const userClass = userClassForRole(options.role);

  if (isDerivedAnalyte(model.analyte)) {
    const route = derivedRouteGrade(model.analyte, routeIdFor(result.assumptions.route));
    if (!route) {
      // A derived curve with no committed grade cannot be disclosed, so it cannot
      // be shown. Reported as an explicit hidden disposition rather than `null`,
      // which the caller reads as "not governed" and would render.
      return ungradeableDerived();
    }
    const assessments = assessDerivedModel(model, route, { matrixBridgedWithoutValidation });
    const structureSimplifications = (['disposition', 'elimination', 'absorption'] as const).flatMap(
      (axis): StructureSimplification[] => {
        const declared = route.simplifiedFrom?.[axis];
        return declared === undefined ? [] : [{ axis, declared, runs: route.structure[axis] }];
      },
    );
    // No `publicTier`: §5.2 does not extend the disclosed public tier to the
    // derived track, so §5.1's un-amended floors stand — and on today's grading
    // that leaves the reviewer acknowledgement as the only path to a curve.
    const decided = decide(assessments, userClass, options.isAcknowledged, false);
    return {
      ...decided,
      ...(structureSimplifications.length > 0 ? { structureSimplifications } : {}),
      ...(route.defaultedParameters?.length
        ? { cautiousDefaults: [...route.defaultedParameters] }
        : {}),
    };
  }

  const assessments = assessReviewedModel(model, { matrixBridgedWithoutValidation });
  return decide(assessments, userClass, options.isAcknowledged, PUBLIC_TIER_IN_FORCE);
}

/** Evaluate, version the complete evidence, ask the caller about it, settle the disposition. */
function decide(
  assessments: readonly DimensionAssessment[],
  userClass: UserClass,
  isAcknowledged: ((version: string) => boolean) | undefined,
  publicTier: boolean,
): ResultGrade {
  const policy = evaluateGradePolicy(assessments);
  const acknowledgementVersion = acknowledgementVersionFor(assessments, policy.grade);
  const tier = publicTier ? { publicTier } : {};

  // Asked twice on purpose. The first answer is what the grade earns unaided; the second is what
  // the acknowledgement adds. Comparing them is the only way to know whether a rendering
  // disposition rests on the evidence or on the reviewer, and §5.1 treats those differently once
  // the figures leave the workspace.
  const onMerit = renderDisposition(policy, userClass, { ...tier, acknowledged: false });
  const disposition = renderDisposition(policy, userClass, {
    ...tier,
    acknowledged: isAcknowledged?.(acknowledgementVersion) ?? false,
  });
  const renders = (d: RenderDisposition) => d === 'render' || d === 'render-with-limitations';

  return {
    policy,
    acknowledgementVersion,
    disposition,
    admittedBy: !renders(disposition)
      ? 'withheld'
      : renders(onMerit)
        ? 'grade'
        : 'acknowledgement',
  };
}

/**
 * Whether a graded result may show figures at all.
 *
 * ONE definition of "admitted", used by every numeric surface, because the leak this
 * closes came from each surface deciding for itself: the chart consulted the
 * disposition and the answer card, summary, assumption panel and text export did
 * not, so a withheld model contributed no curve and printed its median, percentiles
 * and PK parameters underneath it. §5.1 governs "a numeric curve or curve
 * coordinates" wherever they surface, not just the chart.
 *
 * A `null` grade is ADMITTED: it means the result came from an engine this policy
 * does not govern (ethanol/Widmark, KineLab, an older saved case), which carries its
 * own assumption surface. Withholding those would be the gate over-reaching.
 */
export function admitsFigures(grade: ResultGrade | null | undefined): boolean {
  if (!grade) return true;
  return grade.admittedBy !== 'withheld';
}

/**
 * Whether a result's figures may leave the review workspace — an export, a share link, anything
 * that outlives the screen and the viewer.
 *
 * Stricter than `admitsFigures` by exactly one case, and §5.1 is explicit about it: an
 * acknowledgement "must not ... survive into exports/share links". An acknowledged D renders
 * `render-with-limitations` like any C, so a disposition check alone cannot tell them apart — which
 * is what `admittedBy` exists for. The reviewer accepted an exploratory curve for themselves, in a
 * labelled workspace; a downloaded file has neither the label nor the reviewer attached to it.
 */
export function admitsExport(grade: ResultGrade | null | undefined): boolean {
  if (!grade) return true;
  return grade.admittedBy === 'grade';
}

/** The subset of results whose grade admits figures. */
export function admittedResults<T>(
  results: Record<string, T>,
  resultGrades: Record<string, ResultGrade | null> | undefined,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(results).filter(([id]) => admitsFigures(resultGrades?.[id])),
  );
}

/**
 * The policy result for a derived model the artifact carries no grade for. Stated
 * as a hard stop because it is one: without the grade there is nothing to disclose
 * at the curve, and §5.1 does not permit an undisclosed one.
 */
const UNGRADEABLE_DERIVED: GradePolicyResult = {
  grade: 'ungraded',
  limitingDimensions: [],
  disclosable: [],
  hardStops: [
    {
      dimension: 'parameter-provenance',
      grade: 'hard-stop',
      reason:
        'This derived model carries no committed grade, so its curve cannot be disclosed and is not shown.',
    },
  ],
};

/** The hidden disposition for a derived curve that has no grade to disclose it by. */
function ungradeableDerived(): ResultGrade {
  return {
    policy: UNGRADEABLE_DERIVED,
    disposition: 'hidden',
    admittedBy: 'withheld',
    acknowledgementVersion: acknowledgementVersionFor(
      UNGRADEABLE_DERIVED.hardStops,
      UNGRADEABLE_DERIVED.grade,
    ),
  };
}

/** The resolvable model carrying this id — reviewed or derived — or undefined. */
function modelById(modelId: string): DrugModelDefinition | undefined {
  for (const analyte of resolvableAnalyteIds()) {
    const model = resolveModel(analyte);
    if (model?.modelId === modelId) return model;
  }
  return undefined;
}
