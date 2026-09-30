import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionOverrideHistory, permissionOverrides } from '../../db/schema.js';
import {
  applyPermissionChange,
  applyPermissionChanges,
  callerCan,
  getPermissionMatrix,
  listPermissionHistory,
  loadPermissionOverrides,
  resetPermissionOverridesForTests,
} from '../../api/_lib/permissions-store.js';
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
  resetPermissionOverridesForTests();
});

describe('permission overrides over real SQL', () => {
  it('starts empty, so every capability answers with its shipped default', async () => {
    expect(await loadPermissionOverrides()).toEqual({});
    expect(await callerCan('contributor', 'review.edit.decide')).toBe(false);
    expect(await callerCan('editor', 'review.edit.decide')).toBe(true);
    expect(await callerCan('editor', 'edit.directWrite')).toBe(false);
  });

  it('lowers a capability and the change takes effect on the next check', async () => {
    const actorId = await seedUser(db);

    const result = await applyPermissionChange({
      capability: 'review.edit.decide',
      tier: 'contributor',
      actorId,
    });

    expect(result).toMatchObject({ ok: true, minTier: 'contributor', isDefault: false });
    expect(await callerCan('contributor', 'review.edit.decide')).toBe(true);
    // Unrelated capabilities keep their defaults.
    expect(await callerCan('contributor', 'edit.directWrite')).toBe(false);
  });

  it('raises a capability so a tier that used to hold it loses it', async () => {
    const actorId = await seedUser(db);

    await applyPermissionChange({
      capability: 'edit.parameter.submit',
      tier: 'editor',
      actorId,
    });

    expect(await callerCan('contributor', 'edit.parameter.submit')).toBe(false);
    expect(await callerCan('editor', 'edit.parameter.submit')).toBe(true);
  });

  it('clears the row when a capability is set back to its default', async () => {
    const actorId = await seedUser(db);

    await applyPermissionChange({
      capability: 'methods.write',
      tier: 'contributor',
      actorId,
    });
    const stored = await db
      .select()
      .from(permissionOverrides)
      .where(eq(permissionOverrides.capability, 'methods.write'));
    expect(stored).toHaveLength(1);

    await applyPermissionChange({
      capability: 'methods.write',
      tier: 'editor',
      actorId,
    });

    expect(
      await db
        .select()
        .from(permissionOverrides)
        .where(eq(permissionOverrides.capability, 'methods.write')),
    ).toHaveLength(0);
    expect(await callerCan('contributor', 'methods.write')).toBe(false);
  });

  it('refuses a locked capability and a tier below the floor', async () => {
    const actorId = await seedUser(db);

    expect(
      await applyPermissionChange({
        capability: 'admin.permissions.manage',
        tier: 'editor',
        actorId,
      }),
    ).toEqual({
      ok: false,
      reason: 'locked_capability',
      capability: 'admin.permissions.manage',
    });

    expect(
      await applyPermissionChange({
        capability: 'edit.directWrite',
        tier: 'contributor',
        actorId,
      }),
    ).toEqual({
      ok: false,
      reason: 'below_floor',
      capability: 'edit.directWrite',
    });

    expect(await db.select().from(permissionOverrides)).toHaveLength(0);
    expect(await callerCan('editor', 'admin.permissions.manage')).toBe(false);
  });

  it('writes nothing when any row in a batch is refused', async () => {
    const actorId = await seedUser(db);

    const result = await applyPermissionChanges({
      actorId,
      changes: [
        { capability: 'methods.write', tier: 'contributor' },
        { capability: 'dispute.resolve', tier: 'contributor' },
        // Refused: a stale client naming a capability that is locked.
        { capability: 'admin.users.manage', tier: 'editor' },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'locked_capability',
      capability: 'admin.users.manage',
    });
    // The two valid rows preceding the bad one must not have landed.
    expect(await db.select().from(permissionOverrides)).toHaveLength(0);
    expect(await db.select().from(permissionOverrideHistory)).toHaveLength(0);
    expect(await callerCan('contributor', 'methods.write')).toBe(false);
  });

  it('commits every change in a batch together with its audit rows', async () => {
    const actorId = await seedUser(db);

    const result = await applyPermissionChanges({
      actorId,
      changes: [
        { capability: 'methods.write', tier: 'contributor' },
        { capability: 'wiki.draft.read', tier: 'contributor' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(await db.select().from(permissionOverrides)).toHaveLength(2);
    expect(await db.select().from(permissionOverrideHistory)).toHaveLength(2);
    expect(await callerCan('contributor', 'methods.write')).toBe(true);
    expect(await callerCan('contributor', 'wiki.draft.read')).toBe(true);
  });

  it('records an audit row for every real change and none for a no-op', async () => {
    const actorId = await seedUser(db);

    await applyPermissionChange({
      capability: 'dispute.resolve',
      tier: 'contributor',
      actorId,
    });
    await applyPermissionChange({
      capability: 'dispute.resolve',
      tier: 'contributor',
      actorId,
    });
    await applyPermissionChange({
      capability: 'dispute.resolve',
      tier: null,
      actorId,
    });

    const rows = await db
      .select()
      .from(permissionOverrideHistory)
      .where(eq(permissionOverrideHistory.capability, 'dispute.resolve'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fromTier: null, toTier: 'contributor' });
    expect(rows[1]).toMatchObject({ fromTier: 'contributor', toTier: null });

    const history = await listPermissionHistory(10);
    expect(history[0]).toMatchObject({
      capability: 'dispute.resolve',
      toTier: null,
    });
  });

  it('records the real transition when the same capability is saved twice', async () => {
    const actorId = await seedUser(db);

    await applyPermissionChanges({
      actorId,
      changes: [{ capability: 'methods.write', tier: 'contributor' }],
    });
    await applyPermissionChanges({
      actorId,
      changes: [{ capability: 'methods.write', tier: 'admin' }],
    });

    const rows = await db
      .select()
      .from(permissionOverrideHistory)
      .where(eq(permissionOverrideHistory.capability, 'methods.write'));
    expect(rows).toHaveLength(2);
    // The second save must record where it actually came from, not null.
    expect(rows[1]).toMatchObject({
      fromTier: 'contributor',
      toTier: 'admin',
    });
  });

  it('reports provenance for changed rows in the admin matrix view', async () => {
    const actorId = await seedUser(db);
    await applyPermissionChange({
      capability: 'wiki.draft.read',
      tier: 'contributor',
      actorId,
    });

    const { rows, overrides } = await getPermissionMatrix();
    expect(overrides['wiki.draft.read']).toBe('contributor');

    const changed = rows.find((r) => r.capability === 'wiki.draft.read');
    expect(changed).toMatchObject({ minTier: 'contributor', isDefault: false });
    expect(changed?.updatedBy?.id).toBe(actorId);
    expect(changed?.updatedAt).toBeTruthy();

    const untouched = rows.find((r) => r.capability === 'drug.delete');
    expect(untouched).toMatchObject({
      minTier: 'admin',
      isDefault: true,
      updatedAt: null,
    });
  });

  it('ignores a stored row whose capability the registry no longer knows', async () => {
    const actorId = await seedUser(db);
    await db.insert(permissionOverrides).values({
      capability: 'capability.removed.in.a.later.release',
      minTier: 'authenticated',
      updatedBy: actorId,
    });

    expect(await loadPermissionOverrides()).toEqual({});
  });
});
