/**
 * Pure classification of neon-http driver errors.
 *
 * Split out from db.ts on purpose: these helpers have no dependencies (no
 * neon/drizzle/ws imports) and no side effects, so modules that only need to
 * *classify* an error — notably api/_lib/response.ts's top-level catch — can
 * import them without pulling in the database client, and without being caught
 * by the per-test `vi.mock('_lib/db.js')` partial mocks. db.ts re-exports both
 * predicates so existing `from './db.js'` imports keep working.
 */

// Postgres SQLSTATE class prefixes that are worth retrying: connection
// exceptions (08), insufficient resources (53), operator intervention such as
// admin shutdown (57), and transaction rollback / serialization failures (40).
// Everything else Postgres reports — syntax (42), data (22), integrity (23) —
// is deterministic and retrying only adds latency before the same failure.
const RETRYABLE_SQLSTATE_CLASSES = new Set(['08', '53', '57', '40']);

/**
 * Whether a thrown DB error is a transient neon-http failure worth retrying.
 *
 * The http driver (getDb()) raises NeonDbError both for HTTP/connection-level
 * blips — Neon cold starts or 5xx from the SQL endpoint, where no statement
 * ran and there is no SQLSTATE — and for genuine Postgres errors that carry a
 * SQLSTATE `code`. We retry the former unconditionally and the latter only for
 * the transient classes above; deterministic SQL errors fail fast.
 */
export function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'NeonDbError') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || code === '') return true;
  return RETRYABLE_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

// SQLSTATE class prefixes that mean the database is unreachable or unusable
// for reasons outside the request's control — infrastructure or credential
// problems, not a bug in our SQL. Connection exceptions (08), invalid
// authorization / bad password (28 — e.g. the Neon `neondb_owner` password
// rotated out from under DATABASE_URL, which surfaces as `28P01`), insufficient
// resources such as too-many-connections (53), and operator intervention such
// as admin shutdown (57). Deterministic query errors — syntax (42), integrity
// (23), data (22) — are deliberately excluded: those are application bugs the
// caller must fix, and should still surface as 500s and auto-fix issues.
const UNAVAILABLE_SQLSTATE_CLASSES = new Set(['08', '28', '53', '57']);

/**
 * Whether a thrown DB error means the database itself is unavailable — the
 * connection failed, the SQL endpoint is down, or the stored credentials no
 * longer authenticate (Neon `password authentication failed for user ...`).
 *
 * Distinct from isRetryableDbError(): this classifies an *infrastructure /
 * credential outage* so callers can surface it as a 503 (transient, "try again
 * shortly") instead of a 500, and skip filing an auto-fix issue that a bot
 * cannot resolve. isRetryableDbError() instead answers "is this a transient
 * blip worth a quick retry" — note the two sets differ on class 28: a bad
 * password makes the DB unavailable but is NOT retryable, since it fails
 * identically on every attempt.
 *
 * A NeonDbError with no SQLSTATE is an HTTP/driver-level failure to reach Neon
 * at all (connect error, 5xx from the SQL endpoint, auth-token fetch) — also an
 * outage, so it counts as unavailable.
 */
export function isDatabaseUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'NeonDbError') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || code === '') return true;
  return UNAVAILABLE_SQLSTATE_CLASSES.has(code.slice(0, 2));
}
