/**
 * The runner session id an agent-token request declared, carried through the
 * request so the write paths can stamp it on agent-written rows without every
 * insert site threading it by hand.
 *
 * Lives under `db/` because the column defaults in `db/schema.ts` read it. The
 * cell is created per request by `withErrorHandling`; only the agent-token
 * branch of `getUserFromRequest` fills it, so rows written by human sessions
 * (and any code running outside a request) read null.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Request header the agent helper scripts send (scripts/kinetix-api.sh). */
export const RUN_SESSION_HEADER = 'x-kinetix-run-session';

/** Matches `agent_run_usage.session_id`'s varchar(128). */
const MAX_RUN_SESSION_ID_LENGTH = 128;

export interface RunSessionCell {
  runSessionId: string | null;
}

const storage = new AsyncLocalStorage<RunSessionCell>();

export function runWithRunSessionCell<T>(fn: () => T): T {
  return storage.run({ runSessionId: null }, fn);
}

/**
 * Parse the header value. Returns null for anything that is not a plain
 * identifier (the ids are UUIDs or thread ids), so a malformed value never
 * reaches a column.
 */
export function parseRunSessionId(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_RUN_SESSION_ID_LENGTH) return null;
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

/** Record the declared session id for the current request, if inside one. */
export function setRunSessionId(id: string | null): void {
  const cell = storage.getStore();
  if (cell) cell.runSessionId = id;
}

export function currentRunSessionId(): string | null {
  return storage.getStore()?.runSessionId ?? null;
}
