/**
 * PGlite-backed integration test harness (#791 Part A).
 *
 * The unit suite mocks `api/_lib/db.js` and hands stores a fake query builder,
 * so real SQL — joins, FK cascades, unique indexes, the #785 Phase 7
 * `bio_entity_id` resolution — is never executed. This harness boots a
 * throwaway in-process Postgres (PGlite, WASM), runs the committed migration
 * chain against it, and injects the resulting drizzle instance into `getDb()`
 * via `setDbForTesting()` — so the very code the app runs in production executes
 * against actual SQL, no mock.
 *
 * PGlite runs anywhere (no Docker, no network), which is why it's the everyday
 * harness. Its one gap is the real `neon-http`/WebSocket driver behaviour (the
 * SQLSTATE retry logic and pool transactions in `db.ts`); exercising that
 * specifically would want a real Neon branch, deliberately left out here.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';
import { setDbForTesting } from '../../../api/_lib/db.js';
import { replayMigrations } from './migration-chain.js';

export type IntegrationDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Replay the committed migration chain into a fresh PGlite instance.
 *
 * The chain itself lives in {@link replayMigrations}, shared with the
 * real-Postgres target so both replay the same statements the same way.
 * `pg_trgm` is loaded into the instance below so the trigram search index
 * (migration 0008) and its `CREATE EXTENSION` succeed.
 */
async function applyMigrations(client: PGlite): Promise<void> {
  // `query()`, not `exec()`: the extended protocol, matching how production
  // sends each chunk. See the note in replayMigrations.
  await replayMigrations((statement) => client.query(statement));
}

let client: PGlite | null = null;

/**
 * The migrated database, booted once per worker process and shared by every
 * test file that worker runs.
 *
 * This used to be per file: `setupIntegrationDb` booted a PGlite instance and
 * replayed the chain into it, and `teardownIntegrationDb` closed it again. The
 * replay is cheap (~0.6s for the whole journal); booting the WASM Postgres it
 * replays into is not (~2.7s), and the suite paid that boot 63 times for 63
 * identical databases. It was the single largest cost in the `migrations`
 * workflow, which is the most expensive job this repo runs on a PR.
 *
 * Nothing needed a *fresh instance* — what the tests need is an *empty* one,
 * and `resetIntegrationDb` already provides that: it truncates every
 * application table with `RESTART IDENTITY CASCADE`, which is the same
 * isolation the per-test `beforeEach` has always relied on. So the instance
 * now outlives the file, and setup truncates instead of rebooting.
 *
 * A dumped-and-restored data directory (`dumpDataDir`/`loadDataDir`) was the
 * obvious alternative and is measurably worse: restoring a 45 MB image costs
 * more under the parallelism vitest actually runs at than booting does, and
 * every worker holds the image in memory besides.
 *
 * The migration chain still gets replayed — once per worker rather than once
 * per file — so this job's reason for existing (a migration that cannot be
 * prepared must fail here, not at deploy time) is untouched.
 */
async function getMigratedClient(): Promise<PGlite> {
  if (client) return client;
  const fresh = await PGlite.create({ extensions: { pg_trgm } });
  await applyMigrations(fresh);
  client = fresh;
  return fresh;
}

/**
 * Attach a migrated PGlite database to `getDb()`. Call once per test file in
 * `beforeAll`; pair with {@link teardownIntegrationDb} in `afterAll` and
 * {@link resetIntegrationDb} in `beforeEach`.
 *
 * The instance is shared with the other files this worker runs, so it arrives
 * carrying whatever the previous file left behind — truncate before handing it
 * over, or the first test to run would see stale rows.
 */
export async function setupIntegrationDb(): Promise<IntegrationDb> {
  const active = await getMigratedClient();
  const db = drizzle({ client: active, schema });
  setDbForTesting(db);
  await resetIntegrationDb(db);
  return db;
}

/**
 * Detach the test db from `getDb()`.
 *
 * Deliberately leaves the PGlite instance open: it is shared with the rest of
 * this worker's files, and closing it here would put the boot cost back. The
 * worker process exiting is what releases it.
 */
export async function teardownIntegrationDb(): Promise<void> {
  setDbForTesting(null);
}

/**
 * Truncate every application table for per-test isolation. Faster than
 * re-running the migration chain; `RESTART IDENTITY` resets sequences so ids
 * are deterministic within each test, and `CASCADE` clears FK-referencing rows.
 */
export async function resetIntegrationDb(db: IntegrationDb): Promise<void> {
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
