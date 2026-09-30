/**
 * Build-time env flags must be readable by Vite's STATIC replacement.
 *
 * Vite does not hand a bundle a runtime environment. It replaces the literal expression
 * `import.meta.env` in the source with the values known at build time. Read it through an alias —
 *
 *     const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
 *     return meta.env?.VITE_SOMETHING === 'true';
 *
 * — and the expression the replacement looks for is not there, so nothing is replaced. The
 * minifier then inlines the alias back, and the shipped bundle contains a live
 * `import.meta.env?.VITE_SOMETHING`. A browser ES module has no `env` on `import.meta`, so the
 * optional chain short-circuits to `undefined` and the flag reads as OFF however the environment
 * variable is set.
 *
 * The failure is invisible everywhere it would normally be caught: `npm run typecheck` passes, the
 * build succeeds, and every unit test passes because vitest provides a REAL `import.meta.env` for
 * `vi.stubEnv` to write to. It reaches production as "the flag does nothing", with a green
 * pipeline behind it. `VITE_DERIVED_REGISTRY_ENABLED` shipped in exactly that state, which is why
 * this guard exists rather than a comment.
 *
 * Two rules, both about the shape of the SOURCE rather than about any one flag:
 *
 *   1. Every `VITE_*` read is written as one literal `import.meta.env` member expression.
 *   2. `import.meta` is never bound to a variable (the way rule 1 gets broken next time).
 *
 * The declaration that makes rule 1 typecheck outside the Vite program lives in
 * `src/types/import-meta-env.d.ts`, included by every tsconfig — so there is no longer a typing
 * reason to alias.
 */
import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every shipped source file: `src/`, minus type declarations and tests (which run under vitest's
 *  own `import.meta.env` and are never bundled). */
function shippedSources(): string[] {
  return globSync('src/**/*.{ts,tsx}', { cwd: ROOT })
    .filter((f) => !f.endsWith('.d.ts'))
    .filter((f) => !/(^|\/)__tests__\//.test(f) && !/\.test\.tsx?$/.test(f));
}

/**
 * Source with comments removed, so the guard reads CODE.
 *
 * The rules below are stated as text patterns, and the clearest place to explain a banned pattern
 * is a comment that spells it out — including the one on `derivedRegistryRolloutEnabled`, which
 * quotes the aliased read it exists to warn about. Scanning the comments too would make writing
 * that warning fail the build.
 */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** A `VITE_*` token that is NOT immediately preceded by `import.meta.env.` / `import.meta.env?.`. */
const ALIASED_ENV_READ = /(?<!import\.meta\.env\??\.)\bVITE_[A-Z0-9_]+/;

/** `import.meta` bound to a name — `const meta = import.meta`, with or without a cast. */
const ALIASED_IMPORT_META = /[=:]\s*import\.meta\s*(?:as\b|[;,)\n])/;

describe('build-time env flags survive Vite’s static replacement', () => {
  it('reads every VITE_* flag through a literal import.meta.env expression', () => {
    const offenders = shippedSources().filter((file) => ALIASED_ENV_READ.test(code(file)));
    expect(
      offenders,
      'A VITE_* flag is read through something other than `import.meta.env.FLAG`. Vite replaces ' +
        'only that literal expression, so this flag is dead in the built bundle however it is set.',
    ).toEqual([]);
  });

  it('never binds import.meta to a variable', () => {
    const offenders = shippedSources().filter((file) => ALIASED_IMPORT_META.test(code(file)));
    expect(
      offenders,
      'Binding `import.meta` to a variable is how a static env read becomes a runtime one. Read ' +
        '`import.meta.env.FLAG` directly; `src/types/import-meta-env.d.ts` types it for every program.',
    ).toEqual([]);
  });

  it('recognises the pattern that shipped the dead flag', () => {
    // The guard is only worth having if it fails on the real thing, so assert it against the
    // exact source that reached production rather than trusting the regex by inspection.
    const shipped = `
      export function derivedRegistryRolloutEnabled(): boolean {
        const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
        return meta.env?.VITE_DERIVED_REGISTRY_ENABLED === 'true';
      }`;
    expect(ALIASED_ENV_READ.test(shipped)).toBe(true);
    expect(ALIASED_IMPORT_META.test(shipped)).toBe(true);

    const fixed = `
      export function derivedRegistryRolloutEnabled(): boolean {
        return import.meta.env?.VITE_DERIVED_REGISTRY_ENABLED === 'true';
      }`;
    expect(ALIASED_ENV_READ.test(fixed)).toBe(false);
    expect(ALIASED_IMPORT_META.test(fixed)).toBe(false);
  });

  it('leaves `import.meta.url` alone — it is not an env read', () => {
    const workerUrl = `new Worker(new URL('./montecarlo.worker.ts', import.meta.url), { type: 'module' })`;
    expect(ALIASED_IMPORT_META.test(workerUrl)).toBe(false);
    expect(ALIASED_ENV_READ.test(workerUrl)).toBe(false);
  });
});
