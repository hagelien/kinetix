import type { IncomingMessage } from 'node:http';

/**
 * The agent run that wrote an output (issue #214).
 *
 * Scheduled agents send their runner session id — the id
 * scripts/kinetix-log-run-usage.ts later logs as `agent_run_usage.session_id`
 * — in this header on every request (scripts/kinetix-api.sh). The write paths
 * stamp it on `pending_edits` and `agent_verifications` so the tier benchmark
 * can tie each output to the run that paid for it instead of guessing from an
 * identity and a time window.
 *
 * Read only for agent-token requests (`getUserFromRequest`), so a person's
 * row never carries one. The value is self-reported by the agent, the same
 * trust level as its usage log: it can only move its own outputs between its
 * own runs, because the benchmark matches on identity and session together.
 */
export const RUN_SESSION_HEADER = 'x-kinetix-run-session';

/** Width of `run_session_id` and of `agent_run_usage.session_id`. */
export const RUN_SESSION_ID_MAX_LENGTH = 128;

/**
 * Claude Code and Codex session ids are UUIDs; this admits those and other
 * opaque ids without admitting whitespace, commas (a repeated header arrives
 * comma-joined) or anything that could carry markup into a report.
 */
const RUN_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The run session id a header value names, or null when it names none.
 *
 * A malformed value is dropped rather than refused: the stamp is telemetry,
 * and a write must not fail because of it. A dropped stamp leaves the row to
 * the benchmark's time-window fallback, exactly like a client that sent none.
 */
export function parseRunSessionId(
  raw: string | string[] | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > RUN_SESSION_ID_MAX_LENGTH) {
    return null;
  }
  return RUN_SESSION_ID_RE.test(value) ? value : null;
}

/** The validated run session id on a request, or null. */
export function readRunSessionHeader(req: IncomingMessage): string | null {
  return parseRunSessionId(req.headers?.[RUN_SESSION_HEADER]);
}

/**
 * The columns that stamp a new row with the run that wrote it: empty unless
 * the caller authenticated with an agent token and named its run, so a
 * person's insert is unchanged and its `run_session_id` stays NULL.
 */
export function runSessionInsert(auth: {
  runSessionId?: string | null;
}): { runSessionId?: string } {
  return auth.runSessionId ? { runSessionId: auth.runSessionId } : {};
}
