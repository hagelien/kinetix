/**
 * §16.6, the requirement the PGlite harness cannot discharge: exercise the real
 * deadlock shape against a real Postgres.
 *
 * `connection-identity.test.ts` proves what PGlite *can* prove — that
 * `inTransaction` hands the inner helper the same client object — and says in
 * as many words why it stops there:
 *
 *   > Under PGlite everything routes through a single connection, so a nested
 *   > `runInPoolTransaction` degrades to a savepoint: `txid_current()` matches,
 *   > `pg_backend_pid()` matches, advisory locks are re-entrant [...] Every
 *   > reassuring signal is available on precisely the code that opens a second
 *   > Pool in production.
 *
 * So it deferred two things to a real server: the deadlock itself, and the
 * independent commit that makes nesting dangerous even when nothing locks.
 * Both are executed here, against real Postgres, over a real `pg` pool.
 *
 * ## Why this suite is allowed to assert `pg_backend_pid()`
 *
 * On PGlite that assertion is vacuous — one connection, so the pids match
 * however the helper opened its transaction. It is only evidence when a
 * *different* pid was reachable, which is why the first describe below spends
 * its tests establishing that the target really does hand out separate backends
 * for separate transactions. Everything after it depends on that being true,
 * and none of it should be believed if the first block is skipped.
 *
 * ## Running it
 *
 * Set `KINETIX_TEST_PG_URL` to a real server. The `migrations` workflow does
 * this from a service container; `docs/plans/2026-08-26-test-strategy-audit.md`
 * records the local recipe. Without it this suite **skips** — it never falls
 * back to PGlite, because a green run against PGlite would be the exact false
 * reassurance the suite exists to remove.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import {
  getDb,
  inTransaction,
  runInPoolTransaction,
} from '../../../api/_lib/db.js';
import { drugs, pendingEdits, wikiPages, users } from '../../../db/schema.js';
import {
  lockDrugForEntryApplicability,
  withDrugApplicabilityLock,
} from '../../../api/_lib/parameterApplicabilityStore.js';
import {
  LOCK_TIMEOUT_MS,
  REAL_PG_URL_ENV,
  realPostgresUrl,
  resetRealPostgresDb,
  setupRealPostgresDb,
  teardownRealPostgresDb,
  type RealPostgresDb,
} from '../../integration/setup/real-postgres.js';

/** SQLSTATE for a lock acquisition that hit `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

const hasRealPostgres = realPostgresUrl() !== null;

/** `pg_backend_pid()` on whatever connection `getDb()` currently resolves to. */
async function backendPid(): Promise<number> {
  const result = await getDb().execute<{ pid: number }>(
    sql`SELECT pg_backend_pid() AS pid`,
  );
  return Number(result.rows[0]!.pid);
}

describe.skipIf(!hasRealPostgres)('real-Postgres advisory lock behaviour', () => {
  let db: RealPostgresDb;
  let drugId: number;

  beforeAll(async () => {
    db = await setupRealPostgresDb();
  }, 120_000);
  afterAll(async () => {
    await teardownRealPostgresDb();
  });
  beforeEach(async () => {
    await resetRealPostgresDb(db);
    const [row] = await db
      .insert(drugs)
      .values({ slug: 'diazepam', names: { nb: 'Diazepam', en: 'Diazepam' } })
      .returning({ id: drugs.id });
    drugId = row!.id;
  });

  describe('the target itself hands out separate backends', () => {
    /**
     * Non-vacuity for everything below. If this block does not hold, the
     * target has collapsed to PGlite's single-connection behaviour and the
     * deadlock tests would pass without exercising anything.
     */
    it('gives two concurrent transactions two different backend pids', async () => {
      const pids = await Promise.all([
        runInPoolTransaction(async () => backendPid()),
        runInPoolTransaction(async () => backendPid()),
      ]);
      expect(pids[0]).not.toBe(pids[1]);
    });

    it('gives a NESTED runInPoolTransaction a different backend than its parent', async () => {
      // The production bug, reduced to the one fact that causes it. On PGlite
      // this returns equal pids; here it must not, or the deadlock below is
      // unreachable and its absence would prove nothing.
      let outer = 0;
      let inner = 0;
      await runInPoolTransaction(async () => {
        outer = await backendPid();
        await runInPoolTransaction(async () => {
          inner = await backendPid();
        });
      });
      expect(outer).toBeGreaterThan(0);
      expect(inner).not.toBe(outer);
    });

    it('is a real server, not PGlite', async () => {
      const result = await db.execute<{ version: string }>(
        sql`SELECT version() AS version`,
      );
      expect(result.rows[0]!.version).toMatch(/PostgreSQL/);
      expect(result.rows[0]!.version).not.toMatch(/PGlite/i);
    });
  });

  describe('the shape §16.6 asks for', () => {
    it('completes when the legacy helper JOINS the governance transaction', async () => {
      // Governance holds the drug's advisory lock; the legacy helper asks for
      // the same lock. Because `withDrugApplicabilityLock` goes through
      // `inTransaction`, it joins — one backend, re-entrant lock, no wait.
      //
      // The assertion §16.6 names is the pid equality, and here it is load
      // bearing: the block above established that a second backend was the
      // available alternative.
      let governancePid = 0;
      let helperPid = 0;
      let ran = false;

      await runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(drugId);
        governancePid = await backendPid();
        await withDrugApplicabilityLock(drugId, async () => {
          helperPid = await backendPid();
          ran = true;
        });
      });

      expect(ran).toBe(true);
      expect(helperPid).toBe(governancePid);
    });

    it('deadlocks when the legacy helper opens its own transaction instead', async () => {
      // The pre-conversion shape, executed rather than described. The inner
      // call takes a second connection and asks for a lock the outer
      // connection holds; the outer connection is awaiting the inner, so
      // nothing can release it. Only `lock_timeout` ends it — which is the
      // point: in production there was no timeout, and the request hung.
      //
      // This is the negative control that PGlite could not run at all: there
      // the inner call issues a second top-level BEGIN on the one connection
      // and the test never returns.
      const startedAt = performance.now();
      const attempt = runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(drugId);
        // Deliberately NOT inTransaction — this reproduces the bug.
        await runInPoolTransaction(async () => {
          await getDb().execute(
            sql`SELECT pg_advisory_xact_lock(${drugId}::bigint)`,
          );
        });
      });

      const error = await attempt.then(
        () => null,
        (e: unknown) => e as { message?: string; cause?: { code?: string } },
      );
      const waitedMs = performance.now() - startedAt;

      // It failed, and it failed *for the right reason*: drizzle wraps the
      // driver error, so the SQLSTATE is on the cause.
      expect(error).not.toBeNull();
      expect(error!.cause?.code).toBe(LOCK_NOT_AVAILABLE);
      // ...and on the right statement. Without this the assertion would also
      // accept a timeout on some unrelated query in the nested unit.
      expect(error!.message).toContain('pg_advisory_xact_lock');
      // ...and it genuinely *waited* rather than erroring straight out. An
      // immediate failure would mean the lock was never contended and this
      // test proved nothing about blocking. The margin is generous because the
      // claim is "it waited out the timeout", not "it waited precisely 4s".
      expect(waitedMs).toBeGreaterThan(LOCK_TIMEOUT_MS * 0.8);
    }, LOCK_TIMEOUT_MS * 3);

    it('does not block when the two transactions want different drugs', async () => {
      // Keeps the test above honest: it must fail because of *this drug's*
      // lock, not because any nested transaction blocks for some other reason.
      const [other] = await db
        .insert(drugs)
        .values({ slug: 'oksazepam', names: { nb: 'Oksazepam', en: 'Oxazepam' } })
        .returning({ id: drugs.id });

      let inner = 0;
      let outer = 0;
      await runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(drugId);
        outer = await backendPid();
        await runInPoolTransaction(async () => {
          await getDb().execute(
            sql`SELECT pg_advisory_xact_lock(${other!.id}::bigint)`,
          );
          inner = await backendPid();
        });
      });

      // It completed — and on a genuinely different connection, which is what
      // made the same-drug case above a deadlock rather than a slow path.
      expect(inner).not.toBe(outer);
    }, LOCK_TIMEOUT_MS * 3);
  });

  describe('the other half of why nesting is dangerous', () => {
    it('a NESTED runInPoolTransaction survives the outer rollback', async () => {
      // `connection-identity.test.ts` records this as unprovable under PGlite:
      // "where it degrades to a savepoint it rolls back with its parent
      // anyway". On a real pool the inner unit commits on its own connection,
      // so an outer failure leaves the inner write standing — a torn unit of
      // work, with no error anywhere to say so.
      const [user] = await db
        .insert(users)
        .values({
          email: 'nest@example.com',
          username: 'nest',
          role: 'contributor',
        })
        .returning({ id: users.id });
      const [page] = await db
        .insert(wikiPages)
        .values({
          slug: 'diazepam-nest',
          title: 'Diazepam',
          content: { type: 'doc', content: [] },
          status: 'published',
          createdBy: user!.id,
          updatedBy: user!.id,
        })
        .returning({ id: wikiPages.id });

      await expect(
        runInPoolTransaction(async () => {
          await runInPoolTransaction(async () => {
            await getDb().insert(pendingEdits).values({
              editType: 'wiki_fact',
              targetId: page!.id,
              sectionId: 'pk',
              factOperation: 'add',
              factStatement: 'Skrevet av en nestet transaksjon.',
              proposedValue: {
                factStatement: 'Skrevet av en nestet transaksjon.',
              },
              submittedBy: user!.id,
              status: 'pending',
            });
          });
          throw new Error('deliberate failure after the inner write');
        }),
      ).rejects.toThrow('deliberate failure');

      const rows = await db.select({ id: pendingEdits.id }).from(pendingEdits);
      // The damage, asserted rather than argued: the outer unit rolled back and
      // the inner write is still there.
      expect(rows).toHaveLength(1);
    });

    it('a JOINED helper rolls back with the outer transaction', async () => {
      // The converted behaviour, on the same server, for contrast: one
      // connection, one unit of work, nothing left behind.
      const [user] = await db
        .insert(users)
        .values({
          email: 'join@example.com',
          username: 'join',
          role: 'contributor',
        })
        .returning({ id: users.id });
      const [page] = await db
        .insert(wikiPages)
        .values({
          slug: 'diazepam-join',
          title: 'Diazepam',
          content: { type: 'doc', content: [] },
          status: 'published',
          createdBy: user!.id,
          updatedBy: user!.id,
        })
        .returning({ id: wikiPages.id });

      await expect(
        runInPoolTransaction(async () => {
          await inTransaction(async () => {
            await getDb().insert(pendingEdits).values({
              editType: 'wiki_fact',
              targetId: page!.id,
              sectionId: 'pk',
              factOperation: 'add',
              factStatement: 'Skal rulles tilbake.',
              proposedValue: { factStatement: 'Skal rulles tilbake.' },
              submittedBy: user!.id,
              status: 'pending',
            });
          });
          throw new Error('deliberate failure after the inner write');
        }),
      ).rejects.toThrow('deliberate failure');

      const rows = await db.select({ id: pendingEdits.id }).from(pendingEdits);
      expect(rows).toEqual([]);
    });
  });
});

describe('the real-Postgres target stays wired up', () => {
  /**
   * The suite above skips when `KINETIX_TEST_PG_URL` is absent, and a skipped
   * suite is indistinguishable from a passing one in a CI summary. This block
   * always runs, and fails if the wiring that supplies the URL is removed — so
   * losing the coverage is a red build rather than a quieter one.
   */
  const WORKFLOW = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'migrations.yml',
  );

  it('the migrations workflow still runs a Postgres service', () => {
    const source = fs.readFileSync(WORKFLOW, 'utf8');
    expect(source).toMatch(/^\s*services:/m);
    // The image, not a bare `postgres:` — the connection string in the same
    // file contains that, so the looser pattern would keep passing after the
    // service block was deleted.
    expect(source).toMatch(/image:\s*postgres:\d+/);
  });

  it(`the migrations workflow still sets ${REAL_PG_URL_ENV}`, () => {
    const source = fs.readFileSync(WORKFLOW, 'utf8');
    expect(source).toContain(REAL_PG_URL_ENV);
  });

  it('reports whether this run exercised a real server', () => {
    // Not an assertion about the environment — a local run without Postgres is
    // legitimate. It puts the fact in the output so a green run is never read
    // as "the deadlock shape was checked" when it was skipped.
    const status = hasRealPostgres
      ? `real Postgres via ${REAL_PG_URL_ENV}`
      : `SKIPPED: ${REAL_PG_URL_ENV} not set, deadlock shape NOT exercised`;
    expect(status).toBeTruthy();
    if (!hasRealPostgres) {
      console.warn(`[§16.6] ${status}`);
    }
  });
});
