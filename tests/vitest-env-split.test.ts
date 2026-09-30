import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLocal, splitByEnvironment, TEST_FILE } from '../vitest.env-split';

/**
 * `vitest.config.ts` no longer runs the whole unit suite under jsdom. It asks
 * `vitest.env-split.ts` which files need one and builds two projects from the
 * answer, so that partition decides what is tested and how.
 *
 * Two ways it can be wrong, both silent:
 *
 *   * a file in neither list is not run by either project, and vitest reports
 *     success having never executed it — the failure mode unit-tests.yml was
 *     created to close;
 *   * a file that needs a DOM placed in the node project runs without one.
 *     That is meant to fail loudly on `document is not defined`, but only if
 *     the DOM use is on the path the test takes.
 *
 * Both reached review once. The walker dropped every `./foo.js` specifier
 * pointing at `foo.ts` — the convention `server-shared-esm-specifiers` exists
 * to enforce, used by ~90 files under src/ — because it probed `foo.js.ts`.
 * Those edges resolved to nothing, were treated as external packages, and 108
 * files including the whole of `src/lib/kinetics-core/__tests__` were assigned
 * to the node project on an import graph that had been silently truncated.
 */

const ROOT = resolve(import.meta.dirname, '..');
const { dom, node } = splitByEnvironment();

function walk(dir: string, found: string[] = []): string[] {
  const skip = new Set(['node_modules', 'integration', 'governance']);
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(rel, found);
    } else if (TEST_FILE.test(entry.name)) found.push(rel);
  }
  return found;
}

describe('unit-suite environment split', () => {
  it('assigns every test file to exactly one project', () => {
    const assigned = [...dom, ...node].sort();
    expect(assigned).toEqual(walk('src', walk('tests')).sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('covers every extension the single-project config used to include', () => {
    // The pre-split globs were
    //   'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    //   'tests/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}'
    // A narrower walker would drop a `.test.js` added later into neither
    // project, where it would never run and never be missed. Asserted against
    // the pattern the module actually walks with, not a copy of it.
    for (const ext of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']) {
      expect(TEST_FILE.test(`example.test.${ext}`), `.test.${ext}`).toBe(true);
      expect(TEST_FILE.test(`example.spec.${ext}`), `.spec.${ext}`).toBe(true);
    }
    expect(TEST_FILE.test('example.ts')).toBe(false);
  });

  it('resolves emitted-JS specifiers to their TypeScript sources', () => {
    // The regression, pinned at the point it occurred rather than at one of
    // its downstream effects: `./generated-registry-loader.js` names a file
    // that exists on disk only as `.ts`. Probing `…loader.js.ts` finds
    // nothing, `resolveLocal` returns null, and the walker treats a local
    // module as an external package — truncating the graph it is deciding on.
    const loader = 'src/lib/kinetics-core/generated-registry-loader.ts';
    expect(existsSync(join(ROOT, loader)), `${loader} should exist`).toBe(true);
    expect(existsSync(join(ROOT, 'src/lib/kinetics-core/generated-registry-loader.js'))).toBe(
      false,
    );

    expect(
      resolveLocal('./generated-registry-loader.js', 'src/lib/kinetics-core/registry.ts'),
    ).toBe(loader);
    // The same file named directly still resolves.
    expect(resolveLocal('./generated-registry-loader', 'src/lib/kinetics-core/registry.ts')).toBe(
      loader,
    );
    // Alias forms take the same path.
    expect(resolveLocal('@/lib/kinetics-core/generated-registry-loader.js', 'tests/x.test.ts')).toBe(
      loader,
    );
    // A real package is still external, not a phantom local file.
    expect(resolveLocal('react', 'src/lib/kinetics-core/registry.ts')).toBeNull();
  });

  it('keeps the engine suite on an untruncated graph', () => {
    // A consequence of the above rather than a rule: the engine's tests split
    // between the projects on their real imports. Both sides being non-empty
    // is what a working resolver looks like here — all-node would mean the
    // `.js` edges are being dropped again.
    const engineTests = (files: string[]) =>
      files.filter((file) => file.startsWith('src/lib/kinetics-core/__tests__/'));
    expect(engineTests(dom).length).toBeGreaterThan(0);
    expect(engineTests(dom).length + engineTests(node).length).toBeGreaterThan(20);
  });

  it('puts every JSX test file in the dom project', () => {
    expect(node.filter((file) => /\.(jsx|tsx)$/.test(file))).toEqual([]);
  });
});
