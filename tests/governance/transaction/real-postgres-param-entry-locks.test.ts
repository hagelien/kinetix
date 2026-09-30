/**
 * Cmax release B (#1340): a `param_entry` proposal that names drugs in its
 * dose context (administeredDrugId / interactingDrugId) races a delete or a
 * merge of one of those drugs, on two real connections.
 *
 * RFC *Owner review of the locking design*, amendment 5: the concurrency
 * tests must not rely on PGlite alone, which has one connection and so can
 * neither block nor deadlock. The outcomes asserted are the exhaustive pair
 * the protocol promises:
 *
 *   - author first  → the removal waits, then sees the proposal (the delete
 *                      refuses; the merge repoints it);
 *   - removal first → the author waits, then re-reads and refuses the write.
 *
 * Never a committed proposal naming a drug that no longer exists, and never
 * a deadlock — including for an UPDATE proposal, whose owning drug is read
 * off the entry rather than off `target_id`.
 *
 * Skips without `KINETIX_TEST_PG_URL`, never falling back to PGlite; the
 * `migrations` workflow runs it against a service container (asserted below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import drugsHandler from '../../../api/drugs.js';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import { DrugMergeDataConflictError, mergeDrugs } from '../../../api/_lib/drug-merge.js';
import {
  withParamEntryPayloadLocks,
  type ParamEntryLockedResult,
} from '../../../api/_lib/param-entry-payload-locks.js';
import { lockDrugForEntryApplicability } from '../../../api/_lib/parameterApplicabilityStore.js';
import {
  citations,
  drugs,
  parameterEntries,
  pendingEdits,
  users,
} from '../../../db/schema.js';
import {
  REAL_PG_URL_ENV,
  realPostgresUrl,
  resetRealPostgresDb,
  setupRealPostgresDb,
  teardownRealPostgresDb,
  type RealPostgresDb,
} from '../../integration/setup/real-postgres.js';

const hasRealPostgres = realPostgresUrl() !== null;

/** A promise plus the function that settles it — a gate one side waits on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Resolves with 'pending' if `p` has not settled within `ms`. */
async function stillPending(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([
    p.then(
      () => null,
      () => null,
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
  ]);
  return winner === marker;
}

describe.skipIf(!hasRealPostgres)('param_entry nested drug references under real concurrency', () => {
  let db: RealPostgresDb;
  let userId: number;
  let citationId: number;

  beforeAll(async () => {
    db = await setupRealPostgresDb();
  }, 120_000);
  afterAll(async () => {
    await teardownRealPostgresDb();
  });
  beforeEach(async () => {
    await resetRealPostgresDb(db);
    const [user] = await db
      .insert(users)
      .values({ email: 'admin@example.com', username: 'admin', role: 'admin' })
      .returning({ id: users.id });
    userId = user!.id;
    const [cite] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/cmax', metadata: {} })
      .returning({ id: citations.id });
    citationId = cite!.id;
    authMock.mockReset();
  });

  async function seedDrug(slug: string): Promise<number> {
    const [row] = await db
      .insert(drugs)
      .values({ slug, names: { nb: slug, en: slug } })
      .returning({ id: drugs.id });
    return row!.id;
  }

  function cmaxCreate(analyte: number, administeredDrugId: number) {
    return {
      op: 'create' as const,
      input: {
        drugId: analyte,
        parameter: 'cmax',
        citationId,
        unit: 'ng/mL',
        matrix: 'plasma',
        centralValue: 84,
        centralStatistic: 'arithmetic_mean',
        valueBasis: 'concentration',
        doseValue: 2,
        doseUnit: 'mg',
        administeredDrugId,
      },
    };
  }

  /**
   * Write a create proposal under the protocol, holding the transaction open
   * on `hold` after the insert so the other side can be observed waiting.
   */
  function authorCreate(
    analyte: number,
    administered: number,
    hold?: Promise<void>,
    onLocked?: () => void,
  ): Promise<ParamEntryLockedResult<number>> {
    const proposedValue = cmaxCreate(analyte, administered);
    return runInPoolTransaction(() =>
      withParamEntryPayloadLocks(
        { op: 'create', targetId: analyte, proposedValue },
        async () => {
          const [row] = await getDb()
            .insert(pendingEdits)
            .values({
              editType: 'param_entry',
              targetId: analyte,
              parameter: 'cmax',
              referenceId: citationId,
              referenceIds: [citationId],
              proposedValue: proposedValue as never,
              status: 'pending',
              submittedBy: userId,
            })
            .returning({ id: pendingEdits.id });
          onLocked?.();
          if (hold) await hold;
          return row!.id;
        },
      ),
    );
  }

  async function deleteDrug(id: number) {
    const state = { statusCode: 200, body: '' };
    const res = {
      headersSent: false,
      setHeader: vi.fn(),
      writeHead: vi.fn((statusCode: number) => {
        state.statusCode = statusCode;
        return res;
      }),
      end: vi.fn((body?: string) => {
        state.body = body ?? '';
        return res;
      }),
    } as unknown as ServerResponse;
    const req = Readable.from(['']) as IncomingMessage;
    req.method = 'DELETE';
    req.url = `/api/drugs?id=${id}`;
    req.headers = { host: 'localhost', origin: 'http://localhost' };
    authMock.mockResolvedValue({ userId, role: 'admin' });
    await drugsHandler(req, res);
    return state;
  }

  async function exists(id: number): Promise<boolean> {
    return (await db.select({ id: drugs.id }).from(drugs).where(eq(drugs.id, id))).length > 0;
  }

  // Amendment 4: the primitive JOINS its caller's transaction. A nested pool
  // transaction would be a second backend here (the deadlock suite proves the
  // target hands one out), and one asking for an advisory lock its caller
  // already holds waits forever.
  it('runs on its caller\'s connection, not a second one', async () => {
    const analyte = await seedDrug('kokain');
    const pid = async () =>
      Number(
        (await getDb().execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!
          .pid,
      );
    let outer = 0;
    let inner = 0;
    await runInPoolTransaction(async () => {
      await lockDrugForEntryApplicability(analyte);
      outer = await pid();
      await withParamEntryPayloadLocks(
        { op: 'create', targetId: analyte, proposedValue: cmaxCreate(analyte, analyte) },
        async () => {
          inner = await pid();
        },
      );
    });
    expect(outer).toBeGreaterThan(0);
    expect(inner).toBe(outer);
  });

  it('author first: the delete waits for the proposal, then refuses', async () => {
    const analyte = await seedDrug('benzoylekgonin');
    const parent = await seedDrug('kokain');
    const release = gate();
    const locked = gate();

    const author = authorCreate(analyte, parent, release.wait, locked.open);
    await locked.wait;
    const deletion = deleteDrug(parent);
    expect(await stillPending(deletion)).toBe(true);
    release.open();

    const authored = await author;
    expect(authored.refused).toBeNull();
    const state = await deletion;
    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('drug_named_by_open_proposals');
    expect(await exists(parent)).toBe(true);
  });

  it('delete first: the author waits for the delete, then refuses', async () => {
    const analyte = await seedDrug('benzoylekgonin');
    const parent = await seedDrug('kokain');
    const release = gate();
    const locked = gate();

    // The delete path's protocol, held open: its lock on the drug, then the
    // row gone. The handler cannot be paused mid-transaction, so this stages
    // exactly what it does under the same lock.
    const deletion = runInPoolTransaction(async () => {
      await lockDrugForEntryApplicability(parent);
      await getDb().delete(drugs).where(eq(drugs.id, parent));
      locked.open();
      await release.wait;
    });
    await locked.wait;
    const author = authorCreate(analyte, parent);
    expect(await stillPending(author)).toBe(true);
    release.open();
    await deletion;

    expect(await author).toEqual({ refused: 'drug_missing', drugId: parent });
    expect(await db.select().from(pendingEdits)).toEqual([]);
  });

  it('author first: the merge waits for the proposal, then repoints it', async () => {
    const analyte = await seedDrug('benzoylekgonin');
    const winner = await seedDrug('kokain');
    const loser = await seedDrug('kokain-dup');
    const release = gate();
    const locked = gate();

    const author = authorCreate(analyte, loser, release.wait, locked.open);
    await locked.wait;
    const merge = runInPoolTransaction(() =>
      mergeDrugs(getDb(), {
        winnerId: winner,
        loserId: loser,
        resolutions: {},
        actorUserId: userId,
        approvedPlanFingerprint: null,
      }),
    );
    expect(await stillPending(merge)).toBe(true);
    release.open();

    const authored = await author;
    await merge;
    expect(authored.refused).toBeNull();
    const [edit] = await db
      .select({ value: pendingEdits.proposedValue })
      .from(pendingEdits);
    expect((edit!.value as { input: { administeredDrugId: number } }).input.administeredDrugId).toBe(
      winner,
    );
    expect(await exists(loser)).toBe(false);
  });

  it('merge first: the author waits for the merge, then refuses', async () => {
    const analyte = await seedDrug('benzoylekgonin');
    const winner = await seedDrug('kokain');
    const loser = await seedDrug('kokain-dup');
    const release = gate();
    const merged = gate();

    const merge = runInPoolTransaction(async () => {
      await mergeDrugs(getDb(), {
        winnerId: winner,
        loserId: loser,
        resolutions: {},
        actorUserId: userId,
        approvedPlanFingerprint: null,
      });
      merged.open();
      await release.wait;
    });
    await merged.wait;
    const author = authorCreate(analyte, loser);
    expect(await stillPending(author)).toBe(true);
    release.open();
    await merge;

    expect(await author).toEqual({ refused: 'drug_missing', drugId: loser });
  });

  // The ABBA case the sorted lock set exists for, driven through an UPDATE —
  // the op whose target is an entry, so the owner must be read off the row
  // and join the sort. Entry owned by A, naming B; merge of B into A (and the
  // reverse id order). Both sides take ascending locks, so neither can hold
  // one the other needs while waiting for the second.
  it.each([
    ['owner id above the nested id', true],
    ['owner id below the nested id', false],
  ])('an update proposal racing a merge does not deadlock (%s)', async (_label, ownerHigh) => {
    const first = await seedDrug('first');
    const second = await seedDrug('second');
    const [owner, nested] = ownerHigh ? [second, first] : [first, second];
    const [entry] = await db
      .insert(parameterEntries)
      .values({ drugId: owner, parameter: 'tmax', unit: 'h', low: '1', high: '2' })
      .returning({ id: parameterEntries.id });
    const proposedValue = { op: 'update', patch: { administeredDrugId: nested } };

    const results = await Promise.allSettled([
      runInPoolTransaction(() =>
        withParamEntryPayloadLocks(
          { op: 'update', targetId: entry!.id, proposedValue },
          async () => {
            await new Promise((r) => setTimeout(r, 150));
            return 'written';
          },
        ),
      ),
      runInPoolTransaction(() =>
        mergeDrugs(getDb(), {
          winnerId: owner,
          loserId: nested,
          resolutions: {},
          actorUserId: userId,
          approvedPlanFingerprint: null,
        }),
      ),
    ]);

    // Neither side died on a deadlock (40P01) or a lock timeout (55P03); the
    // author either wrote before the merge or was refused after it.
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    const authored = (results[0] as PromiseFulfilledResult<ParamEntryLockedResult<string>>).value;
    expect([null, 'drug_missing']).toContain(authored.refused);
  });

  // Codex review on #1368: the third-party duplicate preflight reads entries
  // of OTHER drugs that name the winner or loser. Unless the merge locks them
  // first, a concurrent edit can make two of them identical after the scan
  // passed, and the repoint then commits one observation twice. With the lock
  // the merge waits for the edit, and its preflight sees the duplicate.
  it('locks third-party entries naming either side before the duplicate preflight', async () => {
    const metabolite = await seedDrug('benzoylekgonin');
    const winner = await seedDrug('kokain');
    const loser = await seedDrug('kokain-dup');
    const seed = async (administeredDrugId: number, low: string) => {
      const [row] = await db
        .insert(parameterEntries)
        .values({
          // A well-formed Cmax row (migration 0129 requires the administered
          // drug, a value basis and, for a concentration, its dose; it forbids
          // dose context elsewhere).
          drugId: metabolite,
          parameter: 'cmax',
          unit: 'ng/mL',
          matrix: 'plasma',
          low,
          high: '20',
          intervalKind: 'range',
          valueBasis: 'concentration',
          doseValue: '2',
          doseUnit: 'mg',
          administeredDrugId,
          createdBy: userId,
        })
        .returning({ id: parameterEntries.id });
      return row!.id;
    };
    await seed(loser, '1');
    const edited = await seed(winner, '1.5');
    const release = gate();
    const locked = gate();

    // An ordinary edit to one of them, held open with its row locked, that
    // makes it identical to the other once the loser reads as the winner.
    const edit = runInPoolTransaction(async () => {
      await getDb().execute(
        sql`SELECT 1 FROM parameter_entries WHERE id = ${edited} FOR UPDATE`,
      );
      locked.open();
      await release.wait;
      await getDb()
        .update(parameterEntries)
        .set({ low: '1' })
        .where(eq(parameterEntries.id, edited));
    });
    await locked.wait;
    const merge = runInPoolTransaction(() =>
      mergeDrugs(getDb(), {
        winnerId: winner,
        loserId: loser,
        resolutions: {},
        actorUserId: userId,
        approvedPlanFingerprint: null,
      }),
    );
    expect(await stillPending(merge)).toBe(true);
    release.open();
    await edit;

    await expect(merge).rejects.toBeInstanceOf(DrugMergeDataConflictError);
    expect(await exists(loser)).toBe(true);
  });
});

describe('the migrations workflow runs this suite against real Postgres', () => {
  it('has a database-enabled step naming this file', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'migrations.yml'),
      'utf8',
    );
    const assignment = new RegExp(`^\\s*${REAL_PG_URL_ENV}:\\s*\\S`, 'm');
    const steps = workflow
      .split(/^ {6}- name: /m)
      .filter((step) => assignment.test(step));
    expect(
      steps.some((step) =>
        step.includes('tests/governance/transaction/real-postgres-param-entry-locks.test.ts'),
      ),
    ).toBe(true);
  });
});
