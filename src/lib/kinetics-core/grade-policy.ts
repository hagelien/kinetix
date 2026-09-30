/**
 * The owner-approved model-grade release policy, as executable rules.
 *
 * Two documents govern this module and it implements both:
 *
 *  - the 2026-08-26 release contract (catalog-coverage plan §5.1) — eight
 *    evidence dimensions, a weakest-link overall grade, hard stops that no role
 *    or acknowledgement can bypass, and a per-user-class rendering floor;
 *  - Amendment 1 (§5.2, 2026-08-26) — a disclosed public tier that moves the
 *    public floor from B to C for the reviewed override tier, on conditions.
 *
 * The amendment is a PARAMETER here, not a rewrite: with `publicTier` off the
 * evaluator reproduces §5.1 exactly, so the pinned acceptance cases keep their
 * original expectations while running against production code.
 *
 * This module is deliberately about EVIDENCE, not about model mathematics. It
 * scores what is known about a model's provenance and validation; it never
 * inspects a curve. `model-grade.ts` remains the derived-model (CV-3a) scorer
 * and feeds this one; the two are not interchangeable.
 */

/** The eight evidence dimensions of §5.1, in the order the contract lists them. */
export const GRADE_DIMENSIONS = [
  'completeness',
  'primary-source-review',
  'parameter-provenance',
  'population-applicability',
  'matrix-route-match',
  'validation-status',
  'uncertainty-semantics',
  'unresolved-contradictions',
] as const;

export type GradeDimension = (typeof GRADE_DIMENSIONS)[number];

/**
 * A dimension's outcome. `hard-stop` is NOT "worse than D" on a scale — it is a
 * categorically different result: no numeric curve for anyone, at any role, with
 * or without acknowledgement.
 */
export type DimensionGrade = 'A' | 'B' | 'C' | 'D' | 'hard-stop';

/** The overall grade. `ungraded` means a hard stop fired: no curve, show why. */
export type ModelGradeLetter = 'A' | 'B' | 'C' | 'D';
export type OverallGrade = ModelGradeLetter | 'ungraded';

export interface DimensionAssessment {
  dimension: GradeDimension;
  grade: DimensionGrade;
  /** Why this dimension scored as it did. Shown to the user for any sub-B grade. */
  reason?: string;
}

export interface GradePolicyResult {
  grade: OverallGrade;
  /**
   * Dimensions at the overall grade — the weakest links, the ones that must
   * improve for the model to move up. Empty for a spotless A.
   */
  limitingDimensions: GradeDimension[];
  /** Every dimension scoring below B, itemised. §5.2 condition 2 renders these. */
  disclosable: DimensionAssessment[];
  /** Dimensions that hard-stopped. Non-empty iff `grade` is `ungraded`. */
  hardStops: DimensionAssessment[];
}

const LETTER_RANK: Record<ModelGradeLetter, number> = { A: 4, B: 3, C: 2, D: 1 };

/**
 * Weakest link over the eight dimensions.
 *
 * A stronger dimension never compensates for a weaker one, so this is a
 * minimum, not an average or a vote. A dimension the caller does not supply is
 * treated as **unknown, which takes the conservative outcome** (D) rather than
 * being skipped — §5.1's rule that unknown evidence never reads as good
 * evidence. Anything that hard-stops makes the model ungraded outright.
 */
/**
 * Every dimension a policy result has something to say about, each named once.
 *
 * `disclosable` already CONTAINS the hard stops when the result came from
 * `evaluateGradePolicy`, so concatenating the two lists double-reports them. But a
 * hand-built result may carry a hard stop and an empty `disclosable` — the
 * "derived model with no committed grade" case is exactly that — and reading only
 * `disclosable` there states no reason at all, on the one result that most needs one.
 * Merging by dimension is the form that is right for both.
 */
export function statedDimensions(
  result: GradePolicyResult,
): readonly DimensionAssessment[] {
  const byDimension = new Map<GradeDimension, DimensionAssessment>();
  for (const item of [...result.disclosable, ...result.hardStops]) {
    if (!byDimension.has(item.dimension)) byDimension.set(item.dimension, item);
  }
  return [...byDimension.values()];
}

export function evaluateGradePolicy(
  assessments: readonly DimensionAssessment[],
): GradePolicyResult {
  const byDimension = new Map<GradeDimension, DimensionAssessment>();
  for (const assessment of assessments) {
    // A later duplicate does not silently win: keep the WORSE of the two, so a
    // caller cannot upgrade a dimension by asserting it twice.
    const existing = byDimension.get(assessment.dimension);
    byDimension.set(
      assessment.dimension,
      existing && worseOf(existing, assessment) === existing
        ? existing
        : assessment,
    );
  }

  const complete: DimensionAssessment[] = GRADE_DIMENSIONS.map(
    (dimension) =>
      byDimension.get(dimension) ?? {
        dimension,
        grade: 'D' as const,
        reason: 'Not assessed; unknown evidence takes the conservative outcome.',
      },
  );

  const hardStops = complete.filter((a) => a.grade === 'hard-stop');
  const disclosable = complete.filter(
    (a) => a.grade === 'C' || a.grade === 'D' || a.grade === 'hard-stop',
  );

  if (hardStops.length > 0) {
    return {
      grade: 'ungraded',
      limitingDimensions: hardStops.map((a) => a.dimension),
      disclosable,
      hardStops,
    };
  }

  let worst: ModelGradeLetter = 'A';
  for (const a of complete) {
    const letter = a.grade as ModelGradeLetter;
    if (LETTER_RANK[letter] < LETTER_RANK[worst]) worst = letter;
  }

  return {
    grade: worst,
    limitingDimensions:
      worst === 'A'
        ? []
        : complete.filter((a) => a.grade === worst).map((a) => a.dimension),
    disclosable,
    hardStops: [],
  };
}

function worseOf(
  a: DimensionAssessment,
  b: DimensionAssessment,
): DimensionAssessment {
  if (a.grade === 'hard-stop') return a;
  if (b.grade === 'hard-stop') return b;
  return LETTER_RANK[a.grade as ModelGradeLetter] <=
    LETTER_RANK[b.grade as ModelGradeLetter]
    ? a
    : b;
}

// --- Rendering ---------------------------------------------------------------

export type UserClass =
  | 'anonymous'
  | 'authenticated'
  | 'contributor'
  | 'editor'
  | 'admin';

/**
 * What a surface may do with a model for a given viewer.
 *
 * "Render" means draw a numeric curve or expose curve coordinates. A grade
 * badge, prose, or an empty chart state is NOT rendering, so `hidden` still
 * shows the reason and the evidence record.
 */
export type RenderDisposition =
  | 'render'
  | 'render-with-limitations'
  | 'acknowledge-in-review-workspace'
  | 'hidden';

const REVIEWER_CLASSES: ReadonlySet<UserClass> = new Set(['editor', 'admin']);

/** §5.1 floors. Login and contribution do not confer review competence. */
const BASE_MINIMUM_GRADE: Record<UserClass, ModelGradeLetter> = {
  anonymous: 'B',
  authenticated: 'B',
  contributor: 'B',
  editor: 'C',
  admin: 'C',
};

export interface RenderPolicyOptions {
  /**
   * A per-model, per-version D acknowledgement is on record for this viewer.
   * Only a reviewer class can use one; it never elevates anyone else, and it
   * never reaches a hard stop.
   */
  acknowledged?: boolean;
  /**
   * Amendment 1 (§5.2) is in force for this model — the reviewed override tier
   * with its disclosure conditions met. Lowers the non-reviewer floor to C.
   * Off by default so the un-amended §5.1 contract is what a caller gets unless
   * it deliberately opts in.
   */
  publicTier?: boolean;
}

/**
 * The disposition for one model and one viewer.
 *
 * Order matters and is the contract's: a hard stop is checked first and is
 * absolute; then the applicable floor; then the reviewer-only D path. Nothing
 * below can re-open something above.
 */
export function renderDisposition(
  result: GradePolicyResult,
  userClass: UserClass,
  options: RenderPolicyOptions = {},
): RenderDisposition {
  // A hard stop is not a low grade. No role, acknowledgement or amendment
  // reaches it.
  if (result.grade === 'ungraded') return 'hidden';

  const minimum = minimumGradeFor(userClass, options.publicTier ?? false);
  if (LETTER_RANK[result.grade] >= LETTER_RANK[minimum]) {
    // A is the only grade with nothing to disclose; everything else renders
    // carrying its limitations.
    return result.grade === 'A' ? 'render' : 'render-with-limitations';
  }

  // Below the floor, only a reviewer may reach a D — and only through a
  // recorded acknowledgement, in a labelled review workspace.
  if (REVIEWER_CLASSES.has(userClass) && result.grade === 'D') {
    return options.acknowledged
      ? 'render-with-limitations'
      : 'acknowledge-in-review-workspace';
  }

  return 'hidden';
}

/**
 * The grade floor in force for a viewer.
 *
 * Amendment 1 lowers the NON-REVIEWER floor to C. It does not touch the
 * reviewer floor (already C) and does not create a floor below C for anyone.
 */
export function minimumGradeFor(
  userClass: UserClass,
  publicTier: boolean,
): ModelGradeLetter {
  const base = BASE_MINIMUM_GRADE[userClass];
  if (!publicTier || REVIEWER_CLASSES.has(userClass)) return base;
  return 'C';
}

/**
 * Whether a surface may call the bands a confidence or prediction interval.
 *
 * §5.1 makes a mislabelled interval a hard stop, and §5.2 condition 3 requires
 * "plausible range" wording while uncertainty semantics score below B. A caller
 * that cannot honour this must not render at all.
 */
export function intervalSemanticsEstablished(
  result: GradePolicyResult,
): boolean {
  const uncertainty = result.disclosable.find(
    (a) => a.dimension === 'uncertainty-semantics',
  );
  return uncertainty === undefined;
}
