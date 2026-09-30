/**
 * Level 4 data repair: rebuild missing generic mirrors from legacy state
 * (docs/plans/2026-08-26-rollback-playbook.md, `repair.ts`).
 *
 *   npx tsx scripts/governance-repair.ts [--target-type=pending_edit] [--limit=500] [--apply]
 *
 * Dry run by default: it scans, says what it would re-mirror and what it will
 * never touch, and writes nothing. `--apply` re-mirrors the repairable
 * findings (`missing_proposal`, `missing_assessment`) through the same mirror
 * functions the request path uses, which means it respects migration state:
 * under `legacy_only` the mirror declines and every finding is reported as
 * `mirror_failed` / skipped by mode. Advance the coarse target type to
 * `shadow` first (scripts/governance-migration-state.ts) if the intent is to
 * backfill historical rows.
 *
 * Nothing here deletes; see the module header for why that is the rule.
 */
import 'dotenv/config';
import {
  describeRepair,
  repairMirrors,
} from '../api/_lib/knowledge-governance/repair.js';

function usage(): never {
  console.error(
    'usage: npx tsx scripts/governance-repair.ts [--target-type=<type>] [--limit=<n>] [--apply]',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  let targetType: string | undefined;
  let limit: number | undefined;
  let apply = false;
  for (const arg of process.argv.slice(2)) {
    const [flag, raw] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    switch (flag) {
      case '--target-type':
        targetType = raw;
        if (!targetType) usage();
        break;
      case '--limit':
        limit = Number(raw);
        if (!Number.isInteger(limit) || limit <= 0) usage();
        break;
      case '--apply':
        apply = true;
        break;
      default:
        console.error(`unknown argument '${arg}'`);
        usage();
    }
  }
  const report = await repairMirrors({ targetType, limit, dryRun: !apply });
  console.log(describeRepair(report));
  if (!apply) console.log('dry run; nothing written. Re-run with --apply to re-mirror.');
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(3);
});
