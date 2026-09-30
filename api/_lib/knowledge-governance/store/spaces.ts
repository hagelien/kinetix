/**
 * `kg_spaces` and `kg_targets` (§5.1, §5.2).
 *
 * Both are identity tables: the operations are "make sure this exists and give
 * me its id". Both are idempotent through the unique index rather than through
 * a read-then-write, which would race two concurrent shadow writers into
 * inserting the same space twice.
 */

import { and, eq } from 'drizzle-orm';
import { kgSpaces, kgTargets } from '../../../../db/governance-schema.js';
import type { GovernanceDb, SpaceRecord, TargetRecord } from './interface.js';

/**
 * Find or create a space.
 *
 * `onConflictDoNothing` then select, rather than select-then-insert: the unique
 * index on `slug` is what makes this safe under concurrency, and a lost insert
 * race resolves to the row the winner wrote.
 */
export async function ensureSpace(
  db: GovernanceDb,
  args: { slug: string; name: string; activePolicyVersion?: string | null },
): Promise<SpaceRecord> {
  await db
    .insert(kgSpaces)
    .values({
      slug: args.slug,
      name: args.name,
      activePolicyVersion: args.activePolicyVersion ?? null,
    })
    .onConflictDoNothing({ target: kgSpaces.slug });
  const space = await findSpace(db, args.slug);
  if (!space) {
    throw new Error(
      `knowledge-governance: space '${args.slug}' vanished between insert and read`,
    );
  }
  return space;
}

export async function findSpace(
  db: GovernanceDb,
  slug: string,
): Promise<SpaceRecord | null> {
  const [row] = await db
    .select({
      id: kgSpaces.id,
      slug: kgSpaces.slug,
      name: kgSpaces.name,
      activePolicyVersion: kgSpaces.activePolicyVersion,
    })
    .from(kgSpaces)
    .where(eq(kgSpaces.slug, slug))
    .limit(1);
  return row ?? null;
}

/**
 * Point a space at a policy version.
 *
 * Deliberately not retroactive: every decision record stores the version it was
 * made under (§7.4), so moving this pointer changes what happens next and
 * nothing that already happened.
 */
export async function setActivePolicyVersion(
  db: GovernanceDb,
  spaceId: number,
  activePolicyVersion: string | null,
): Promise<void> {
  await db
    .update(kgSpaces)
    .set({ activePolicyVersion, updatedAt: new Date() })
    .where(eq(kgSpaces.id, spaceId));
}

/** Find or create the generic handle for one host-domain object. */
export async function ensureTarget(
  db: GovernanceDb,
  args: {
    spaceId: number;
    targetType: string;
    targetKey: string;
    metadata?: unknown;
  },
): Promise<TargetRecord> {
  await db
    .insert(kgTargets)
    .values({
      spaceId: args.spaceId,
      targetType: args.targetType,
      targetKey: args.targetKey,
      metadata: args.metadata ?? null,
    })
    .onConflictDoNothing({
      target: [kgTargets.spaceId, kgTargets.targetType, kgTargets.targetKey],
    });
  const target = await findTarget(db, args);
  if (!target) {
    throw new Error(
      `knowledge-governance: target '${args.targetType}/${args.targetKey}' vanished between insert and read`,
    );
  }
  return target;
}

export async function findTarget(
  db: GovernanceDb,
  args: { spaceId: number; targetType: string; targetKey: string },
): Promise<TargetRecord | null> {
  const [row] = await db
    .select({
      id: kgTargets.id,
      spaceId: kgTargets.spaceId,
      targetType: kgTargets.targetType,
      targetKey: kgTargets.targetKey,
    })
    .from(kgTargets)
    .where(
      and(
        eq(kgTargets.spaceId, args.spaceId),
        eq(kgTargets.targetType, args.targetType),
        eq(kgTargets.targetKey, args.targetKey),
      ),
    )
    .limit(1);
  return row ?? null;
}
