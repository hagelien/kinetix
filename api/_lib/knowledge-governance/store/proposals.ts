/**
 * `kg_proposals` (§5.3) — the stable identity of a proposed mutation across its
 * revisions.
 *
 * The row is a **projection**. `state` and `currentVersionId` exist so a queue
 * can be read without replaying history, and they are the only fields in this
 * whole store that get updated. The authoritative record is the version,
 * decision and publication history; if this row disagrees with those, those
 * win, and `recomputeProjection` is how it is put back.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  kgProposals,
  kgProposalVersions,
  type KgProposalState,
} from '../../../../db/governance-schema.js';
import type { GovernanceDb, ProposalRecord } from './interface.js';

/** States that mean the proposal is finished and should carry a `closedAt`. */
const TERMINAL_STATES: readonly KgProposalState[] = [
  'applied',
  'rejected',
  'withdrawn',
  'superseded',
];

export function isTerminalProposalState(state: KgProposalState): boolean {
  return TERMINAL_STATES.includes(state);
}

const PROPOSAL_COLUMNS = {
  id: kgProposals.id,
  spaceId: kgProposals.spaceId,
  targetId: kgProposals.targetId,
  authorActorRef: kgProposals.authorActorRef,
  authorKind: kgProposals.authorKind,
  state: kgProposals.state,
  currentVersionId: kgProposals.currentVersionId,
  legacyPendingEditId: kgProposals.legacyPendingEditId,
  createdAt: kgProposals.createdAt,
  closedAt: kgProposals.closedAt,
} as const;

export async function createProposal(
  db: GovernanceDb,
  args: {
    spaceId: number;
    targetId: number;
    authorActorRef: string;
    authorKind: string;
    state?: KgProposalState;
    legacyPendingEditId?: number | null;
    /**
     * When the proposal was raised, for a caller mirroring or importing a row
     * that already exists. Omitted, the column default records now — which is
     * right for a proposal being created and wrong for one being reconstructed,
     * because `kg_proposals_open_idx` orders the queue on this column and an
     * import would renumber every historical row to the day it was imported.
     */
    createdAt?: Date;
  },
): Promise<ProposalRecord> {
  const [row] = await db
    .insert(kgProposals)
    .values({
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      spaceId: args.spaceId,
      targetId: args.targetId,
      authorActorRef: args.authorActorRef,
      authorKind: args.authorKind,
      state: args.state ?? 'draft',
      legacyPendingEditId: args.legacyPendingEditId ?? null,
    })
    .returning(PROPOSAL_COLUMNS);
  return row as ProposalRecord;
}

export async function getProposal(
  db: GovernanceDb,
  id: number,
): Promise<ProposalRecord | null> {
  const [row] = await db
    .select(PROPOSAL_COLUMNS)
    .from(kgProposals)
    .where(eq(kgProposals.id, id))
    .limit(1);
  return (row as ProposalRecord | undefined) ?? null;
}

/**
 * Move the projection to a new state.
 *
 * `closedAt` is derived from the state rather than passed in, so a caller
 * cannot leave a rejected proposal sitting in the open-proposals index — which
 * is a partial index on `closed_at IS NULL`, so the mistake would be invisible
 * until a queue served something already decided. Re-opening a terminal
 * proposal clears it again for the same reason.
 */
export async function setProposalState(
  db: GovernanceDb,
  id: number,
  state: KgProposalState,
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(kgProposals)
    .set({
      state,
      closedAt: isTerminalProposalState(state) ? at : null,
    })
    .where(eq(kgProposals.id, id));
}

/** Point the projection at the version reviewers should now be judging. */
export async function setCurrentVersion(
  db: GovernanceDb,
  proposalId: number,
  versionId: number,
): Promise<void> {
  await db
    .update(kgProposals)
    .set({ currentVersionId: versionId })
    .where(eq(kgProposals.id, proposalId));
}

/**
 * Rebuild `currentVersionId` from the version history.
 *
 * The repair path for the one direction a projection can drift: a shadow write
 * that appended a version and then failed before updating the pointer. Reads
 * the highest `version_no`, which is the ordering the unique index guarantees,
 * rather than the highest id or newest timestamp — two versions written in the
 * same millisecond would make a timestamp ambiguous.
 */
export async function recomputeProjection(
  db: GovernanceDb,
  proposalId: number,
): Promise<number | null> {
  const [latest] = await db
    .select({ id: kgProposalVersions.id })
    .from(kgProposalVersions)
    .where(eq(kgProposalVersions.proposalId, proposalId))
    .orderBy(desc(kgProposalVersions.versionNo))
    .limit(1);
  const versionId = latest?.id ?? null;
  await db
    .update(kgProposals)
    .set({ currentVersionId: versionId })
    .where(eq(kgProposals.id, proposalId));
  return versionId;
}

/** Open proposals in a space, oldest first — the shape the queue index serves. */
export async function listOpenProposals(
  db: GovernanceDb,
  spaceId: number,
  limit = 50,
): Promise<ProposalRecord[]> {
  const rows = await db
    .select(PROPOSAL_COLUMNS)
    .from(kgProposals)
    .where(and(eq(kgProposals.spaceId, spaceId), isNull(kgProposals.closedAt)))
    .orderBy(kgProposals.createdAt)
    .limit(limit);
  return rows as ProposalRecord[];
}

/** The proposal mirroring a `pending_edits` row, if one was ever mirrored. */
export async function findProposalByLegacyPendingEdit(
  db: GovernanceDb,
  legacyPendingEditId: number,
): Promise<ProposalRecord | null> {
  const [row] = await db
    .select(PROPOSAL_COLUMNS)
    .from(kgProposals)
    .where(eq(kgProposals.legacyPendingEditId, legacyPendingEditId))
    .limit(1);
  return (row as ProposalRecord | undefined) ?? null;
}
