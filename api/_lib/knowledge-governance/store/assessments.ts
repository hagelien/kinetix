/**
 * `kg_assessments` (§5.7) — immutable reviewer judgments.
 *
 * This module is the fix for the known limitation of `agent_verifications`.
 * That table upserts on `(agent_id, target_type, target_id)`, so a reviewer who
 * changes its mind overwrites — and destroys — the judgment it previously
 * published. An audit then cannot answer "what did this reviewer say before,
 * and when did it change?", which for a governance system is most of the
 * question.
 *
 * Here a change of mind is an insert whose `supersedesAssessmentId` names the
 * row it replaces. Both rows survive. The *current effective* judgment for an
 * actor is its newest row that nothing supersedes, which is what
 * `currentAssessments` computes.
 *
 * There is no update and no delete, and that absence is the enforcement.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { kgAssessments, type KgVerdict } from '../../../../db/governance-schema.js';
import type { AssessmentRecord, GovernanceDb, SubjectType } from './interface.js';

const ASSESSMENT_COLUMNS = {
  id: kgAssessments.id,
  spaceId: kgAssessments.spaceId,
  subjectType: kgAssessments.subjectType,
  subjectId: kgAssessments.subjectId,
  actorRef: kgAssessments.actorRef,
  actorKind: kgAssessments.actorKind,
  verdict: kgAssessments.verdict,
  rationaleMd: kgAssessments.rationaleMd,
  capabilitySnapshot: kgAssessments.capabilitySnapshot,
  independenceGroup: kgAssessments.independenceGroup,
  supersedesAssessmentId: kgAssessments.supersedesAssessmentId,
  createdAt: kgAssessments.createdAt,
} as const;

/**
 * Record one judgment.
 *
 * `capabilitySnapshot` is written here, from what the caller resolved at the
 * time, and never read live afterwards — the same reason
 * `agent_verifications.verifier_tier` exists (migration 0113). Reading a live
 * capability at tally time would let an agent later re-tiered to flagship
 * retroactively turn all of its past mid-tier approvals into flagship ones.
 *
 * `modelMetadata` is the actor's self-reported model identity. It is stored for
 * audit and is never a policy input (§2.3): a claim about yourself cannot be
 * what qualifies you.
 */
export async function recordAssessment(
  db: GovernanceDb,
  args: {
    spaceId: number;
    subjectType: SubjectType;
    subjectId: number;
    actorRef: string;
    actorKind: string;
    verdict: KgVerdict;
    rationaleMd?: string | null;
    capabilitySnapshot?: unknown;
    modelMetadata?: unknown;
    independenceGroup?: string | null;
    supersedesAssessmentId?: number | null;
    /**
     * When the judgment was formed, for a caller replaying or importing
     * history. Omitted, the column default records now — which is right for a
     * verdict being cast and wrong for one being restored, because it would
     * renumber the audit chronology.
     */
    at?: Date;
  },
): Promise<AssessmentRecord> {
  const [row] = await db
    .insert(kgAssessments)
    .values({
      ...(args.at ? { createdAt: args.at } : {}),
      spaceId: args.spaceId,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      actorRef: args.actorRef,
      actorKind: args.actorKind,
      verdict: args.verdict,
      rationaleMd: args.rationaleMd ?? null,
      capabilitySnapshot: args.capabilitySnapshot ?? null,
      modelMetadata: args.modelMetadata ?? null,
      independenceGroup: args.independenceGroup ?? null,
      supersedesAssessmentId: args.supersedesAssessmentId ?? null,
    })
    .returning(ASSESSMENT_COLUMNS);
  return row as AssessmentRecord;
}

/**
 * Record a reviewer's changed judgment, superseding its previous one.
 *
 * Finds the actor's current effective row for this subject and points the new
 * one at it. When the actor has said nothing yet this is just an insert, so a
 * caller does not have to know which case it is in — the distinction between a
 * first verdict and a revision belongs here, not at every call site.
 */
export async function reviseAssessment(
  db: GovernanceDb,
  args: {
    spaceId: number;
    subjectType: SubjectType;
    subjectId: number;
    actorRef: string;
    actorKind: string;
    verdict: KgVerdict;
    rationaleMd?: string | null;
    capabilitySnapshot?: unknown;
    modelMetadata?: unknown;
    independenceGroup?: string | null;
  },
): Promise<AssessmentRecord> {
  const current = await currentAssessments(db, {
    subjectType: args.subjectType,
    subjectId: args.subjectId,
  });
  const previous = current.find((a) => a.actorRef === args.actorRef) ?? null;
  return recordAssessment(db, {
    ...args,
    supersedesAssessmentId: previous?.id ?? null,
  });
}

/** One assessment by id, for a caller holding only a legacy link. */
export async function getAssessment(
  db: GovernanceDb,
  id: number,
): Promise<AssessmentRecord | null> {
  const [row] = await db
    .select(ASSESSMENT_COLUMNS)
    .from(kgAssessments)
    .where(eq(kgAssessments.id, id))
    .limit(1);
  return (row as AssessmentRecord | undefined) ?? null;
}

/** Every assessment ever recorded on a subject, oldest first. */
export async function listAssessments(
  db: GovernanceDb,
  args: { subjectType: SubjectType; subjectId: number },
): Promise<AssessmentRecord[]> {
  const rows = await db
    .select(ASSESSMENT_COLUMNS)
    .from(kgAssessments)
    .where(
      and(
        eq(kgAssessments.subjectType, args.subjectType),
        eq(kgAssessments.subjectId, args.subjectId),
      ),
    )
    .orderBy(asc(kgAssessments.createdAt), asc(kgAssessments.id));
  return rows as AssessmentRecord[];
}

/**
 * The current effective judgments on a subject: the rows nothing supersedes.
 *
 * Computed in-process from the subject's own rows rather than with a NOT EXISTS
 * subquery, because the set is small (one subject's reviewers) and because the
 * "superseded" relation is only ever within a subject. Doing it here also keeps
 * the definition of *effective* in one readable place instead of inside SQL
 * that three callers would each rewrite slightly differently.
 *
 * A reviewer that revised twice contributes exactly one row: its newest.
 */
export async function currentAssessments(
  db: GovernanceDb,
  args: { subjectType: SubjectType; subjectId: number },
): Promise<AssessmentRecord[]> {
  const all = await listAssessments(db, args);
  const superseded = new Set(
    all
      .map((a) => a.supersedesAssessmentId)
      .filter((id): id is number => id !== null),
  );
  return all.filter((a) => !superseded.has(a.id));
}

/** The chain of judgments an actor recorded on a subject, oldest first. */
export async function assessmentHistoryForActor(
  db: GovernanceDb,
  args: { subjectType: SubjectType; subjectId: number; actorRef: string },
): Promise<AssessmentRecord[]> {
  const all = await listAssessments(db, args);
  return all.filter((a) => a.actorRef === args.actorRef);
}

/** Bulk lookup for a page of subjects of one type. */
export async function currentAssessmentsForSubjects(
  db: GovernanceDb,
  args: { subjectType: SubjectType; subjectIds: readonly number[] },
): Promise<Map<number, AssessmentRecord[]>> {
  const out = new Map<number, AssessmentRecord[]>();
  if (args.subjectIds.length === 0) return out;
  const rows = (await db
    .select(ASSESSMENT_COLUMNS)
    .from(kgAssessments)
    .where(
      and(
        eq(kgAssessments.subjectType, args.subjectType),
        inArray(kgAssessments.subjectId, [...args.subjectIds]),
      ),
    )
    .orderBy(asc(kgAssessments.createdAt), asc(kgAssessments.id))) as AssessmentRecord[];

  const superseded = new Set(
    rows
      .map((a) => a.supersedesAssessmentId)
      .filter((id): id is number => id !== null),
  );
  for (const row of rows) {
    if (superseded.has(row.id)) continue;
    const bucket = out.get(row.subjectId) ?? [];
    bucket.push(row);
    out.set(row.subjectId, bucket);
  }
  return out;
}

