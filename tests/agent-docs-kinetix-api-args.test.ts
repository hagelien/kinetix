/**
 * Every `scripts/kinetix-api.sh` call written into an agent prompt must pass a
 * body argument the script accepts: none, `@path`, or `-` (stdin). Anything
 * else makes the script exit 2 with "body argument must be …", so an agent
 * following the prompt silently skips that step. The consensus-sweep call
 * (#1359) shipped as `… POST '/api/agent-consensus-sweep' '{}'` and would have
 * never run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AGENTS_DIR = join(__dirname, '..', 'agents');
// method, quoted path, then an optional quoted third argument.
const CALL_RE =
  /kinetix-api\.sh\s+(GET|POST|PATCH|PUT|DELETE)\s+'[^']*'(?:\s+'([^']*)')?/g;

describe('agent prompt kinetix-api.sh calls', () => {
  it('use only body arguments the script accepts', () => {
    const bad: string[] = [];
    for (const file of readdirSync(AGENTS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
      for (const m of text.matchAll(CALL_RE)) {
        const body = m[2];
        if (body === undefined) continue;
        if (body === '-' || body.startsWith('@')) continue;
        bad.push(`${file}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
