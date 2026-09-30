import { describe, expect, it } from 'vitest';
import {
  atLeastSeverity,
  classifyAuditReport,
  classifyFix,
  gateFailures,
  isDevOnly,
  expandThroughDependencies,
  isNonRegistrySpec,
  isReachableFromDeployed,
  resolveReach,
  type NpmAuditAdvisory,
  type NpmAuditReport,
  type NpmAuditVulnerability,
  type PackageLock,
} from './dependencyAudit';

function advisory(overrides: Partial<NpmAuditAdvisory> = {}): NpmAuditAdvisory {
  return {
    source: 1123897,
    name: 'brace-expansion',
    dependency: 'brace-expansion',
    title: 'brace-expansion: DoS via exponential-time expansion',
    url: 'https://github.com/advisories/GHSA-3jxr-9vmj-r5cp',
    severity: 'high',
    cwe: ['CWE-400'],
    cvss: { score: 5.3, vectorString: 'CVSS:3.1/AV:N' },
    range: '<1.1.16',
    ...overrides,
  };
}

function vuln(overrides: Partial<NpmAuditVulnerability> = {}): NpmAuditVulnerability {
  return {
    name: 'brace-expansion',
    severity: 'high',
    isDirect: false,
    via: [advisory()],
    effects: [],
    range: '<=1.1.17',
    fixAvailable: true,
    ...overrides,
  } as NpmAuditVulnerability;
}

function report(...vulns: NpmAuditVulnerability[]): NpmAuditReport {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(vulns.map((v) => [v.name, v])),
  };
}

describe('classifyFix', () => {
  it('maps the three shapes of fixAvailable onto fix classes', () => {
    expect(classifyFix(true)).toBe('in-range');
    expect(classifyFix(false)).toBe('no-auto-fix');
    expect(classifyFix({ name: 'postcss', version: '8.5.25', isSemVerMajor: false })).toBe(
      'out-of-range',
    );
    expect(classifyFix({ name: 'vite', version: '9.0.0', isSemVerMajor: true })).toBe('major');
  });
});

describe('isNonRegistrySpec', () => {
  it('accepts the spec forms npm resolves from the registry', () => {
    for (const spec of ['^1.2.3', '~2.0.0', '1.x', '*', 'latest', 'npm:other@^1.0.0', '>=8 <9']) {
      expect(isNonRegistrySpec(spec)).toBe(false);
    }
  });

  it('flags the spec forms that make npm report fixAvailable: false regardless of patches', () => {
    for (const spec of [
      'git+https://github.com/o/r.git#v1.2.3',
      'github:owner/repo',
      'file:../local-pkg',
      'link:../local-pkg',
      'https://example.test/pkg.tgz',
      'workspace:*',
    ]) {
      expect(isNonRegistrySpec(spec)).toBe(true);
    }
  });

  it('is false for an undeclared package', () => {
    expect(isNonRegistrySpec(undefined)).toBe(false);
  });
});

describe('resolveReach', () => {
  it('ships when the lockfile has a non-dev copy', () => {
    expect(resolveReach(false, false)).toBe('ships');
    expect(resolveReach(false, null)).toBe('ships');
  });

  it('ships when deployed source imports it, whatever the lockfile dev flag says', () => {
    // The real case: lucide-react, clsx and tailwind-merge are devDependencies
    // flagged `dev: true`, and Vite bundles all three into the browser. Trusting
    // the flag alone would rank a user-facing advisory as build-only.
    expect(resolveReach(true, true)).toBe('ships');
  });

  it('is build-only only when both signals agree', () => {
    expect(resolveReach(true, false)).toBe('build-only');
  });

  it('refuses to claim build-only from the dev flag alone', () => {
    // No import set supplied — we cannot rule out that a bundler ships it.
    expect(resolveReach(true, null)).toBe('unknown');
  });

  it('is unknown when the lockfile says nothing', () => {
    expect(resolveReach(null, null)).toBe('unknown');
    expect(resolveReach(null, false)).toBe('unknown');
  });
});

describe('expandThroughDependencies', () => {
  const lock: PackageLock = {
    packages: {
      '': { version: '1.0.0' },
      'node_modules/marked': { version: '18.0.4', dependencies: { 'linkify-it': '^5.0.0' } },
      'node_modules/linkify-it': { version: '5.0.1', dependencies: { uc: '^1.0.0' } },
      'node_modules/uc': { version: '1.0.0' },
      'node_modules/eslint': { version: '9.17.0', dev: true, dependencies: { minimatch: '^9' } },
      'node_modules/minimatch': { version: '9.0.0', dev: true },
      // A nested copy that must win over the hoisted one for its own parent.
      'node_modules/vite': { version: '8.0.16', dependencies: { postcss: '^8' } },
      'node_modules/vite/node_modules/postcss': { version: '8.5.25' },
      'node_modules/postcss': { version: '8.5.12', dev: true },
    },
  };

  it('reaches transitive children of an imported package', () => {
    // The import scan only ever sees `marked`; linkify-it is the vulnerable one.
    const reached = expandThroughDependencies(new Set(['marked']), lock);
    expect(reached.names.has('marked')).toBe(true);
    expect(reached.names.has('linkify-it')).toBe(true);
    expect(reached.names.has('uc')).toBe(true);
  });

  it('does not reach packages outside the imported subtree', () => {
    const reached = expandThroughDependencies(new Set(['marked']), lock);
    expect(reached.names.has('eslint')).toBe(false);
    expect(reached.names.has('minimatch')).toBe(false);
  });

  it('records the exact install path reached, not just the name', () => {
    const reached = expandThroughDependencies(new Set(['vite']), lock);
    // vite pins its own copy; the hoisted dev-only postcss must NOT be reached.
    expect(reached.paths.has('node_modules/vite/node_modules/postcss')).toBe(true);
    expect(reached.paths.has('node_modules/postcss')).toBe(false);
  });

  it('follows non-optional peer dependencies', () => {
    const peered: PackageLock = {
      packages: {
        'node_modules/host': {
          version: '1.0.0',
          peerDependencies: { runtimePeer: '^1', optionalPeer: '^1' },
          peerDependenciesMeta: { optionalPeer: { optional: true } },
        },
        'node_modules/runtimePeer': { version: '1.0.0', dev: true },
        'node_modules/optionalPeer': { version: '1.0.0', dev: true },
      },
    };
    const reached = expandThroughDependencies(new Set(['host']), peered);
    // A peer is resolved elsewhere in the tree but still required at runtime.
    expect(reached.names.has('runtimePeer')).toBe(true);
    expect(reached.names.has('optionalPeer')).toBe(false);
  });

  it('returns the roots unchanged when there is no lockfile', () => {
    expect([...expandThroughDependencies(new Set(['marked']), undefined).names]).toEqual([
      'marked',
    ]);
  });

  it('terminates on a dependency cycle', () => {
    const cyclic: PackageLock = {
      packages: {
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^1' } },
        'node_modules/b': { version: '1.0.0', dependencies: { a: '^1' } },
      },
    };
    expect([...expandThroughDependencies(new Set(['a']), cyclic).names].sort()).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('isReachableFromDeployed', () => {
  const reach = {
    paths: new Set(['node_modules/marked', 'node_modules/marked/node_modules/entities']),
    names: new Set(['marked', 'entities']),
  };

  it('matches on the vulnerable install path, not the shared name', () => {
    // The deployed copy of `entities` is safe and reached; the vulnerable one
    // sits in the dev tree. A name-level check would call this shipped.
    expect(
      isReachableFromDeployed(reach, { name: 'entities', nodes: ['node_modules/entities'] }),
    ).toBe(false);
    expect(
      isReachableFromDeployed(reach, {
        name: 'entities',
        nodes: ['node_modules/marked/node_modules/entities'],
      }),
    ).toBe(true);
  });

  it('falls back to the name when the report carries no node paths', () => {
    expect(isReachableFromDeployed(reach, { name: 'entities' })).toBe(true);
    expect(isReachableFromDeployed(reach, { name: 'eslint' })).toBe(false);
  });

  it('is null when no import set was supplied', () => {
    expect(isReachableFromDeployed(undefined, { name: 'marked' })).toBeNull();
  });
});

describe('atLeastSeverity', () => {
  it('orders severities from info up to critical', () => {
    expect(atLeastSeverity('critical', 'high')).toBe(true);
    expect(atLeastSeverity('high', 'high')).toBe(true);
    expect(atLeastSeverity('moderate', 'high')).toBe(false);
    expect(atLeastSeverity('low', 'info')).toBe(true);
  });
});

describe('isDevOnly', () => {
  const lock: PackageLock = {
    packages: {
      '': { version: '1.0.0' },
      'node_modules/brace-expansion': { version: '1.1.11', dev: true },
      'node_modules/eslint/node_modules/brace-expansion': { version: '2.0.1', dev: true },
      'node_modules/react-router': { version: '7.16.0' },
      'node_modules/postcss': { version: '8.5.12', dev: true },
      'node_modules/vite/node_modules/postcss': { version: '8.5.12' },
      // Deliberately similar names that must not match `postcss`.
      'node_modules/postcss-selector-parser': { version: '7.0.0', dev: true },
    },
  };

  it('is true when every copy in the tree is a dev dependency', () => {
    expect(isDevOnly(lock, { name: 'brace-expansion' })).toBe(true);
  });

  it('is false when any copy reaches production', () => {
    expect(isDevOnly(lock, { name: 'react-router' })).toBe(false);
    // postcss is a devDependency, but vite pulls a production copy too.
    expect(isDevOnly(lock, { name: 'postcss' })).toBe(false);
  });

  it('does not match packages that merely share a name prefix', () => {
    expect(isDevOnly(lock, { name: 'postcs' })).toBeNull();
  });

  it('is null when the package is absent or no lockfile was supplied', () => {
    expect(isDevOnly(lock, { name: 'undici' })).toBeNull();
    expect(isDevOnly(undefined, { name: 'brace-expansion' })).toBeNull();
    expect(isDevOnly({}, { name: 'brace-expansion' })).toBeNull();
  });

  it('judges scope from the vulnerable installs, not every copy of the name', () => {
    // Only the dev copy is vulnerable; the production copy is already patched.
    // Scanning by name alone would call this production-reaching and overstate
    // how urgent it is.
    expect(
      isDevOnly(lock, { name: 'postcss', nodes: ['node_modules/postcss'] }),
    ).toBe(true);
    expect(
      isDevOnly(lock, { name: 'postcss', nodes: ['node_modules/vite/node_modules/postcss'] }),
    ).toBe(false);
    expect(
      isDevOnly(lock, {
        name: 'postcss',
        nodes: ['node_modules/postcss', 'node_modules/vite/node_modules/postcss'],
      }),
    ).toBe(false);
  });

  it('falls back to a name scan when the node paths are missing from the lockfile', () => {
    expect(
      isDevOnly(lock, { name: 'brace-expansion', nodes: ['node_modules/nowhere/brace-expansion'] }),
    ).toBe(true);
    expect(isDevOnly(lock, { name: 'brace-expansion', nodes: [] })).toBe(true);
  });
});

describe('classifyAuditReport', () => {
  it('collapses one GHSA listed under several source ids into a single advisory', () => {
    // npm files the same advisory once per affected release line, each with its
    // own `source` id — the real brace-expansion report looks exactly like this.
    const triage = classifyAuditReport(
      report(
        vuln({
          via: [
            advisory({ source: 1123897, range: '<1.1.16' }),
            advisory({ source: 1123898, range: '>=3.0.0 <5.0.7' }),
            advisory({
              source: 1130588,
              title: 'brace-expansion: DoS via unbounded expansion length',
              url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
              range: '<1.1.17',
            }),
          ],
        }),
      ),
    );

    const advisories = triage.findings[0]?.advisories ?? [];
    expect(advisories.map((a) => a.url)).toEqual([
      'https://github.com/advisories/GHSA-3jxr-9vmj-r5cp',
      'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
    ]);
    // Both affected lines survive the merge, under the lowest source id.
    expect(advisories[0]?.vulnerableRange).toBe('<1.1.16 || >=3.0.0 <5.0.7');
    expect(advisories[0]?.id).toBe(1123897);
  });

  it('treats a zero CVSS score as no score rather than a real 0.0', () => {
    const triage = classifyAuditReport(
      report(
        vuln({
          via: [
            advisory({ source: 1, url: 'https://example.test/a', cvss: { score: 0 } }),
            advisory({ source: 2, url: 'https://example.test/b', cvss: { score: 7.5 } }),
          ],
        }),
      ),
    );

    const advisories = triage.findings[0]?.advisories ?? [];
    expect(advisories.find((a) => a.url === 'https://example.test/a')?.cvss).toBeNull();
    expect(advisories.find((a) => a.url === 'https://example.test/b')?.cvss).toBe(7.5);
  });

  it('ignores string via entries, which point at packages rather than advisories', () => {
    const triage = classifyAuditReport(
      report(vuln({ name: 'react-router-dom', severity: 'moderate', via: ['react-router'] })),
    );

    expect(triage.findings[0]?.advisories).toEqual([]);
  });

  it('resolves the direct dependencies that reach a transitive package', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'react-router', severity: 'high', effects: ['react-router-dom'] }),
        vuln({
          name: 'react-router-dom',
          severity: 'moderate',
          isDirect: true,
          via: ['react-router'],
          effects: [],
        }),
      ),
      { manifest: { dependencies: { 'react-router-dom': '^7.16.0' } } },
    );

    const routerFinding = triage.findings.find((f) => f.package === 'react-router');
    expect(routerFinding?.reachableVia).toEqual(['react-router-dom']);
    expect(routerFinding?.direct).toBe(false);

    const domFinding = triage.findings.find((f) => f.package === 'react-router-dom');
    expect(domFinding?.direct).toBe(true);
    expect(domFinding?.manifestScope).toBe('dependencies');
  });

  it('walks multi-hop effect chains without looping on cycles', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'leaf', effects: ['middle'] }),
        vuln({ name: 'middle', effects: ['root', 'leaf'] }),
        vuln({ name: 'root', isDirect: true, effects: ['middle'] }),
      ),
      { manifest: { devDependencies: { root: '^1.0.0' } } },
    );

    expect(triage.findings.find((f) => f.package === 'leaf')?.reachableVia).toEqual(['root']);
  });

  it('does not call a non-registry dependency unfixable', () => {
    // npm returns fixAvailable: false for any non-registry spec, patched
    // upstream or not. The finding must carry that distinction so the routine
    // does not defer on a fix that exists.
    const triage = classifyAuditReport(
      report(vuln({ name: 'vendored-lib', isDirect: true, fixAvailable: false })),
      { manifest: { dependencies: { 'vendored-lib': 'git+https://example.test/r.git#v1' } } },
    );

    const finding = triage.findings[0];
    expect(finding?.fixClass).toBe('no-auto-fix');
    expect(finding?.nonRegistrySpec).toBe(true);
  });

  it('leaves nonRegistrySpec false for an ordinary registry range', () => {
    const triage = classifyAuditReport(
      report(vuln({ name: 'dompurify', isDirect: true, fixAvailable: false })),
      { manifest: { dependencies: { dompurify: '^3.4.9' } } },
    );

    expect(triage.findings[0]?.nonRegistrySpec).toBe(false);
  });

  it('flags packages already pinned through overrides', () => {
    const triage = classifyAuditReport(report(vuln({ name: 'esbuild', fixAvailable: false })), {
      manifest: { overrides: { esbuild: '^0.28.1' } },
    });

    const finding = triage.findings[0];
    expect(finding?.overridden).toBe(true);
    expect(finding?.fixClass).toBe('no-auto-fix');
    expect(finding?.actionable).toBe(false);
  });

  it('records the target version when the fix needs a manifest edit', () => {
    const triage = classifyAuditReport(
      report(
        vuln({
          name: 'postcss',
          isDirect: true,
          fixAvailable: { name: 'postcss', version: '8.5.25', isSemVerMajor: false },
        }),
      ),
    );

    expect(triage.findings[0]?.fixVersion).toBe('8.5.25');
    expect(triage.findings[0]?.fixPackage).toBe('postcss');
    expect(triage.findings[0]?.fixClass).toBe('out-of-range');
  });

  it('keeps the parent package name when the fix is a bump one level up', () => {
    // npm resolves a vulnerable leaf by bumping whichever package pins it, and
    // names that parent in `fixAvailable`. Dropping the name would tell a
    // maintainer to bump `linkify-it` to markdown-it's version.
    const triage = classifyAuditReport(
      report(
        vuln({
          name: 'linkify-it',
          isDirect: false,
          fixAvailable: { name: 'markdown-it', version: '14.1.0', isSemVerMajor: false },
        }),
      ),
    );

    expect(triage.findings[0]?.package).toBe('linkify-it');
    expect(triage.findings[0]?.fixPackage).toBe('markdown-it');
    expect(triage.findings[0]?.fixVersion).toBe('14.1.0');
  });

  it('leaves the fix target null when npm reports an in-range fix', () => {
    const triage = classifyAuditReport(report(vuln()));
    expect(triage.findings[0]?.fixVersion).toBeNull();
    expect(triage.findings[0]?.fixPackage).toBeNull();
  });

  it('ranks by severity first, then by how mechanical the fix is', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'a-major', severity: 'high', fixAvailable: { name: 'a-major', version: '2.0.0', isSemVerMajor: true } }),
        vuln({ name: 'b-in-range', severity: 'high', fixAvailable: true }),
        vuln({ name: 'c-critical', severity: 'critical', fixAvailable: false }),
        vuln({ name: 'd-low', severity: 'low', fixAvailable: true }),
      ),
    );

    expect(triage.findings.map((f) => f.package)).toEqual([
      'c-critical',
      'b-in-range',
      'a-major',
      'd-low',
    ]);
  });

  it('ranks production-reaching findings ahead of build-only ones', () => {
    // Same severity and fix class, so reach is the only thing left to sort on.
    // Alphabetical order would put the dev-only package first and contradict
    // DEPENDENCY_AUDIT.md's "not ahead of anything that ships".
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'a-dev', nodes: ['node_modules/a-dev'] }),
        vuln({ name: 'z-prod', nodes: ['node_modules/z-prod'] }),
      ),
      {
        lock: {
          packages: {
            'node_modules/a-dev': { version: '1.0.0', dev: true },
            'node_modules/z-prod': { version: '1.0.0' },
          },
        },
        deployedImports: new Set<string>(),
      },
    );

    expect(triage.findings.map((f) => f.package)).toEqual(['z-prod', 'a-dev']);
  });

  it('ranks unclassifiable reach above dev-only, not beside it', () => {
    // "Could not tell" might ship; it must not sink below what we know is
    // build-only just because the lockfile had nothing to say.
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'a-dev', nodes: ['node_modules/a-dev'] }),
        vuln({ name: 'b-unknown', nodes: ['node_modules/b-unknown'] }),
        vuln({ name: 'c-prod', nodes: ['node_modules/c-prod'] }),
      ),
      {
        lock: {
          packages: {
            'node_modules/a-dev': { version: '1.0.0', dev: true },
            'node_modules/c-prod': { version: '1.0.0' },
          },
        },
        deployedImports: new Set<string>(),
      },
    );

    expect(triage.findings.map((f) => f.package)).toEqual(['c-prod', 'b-unknown', 'a-dev']);
  });

  it('keeps severity and fix class ahead of production reach', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'dev-high-inrange', severity: 'high', nodes: ['node_modules/dev-high-inrange'] }),
        vuln({
          name: 'prod-high-major',
          severity: 'high',
          nodes: ['node_modules/prod-high-major'],
          fixAvailable: { name: 'prod-high-major', version: '9.0.0', isSemVerMajor: true },
        }),
        vuln({ name: 'prod-low', severity: 'low', nodes: ['node_modules/prod-low'] }),
      ),
      {
        lock: {
          packages: {
            'node_modules/dev-high-inrange': { version: '1.0.0', dev: true },
            'node_modules/prod-high-major': { version: '1.0.0' },
            'node_modules/prod-low': { version: '1.0.0' },
          },
        },
        deployedImports: new Set<string>(),
      },
    );

    // A dev-only high with a mechanical fix still outranks a production high
    // that needs a breaking upgrade, and both outrank a production low.
    expect(triage.findings.map((f) => f.package)).toEqual([
      'dev-high-inrange',
      'prod-high-major',
      'prod-low',
    ]);
  });

  it('summarises counts by severity and fix class', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'a', severity: 'high', fixAvailable: true }),
        vuln({ name: 'b', severity: 'moderate', fixAvailable: false }),
        vuln({ name: 'c', severity: 'high', fixAvailable: { name: 'c', version: '3.0.0', isSemVerMajor: true } }),
      ),
    );

    expect(triage.summary.total).toBe(3);
    expect(triage.summary.actionable).toBe(1);
    expect(triage.summary.bySeverity.high).toBe(2);
    expect(triage.summary.bySeverity.moderate).toBe(1);
    expect(triage.summary.byFixClass['in-range']).toBe(1);
    expect(triage.summary.byFixClass['no-auto-fix']).toBe(1);
    expect(triage.summary.byFixClass.major).toBe(1);
  });

  it('handles an empty report', () => {
    const triage = classifyAuditReport({ vulnerabilities: {} });
    expect(triage.findings).toEqual([]);
    expect(triage.summary.total).toBe(0);
    expect(triage.summary.actionable).toBe(0);
  });

  it('marks devOnly from the lockfile without defaulting unknowns to true', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'brace-expansion', nodes: ['node_modules/brace-expansion'] }),
        vuln({ name: 'undici', severity: 'moderate', nodes: ['node_modules/undici'] }),
      ),
      {
        lock: { packages: { 'node_modules/brace-expansion': { version: '1.1.11', dev: true } } },
      },
    );

    expect(triage.findings.find((f) => f.package === 'brace-expansion')?.devOnly).toBe(true);
    expect(triage.findings.find((f) => f.package === 'undici')?.devOnly).toBeNull();
  });

  it('promotes a dev-flagged transitive child of an imported package', () => {
    // Deployed source imports `marked`; the advisory is against `linkify-it`,
    // which the import scan never sees and whose lockfile copy is dev-flagged.
    const triage = classifyAuditReport(
      report(vuln({ name: 'linkify-it', nodes: ['node_modules/linkify-it'] })),
      {
        lock: {
          packages: {
            'node_modules/marked': { version: '18.0.4', dependencies: { 'linkify-it': '^5' } },
            'node_modules/linkify-it': { version: '5.0.1', dev: true },
          },
        },
        deployedImports: new Set(['marked']),
      },
    );

    const finding = triage.findings[0];
    expect(finding?.devOnly).toBe(true);
    expect(finding?.reachableFromDeployedSource).toBe(true);
    expect(finding?.productionReach).toBe('ships');
  });

  it('promotes a dev-flagged package that deployed source imports', () => {
    const triage = classifyAuditReport(
      report(
        vuln({ name: 'lucide-react', nodes: ['node_modules/lucide-react'] }),
        vuln({ name: 'brace-expansion', nodes: ['node_modules/brace-expansion'] }),
      ),
      {
        manifest: { devDependencies: { 'lucide-react': '^0.469.0' } },
        lock: {
          packages: {
            'node_modules/lucide-react': { version: '0.469.0', dev: true },
            'node_modules/brace-expansion': { version: '1.1.11', dev: true },
          },
        },
        deployedImports: new Set(['lucide-react']),
      },
    );

    const bundled = triage.findings.find((f) => f.package === 'lucide-react');
    // Same lockfile dev flag, opposite reach — and the bundled one sorts first.
    expect(bundled?.devOnly).toBe(true);
    expect(bundled?.reachableFromDeployedSource).toBe(true);
    expect(bundled?.productionReach).toBe('ships');
    expect(triage.findings.find((f) => f.package === 'brace-expansion')?.productionReach).toBe(
      'build-only',
    );
    expect(triage.findings[0]?.package).toBe('lucide-react');
  });
});

describe('gateFailures', () => {
  const triage = classifyAuditReport(
    report(
      vuln({ name: 'high-in-range', severity: 'high', fixAvailable: true }),
      vuln({ name: 'high-major', severity: 'high', fixAvailable: { name: 'high-major', version: '9.0.0', isSemVerMajor: true } }),
      vuln({ name: 'moderate-in-range', severity: 'moderate', fixAvailable: true }),
      vuln({ name: 'low-no-auto-fix', severity: 'low', fixAvailable: false }),
    ),
  );

  it('fails only on mechanically fixable findings at or above the threshold', () => {
    expect(gateFailures(triage).map((f) => f.package)).toEqual(['high-in-range']);
  });

  it('honours a lower severity threshold', () => {
    expect(gateFailures(triage, { minSeverity: 'moderate' }).map((f) => f.package)).toEqual([
      'high-in-range',
      'moderate-in-range',
    ]);
  });

  it('includes decision-required findings under strict', () => {
    expect(gateFailures(triage, { strict: true }).map((f) => f.package)).toEqual([
      'high-in-range',
      'high-major',
    ]);
  });
});
