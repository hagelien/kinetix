/**
 * Phase 14: do the package boundaries actually hold?
 *
 * §14 splits the extracted repository into `core`, `postgres`, `http` and
 * `agent-sdk`, each with a dependency rule. Extracting first and discovering
 * the rules do not hold is the expensive order to find out, so this checks them
 * against the code as it stands — statically, from the import graph.
 *
 * `core` has since left: it is `assurance-core` on npm, and Kinetix consumes it
 * as a dependency rather than owning a copy. That changes what this file can
 * check about it and what checking is worth. The graph of the core's own source
 * is guarded by the package's purity suite, in its repository. What Kinetix can
 * still establish — and does, below — is that the artifact it actually installs
 * has the shape the boundary claims: no dependencies, no host vocabulary on its
 * surface, and nothing reaching outside itself in the code that ships.
 *
 * The remaining three boundaries are still directories here, and still checked
 * the original way.
 *
 * ## The finding
 *
 * `core` is clean, and now demonstrably so from outside. `postgres` is not, and
 * the reason is one import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from 'assurance-core';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(abs, e.name));
}

/**
 * The core's *shipped* JavaScript — `node_modules/assurance-core/dist/*.js`.
 *
 * Deliberately the build rather than the package's source: what a consumer runs
 * is what was published, and a `files` or `tsconfig` mistake that let something
 * extra into the tarball would be invisible to a check on the source tree. The
 * throw makes a missing install a failure rather than an empty loop.
 */
function shippedCore(): string[] {
  const dist = path.join(ROOT, 'node_modules/assurance-core/dist');
  if (!fs.existsSync(dist)) {
    throw new Error('assurance-core is not installed; run `npm install`');
  }
  const files = fs
    .readdirSync(dist)
    .filter((n) => n.endsWith('.js'))
    .map((n) => path.join(dist, n));
  if (files.length === 0) throw new Error('assurance-core shipped no JavaScript');
  return files;
}

function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
}

describe('package `core` — now a published dependency, not a directory here', () => {
  // The core used to live at `src/lib/knowledge-governance/`, and this block
  // checked its import graph directly. It is now `assurance-core` on npm, and
  // its own purity suite guards the source. What is still Kinetix's business —
  // and what these assertions cover — is the shape of the dependency as this
  // repository consumes it.
  //
  // `sourceFiles()` returns [] for a directory that does not exist, so simply
  // repointing the old loops at the vanished path would have turned every
  // assertion into a vacuous pass. Each check below therefore asserts against
  // something that demonstrably exists, and says so.

  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };

  const installed = path.join(ROOT, 'node_modules/assurance-core');

  it('is declared as a direct dependency, at a pinned major', () => {
    expect(manifest.dependencies?.['assurance-core']).toMatch(/^\^?0\./);
  });

  it('ships zero runtime dependencies of its own', () => {
    // The property that makes the package worth depending on: taking it costs
    // one entry in the lockfile, not a subtree. If that ever stops being true,
    // Kinetix's dependency surface grows silently on an `npm update`, and this
    // is the only place that would notice.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it.each(['drizzle-orm', 'node:crypto', 'react', 'zod', '@neondatabase/serverless'])(
    'the shipped build does not import %s',
    (dependency) => {
      const specs = shippedCore().flatMap((f) => importsOf(f));
      expect(specs).not.toContain(dependency);
    },
  );

  it('the shipped build imports nothing outside itself', () => {
    for (const file of shippedCore()) {
      for (const spec of importsOf(file)) {
        expect(spec, `${path.basename(file)} imports ${spec}`).toMatch(/^\.\//);
      }
    }
  });

  it('exports no Kinetix projection', () => {
    // `kinetix/` was the host projection sitting next to the core, and the old
    // assertion was that the barrel did not re-export it. The split makes that
    // structurally impossible, so the check moves to the surface itself: no
    // exported name may carry host vocabulary.
    for (const name of Object.keys(core)) {
      expect(name.toLowerCase(), `package exports ${name}`).not.toMatch(
        /kinetix|drug|pharma/,
      );
    }
  });
});

describe('Kinetix host layer — pure, and the only place Kinetix policy lives', () => {
  // `src/lib/assurance/` is what stayed behind: the Kinetix policy and the
  // projection of an AssuranceProfile onto a 0–3 verification level. It is as
  // pure as the core — no database, no React — but unlike the core it is
  // *allowed* to name drugs and roles, because that is its entire job.
  const HOST = 'src/lib/assurance';

  it('has files to check', () => {
    // Non-vacuity: every assertion below iterates this list.
    expect(sourceFiles(HOST).length).toBeGreaterThanOrEqual(3);
  });

  it('imports only the core package and its own siblings', () => {
    for (const file of sourceFiles(HOST)) {
      for (const spec of importsOf(file)) {
        expect(spec, `${path.basename(file)} imports ${spec}`).toMatch(
          /^(assurance-core|\.\/|\.\.\/verificationLevel\.js$)/,
        );
      }
    }
  });

  it.each(['drizzle-orm', 'react', '@neondatabase/serverless'])(
    'does not depend on %s',
    (dependency) => {
      expect(sourceFiles(HOST).flatMap(importsOf)).not.toContain(dependency);
    },
  );
});

describe('package `postgres` — schema, store, reconciliation, no Kinetix tables', () => {
  const STORE = 'api/_lib/knowledge-governance/store';

  it('depends only on drizzle, the core, the governance schema and the db handle', () => {
    const external = sourceFiles(STORE)
      .flatMap(importsOf)
      .filter((s) => !s.startsWith('./'));
    for (const spec of new Set(external)) {
      expect(spec).toMatch(
        /^(assurance-core|drizzle-orm|\.\.\/\.\.\/db\.js|\.\.\/\.\.\/\.\.\/\.\.\/db\/governance-schema\.js)$/,
      );
    }
  });

  it('imports the governance schema, not the Kinetix one', () => {
    // Previously the blocker: the store read its tables from `db/schema.ts`,
    // which defines `kgProposals` alongside `drugs` and `wikiPages`, so
    // extracting it would have dragged the whole pharmacology schema into a
    // package whose rule is "no Kinetix tables". The definitions now live in
    // `db/governance-schema.ts`.
    const specs = sourceFiles(STORE).flatMap(importsOf);
    expect(specs.some((s) => s.endsWith('db/governance-schema.js'))).toBe(true);
    expect(specs.some((s) => s.endsWith('db/schema.js'))).toBe(false);
  });

  it('the governance schema references no Kinetix table', () => {
    // What made the split possible, and worth asserting so it stays true:
    // actors are referenced as strings (`user:42`), never by foreign key, so no
    // kg_* table points at `users` — or at anything else Kinetix owns.
    const source = fs.readFileSync(
      path.join(ROOT, 'db/governance-schema.ts'),
      'utf8',
    );
    const references = [...source.matchAll(/=> (\w+)\./g)].map((m) => m[1]!);
    expect(references.length).toBeGreaterThan(0);
    for (const table of new Set(references)) {
      expect(table, `kg_* references ${table}`).toMatch(/^kg[A-Z]/);
    }
  });

  it('never imports back from the Kinetix schema', () => {
    // The dependency runs one way. A back-reference would quietly restore the
    // coupling the split removed.
    const specs = importsOf(path.join(ROOT, 'db/governance-schema.ts'));
    for (const spec of specs) {
      expect(spec).not.toMatch(/schema\.js$/);
    }
  });

  it('keeps every existing importer of db/schema.ts working', () => {
    // The split is invisible to the rest of Kinetix: `schema.ts` re-exports
    // everything, so no route had to change.
    const schema = fs.readFileSync(path.join(ROOT, 'db/schema.ts'), 'utf8');
    expect(schema).toContain("export * from './governance-schema.js'");
  });
});

describe('package `agent-sdk` — no model-vendor dependency', () => {
  const SDK = 'api/_lib/knowledge-governance/sdk';

  it.each(['openai', '@anthropic-ai/sdk', 'anthropic', '@google/generative-ai'])(
    'does not depend on %s',
    (vendor) => {
      const all = sourceFiles(SDK).flatMap(importsOf);
      expect(all).not.toContain(vendor);
    },
  );

  it('does not name a model vendor anywhere in its source', () => {
    // §14: "no model-vendor dependency". The SDK talks about actors, and an
    // actor's model is the host's business.
    for (const file of sourceFiles(SDK)) {
      const body = fs.readFileSync(file, 'utf8').toLowerCase();
      for (const vendor of ['openai', 'gpt-', 'gemini', 'llama']) {
        expect(body, `${path.basename(file)} mentions ${vendor}`).not.toContain(
          vendor,
        );
      }
    }
  });
});

describe('package naming', () => {
  it('bakes neither Kinetix nor pharmacology into a core symbol', () => {
    // §14: "Avoid baking 'Kinetix' or 'drug' into package names." The same
    // applies to what the package exports — a `KinetixPolicy` in `core` would
    // be the name problem one level down.
    //
    // Read from the shipped type declarations rather than the runtime
    // namespace: the runtime one omits interfaces and type aliases, which is
    // most of the surface a consumer actually writes against, and a
    // `DrugRiskProfile` type would slip through unnamed.
    const declared = fs
      .readFileSync(
        path.join(ROOT, 'node_modules/assurance-core/dist/index.d.ts'),
        'utf8',
      );
    const exported = shippedCore()
      .map((f) => f.replace(/\.js$/, '.d.ts'))
      .flatMap((f) => [
        ...fs
          .readFileSync(f, 'utf8')
          .matchAll(/export (?:declare )?(?:const|function|interface|type|class) (\w+)/g),
      ])
      .map((m) => m[1]!);
    // Non-vacuity: an empty list would make the loop below prove nothing.
    expect(exported.length).toBeGreaterThan(20);
    expect(declared).toContain('export');
    for (const name of exported) {
      expect(name.toLowerCase(), `the package exports ${name}`).not.toMatch(
        /kinetix|drug|pharma/,
      );
    }
  });
});

/**
 * §28 — the three ways the plan says the boundary can slip.
 *
 * §28 is prose, not a phase, and it is the section most likely to be read once
 * and never checked. Its three "if" clauses are each a testable statement about
 * the code, so they are tested:
 *
 *   > If new core code starts importing pharmacology definitions, TipTap fact
 *   > helpers, Kinetix citation tables, or Kinetix role names, the boundary has
 *   > slipped in the wrong direction.
 *
 *   > If Kinetix begins requiring a remote governance service to stay online,
 *   > the extraction has become operationally riskier than the system it
 *   > replaced.
 *
 * The third — that no phase turns the old path off before measuring the new one
 * against it — is a property of the migration rather than of the import graph,
 * and lives in the fallback and rollback suites (`assurance/read-cutover`,
 * `cutover/authoritative-publication`, `rollback/rehearsal`).
 */
describe('§28 — the boundary has not slipped', () => {
  // The core's files are `node_modules/assurance-core/dist/*.js` now. Checking
  // the shipped build instead of a source tree costs one thing worth naming:
  // the compiler has already erased type-only declarations, so a slip that
  // existed solely in an interface would not appear here. That case is covered
  // in the package's own suite, against its source. What remains checkable
  // here is what runs — which is also what a slip would have to reach to do
  // any harm.
  const SERVER = 'api/_lib/knowledge-governance';

  /**
   * Source with comments removed.
   *
   * Load-bearing: the core's prose explains Kinetix's rules and therefore says
   * "admin" and "authenticated" in several places, entirely correctly — a
   * comment describing why the core does NOT read a role is the opposite of a
   * boundary slip. Only what the compiler sees counts.
   */
  function code(file: string): string {
    return fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }

  it('strips comments but keeps code, so the checks below look at the right text', () => {
    // A stripper that emptied the file would make every assertion below pass.
    const file = path.join(ROOT, 'src/lib/assurance/policy.ts');
    const stripped = code(file);
    expect(stripped).toContain('export const KINETIX_POLICY');
    expect(stripped).not.toContain('§14: "Avoid baking');
  });

  it('names no Kinetix role in core code', () => {
    // The core asks "is this actor a human or an agent, and what does its
    // approval carry?" — never "is it an editor?". A role is a host concept and
    // the mapping from role to capability is the host's (`actor-context.ts`).
    for (const file of shippedCore()) {
      for (const role of ['editor', 'admin', 'contributor', 'authenticated']) {
        expect(
          code(file),
          `${path.basename(file)} names the role '${role}' in code`,
        ).not.toMatch(new RegExp(`['"\`]${role}['"\`]`));
      }
    }
  });

  it('names no pharmacology concept in core code', () => {
    for (const file of shippedCore()) {
      for (const term of ['halfLife', 'drugId', 'wikiPage', 'pendingEdit', 'citation']) {
        expect(
          code(file),
          `${path.basename(file)} names ${term} in code`,
        ).not.toContain(term);
      }
    }
  });

  it('reaches no network, anywhere in the governance layer', () => {
    // "If Kinetix begins requiring a remote governance service to stay online,
    // the extraction has become operationally riskier than the system it
    // replaced." The engine is a library in the same process; an outbound call
    // here would make every publication decision depend on something else being
    // up. Checked over the server layer too, not just the core — the core
    // already imports nothing at all, so it is the layer that CAN reach out
    // that this is about.
    const files = [
      ...shippedCore(),
      ...sourceFiles(SERVER),
      ...sourceFiles(`${SERVER}/store`),
      ...sourceFiles(`${SERVER}/sdk`),
      ...sourceFiles(`${SERVER}/queue`),
      ...sourceFiles(`${SERVER}/adapters/kinetix`),
    ];
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const body = code(file);
      for (const spec of importsOf(file)) {
        expect(
          spec,
          `${path.basename(file)} imports ${spec}`,
        ).not.toMatch(/^(node-fetch|axios|got|undici|ky)$/);
      }
      expect(body, `${path.basename(file)} calls fetch()`).not.toMatch(
        /\bfetch\s*\(/,
      );
      expect(body, `${path.basename(file)} contains a URL`).not.toMatch(
        /https?:\/\//,
      );
    }
  });
});
