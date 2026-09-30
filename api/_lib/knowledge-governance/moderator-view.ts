/**
 * The moderator/auditor read model (§8.2 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * §8.2 requires **two** read models, and only one has existed until now. The
 * reviewer's is `ReviewPacket`, sealed so it cannot carry a peer's judgment.
 * This is the other one, and its defining property is the exact inverse: a
 * moderator is supposed to see everything.
 *
 * §8.2 lists five things it must contain — all assessments, dispute rationales,
 * assurance summary, policy requirement state, complete history — and this
 * returns those five.
 *
 * ## Why it is a separate module and not a flag on the packet
 *
 * A `includePeerVerdicts: true` parameter on `buildReviewPacket` would be one
 * boolean between a reviewer and every other reviewer's verdict. The whole
 * anti-echo-chamber guarantee would then rest on every call site passing the
 * right value, forever, including call sites nobody has written yet.
 *
 * Two functions in two modules cannot be confused by a default argument. The
 * reviewer path physically cannot produce this shape, and this path physically
 * cannot be reached from the queue.
 *
 * ## Nothing here is redacted, and that is the point
 *
 * `sealReviewPacket`'s leak guard is deliberately *not* applied. A moderator
 * view that scrubbed verdicts would be useless for the job it exists for —
 * deciding whether the reviewers were right. The guard protects the reviewer
 * path; applying it here would be cargo-culting the mechanism past the reason
 * for it.
 *
 * The audience separation is therefore the caller's responsibility, and is
 * stated rather than assumed: this must only be served to an actor who may
 * moderate. Kinetix enforces that with `review.edit.decide` on the routes that
 * would call it.
 */

import { getDb } from '../db.js';
import { KINETIX_SPACE } from './actor-context.js';
import {
  currentAssessments,
  decisionRequirements,
  evidenceForSubject,
  getProposal,
  latestDecisionForVersion,
  listAssessments,
  listPublicationEvents,
  listRulings,
  listVersions,
  openDisputes,
  findByLegacy,
} from './store/postgres.js';
import { genericAssuranceProfile } from './assurance-service.js';
import type {
  AssessmentRecord,
  DisputeRecord,
  DisputeRulingRecord,
  GovernanceDb,
  PolicyDecisionRecord,
  ProposalRecord,
  ProposalVersionRecord,
  PublicationEventRecord,
} from './store/interface.js';
import type { AssuranceProfile } from 'assurance-core';

/** One dispute with the rulings made on it (§8.2: "dispute rationales"). */
export interface DisputeWithRulings {
  readonly dispute: DisputeRecord;
  readonly rulings: readonly DisputeRulingRecord[];
}

/**
 * The requirement state of the latest policy decision (§8.2: "policy
 * requirement state", and §20 Stage 2's "policy hold reasons").
 */
export interface RequirementState {
  readonly decision: PolicyDecisionRecord | null;
  /** Requirement ids that were not met, in evaluation order. */
  readonly unmet: readonly string[];
  /** The full breakdown as recorded, for a UI that wants to show all of it. */
  readonly requirements: unknown;
}

export interface ModeratorView {
  readonly proposal: ProposalRecord | null;
  readonly versions: readonly ProposalVersionRecord[];
  readonly currentVersion: ProposalVersionRecord | null;
  /**
   * Every assessment ever recorded, superseded ones included.
   *
   * §8.2 says "all assessments", and the superseded ones are most of the value:
   * "this reviewer disputed it in March and approved it in May" is a fact about
   * the review, and it is exactly what `agent_verifications` destroys.
   */
  readonly assessments: readonly AssessmentRecord[];
  /**
   * Judgments recorded against the *target* rather than any one version.
   *
   * Historical imports put a verdict here whenever the source cannot prove
   * which revision it judged (§8.3), and `snapshotLegacyVerifications` puts
   * every row it reads here for the same reason. They are deliberately not
   * version evidence — no version-specific gate may see them, and merging them
   * into `assessments` would be exactly that mistake — but they *are* history,
   * and §8.2 promises the whole of it. Leaving them out let the migration erase
   * a judgment from the record it claims is complete: the legacy link exists,
   * so reconciliation reports the row clean, and the verdict is visible nowhere
   * but the CLI report that imported it.
   *
   * Kept as a separate field so a reader has to opt in, and so the distinction
   * the importer was careful to record survives being read back.
   */
  readonly targetAssessments: readonly AssessmentRecord[];
  /** The subset that counts right now — newest unsuperseded per actor. */
  readonly effectiveAssessments: readonly AssessmentRecord[];
  readonly disputes: readonly DisputeWithRulings[];
  /** §8.2: assurance summary. `null` when nothing generic backs this target. */
  readonly assurance: AssuranceProfile | null;
  readonly requirementState: RequirementState;
  /** §8.2: complete history. */
  readonly publicationEvents: readonly PublicationEventRecord[];
  /** §20 Stage 2: evidence requirement status, per the recorded decision. */
  readonly evidence: ReadonlyArray<{ kind: string; ref: string | null }>;
}

/**
 * Assemble the moderator view for one generic proposal.
 *
 * Returns `null` only when the proposal does not exist — an unmirrored or
 * un-assessed proposal produces a view with empty sections rather than
 * nothing, because "no reviews yet" is information a moderator wants and an
 * absent view is not.
 */
export async function moderatorView(
  proposalId: number,
  opts: { db?: GovernanceDb } = {},
): Promise<ModeratorView | null> {
  const db = opts.db ?? getDb();
  const proposal = await getProposal(db, proposalId);
  if (!proposal) return null;

  const versions = await listVersions(db, proposalId);
  const currentVersion =
    versions.find((v) => v.id === proposal.currentVersionId) ??
    versions[versions.length - 1] ??
    null;

  const assessments: AssessmentRecord[] = [];
  const effective: AssessmentRecord[] = [];
  const disputes: DisputeWithRulings[] = [];
  const events: PublicationEventRecord[] = [];
  const evidence: Array<{ kind: string; ref: string | null }> = [];

  for (const version of versions) {
    const subject = { subjectType: 'proposal_version' as const, subjectId: version.id };
    assessments.push(...(await listAssessments(db, subject)));
    events.push(...(await listPublicationEvents(db, version.id)));
    for (const open of await openDisputes(db, subject)) {
      disputes.push({ dispute: open, rulings: await listRulings(db, open.id) });
    }
    for (const attached of await evidenceForSubject(db, subject)) {
      evidence.push({ kind: attached.item.kind, ref: attached.item.externalRef });
    }
  }
  // Target-level history: the imported judgments whose reviewed version the
  // source could not establish. Read once from the proposal's target, not per
  // version — they are attached to neither.
  const targetAssessments = await listAssessments(db, {
    subjectType: 'target',
    subjectId: proposal.targetId,
  });

  if (currentVersion) {
    effective.push(
      ...(await currentAssessments(db, {
        subjectType: 'proposal_version',
        subjectId: currentVersion.id,
      })),
    );
  }

  const decision = currentVersion
    ? await latestDecisionForVersion(db, currentVersion.id)
    : null;
  const breakdown = decision ? await decisionRequirements(db, decision.id) : null;

  return {
    proposal,
    versions,
    currentVersion,
    assessments,
    targetAssessments,
    effectiveAssessments: effective,
    disputes,
    assurance: await assuranceForProposal(db, proposal),
    requirementState: {
      decision,
      unmet: unmetIds(breakdown?.unsatisfied),
      requirements: breakdown?.requirements ?? null,
    },
    publicationEvents: events,
    evidence,
  };
}

/** The moderator view for a Kinetix row, via its legacy link. */
export async function moderatorViewForLegacy(
  legacyType: string,
  legacyId: number,
  opts: { db?: GovernanceDb } = {},
): Promise<ModeratorView | null> {
  const db = opts.db ?? getDb();
  const link = await findByLegacy(db, legacyType, legacyId);
  return link ? moderatorView(link.genericId, { db }) : null;
}

async function assuranceForProposal(
  db: GovernanceDb,
  proposal: ProposalRecord,
): Promise<AssuranceProfile | null> {
  // `genericAssuranceProfile` is keyed on the *legacy* target, which is how
  // Phase 7 reads it. Reuse rather than reimplement: a second tally would be a
  // second thing that can disagree with the badge a user sees.
  const link = await findByLegacy(db, 'pending_edit', proposal.id).catch(() => null);
  if (!link) return null;
  return genericAssuranceProfile(db, {
    targetType: 'pending_edit',
    targetId: link.legacyId,
  });
}

/** The failing requirement ids from a recorded breakdown, in evaluation order. */
function unmetIds(unsatisfied: unknown): string[] {
  if (!Array.isArray(unsatisfied)) return [];
  return unsatisfied
    .map((o) => (o as { requirementId?: unknown }).requirementId)
    .filter((id): id is string => typeof id === 'string');
}

export { KINETIX_SPACE };
