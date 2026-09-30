/**
 * `GovernanceAssuranceService` — the first read cutover (Phase 7 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 7 lets Kinetix *consume* generic-derived read state before the generic
 * engine controls publication. Nothing about what publishes changes here; what
 * changes is where the number on a monograph badge came from.
 *
 * ## The shape stays exactly the same
 *
 * §7.3 is explicit that Kinetix's 0–3 verification level must not become the
 * canonical generic state. The core owns an `AssuranceProfile` — counts,
 * capabilities, dispute state — and Kinetix *projects* that into its existing
 * `VerificationLevelInfo`. So the UI receives the same `{ level, disputed }` it
 * always has, and no component changes.
 *
 * ## Falling back is the normal case, not the error case
 *
 * A generic read is served only when three things hold: the target type is at
 * `generic_read` or beyond, the generic records exist, and they are *complete*
 * — every legacy verdict has a mirrored assessment. Anything else falls back to
 * the legacy calculation silently and correctly.
 *
 * "Complete" is checked rather than assumed because shadow mirroring is allowed
 * to fail (§12.1). A partially-mirrored target would produce a *lower* level
 * than the truth, and a badge that under-reports review is a badge that tells
 * a reader a verified value is unverified. Falling back where linkage is
 * incomplete is the same fail-safe direction as §1.6, pointed at a read.
 */

import { and, eq } from 'drizzle-orm';
import {
  isImplicitAssessment,
  kinetixAssuranceStore,
  readHostCapabilities,
} from './kinetix-compat.js';

import { getDb } from '../db.js';
import { agentVerifications, approvals } from '../../../db/schema.js';
import { summariseApprovalsForTargets } from '../approvals.js';
import { summariseVerificationsForTargets } from '../agent-verifications.js';
import {
  projectKinetixVerificationLevel,
  KINETIX_SPACE,
} from '../../../src/lib/assurance/projection.js';
import {
  computeVerificationLevel,
  type VerificationLevelInfo,
} from '../../../src/lib/verificationLevel.js';
import type { AssuranceProfile } from 'assurance-core';
import {
  NON_CANONICAL_SNAPSHOT_METRIC,
  UNREADABLE_HISTORY_METRIC,
  incrementMetric,
} from './metrics.js';
import type { KinetixAssuranceStore } from './store/assurance-port.js';
import { resolveMigrationMode } from './migration-state.js';
import { currentAssessments } from './store/assessments.js';
import { findByLegacy } from './store/legacy-links.js';
import { openDisputes } from './store/disputes.js';
import { latestVersion } from './store/versions.js';
import type { GovernanceDb } from './store/interface.js';
import type { ApprovalTargetType } from '../../../db/schema.js';

/**
 * The target types a verification level is computed for.
 *
 * `ApprovalTargetType`, not `AgentVerificationTargetType`: a level counts human
 * approval stamps as well as agent verdicts, and `approvals` does not carry a
 * `pending_edit` row. A pending edit has no level because it is not published
 * yet — its level is the level of whatever revision applying it produces.
 */
export type AssuranceTargetType = ApprovalTargetType;

/** Where a served level came from, for the rollout comparison log. */
export type AssuranceSource =
  | 'legacy'
  | 'generic'
  | 'legacy_fallback_incomplete'
  | 'legacy_fallback_error';

export interface ResolvedAssurance {
  readonly info: VerificationLevelInfo;
  readonly source: AssuranceSource;
  /** The legacy answer, always computed while the rollout is being watched. */
  readonly legacy: VerificationLevelInfo;
  /** The generic answer, when one could be produced. */
  readonly generic: VerificationLevelInfo | null;
}

/**
 * The port, wired to this host's observability.
 *
 * The store itself cannot import `./metrics.js` — `boundaries.test.ts` holds
 * it to drizzle, the core, the governance schema and the db handle, so that it
 * stays movable to another host — so it reports an unreadable assessment
 * history through a callback and the wiring lives here, on the host side of
 * that line. Construct the store this way rather than calling
 * `kinetixAssuranceStore` directly, or a version held for corrupt history is
 * held silently.
 */
export function observedAssuranceStore(
  db: GovernanceDb,
): KinetixAssuranceStore {
  return kinetixAssuranceStore(db, {
    // Labelled by proposal id so the answer to "which ones?" is in the counter
    // rather than only in the count.
    onUnreadableHistory: (proposalId) =>
      incrementMetric(UNREADABLE_HISTORY_METRIC, proposalId),
    // Counted separately from unreadable history: that one holds the version,
    // this one does not. A non-canonical snapshot confers nothing and the
    // version can still publish on its other approvals — so without a counter
    // it is invisible, which is exactly how a corrupt row passes as an
    // ordinary approval by an assessor with no standing.
    onNonCanonicalSnapshot: (proposalId) =>
      incrementMetric(NON_CANONICAL_SNAPSHOT_METRIC, proposalId),
  });
}

/**
 * Build an `AssuranceProfile` from the generic records for one legacy target.
 *
 * Returns `null` — meaning "not available", not "nothing approved it" — when
 * the target has no mirrored proposal or version. The distinction matters: an
 * empty profile projects to level 0, and serving that for an unmirrored target
 * would silently downgrade every value the mirror has not reached yet.
 */
export async function genericAssuranceProfile(
  db: GovernanceDb,
  target: { targetType: string; targetId: number },
): Promise<AssuranceProfile | null> {
  const link = await findByLegacy(db, target.targetType, target.targetId);
  if (!link) return null;
  const version = await latestVersion(db, link.genericId);
  if (!version) return null;

  const assessments = await currentAssessments(db, {
    subjectType: 'proposal_version',
    subjectId: version.id,
  });
  const disputes = await openDisputes(db, {
    subjectType: 'proposal_version',
    subjectId: version.id,
  });

  // Decoded once per assessment, before anything is filtered by verdict or
  // actor kind. Reporting from inside the capability aggregates made the
  // counter measure the wrong thing entirely: a malformed human approval was
  // decoded by both the explicit and the human aggregate and counted twice,
  // while one on a dispute, an abstention or an implicit approval was never
  // decoded at all and so never counted. A corruption signal whose value
  // depends on the verdict of the corrupt row is not a corruption signal.
  const decoded = new Map(
    assessments.map((a) => [a, readHostCapabilities(a.capabilitySnapshot)] as const),
  );
  for (const read of decoded.values()) {
    if (!read.readable) {
      incrementMetric(NON_CANONICAL_SNAPSHOT_METRIC, String(link.genericId));
    }
  }

  const approvals = assessments.filter((a) => a.verdict === 'approve');
  // Through the shared reader, not `?.isImplicit`: that truthiness test saw
  // only a historical row's snapshot marker, so a canonically written implicit
  // approval — the marker in `independence_group`, where the generic schema
  // puts it — counted as an explicit one and reached a quorum meant to be
  // independent of its author.
  const implicit = approvals.filter((a) => isImplicitAssessment(a));
  const explicit = approvals.filter((a) => !implicit.includes(a));
  const humans = explicit.filter((a) => a.actorKind === 'human');
  const agentsApproving = explicit.filter((a) => a.actorKind === 'agent');
  // Likewise: the tier is one of several shapes a capability can arrive in,
  // and re-deriving `model_tier:` here from one of them meant a canonically
  // recorded capability did not count.
  const capabilityOf = (a: (typeof assessments)[number]) =>
    decoded.get(a)?.capabilities ?? [];

  return {
    explicitApprovals: explicit.length,
    // Every explicit approval that reaches the gate is one it may count:
    // Kinetix's admission rules already exclude an author's own verdict unless
    // an admin's self-review grant admitted it, and that grant simultaneously
    // enlarges the reviewer pool.
    independentApprovers: explicit.length,
    humanApprovals: humans.length,
    agentApprovals: agentsApproving.length,
    implicitApprovals: implicit.length,
    approvalCapabilities: [...new Set(explicit.flatMap(capabilityOf))].sort(),
    humanApprovalCapabilities: [...new Set(humans.flatMap(capabilityOf))].sort(),
    disputingAssessors: assessments.filter((a) => a.verdict === 'dispute').length,
    disputesOpen: disputes.length,
    abstentions: assessments.filter((a) => a.verdict === 'abstain').length,
    evidenceRequirementState: [],
  };
}

/**
 * Is every legacy judgment on this target mirrored?
 *
 * Both halves count: agent verdicts in `agent_verifications` **and** human
 * approval stamps in `approvals`. Checking only the agent side was the first
 * version of this function, and it let a human-approved revision be served from
 * a generic profile that could not see the stamp — a level lower than the
 * truth, on exactly the values a person had taken the trouble to endorse.
 *
 * Counts rather than compares row by row: the question is whether anything was
 * lost, and a count answers it in one query per side. A generic side with
 * *more* rows than legacy is also a mismatch and also falls back — it means the
 * mirror wrote something legacy has since removed, and serving a level built on
 * a verdict that no longer exists would over-report review.
 */
export async function linkageIsComplete(
  db: GovernanceDb,
  target: { targetType: string; targetId: number },
): Promise<boolean> {
  const link = await findByLegacy(db, target.targetType, target.targetId);
  if (!link) return false;
  const version = await latestVersion(db, link.genericId);
  if (!version) return false;

  const legacyRows = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, target.targetType),
        eq(agentVerifications.targetId, target.targetId),
      ),
    );
  const approvalRows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.targetType, target.targetType),
        eq(approvals.targetId, target.targetId),
      ),
    );
  // *Current* rows, not every row ever written. A reviewer that changes its
  // mind leaves two generic assessments behind one legacy verdict — the mirror
  // records a correction by superseding, because the legacy table upserts in
  // place and would otherwise lose the earlier judgment entirely. Counting the
  // superseded row here would make every corrected verdict look like a linkage
  // surplus and fall back to legacy forever, which is safe and useless.
  const genericRows = await currentAssessments(db, {
    subjectType: 'proposal_version',
    subjectId: version.id,
  });
  return legacyRows.length + approvalRows.length === genericRows.length;
}

/**
 * The legacy verification level for one revision target — the calculation
 * `api/_lib/verification-levels.ts` performs, expressed for a single target.
 *
 * Kept here rather than imported so that the fallback path does not depend on
 * a module that reaches for `getNeonClient()`, which is not available in every
 * environment the service runs in.
 */
export async function legacyVerificationLevel(target: {
  targetType: AssuranceTargetType;
  targetId: number;
  authorSelfVerified?: boolean;
}): Promise<VerificationLevelInfo> {
  const [verifications, approvals] = await Promise.all([
    summariseVerificationsForTargets({
      targetType: target.targetType,
      targetIds: [target.targetId],
    }),
    summariseApprovalsForTargets({
      targetType: target.targetType,
      targetIds: [target.targetId],
    }),
  ]);
  const v = verifications.get(target.targetId);
  const a = approvals.get(target.targetId);
  return {
    level: computeVerificationLevel({
      agentApprovers: (v?.approveCount ?? 0) + (v?.implicitApproveCount ?? 0),
      hasHumanApprover: (a?.approvers ?? []).some((ap) => !ap.isAgent),
      authorSelfVerified: target.authorSelfVerified ?? false,
    }),
    disputed: (v?.disputeCount ?? 0) > 0,
  };
}

/**
 * Resolve the verification level for one target, honouring the migration mode.
 *
 * The legacy answer is always computed while the rollout is being watched, so
 * the comparison the plan asks for ("compare returned level/dispute state in
 * logs during rollout") is available on every call rather than needing a second
 * pass. When the mode is below `generic_read` that is the only work done — this
 * is the hot read path for monograph badges, and a target nobody has advanced
 * must cost exactly what it costs today.
 */
export async function resolveVerificationLevel(args: {
  targetType: AssuranceTargetType;
  targetId: number;
  authorSelfVerified?: boolean;
  db?: GovernanceDb;
  space?: string;
}): Promise<ResolvedAssurance> {
  const legacy = await legacyVerificationLevel(args);
  const mode = await resolveMigrationMode(args.targetType, {
    space: args.space ?? KINETIX_SPACE,
  });
  if (mode !== 'generic_read' && mode !== 'legacy_write_generic_mirror' && mode !== 'generic_authoritative') {
    return { info: legacy, source: 'legacy', legacy, generic: null };
  }

  const db = args.db ?? getDb();
  try {
    if (!(await linkageIsComplete(db, args))) {
      incrementMetric('kg_read_fallback_total', 'linkage_incomplete');
      return {
        info: legacy,
        source: 'legacy_fallback_incomplete',
        legacy,
        generic: null,
      };
    }
    const profile = await genericAssuranceProfile(db, args);
    if (!profile) {
      incrementMetric('kg_read_fallback_total', 'no_generic_profile');
      return {
        info: legacy,
        source: 'legacy_fallback_incomplete',
        legacy,
        generic: null,
      };
    }
    const generic = projectKinetixVerificationLevel(profile, {
      authorSelfVerified: args.authorSelfVerified ?? false,
    });
    if (generic.level !== legacy.level || generic.disputed !== legacy.disputed) {
      // Logged, not thrown, and the generic answer is still served: this is
      // the divergence the rollout exists to surface, and hiding it behind a
      // silent fallback would mean the comparison never fires.
      console.warn(
        `[kg-assurance] divergence on ${args.targetType}#${args.targetId}: ` +
          `legacy=${legacy.level}/${legacy.disputed} generic=${generic.level}/${generic.disputed}`,
      );
    }
    return { info: generic, source: 'generic', legacy, generic };
  } catch (err) {
    console.warn(
      `[kg-assurance] generic read failed for ${args.targetType}#${args.targetId}; ` +
        `serving legacy: ${err instanceof Error ? err.message : String(err)}`,
    );
    incrementMetric('kg_read_fallback_total', 'generic_read_error');
    return {
      info: legacy,
      source: 'legacy_fallback_error',
      legacy,
      generic: null,
    };
  }
}

/**
 * Batch form for a page of revision targets.
 *
 * Short-circuits to `null` when the target type is not advanced, so the caller
 * keeps its existing batched legacy calculation and adds **zero** queries in
 * the mode everything ships in. Substituting per row only happens once someone
 * has deliberately advanced the type.
 */
export async function genericLevelsForTargets(args: {
  targetType: AssuranceTargetType;
  targetIds: readonly number[];
  authorSelfVerified?: ReadonlySet<number>;
  db?: GovernanceDb;
  space?: string;
}): Promise<Map<number, VerificationLevelInfo> | null> {
  if (args.targetIds.length === 0) return null;
  const mode = await resolveMigrationMode(args.targetType, {
    space: args.space ?? KINETIX_SPACE,
  });
  if (mode !== 'generic_read' && mode !== 'legacy_write_generic_mirror' && mode !== 'generic_authoritative') {
    return null;
  }

  const db = args.db ?? getDb();
  const out = new Map<number, VerificationLevelInfo>();
  for (const targetId of args.targetIds) {
    const resolved = await resolveVerificationLevel({
      targetType: args.targetType,
      targetId,
      authorSelfVerified: args.authorSelfVerified?.has(targetId) ?? false,
      db,
      space: args.space,
    });
    // Only the rows the generic path could actually answer are substituted;
    // the caller keeps its legacy value for the rest, which is what makes a
    // partial mirror a non-event rather than a page of zeroes.
    if (resolved.source === 'generic') out.set(targetId, resolved.info);
  }
  return out.size > 0 ? out : null;
}
