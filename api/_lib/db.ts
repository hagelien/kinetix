import { AsyncLocalStorage } from 'node:async_hooks';
import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql as sqlTemplate, type SQL } from 'drizzle-orm';
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '../../db/schema.js';
import { isRetryableDbError } from './db-errors.js';

// Pure driver-error classifiers live in db-errors.ts (no db-client deps) so
// modules that only classify errors don't pull in the connection stack.
// Re-exported here so existing `from './db.js'` importers keep working.
export { isRetryableDbError, isDatabaseUnavailableError } from './db-errors.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _sql: ReturnType<typeof neon> | null = null;

// The interactive transaction client exposed by the WebSocket Pool driver.
type PoolDatabase = ReturnType<typeof drizzlePool>;
export type TransactionClient = Parameters<
  Parameters<PoolDatabase['transaction']>[0]
>[0];

// When a caller runs inside runInPoolTransaction(), the active transaction
// context is stored here. getDb() returns ctx.tx for the duration so that
// every helper — including ones that resolve their own client via getDb() —
// performs its reads and writes on the single transactional connection, and
// the whole unit of work commits or rolls back atomically without threading a
// `tx` argument through every function. `afterCommit` collects work that must
// run only once the transaction has actually committed (see
// afterTransactionCommit).
type TxContext = {
  tx: TransactionClient;
  afterCommit: Array<() => void>;
};
const txStorage = new AsyncLocalStorage<TxContext>();

// Test-only seam. An integration harness (tests/integration/) can point
// getDb() and runInPoolTransaction() at a real database — a PGlite instance
// that has run the full migration chain — so store logic executes against
// actual SQL instead of a mocked query builder (#791 Part A). This is never
// set in production: only the harness calls setDbForTesting(), and the app
// code path is unchanged when it is null.
let _testDb: ReturnType<typeof drizzle> | null = null;

/**
 * Whether the caller is already inside a runInPoolTransaction() unit.
 *
 * Needed by code that must hold a transaction-scoped advisory lock across a
 * check-then-write: on the auto-commit client such a lock is released the
 * moment its own SELECT completes, so it serializes nothing. A helper that
 * wants the lock to mean something has to know whether to open a transaction
 * or join the caller's.
 */
export function isInPoolTransaction(): boolean {
  return txStorage.getStore() !== undefined;
}

/**
 * Run `fn` inside a pool transaction, **joining** the caller's if there is one
 * rather than opening a second.
 *
 * Nesting `runInPoolTransaction` is not a nested transaction — it opens a
 * fresh Pool on a *different connection*, which breaks two things at once. The
 * inner unit commits independently, so it survives an outer rollback; and if
 * either side takes a transaction-scoped advisory lock, the inner connection
 * blocks on a lock the outer connection holds while the outer awaits the
 * inner. That is a hang until timeout, not an error.
 *
 * The integration harness cannot catch it: `runInPoolTransaction` there routes
 * through the single PGlite connection, where a nested call becomes a
 * savepoint and the advisory lock is re-entrant. So a deadlock of this shape
 * passes the suite and only appears in production — which is exactly what
 * happened to the monograph-creation path. Prefer this helper over
 * `runInPoolTransaction` anywhere the caller might already be transactional.
 */
export function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return isInPoolTransaction() ? fn() : runInPoolTransaction(fn);
}

export function setDbForTesting(db: unknown): void {
  _testDb = (db as ReturnType<typeof drizzle> | null) ?? null;
  // Drop the cached tagged-template client: a new harness database must not
  // keep executing against the previous one.
  _testSqlFor = null;
  _testSql = null;
}

export function getDb() {
  const ctx = txStorage.getStore();
  if (ctx) {
    // The transaction client and the http client expose the same query-builder
    // surface for the operations callers use; the cast keeps the http return
    // type while transparently running the work on the active transaction.
    // That premise held until `.batch()` — a neon-http-only method the
    // neon-serverless pool-transaction client does not implement — became one
    // of the operations a caller used. The cast hides the mismatch from the
    // typechecker, so it only surfaces at runtime, and only on this path
    // (#1356). Do not add a `.batch()` call to anything reachable from inside
    // runInPoolTransaction(); run the queries individually instead.
    return ctx.tx as unknown as ReturnType<typeof drizzle>;
  }
  if (_testDb) return _testDb;
  if (!_db) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    _sql = neon(process.env.DATABASE_URL);
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

/**
 * Client for infrastructure reads that are not part of a route's own work —
 * today just the permission matrix, which nearly every handler consults
 * before doing anything else.
 *
 * It is the same connection as getDb(); the point of the separate accessor is
 * the seam. Route unit tests mock this module with a hand-built query builder
 * whose results are queued in the exact order the handler asks for them, and
 * an extra read threaded through getDb() would silently consume the first
 * queued result in every one of them. Resolving the matrix through its own
 * export keeps those mocks describing only the route's queries; a partial
 * mock leaves this undefined, the permission store catches that and falls
 * back to the shipped defaults, which is what such a test is asserting
 * anyway. The integration harness injects a real database via
 * setDbForTesting(), so the stored-override path is exercised there.
 */
export function getConfigDb() {
  return getDb();
}

/**
 * Retry an idempotent database read over transient neon-http failures.
 *
 * Each getDb() query is an independent HTTPS request to Neon's SQL endpoint, so
 * a single transient blip on any one of them turns an otherwise-healthy read
 * into a 500 (observed intermittently on GET /api/agents). Re-running the read
 * a couple of times with a short, jittered backoff smooths these over without
 * masking real failures — only isRetryableDbError() errors are retried.
 *
 * READS ONLY: `fn` must be idempotent because a retry re-runs it from scratch.
 * Never wrap writes or multi-statement units here — use runInPoolTransaction().
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = 3,
    baseDelayMs = 100,
  }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !isRetryableDbError(err)) throw err;
      const delay =
        baseDelayMs * (i + 1) + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Returns the raw neon SQL client so callers can use sql.transaction([...])
// for atomic multi-statement operations. neon-http's drizzle wrapper does
// not expose db.transaction(); the underlying neon client does.
export function getNeonClient() {
  // Under the integration harness there is no neon client to hand back: getDb()
  // returns the injected PGlite database and never initialises `_sql`, so this
  // used to return null and every caller failed with "sql is not a function".
  // That made a handful of routes — the ones that reach for a raw tagged
  // template rather than the query builder — untestable end to end, which is
  // exactly the wrong set to have a blind spot in: they are raw SQL precisely
  // because the query is doing something the builder cannot express.
  //
  // The shim below is deliberately thin. It does not parse or rewrite the
  // query; it hands the same strings and values to drizzle's own `sql`
  // template, so parameter binding is drizzle's, not a hand-rolled `$1`
  // counter that could silently bind the wrong argument.
  if (_testDb) return testNeonClient(_testDb);
  if (!_sql) {
    getDb(); // ensures _sql is initialised
  }
  return _sql!;
}

/**
 * A tagged-template `sql` over the injected test database.
 *
 * Resolves to the rows array, which is what the neon-http client gives and what
 * every caller of `getNeonClient()` destructures.
 *
 * `.query()` and `.transaction()` are **not** implemented. Both exist on the
 * real client and both are used (`api/agent-sweep.ts`, `api/admin.ts`), so the
 * shim carries them as functions that throw a message naming the limitation
 * rather than being absent — an absent method fails as `undefined is not a
 * function` from inside a route, which is the same cryptic failure this shim
 * exists to remove. A test that reaches one gets told what it hit.
 *
 * Built once per test database and cached; `setDbForTesting` clears it so a new
 * harness database cannot keep executing against the previous one.
 */
let _testSqlFor: ReturnType<typeof drizzle> | null = null;
let _testSql: ReturnType<typeof neon> | null = null;

function testNeonClient(db: ReturnType<typeof drizzle>): ReturnType<typeof neon> {
  if (_testSqlFor === db && _testSql) return _testSql;

  const tagged = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    // The strings and values are handed to drizzle's own `sql` template, so
    // parameter binding is drizzle's rather than a hand-rolled `$1` counter
    // that could bind the wrong argument and pass a test against wrong SQL.
    const chunks: SQL[] = [];
    strings.forEach((literal, i) => {
      chunks.push(sqlTemplate.raw(literal));
      if (i < values.length) chunks.push(sqlTemplate`${values[i]}`);
    });
    const result = (await getDb().execute(sqlTemplate.join(chunks))) as
      | { rows?: unknown[] }
      | unknown[];
    // PGlite and neon-http disagree about the envelope: one resolves to
    // `{ rows }`, the other to the array itself.
    return Array.isArray(result) ? result : (result.rows ?? []);
  };

  const unsupported = (method: string) => () => {
    throw new Error(
      `getNeonClient().${method}() is not available under the integration ` +
        'harness: the test database is PGlite, which this shim drives through ' +
        "drizzle's sql template. Use the query builder, or a tagged template.",
    );
  };
  Object.assign(tagged, {
    query: unsupported('query'),
    transaction: unsupported('transaction'),
    unsafe: unsupported('unsafe'),
  });

  _testSqlFor = db;
  _testSql = tagged as unknown as ReturnType<typeof neon>;
  return _testSql;
}

// Runs `fn` inside a Postgres transaction on the WebSocket Pool driver (the
// neon-http client cannot do interactive transactions or row locks). For the
// duration getDb() returns the transaction client, so nested helpers join the
// same transaction automatically and everything commits or rolls back as one
// unit. The Pool is created and closed per call on purpose: Neon's serverless
// guidance is not to retain WebSocket pools on warm function instances, where
// they would hold connections open and exhaust connection limits.
//
// Work registered via afterTransactionCommit() runs only after the
// transaction has committed successfully; if `fn` throws and the transaction
// rolls back, that work is discarded.
export async function runInPoolTransaction<T>(
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  // Integration harness: run the unit of work as one real transaction on the
  // injected test database so nested getDb() callers join it, mirroring the
  // production pool-transaction semantics without a WebSocket pool (#791).
  if (_testDb) {
    const testDb = _testDb as unknown as {
      transaction: <R>(cb: (tx: TransactionClient) => Promise<R>) => Promise<R>;
    };
    const afterCommit: Array<() => void> = [];
    const result = await testDb.transaction((tx) =>
      txStorage.run({ tx, afterCommit }, () => fn(tx)),
    );
    for (const cb of afterCommit) cb();
    return result;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  // The Pool driver speaks the Postgres wire protocol over a WebSocket; in a
  // Node runtime it needs an explicit WebSocket constructor.
  if (!neonConfig.webSocketConstructor) {
    neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const afterCommit: Array<() => void> = [];
  try {
    const poolDb = drizzlePool(pool, { schema });
    const result = await poolDb.transaction((tx) =>
      txStorage.run({ tx, afterCommit }, () => fn(tx)),
    );
    // The transaction committed; run post-commit work outside the transaction
    // context so getDb() resolves to the base connection for it.
    for (const cb of afterCommit) cb();
    return result;
  } finally {
    await pool.end();
  }
}

// Registers `fn` to run after the current transaction commits. Inside a
// runInPoolTransaction() the callback is queued and fired only on success;
// outside any transaction it runs immediately. Used for fire-and-forget work
// (e.g. agent hooks) that must observe committed data and must not be emitted
// for a transaction that later rolls back.
export function afterTransactionCommit(fn: () => void): void {
  const ctx = txStorage.getStore();
  if (ctx) {
    ctx.afterCommit.push(fn);
  } else {
    fn();
  }
}
