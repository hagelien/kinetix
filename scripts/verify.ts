/**
 * Run, locally, the gates CI would have run for *this* change — because CI is
 * not running.
 *
 * GitHub Actions stopped allocating runners for this repository (a billing
 * matter, not a code one): every workflow fails in about four seconds with no
 * runner, no steps and no log, on every branch. Nothing is checked before
 * merge. That is the state this exists for.
 *
 * It is a stand-in, not a replacement, and the difference is worth stating
 * plainly. CI is trustworthy because it runs on a clean machine, from
 * `npm ci`, on every push, whether or not anyone remembers, and against the
 * *merge commit*. This runs on your working tree, with your `node_modules`,
 * when you type it. It can pass here and fail on a clean checkout, and two
 * branches that each pass alone can still break each other. A pass means "I
 * checked", never "CI is green".
 *
 * **It mirrors the workflows' own path filters rather than running
 * everything.** That is not a shortcut — it is the point. A gate that fires on
 * changes it was never meant to judge is a gate people learn to ignore, and a
 * check nobody reads is worse than no check at all. `catalog-drift` is a
 * weekly report, not a pull-request gate; `kinetics-core` only runs when the
 * kinetics sources move. Running them on a docs change would paint every
 * branch red for reasons that have nothing to do with it — and both of them
 * are, as of 2026-09-22, already failing on a clean `main`.
 *
 * So each gate below carries the same `paths:` its workflow carries, matched
 * against this branch's diff with `main`. `--all` overrides that and runs
 * everything, which is how you check the pre-existing state of the repository
 * rather than the state of your change.
 *
 * Usage:
 *   npm run verify             # the gates this branch's diff would trigger
 *   npm run verify -- --all    # every gate, including the scheduled reports
 *   npm run verify -- --fast   # skip the ~3 minute unit suite (reported, not hidden)
 *   npm run verify -- --list   # print the gates and what triggers them
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';

type Status = 'pass' | 'fail' | 'skipped' | 'not-triggered';

interface Gate {
  name: string;
  /** The workflow(s) this stands in for. */
  covers: string;
  command: string;
  args: string[];
  /**
   * The workflow's own `paths:` filter, verbatim. An empty array means the
   * workflow has none — it runs on every pull request.
   */
  paths: string[];
  /** Env vars without which the gate cannot run at all. */
  requires?: string[];
  /** Not a pull-request gate: a schedule or a manual dispatch. `--all` only. */
  scheduledOnly?: boolean;
  /** Minutes-long, so `--fast` can name what it dropped. */
  slow?: boolean;
}

const GATES: Gate[] = [
  {
    name: 'typecheck',
    covers: 'kinetics-core / simulator-mechanics (their `Typecheck` step)',
    command: 'npx',
    args: ['tsc', '--noEmit'],
    // No workflow typechecks the whole tree on every PR, but `tsc --noEmit` is
    // cheap, catches what the narrow suites would only catch by accident, and
    // is the check a contributor would run anyway. Kept unconditional.
    paths: [],
  },
  {
    name: 'typecheck:scripts',
    covers: 'scripts-typecheck',
    command: 'npx',
    args: ['tsc', '-p', 'tsconfig.scripts.json', '--noEmit'],
    paths: [
      'scripts/**',
      'api/**',
      'data/**',
      'db/**',
      'src/lib/**',
      'src/types/**',
      'tsconfig.json',
      'tsconfig.migrations.json',
      'tsconfig.scripts.json',
      'package.json',
      'package-lock.json',
      '.github/workflows/scripts-typecheck.yml',
    ],
  },
  {
    name: 'lint',
    covers: 'nothing — no workflow runs eslint',
    command: 'npx',
    args: ['eslint', 'src', '--ext', '.ts,.tsx'],
    paths: ['src/**', 'eslint.config.js'],
  },
  {
    name: 'unit',
    covers:
      'unit-tests (no path filter), and with it server-shared-esm, ' +
      'prompt-registry-sync, simulator-mechanics, kinetics-core',
    command: 'npx',
    args: ['vitest', 'run', '--reporter=dot'],
    paths: [],
    slow: true,
  },
  {
    name: 'provenance',
    covers: 'kinetics-core',
    command: 'npx',
    args: ['tsx', 'scripts/generate-registry-provenance.ts', '--check'],
    paths: [
      'src/lib/kinetics-core/**',
      'src/lib/kinetics-provenance/**',
      'scripts/generate-registry-provenance.ts',
      'scripts/generate-derived-registry.ts',
      'scripts/run-kinetics-validation.ts',
      'api/_lib/model-derivation-store.ts',
      'docs/kinetics-core/registry-provenance.md',
      'data/components.ts',
      '.github/workflows/kinetics-core.yml',
    ],
  },
  {
    name: 'derived-registry',
    covers: 'kinetics-core',
    command: 'npx',
    args: ['tsx', 'scripts/generate-derived-registry.ts', '--check'],
    paths: [
      'src/lib/kinetics-core/**',
      'src/lib/kinetics-provenance/**',
      'scripts/generate-registry-provenance.ts',
      'scripts/generate-derived-registry.ts',
      'scripts/run-kinetics-validation.ts',
      'api/_lib/model-derivation-store.ts',
      'docs/kinetics-core/registry-provenance.md',
      'data/components.ts',
      '.github/workflows/kinetics-core.yml',
    ],
    requires: ['DATABASE_URL'],
  },
  {
    name: 'catalog-drift',
    covers: 'catalog-drift — a WEEKLY report, never a pull-request gate',
    command: 'npx',
    args: [
      'tsx',
      'scripts/export-components.ts',
      '--check',
      '--max-drifts',
      '25',
    ],
    paths: [],
    scheduledOnly: true,
    requires: ['DATABASE_URL'],
  },
];

/** Workflows this does not stand in for. Printed, never silently dropped. */
const UNCOVERED = [
  'parity — needs Python `formulas` + `openpyxl` and a regenerated oracle snapshot',
  'migrations — needs a real Postgres (tests/integration)',
  'e2e (playwright) — not a pre-merge gate',
  'deploy-production — manual, human-only',
];

/**
 * Does a changed path match one of a workflow's `paths:` entries?
 *
 * Only the two forms the workflows actually use are handled — an exact path
 * and a `dir/**` prefix, plus the `src/lib/etoh**` style GitHub also accepts.
 * A general globber would be more code and no more correct here, and this is
 * checked against the real filters above rather than against a spec.
 */
function matches(changed: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) return changed.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith('**')) return changed.startsWith(pattern.slice(0, -2));
  return changed === pattern;
}

function triggered(gate: Gate, changed: string[]): boolean {
  if (gate.paths.length === 0) return true;
  return changed.some((file) => gate.paths.some((p) => matches(file, p)));
}

/**
 * Files this branch changes, against its merge base with `main`.
 *
 * Uncommitted work counts: the whole point is to check before pushing, and a
 * gate that ignored the edit still in the editor would be checking the wrong
 * tree. Falls back to "everything changed" if the merge base cannot be found
 * (a shallow clone, a detached head) — over-running gates is a cost, missing
 * one is a defect.
 */
function changedFiles(): { files: string[]; basis: string } {
  const base = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], {
    encoding: 'utf8',
  });
  if (base.status !== 0 || !base.stdout.trim()) {
    return {
      files: [],
      basis: 'no merge base with origin/main — running every gate',
    };
  }
  const sha = base.stdout.trim();
  const diff = spawnSync('git', ['diff', '--name-only', sha], {
    encoding: 'utf8',
  });
  // `git diff` does not see a file git has never been told about, and a
  // brand-new file is exactly the kind of change a gate must not miss: a new
  // script under `scripts/` is what `scripts-typecheck` exists for. Untracked
  // files (minus anything ignored) are therefore added explicitly.
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  );
  const files = [
    ...new Set(
      `${diff.stdout}\n${untracked.stdout}`
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ];
  return {
    files,
    basis: `${files.length} file(s) changed since ${sha.slice(0, 7)} (merge base with main)`,
  };
}

interface Result {
  gate: Gate;
  status: Status;
  seconds: number;
  note: string;
}

function run(gate: Gate): Result {
  const started = Date.now();
  const proc = spawnSync(gate.command, gate.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const seconds = (Date.now() - started) / 1000;
  if (proc.error) {
    return {
      gate,
      status: 'fail',
      seconds,
      note: `could not start: ${proc.error.message}`,
    };
  }
  return {
    gate,
    status: proc.status === 0 ? 'pass' : 'fail',
    seconds,
    note: proc.status === 0 ? '' : `exited ${proc.status}`,
  };
}

const MARK: Record<Status, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'NOT CHECKED',
  'not-triggered': 'n/a',
};

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.includes('--list')) {
    for (const gate of GATES) {
      console.log(`${gate.name.padEnd(18)} ${gate.covers}`);
      console.log(
        `${' '.repeat(18)} triggers on: ` +
          `${gate.scheduledOnly ? '--all only (scheduled report)' : gate.paths.length === 0 ? 'every change' : gate.paths.join(', ')}`,
      );
    }
    console.log(`\nNot covered:\n  ${UNCOVERED.join('\n  ')}`);
    return;
  }

  const all = argv.includes('--all');
  const fast = argv.includes('--fast');
  const { files, basis } = changedFiles();

  console.log(
    'Running the pre-merge gates locally. CI cannot allocate runners for this\n' +
      'repository, so this is the only check these commits get.\n',
  );
  console.log(`  ${all ? 'running every gate (--all)' : basis}\n`);

  const results: Result[] = [];
  for (const gate of GATES) {
    if (!all && gate.scheduledOnly) {
      results.push({
        gate,
        status: 'not-triggered',
        seconds: 0,
        note: 'scheduled report, not a PR gate',
      });
      continue;
    }
    if (!all && files.length > 0 && !triggered(gate, files)) {
      results.push({
        gate,
        status: 'not-triggered',
        seconds: 0,
        note: 'no changed file matches its paths',
      });
      continue;
    }
    if (fast && gate.slow) {
      results.push({
        gate,
        status: 'skipped',
        seconds: 0,
        note: 'dropped by --fast',
      });
      continue;
    }
    const missing = (gate.requires ?? []).filter(
      (k) => !process.env[k]?.trim(),
    );
    if (missing.length > 0) {
      results.push({
        gate,
        status: 'skipped',
        seconds: 0,
        note: `needs ${missing.join(', ')}`,
      });
      continue;
    }
    console.log(`\n──── ${gate.name} ────────────────────────────────────────`);
    results.push(run(gate));
  }

  console.log(
    '\n\n─── Gates ─────────────────────────────────────────────────',
  );
  for (const r of results) {
    const time = r.seconds > 0 ? `${r.seconds.toFixed(0)}s` : '';
    console.log(
      `  ${MARK[r.status].padEnd(12)} ${r.gate.name.padEnd(18)} ${time.padStart(5)}` +
        `${r.note ? `  ${r.note}` : ''}`,
    );
  }

  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(
    `\nNot covered by this script at all:\n  ${UNCOVERED.join('\n  ')}`,
  );

  if (failed.length > 0) {
    console.log(
      `\n${failed.length} gate(s) FAILED: ${failed.map((r) => r.gate.name).join(', ')}`,
    );
    process.exit(1);
  }

  if (skipped.length > 0) {
    // Deliberately not an exit code. A contributor without DATABASE_URL is a
    // normal state, and failing on it would train people to ignore the output
    // — which is the one thing this must not do. Loud in the text instead.
    console.log(
      `\nPARTIAL: ${skipped.length} gate(s) did not run ` +
        `(${skipped.map((r) => r.gate.name).join(', ')}). ` +
        'Everything that could run here passed.',
    );
    return;
  }

  console.log(
    '\nEvery gate this change triggers passed locally. That is not CI green: ' +
      'this ran on your working tree and your node_modules, not a clean ' +
      'checkout, and not against the merge commit.',
  );
}

main();
