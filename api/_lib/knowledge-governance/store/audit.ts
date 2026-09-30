/**
 * `kg_audit_events` (§5.12) — append-only operational audit for what does not
 * fit the domain tables.
 *
 * The domain tables record governance *facts*: a version was written, a verdict
 * was cast, a decision was reached. This one records everything else worth
 * being able to reconstruct — a backfill ran, a migration mode changed, a
 * shadow write failed and was dropped. Those are the events that explain why
 * the domain tables look the way they do, and without them a parity
 * investigation ends at "the row is just missing".
 *
 * `actorRef` is nullable here and only here. A system-generated event has no
 * actor, and inventing one would put a fabricated name in an audit log.
 */

import { and, desc, eq } from 'drizzle-orm';
import { kgAuditEvents } from '../../../../db/governance-schema.js';
import type { AuditEventRecord, GovernanceDb } from './interface.js';

const AUDIT_COLUMNS = {
  id: kgAuditEvents.id,
  spaceId: kgAuditEvents.spaceId,
  eventType: kgAuditEvents.eventType,
  actorRef: kgAuditEvents.actorRef,
  subjectType: kgAuditEvents.subjectType,
  subjectId: kgAuditEvents.subjectId,
  payload: kgAuditEvents.payload,
  createdAt: kgAuditEvents.createdAt,
} as const;

export async function recordAuditEvent(
  db: GovernanceDb,
  args: {
    spaceId: number;
    eventType: string;
    subjectType: string;
    subjectId: number;
    actorRef?: string | null;
    payload?: unknown;
  },
): Promise<AuditEventRecord> {
  const [row] = await db
    .insert(kgAuditEvents)
    .values({
      spaceId: args.spaceId,
      eventType: args.eventType,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      actorRef: args.actorRef ?? null,
      payload: args.payload ?? null,
    })
    .returning(AUDIT_COLUMNS);
  return row as AuditEventRecord;
}

/** Events about one subject, newest first. */
export async function listAuditEvents(
  db: GovernanceDb,
  args: { subjectType: string; subjectId: number; limit?: number },
): Promise<AuditEventRecord[]> {
  const rows = await db
    .select(AUDIT_COLUMNS)
    .from(kgAuditEvents)
    .where(
      and(
        eq(kgAuditEvents.subjectType, args.subjectType),
        eq(kgAuditEvents.subjectId, args.subjectId),
      ),
    )
    .orderBy(desc(kgAuditEvents.createdAt), desc(kgAuditEvents.id))
    .limit(args.limit ?? 100);
  return rows as AuditEventRecord[];
}

/**
 * Events of one type on one subject, newest first.
 *
 * Separate from {@link listAuditEvents} because a caller looking for a specific
 * record must not have to page past unrelated ones. Reading the recent window
 * and filtering in memory makes the answer depend on how much else has happened
 * to the same subject since — so a version that accumulated enough retry or
 * failure events would report that it was never imported, which is a different
 * claim entirely.
 */
export async function listAuditEventsOfType(
  db: GovernanceDb,
  args: {
    subjectType: string;
    subjectId: number;
    eventType: string;
    limit?: number;
  },
): Promise<AuditEventRecord[]> {
  const rows = await db
    .select(AUDIT_COLUMNS)
    .from(kgAuditEvents)
    .where(
      and(
        eq(kgAuditEvents.subjectType, args.subjectType),
        eq(kgAuditEvents.subjectId, args.subjectId),
        eq(kgAuditEvents.eventType, args.eventType),
      ),
    )
    .orderBy(desc(kgAuditEvents.createdAt), desc(kgAuditEvents.id))
    .limit(args.limit ?? 100);
  return rows as AuditEventRecord[];
}

/** Events of one type in a space, newest first — the operational view. */
export async function listAuditEventsByType(
  db: GovernanceDb,
  args: { spaceId: number; eventType: string; limit?: number },
): Promise<AuditEventRecord[]> {
  const rows = await db
    .select(AUDIT_COLUMNS)
    .from(kgAuditEvents)
    .where(
      and(
        eq(kgAuditEvents.spaceId, args.spaceId),
        eq(kgAuditEvents.eventType, args.eventType),
      ),
    )
    .orderBy(desc(kgAuditEvents.createdAt), desc(kgAuditEvents.id))
    .limit(args.limit ?? 100);
  return rows as AuditEventRecord[];
}
