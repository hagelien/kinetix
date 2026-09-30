/**
 * Change one knowledge-governance target's migration mode — the admin lever
 * of docs/plans/2026-08-26-general-knowledge-governance-extraction.md §11.4.
 *
 *   npx tsx scripts/governance-migration-state.ts \
 *       --target=pending_edit --mode=shadow --by=<admin users.id> \
 *       [--notes="why"] --confirm
 *
 * Without `--confirm` it verifies the operator, prints what would change,
 * and exits 1 having written nothing. With it, the change is made through
 * `setMigrationMode`, which enforces the high-consequence guard and writes the
 * audit event; the operator's role is checked against `users` first.
 *
 * Keys: the coarse `pending_edit` (and the other verification target types)
 * governs mirroring and reads; `pending_edit:<editType>` governs apply
 * authority for one edit type and must also be in CUTOVER_ELIGIBLE_EDIT_TYPES
 * for the generic engine to decide anything.
 *
 * Rollback is the same command with a safer mode; every mode may retreat.
 * The emergency lever is not here at all: set
 * `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1` in the deployment and redeploy.
 *
 * Nothing invokes this on deploy or on a schedule. Keep it that way.
 */
import 'dotenv/config';
import { getDb } from '../api/_lib/db.js';
import {
  MIGRATION_MODES,
  isMigrationMode,
  listMigrationState,
  migrationTransitionRefusal,
  resolveMigrationMode,
} from '../api/_lib/knowledge-governance/migration-state.js';
import {
  changeMigrationMode,
  describeMigrationModeChange,
  requireMigrationAdmin,
} from '../api/_lib/knowledge-governance/operator-migration-state.js';

function usage(): never {
  console.error(
    'usage: npx tsx scripts/governance-migration-state.ts --target=<targetType> ' +
      `--mode=<${MIGRATION_MODES.join('|')}> --by=<admin users.id> [--notes=<text>] --confirm`,
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): {
  target: string;
  mode: string;
  by: number;
  notes: string | null;
  confirm: boolean;
} {
  let target: string | undefined;
  let mode: string | undefined;
  let by: number | undefined;
  let notes: string | null = null;
  let confirm = false;
  for (const arg of argv) {
    const [flag, raw] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    switch (flag) {
      case '--target':
        target = raw;
        break;
      case '--mode':
        mode = raw;
        break;
      case '--by':
        by = Number(raw);
        break;
      case '--notes':
        notes = raw ?? null;
        break;
      case '--confirm':
        confirm = true;
        break;
      default:
        console.error(`unknown argument '${arg}'`);
        usage();
    }
  }
  if (!target || !mode || by === undefined || !Number.isInteger(by) || by <= 0) usage();
  return { target, mode, by, notes, confirm };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const { target, mode, by, notes, confirm } = parseArgs(process.argv.slice(2));
  if (!isMigrationMode(mode)) {
    console.error(`unknown mode '${mode}'; one of ${MIGRATION_MODES.join(', ')}`);
    process.exit(2);
  }
  const db = getDb();
  const admin = await requireMigrationAdmin(db, by);

  // The stored row is the before-state, and the resolved mode is a different
  // fact: `resolveMigrationMode` answers `legacy_only` whenever the kill
  // switch is engaged or the read failed, so a preview built from it would
  // announce `legacy_only -> shadow` for a target actually stored at
  // `generic_authoritative` — and the `--confirm` run, which reads the row,
  // would then do something other than what the dry run showed. Both are
  // printed because both matter: one is what changes, the other is what the
  // request path will do afterwards.
  const stored =
    (await listMigrationState(db)).find((row) => row.targetType === target)?.mode ??
    'legacy_only';
  const resolved = await resolveMigrationMode(target, { db });

  // Checked before the plan is printed, not left for the confirmed run to
  // discover: a preview that says "re-run with --confirm" for a move §11.4
  // refuses is describing a command that does not exist.
  const refusal = migrationTransitionRefusal({ targetType: target, from: stored, to: mode });
  if (refusal) {
    console.error(`refused: ${refusal}`);
    process.exit(2);
  }

  if (!confirm) {
    console.log(
      `would change ${target}: ${stored} -> ${mode}, as ${admin.username} (user ${admin.id})` +
        (notes ? `, notes: ${notes}` : ''),
    );
    if (resolved !== stored) {
      console.log(
        `  note: the request path currently resolves '${resolved}', not the stored ` +
          "'" + stored + "' — the force-legacy kill switch is engaged",
      );
    }
    console.log('nothing written; re-run with --confirm to apply');
    process.exit(1);
  }

  const result = await changeMigrationMode({ targetType: target, mode, byUserId: by, notes });
  console.log(describeMigrationModeChange(result));
  console.log(
    'verify with: npx tsx scripts/governance-status.ts — and roll back with the same ' +
      'command and a safer mode',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(3);
});
