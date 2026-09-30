/**
 * Read-only knowledge-governance status, for an operator.
 *
 *   npx tsx scripts/governance-status.ts [--edit-type=wiki_fact] [--survey]
 *       [--queue-agent=<agents.id>|all] [--queue-limit=100] [--queue-min-age=5]
 *       [--limit=500] [--max-pages=200] [--json]
 *
 * Runs Step A of docs/plans/2026-09-05-assurance-transition-continuation.md
 * against `DATABASE_URL`: migration modes, apply authority, the target's
 * dossier (`assessReadiness`), the §17.3 parity report, optional queue parity
 * per agent, and the §26 definition-of-done audit — all of them the existing
 * report functions, composed by `operator-status.ts`.
 *
 * This script never changes migration state. Advancing or rolling back a
 * target (`setMigrationMode`) is a deliberate admin action and is not offered
 * here on purpose: a status command that could also advance is a status
 * command that one day advances. Nothing here writes; see the module header
 * for the one caveat about the space row, which this script honours.
 */
import 'dotenv/config';
import {
  describeOperatorStatus,
  gatherOperatorStatus,
  type OperatorStatusOptions,
} from '../api/_lib/knowledge-governance/operator-status.js';

function usage(): never {
  console.error(
    'usage: npx tsx scripts/governance-status.ts [--edit-type=<type>] [--survey] ' +
      '[--queue-agent=<id>|all] [--queue-limit=<n>] [--queue-min-age=<minutes>] ' +
      '[--limit=<n>] [--max-pages=<n>] [--json]',
  );
  process.exit(2);
}

function positiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${flag} must be a positive integer, got '${raw}'`);
    usage();
  }
  return value;
}

function parseArgs(argv: readonly string[]): OperatorStatusOptions & { json: boolean } {
  let json = false;
  const opts: {
    -readonly [K in keyof OperatorStatusOptions]: OperatorStatusOptions[K];
  } = {};
  for (const arg of argv) {
    const [flag, raw] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const need = (): string => {
      if (raw === undefined || raw === '') {
        console.error(`${flag} needs a value`);
        usage();
      }
      return raw;
    };
    switch (flag) {
      case '--json':
        json = true;
        break;
      case '--survey':
        opts.survey = true;
        break;
      case '--edit-type':
        opts.editType = need();
        break;
      case '--queue-agent': {
        const value = need();
        if (value === 'all') {
          opts.queueAgents = 'all';
        } else {
          const ids = value.split(',').map((id) => positiveInt(id, flag));
          opts.queueAgents =
            opts.queueAgents && opts.queueAgents !== 'all'
              ? [...opts.queueAgents, ...ids]
              : ids;
        }
        break;
      }
      case '--queue-limit':
        opts.queueLimit = positiveInt(need(), flag);
        break;
      case '--queue-min-age':
        opts.queueMinAgeMinutes = Number(need());
        if (!Number.isFinite(opts.queueMinAgeMinutes) || opts.queueMinAgeMinutes < 0) {
          usage();
        }
        break;
      case '--limit':
        opts.limit = positiveInt(need(), flag);
        break;
      case '--max-pages':
        opts.maxPages = positiveInt(need(), flag);
        break;
      case '--help':
      case '-h':
        usage();
      // eslint-disable-next-line no-fallthrough
      default:
        console.error(`unknown argument '${arg}'`);
        usage();
    }
  }
  return { ...opts, json };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const { json, ...opts } = parseArgs(process.argv.slice(2));
  const status = await gatherOperatorStatus(opts);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(describeOperatorStatus(status));
  }
  // Exit code says what the dossier said, so a script can gate on it without
  // parsing text. 0: ready. 1: not ready. Anything else: could not report.
  process.exit(status.readiness.ready ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(3);
});
