/**
 * The marker that lets a Claude Code `Stop` hook re-log a routine's token
 * usage after its closing inference (issue 213, gap 1 of issue 38).
 *
 * A routine calls scripts/kinetix-log-run-usage.ts as its last tool call, so
 * the model turn that writes the run's final paragraph happens after the
 * transcript was read and is never counted. After a successful (non-dry-run)
 * Claude Code log, the logger writes one marker per session recording how it
 * was invoked. The `Stop` hook (.claude/hooks/relog-run-usage.mjs) fires when
 * the turn ends, finds the marker for its session and runs the logger again on
 * the same transcript. POST /api/agent-run-usage upserts on
 * (agent_id, session_id), so the re-log refreshes the same row's counts and
 * duration — now including the closing inference — without moving its tier or
 * date. A session without a marker (every developer session) is left alone.
 *
 * Where markers live: `$CLAUDE_CONFIG_DIR/kinetix-run-usage/<session>.json`,
 * else `~/.claude/kinetix-run-usage/<session>.json` — next to the transcripts
 * they point at and never inside the repository working tree, so they cannot
 * be committed. KINETIX_RUN_USAGE_MARKER_DIR overrides the directory (tests).
 * Markers older than MARKER_TTL_MS are pruned whenever a new one is written.
 *
 * Plain ESM with no dependencies: the hook runs under bare `node` on every
 * turn of every session, so it cannot pay for a TypeScript loader just to
 * learn there is nothing to do. Types for the TypeScript logger are in
 * run-usage-marker.d.mts.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKER_VERSION = 1;

/** Markers older than this are stale leftovers of finished runs. */
export const MARKER_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * How long after the log the closing turn may end and still be re-logged. The
 * closing turn follows the logger call within the same turn, so minutes is
 * ample; a marker older than this belongs to a run that already finished, and
 * re-logging it would fold later, unrelated work into that run.
 */
export const RELOG_WINDOW_MS = 30 * 60_000;

/**
 * Set by the hook on the logger it spawns, so a re-log neither rewrites the
 * routine's own marker nor depends on how the hook environment differs.
 */
export const RELOG_ENV = 'KINETIX_RUN_USAGE_RELOG';

/** @param {NodeJS.ProcessEnv} [env] */
export function markerDir(env = process.env) {
  if (env.KINETIX_RUN_USAGE_MARKER_DIR) return env.KINETIX_RUN_USAGE_MARKER_DIR;
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'kinetix-run-usage');
}

/**
 * A session id reduced to a safe file name, or null when nothing is left. The
 * id comes from a hook payload or a transcript, so it must never be able to
 * name a path outside the marker directory.
 *
 * @param {unknown} id
 */
export function safeSessionId(id) {
  if (typeof id !== 'string') return null;
  const safe = id
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 128);
  return safe && !/^\.+$/.test(safe) ? safe : null;
}

/**
 * @param {unknown} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function markerPath(sessionId, env = process.env) {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(markerDir(env), `${safe}.json`) : null;
}

/**
 * The marker's shape, or null when the value is not a current-version marker.
 *
 * @param {unknown} value
 */
export function parseMarker(value) {
  if (!value || typeof value !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (value);
  const str = (/** @type {unknown} */ v) => typeof v === 'string' && v !== '';
  if (
    m.version !== MARKER_VERSION ||
    !str(m.sessionId) ||
    !str(m.workflow) ||
    !str(m.runtime) ||
    !str(m.transcript) ||
    !(m.notes === null || typeof m.notes === 'string') ||
    !(m.cwd === null || typeof m.cwd === 'string') ||
    !str(m.loggedAt)
  ) {
    return null;
  }
  return {
    version: MARKER_VERSION,
    sessionId: /** @type {string} */ (m.sessionId),
    workflow: /** @type {string} */ (m.workflow),
    runtime: /** @type {string} */ (m.runtime),
    transcript: /** @type {string} */ (m.transcript),
    notes: /** @type {string | null} */ (m.notes),
    cwd: /** @type {string | null} */ (m.cwd),
    loggedAt: /** @type {string} */ (m.loggedAt),
  };
}

/**
 * Write (or replace) the marker for `key`, then prune stale markers. Written
 * to a temporary file and renamed, so a hook never reads half a marker.
 *
 * @param {string} key  the session id the Stop hook will be given
 * @param {import('./run-usage-marker.d.mts').RunUsageMarker} marker
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [opts]
 * @returns {string} the marker's path
 */
export function writeMarker(key, marker, opts = {}) {
  const env = opts.env ?? process.env;
  const file = markerPath(key, env);
  if (!file) throw new Error(`unusable session id for a marker: ${key}`);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`);
  renameSync(tmp, file);
  pruneMarkers(dir, opts.now ?? Date.now(), file);
  return file;
}

/**
 * @param {string} dir
 * @param {number} now
 * @param {string} keep
 */
function pruneMarkers(dir, now, keep) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (file === keep || !name.endsWith('.json')) continue;
    try {
      if (now - statSync(file).mtimeMs > MARKER_TTL_MS) unlinkSync(file);
    } catch {
      // another run pruned it first
    }
  }
}

/**
 * The marker for `sessionId`, or null when there is none or it is unreadable.
 *
 * @param {unknown} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readMarker(sessionId, env = process.env) {
  const file = markerPath(sessionId, env);
  if (!file || !existsSync(file)) return null;
  try {
    return parseMarker(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Take the marker for `sessionId` so it is used exactly once: renamed away
 * (atomic, so two hooks racing on one session cannot both get it), read,
 * then deleted. The first Stop after the log is the run's closing turn; any
 * later Stop in the same session — a follow-up or a resumed session — is work
 * that does not belong to the run, and finds no marker.
 *
 * @param {unknown} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function consumeMarker(sessionId, env = process.env) {
  const file = markerPath(sessionId, env);
  if (!file || !existsSync(file)) return null;
  const claimed = `${file}.${process.pid}.consumed`;
  try {
    renameSync(file, claimed);
  } catch {
    return null; // another hook took it first
  }
  try {
    return parseMarker(JSON.parse(readFileSync(claimed, 'utf8')));
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(claimed);
    } catch {
      // already gone
    }
  }
}

/**
 * Decide what the Stop hook does for one hook payload. Pure: the caller reads
 * the marker and runs the logger.
 *
 * Only a session whose own routine logged its usage (a marker exists) is
 * re-logged, and only a Claude Code one — Codex has no Stop hook, and a marker
 * claiming another runtime is not this hook's to act on. The re-log reuses the
 * marker's transcript and flags so it lands on the same
 * (agent_id, session_id) row.
 *
 * A marker logged more than RELOG_WINDOW_MS ago is refused: it is not this
 * session's closing turn.
 *
 * @param {unknown} input  the hook's stdin JSON
 * @param {import('./run-usage-marker.d.mts').RunUsageMarker | null} marker
 * @param {number} [now]
 * @returns {import('./run-usage-marker.d.mts').RelogPlan}
 */
export function planRelog(input, marker, now = Date.now()) {
  const sessionId =
    input && typeof input === 'object'
      ? safeSessionId(/** @type {Record<string, unknown>} */ (input).session_id)
      : null;
  if (!sessionId) return { relog: false, reason: 'no session id' };
  if (!marker) return { relog: false, reason: 'no marker' };
  if (marker.runtime !== 'claude-code') {
    return { relog: false, reason: `runtime ${marker.runtime}` };
  }
  const loggedAt = Date.parse(marker.loggedAt);
  if (!Number.isFinite(loggedAt) || now - loggedAt > RELOG_WINDOW_MS) {
    return { relog: false, reason: 'marker expired' };
  }
  const args = [
    '--workflow',
    marker.workflow,
    '--runtime',
    marker.runtime,
    '--transcript',
    marker.transcript,
  ];
  if (marker.notes) args.push('--notes', marker.notes);
  return { relog: true, args, cwd: marker.cwd };
}
