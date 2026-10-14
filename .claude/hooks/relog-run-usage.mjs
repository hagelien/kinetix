#!/usr/bin/env node
/**
 * Claude Code Stop hook: re-log a routine's token usage once its closing
 * inference has been written (issue 213).
 *
 * Routines call scripts/kinetix-log-run-usage.ts as their last tool call, so
 * the turn that writes the final paragraph is missing from the row it posts.
 * That logger leaves a marker for its session (scripts/lib/run-usage-marker.mjs
 * says where and why); this hook, fired when the turn ends, runs the logger
 * again on the same transcript and the server refreshes the same row.
 *
 * Wired via .claude/settings.json (Stop). Notes:
 *   - Does nothing for a session without a marker — every developer session —
 *     and returns before loading anything heavier than `node:fs`.
 *   - Must NEVER block or fail the stop: every path exits 0, nothing is
 *     written to stdout (a Stop hook's stdout JSON can ask for another turn),
 *     and errors are swallowed. The logger's own output goes to stderr only.
 *   - Stop fires after every turn, so a session may be re-logged several
 *     times; the endpoint upserts on (agent_id, session_id), so that is
 *     idempotent. The spawned logger is a plain process, not a model turn,
 *     so the hook cannot re-enter itself.
 *   - Codex has no equivalent hook; its runs keep the gap (see the logger's
 *     header and docs/ops/agent-tier-benchmark.md).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Under the settings.json timeout, so the hook ends on its own terms. */
const LOGGER_TIMEOUT_MS = 25_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  // Imported inside the try below, so even a missing or broken module ends in
  // exit 0 rather than a hook error.
  const { RELOG_ENV, planRelog, readMarker } = await import(
    '../../scripts/lib/run-usage-marker.mjs'
  );
  // A re-log's own process tree must not recurse (defensive: the logger is
  // not a Claude session and fires no hooks).
  if (process.env[RELOG_ENV] === '1') return;
  const input = readInput();
  const sessionId =
    input && typeof input === 'object' ? input.session_id : undefined;
  const plan = planRelog(input, readMarker(sessionId));
  if (!plan.relog) return;

  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const logger = path.join(root, 'scripts', 'kinetix-log-run-usage.ts');
  const result = spawnSync(process.execPath, [tsx, logger, ...plan.args], {
    cwd: plan.cwd && existsSync(plan.cwd) ? plan.cwd : root,
    env: { ...process.env, [RELOG_ENV]: '1' },
    encoding: 'utf8',
    timeout: LOGGER_TIMEOUT_MS,
    windowsHide: true,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  process.stderr.write(
    `[relog-run-usage] ${result.error ? String(result.error) : `exit ${result.status}`}${out ? `: ${out}` : ''}\n`,
  );
}

try {
  await main();
} catch {
  // A usage re-log must never interfere with the session ending.
}
process.exitCode = 0;
