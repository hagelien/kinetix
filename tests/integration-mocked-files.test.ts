/**
 * vitest.integration.config.ts runs most integration files with `isolate:
 * false`, sharing one module registry per worker, and gives a fresh registry
 * only to the files in its MOCKED list. A file that calls `vi.mock` but is
 * missing from that list gets its mock only when the worker has not already
 * loaded the real module — so it fails intermittently, in whichever order
 * the worker happens to pick. drug-delete-parameter-entries did exactly that:
 * its admin-auth mock lost to the real module and every request came back 403.
 *
 * The config says "keep this in sync"; this is what keeps it in sync.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

describe('vitest.integration.config.ts MOCKED list', () => {
  it('lists exactly the integration files that call vi.mock', () => {
    const config = readFileSync(path.join(root, 'vitest.integration.config.ts'), 'utf8');
    const block = config.match(/const MOCKED = \[([\s\S]*?)\];/);
    expect(block, 'MOCKED list not found').not.toBeNull();
    const listed = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    const dir = path.join(root, 'tests/integration');
    const mocking = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => /\bvi\.mock\(/.test(readFileSync(path.join(dir, f), 'utf8')))
      .map((f) => `tests/integration/${f}`)
      .sort();

    expect(listed).toEqual(mocking);
  });
});
