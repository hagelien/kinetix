/**
 * Import historical legacy rows into the generic schema as explicit snapshots
 * (Step B of docs/plans/2026-09-05-assurance-transition-continuation.md).
 *
 *   npx tsx scripts/governance-import-history.ts \
 *     [--target-type=pending_edit] [--edit-type=wiki_fact] \
 *     [--limit=500] [--page-size=200] [--after=<id>] [--apply]
 *
 * Preview by default: it plans every row in the requested population, prints
 * the state each one would land in, how its historical verdicts would bind, and
 * which reconciliation findings the plan expects to remain — then writes
 * nothing. `--apply` executes exactly that plan.
 *
 * This is **not** `governance-repair.ts --apply`. Repair re-runs the live
 * mirror, which projects every new proposal as `pending`; pointed at an
 * already-approved 2024 edit it records a decided edit as still under review.
 * Use this command for the initial historical backfill and that one for
 * rebuilding mirrors of rows the live path lost.
 *
 * Bounded and resumable on purpose. A run that stops at `--limit` says so and
 * prints the `--after` cursor to continue from; it never reports a partial scan
 * as complete, and re-running is safe — an already-imported row is skipped
 * rather than duplicated.
 *
 * The cursor is not the whole resume story, and the command says so rather than
 * letting a script assume it is: `--after` records where the *scan* stopped, so
 * a row that was examined and not imported (it moved mid-capture, it failed, the
 * mode forbade the write) is behind the cursor and would never be revisited.
 * Those rows are listed as NEEDS ATTENTION and the command exits non-zero, so a
 * batch runner stops instead of walking past the hole.
 */
import 'dotenv/config';
import {
  describeHistoricalImport,
  importHistoricalSnapshots,
} from '../api/_lib/knowledge-governance/historical-import.js';

function usage(): never {
  console.error(
    'usage: npx tsx scripts/governance-import-history.ts ' +
      '[--target-type=<type>] [--edit-type=<type>] [--limit=<n>] ' +
      '[--page-size=<n>] [--after=<id>] [--apply] [--json]',
  );
  process.exit(2);
}

function positiveInt(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) usage();
  return value;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  let legacyType: string | undefined;
  let editType: string | undefined;
  let limit: number | undefined;
  let pageSize: number | undefined;
  let after: number | undefined;
  let apply = false;
  let json = false;

  for (const arg of process.argv.slice(2)) {
    const [flag, raw] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    switch (flag) {
      case '--target-type':
        legacyType = raw || usage();
        break;
      case '--edit-type':
        editType = raw || usage();
        break;
      case '--limit':
        limit = positiveInt(raw);
        break;
      case '--page-size':
        pageSize = positiveInt(raw);
        break;
      case '--after':
        after = positiveInt(raw);
        break;
      case '--apply':
        apply = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        console.error(`unknown argument '${arg}'`);
        usage();
    }
  }

  const report = await importHistoricalSnapshots({
    legacyType,
    editType,
    limit,
    pageSize,
    after,
    dryRun: !apply,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(describeHistoricalImport(report));
    if (!apply) {
      console.log('preview; nothing written. Re-run with --apply to import.');
    }
  }

  // Any row this run examined and did not import means the population is not
  // imported, and `--after` walks past it: the cursor records where the scan
  // stopped, not which rows landed. Exiting 0 would let a batch script march on
  // to the next page over that hole and eventually report a complete pass.
  // A failure, a row that moved mid-capture, and a mode that forbids the write
  // are all that hole.
  if (apply && (report.revisit.length > 0 || !report.writable)) process.exit(1);
  if (!apply && report.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(3);
});
