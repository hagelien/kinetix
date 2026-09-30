/**
 * The admin's lever, wrapped for an operator terminal.
 *
 * `setMigrationMode` has enforced §11.4's code-enforceable rules since Phase 4
 * — the high-consequence guard, the audit event — but it had no caller outside
 * the test suite. The continuation plan's Step B says advancement "remains a
 * deliberate admin action after the code/dossier PR is merged", and the only
 * way to take that action was a hand-written UPDATE on `kg_migration_state`,
 * which skips both rules the function exists to apply. A lever nobody can
 * reach without bypassing its guards is a guard, not a lever.
 *
 * This module adds the procedural rule §11.4 leaves to the caller — *only an
 * admin may change state* — and nothing else. It resolves the operator from
 * `users` and refuses unless the row carries the `admin` role, so the audit
 * event names a person who was allowed to do this, and it reports what the
 * request path will resolve afterwards, so an operator who advanced an
 * ineligible edit type finds out from the terminal rather than from the
 * absence of any effect.
 *
 * Nothing here runs on deploy, on a schedule, or from a request. It runs when
 * someone types the command (`scripts/governance-migration-state.ts`), with
 * the target, the mode, and their own user id spelled out.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { users, type KgMigrationMode } from '../../../db/schema.js';
import {
  CUTOVER_ELIGIBLE_EDIT_TYPES,
  resolveApplyAuthority,
  type ApplyAuthority,
} from './cutover.js';
import {
  MIGRATION_MODES,
  isMigrationMode,
  migrationTransitionDirection,
  resolveMigrationMode,
  setMigrationMode,
} from './migration-state.js';
import type { GovernanceDb } from './store/interface.js';

/** The `users.role` that may change migration state. */
export const MIGRATION_ADMIN_ROLE = 'admin';

const APPLY_AUTHORITY_PREFIX = 'pending_edit:';

export class MigrationOperatorError extends Error {
  constructor(message: string) {
    super(`knowledge-governance: ${message}`);
    this.name = 'MigrationOperatorError';
  }
}

export interface ChangeMigrationModeArgs {
  readonly targetType: string;
  readonly mode: KgMigrationMode;
  /** The admin performing the change; verified against `users`. */
  readonly byUserId: number;
  readonly notes?: string | null;
}

export interface ChangeMigrationModeResult {
  readonly targetType: string;
  readonly previous: KgMigrationMode;
  readonly mode: KgMigrationMode;
  readonly direction: 'advance' | 'rollback' | 'unchanged';
  /** What the request path resolves now — the kill switch included. */
  readonly resolved: KgMigrationMode;
  /** Present when the key is an apply-authority key (`pending_edit:<editType>`). */
  readonly authority: ApplyAuthority | null;
  readonly warnings: readonly string[];
}

function editTypeOf(targetType: string): string | null {
  return targetType.startsWith(APPLY_AUTHORITY_PREFIX)
    ? targetType.slice(APPLY_AUTHORITY_PREFIX.length)
    : null;
}

/**
 * Confirm the operator may do this.
 *
 * Read from the database, not from an argument: `--by` names who is acting,
 * and the table says whether they are allowed to. Exported so the CLI can
 * refuse before printing a plan, not only before writing.
 */
export async function requireMigrationAdmin(
  db: GovernanceDb,
  userId: number,
): Promise<{ id: number; username: string }> {
  const [row] = await db
    .select({ id: users.id, username: users.username, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new MigrationOperatorError(`no user with id ${userId}`);
  if (row.role !== MIGRATION_ADMIN_ROLE) {
    throw new MigrationOperatorError(
      `user ${userId} (${row.username}) has role '${row.role}', and only an ` +
        `'${MIGRATION_ADMIN_ROLE}' may change migration state (§11.4)`,
    );
  }
  return { id: row.id, username: row.username };
}

/** Change one target's mode, as an admin, and report the effect. */
export async function changeMigrationMode(
  args: ChangeMigrationModeArgs,
): Promise<ChangeMigrationModeResult> {
  // Resolved here rather than taken as an argument, for the same reason
  // `setMigrationMode` stopped accepting one. The transaction boundary either
  // encloses this whole function — a caller's unit of work, in which case
  // `getDb()` is that unit's client and every read below sees the change it
  // just made — or lies entirely inside `setMigrationMode`, in which case it
  // has committed by the time these run. A client captured before either
  // boundary would read around the change and report the target's old mode,
  // which this function would then announce as the kill switch being engaged.
  const db = getDb();
  if (!isMigrationMode(args.mode)) {
    throw new MigrationOperatorError(
      `unknown migration mode '${String(args.mode)}'; one of ${MIGRATION_MODES.join(', ')}`,
    );
  }
  const admin = await requireMigrationAdmin(db, args.byUserId);

  // No client is passed: `setMigrationMode` owns the transaction that keeps
  // the state row and its audit event together, and resolves the ambient
  // client inside it.
  const previous = await setMigrationMode({
    targetType: args.targetType,
    mode: args.mode,
    updatedBy: admin.id,
    notes: args.notes ?? null,
  });

  const direction = migrationTransitionDirection(previous, args.mode);

  const resolved = await resolveMigrationMode(args.targetType, { db });
  const editType = editTypeOf(args.targetType);
  const authority = editType ? await resolveApplyAuthority(editType, { db }) : null;

  const warnings: string[] = [];
  if (resolved !== args.mode) {
    warnings.push(
      `the stored mode is '${args.mode}' but the request path resolves '${resolved}' ` +
        '— the force-legacy kill switch is engaged in this process',
    );
  }
  if (editType && !CUTOVER_ELIGIBLE_EDIT_TYPES.includes(editType)) {
    warnings.push(
      `'${editType}' is not in CUTOVER_ELIGIBLE_EDIT_TYPES on this build; the ` +
        'generic engine will not decide it whatever this row says (Lock 2)',
    );
  }
  return {
    targetType: args.targetType,
    previous,
    mode: args.mode,
    direction,
    resolved,
    authority,
    warnings,
  };
}

/** One-screen rendering of the change, for the terminal. */
export function describeMigrationModeChange(result: ChangeMigrationModeResult): string {
  const lines = [
    `${result.targetType}: ${result.previous} -> ${result.mode} (${result.direction})`,
    `  request path now resolves: ${result.resolved}`,
  ];
  if (result.authority) {
    lines.push(
      `  apply authority:           ${
        result.authority.authoritative
          ? 'GENERIC decides'
          : `legacy decides (withheld: ${result.authority.withheld})`
      }`,
    );
  }
  for (const warning of result.warnings) lines.push(`  WARNING: ${warning}`);
  return lines.join('\n');
}
