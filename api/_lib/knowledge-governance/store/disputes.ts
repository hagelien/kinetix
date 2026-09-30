/**
 * `kg_disputes` and `kg_dispute_rulings` (§5.8, §5.9).
 *
 * A dispute is a stable identity with a `state` projection; the ruling history
 * below it is append-only and authoritative. A dispute reopened and re-ruled
 * gains a ruling row — it never edits the previous one, because "this was
 * upheld in March and overruled in May" is a fact about the record, not a
 * correction to it.
 *
 * The one Kinetix behaviour worth carrying forward deliberately (Phase 0 doc
 * §5.5): an upheld dispute is cleared by an actual revision, never by a
 * re-stamp. Nothing here lets a caller mark a dispute resolved without saying
 * who ruled and why.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  kgDisputeRulings,
  kgDisputes,
  type KgDisputeRulingKind,
} from '../../../../db/governance-schema.js';
import type {
  DisputeRecord,
  DisputeRulingRecord,
  GovernanceDb,
  SubjectType,
} from './interface.js';

const DISPUTE_COLUMNS = {
  id: kgDisputes.id,
  spaceId: kgDisputes.spaceId,
  subjectType: kgDisputes.subjectType,
  subjectId: kgDisputes.subjectId,
  openedByActorRef: kgDisputes.openedByActorRef,
  state: kgDisputes.state,
  createdAt: kgDisputes.createdAt,
  closedAt: kgDisputes.closedAt,
} as const;

const RULING_COLUMNS = {
  id: kgDisputeRulings.id,
  disputeId: kgDisputeRulings.disputeId,
  ruling: kgDisputeRulings.ruling,
  actorRef: kgDisputeRulings.actorRef,
  rationaleMd: kgDisputeRulings.rationaleMd,
  createdAt: kgDisputeRulings.createdAt,
} as const;

export async function openDispute(
  db: GovernanceDb,
  args: {
    spaceId: number;
    subjectType: SubjectType;
    subjectId: number;
    openedByActorRef: string;
    openedByKind: string;
    reasonMd?: string | null;
    /** When the objection was raised, for a caller replaying history. */
    at?: Date;
  },
): Promise<DisputeRecord> {
  const [row] = await db
    .insert(kgDisputes)
    .values({
      ...(args.at ? { createdAt: args.at } : {}),
      spaceId: args.spaceId,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      openedByActorRef: args.openedByActorRef,
      openedByKind: args.openedByKind,
      reasonMd: args.reasonMd ?? null,
      state: 'open',
    })
    .returning(DISPUTE_COLUMNS);
  return row as DisputeRecord;
}

/**
 * Append a ruling and move the projection.
 *
 * The ruling row is written first and is what survives; the `state`/`closedAt`
 * update is bookkeeping for the open-disputes index. `withdrawn` closes the
 * dispute as much as `upheld` does — a withdrawn dispute is finished, and
 * leaving it open would keep blocking publication on a complaint nobody is
 * making any more.
 *
 * `superseded` deliberately does not close it: that ruling means another
 * dispute took this one's place, and the replacement is what governs.
 */
/**
 * The rulings that end a dispute, named rather than inferred.
 *
 * `kg_dispute_rulings.ruling` is `varchar(20)` with no enum or check
 * constraint behind it, so `KgDisputeRulingKind` is a claim about the column
 * rather than a guarantee from it. `ruling !== 'superseded'` therefore treated
 * every unreadable value as closing — the unsafe direction, because closing a
 * dispute removes a publication block. An unrecognised ruling now leaves the
 * dispute open: the objection keeps blocking until someone can say what
 * settled it.
 */
const CLOSING_RULINGS: ReadonlySet<string> = new Set([
  'upheld',
  'overruled',
  'withdrawn',
]);

/** True for a ruling that ends its dispute. Unknown values do not. */
export function rulingClosesDispute(ruling: string): boolean {
  return CLOSING_RULINGS.has(ruling);
}

export async function recordRuling(
  db: GovernanceDb,
  args: {
    disputeId: number;
    ruling: KgDisputeRulingKind;
    actorRef: string;
    rationaleMd?: string | null;
    at?: Date;
  },
): Promise<DisputeRulingRecord> {
  const [row] = await db
    .insert(kgDisputeRulings)
    .values({
      // The ruling row is the thing that survives, so it carries the caller's
      // time; the projection below is then derived from the ordered history
      // rather than from this insert.
      ...(args.at ? { createdAt: args.at } : {}),
      disputeId: args.disputeId,
      ruling: args.ruling,
      actorRef: args.actorRef,
      rationaleMd: args.rationaleMd ?? null,
    })
    .returning(RULING_COLUMNS);

  // Recomputed from the ordered history, not from the row just inserted.
  //
  // Those were the same thing while every ruling was stamped `now()`. They
  // stopped being the same once a caller could supply a historical `at`:
  // replaying an older `upheld` after a newer `superseded` would set
  // `closedAt` from the older event, while `latestRuling` — which orders by
  // timestamp — still considers the supersession current. The dispute would
  // then read as closed and stop blocking publication, on the strength of a
  // ruling that history says was overtaken.
  //
  // Reading the ordered history back costs one query per ruling, which is
  // rare, and makes the projection a function of the rulings rather than of
  // the order they happened to be written in.
  const latest = await latestRuling(db, args.disputeId);
  const closes = latest !== null && rulingClosesDispute(latest.ruling);
  await db
    .update(kgDisputes)
    .set({
      state: closes ? 'resolved' : 'open',
      closedAt: closes ? latest.createdAt : null,
    })
    .where(eq(kgDisputes.id, args.disputeId));

  return row as DisputeRulingRecord;
}

/** The ruling history of one dispute, oldest first. */
export async function listRulings(
  db: GovernanceDb,
  disputeId: number,
): Promise<DisputeRulingRecord[]> {
  const rows = await db
    .select(RULING_COLUMNS)
    .from(kgDisputeRulings)
    .where(eq(kgDisputeRulings.disputeId, disputeId))
    .orderBy(asc(kgDisputeRulings.createdAt), asc(kgDisputeRulings.id));
  return rows as DisputeRulingRecord[];
}

/** The latest ruling, or `null` while a dispute has never been ruled on. */
export async function latestRuling(
  db: GovernanceDb,
  disputeId: number,
): Promise<DisputeRulingRecord | null> {
  const rulings = await listRulings(db, disputeId);
  return rulings[rulings.length - 1] ?? null;
}

/**
 * Open disputes on a subject — the question that blocks publication.
 *
 * Reads `closedAt IS NULL` rather than `state = 'open'`, matching the partial
 * index the migration creates. The two agree, and keeping the query on the
 * indexed predicate means a projection that drifted cannot quietly turn this
 * into a sequential scan of every dispute ever filed.
 */
export async function openDisputes(
  db: GovernanceDb,
  args: { subjectType: SubjectType; subjectId: number },
): Promise<DisputeRecord[]> {
  const rows = await db
    .select(DISPUTE_COLUMNS)
    .from(kgDisputes)
    .where(
      and(
        eq(kgDisputes.subjectType, args.subjectType),
        eq(kgDisputes.subjectId, args.subjectId),
        isNull(kgDisputes.closedAt),
      ),
    )
    .orderBy(asc(kgDisputes.createdAt));
  return rows as DisputeRecord[];
}

export async function getDispute(
  db: GovernanceDb,
  id: number,
): Promise<DisputeRecord | null> {
  const [row] = await db
    .select(DISPUTE_COLUMNS)
    .from(kgDisputes)
    .where(eq(kgDisputes.id, id))
    .limit(1);
  return (row as DisputeRecord | undefined) ?? null;
}
