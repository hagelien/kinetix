/**
 * Shared plumbing for the Kinetix target adapters.
 *
 * Nothing here decides policy. It exists so six adapters agree on how a target
 * is addressed, how a citation id becomes an evidence reference, and how a
 * payload is fingerprinted, rather than each inventing its own convention and
 * making the generic layer's records inconsistent between target types.
 */

import { fingerprint } from 'assurance-core';
import type { ProposalVersionRef, TargetRef } from 'assurance-core';
import { KINETIX_SPACE } from '../../actor-context.js';
import { effectiveProposalReferenceIds } from '../../../../../src/lib/parameterEntries.js';
import type { EvidenceRequirement } from '../../target-adapter.js';
import type { ReviewEvidenceRef } from 'assurance-core';

export { KINETIX_SPACE };

/** Address a Kinetix row of a given verification target type. */
export function kinetixTarget(type: string, id: number | string): TargetRef {
  return { space: KINETIX_SPACE, type, id: String(id) };
}

/**
 * Address the immutable version under review.
 *
 * Kinetix has no separate proposal identity yet: a `drug_parameter_revisions`
 * row *is* both the proposal and its only version, and a `pending_edits` row
 * carries its revisions in place. So proposal and version ids coincide during
 * Phase 2, and `versionId` folds in the legacy version token — for
 * `pending_edit` that token includes the row's status, which is exactly what
 * makes a moderated row a different version from the one a reviewer fetched.
 */
export function kinetixVersionRef(
  type: string,
  id: number | string,
  targetVersion: string,
): ProposalVersionRef {
  return {
    proposalId: `${type}:${id}`,
    versionId: `${type}:${id}@${targetVersion}`,
  };
}

/** `user:<id>`, or `null` for a row with no recorded author. */
export function authorRefOf(userId: number | null | undefined): string | null {
  return typeof userId === 'number' ? `user:${userId}` : null;
}

/**
 * The citation ids a legacy row cites.
 *
 * `reference_ids` is the newer plural column and `reference_id` the single-value
 * one it replaced, so a row written before the migration carries only the
 * latter — and an EMPTY plural array is such a row, not one citing nothing. The
 * shared rule is `effectiveProposalReferenceIds`, which the review card, the
 * resubmit gate and the approval's citation gate all read: a peer-review packet
 * that fell back only on `null` showed no citation for a legacy row, so an
 * agent could form a verdict without the evidence the moderator is looking at.
 */
export function referenceIdList(
  referenceIds: number[] | null | undefined,
  referenceId: number | null | undefined,
): number[] {
  return effectiveProposalReferenceIds({ referenceIds, referenceId });
}

export function citationEvidence(ids: readonly number[]): ReviewEvidenceRef[] {
  return ids.map((id) => ({ kind: 'citation', id: String(id) }));
}

/** Content hash of a proposal against its baseline. */
export function payloadFingerprint(proposal: unknown, current: unknown): string {
  return fingerprint({ proposal: proposal ?? null, current: current ?? null });
}

/**
 * The evidence rule Kinetix actually enforces today, expressed generically.
 *
 * `blocking: false` is not a softening — it is a statement of where the rule
 * lives. Kinetix rejects an unreferenced parameter edit at the submit endpoint,
 * before governance sees it, so by the time a proposal reaches a reviewer the
 * requirement is already satisfied or the row would not exist. Marking it
 * blocking here would imply this layer is the gate, and it is not yet (§1.3:
 * legacy stays authoritative until proven otherwise).
 */
export function citationEvidenceRequirement(
  args: { blocking?: boolean } = {},
): EvidenceRequirement {
  return {
    id: 'kinetix.citation',
    kind: 'citation',
    description:
      'At least one citation supporting the proposed change (enforced today by the submit endpoint).',
    blocking: args.blocking ?? false,
  };
}
