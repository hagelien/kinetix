/**
 * §12.3.1 / §16.6: legacy apply helpers must **join** an ambient transaction,
 * not open a second one.
 *
 * This is the prerequisite Phase 8 cannot start without, and it is the one
 * property in this whole migration that the integration harness cannot detect
 * by ordinary means.
 *
 * ## Why "it ran in a transaction" is not the assertion
 *
 * Under PGlite everything routes through a single connection, so a nested
 * `runInPoolTransaction` degrades to a **savepoint**: `txid_current()` matches,
 * `pg_backend_pid()` matches, advisory locks are re-entrant, and the rollback
 * test passes. Every reassuring signal is available on precisely the code that
 * opens a second Pool — on a different connection — in production, where it
 * blocks on the locks the outer connection holds and hangs until timeout. That
 * is how the monograph-creation path went down.
 *
 * The assertion that *does* discriminate is **client object identity**. A
 * nested `runInPoolTransaction` allocates a fresh transaction client and a
 * fresh `txStorage` context even on PGlite, so `getDb()` inside the helper
 * returns a different object than `getDb()` at the outer layer. `inTransaction`
 * returns the same one. That difference survives the savepoint degradation, and
 * it is what these tests check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  getDb,
  inTransaction,
  isInPoolTransaction,
  runInPoolTransaction,
} from '../../../api/_lib/db.js';
import { pendingEdits, wikiPages } from '../../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

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

describe('client identity across a joined transaction', () => {
  it('inTransaction hands the inner helper the SAME client object', async () => {
    // The assertion Phase 8 depends on. `toBe`, not `toEqual`: object identity
    // is the whole point, and two different transaction clients would compare
    // equal on every field that matters to a value comparison.
    let outer: unknown;
    let inner: unknown;
    await runInPoolTransaction(async () => {
      outer = getDb();
      await inTransaction(async () => {
        inner = getDb();
      });
    });
    expect(inner).toBe(outer);
  });

  it('the ambient client is a different object from the base client', async () => {
    // What makes the assertion above discriminating rather than vacuous:
    // `getDb()` genuinely returns different objects depending on the
    // transaction context, so "same object" is a real claim about joining and
    // not something that would hold however the helper opened its transaction.
    const base = getDb();
    let inside: unknown;
    await runInPoolTransaction(async () => {
      inside = getDb();
    });
    expect(inside).not.toBe(base);
  });

  // NOT executed: nesting `runInPoolTransaction` inside itself.
  //
  // It is the production bug's exact shape, and the obvious negative control —
  // but running it under this harness **hangs**. PGlite has one connection, and
  // the inner call issues a second top-level `BEGIN` on it rather than the
  // savepoint a nested drizzle transaction object would produce, so the test
  // never returns and CI reads a timeout rather than a failure.
  //
  // That hang is itself evidence for the conversion, and it is why the check
  // that ships *here* is the client-identity assertion above plus the static
  // sweep below: both fail fast and describe the problem, where executing the
  // nesting only stops responding.
  //
  // The real exercise now exists — `real-postgres-deadlock.test.ts` runs this
  // shape against a real server, where the inner call takes a second
  // connection and the advisory lock genuinely blocks. It is a separate file
  // because it needs a Postgres this harness does not have, and it skips
  // without one.

  it('inTransaction opens one when there is no ambient transaction', async () => {
    // What keeps the conversion behaviour-preserving for every existing
    // endpoint: a standalone call still gets its own transaction.
    expect(isInPoolTransaction()).toBe(false);
    let insideWasTransactional = false;
    await inTransaction(async () => {
      insideWasTransactional = isInPoolTransaction();
    });
    expect(insideWasTransactional).toBe(true);
    expect(isInPoolTransaction()).toBe(false);
  });

  it('reports the ambient context to the joined helper', async () => {
    let seen = false;
    await runInPoolTransaction(async () => {
      await inTransaction(async () => {
        seen = isInPoolTransaction();
      });
    });
    expect(seen).toBe(true);
  });
});

describe('the converted apply paths join rather than nest', () => {
  /**
   * Read the three files §12.3.1 names and assert they no longer open their own
   * Pool. A static check rather than a runtime one because the failure is a
   * *hang*: a runtime test of the real thing would time out rather than fail,
   * and a timeout in CI reads as flake.
   */
  const CONVERTED = [
    'api/_lib/pending-edits-helpers.ts',
    'api/drug-parameter.ts',
    'api/parameter-entries.ts',
    // Added after the real-Postgres suite (real-postgres-deadlock.test.ts)
    // showed this file was the one that actually deadlocks: reverting
    // `withDrugApplicabilityLock` to `runInPoolTransaction` hangs the
    // governance apply path on a real server, and every test in this file
    // still passed, because it is in neither the list above nor the
    // knowledge-governance sweep below. The runtime proof needs a real
    // Postgres; this static line does not, so it holds on every PR.
    'api/_lib/parameterApplicabilityStore.ts',
  ];

  it.each(CONVERTED)('%s is in the path filter that runs this test', (file) => {
    // The guard above is worthless on the PR that breaks it unless changing
    // the guarded file actually starts the job that runs it. It did not:
    // `migrations` is the only workflow that runs this suite, and until its
    // filter listed these paths a PR reintroducing the nesting started
    // `scripts-typecheck` and `server-shared-esm` — both of which cover
    // `api/**`, neither of which runs these tests.
    //
    // Asserted rather than commented so that adding a file to CONVERTED
    // without adding it to the filter fails here instead of quietly removing
    // the coverage.
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'migrations.yml'),
      'utf8',
    );
    expect(workflow).toContain(`- '${file}'`);
  });

  it('the governance suite itself is in that path filter', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'migrations.yml'),
      'utf8',
    );
    // Both the pull_request and the push filter — a guard that runs on PRs but
    // not on merges to main lets the regression land anyway.
    expect([...workflow.matchAll(/- 'tests\/governance\/\*\*'/g)]).toHaveLength(2);
  });

  it.each(CONVERTED)('%s calls inTransaction, never runInPoolTransaction', (file) => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', file),
      'utf8',
    );
    const calls = [...source.matchAll(/\brunInPoolTransaction\s*[<(]/g)];
    expect(calls).toEqual([]);
    expect(source).toContain('inTransaction');
  });
});

describe('governance code never opens its own Pool', () => {
  /**
   * §12.3.1 rule 5, as the cheap static test the plan suggests: an adapter that
   * called `runInPoolTransaction` would reintroduce the nesting the conversion
   * just removed, and it would do it in the newest, least-reviewed code.
   */
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('no file under api/_lib/knowledge-governance/ calls runInPoolTransaction', () => {
    const root = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'api',
      '_lib',
      'knowledge-governance',
    );
    const offenders = walk(root).filter((file) =>
      /\brunInPoolTransaction\s*[<(]/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('finds files to check, so a moved directory fails loudly', () => {
    // Guard the guard: an empty sweep would pass forever.
    const root = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'api',
      '_lib',
      'knowledge-governance',
    );
    expect(walk(root).length).toBeGreaterThan(10);
  });
});

describe('atomicity of a joined unit of work', () => {
  it('rolls back the inner helper with the outer transaction', async () => {
    // Evidence of atomicity, and deliberately NOT evidence that one connection
    // was used: under PGlite a nested savepoint also rolls back with its
    // parent. The identity assertions above are what prove the connection.
    const userId = await seedUser(db, {
      email: 'a@example.com',
      username: 'a',
      role: 'contributor',
    });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        content: { type: 'doc', content: [] },
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
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
            submittedBy: userId,
            status: 'pending',
          });
        });
        throw new Error('deliberate failure after the inner write');
      }),
    ).rejects.toThrow('deliberate failure');

    const rows = await db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(eq(pendingEdits.targetId, page!.id));
    expect(rows).toEqual([]);
  });

  // NOT covered here: that a nested `runInPoolTransaction` would *survive* an
  // outer rollback. Under PGlite the nested call cannot even be executed (see
  // above), and where it degrades to a savepoint it rolls back with its parent
  // anyway — so the harness has no way to demonstrate the independent commit
  // that makes nesting dangerous in production. §16.6 reserves that, and the
  // real deadlock shape, for a real-Postgres run. The client-identity
  // assertions are what this harness can prove, and they are the ones that
  // discriminate.
});
