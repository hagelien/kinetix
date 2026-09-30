/**
 * Rank the repo's open dependency vulnerabilities by what it costs to fix them.
 *
 *   npm run deps:audit                    # ranked table
 *   npm run deps:audit -- --json          # machine-readable triage
 *   npm run deps:audit:check              # exit 1 on mechanically fixable high+
 *   node scripts/dependency-audit-scan.ts --check --min-severity moderate
 *   node scripts/dependency-audit-scan.ts --input audit.json
 *
 * Run with bare `node`, not `tsx`. Node strips the type annotations itself
 * (>=22.18), so the scan works in a fresh clone with no `node_modules` — which
 * it has to, because the scheduled routine triages *before* it installs
 * anything, and `tsx` is a devDependency that would not exist yet.
 *
 * This is the reading half of the dependency-security loop;
 * `agents/dependency-security-maintainer.md` is the fixing half and runs this
 * first on every cycle. The classification lives in `src/lib/dependencyAudit.ts`
 * (pure, unit-tested); this file only shells out to npm, loads the manifest and
 * lockfile, and renders.
 *
 * ── Why not just read the Dependabot alert list ──────────────────────────────
 * Because it does not say what a fix costs. `npm audit` does — in `fixAvailable`
 * — and `package-lock.json` says whether the vulnerable code ships to a user or
 * only ever runs on a build machine. Those two facts decide whether an alert
 * can be cleared by a bot or needs a person, and neither is visible in the
 * GitHub UI. Cross-reference the output with the alert list rather than
 * replacing it: an alert with no matching finding here usually means the
 * lockfile already moved past it and the alert will close on the next scan.
 *
 * ── Exit codes ───────────────────────────────────────────────────────────────
 * Without `--check`, always 0 (it is a report). With `--check`, 1 when any
 * finding at or above `--min-severity` is mechanically fixable — the ones with
 * no excuse for still being open. `major` and `no-auto-fix` findings need a
 * human decision and are reported but do not fail the gate unless `--strict`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEVERITY_ORDER,
  classifyAuditReport,
  gateFailures,
  type AuditFinding,
  type AuditTriage,
  type NpmAuditReport,
  type PackageLock,
  type PackageManifest,
  type Severity,
} from '../src/lib/dependencyAudit.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  json: boolean;
  check: boolean;
  strict: boolean;
  minSeverity: Severity;
  input: string | null;
}

function isSeverity(value: string): value is Severity {
  return (SEVERITY_ORDER as readonly string[]).includes(value);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    json: false,
    check: false,
    strict: false,
    minSeverity: 'high',
    input: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--min-severity') {
      const value = argv[++i];
      if (value === undefined || !isSeverity(value)) {
        throw new Error(
          `--min-severity expects one of ${SEVERITY_ORDER.join('|')}, got ${value ?? '(nothing)'}`,
        );
      }
      options.minSeverity = value;
    } else if (arg === '--input') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--input expects a file path');
      options.input = value;
    } else if (arg !== undefined) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Reject anything that is not a successful audit report.
 *
 * A failed `npm audit` still writes JSON — an `error` object and no
 * `vulnerabilities` map. Since a report with no vulnerabilities classifies as a
 * clean tree, accepting one of those payloads would turn an outage of the
 * advisory service into a **passing** security gate. Every path into the
 * classifier goes through here, `--input` included: a saved report is exactly
 * as likely to be a recorded failure as a live one.
 */
function validateAuditReport(raw: unknown, source: string): NpmAuditReport {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${source} is not a JSON object`);
  }

  const report = raw as NpmAuditReport & { error?: { detail?: string; summary?: string } };
  if (report.error) {
    const detail = report.error.detail ?? report.error.summary ?? 'unknown error';
    throw new Error(`${source} reports a failed audit: ${detail}`);
  }
  if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    throw new Error(
      `${source} has no "vulnerabilities" map — refusing to report a clean tree from an incomplete audit`,
    );
  }
  return report;
}

/**
 * `npm audit` exits non-zero whenever it finds anything, so a non-zero status
 * is the normal case here, not a failure. Only a missing/unparseable payload
 * means the command actually broke.
 *
 * `--package-lock-only` is load-bearing, not an optimisation. It makes npm
 * resolve from `package-lock.json` instead of `node_modules`, which means:
 *
 *   1. The report describes what the repo *pins*, not whatever happens to be
 *      installed on the machine running the scan. That is the question this
 *      tool exists to answer, and it is what a fresh `npm ci` would produce.
 *   2. Triage needs no install at all — so the scheduled routine can rank every
 *      advisory before a single line of dependency code has executed. For a job
 *      whose whole purpose is pulling in newer versions of other people's
 *      packages, deciding what to install without first installing it is worth
 *      more than the milliseconds it saves.
 *
 * Verified to produce a byte-identical finding set to the installed-tree audit
 * on this repo, down to `nodes` and `fixAvailable`.
 */
function runNpmAudit(): NpmAuditReport {
  let stdout: string;
  try {
    stdout = execFileSync('npm', ['audit', '--json', '--package-lock-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const output = (err as { stdout?: string }).stdout;
    if (!output) throw err;
    stdout = output;
  }

  return validateAuditReport(JSON.parse(stdout), 'npm audit');
}

/**
 * Directories whose code runs in production: the Vite-bundled SPA, the
 * serverless API, and the data/schema modules both import. Tests are excluded —
 * a package imported only by a spec file never reaches a user.
 *
 * `scripts/` is deliberately **not** here. It looks deployable (AGENTS.md calls
 * the vanilla widgets "legacy but still active") but nothing ships it:
 * `index.html` loads exactly one entry, `/src/main.tsx`, and no file under
 * `src/` references `scripts/`. What the directory actually holds is
 * maintenance CLIs — seed, backfill, import, this scanner — plus the two
 * migration steps `vercel.json` runs at *build* time. Scanning it would mark
 * `jsdom` (imported by `scripts/farmakologiportalen/parse.ts`) and `dotenv`
 * (imported by most seed scripts) as reaching production, promoting build-only
 * findings ahead of genuinely shipped ones. If a vanilla widget is ever wired
 * back into a served page, add that entry file here.
 */
const DEPLOYED_ROOTS = ['src', 'api', 'data', 'db'];
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(\.(test|spec)\.|(^|\/)(__tests__|test)\/)/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`; relative/builtin → null. */
function packageNameFromSpecifier(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:') || specifier.startsWith('@/') || specifier.startsWith('@db/')) {
    return null;
  }
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return name && name.length > 0 ? name : null;
}

/**
 * Package names imported *directly* by code that runs in production.
 *
 * This exists because a lockfile `dev` flag is about installation, not reach.
 * `lucide-react`, `clsx`, and `tailwind-merge` are all `devDependencies` in this
 * repo, all flagged `dev: true`, and all bundled into the browser by Vite —
 * `lucide-react` alone is imported by dozens of components. Ranking an advisory
 * in one of those as "build-only" would bury a user-facing vulnerability under
 * findings that matter less.
 *
 * These are only the **roots**. `expandThroughDependencies` walks the lockfile
 * graph from here, so a vulnerable transitive child of an imported package is
 * reached too — the regex never has to see it.
 *
 * The remaining approximation is at the root set: a package counts as imported
 * if any deployed file names it, without asking whether the bundler tree-shakes
 * that module out of the shipped chunk. That bias is deliberate — it can only
 * move a finding *up* the ranking, never bury one — and anything not provably
 * build-only stays `unknown` regardless.
 */
function collectDeployedImports(): Set<string> {
  const imported = new Set<string>();

  for (const root of DEPLOYED_ROOTS) {
    let entries: string[];
    try {
      entries = readdirSync(join(repoRoot, root), { recursive: true, encoding: 'utf8' });
    } catch {
      continue; // Optional root; absent in a partial checkout.
    }

    for (const entry of entries) {
      const path = entry.split(sep).join('/');
      if (!SOURCE_EXTENSIONS.test(path) || TEST_FILE.test(path)) continue;

      let source: string;
      try {
        source = readFileSync(join(repoRoot, root, entry), 'utf8');
      } catch {
        continue; // Directory entry or unreadable file.
      }

      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const name = packageNameFromSpecifier(match[1] ?? '');
        if (name) imported.add(name);
      }
    }
  }

  return imported;
}

/**
 * Where the package is declared. This says nothing about whether the vulnerable
 * code ships — see `formatReach`.
 */
function formatDeclared(finding: AuditFinding): string {
  if (finding.manifestScope === 'dependencies') return 'direct prod';
  if (finding.manifestScope === 'devDependencies') return 'direct dev';
  return 'transitive';
}

/**
 * Whether the vulnerable installs reach a user, from the lockfile.
 *
 * Kept as its own column because declaration and reach are independent axes and
 * collapsing them lies in both directions: a package declared in
 * `devDependencies` can still be pulled into the production tree by something
 * else, and a package declared in `dependencies` can have only a dev-tree copy
 * flagged. Reporting "direct dev" for the first would understate that affected
 * code ships; reporting "direct prod" for the second would overstate it.
 */
function formatReach(finding: AuditFinding): string {
  return finding.productionReach;
}

/**
 * Name the package to bump, not just the version.
 *
 * When a transitive vulnerability is resolved by bumping the parent that pins
 * it, npm reports the *parent* in `fixAvailable.name`. Printing only the
 * version next to the vulnerable leaf would tell a maintainer to bump a package
 * they have not declared — so always render the package the version belongs to,
 * and keep it explicit when that differs from the vulnerable one.
 */
function formatFix(finding: AuditFinding): string {
  const target =
    finding.fixVersion === null
      ? null
      : `${finding.fixPackage ?? finding.package}@${finding.fixVersion}`;

  switch (finding.fixClass) {
    case 'in-range':
      return 'npm audit fix';
    case 'out-of-range':
      return `bump ${target ?? '?'}`;
    case 'major':
      return `major → ${target ?? '?'}`;
    case 'no-auto-fix':
      // Never phrase this as "no fix exists" — npm reports `fixAvailable:
      // false` for any non-registry spec too, patched upstream or not.
      if (finding.nonRegistrySpec) return 'no npm fix (non-registry spec)';
      return finding.overridden ? 'no npm fix (pinned)' : 'no npm fix';
  }
}

function renderTable(triage: AuditTriage, options: Options): void {
  const { findings, summary } = triage;

  if (findings.length === 0) {
    console.log('No known vulnerabilities in the dependency tree.');
    return;
  }

  const rows = findings.map((finding) => [
    finding.severity,
    finding.package,
    formatDeclared(finding),
    formatReach(finding),
    formatFix(finding),
  ]);
  const headers = ['SEVERITY', 'PACKAGE', 'DECLARED', 'REACH', 'FIX'];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();

  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));

  console.log('');
  for (const finding of findings) {
    console.log(`${finding.package} (${finding.vulnerableRange})`);
    if (finding.reachableVia.length > 0) {
      console.log(`  reached via: ${finding.reachableVia.join(', ')}`);
    }
    if (finding.fixPackage !== null && finding.fixPackage !== finding.package) {
      console.log(
        `  fixed by bumping ${finding.fixPackage} to ${finding.fixVersion} — ` +
          'the parent that pins it, not this package',
      );
    }
    for (const advisory of finding.advisories) {
      const score = advisory.cvss !== null ? ` (CVSS ${advisory.cvss})` : '';
      console.log(`  [${advisory.severity}] ${advisory.title}${score}`);
      console.log(`    ${advisory.url}`);
    }
  }

  console.log('');
  const severityCounts = [...SEVERITY_ORDER]
    .reverse()
    .filter((severity) => summary.bySeverity[severity] > 0)
    .map((severity) => `${summary.bySeverity[severity]} ${severity}`)
    .join(', ');
  console.log(`${summary.total} vulnerable package(s): ${severityCounts}`);
  console.log(
    `${summary.actionable} mechanically fixable ` +
      `(${summary.byFixClass['in-range']} in-range, ${summary.byFixClass['out-of-range']} range bump); ` +
      `${summary.byFixClass.major} major, ${summary.byFixClass['no-auto-fix']} with no automatic npm fix — these need a decision.`,
  );

  if (!options.check && summary.actionable > 0) {
    console.log('');
    console.log('Start with `npm audit fix`, then re-run this scan.');
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const report = options.input
    ? validateAuditReport(
        readJson<unknown>(resolve(process.cwd(), options.input)),
        options.input,
      )
    : runNpmAudit();
  const manifest = readJson<PackageManifest>(join(repoRoot, 'package.json'));
  const lock = readJson<PackageLock>(join(repoRoot, 'package-lock.json'));

  const triage = classifyAuditReport(report, {
    manifest,
    lock,
    deployedImports: collectDeployedImports(),
  });
  const failures = gateFailures(triage, {
    minSeverity: options.minSeverity,
    strict: options.strict,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...triage,
          gate: {
            minSeverity: options.minSeverity,
            strict: options.strict,
            failing: failures.map((finding) => finding.package),
          },
        },
        null,
        2,
      ),
    );
  } else {
    renderTable(triage, options);
  }

  if (!options.check) return;

  if (failures.length === 0) {
    if (!options.json) {
      console.log('');
      console.log(
        `No mechanically fixable ${options.minSeverity}+ vulnerabilities. Gate passes.`,
      );
    }
    return;
  }

  if (!options.json) {
    // Under --strict the gate also fails on `major` and `no-auto-fix` findings,
    // which by definition have no mechanical remediation. Reporting those as
    // having "a known fix path" would send an operator hunting for a fix the
    // audit just said does not exist, so describe each group as what it is.
    const mechanical = failures.filter((finding) => finding.actionable);
    const decisions = failures.filter((finding) => !finding.actionable);
    const names = (group: AuditFinding[]) =>
      group.map((finding) => finding.package).join(', ');

    console.log('');
    if (mechanical.length > 0) {
      console.error(
        `${mechanical.length} ${options.minSeverity}+ vulnerabilit${mechanical.length === 1 ? 'y has' : 'ies have'} ` +
          `a known fix path: ${names(mechanical)}`,
      );
    }
    if (decisions.length > 0) {
      console.error(
        `${decisions.length} ${options.minSeverity}+ vulnerabilit${decisions.length === 1 ? 'y needs' : 'ies need'} ` +
          `a decision (breaking upgrade, or no fix npm can apply): ${names(decisions)}`,
      );
    }
  }
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
