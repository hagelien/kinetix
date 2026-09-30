/**
 * Real-Postgres integration target (§16.6).
 *
 * The everyday harness is PGlite, and for almost everything that is the right
 * trade: it boots anywhere, needs no service container, and executes the app's
 * actual SQL. It has exactly one blind spot, and it is the expensive kind —
 * **it cannot tell one connection from two.**
 *
 * PGlite is a single connection. A nested `runInPoolTransaction` there becomes
 * a savepoint on that one connection, so `pg_backend_pid()` matches,
 * `txid_current()` matches, and a transaction-scoped advisory lock is
 * re-entrant. Every signal a test could read comes back reassuring for
 * precisely the code that opens a *second* Pool in production, blocks on the
 * lock the outer connection is holding, and hangs until timeout. That is how
 * the monograph-creation path went down, and it is why §16.6 reserves the
 * deadlock exercise for a real server.
 *
 * What makes this target faithful is one property, verified rather than
 * assumed by the first test in the deadlock suite: with a real `pg` pool behind
 * drizzle, `db.transaction()` **checks out a connection**, so a nested call
 * takes a second one. The production shape is reproduced exactly, on the same
 * `setDbForTesting` seam the PGlite harness uses.
 *
 * Opt-in by design. `KINETIX_TEST_PG_URL` selects this target; without it the
 * deadlock suite skips rather than silently degrading to PGlite, where its
 * central assertion would pass for the wrong reason. The `migrations` workflow
 * sets it from a service container, and a static guard in the suite fails if
 * that wiring is ever removed — an absent real Postgres must never read as a
 * clean run.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';
import { setDbForTesting } from '../../../api/_lib/db.js';
import { replayMigrations } from './migration-chain.js';

export type RealPostgresDb = ReturnType<typeof drizzle<typeof schema>>;

/** The env var that points the suite at a real server. */
export const REAL_PG_URL_ENV = 'KINETIX_TEST_PG_URL';

/**
 * The configured real-Postgres URL, or null when this target is not available.
 *
 * Callers gate with `describe.skipIf(!realPostgresUrl())`. Never fall back to
 * PGlite here: the whole point of the target is the connection behaviour PGlite
 * does not have, so a fallback would turn a skipped suite into a green one.
 */
export function realPostgresUrl(): string | null {
  const url = process.env[REAL_PG_URL_ENV];
  return url && url.trim() !== '' ? url : null;
}

/**
 * How long a blocked lock acquisition waits before erroring.
 *
 * Long enough that a slow CI runner cannot mistake scheduling for contention,
 * short enough that the negative control costs seconds rather than a job.
 */
export const LOCK_TIMEOUT_MS = 4000;

let pool: Pool | null = null;

/**
 * Attach a migrated real-Postgres database to `getDb()`.
 *
 * `max` is deliberately above 1. A pool capped at a single connection would
 * make a nested transaction *queue* behind its parent instead of deadlocking —
 * the same false reassurance PGlite gives, arrived at a different way.
 */
export async function setupRealPostgresDb(): Promise<RealPostgresDb> {
  const connectionString = realPostgresUrl();
  if (!connectionString) {
    throw new Error(
      `${REAL_PG_URL_ENV} is not set; gate on realPostgresUrl() before calling this`,
    );
  }
  // `lock_timeout` is what keeps the deadlock suite runnable in CI. The shape
  // it exercises does not fail — it *waits*, forever, on a lock the outer
  // connection will not release until the inner call it is awaiting returns.
  // Without a timeout the negative control would hang the job and report as a
  // flaky timeout rather than as the deliberate demonstration it is; with one,
  // the blocked acquisition comes back as SQLSTATE 55P03 and the test asserts
  // on it. It never fires on the joined path, where the lock is re-entrant.
  pool = new Pool({
    connectionString,
    max: 8,
    options: `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
  });
  const db = drizzle(pool, { schema });
  await dropEverything(db);
  await replayMigrations((statement) => pool!.query(statement));
  setDbForTesting(db);
  return db;
}

/** Detach the target and release its connections. */
export async function teardownRealPostgresDb(): Promise<void> {
  setDbForTesting(null);
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Drop the public schema before replaying.
 *
 * Unlike PGlite, this server persists between runs, so the chain would hit
 * "relation already exists" on the second invocation. Recreating the schema is
 * both the reset and the guarantee that the replay is exercising the committed
 * chain from nothing.
 */
async function dropEverything(db: RealPostgresDb): Promise<void> {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
}

/** Truncate every application table, matching the PGlite harness's isolation. */
export async function resetRealPostgresDb(db: RealPostgresDb): Promise<void> {
  const result = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  const names = result.rows.map((r) => `"public"."${r.tablename}"`);
  if (names.length === 0) return;
  await db.execute(
    sql.raw(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`),
  );
}
