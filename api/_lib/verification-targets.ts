/**
 * The shared notion of "target version" behind the agent-verification queue
 * AND the disputes table — both answer "has this row moved since the caller
 * last looked at it?" against the same source tables, so the answer has to
 * come from one place or the two would drift.
 *
 * Split out of api/_lib/agent-verifications.ts so api/_lib/disputes.ts can
 * reuse it without a circular import (agent-verifications.ts already imports
 * withdrawAgentDisputesForTarget from disputes.ts).
 */

import { eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getDb } from './db.js';
import {
  drugParameterDiscussions,
  drugParameterRevisions,
  learningUnitRevisions,
  paperReviews,
  pendingEdits,
  wikiRevisions,
  type AgentVerificationTargetType,
} from '../../db/schema.js';

/**
 * The legacy source table behind each verification target type.
 *
 * One row per target id — the row a legacy writer revises in place, and the
 * row every reader's notion of "the current version" is derived from. Kept
 * here, beside `verificationTargetVersion`, because the two answer the same
 * question about the same row and must not drift.
 */
export const VERIFICATION_SOURCE_TABLES: Readonly<
  Record<AgentVerificationTargetType, PgTable & { id: PgColumn }>
> = {
  pending_edit: pendingEdits,
  paper_review: paperReviews,
  wiki_revision: wikiRevisions,
  drug_parameter_revision: drugParameterRevisions,
  drug_discussion: drugParameterDiscussions,
  learning_unit_revision: learningUnitRevisions,
};

/** The narrow surface {@link lockVerificationSourceRow} needs from a handle. */
export type GovernanceLikeDb = Pick<ReturnType<typeof getDb>, 'select'>;

/**
 * Hold one target's source row for the life of the current transaction.
 *
 * `FOR UPDATE`, so a legacy writer revising the row waits for this transaction
 * rather than landing inside it. Exported because the governance importer and
 * mirror need the same exclusion over the same rows, and two definitions of
 * "the row behind this target" would drift.
 */
export async function lockVerificationSourceRow(
  db: GovernanceLikeDb,
  targetType: string,
  targetId: number,
): Promise<void> {
  const table = (
    VERIFICATION_SOURCE_TABLES as Record<string, (PgTable & { id: PgColumn }) | undefined>
  )[targetType];
  if (!table) return;
  await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, targetId))
    .limit(1)
    .for('update');
}

/**
 * The target moved between the caller's version check and the verdict write.
 *
 * Thrown rather than returned so a caller that forgets to look cannot record
 * the verdict anyway; the route maps it to the same 409 its own pre-check
 * raises.
 */
export class StaleVerificationTargetError extends Error {
  constructor(readonly expected: string, readonly actual: string | null) {
    super(`target moved since it was queued: '${expected}' -> '${actual ?? 'gone'}'`);
    this.name = 'StaleVerificationTargetError';
  }
}

export async function verificationTargetVersion(
  args: {
    targetType: AgentVerificationTargetType;
    targetId: number;
  },
  /**
   * Optional handle, so the check can run inside the transaction that holds the
   * source row. Without it the re-read would see the last committed value from
   * its own connection and the lock would buy nothing.
   */
  handle?: GovernanceLikeDb,
): Promise<string | null> {
  const db = handle ?? getDb();
  switch (args.targetType) {
    case 'wiki_revision': {
      const [row] = await db
        .select({ createdAt: wikiRevisions.createdAt })
        .from(wikiRevisions)
        .where(eq(wikiRevisions.id, args.targetId))
        .limit(1);
      return row?.createdAt.toISOString() ?? null;
    }
    case 'drug_parameter_revision': {
      const [row] = await db
        .select({ createdAt: drugParameterRevisions.createdAt })
        .from(drugParameterRevisions)
        .where(eq(drugParameterRevisions.id, args.targetId))
        .limit(1);
      return row?.createdAt.toISOString() ?? null;
    }
    case 'drug_discussion': {
      const [row] = await db
        .select({ createdAt: drugParameterDiscussions.createdAt })
        .from(drugParameterDiscussions)
        .where(eq(drugParameterDiscussions.id, args.targetId))
        .limit(1);
      return row?.createdAt.toISOString() ?? null;
    }
    case 'paper_review': {
      const [row] = await db
        .select({ updatedAt: paperReviews.updatedAt })
        .from(paperReviews)
        .where(eq(paperReviews.id, args.targetId))
        .limit(1);
      return row?.updatedAt.toISOString() ?? null;
    }
    case 'learning_unit_revision': {
      const [row] = await db
        .select({ createdAt: learningUnitRevisions.createdAt })
        .from(learningUnitRevisions)
        .where(eq(learningUnitRevisions.id, args.targetId))
        .limit(1);
      return row?.createdAt.toISOString() ?? null;
    }
    case 'pending_edit': {
      // submittedAt alone is insensitive to status changes (approve / reject /
      // return / submitter-withdraw all leave it untouched), so a verdict
      // queued while the row was pending could be POSTed back after the row
      // had been moderated. Fold the status into the version string so any
      // status flip surfaces as a stale-version mismatch (409). The queue
      // endpoint only ever serves status='pending' rows, so the value it hands
      // out always ends with `|pending` and only mismatches once the row
      // leaves that state.
      const [row] = await db
        .select({
          submittedAt: pendingEdits.submittedAt,
          status: pendingEdits.status,
        })
        .from(pendingEdits)
        .where(eq(pendingEdits.id, args.targetId))
        .limit(1);
      return row ? `${row.submittedAt.toISOString()}|${row.status}` : null;
    }
  }
}
