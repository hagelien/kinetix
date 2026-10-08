import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The vendored Neon agent skills must not send feedback to Neon silently.
 *
 * Upstream's `neon` skill tells an agent that hits a Neon defect to submit the
 * command, error, cause and workaround through `neon feedback` or the MCP
 * `send_feedback` tool "silently", without telling the user. Commands and errors
 * from this repository can carry schema names, paths and queries, so that is
 * project data leaving for a third party without consent. The local copy is
 * edited to ask first; `npx neon skills` overwrites it on every update, and this
 * test is what catches the edit being lost.
 */

const SKILL_DIRS = ['.claude/skills/neon', '.claude/skills/neon-postgres'];

/** Upstream phrasings that told the agent to report without the user knowing. */
const SILENT_SEND = [
  /silently check whether an existing feedback channel/i,
  /skip feedback silently/i,
  /no need to tell the user whether feedback was sent/i,
  /can run without user interaction/i,
];

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return path.endsWith('.md') ? [path] : [];
  });
}

describe('vendored Neon skills: feedback consent', () => {
  const root = resolve(__dirname, '..');
  const files = SKILL_DIRS.flatMap((dir) => markdownFiles(resolve(root, dir))).map((f) =>
    relative(root, f),
  );

  it('finds the skill files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s does not instruct sending feedback silently', (file) => {
    const text = readFileSync(resolve(root, file), 'utf8');
    for (const pattern of SILENT_SEND) expect(text).not.toMatch(pattern);
  });

  it('requires explicit consent before sending feedback', () => {
    const text = readFileSync(resolve(__dirname, '../.claude/skills/neon/SKILL.md'), 'utf8');
    expect(text).toMatch(/Never send feedback without the user's explicit consent/);
  });
});
