/**
 * Which (drug, parameter) pairs are worth asking about at all.
 *
 * The maintenance agent's core-coverage queue (§3 tier A in
 * `agents/drug-db-maintainer.md`) is a plain "no row in `drug_parameters`"
 * gap scan. On its own that query has no memory and no notion of a quantity
 * that cannot exist, so an unfillable pair sits at the head of the queue and
 * is re-selected every hour, forever. Benzoylecgonine's bioavailability was
 * the first one to surface: it is a cocaine metabolite formed in vivo, nobody
 * administers it, and absolute bioavailability needs an administered dose —
 * so The Method (§4) lands on `absent` every cycle and the gap never closes.
 *
 * Three layers keep that from happening, cheapest and broadest first:
 *
 *   1. **Substance class** (automatic, class-wide) — a substance that is never
 *      administered has no bioavailability and no dose, because both need a
 *      dose *of that substance*. Note the boundary: tmax is **not** in that
 *      set, since a metabolite's time to peak is measured after the parent is
 *      dosed and is routinely published. This module's
 *      `parameterAppliesToSubstanceClass` encodes that rule from the drug's
 *      `substanceClass` and the parameter spec's `requiresAdministration`, so
 *      one classification retires several pairs at once and new metabolites
 *      inherit it for free.
 *   2. **Explicit not-applicable marker** (human, pair-level, permanent) — the
 *      `drug_parameter_applicability` table, for one-off pairs the class rule
 *      cannot express. An editor sets it with a reason.
 *   3. **Absent cooldown** (automatic, pair-level, temporary) — after an
 *      exhaustive search that found nothing, the pair is suppressed for
 *      `ABSENT_RECHECK_DAYS` rather than forever, because literature that does
 *      not exist today may exist next year.
 *
 * Layers 1 and 2 are permanent judgements about the quantity; layer 3 is a
 * statement about the literature at a point in time. Keeping them distinct is
 * what lets the queue skip an impossible pair without also going blind to a
 * merely undiscovered one.
 */
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  parameterAuthoringGated,
} from './drugParameters.js';

// ─── Substance class ────────────────────────────────────────────────────────

/**
 * What kind of thing a registry entry is. Free-form varchar in the database to
 * match the repo convention of avoiding native PG enums (see the `source`
 * column on `drugs`); this list is the validated set the API accepts.
 */
export const SUBSTANCE_CLASSES = [
  /** Administered as a drug or product — the default for a registry entry. */
  'drug',
  /**
   * Formed in vivo from a parent substance and not administered itself. Note
   * that "is a metabolite of something" is NOT sufficient: morphine is a
   * metabolite of codeine and oxazepam of diazepam, yet both are marketed and
   * administered, so both stay `drug`. This class is only for entries that are
   * exclusively analytes — benzoylecgonine, THC-COOH, 6-MAM.
   */
  'metabolite',
  /**
   * Produced by normal physiology and measured as a marker rather than
   * administered — creatinine as a renal-function marker.
   *
   * The same trap as `metabolite`, one step further: "the body makes it" is not
   * the bar either. GHB is endogenous and is also sodium oxybate; beta-
   * hydroxybutyrate is endogenous and is also sold as ketone salts and esters
   * with published human tmax and bioavailability. Both stay `drug`. A
   * substance qualifies here only if nobody administers it in any form, since
   * the class permanently forbids storing the absorption and dose data that
   * administration produces.
   */
  'endogenous',
] as const;

export type SubstanceClass = (typeof SUBSTANCE_CLASSES)[number];

/** What an unclassified registry entry is treated as. */
export const DEFAULT_SUBSTANCE_CLASS: SubstanceClass = 'drug';

export function isSubstanceClass(value: unknown): value is SubstanceClass {
  return (
    typeof value === 'string' &&
    (SUBSTANCE_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Normalize a raw column value. NULL/unknown reads as the default rather than
 * throwing: a row written by an older release, or by a future release using a
 * class this build does not know, must not make the substance disappear from
 * the queue. Defaulting to `drug` keeps every parameter in scope, which is the
 * safe direction to fail — a spurious gap costs one cycle, a wrongly hidden
 * one hides real missing data indefinitely.
 */
export function normalizeSubstanceClass(value: unknown): SubstanceClass {
  return isSubstanceClass(value) ? value : DEFAULT_SUBSTANCE_CLASS;
}

/** Classes whose substances are actually administered to a subject. */
export function substanceIsAdministered(value: unknown): boolean {
  return normalizeSubstanceClass(value) === 'drug';
}

// ─── Parameter × substance-class rule ───────────────────────────────────────

/**
 * Whether a parameter is a meaningful quantity for a substance of this class.
 *
 * Only the administration rule lives here. Everything else — whether the value
 * happens to be known, whether anyone has searched for it — is queue state,
 * not applicability.
 */
export function parameterAppliesToSubstanceClass(
  parameter: string,
  substanceClass: unknown,
): boolean {
  if (!isDrugParameterId(parameter)) return true;
  if (!DRUG_PARAMETERS[parameter].requiresAdministration) return true;
  return substanceIsAdministered(substanceClass);
}

/**
 * Every parameter that is undefined for a substance nobody administers. Used
 * to explain the exclusion in API responses and to build the gap query's
 * filter, so the SQL and the TypeScript rule cannot drift apart.
 */
export function parametersRequiringAdministration(): string[] {
  return Object.values(DRUG_PARAMETERS)
    .filter((spec) => spec.requiresAdministration)
    .map((spec) => spec.id);
}

/**
 * The classes whose substances are not administered, as an explicit list.
 *
 * The gap query filters with `substance_class = ANY(<this list>)` rather than
 * `substance_class <> 'drug'` so that SQL and `normalizeSubstanceClass` agree
 * on an unrecognised value: both treat it as administered and keep every
 * parameter in scope. Inverting the test would make a class this build has not
 * heard of silently hide real gaps.
 */
export function nonAdministeredSubstanceClasses(): SubstanceClass[] {
  return SUBSTANCE_CLASSES.filter((c) => !substanceIsAdministered(c));
}

// ─── Core coverage set ──────────────────────────────────────────────────────

/**
 * The parameters the maintenance agent's tier-A queue treats as expected of
 * every substance, in priority order (index = priority, lowest first).
 *
 * The first six are the documented core in §3 of
 * `agents/drug-db-maintainer.md`; the rest are the broader chemistry/PK set the
 * dev-side `scripts/prioritize-param.ts` has always scanned. Exporting one
 * ordered list is what keeps the prompt, the script and
 * `GET /api/agent-sweep?mode=parameter_gaps` from disagreeing about what
 * counts as a gap — they previously named different sets in three places.
 *
 * `postmortemRedistribution` is deliberately absent: it is in scope for flags
 * and forensic monograph work, not mandatory per-drug coverage.
 */
export const CORE_COVERAGE_PARAMETERS = [
  'molecularWeight',
  'bloodPlasmaRatio',
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'tmax',
  'proteinBinding',
  'pKa',
  'logP',
  'logD',
  'clearance',
] as const;

// ─── Model-declaration set ──────────────────────────────────────────────────

/**
 * The parameters that declare a drug's PK MODEL rather than measure a quantity
 * of it, in priority order — the three CV-1b structural axes plus the
 * route-scoped absorption rate they need to run.
 *
 * Kept apart from `CORE_COVERAGE_PARAMETERS` because the two are *filled*
 * differently, not merely ranked differently. A core parameter publishes a
 * cached aggregate into `drug_parameters`, so "no row there" is the gap test.
 * None of these do: `recomputeAndCacheParameterSummary` returns early for
 * anything that is not `summarizable`, and all four are `summarizable: false`
 * (the axes are asserted with a citation rather than pooled; `ka` is per-route,
 * so there is no single drug-level aggregate to cache). Ranking them into the
 * core list would therefore recreate the benzoylecgonine loop exactly — a pair
 * that can never satisfy the queue's fill test, re-served every hour forever.
 * The queue gives them their own test instead: a live `parameter_entries` row.
 *
 * They rank after core coverage in the unfocused queue: every model family
 * needs the numbers too, so a drug with no half-life gains nothing from a
 * compartment count. Reaching them by falling through is not the intended
 * route — `mode = "methods"` with these four selected is (see
 * `resolveFocusNarrowing`).
 */
export const MODEL_DECLARATION_PARAMETERS = [
  'dispositionModel',
  'eliminationModel',
  'absorptionModel',
  'ka',
] as const;

export type ModelDeclarationParameter =
  (typeof MODEL_DECLARATION_PARAMETERS)[number];

/**
 * Whether this parameter is filled by declaring a cited entry rather than by
 * publishing an aggregate value — i.e. which of the gap queue's two fill tests
 * applies to it.
 */
export function parameterIsDeclaredByEntry(parameter: string): boolean {
  return (MODEL_DECLARATION_PARAMETERS as readonly string[]).includes(
    parameter,
  );
}

// ─── Dose-context observation set ───────────────────────────────────────────

/**
 * The entry-only parameters whose every reading carries structured dose
 * context (`doseContext: 'required'` — Cmax today; the RFC names AUC as the
 * next), in registry order. The gap queue's fourth lane,
 * `fill_kind: "observation"`.
 *
 * A lane of their own, not a place in either list above, for the same reason
 * the declarations have one: they are *filled* differently. There is no
 * drug-level value — the registry marks them `summarizable: false`, and the
 * headline is a per-dose summary derived at read time
 * (`src/lib/cmaxNormalization.ts`), never cached — so the core lane's "no
 * `drug_parameters` row" test would answer "missing" forever. And the payload
 * that closes one is neither a pooled value nor a model claim but one cohort's
 * reading with its dose, regimen, formulation, population and statistic, which
 * the routine has to know to capture before it opens the paper.
 *
 * Derived from the registry rather than written out, so a parameter joins the
 * lane the moment it declares required dose context — and leaves it while its
 * authoring gate is shut: serving a pair the write endpoint refuses with
 * `parameter_authoring_gated` would spend every cycle on a guaranteed 403.
 *
 * Without this lane the admin focus picker offered Cmax (it is a legal work
 * target) and selecting it resolved to an empty queue: the narrowing filters
 * within the lanes, and Cmax was in none of them (#1346).
 */
export const DOSE_CONTEXT_OBSERVATION_PARAMETERS: readonly string[] =
  Object.values(DRUG_PARAMETERS)
    .filter(
      (spec) =>
        spec.doseContext === 'required' && !parameterAuthoringGated(spec.id),
    )
    .map((spec) => spec.id);

// ─── Explicit marker ────────────────────────────────────────────────────────

/**
 * Status values for a `drug_parameter_applicability` row. Only one today; the
 * column exists so a future "applicable but not expected to be findable"
 * distinction does not need a migration.
 */
export const APPLICABILITY_STATUSES = ['not_applicable'] as const;

export type ApplicabilityStatus = (typeof APPLICABILITY_STATUSES)[number];

export function isApplicabilityStatus(
  value: unknown,
): value is ApplicabilityStatus {
  return (
    typeof value === 'string' &&
    (APPLICABILITY_STATUSES as readonly string[]).includes(value)
  );
}

// ─── Absent cooldown ────────────────────────────────────────────────────────

/**
 * How long an exhaustive-but-empty search suppresses a pair from the gap
 * queue. Long enough that the agent is not re-searching the same dead end
 * every hour (the failure this whole module exists to fix), short enough that
 * a genuinely new primary study is picked up within a year of publication.
 *
 * This is deliberately a cooldown and not a permanent retirement: `absent`
 * means "nothing found today", which is a claim about the literature, and the
 * literature moves. Pairs that are undefined rather than unstudied belong in
 * the substance-class rule or the explicit marker above.
 */
export const ABSENT_RECHECK_DAYS = 180;

// ─── Combined verdict ───────────────────────────────────────────────────────

export type GapSuppressionReason =
  | 'not_applicable_marker'
  | 'substance_class'
  | 'absent_cooldown';

export interface GapSuppressionInput {
  parameter: string;
  substanceClass: unknown;
  /** Status from `drug_parameter_applicability`, when a row exists. */
  markerStatus?: unknown;
  /**
   * `verified_at` of the most recent `concordance='absent'` verification for
   * this pair, when one exists.
   */
  lastAbsentAt?: Date | string | null;
  /** Evaluation time; injected so the rule is testable without clock control. */
  now: Date;
}

/**
 * The single place the three layers combine. Returns the reason the pair
 * should stay out of the gap queue, or `null` when it is genuine open work.
 *
 * Order matters only for reporting — the permanent reasons are checked first
 * so a pair that is both undefined and recently searched is explained by the
 * durable fact rather than by the cooldown that would expire.
 */
export function gapSuppressionReason(
  input: GapSuppressionInput,
): GapSuppressionReason | null {
  if (isApplicabilityStatus(input.markerStatus)) return 'not_applicable_marker';

  if (!parameterAppliesToSubstanceClass(input.parameter, input.substanceClass)) {
    return 'substance_class';
  }

  if (input.lastAbsentAt) {
    const last = new Date(input.lastAbsentAt);
    if (!Number.isNaN(last.getTime())) {
      const elapsedDays =
        (input.now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
      // A future-dated row (clock skew, a hand-written backfill) reads as
      // "searched very recently" rather than as an expired cooldown.
      if (elapsedDays < ABSENT_RECHECK_DAYS) return 'absent_cooldown';
    }
  }

  return null;
}
