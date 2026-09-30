/**
 * `getNeonClient()` under the integration harness.
 *
 * Several routes reach for the raw neon tagged template rather than the query
 * builder — `api/_lib/verification-levels.ts` resolves a factId through a
 * `DISTINCT ON` with a lateral subquery, `api/agent-sweep.ts` and
 * `api/admin.ts` do similar. Those are raw SQL precisely because the query is
 * doing something the builder cannot express, which makes them exactly the
 * wrong set of routes to have no end-to-end coverage for.
 *
 * They had none: `getDb()` returns the injected PGlite database and never
 * initialises `_sql`, so `getNeonClient()` returned null and every caller died
 * with "sql is not a function" from inside the route. The shim drives the same
 * template through drizzle's `sql`, and this pins its behaviour — including the
 * two things it deliberately does not support.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getNeonClient } from '../../api/_lib/db.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

describe('the tagged template', () => {
  it('returns rows, not a driver envelope', async () => {
    const sql = getNeonClient();
    const rows = (await sql`SELECT 1 AS one`) as Array<{ one: number }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]!.one).toBe(1);
  });

  it('binds interpolated values as parameters, not as text', async () => {
    // The property that matters most and is easiest to get wrong: a
    // hand-rolled `$1` counter that pasted values into the string would
    // produce the same answer here and a SQL injection everywhere else. The
    // value below is only harmless if it was bound.
    const sql = getNeonClient();
    const hostile = "1; DROP TABLE users; --";
    const rows = (await sql`SELECT ${hostile}::text AS value`) as Array<{
      value: string;
    }>;
    expect(rows[0]!.value).toBe(hostile);
    // …and the table it names is still there.
    const still = (await sql`SELECT count(*)::int AS n FROM users`) as Array<{
      n: number;
    }>;
    expect(still[0]!.n).toBe(0);
  });

  it('binds several values in order', async () => {
    const sql = getNeonClient();
    const rows = (await sql`SELECT ${'a'}::text AS x, ${'b'}::text AS y, ${3}::int AS z`) as Array<{
      x: string;
      y: string;
      z: number;
    }>;
    expect(rows[0]).toEqual({ x: 'a', y: 'b', z: 3 });
  });

  it('reads rows the app actually wrote', async () => {
    const userId = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'editor',
    });
    const drugId = await seedDrug(db, { slug: 'diazepam' });
    const sql = getNeonClient();
    const rows = (await sql`
      SELECT slug FROM drugs WHERE id = ${drugId}
    `) as Array<{ slug: string }>;
    expect(rows[0]!.slug).toBe('diazepam');
    const users = (await sql`
      SELECT username FROM users WHERE id = ${userId}
    `) as Array<{ username: string }>;
    expect(users[0]!.username).toBe('person');
  });

  it('returns an empty array rather than throwing when nothing matches', async () => {
    const sql = getNeonClient();
    const rows = (await sql`SELECT id FROM drugs WHERE id = ${999_999}`) as unknown[];
    expect(rows).toEqual([]);
  });
});

describe('what the shim deliberately does not do', () => {
  // Both exist on the real client and both are used in production routes. They
  // are functions that explain themselves rather than absent properties,
  // because `undefined is not a function` from three frames inside a route is
  // the failure mode this shim was added to remove.
  for (const method of ['query', 'transaction', 'unsafe'] as const) {
    it(`throws a named error from .${method}()`, () => {
      const sql = getNeonClient() as unknown as Record<string, () => unknown>;
      expect(typeof sql[method]).toBe('function');
      expect(() => sql[method]!()).toThrow(/integration harness/);
      expect(() => sql[method]!()).toThrow(new RegExp(method));
    });
  }
});
