/**
 * `nextProposedMetaPreservingConflict`, against real SQL (#1258 follow-up).
 *
 * The function decides, inside a single JSONB expression evaluated by
 * Postgres, whether a `direct_admin_write` conflict marker survives a
 * submitter/reviewer PATCH. A unit test that only inspects the generated SQL
 * TEXT cannot tell whether that expression is actually correct once it runs:
 * the "preserve" and "clear" outcomes now both live inside one CASE, chosen by
 * a real `jsonb` comparison against the row — exactly the kind of thing that
 * only shows up against a real Postgres.
 *
 * The scenario this exists to catch: a caller supplies a replacement
 * `proposedMeta` that has never heard of the `conflict` key (an ordinary
 * object, or `null`) while NOT authorized to clear the marker (no matching
 * `acknowledgedConflictId`, or no payload revision at all). The write must
 * still come out with the marker attached — because it is Postgres, not the
 * caller's `nextMeta`, that owns whether the marker survives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pendingEdits } from '../../db/schema.js';
import { nextProposedMetaPreservingConflict } from '../../api/pending-edits.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

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

const CONFLICT = {
  reason: 'direct_admin_write',
  id: 'marker-1',
  at: '2026-09-20T00:00:00.000Z',
};

async function seedConflictedEdit(userId: number): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: 88,
      parameter: 'halfLife',
      proposedValue: {
        op: 'update',
        patch: { low: 8, high: 10, median: 9, unit: 'h', citationId: 5 },
      },
      proposedMeta: { editSummary: 'From the label.', conflict: CONFLICT },
      status: 'pending',
      submittedBy: userId,
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

async function readMeta(id: number): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ proposedMeta: pendingEdits.proposedMeta })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id))
    .limit(1);
  return row!.proposedMeta as Record<string, unknown> | null;
}

async function writeWithExpr(
  id: number,
  nextMeta: unknown,
  snapshotProposedMeta: unknown,
  revisesPayload: boolean,
): Promise<void> {
  await db
    .update(pendingEdits)
    .set({
      proposedMeta: nextProposedMetaPreservingConflict(
        nextMeta,
        snapshotProposedMeta,
        revisesPayload,
      ) as never,
    })
    .where(eq(pendingEdits.id, id));
}

describe('nextProposedMetaPreservingConflict over real SQL', () => {
  // The P1 this file exists to catch (Codex review on #1292): a replacement
  // `proposedMeta` that never mentions `conflict` at all must not erase it
  // just because `revisesPayload` is false — the write has to actively carry
  // the row's marker forward, not trust the supplied JSON to already have it.
  it('KEEPS the marker when the replacement meta omits it and clearing is not authorized', async () => {
    const userId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const id = await seedConflictedEdit(userId);

    // An ordinary client payload — no idea `conflict` exists — and NOT
    // authorized to clear (revisesPayload: false, as an unacknowledged
    // revision or a bare metadata edit would compute it). The snapshot
    // mirrors the row's actual stored `proposedMeta` (conflict included) —
    // the actor saw exactly this marker and still isn't authorized to clear.
    await writeWithExpr(
      id,
      { editSummary: 'Reworded.' },
      { editSummary: 'From the label.', conflict: CONFLICT },
      false,
    );

    const meta = await readMeta(id);
    expect(meta?.conflict).toEqual(CONFLICT);
    // And the replacement content still landed — this isn't a no-op write.
    expect(meta?.editSummary).toBe('Reworded.');
  });

  it('CLEARS the marker when the replacement meta omits it but clearing IS authorized', async () => {
    const userId = await seedUser(db, {
      email: 'author2@example.com',
      username: 'author2',
      role: 'contributor',
    });
    const id = await seedConflictedEdit(userId);

    await writeWithExpr(
      id,
      { editSummary: 'Rebased.' },
      { editSummary: 'From the label.', conflict: CONFLICT },
      true,
    );

    const meta = await readMeta(id);
    expect(meta?.conflict).toBeUndefined();
    expect(meta?.editSummary).toBe('Rebased.');
  });

  it('re-applies a NEWER marker than the snapshot regardless of revisesPayload', async () => {
    const userId = await seedUser(db, {
      email: 'author3@example.com',
      username: 'author3',
      role: 'contributor',
    });
    const id = await seedConflictedEdit(userId);
    const staleSnapshot = {
      editSummary: 'From the label.',
      conflict: { reason: 'direct_admin_write', id: 'marker-0' },
    };

    // The actor's snapshot carries an OLDER marker id than the one now on the
    // row (a second direct write landed after they loaded it) — even an
    // authorized-looking clear must not win.
    await writeWithExpr(
      id,
      { editSummary: 'Rebased against the wrong version.' },
      staleSnapshot,
      true,
    );

    const meta = await readMeta(id);
    expect(meta?.conflict).toEqual(CONFLICT);
  });

  it('is a no-op on the marker when the row carries none at all', async () => {
    const userId = await seedUser(db, {
      email: 'author4@example.com',
      username: 'author4',
      role: 'contributor',
    });
    const [row] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: 89,
        parameter: 'halfLife',
        proposedValue: { op: 'update', patch: { low: 1, high: 2 } },
        proposedMeta: { editSummary: 'No conflict here.' },
        status: 'pending',
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });
    const id = row!.id;

    await writeWithExpr(id, { editSummary: 'Edited.' }, null, false);

    const meta = await readMeta(id);
    expect(meta?.conflict).toBeUndefined();
    expect(meta?.editSummary).toBe('Edited.');
  });
});
