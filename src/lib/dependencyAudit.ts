/**
 * Triage `npm audit --json` into a fix-path classification.
 *
 * GitHub's Dependabot alert list tells you *what* is vulnerable. It does not
 * tell you what it costs to fix, and that is the only question that decides
 * whether an alert can be cleared automatically. A high-severity DoS in a
 * transitive dev-only package that a lockfile bump resolves is a different
 * problem from the same severity in a shipped runtime dependency whose only
 * patched release is a major version. Both render identically in the alert
 * list, which is why nineteen of them accumulated.
 *
 * `npm audit` already knows the difference — it is encoded in the awkwardly
 * overloaded `fixAvailable` field — and `package-lock.json` knows whether a
 * package reaches production. This module joins the three sources into one
 * ranked list a maintainer (human or `agents/dependency-security-maintainer.md`)
 * can work top-down without re-deriving the fix path per advisory.
 *
 * Pure by design: no filesystem, no child processes, no network. The CLI in
 * `scripts/dependency-audit-scan.ts` shells out to npm and feeds the JSON in
 * here, so the classification stays unit-testable against recorded fixtures.
 */

export const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

/**
 * How much work the fix costs, derived from `fixAvailable`. Ordered by
 * escalating human involvement — `in-range` needs none, `no-auto-fix` needs a
 * decision.
 *
 * `no-auto-fix` is named for what npm actually reports, which is narrower than
 * "no patched release exists". Arborist returns `fixAvailable: false` as soon as
 * the dependency's spec is non-registry — a git URL, `file:`, `link:` — because
 * it cannot propose a registry replacement, whether or not a patched tag exists
 * upstream. Calling that class `unfixable` would hand the routine and the
 * operator a false reason to defer.
 */
export const FIX_CLASS_ORDER = ['in-range', 'out-of-range', 'major', 'no-auto-fix'] as const;

export type FixClass = (typeof FIX_CLASS_ORDER)[number];

/** Ordered by urgency: what runs in production first, what we cannot tell last. */
export const PRODUCTION_REACH_ORDER = ['ships', 'unknown', 'build-only'] as const;

export type ProductionReach = (typeof PRODUCTION_REACH_ORDER)[number];

/** An advisory object as it appears in a `via` array. */
export interface NpmAuditAdvisory {
  source: number;
  name: string;
  dependency: string;
  title: string;
  url: string;
  severity: Severity;
  cwe?: string[];
  cvss?: { score?: number; vectorString?: string };
  range: string;
}

/**
 * `fixAvailable` is three values in one field:
 *   `true`   — a version inside the currently declared range fixes it
 *   `false`  — npm has no automatic fix (usually unpatched, but also every
 *              non-registry spec — see `FIX_CLASS_ORDER`)
 *   object   — a manifest edit is required; `isSemVerMajor` says how painful
 */
export type NpmAuditFixAvailable =
  | boolean
  | { name: string; version: string; isSemVerMajor: boolean };

export interface NpmAuditVulnerability {
  name: string;
  severity: Severity;
  isDirect: boolean;
  /** Strings name another vulnerable package that drags this one in. */
  via: Array<string | NpmAuditAdvisory>;
  /** Packages that are themselves flagged *because* they depend on this one. */
  effects?: string[];
  range: string;
  nodes?: string[];
  fixAvailable: NpmAuditFixAvailable;
}

export interface NpmAuditReport {
  auditReportVersion?: number;
  vulnerabilities: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: Partial<Record<Severity, number>> & { total?: number };
    dependencies?: Record<string, number>;
  };
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

/** The `packages` map of a lockfile v2/v3. Only the fields we read. */
export interface PackageLock {
  packages?: Record<
    string,
    {
      version?: string;
      dev?: boolean;
      optional?: boolean;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
  >;
}

export interface TriagedAdvisory {
  id: number;
  title: string;
  url: string;
  severity: Severity;
  /** Union of the affected ranges npm reported for this advisory. */
  vulnerableRange: string;
  /** `null` when the advisory carries no CVSS score — npm encodes that as 0. */
  cvss: number | null;
  cwe: string[];
}

export interface AuditFinding {
  package: string;
  severity: Severity;
  fixClass: FixClass;
  /**
   * True when the fix path is mechanical: run `npm audit fix`, or bump one
   * declared range. These are the findings nobody needs to deliberate over,
   * and the ones `--check` fails on.
   */
  actionable: boolean;
  /** Declared in `dependencies`/`devDependencies`, per npm and the manifest. */
  direct: boolean;
  manifestScope: 'dependencies' | 'devDependencies' | null;
  /** Already pinned in `overrides` — an existing pin may be what holds it back. */
  overridden: boolean;
  /**
   * The manifest declares this package with a non-registry spec (git URL,
   * `file:`, `link:`, …). npm cannot propose a registry fix for those and
   * reports `fixAvailable: false` regardless of whether the upstream source has
   * a patched tag — so a `no-auto-fix` finding with this set is a "go look at
   * the source" signal, not a dead end. `false` when the spec is a normal
   * registry range or the package is not declared at all.
   */
  nonRegistrySpec: boolean;
  /**
   * Every copy in the lockfile is marked `dev`. This is npm's **installation
   * scope**, not runtime reach — see `productionReach`. `null` when no lockfile
   * was supplied or the package is absent from it.
   */
  devOnly: boolean | null;
  /**
   * This *install* is reachable from deployed source — either imported
   * directly, or pulled in through the dependency graph of something that is.
   * Matched on `vuln.nodes` paths, so a safe deployed copy elsewhere in the
   * tree does not vouch for a vulnerable dev-only one. `null` when no import
   * set was supplied.
   */
  reachableFromDeployedSource: boolean | null;
  /**
   * Whether the vulnerable code reaches production, which is the question the
   * ranking actually cares about. Derived from the lockfile scope *and* the
   * import graph, because neither alone is sufficient — see `resolveReach`.
   */
  productionReach: ProductionReach;
  vulnerableRange: string;
  /** Target version when a manifest edit is required, else `null`. */
  fixVersion: string | null;
  /**
   * The package the fix version belongs to. When a transitive vulnerability is
   * resolved by bumping the *parent* that pins it, npm names that parent here,
   * not the vulnerable leaf — so `fixPackage` and `package` can differ, and it
   * is `fixPackage` that a maintainer edits. `null` when no manifest edit is
   * required.
   */
  fixPackage: string | null;
  /** Direct dependencies that pull this package in, via npm's `effects` graph. */
  reachableVia: string[];
  advisories: TriagedAdvisory[];
}

export interface AuditTriage {
  findings: AuditFinding[];
  summary: {
    total: number;
    actionable: number;
    bySeverity: Record<Severity, number>;
    byFixClass: Record<FixClass, number>;
  };
}

// `Object.hasOwn` needs the ES2022 lib and this project targets ES2020; a bare
// `key in obj` would walk the prototype chain and call `constructor` a declared
// dependency. Both inputs are parsed JSON, so guard the own-property check.
function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * True for a declared spec npm resolves outside the registry — a git URL,
 * `file:`/`link:` path, tarball URL, or `workspace:` reference.
 *
 * Registry specs are semver ranges (`^1.2.3`), dist-tags (`latest`), or `npm:`
 * aliases; none of those carry a path separator or a non-`npm` protocol. This
 * is the condition under which npm reports `fixAvailable: false` for reasons
 * that have nothing to do with whether a patch exists.
 */
export function isNonRegistrySpec(spec: string | undefined): boolean {
  if (!spec) return false;
  if (spec.startsWith('npm:')) return false;
  return (
    /^[a-z+]+:/i.test(spec) ||
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.includes('/')
  );
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

export function atLeastSeverity(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) >= severityRank(threshold);
}

export function classifyFix(fixAvailable: NpmAuditFixAvailable): FixClass {
  if (fixAvailable === true) return 'in-range';
  // `false` means npm has no automatic remediation to offer — usually no
  // patched release, but also every non-registry spec. Do not read it as proof
  // that no fix exists anywhere.
  if (fixAvailable === false || fixAvailable == null) return 'no-auto-fix';
  return fixAvailable.isSemVerMajor ? 'major' : 'out-of-range';
}

/** `in-range` and `out-of-range` are mechanical; `major` and `no-auto-fix` are decisions. */
export function isActionable(fixClass: FixClass): boolean {
  return fixClass === 'in-range' || fixClass === 'out-of-range';
}

function advisoriesOf(vuln: NpmAuditVulnerability): TriagedAdvisory[] {
  const byAdvisory = new Map<string, TriagedAdvisory>();

  for (const via of vuln.via ?? []) {
    // A string entry is a pointer to another vulnerable package, not an
    // advisory — that relationship is already captured by `reachableVia`.
    if (typeof via === 'string') continue;

    // npm lists one GHSA once per affected release line, each with its own
    // `source` id: brace-expansion's GHSA-3jxr-9vmj-r5cp appears as 1123897
    // (`<1.1.16`) and 1123898 (`>=3.0.0 <5.0.7`). Those are one advisory to a
    // reader, so key on the advisory URL and union the ranges — keying on
    // `source` would print every finding twice.
    const key = via.url || `source:${via.source}`;
    const existing = byAdvisory.get(key);
    if (existing) {
      if (via.range && !existing.vulnerableRange.split(' || ').includes(via.range)) {
        existing.vulnerableRange = `${existing.vulnerableRange} || ${via.range}`;
      }
      existing.id = Math.min(existing.id, via.source);
      continue;
    }

    byAdvisory.set(key, {
      id: via.source,
      title: via.title,
      url: via.url,
      severity: via.severity,
      vulnerableRange: via.range,
      // npm writes `score: 0` for advisories published without a CVSS vector.
      // Reporting that as a real 0.0 score would rank a scoreless critical
      // below a scored low, so treat it as absent.
      cvss: typeof via.cvss?.score === 'number' && via.cvss.score > 0 ? via.cvss.score : null,
      cwe: via.cwe ?? [],
    });
  }

  return [...byAdvisory.values()].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id - b.id,
  );
}

/**
 * Walk npm's `effects` graph outward from `name` to the declared dependencies
 * that reach it. `effects` points *up* the tree (X's effects are the packages
 * flagged because they depend on X), so a breadth-first walk lands on the
 * direct dependencies a maintainer can actually edit.
 *
 * Returns `[]` for a deduped transitive package npm reports with no effects —
 * that is npm declining to say, not evidence of no dependents.
 */
function reachableDirectDeps(
  name: string,
  vulnerabilities: Record<string, NpmAuditVulnerability>,
  isDirect: (pkg: string) => boolean,
): string[] {
  const found = new Set<string>();
  const seen = new Set<string>([name]);
  const queue = [...(vulnerabilities[name]?.effects ?? [])];

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    if (isDirect(next)) found.add(next);
    queue.push(...(vulnerabilities[next]?.effects ?? []));
  }

  return [...found].sort();
}

/** Every lockfile path holding a copy of `name`, at any depth. */
function pathsByName(packages: Record<string, unknown>, name: string): string[] {
  const suffix = `node_modules/${name}`;
  // Match `node_modules/x` and any nested `.../node_modules/x`, but never
  // `node_modules/xyz` or `node_modules/x/node_modules/y`.
  return Object.keys(packages).filter(
    (path) => path === suffix || path.endsWith(`/${suffix}`),
  );
}

/**
 * True when every *vulnerable* copy of the package is flagged `dev` in the
 * lockfile, so the vulnerable code never ships to a user.
 *
 * Scope is decided from `vuln.nodes` — npm's list of the specific installations
 * the advisory applies to — not from every copy that shares the name. The
 * distinction matters whenever a tree holds two versions: a patched production
 * copy alongside a vulnerable dev-only one would otherwise be reported as
 * reaching production, which overstates the urgency of exactly the findings
 * this scan exists to rank. Falls back to a name-wide scan only when npm gave
 * no usable node paths.
 *
 * Returns `null` when nothing matched, so callers can distinguish "dev-only"
 * from "could not tell" — the two must never render the same.
 */
export function isDevOnly(
  lock: PackageLock | undefined,
  target: { name: string; nodes?: string[] },
): boolean | null {
  const packages = lock?.packages;
  if (!packages) return null;

  const declared = (target.nodes ?? []).filter((path) => hasOwn(packages, path));
  const paths = declared.length > 0 ? declared : pathsByName(packages, target.name);
  if (paths.length === 0) return null;

  return paths.every((path) => packages[path]?.dev === true);
}

/**
 * Sort weight for production reach: what ships first, what we could not
 * determine second, build-only last.
 *
 * `unknown` deliberately sorts *above* `build-only` rather than beside it. A
 * finding we could not classify might reach users, and ranking it as though it
 * were build-only would let the one case we understand least sink to the bottom
 * of a list the routine works top-down.
 */
function reachRank(finding: AuditFinding): number {
  return PRODUCTION_REACH_ORDER.indexOf(finding.productionReach);
}

function emptySeverityCounts(): Record<Severity, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

function emptyFixClassCounts(): Record<FixClass, number> {
  return { 'in-range': 0, 'out-of-range': 0, major: 0, 'no-auto-fix': 0 };
}

export interface ClassifyOptions {
  manifest?: PackageManifest;
  lock?: PackageLock;
  /**
   * Package names imported *directly* by source that runs in production — the
   * Vite-bundled SPA and the serverless API, excluding tests.
   * `scripts/dependency-audit-scan.ts` collects this from the filesystem; the
   * classifier stays pure and expands it through the lockfile graph itself.
   */
  deployedImports?: ReadonlySet<string>;
}

/**
 * Decide whether the vulnerable code reaches production.
 *
 * A lockfile `dev` flag records how npm installs a package, **not** whether a
 * bundler ships it. In this repo `lucide-react`, `clsx`, and `tailwind-merge`
 * are all declared in `devDependencies` and flagged `dev: true`, and all three
 * are imported by `src/` — so Vite bundles them into every user's browser.
 * Trusting the flag alone would label a genuinely user-facing advisory
 * `build-only` and, because reach is a sort key, rank it below findings that
 * actually matter less.
 *
 * So `build-only` requires both signals to agree: npm installs it as dev *and*
 * no deployed source imports it. Anything else we cannot prove is build-only
 * stays `unknown` rather than being quietly downgraded — including the case
 * where no import set was supplied at all.
 */
export function resolveReach(
  devOnly: boolean | null,
  reachableFromDeployedSource: boolean | null,
): ProductionReach {
  // A non-dev copy in the lockfile is proof enough on its own.
  if (devOnly === false) return 'ships';
  // Dev-flagged but reachable from deployed code: the flag describes how npm
  // installs the package, not what a bundler ships.
  if (reachableFromDeployedSource === true) return 'ships';
  if (devOnly === true && reachableFromDeployedSource === false) return 'build-only';
  return 'unknown';
}

/**
 * Resolve `name` as a dependency of the package installed at `fromPath`,
 * following npm's lookup order: the nearest `node_modules`, then outward.
 */
function resolveDependencyPath(
  packages: Record<string, unknown>,
  fromPath: string,
  name: string,
): string | null {
  const segments = fromPath === '' ? [] : fromPath.split('/');
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join('/');
    const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
    if (hasOwn(packages, candidate)) return candidate;
  }
  return null;
}

/** What a traversal from the deployed roots actually reaches. */
export interface DeployedReach {
  /**
   * Lockfile paths of the reached installs. Path-precise, because a name can
   * sit at several paths with different scoping — this lockfile already has
   * four such names (`entities`, `commander`, `js-tokens`, `whatwg-mimetype`),
   * each with one production copy and one dev-only copy.
   */
  paths: Set<string>;
  /** Names of the reached installs, for reports that carry no node paths. */
  names: Set<string>;
}

/**
 * Expand a set of directly-imported package names to everything those packages
 * pull in, by walking the lockfile's dependency graph.
 *
 * Without this, reach stops at the import statement. A deployed module that
 * imports `marked` would mark only `marked` as reaching production, while
 * `linkify-it` — the vulnerable package `marked` actually executes — stayed
 * whatever its lockfile `dev` flag said. The regex over source therefore only
 * establishes the *roots*; propagation is exact, straight out of the lockfile.
 *
 * Which edges count as runtime:
 *   - `dependencies` — always.
 *   - `optionalDependencies` — installed and executed when present.
 *   - `peerDependencies` — yes, unless marked optional in
 *     `peerDependenciesMeta`. A peer is resolved from elsewhere in the tree but
 *     is still `require`d at runtime by the package that declares it, so
 *     skipping peers lets a vulnerable copy installed in the dev-scoped tree
 *     read as `build-only` while deployed code executes it. Only peers of
 *     already-reached packages are followed, so this cannot pull in the peers
 *     of dev-only tooling.
 */
export function expandThroughDependencies(
  roots: ReadonlySet<string>,
  lock: PackageLock | undefined,
): DeployedReach {
  const names = new Set(roots);
  const paths = new Set<string>();
  const packages = lock?.packages;
  if (!packages) return { paths, names };

  const queue: string[] = [];
  for (const name of roots) {
    const path = `node_modules/${name}`;
    if (hasOwn(packages, path)) {
      queue.push(path);
      paths.add(path);
    }
  }

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined) continue;
    const entry = packages[path];

    const peerMeta = entry?.peerDependenciesMeta ?? {};
    const runtimePeers = Object.keys(entry?.peerDependencies ?? {}).filter(
      (peer) => peerMeta[peer]?.optional !== true,
    );
    const dependencies = [
      ...Object.keys(entry?.dependencies ?? {}),
      ...Object.keys(entry?.optionalDependencies ?? {}),
      ...runtimePeers,
    ];

    for (const dependency of dependencies) {
      const resolved = resolveDependencyPath(packages, path, dependency);
      if (resolved === null || paths.has(resolved)) continue;
      paths.add(resolved);
      names.add(dependency);
      queue.push(resolved);
    }
  }

  return { paths, names };
}

/**
 * Is *this* vulnerable install reachable from deployed code?
 *
 * Matches on the lockfile paths npm flagged as affected (`vuln.nodes`), not on
 * the package name. A name-level check would mark a vulnerable dev-only copy as
 * shipping whenever a *different*, safe copy of the same name sits under the
 * deployed subtree — the same duplicate-path trap that `isDevOnly` already
 * avoids. Falls back to the name only when the report carries no node paths.
 */
export function isReachableFromDeployed(
  reach: DeployedReach | undefined,
  target: { name: string; nodes?: string[] },
): boolean | null {
  if (!reach) return null;
  const nodes = target.nodes ?? [];
  if (nodes.length > 0) return nodes.some((node) => reach.paths.has(node));
  return reach.names.has(target.name);
}

/**
 * Join an audit report with the manifest and lockfile into a ranked triage.
 *
 * Ranking is by remediation urgency, not by severity alone: within a severity,
 * a mechanical fix sorts above one that needs a decision, so working the list
 * top-down clears the cheap alerts first.
 */
export function classifyAuditReport(
  report: NpmAuditReport,
  options: ClassifyOptions = {},
): AuditTriage {
  const { manifest, lock, deployedImports } = options;
  // The import scan supplies roots; the lockfile graph does the propagation.
  const deployedReach = deployedImports
    ? expandThroughDependencies(deployedImports, lock)
    : undefined;
  const vulnerabilities = report.vulnerabilities ?? {};
  const dependencies = manifest?.dependencies ?? {};
  const devDependencies = manifest?.devDependencies ?? {};
  const overrides = manifest?.overrides ?? {};

  const declaredDirect = (pkg: string): boolean =>
    hasOwn(dependencies, pkg) || hasOwn(devDependencies, pkg);
  // npm's `isDirect` and the manifest can disagree (a package declared only as
  // an override, or hoisted oddly); treat either signal as direct so nothing a
  // maintainer can edit gets filed as untouchable transitive depth.
  const isDirect = (pkg: string): boolean =>
    declaredDirect(pkg) || vulnerabilities[pkg]?.isDirect === true;

  const findings: AuditFinding[] = Object.values(vulnerabilities).map((vuln) => {
    const fixClass = classifyFix(vuln.fixAvailable);
    const devOnly = isDevOnly(lock, { name: vuln.name, nodes: vuln.nodes });
    const reachableFromDeployedSource = isReachableFromDeployed(deployedReach, {
      name: vuln.name,
      nodes: vuln.nodes,
    });
    const manifestFix =
      typeof vuln.fixAvailable === 'object' && vuln.fixAvailable !== null
        ? vuln.fixAvailable
        : null;

    return {
      package: vuln.name,
      severity: vuln.severity,
      fixClass,
      actionable: isActionable(fixClass),
      direct: isDirect(vuln.name),
      manifestScope: hasOwn(dependencies, vuln.name)
        ? 'dependencies'
        : hasOwn(devDependencies, vuln.name)
          ? 'devDependencies'
          : null,
      overridden: hasOwn(overrides, vuln.name),
      nonRegistrySpec: isNonRegistrySpec(
        dependencies[vuln.name] ?? devDependencies[vuln.name],
      ),
      devOnly,
      reachableFromDeployedSource,
      productionReach: resolveReach(devOnly, reachableFromDeployedSource),
      vulnerableRange: vuln.range,
      fixVersion: manifestFix?.version ?? null,
      fixPackage: manifestFix?.name ?? null,
      reachableVia: reachableDirectDeps(vuln.name, vulnerabilities, isDirect),
      advisories: advisoriesOf(vuln),
    };
  });

  findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      FIX_CLASS_ORDER.indexOf(a.fixClass) - FIX_CLASS_ORDER.indexOf(b.fixClass) ||
      reachRank(a) - reachRank(b) ||
      a.package.localeCompare(b.package),
  );

  const bySeverity = emptySeverityCounts();
  const byFixClass = emptyFixClassCounts();
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byFixClass[finding.fixClass] += 1;
  }

  return {
    findings,
    summary: {
      total: findings.length,
      actionable: findings.filter((f) => f.actionable).length,
      bySeverity,
      byFixClass,
    },
  };
}

export interface GateOptions {
  /** Ignore anything below this severity. Default `high`. */
  minSeverity?: Severity;
  /** Also fail on `major`/`no-auto-fix` findings, which normally need a human. */
  strict?: boolean;
}

/**
 * The findings a `--check` run fails on: at or above the severity threshold,
 * and mechanically fixable (or anything at all, under `--strict`).
 */
export function gateFailures(triage: AuditTriage, options: GateOptions = {}): AuditFinding[] {
  const { minSeverity = 'high', strict = false } = options;
  return triage.findings.filter(
    (finding) =>
      atLeastSeverity(finding.severity, minSeverity) && (strict || finding.actionable),
  );
}
