/**
 * `kg_legacy_links` (§5.13) — the explicit mapping between a generic record and
 * the Kinetix record it mirrors.
 *
 * The point of the table is that parity debugging becomes a join instead of a
 * payload heuristic. "Which pending edit is this proposal?" has one answer, and
 * it is stored rather than inferred from matching fingerprints — inference is
 * exactly what goes wrong when two proposals legitimately carry identical
 * payloads.
 *
 * Unique in both directions, enforced by the two indexes the migration creates.
 * Linking is therefore idempotent but *not* silently re-pointable: relinking a
 * generic record to a different legacy row fails rather than quietly rewriting
 * history, because the shadow writer that tries it has a bug and losing the
 * original mapping is how that bug gets hidden.
 */

import { and, eq } from 'drizzle-orm';
import { kgLegacyLinks } from '../../../../db/governance-schema.js';
import type { GovernanceDb, LegacyLinkRecord } from './interface.js';

const LINK_COLUMNS = {
  id: kgLegacyLinks.id,
  genericType: kgLegacyLinks.genericType,
  genericId: kgLegacyLinks.genericId,
  legacyType: kgLegacyLinks.legacyType,
  legacyId: kgLegacyLinks.legacyId,
} as const;

export class ConflictingLegacyLinkError extends Error {
  constructor(
    readonly existing: LegacyLinkRecord,
    readonly attempted: Omit<LegacyLinkRecord, 'id'>,
  ) {
    super(
      `knowledge-governance: ${existing.genericType}#${existing.genericId} is already linked to ` +
        `${existing.legacyType}#${existing.legacyId}; refusing to relink it to ` +
        `${attempted.legacyType}#${attempted.legacyId}`,
    );
    this.name = 'ConflictingLegacyLinkError';
  }
}

/**
 * Link a generic record to its legacy counterpart.
 *
 * Idempotent for an identical link, so a backfill can be re-run. A *different*
 * link for either side throws.
 */
export async function linkLegacyRecord(
  db: GovernanceDb,
  args: {
    genericType: string;
    genericId: number;
    legacyType: string;
    legacyId: number;
  },
): Promise<LegacyLinkRecord> {
  const existing = await findByGeneric(db, args.genericType, args.genericId);
  if (existing) {
    if (
      existing.legacyType !== args.legacyType ||
      existing.legacyId !== args.legacyId
    ) {
      throw new ConflictingLegacyLinkError(existing, args);
    }
    return existing;
  }

  const reverse = await findByLegacy(db, args.legacyType, args.legacyId);
  if (reverse) {
    if (
      reverse.genericType !== args.genericType ||
      reverse.genericId !== args.genericId
    ) {
      throw new ConflictingLegacyLinkError(reverse, args);
    }
    return reverse;
  }

  const [row] = await db.insert(kgLegacyLinks).values(args).returning(LINK_COLUMNS);
  return row as LegacyLinkRecord;
}

export async function findByGeneric(
  db: GovernanceDb,
  genericType: string,
  genericId: number,
): Promise<LegacyLinkRecord | null> {
  const [row] = await db
    .select(LINK_COLUMNS)
    .from(kgLegacyLinks)
    .where(
      and(
        eq(kgLegacyLinks.genericType, genericType),
        eq(kgLegacyLinks.genericId, genericId),
      ),
    )
    .limit(1);
  return (row as LegacyLinkRecord | undefined) ?? null;
}

export async function findByLegacy(
  db: GovernanceDb,
  legacyType: string,
  legacyId: number,
): Promise<LegacyLinkRecord | null> {
  const [row] = await db
    .select(LINK_COLUMNS)
    .from(kgLegacyLinks)
    .where(
      and(
        eq(kgLegacyLinks.legacyType, legacyType),
        eq(kgLegacyLinks.legacyId, legacyId),
      ),
    )
    .limit(1);
  return (row as LegacyLinkRecord | undefined) ?? null;
}
