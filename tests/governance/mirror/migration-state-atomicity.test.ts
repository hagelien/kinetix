/**
 * §11.4: "every change is audited" — which is a claim about both writes, or
 * neither.
 *
 * The state row and its audit event used to be written one after the other,
 * and they could come apart in exactly one direction: the row lands, the audit
 * insert fails, and `setMigrationMode` rejects. The operator sees an error and
 * reasonably concludes nothing happened — while the target has in fact moved,
 * with no audit record saying who moved it. For an advance to
 * `generic_authoritative` that is the generic engine going live unnoticed.
 *
 * The failure needs the audit write to fail, so this file mocks that module
 * and does nothing else; the rest of `setMigrationMode` is covered in
 * migration-state.test.ts, which needs the real one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/_lib/knowledge-governance/store/audit.js', () => ({
  recordAuditEvent: vi.fn(async () => {
    throw new Error('audit write failed');
  }),
}));

import { kgAuditEvents, kgMigrationState } from '../../../db/governance-schema.js';
import {
  invalidateMigrationStateCache,
  resolveMigrationMode,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

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

describe('an unauditable change does not happen', () => {
  it('leaves no state row behind when the audit write fails', async () => {
    await expect(
      setMigrationMode({
        targetType: applyAuthorityKey('wiki_fact'),
        mode: 'generic_authoritative',
        updatedBy: 1,
      }),
    ).rejects.toThrow(/audit write failed/);

    expect(await db.select().from(kgMigrationState)).toEqual([]);
    expect(await db.select().from(kgAuditEvents)).toEqual([]);
    // And the request path agrees: the error the operator saw is the whole
    // truth, not the half of it that failed.
    expect(
      await resolveMigrationMode(applyAuthorityKey('wiki_fact'), { db }),
    ).toBe('legacy_only');
  });

  it('does not leave a partial update on an existing row either', async () => {
    // Seeded directly: the module under test cannot write a starting state
    // while its audit write throws.
    const [space] = await db
      .insert((await import('../../../db/governance-schema.js')).kgSpaces)
      .values({ slug: 'kinetix', name: 'Kinetix' })
      .returning({ id: (await import('../../../db/governance-schema.js')).kgSpaces.id });
    await db.insert(kgMigrationState).values({
      spaceId: space!.id,
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });

    await expect(
      setMigrationMode({
        targetType: 'pending_edit',
        mode: 'generic_read',
        updatedBy: 1,
      }),
    ).rejects.toThrow(/audit write failed/);

    const [row] = await db.select().from(kgMigrationState);
    expect(row?.mode).toBe('shadow');
  });
});
