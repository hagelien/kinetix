import fs from 'node:fs';
import path from 'node:path';

// Which unit-test files actually need a DOM.
//
// The whole unit suite used to run under `environment: 'jsdom'`, and building
// that environment was the single most expensive thing in it — more expensive
// than executing the tests:
//
//   Duration 253s (transform 22s, setup 95s, import 150s, tests 143s,
//                  environment 269s)
//
// `environment` is jsdom construction, once per test file, 417 times. Roughly
// half those files never touch a DOM: `tests/api/**` alone is ~100 route tests
// that assert on request/response objects. They were each paying for a browser
// to be simulated around them and then not using it.
//
// So the suite is split into two projects that differ only in `environment`.
// The split cannot be a path rule — `src/lib/**` is almost exactly half and
// half — and a hand-maintained list of 125 paths would go stale in a tree that
// adds test files weekly. It is derived instead, by walking each test file's
// local import graph looking for anything that implies a DOM.
//
// The rule that makes this safe: **jsdom is the answer whenever we are not
// certain the file is DOM-free.** Every uncertainty — an unreadable file, an
// import graph deeper than the walk follows, a `.tsx` anywhere in the graph —
// resolves to jsdom. A file misjudged in that direction is merely as slow as
// it used to be. A file misjudged the other way fails loudly and immediately
// (`document is not defined`), which is a bug report, not a silent pass.

const ROOT = import.meta.dirname;

// A module needs a DOM if its source mentions any of these. `react` covers the
// component libraries and the hooks; the globals cover code that reaches for
// the browser directly. Matched against source with comments stripped, so a
// comment mentioning `window` does not drag a file into jsdom.
const DOM_SIGNAL =
  /@testing-library|\breact\b|\bdocument\b|\bwindow\b|localStorage|sessionStorage|ResizeObserver|IntersectionObserver|HTMLElement|matchMedia|navigator\.|jsdom|createRoot|new Worker/;

const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

// How far to follow the import graph. Chains longer than this resolve to
// jsdom rather than being assumed clean — see the safety rule above.
const MAX_DEPTH = 12;

/**
 * Resolve an import specifier to a repo-relative file, or null if not local.
 *
 * Exported for `tests/vitest-env-split.test.ts`: returning null here is how an
 * import edge gets dropped, and a dropped edge votes for the node project.
 */
export function resolveLocal(spec: string, importer: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('@db/')) base = path.join(ROOT, 'db', spec.slice(4));
  else if (spec.startsWith('.')) base = path.resolve(ROOT, path.dirname(importer), spec);
  else return null; // bare specifier: a package, covered by DOM_SIGNAL above

  // This repository imports TypeScript sources through explicit emitted-JS
  // specifiers — `import './scaling.js'` where the file on disk is
  // `scaling.ts`. Ninety files under src/ do it, most of the PK engine among
  // them, and `server-shared-esm.yml` exists to keep it that way. Probing
  // `scaling.js` + `.ts` gives `scaling.js.ts`, which exists nowhere, so
  // every one of those edges was being dropped as though it pointed at a
  // package. Dropping an edge votes for `node`, which is the unsafe
  // direction: a test could be placed there while its transitive imports
  // reach React.
  const candidates = [base];
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (stripped !== base) candidates.push(stripped);

  for (const candidate of candidates) {
    for (const ext of ['', '.ts', '.tsx', '.mts', '.cts', '/index.ts', '/index.tsx']) {
      const file = candidate + ext;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return path.relative(ROOT, file);
      }
    }
  }
  return null;
}

const cache = new Map<string, boolean>();

function needsDom(file: string, depth = 0, seen = new Set<string>()): boolean {
  if (JSX_FILE.test(file)) return true; // JSX is a DOM by definition
  if (depth > MAX_DEPTH) return true; // uncertain -> jsdom
  if (seen.has(file)) return false; // already on this path; not new evidence
  seen.add(file);

  const cached = cache.get(file);
  if (cached !== undefined) return cached;

  let source: string;
  try {
    source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return true; // unreadable -> jsdom
  }

  // Strip comments so prose does not vote on the environment.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  let result = DOM_SIGNAL.test(code);
  if (!result) {
    for (const [, spec] of code.matchAll(IMPORT)) {
      const local = resolveLocal(spec, file);
      if (local && needsDom(local, depth + 1, seen)) {
        result = true;
        break;
      }
    }
  }
  cache.set(file, result);
  return result;
}

// Every extension the single-project `include` globs used to cover. The tree
// currently holds only `.ts` and `.tsx` tests, but a narrower list here would
// mean a `.test.js` added later matched neither project's include and was
// never run — reported as success, having executed nothing. That is the exact
// failure mode unit-tests.yml was created to close, so the walker keeps the
// old config's reach rather than the tree's current contents.
export const TEST_FILE = /\.(test|spec)\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;

// Extensions that carry JSX, and so always need a DOM.
const JSX_FILE = /\.(jsx|tsx)$/;

/** Every unit-project test file, repo-relative, POSIX separators. */
function testFiles(): string[] {
  const found: string[] = [];
  const skip = new Set(['node_modules', 'integration', 'governance']);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(rel);
      } else if (TEST_FILE.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  walk('src');
  walk('tests');
  return found;
}

/**
 * Partition the unit suite by whether a DOM is required.
 *
 * `dom` keeps the jsdom environment and the React setup file; `node` runs in
 * plain Node with neither. Both lists are explicit includes, so every file
 * lands in exactly one project and nothing is skipped by a rule that stops
 * matching.
 */
export function splitByEnvironment(): { dom: string[]; node: string[] } {
  const dom: string[] = [];
  const node: string[] = [];
  for (const file of testFiles()) (needsDom(file) ? dom : node).push(file);
  return { dom, node };
}
