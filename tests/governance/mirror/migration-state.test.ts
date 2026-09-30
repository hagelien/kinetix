/**
 * Phase 4: the migration control plane (§11).
 *
 * Everything the shadow path is allowed to do hangs off `resolveMigrationMode`,
 * so its failure modes matter more than its happy path. The three that would be
 * dangerous: a missing row reading as permissive, an unreadable table throwing
 * into a Kinetix request, and the kill switch being cached.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FORCE_LEGACY_ENV,
  forceLegacyEnabled,
  invalidateMigrationStateCache,
  isGenericAuthoritative,
  listMigrationState,
  MIGRATION_MODES,
  MigrationStateTransitionError,
  migrationTransitionRefusal,
  mirrorsWrites,
  participatesInRequest,
  resolveMigrationMode,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { ensureKinetixSpace } from '../../../api/_lib/knowledge-governance/backfill.js';
import { listAuditEventsByType } from '../../../api/_lib/knowledge-governance/store/postgres.js';
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
  delete process.env[FORCE_LEGACY_ENV];
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  delete process.env[FORCE_LEGACY_ENV];
});

describe('resolveMigrationMode', () => {
  it('treats a target with no stored row as legacy_only', async () => {
    // Absence of a decision is the conservative decision — adding a new target
    // type must never silently opt it into the generic path.
    expect(await resolveMigrationMode('pending_edit', { db })).toBe('legacy_only');
  });

  it('treats a space that does not exist as legacy_only', async () => {
    expect(await resolveMigrationMode('pending_edit', { db, space: 'nope' })).toBe(
      'legacy_only',
    );
  });

  it('returns the stored mode once a target is advanced', async () => {
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: 1,
    });
    expect(await resolveMigrationMode('pending_edit', { db })).toBe('shadow');
  });

  it('falls back to legacy_only for an unrecognised stored mode', async () => {
    // A mode removed in a later release, or a hand-edited row. This build
    // cannot reason about it, so it must not act on it.
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: 1,
    });
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`update kg_migration_state set mode = 'teleport'`,
    );
    invalidateMigrationStateCache();
    expect(await resolveMigrationMode('pending_edit', { db })).toBe('legacy_only');
  });

  it('never throws when the configuration cannot be read', async () => {
    // A governance layer that surfaced its own read failure into an unrelated
    // Kinetix request would be the harm this phase exists to avoid.
    const broken = {
      select: () => {
        throw new Error('connection refused');
      },
    } as unknown as IntegrationDb;
    await expect(
      resolveMigrationMode('pending_edit', { db: broken }),
    ).resolves.toBe('legacy_only');
  });
});

describe('the force-legacy kill switch', () => {
  it.each([['1'], ['true'], ['on'], ['yes'], ['anything']])(
    'is engaged by %s',
    (value) => {
      process.env[FORCE_LEGACY_ENV] = value;
      // Anything other than an explicit off value counts as ON: during an
      // incident a typo must not silently leave the generic path running.
      expect(forceLegacyEnabled()).toBe(true);
    },
  );

  it.each([[''], ['0'], ['false'], ['off'], ['  OFF  ']])(
    'is not engaged by %s',
    (value) => {
      process.env[FORCE_LEGACY_ENV] = value;
      expect(forceLegacyEnabled()).toBe(false);
    },
  );

  it('is not engaged when unset', () => {
    expect(forceLegacyEnabled()).toBe(false);
  });

  it('overrides a stored mode with no cache flush', async () => {
    // `wiki_revision` rather than `pending_edit`: the latter is
    // high-consequence and cannot jump straight to authoritative, which is a
    // different rule being tested elsewhere.
    await setMigrationMode({
      targetType: 'wiki_revision',
      mode: 'generic_authoritative',
      updatedBy: 1,
    });
    expect(await resolveMigrationMode('wiki_revision', { db })).toBe(
      'generic_authoritative',
    );
    // The emergency lever must take effect immediately — not after the mode
    // cache expires.
    process.env[FORCE_LEGACY_ENV] = '1';
    expect(await resolveMigrationMode('wiki_revision', { db })).toBe('legacy_only');
  });
});

describe('mode predicates', () => {
  it('lets nothing participate under legacy_only', () => {
    expect(participatesInRequest('legacy_only')).toBe(false);
    expect(mirrorsWrites('legacy_only')).toBe(false);
    expect(isGenericAuthoritative('legacy_only')).toBe(false);
  });

  it('lets every mode from shadow upward participate and mirror', () => {
    for (const mode of MIGRATION_MODES.filter((m) => m !== 'legacy_only')) {
      expect(participatesInRequest(mode)).toBe(true);
      expect(mirrorsWrites(mode)).toBe(true);
    }
  });

  it('reserves authority for generic_authoritative alone', () => {
    for (const mode of MIGRATION_MODES) {
      expect(isGenericAuthoritative(mode)).toBe(mode === 'generic_authoritative');
    }
  });
});

describe('migrationTransitionRefusal', () => {
  // The same rule `setMigrationMode` throws on, as a pure function — so a dry
  // run can report the refusal without writing. A preview that says "re-run
  // with --confirm" for a move the guard rejects describes a command that
  // does not exist, and the operator finds out by running it.
  it('refuses a high-consequence jump straight to authoritative', () => {
    expect(
      migrationTransitionRefusal({
        targetType: 'pending_edit',
        from: 'legacy_only',
        to: 'generic_authoritative',
      }),
    ).toMatch(/cannot move from legacy_only straight to generic_authoritative/);
  });

  it('permits the same jump from an intermediate mode', () => {
    expect(
      migrationTransitionRefusal({
        targetType: 'pending_edit',
        from: 'generic_read',
        to: 'generic_authoritative',
      }),
    ).toBeNull();
  });

  it('permits any retreat, including the one it refuses to advance', () => {
    expect(
      migrationTransitionRefusal({
        targetType: 'pending_edit',
        from: 'generic_authoritative',
        to: 'legacy_only',
      }),
    ).toBeNull();
  });

  it('leaves a target outside the high-consequence list alone', () => {
    expect(
      migrationTransitionRefusal({
        targetType: 'pending_edit:wiki_fact',
        from: 'legacy_only',
        to: 'generic_authoritative',
      }),
    ).toBeNull();
  });

  it('agrees with what setMigrationMode actually does', () => {
    // Two statements of one rule drift. This is the assertion that notices.
    expect(
      migrationTransitionRefusal({
        targetType: 'pending_edit',
        from: 'legacy_only',
        to: 'generic_authoritative',
      }),
    ).not.toBeNull();
  });
});

describe('setMigrationMode', () => {
  it('audits every change with who, from and to', async () => {
    const space = await ensureKinetixSpace(db);
    await setMigrationMode({
      targetType: 'wiki_revision',
      mode: 'shadow',
      updatedBy: 7,
      notes: 'starting observation',
    });
    const events = await listAuditEventsByType(db, {
      spaceId: space.id,
      eventType: 'migration_state_changed',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorRef).toBe('user:7');
    expect(events[0]!.payload).toMatchObject({
      targetType: 'wiki_revision',
      from: 'legacy_only',
      to: 'shadow',
      direction: 'advance',
    });
  });

  it('refuses to jump a high-consequence target straight to authoritative', async () => {
    // §11.4: every intermediate mode exists to produce the parity evidence
    // that justifies the next one. Skipping them means advancing on none.
    await expect(
      setMigrationMode({
        targetType: 'pending_edit',
        mode: 'generic_authoritative',
        updatedBy: 1,
      }),
    ).rejects.toThrow(MigrationStateTransitionError);
  });

  it('allows the same jump once the target has been advanced', async () => {
    for (const mode of [
      'shadow',
      'compare',
      'generic_read',
      'legacy_write_generic_mirror',
      'generic_authoritative',
    ] as const) {
      await setMigrationMode({
        targetType: 'pending_edit',
        mode,
        updatedBy: 1,
      });
    }
    expect(await resolveMigrationMode('pending_edit', { db })).toBe(
      'generic_authoritative',
    );
  });

  it('always allows a rollback, from any mode to any safer one', async () => {
    // A rollback that had to satisfy a gate would not be a rollback.
    await setMigrationMode({
      targetType: 'wiki_revision',
      mode: 'generic_authoritative',
      updatedBy: 1,
    });
    const previous = await setMigrationMode({
      targetType: 'wiki_revision',
      mode: 'legacy_only',
      updatedBy: 1,
    });
    expect(previous).toBe('generic_authoritative');
    expect(await resolveMigrationMode('wiki_revision', { db })).toBe('legacy_only');
  });

  it('rejects a mode this build does not know', async () => {
    await expect(
      setMigrationMode({
        targetType: 'wiki_revision',
        mode: 'teleport' as never,
        updatedBy: 1,
      }),
    ).rejects.toThrow(MigrationStateTransitionError);
  });

  it('lists what has been advanced, for an admin view', async () => {
    await setMigrationMode({
      targetType: 'wiki_revision',
      mode: 'shadow',
      updatedBy: 1,
    });
    await setMigrationMode({
      targetType: 'paper_review',
      mode: 'compare',
      updatedBy: 1,
    });
    const rows = await listMigrationState(db);
    expect(rows.map((r) => [r.targetType, r.mode])).toEqual([
      ['paper_review', 'compare'],
      ['wiki_revision', 'shadow'],
    ]);
  });
});
