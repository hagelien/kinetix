/**
 * The admin lever, as an operator reaches it.
 *
 * `setMigrationMode` already proves the §11.4 rules it enforces (see
 * tests/governance/mirror/migration-state.test.ts). What this adds is the
 * rule that function leaves to its caller — only an admin — and the report
 * that tells the operator what actually happened, kill switch and eligibility
 * included.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { kgAuditEvents, kgMigrationState } from '../../../db/governance-schema.js';
import {
  changeMigrationMode,
  describeMigrationModeChange,
  requireMigrationAdmin,
} from '../../../api/_lib/knowledge-governance/operator-migration-state.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  resolveMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { runInPoolTransaction } from '../../../api/_lib/db.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
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
  invalidateMigrationStateCache();
});
afterEach(() => {
  delete process.env[FORCE_LEGACY_ENV];
});

async function seedAdmin(): Promise<number> {
  return seedUser(db, { email: 'admin@example.com', username: 'admin', role: 'admin' });
}

describe('only an admin', () => {
  it('refuses an unknown user, writing nothing', async () => {
    await expect(
      changeMigrationMode({ targetType: 'pending_edit', mode: 'shadow', byUserId: 999 }),
    ).rejects.toThrow(/no user with id 999/);
    expect(await db.select().from(kgMigrationState)).toEqual([]);
  });

  it('refuses an editor, writing nothing', async () => {
    const editorId = await seedUser(db, {
      email: 'editor@example.com',
      username: 'editor',
      role: 'editor',
    });
    await expect(
      changeMigrationMode({ targetType: 'pending_edit', mode: 'shadow', byUserId: editorId }),
    ).rejects.toThrow(/only an 'admin'/);
    expect(await db.select().from(kgMigrationState)).toEqual([]);
    expect(await db.select().from(kgAuditEvents)).toEqual([]);
  });

  it('identifies the admin before anything is planned', async () => {
    const adminId = await seedAdmin();
    expect(await requireMigrationAdmin(db, adminId)).toEqual({ id: adminId, username: 'admin' });
  });
});

describe('the change and its report', () => {
  it('advances, audits under the admin, and reports what the request path resolves', async () => {
    const adminId = await seedAdmin();
    const result = await changeMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      byUserId: adminId,
      notes: 'start mirroring',
    });
    expect(result).toMatchObject({
      targetType: 'pending_edit',
      previous: 'legacy_only',
      mode: 'shadow',
      direction: 'advance',
      resolved: 'shadow',
      authority: null,
      warnings: [],
    });
    expect(await resolveMigrationMode('pending_edit', { db })).toBe('shadow');

    const [event] = await db
      .select()
      .from(kgAuditEvents)
      .where(eq(kgAuditEvents.eventType, 'migration_state_changed'));
    expect(event?.actorRef).toBe(`user:${adminId}`);
    expect(event?.payload).toMatchObject({ from: 'legacy_only', to: 'shadow', notes: 'start mirroring' });
  });

  it('still enforces the high-consequence guard underneath', async () => {
    const adminId = await seedAdmin();
    await expect(
      changeMigrationMode({
        targetType: 'pending_edit',
        mode: 'generic_authoritative',
        byUserId: adminId,
      }),
    ).rejects.toThrow(/cannot move from legacy_only straight to generic_authoritative/);
  });

  it('reports apply authority for an edit-type key, and rolls back the same way', async () => {
    const adminId = await seedAdmin();
    const key = applyAuthorityKey('wiki_fact');
    const advanced = await changeMigrationMode({
      targetType: key,
      mode: 'generic_authoritative',
      byUserId: adminId,
    });
    expect(advanced.direction).toBe('advance');
    expect(advanced.authority).toEqual({ authoritative: true, key, withheld: null });
    expect(advanced.warnings).toEqual([]);

    const back = await changeMigrationMode({
      targetType: key,
      mode: 'generic_read',
      byUserId: adminId,
    });
    expect(back.direction).toBe('rollback');
    expect(back.authority).toEqual({ authoritative: false, key, withheld: 'mode' });
    expect(describeMigrationModeChange(back)).toContain('generic_authoritative -> generic_read (rollback)');
  });

  it('joins the caller’s transaction rather than committing beside it', async () => {
    // `runInPoolTransaction` nested inside another one is not a nested
    // transaction — it opens a second connection whose work commits
    // independently and survives the outer rollback. A mode change that
    // outlived the unit of work that made it would be an authority change
    // nobody decided to keep.
    const adminId = await seedAdmin();
    await expect(
      runInPoolTransaction(async () => {
        // No explicit `db`: inside a unit of work the ambient `getDb()` is the
        // transaction's own client, and reaching around it to the base one
        // would be the very thing this test exists to rule out.
        await changeMigrationMode({
          targetType: 'pending_edit',
          mode: 'shadow',
          byUserId: adminId,
        });
        throw new Error('caller changed its mind');
      }),
    ).rejects.toThrow(/changed its mind/);

    // Deliberately no cache flush before this read: the point is that the
    // rolled-back transition is not being served from the process-wide mode
    // cache, which a transactional read would otherwise have populated for
    // the next ten seconds.
    expect(await resolveMigrationMode('pending_edit', { db })).toBe('legacy_only');
    expect(await db.select().from(kgMigrationState)).toEqual([]);
    expect(
      await db
        .select()
        .from(kgAuditEvents)
        .where(eq(kgAuditEvents.eventType, 'migration_state_changed')),
    ).toEqual([]);
  });

  it('reports the change it just made when it runs inside a transaction', async () => {
    // The receipt is read after the write, and inside a caller's unit of work
    // that write is not committed yet. Reading around it — through a client
    // captured before the transaction — would report the target's old mode,
    // which this function announces as the kill switch being engaged: a
    // receipt that contradicts what it just did.
    const adminId = await seedAdmin();
    const result = await runInPoolTransaction(() =>
      changeMigrationMode({
        targetType: 'pending_edit',
        mode: 'shadow',
        byUserId: adminId,
      }),
    );
    expect(result.previous).toBe('legacy_only');
    expect(result.resolved).toBe('shadow');
    expect(result.warnings).toEqual([]);
    // No manual flush: the write clears the cache on its way out, and again
    // after the outermost commit.
    expect(await resolveMigrationMode('pending_edit', { db })).toBe('shadow');
  });

  it('records a re-submitted mode as unchanged, in both the receipt and the audit', async () => {
    // Re-submitting the mode a target already has — to change its notes, say —
    // is not a retreat. The receipt and the permanent audit record have to
    // agree about that, or the trail shows a rollback nobody performed.
    const adminId = await seedAdmin();
    await changeMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      byUserId: adminId,
    });
    const again = await changeMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      byUserId: adminId,
      notes: 'same mode, new note',
    });
    expect(again.direction).toBe('unchanged');

    const events = await db
      .select()
      .from(kgAuditEvents)
      .where(eq(kgAuditEvents.eventType, 'migration_state_changed'))
      .orderBy(kgAuditEvents.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({ direction: 'advance' });
    expect(events[1]?.payload).toMatchObject({
      direction: 'unchanged',
      from: 'shadow',
      to: 'shadow',
    });
  });

  it('warns when the row says one thing and the request path another', async () => {
    const adminId = await seedAdmin();
    process.env[FORCE_LEGACY_ENV] = '1';
    const result = await changeMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      byUserId: adminId,
    });
    expect(result.resolved).toBe('legacy_only');
    expect(result.warnings.join(' ')).toMatch(/kill switch is engaged/);
  });

  it('warns when the edit type is not eligible on this build', async () => {
    const adminId = await seedAdmin();
    const result = await changeMigrationMode({
      targetType: applyAuthorityKey('wiki_section'),
      mode: 'shadow',
      byUserId: adminId,
    });
    expect(result.authority).toEqual({
      authoritative: false,
      key: 'pending_edit:wiki_section',
      withheld: 'not_eligible',
    });
    expect(result.warnings.join(' ')).toMatch(/not in CUTOVER_ELIGIBLE_EDIT_TYPES/);
  });
});
