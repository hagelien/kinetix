/**
 * The first authoritative cutover (Phase 8 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Up to Phase 7 the generic engine watched. Here, for one edit type and only
 * when explicitly advanced, it *decides*: the policy decision recorded is
 * `authoritative`, and whether the change publishes follows from it rather than
 * from `consensusApprovalHoldReason`. Kinetix still performs the mutation —
 * the adapter's `apply()` delegates to `applyApprovedEdit` — so what moves is
 * the authority, not the machinery.
 *
 * ## The two failure directions, and why they are handled differently
 *
 * The plan draws a hard line at the commit (§ "Failure fallback"):
 *
 *   - **Before any domain mutation is committed**, a generic orchestration
 *     failure may fall back to the legacy path. Nothing has happened yet, so
 *     the safe thing is to let the proven code decide.
 *   - **After a generic transaction has committed a publication event**, the
 *     same mutation must never be replayed through legacy. That is how a fact
 *     gets applied twice.
 *
 * `publishOnAgentConsensus` is built around that line. Everything before
 * `apply()` — resolving authority, gathering facts, evaluating policy, finding
 * the mirrored version — returns `fell_back`, and the caller runs the legacy
 * gate as if this module did not exist. From the moment the transaction opens,
 * the outcome is `applied`, `held` or `failed`, and `failed` is *not* a
 * fallback: it is reported as itself, because a fault inside the unit of work
 * cannot be distinguished from a partial one by anything this layer can see.
 *
 * ## Idempotency
 *
 * The publication event is the record of record. Before applying, this checks
 * for an `applied` event on the version and stops if one exists — so a retried
 * request, a duplicated verdict, or a legacy path that ran anyway cannot apply
 * the same version twice. The event and the mutation share one transaction, so
 * there is no window where one exists without the other.
 */

import { inTransaction } from '../db.js';
import { getDb } from '../db.js';
import { KINETIX_SPACE, userActorRef } from './actor-context.js';
import { ensureKinetixSpace } from './backfill.js';
import { resolveApplyAuthority, type ApplyAuthority } from './cutover.js';
import { collectConsensusFacts, evaluateShadowPolicy } from './policy-shadow.js';
import {
  genericConsensusHoldReason,
  type GenericConsensusHoldReason,
} from '../../../src/lib/assurance/projection.js';
import { getKnowledgeTargetAdapter } from './registry.js';
import { incrementMetric } from './metrics.js';
import { recordAuditEvent } from './store/audit.js';
import {
  listPublicationEvents,
  recordCoreDecision,
  recordPublicationEvent,
} from './store/decisions.js';
import { findByLegacy } from './store/legacy-links.js';
import { getVersion, latestVersion } from './store/versions.js';
import { setProposalState } from './store/proposals.js';
import type { GovernanceDb } from './store/interface.js';
import type { ActorContext } from 'assurance-core';

/**
 * What the generic path did.
 *
 * `fell_back` is the only value that means "run the legacy gate now". The
 * others all mean the generic path owned this decision and the caller must not
 * second-guess it — `held` included, since a hold is a decision.
 */
export type PublicationOutcome =
  | 'applied'
  | 'held'
  | 'already_applied'
  | 'fell_back'
  | 'failed';

export interface PublicationResult {
  readonly outcome: PublicationOutcome;
  /** Why the generic path declined to own this, when it declined. */
  readonly reason: string;
  /** Unmet requirement ids when the outcome is `held`. */
  readonly unmet: readonly string[];
  /**
   * Which specific requirement held the version, projected onto the legacy
   * `AgentConsensusHold` vocabulary the moderator-facing sweep reports.
   * Populated only when `outcome` is `held` — every other outcome either
   * published, fell back, or failed for a reason `unmet` cannot describe.
   */
  readonly holdReason: GenericConsensusHoldReason | null;
  readonly authority: ApplyAuthority | null;
}

/**
 * Every exit that hands the decision back to the legacy gate.
 *
 * `label` is the *reason*, not the target type, and is counted (§17.3). "It
 * fell back 40 times" is not actionable; "40 times because nothing was
 * mirrored" points straight at the mirror. The label is a fixed vocabulary
 * rather than the free-text `reason`, so the counter has bounded cardinality.
 */
function fellBack(
  label: FallbackLabel,
  reason: string,
  authority: ApplyAuthority | null = null,
): PublicationResult {
  incrementMetric('kg_publication_fallback_total', label);
  return { outcome: 'fell_back', reason, unmet: [], holdReason: null, authority };
}

type FallbackLabel =
  | 'no_pending_edit'
  | 'not_cutover_eligible'
  | 'mode_not_authoritative'
  | 'no_mirrored_proposal'
  | 'no_mirrored_version';

/** True when this version already has a committed `applied` publication event. */
export async function alreadyPublished(
  db: GovernanceDb,
  proposalVersionId: number,
): Promise<boolean> {
  const events = await listPublicationEvents(db, proposalVersionId);
  return events.some((e) => e.action === 'applied');
}

/**
 * Decide and, if the policy allows, publish one pending edit generically.
 *
 * Returns `fell_back` for every condition that means "this build is not the
 * authority here", so the caller can run the legacy gate unchanged. The
 * conditions are deliberately many and cheap, and all of them are checked
 * before anything is written.
 */
export async function publishOnAgentConsensus(args: {
  pendingEditId: number;
  approverUserId: number;
}): Promise<PublicationResult> {
  const db = getDb();

  const facts = await collectConsensusFacts(args.pendingEditId);
  if (!facts) return fellBack('no_pending_edit', 'pending edit not found');

  const authority = await resolveApplyAuthority(facts.editType);
  if (!authority.authoritative) {
    return fellBack(
      authority.withheld === 'not_eligible'
        ? 'not_cutover_eligible'
        : 'mode_not_authoritative',
      authority.withheld === 'not_eligible'
        ? `edit type '${facts.editType}' is not cutover-eligible in this build`
        : `'${authority.key}' is not generic_authoritative`,
      authority,
    );
  }

  // The generic decision needs a mirrored version to be *about* (§7.4). A
  // target advanced to generic_authoritative without a mirror is a
  // misconfiguration, not a licence to decide from nothing — fall back and let
  // the reconciliation scanner's `missing_proposal` finding surface it.
  const link = await findByLegacy(db, 'pending_edit', args.pendingEditId);
  if (!link) {
    return fellBack(
      'no_mirrored_proposal',
      'no mirrored proposal for this pending edit',
      authority,
    );
  }
  const version = await latestVersion(db, link.genericId);
  if (!version) {
    return fellBack('no_mirrored_version', 'mirrored proposal has no version', authority);
  }

  if (await alreadyPublished(db, version.id)) {
    return {
      outcome: 'already_applied',
      reason: 'a publication event already records this version as applied',
      unmet: [],
      holdReason: null,
      authority,
    };
  }

  const evaluation = evaluateShadowPolicy(facts);
  const space = await ensureKinetixSpace(db);
  const actor: ActorContext = {
    actorRef: userActorRef(args.approverUserId),
    kind: 'agent',
    capabilities: [],
    assuranceCapabilities: [],
    metadata: { via: 'agent_consensus' },
  };

  if (evaluation.outcome === 'hold') {
    // A hold is an authoritative decision and is recorded as one. Recording it
    // outside a transaction is fine: nothing is mutated, and a lost decision
    // record on a hold costs an audit line rather than a wrong publication.
    //
    // A failure to record must NOT become a fallback. Once the generic policy
    // has decided to hold, letting the legacy gate re-decide could publish what
    // this engine just refused — §1.7 permits tightening Kinetix and never
    // relaxing it, and an unwritten audit line is not a reason to relax.
    try {
      await recordCoreDecision(db, {
        spaceId: space.id,
        proposalVersionId: version.id,
        decision: evaluation.decision,
        evaluationMode: 'authoritative',
        outcome: 'hold',
      });
    } catch (err) {
      console.error(
        `[knowledge-governance] could not record the authoritative hold for ` +
          `pending edit ${args.pendingEditId}; the hold still stands: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      outcome: 'held',
      reason: 'the generic policy holds this version',
      unmet: evaluation.reasons,
      holdReason: genericConsensusHoldReason(evaluation.decision),
      authority,
    };
  }

  // ── past this line a mutation may happen; there is no falling back ──
  try {
    return await inTransaction(async () => {
      const tx = getDb();

      // Re-check inside the transaction. Two concurrent verdicts can both pass
      // the check above; only one may pass it holding the row lock that
      // `applyApprovedEdit` takes immediately after.
      if (await alreadyPublished(tx, version.id)) {
        return {
          outcome: 'already_applied' as const,
          reason: 'another writer published this version first',
          unmet: [],
          holdReason: null,
          authority,
        };
      }

      const decision = await recordCoreDecision(tx, {
        spaceId: space.id,
        proposalVersionId: version.id,
        decision: evaluation.decision,
        evaluationMode: 'authoritative',
        outcome: 'apply',
      });

      const adapter = getKnowledgeTargetAdapter(KINETIX_SPACE, 'pending_edit');
      const full = await getVersion(tx, version.id);
      if (!full) throw new Error('mirrored version vanished mid-transaction');

      const applied = await adapter.apply!({
        version: {
          ref: { proposalId: String(link.genericId), versionId: String(version.id) },
          target: { space: KINETIX_SPACE, type: 'pending_edit', id: String(args.pendingEditId) },
          payload: full.payload,
          targetVersion: full.legacyReviewToken ?? '',
          createdAt: full.createdAt.toISOString(),
          authorRef: full.authorActorRef,
        },
        decision: {
          allowed: true,
          policyId: evaluation.decision.policyId,
          policyVersion: evaluation.decision.policyVersion,
          holdReason: null,
        },
        actor,
        tx,
      });

      await recordPublicationEvent(tx, {
        proposalVersionId: version.id,
        action: 'applied',
        actorRef: actor.actorRef,
        policyDecisionId: decision.id,
        appliedRevisionRef: `pending_edit:${applied.revisionId}`,
      });
      await setProposalState(tx, link.genericId, 'applied');

      return {
        outcome: 'applied' as const,
        reason: 'published by the generic policy',
        unmet: [],
        holdReason: null,
        authority,
      };
    });
  } catch (err) {
    // Not a fallback. The transaction rolled back, but this layer cannot prove
    // from here that no effect escaped it, and replaying the same mutation
    // through legacy is exactly the double-apply the plan forbids. Report it,
    // leave the edit pending, and let the next verdict or a moderator retry.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[knowledge-governance] authoritative publish failed for pending edit ` +
        `${args.pendingEditId}; leaving it pending: ${message}`,
    );
    await recordAuditEvent(db, {
      spaceId: space.id,
      eventType: 'authoritative_publish_failed',
      subjectType: 'proposal_version',
      subjectId: version.id,
      actorRef: actor.actorRef,
      payload: { pendingEditId: args.pendingEditId, error: message },
    }).catch(() => {
      // The audit write is best-effort here on purpose: it runs after a
      // failure, and a second failure must not replace the first in the log.
    });
    return {
      outcome: 'failed',
      reason: message,
      unmet: [],
      holdReason: null,
      authority,
    };
  }
}
