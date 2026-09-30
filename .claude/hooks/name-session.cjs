#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook: names a session "<repo>: <theme>" from
 * your first prompt, exactly once, then leaves it alone.
 *
 *   - <repo>  = basename of the git top-level dir (fallback: basename of cwd)
 *   - <theme> = a short, cleaned snippet of your first message
 *
 * Wired via .claude/settings.json (UserPromptSubmit). Override anytime with
 * /rename; delete ~/.claude/session-titles/<id>.done to let it re-name.
 *
 * Notes:
 *   - Emits {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
 *     "sessionTitle":"..."}} — the field the CLI reads to set the title.
 *   - Must NEVER block prompt submission: every path exits 0, and only the
 *     naming path writes to stdout. Errors are swallowed.
 *   - No subprocess: the repo root is found by walking up for a .git entry,
 *     so the hook doesn't depend on `git` being on PATH.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_WORDS = 8;
const MAX_CHARS = 48;

/** Read the hook's JSON payload from stdin (fd 0); null on any failure. */
function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** Walk up from `dir` looking for a `.git` entry; return that dir or null. */
function findRepoRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // reached the filesystem root
    cur = parent;
  }
}

/** Condense the first prompt into a short, human-friendly theme. */
function themeFromPrompt(prompt) {
  const cleaned = String(prompt || '')
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code blocks
    .replace(/`[^`]*`/g, ' ') // drop inline code spans
    .replace(/^\/\S+\s*/, '') // drop a leading /slash-command
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();

  const words = cleaned.split(' ').filter(Boolean).slice(0, MAX_WORDS).join(' ');
  if (!words) return 'session';

  const chars = [...words]; // count code points, not UTF-16 units
  return chars.length > MAX_CHARS
    ? chars.slice(0, MAX_CHARS - 1).join('').trimEnd() + '…'
    : words;
}

function main() {
  const data = readInput();
  if (!data) return;

  const sessionId = String(data.session_id || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_'); // keep the marker path safe
  if (!sessionId) return;

  const prompt = String(data.prompt || '').trim();
  if (!prompt) return; // no theme to derive yet

  // Name only once per session.
  const stateDir = path.join(os.homedir(), '.claude', 'session-titles');
  const marker = path.join(stateDir, sessionId + '.done');
  if (fs.existsSync(marker)) return;

  const root = findRepoRoot(data.cwd || process.cwd());
  const repo = path.basename(root || data.cwd || process.cwd()) || 'session';
  const title = `${repo}: ${themeFromPrompt(prompt)}`;

  // Record that we've named this session, then hand the title to the CLI.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(marker, title + '\n');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        sessionTitle: title,
      },
    }),
  );
}

try {
  main();
} catch {
  // A naming hook must never interfere with prompt submission.
  process.exitCode = 0;
}
// No explicit process.exit(): let the event loop drain so buffered stdout
// flushes to the CLI before the process exits 0.
