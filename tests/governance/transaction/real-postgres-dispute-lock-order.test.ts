/**
 * #1385, the deadlock shape PGlite cannot exercise (same reason as
 * `real-postgres-deadlock.test.ts` — a single connection cannot deadlock with
 * itself).
 *
 * `resolveDisputeById` (the moderator upheld/overrule/withdraw path, which
 * upholding then chains into `returnPendingEditForUpheldDispute` for a
 * `pending_edit` target) used to lock the `disputes` row before the target's
 * source row. `lockOpenDispute` (the reconsideration path) — and every other
 * writer of these two tables (`recordVerification`, `upsertOpenDispute`) —
 * locks the source row first, dispute row second. Two backends taking the
 * same two locks in opposite order is exactly the AB-BA shape Postgres's
 * deadlock detector exists for: a moderator resolving a dispute and an agent
 * reconsidering the same one, at the same moment, could abort one request
 * with `deadlock_detected` for no reason a retry would fix.
 *
 * The fix makes `resolveDisputeById` take the same order as everyone else:
 * source row, then dispute row. This suite proves the property both ways —
 * the fixed order does not deadlock against the reconsideration order, and
 * (as a negative control, so a green first test cannot be read as "nothing
 * was contended") the pre-fix order genuinely does.
 *
 * Gated on `KINETIX_TEST_PG_URL`, same as `real-postgres-deadlock.test.ts`;
 * skips without it, never falls back to PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { disputes, pendingEdits, users } from '../../../db/schema.js';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import { resolveDisputeById } from '../../../api/_lib/disputes.js';
import { returnPendingEditForUpheldDispute } from '../../../api/_lib/upheld-dispute-return.js';
import {
  LOCK_TIMEOUT_MS,
  realPostgresUrl,
  resetRealPostgresDb,
  setupRealPostgresDb,
  teardownRealPostgresDb,
  type RealPostgresDb,
} from '../../integration/setup/real-postgres.js';

/** SQLSTATE Postgres uses for a cycle its own deadlock detector breaks. */
const DEADLOCK_DETECTED = '40P01';
/** SQLSTATE for a lock acquisition that hit this pool's `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

const hasRealPostgres = realPostgresUrl() !== null;

/** A promise plus its own resolver, for hand-off between the two sides. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * `api/disputes.ts`'s `resolveAndReturn` for an `upheld` ruling against a
 * `pending_edit` target, reproduced here rather than imported: it is a closure
 * inside the route handler, not an exported unit. This is the only shape that
 * actually chains `resolveDisputeById` into `returnPendingEditForUpheldDispute`
 * inside one transaction — the two-lock sequence #1385 is about.
 */
async function upholdAndReturn(args: {
  disputeId: number;
  resolvedBy: number;
}) {
  const resolved = await resolveDisputeById({
    id: args.disputeId,
    resolution: 'upheld',
    resolvedBy: args.resolvedBy,
  });
  if (!resolved || resolved.targetType !== 'pending_edit') return resolved;
  await returnPendingEditForUpheldDispute({
    pendingEditId: resolved.targetId,
    disputeId: resolved.id,
    source: resolved.source,
    reasonMd: resolved.reasonMd,
    evidenceRefs: resolved.evidenceRefs,
    disputeRaisedAt: resolved.createdAt,
    targetVersion: resolved.targetVersion,
    resolvedBy: args.resolvedBy,
    mayDecide: true,
    mayDecideOwn: true,
    mayDecideModelStructure: true,
  });
  return resolved;
}

describe.skipIf(!hasRealPostgres)(
  'resolveDisputeById lock order against the reconsideration path (#1385)',
  () => {
    let db: RealPostgresDb;
    let submitterId: number;
    let resolverId: number;
    let pendingEditId: number;
    let disputeId: number;

    beforeAll(async () => {
      db = await setupRealPostgresDb();
    }, 120_000);
    afterAll(async () => {
      await teardownRealPostgresDb();
    });
    beforeEach(async () => {
      await resetRealPostgresDb(db);
      const [submitter] = await db
        .insert(users)
        .values({
          email: 'submitter@example.com',
          username: 'submitter',
          role: 'contributor',
        })
        .returning({ id: users.id });
      const [resolver] = await db
        .insert(users)
        .values({
          email: 'resolver@example.com',
          username: 'resolver',
          role: 'admin',
        })
        .returning({ id: users.id });
      submitterId = submitter!.id;
      resolverId = resolver!.id;

      const [edit] = await db
        .insert(pendingEdits)
        .values({
          editType: 'wiki_fact',
          sectionId: 'pk',
          factOperation: 'add',
          factStatement: 'Halveringstiden er 8 timer.',
          proposedValue: { factStatement: 'Halveringstiden er 8 timer.' },
          submittedBy: submitterId,
          status: 'pending',
        })
        .returning({ id: pendingEdits.id });
      pendingEditId = edit!.id;

      const [dispute] = await db
        .insert(disputes)
        .values({
          targetType: 'pending_edit',
          targetId: pendingEditId,
          createdBy: resolverId,
          source: 'human',
          reasonMd: 'Kilden oppgir ikke denne halveringstiden i det hele tatt.',
          status: 'open',
        })
        .returning({ id: disputes.id });
      disputeId = dispute!.id;
    });

    it(
      'lets a concurrent reconsideration-order transaction complete instead of deadlocking',
      async () => {
        // Stands in for `lockOpenDispute`: source row first, then the dispute
        // row — the order every writer but the pre-fix moderator path takes.
        const sourceLocked = gate();
        const releaseSource = gate();

        const reconsiderationSide = runInPoolTransaction(async () => {
          await getDb().execute(
            sql`SELECT id FROM pending_edits WHERE id = ${pendingEditId} FOR UPDATE`,
          );
          sourceLocked.open();
          await releaseSource.wait;
          await getDb().execute(
            sql`SELECT id FROM disputes WHERE id = ${disputeId} FOR UPDATE`,
          );
        });

        await sourceLocked.wait;
        // The upheld path: `resolveDisputeById` locks and updates the dispute
        // row, then `returnPendingEditForUpheldDispute` locks and updates the
        // pending edit's row — both inside one transaction, exactly as
        // `api/disputes.ts`'s `resolveAndReturn` runs them. This now has to
        // wait for the source row exactly as the reconsideration side does
        // for any other writer, not race it for the dispute row in the
        // opposite direction.
        const moderatorSide = runInPoolTransaction(() =>
          upholdAndReturn({ disputeId, resolvedBy: resolverId }),
        );

        // Give the moderator side time to actually reach and block on the
        // source-row lock before the reconsideration side releases it. If the
        // fix regressed to the old order, this window is where it would
        // instead take the dispute row uncontested and "succeed" for the
        // wrong reason.
        await new Promise((resolve) => setTimeout(resolve, 300));
        releaseSource.open();

        const [reconOutcome, modOutcome] = await Promise.allSettled([
          reconsiderationSide,
          moderatorSide,
        ]);

        expect(reconOutcome.status).toBe('fulfilled');
        expect(modOutcome.status).toBe('fulfilled');
        if (modOutcome.status === 'fulfilled') {
          expect(modOutcome.value?.id).toBe(disputeId);
        }

        const [disputeRow] = await db
          .select({ status: disputes.status })
          .from(disputes)
          .where(sql`${disputes.id} = ${disputeId}`);
        expect(disputeRow?.status).toBe('resolved');
        const [editRow] = await db
          .select({ status: pendingEdits.status })
          .from(pendingEdits)
          .where(sql`${pendingEdits.id} = ${pendingEditId}`);
        expect(editRow?.status).toBe('returned');
      },
      LOCK_TIMEOUT_MS * 3,
    );

    it(
      'the pre-#1385 order (dispute row first) really does deadlock against the reconsideration order',
      async () => {
        // The negative control: without this, a reader cannot tell whether
        // the first test passed because the fix works or because nothing in
        // it was ever actually contended.
        const sourceLocked = gate();
        const disputeLocked = gate();

        const reconsiderationSide = runInPoolTransaction(async () => {
          await getDb().execute(
            sql`SELECT id FROM pending_edits WHERE id = ${pendingEditId} FOR UPDATE`,
          );
          sourceLocked.open();
          await disputeLocked.wait;
          // Waits for the old moderator order's dispute-row lock — the other
          // half of the cycle.
          await getDb().execute(
            sql`SELECT id FROM disputes WHERE id = ${disputeId} FOR UPDATE`,
          );
        });

        await sourceLocked.wait;

        const oldModeratorOrder = runInPoolTransaction(async () => {
          await getDb().execute(
            sql`SELECT id FROM disputes WHERE id = ${disputeId} FOR UPDATE`,
          );
          disputeLocked.open();
          // Waits for the reconsideration side's source-row lock, which it is
          // holding while waiting on the dispute row above: a genuine cycle.
          await getDb().execute(
            sql`SELECT id FROM pending_edits WHERE id = ${pendingEditId} FOR UPDATE`,
          );
        });

        const [reconResult, oldResult] = await Promise.allSettled([
          reconsiderationSide,
          oldModeratorOrder,
        ]);

        // Exactly one side is Postgres's chosen victim; the other completes
        // once the victim's transaction aborts and releases its locks.
        const outcomes = [reconResult, oldResult];
        const rejected = outcomes.filter(
          (o): o is PromiseRejectedResult => o.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        const code = (rejected[0]!.reason as { cause?: { code?: string } })
          ?.cause?.code;
        expect([DEADLOCK_DETECTED, LOCK_NOT_AVAILABLE]).toContain(code);
      },
      LOCK_TIMEOUT_MS * 3,
    );
  },
);
