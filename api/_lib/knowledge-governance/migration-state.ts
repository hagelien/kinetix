/**
 * The migration control plane (§11 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Every question of the form "may the generic path do X for this target type?"
 * is answered here, and nowhere else. Two things decide it:
 *
 *  1. `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY` — the hard kill switch (§1.5/§11.3).
 *     When set, every target is `legacy_only` regardless of what the database
 *     says. It requires no schema change and no code change to use, which is
 *     the point: the fastest rollback available during an incident is an
 *     environment variable and a redeploy.
 *  2. `kg_migration_state`, per `(space, target_type)`.
 *
 * **A missing row means `legacy_only`.** So does an unreadable one: if the
 * lookup throws — the table is not migrated in this environment, the connection
 * is down — the answer is the conservative mode, not an error and not a
 * permissive default. §1.6 requires failing toward doing nothing, and a
 * governance layer that participated *because* it could not read its own
 * configuration would be the exact inversion of that.
 */

import { and, eq } from 'drizzle-orm';
import {
  afterTransactionCommit,
  getDb,
  inTransaction,
  isInPoolTransaction,
} from '../db.js';
import {
  kgMigrationState,
  type KgMigrationMode,
} from '../../../db/schema.js';
import { KINETIX_SPACE } from './actor-context.js';
import { recordAuditEvent } from './store/audit.js';
import { ensureSpace, findSpace } from './store/spaces.js';
import type { GovernanceDb } from './store/interface.js';

export const MIGRATION_MODES: readonly KgMigrationMode[] = [
  'legacy_only',
  'shadow',
  'compare',
  'generic_read',
  'legacy_write_generic_mirror',
  'generic_authoritative',
];

/** Ordered by how much authority the generic path holds (§11.2). */
const MODE_RANK: Record<KgMigrationMode, number> = {
  legacy_only: 0,
  shadow: 1,
  compare: 2,
  generic_read: 3,
  legacy_write_generic_mirror: 4,
  generic_authoritative: 5,
};

export function isMigrationMode(value: unknown): value is KgMigrationMode {
  return typeof value === 'string' && value in MODE_RANK;
}

export const FORCE_LEGACY_ENV = 'KNOWLEDGE_GOVERNANCE_FORCE_LEGACY';

/**
 * Whether the kill switch is engaged.
 *
 * Read from the environment on every call rather than cached at import: a
 * cached value would survive a change until the process restarted, and the
 * whole value of this switch is that it takes effect the moment it is set.
 *
 * Anything other than an explicit off value counts as ON. During an incident,
 * `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=yes` must not be silently ignored because
 * it was not spelled `1`, and a typo that fails toward legacy costs nothing.
 */
export function forceLegacyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FORCE_LEGACY_ENV];
  if (raw === undefined) return false;
  const normalised = raw.trim().toLowerCase();
  return !(normalised === '' || normalised === '0' || normalised === 'false' || normalised === 'off');
}

interface CachedMode {
  readonly mode: KgMigrationMode;
  readonly readAt: number;
}

/**
 * Short-lived per-process cache.
 *
 * The mode is consulted on every mirrored write, and a database round trip per
 * write would put the generic path in the latency budget of a Kinetix request
 * it is not allowed to affect. Ten seconds is short enough that an operator
 * rolling a target back sees it take effect while they are still watching, and
 * long enough to keep the read off the hot path. The kill switch is deliberately
 * NOT cached — the emergency lever must never be up to ten seconds late.
 */
const MODE_CACHE_TTL_MS = 10_000;
const modeCache = new Map<string, CachedMode>();

function cacheKey(space: string, targetType: string): string {
  return `${space}/${targetType}`;
}

/** Drop the cache. Called after a state change, and by tests. */
export function invalidateMigrationStateCache(): void {
  modeCache.clear();
}

/**
 * The mode in force for one target type.
 *
 * Never throws. A failure to read the configuration resolves to `legacy_only`
 * with a logged warning, because the alternative — surfacing an error into a
 * Kinetix request that had nothing to do with governance — is the harm this
 * whole phase is built to avoid.
 */
export async function resolveMigrationMode(
  targetType: string,
  opts: { space?: string; db?: GovernanceDb } = {},
): Promise<KgMigrationMode> {
  if (forceLegacyEnabled()) return 'legacy_only';

  const space = opts.space ?? KINETIX_SPACE;
  const key = cacheKey(space, targetType);
  const cached = modeCache.get(key);
  if (cached && Date.now() - cached.readAt < MODE_CACHE_TTL_MS) {
    return cached.mode;
  }

  let mode: KgMigrationMode = 'legacy_only';
  try {
    const db = opts.db ?? getDb();
    const spaceRow = await findSpace(db, space);
    if (spaceRow) {
      const [row] = await db
        .select({ mode: kgMigrationState.mode })
        .from(kgMigrationState)
        .where(
          and(
            eq(kgMigrationState.spaceId, spaceRow.id),
            eq(kgMigrationState.targetType, targetType),
          ),
        )
        .limit(1);
      // An unrecognised string in the column — a mode removed in a later
      // release, a hand-edited row — is not a mode. Fall back rather than
      // trusting a value this build cannot reason about.
      if (row && isMigrationMode(row.mode)) mode = row.mode;
    }
  } catch (err) {
    console.warn(
      `[knowledge-governance] could not read migration state for ${key}; ` +
        `treating as legacy_only: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Deliberately not cached: a transient read failure must not pin the target
    // to legacy_only for the next ten seconds once the database recovers.
    return 'legacy_only';
  }

  // Not cached when the read happened inside a transaction. The value is the
  // transaction's own uncommitted view, and the cache is process-wide with a
  // ten-second life: a caller that read a mode it had just written and then
  // rolled back would leave every request path in this process using an
  // authority level the database does not have. That is the one direction the
  // cache must never be wrong in.
  if (!isInPoolTransaction()) modeCache.set(key, { mode, readAt: Date.now() });
  return mode;
}

/** True when the generic path may run beside the legacy one at all (§11.2). */
export function participatesInRequest(mode: KgMigrationMode): boolean {
  return MODE_RANK[mode] >= MODE_RANK.shadow;
}

/** True when generic records should be mirrored for this mode. */
export function mirrorsWrites(mode: KgMigrationMode): boolean {
  return MODE_RANK[mode] >= MODE_RANK.shadow;
}

/** True when the generic engine decides eligibility rather than observing it. */
export function isGenericAuthoritative(mode: KgMigrationMode): boolean {
  return mode === 'generic_authoritative';
}

export class MigrationStateTransitionError extends Error {
  constructor(message: string) {
    super(`knowledge-governance: ${message}`);
    this.name = 'MigrationStateTransitionError';
  }
}

/**
 * Target types where a wrong publication decision changes a computed dose
 * rather than a sentence (§13, Tier C/D). These may not jump straight to
 * `generic_authoritative` (§11.4).
 */
const HIGH_CONSEQUENCE_TARGET_TYPES: readonly string[] = [
  'pending_edit',
  'drug_parameter_revision',
];

/**
 * Which way this transition moves.
 *
 * Exported so that the audit payload and the receipt an operator reads are
 * derived from one rule. Written out twice they disagreed on the case neither
 * author had in mind: re-submitting the mode a target already has — to change
 * its notes, say — is not an advance, and calling it a `rollback` because it
 * is not one puts a retreat in the permanent record that never happened.
 */
export function migrationTransitionDirection(
  from: KgMigrationMode,
  to: KgMigrationMode,
): 'advance' | 'rollback' | 'unchanged' {
  if (MODE_RANK[to] === MODE_RANK[from]) return 'unchanged';
  return MODE_RANK[to] > MODE_RANK[from] ? 'advance' : 'rollback';
}

/**
 * Why §11.4 refuses this transition, or `null` when it permits it.
 *
 * Pure, and exported, so that the refusal can be reported by something that
 * is not about to write. A dry run that prints "re-run with --confirm" for a
 * move the guard rejects is describing a command that does not exist, and the
 * operator finds out by running it.
 *
 * Moving *backward* is always permitted, from any mode to any safer one: a
 * target can always retreat while legacy compatibility is installed, and a
 * rollback that had to satisfy a gate would not be a rollback.
 */
export function migrationTransitionRefusal(args: {
  targetType: string;
  from: KgMigrationMode;
  to: KgMigrationMode;
}): string | null {
  if (!isMigrationMode(args.to)) {
    return `unknown migration mode '${String(args.to)}'`;
  }
  const advancing = MODE_RANK[args.to] > MODE_RANK[args.from];
  if (
    advancing &&
    args.to === 'generic_authoritative' &&
    args.from === 'legacy_only' &&
    HIGH_CONSEQUENCE_TARGET_TYPES.includes(args.targetType)
  ) {
    return (
      `'${args.targetType}' cannot move from legacy_only straight to generic_authoritative; ` +
      'advance through the intermediate modes so there is parity evidence for the step'
    );
  }
  return null;
}

/**
 * Move a target to a new mode.
 *
 * Enforces the §11.4 safety rules that can be enforced in code:
 *
 *  - a high-consequence target cannot go directly from `legacy_only` to
 *    `generic_authoritative` — every intermediate mode exists to produce the
 *    parity evidence that justifies the next one, and skipping them means
 *    advancing on no evidence;
 *  - every change is audited, including who made it and what it replaced.
 *
 * Moving *backward* is always allowed, from any mode to any safer one: §11.4
 * says a target can always retreat while legacy compatibility is installed, and
 * a rollback that had to satisfy a gate would not be a rollback.
 *
 * The remaining rules are procedural and live outside the code: only an admin
 * may call this (the caller enforces that), and automated deployment must not.
 * No migration in this repository writes to the table.
 */
export async function setMigrationMode(args: {
  targetType: string;
  mode: KgMigrationMode;
  updatedBy: number | null;
  space?: string;
  notes?: string | null;
}): Promise<KgMigrationMode> {
  // §11.4 requires that every change is audited, which means the state row and
  // its audit event have to commit together. Written separately they can come
  // apart in the one direction that matters: the row lands, the audit insert
  // fails, and the caller sees an error for a change that has already taken
  // effect. An operator advancing a target to `generic_authoritative` would
  // then reasonably believe the generic path is not live while it is, and the
  // audit trail would not say otherwise.
  //
  // Alone among the functions here, this one takes no client. Every other
  // store helper accepts one because it participates in whatever unit of work
  // its caller has open; this one owns the unit, and a caller who handed in a
  // client captured before entering a transaction would get two autocommit
  // writes that neither commit together nor roll back with the caller —
  // precisely the failure above, wearing the shape of correct code. So the
  // client is resolved here: `inTransaction` joins an open unit rather than
  // opening a second connection beside it, and `getDb()` inside it is that
  // unit's own client.
  return inTransaction(() => applyMigrationMode(getDb(), args));
}

async function applyMigrationMode(
  db: GovernanceDb,
  args: {
    targetType: string;
    mode: KgMigrationMode;
    updatedBy: number | null;
    space?: string;
    notes?: string | null;
  },
): Promise<KgMigrationMode> {
  const spaceSlug = args.space ?? KINETIX_SPACE;
  const space = await ensureSpace(db, { slug: spaceSlug, name: spaceSlug });

  const [existing] = await db
    .select({ id: kgMigrationState.id, mode: kgMigrationState.mode })
    .from(kgMigrationState)
    .where(
      and(
        eq(kgMigrationState.spaceId, space.id),
        eq(kgMigrationState.targetType, args.targetType),
      ),
    )
    .limit(1);
  const previous: KgMigrationMode =
    existing && isMigrationMode(existing.mode) ? existing.mode : 'legacy_only';

  const direction = migrationTransitionDirection(previous, args.mode);
  const refusal = migrationTransitionRefusal({
    targetType: args.targetType,
    from: previous,
    to: args.mode,
  });
  if (refusal) throw new MigrationStateTransitionError(refusal);

  if (existing) {
    await db
      .update(kgMigrationState)
      .set({
        mode: args.mode,
        updatedBy: args.updatedBy,
        updatedAt: new Date(),
        notes: args.notes ?? null,
      })
      .where(eq(kgMigrationState.id, existing.id));
  } else {
    await db.insert(kgMigrationState).values({
      spaceId: space.id,
      targetType: args.targetType,
      mode: args.mode,
      updatedBy: args.updatedBy,
      notes: args.notes ?? null,
    });
  }

  await recordAuditEvent(db, {
    spaceId: space.id,
    eventType: 'migration_state_changed',
    subjectType: 'target_type',
    // Not a row id: the subject is a whole target type. Recorded as 0 with the
    // name in the payload rather than left out, so the audit table's NOT NULL
    // shape holds without inventing an id that points at something.
    subjectId: 0,
    actorRef: args.updatedBy === null ? null : `user:${args.updatedBy}`,
    payload: {
      targetType: args.targetType,
      from: previous,
      to: args.mode,
      direction,
      notes: args.notes ?? null,
    },
  });

  // Cleared twice, for two different readers.
  //
  // Now, so that anything continuing inside this transaction — the operator
  // receipt, most of all — re-reads rather than answering from the entry this
  // change has just invalidated.
  //
  // And again after the outermost commit, because the clear above only empties
  // the cache at the moment it runs. Between that moment and the commit, a
  // concurrent request in this process is still outside the transaction: it
  // reads the row as it was, caches it, and would go on serving that value for
  // the ten-second life of the entry — a retreat from `generic_authoritative`
  // leaving generic authority live for ten seconds after it was revoked. On a
  // rollback the deferred clear is discarded, which is right: the value a
  // concurrent reader cached is the value that survived.
  invalidateMigrationStateCache();
  afterTransactionCommit(invalidateMigrationStateCache);
  return previous;
}

/** Every target type with a stored mode, for an admin view. */
export async function listMigrationState(
  db: GovernanceDb,
  space: string = KINETIX_SPACE,
): Promise<Array<{ targetType: string; mode: KgMigrationMode; updatedAt: Date }>> {
  const spaceRow = await findSpace(db, space);
  if (!spaceRow) return [];
  const rows = await db
    .select({
      targetType: kgMigrationState.targetType,
      mode: kgMigrationState.mode,
      updatedAt: kgMigrationState.updatedAt,
    })
    .from(kgMigrationState)
    .where(eq(kgMigrationState.spaceId, spaceRow.id))
    .orderBy(kgMigrationState.targetType);
  return rows.map((r) => ({
    targetType: r.targetType,
    mode: isMigrationMode(r.mode) ? r.mode : 'legacy_only',
    updatedAt: r.updatedAt,
  }));
}
