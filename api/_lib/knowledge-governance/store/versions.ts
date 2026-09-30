/**
 * `kg_proposal_versions` (§5.4) — the immutable snapshot reviewers judge.
 *
 * There is deliberately no update and no delete in this module. A payload edit
 * appends a new version; a version that was ever visible to a reviewer is never
 * rewritten. That is what makes §8.3 structural rather than procedural: an
 * assessment names the version it judged, so a revised payload cannot inherit
 * the previous version's approvals, and no "clear the old verdicts" step has to
 * remember to run.
 */

import { asc, desc, eq } from 'drizzle-orm';
import { kgProposalVersions } from '../../../../db/governance-schema.js';
import { setCurrentVersion } from './proposals.js';
import type { GovernanceDb, ProposalVersionRecord } from './interface.js';

const VERSION_COLUMNS = {
  id: kgProposalVersions.id,
  proposalId: kgProposalVersions.proposalId,
  versionNo: kgProposalVersions.versionNo,
  payload: kgProposalVersions.payload,
  payloadFingerprint: kgProposalVersions.payloadFingerprint,
  authorActorRef: kgProposalVersions.authorActorRef,
  actorKind: kgProposalVersions.actorKind,
  riskProfile: kgProposalVersions.riskProfile,
  baseRevisionRef: kgProposalVersions.baseRevisionRef,
  legacyReviewToken: kgProposalVersions.legacyReviewToken,
  createdAt: kgProposalVersions.createdAt,
  submittedAt: kgProposalVersions.submittedAt,
} as const;

/**
 * Append the next version of a proposal.
 *
 * `versionNo` is derived here rather than supplied, so two callers cannot
 * disagree about what "next" means. The unique index on
 * `(proposal_id, version_no)` is the real guard: under concurrency the loser of
 * the race gets a constraint violation and retries, which is the correct
 * outcome — silently reusing a number would give two different payloads the
 * same identity, and assessments name versions.
 *
 * Also moves the proposal's `currentVersionId` projection, because a version
 * nobody is pointed at is a version no reviewer will be handed.
 */
export async function appendVersion(
  db: GovernanceDb,
  args: {
    proposalId: number;
    payload: unknown;
    payloadFingerprint: string;
    authorActorRef: string;
    actorKind: string;
    riskProfile?: unknown;
    baseRevisionRef?: string | null;
    legacyReviewToken?: string | null;
    submittedAt?: Date | null;
  },
): Promise<ProposalVersionRecord> {
  const [previous] = await db
    .select({ versionNo: kgProposalVersions.versionNo })
    .from(kgProposalVersions)
    .where(eq(kgProposalVersions.proposalId, args.proposalId))
    .orderBy(desc(kgProposalVersions.versionNo))
    .limit(1);
  const versionNo = (previous?.versionNo ?? 0) + 1;

  const [row] = await db
    .insert(kgProposalVersions)
    .values({
      proposalId: args.proposalId,
      versionNo,
      payload: args.payload,
      payloadFingerprint: args.payloadFingerprint,
      authorActorRef: args.authorActorRef,
      actorKind: args.actorKind,
      riskProfile: args.riskProfile ?? null,
      baseRevisionRef: args.baseRevisionRef ?? null,
      legacyReviewToken: args.legacyReviewToken ?? null,
      submittedAt: args.submittedAt ?? null,
    })
    .returning(VERSION_COLUMNS);

  const created = row as ProposalVersionRecord;
  await setCurrentVersion(db, args.proposalId, created.id);
  return created;
}

export async function getVersion(
  db: GovernanceDb,
  id: number,
): Promise<ProposalVersionRecord | null> {
  const [row] = await db
    .select(VERSION_COLUMNS)
    .from(kgProposalVersions)
    .where(eq(kgProposalVersions.id, id))
    .limit(1);
  return (row as ProposalVersionRecord | undefined) ?? null;
}

/** Every version of a proposal, oldest first — the review history as written. */
export async function listVersions(
  db: GovernanceDb,
  proposalId: number,
): Promise<ProposalVersionRecord[]> {
  const rows = await db
    .select(VERSION_COLUMNS)
    .from(kgProposalVersions)
    .where(eq(kgProposalVersions.proposalId, proposalId))
    .orderBy(asc(kgProposalVersions.versionNo));
  return rows as ProposalVersionRecord[];
}

export async function latestVersion(
  db: GovernanceDb,
  proposalId: number,
): Promise<ProposalVersionRecord | null> {
  const [row] = await db
    .select(VERSION_COLUMNS)
    .from(kgProposalVersions)
    .where(eq(kgProposalVersions.proposalId, proposalId))
    .orderBy(desc(kgProposalVersions.versionNo))
    .limit(1);
  return (row as ProposalVersionRecord | undefined) ?? null;
}

/**
 * Mark a version as submitted for review.
 *
 * The one permitted write to an existing version row, and it does not touch the
 * payload: `submitted_at` records when a draft entered review, which is not
 * part of what a reviewer judges. It is set once — a re-submission is a new
 * version, not a re-stamp of the old one.
 */
export async function markSubmitted(
  db: GovernanceDb,
  versionId: number,
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(kgProposalVersions)
    .set({ submittedAt: at })
    .where(eq(kgProposalVersions.id, versionId));
}
