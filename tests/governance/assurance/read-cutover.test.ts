/**
 * Phase 7: the first read cutover.
 *
 * Kinetix consumes generic-derived read state before the generic engine
 * controls publication. Nothing about what publishes changes; what changes is
 * where the number on a monograph badge came from.
 *
 * Three properties carry the phase, and each gets its own group:
 *
 *  1. **Parity** — the generic projection produces the same
 *     `{ level, disputed }` the legacy calculation does.
 *  2. **Fallback** — anything unmirrored, partially mirrored, or broken serves
 *     the legacy answer rather than a wrong one. A badge that under-reports
 *     review tells a reader a verified value is unverified, so falling back is
 *     the fail-safe direction for a read.
 *  3. **Rollback** — both levers work: the migration-state toggle and
 *     `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  approvals,
  drugParameterRevisions,
} from '../../../db/schema.js';
import {
  NON_CANONICAL_SNAPSHOT_METRIC,
  readMetricTotal,
  resetMetricsForTests,
} from '../../../api/_lib/knowledge-governance/metrics.js';
import {
  genericAssuranceProfile,
  linkageIsComplete,
  resolveVerificationLevel,
} from '../../../api/_lib/knowledge-governance/assurance-service.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorHumanApproval,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

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

interface World {
  revisionId: number;
  authorId: number;
  verifierUserIds: number[];
  verifierAgentIds: number[];
  humanId: number;
}

async function seedRevision(): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author-agent',
    role: 'contributor',
  });
  const humanId = await seedUser(db, {
    email: 'human@example.com',
    username: 'human-editor',
    role: 'editor',
  });
  const verifierUserIds: number[] = [];
  const verifierAgentIds: number[] = [];
  for (const n of [1, 2]) {
    const userId = await seedUser(db, {
      email: `verifier${n}@example.com`,
      username: `verifier-${n}`,
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId,
        name: `verifier-${n}`,
        slug: `verifier-${n}`,
        status: 'active',
        modelTier: n === 1 ? 'flagship' : 'mid',
      })
      .returning({ id: agents.id });
    verifierUserIds.push(userId);
    verifierAgentIds.push(agent!.id);
  }
  await db
    .insert(agents)
    .values({
      userId: authorId,
      name: 'author-agent',
      slug: 'author-agent',
      status: 'active',
    });

  const drugId = await seedDrug(db, {
    slug: 'diazepam',
    names: { nb: 'Diazepam', en: 'Diazepam' },
  });
  const [revision] = await db
    .insert(drugParameterRevisions)
    .values({
      drugId,
      parameter: 'halfLife',
      oldValue: { value: 20 },
      newValue: { value: 30 },
      createdBy: authorId,
    })
    .returning({ id: drugParameterRevisions.id });

  return {
    revisionId: revision!.id,
    authorId,
    humanId,
    verifierUserIds,
    verifierAgentIds,
  };
}

/**
 * Record an agent verdict and mirror it, so the generic side is complete.
 *
 * Advances the target type to `shadow` first: the mirror is gated on the mode
 * and writes nothing under `legacy_only`, so a test that mirrored before
 * advancing would be silently testing the fallback path instead.
 */
async function verdictAndMirror(
  world: World,
  index: number,
  verdict: 'approve' | 'dispute',
): Promise<void> {
  await advanceTo('shadow');
  const [row] = await db
    .insert(agentVerifications)
    .values({
      agentId: world.verifierAgentIds[index]!,
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      verdict,
      verifierTier: index === 0 ? 'flagship' : 'mid',
    })
    .returning({ id: agentVerifications.id });
  await mirrorProposalVersion({
    targetType: 'drug_parameter_revision',
    targetId: world.revisionId,
  });
  await mirrorAssessment({
    targetType: 'drug_parameter_revision',
    targetId: world.revisionId,
    legacyVerificationId: row!.id,
    actorRef: `user:${world.verifierUserIds[index]}`,
    verdict,
  });
}

async function advanceTo(mode: 'shadow' | 'generic_read'): Promise<void> {
  await setMigrationMode({
    targetType: 'drug_parameter_revision',
    mode,
    updatedBy: null,
  });
  invalidateMigrationStateCache();
}

describe('parity: the generic projection matches the legacy calculation', () => {
  beforeEach(async () => {
    await advanceTo('shadow');
  });

  it.each([0, 1, 2])('agrees with %i mirrored approvals', async (count) => {
    const world = await seedRevision();
    // Mirror the proposal itself even with no verdicts: a target with a
    // mirrored version and zero assessments is complete, and its generic level
    // must match legacy's zero rather than falling back. Without this the
    // count=0 row would be testing the fallback path under another name.
    await advanceTo('shadow');
    await mirrorProposalVersion({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
    });
    for (let i = 0; i < count; i += 1) {
      await verdictAndMirror(world, i, 'approve');
    }
    await advanceTo('generic_read');

    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    // The generic answer is what was served, and it equals the legacy one.
    expect(resolved.source).toBe('generic');
    expect(resolved.generic).toEqual(resolved.legacy);
    expect(resolved.info).toEqual(resolved.legacy);
  });

  it('does not count an author’s implicit stake as an explicit approval', async () => {
    // The canonical shape records "this is the author's submit-time stake" in
    // `independence_group`, where the generic schema has a column for it. The
    // consensus reader used to look only for a snapshot field called
    // `isImplicit`, by truthiness — so a canonically written implicit approval
    // was invisible to it and counted toward a quorum meant to be independent
    // of its author. Legacy has always excluded it; parity is the assertion.
    const world = await seedRevision();
    await advanceTo('shadow');
    const [row] = await db
      .insert(agentVerifications)
      .values({
        agentId: world.verifierAgentIds[0]!,
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
        verdict: 'approve',
        verifierTier: 'flagship',
        isImplicit: true,
      })
      .returning({ id: agentVerifications.id });
    await mirrorProposalVersion({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
    });
    await mirrorAssessment({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      legacyVerificationId: row!.id,
      actorRef: `user:${world.verifierUserIds[0]}`,
      verdict: 'approve',
      isImplicit: true,
    });

    const profile = await genericAssuranceProfile(db, {
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
    });
    expect(profile).not.toBeNull();
    expect(profile!.explicitApprovals).toBe(0);

    await advanceTo('generic_read');
    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('generic');
    expect(resolved.generic).toEqual(resolved.legacy);
  });

  it('counts an unreadable snapshot on the path production actually takes', async () => {
    // The counter was reported by the observed store, and the observed store
    // was reached by tests. `resolveVerificationLevel`, the SDK's
    // `assurance.get` and the moderator view all come through
    // `genericAssuranceProfile`, which read the DAO directly — so the signal
    // would have stayed zero in exactly the environments it was added for.
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await advanceTo('generic_read');
    await db.execute(
      sql`UPDATE kg_assessments SET capability_snapshot = ${'"nonsense"'}::jsonb`,
    );
    resetMetricsForTests();

    const profile = await genericAssuranceProfile(db, {
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
    });
    // Still counted as an approval; it simply carries no qualification.
    expect(profile!.explicitApprovals).toBe(1);
    expect(profile!.approvalCapabilities).toEqual([]);
    expect(readMetricTotal(NON_CANONICAL_SNAPSHOT_METRIC)).toBe(1);
  });

  it('counts one unreadable snapshot once, whatever the verdict on it', async () => {
    // The counter must measure unreadable assessments, not verdicts. Reported
    // from inside the capability aggregates it did neither: a malformed human
    // approval was decoded by the explicit and the human aggregate and counted
    // twice, while one on a dispute was never decoded and never counted.
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await verdictAndMirror(world, 1, 'dispute');
    await advanceTo('generic_read');
    await db.execute(
      sql`UPDATE kg_assessments SET capability_snapshot = ${'"nonsense"'}::jsonb`,
    );
    resetMetricsForTests();

    await genericAssuranceProfile(db, {
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
    });
    // Two corrupt rows, two counts — not one for the approval alone, and not
    // three for an approval decoded twice.
    expect(readMetricTotal(NON_CANONICAL_SNAPSHOT_METRIC)).toBe(2);
  });

  it('agrees on the disputed flag, which never lowers the level', async () => {
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await verdictAndMirror(world, 1, 'dispute');
    await advanceTo('generic_read');

    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('generic');
    expect(resolved.info.disputed).toBe(true);
    expect(resolved.info).toEqual(resolved.legacy);
  });

  it('counts a mirrored human approval stamp the same way', async () => {
    // A human stamp lives in `approvals`, not `agent_verifications`, so it is
    // mirrored by its own path. The level it produces must match legacy's —
    // this is the case where an incomplete generic profile would under-report
    // review on exactly the values a person took the trouble to endorse.
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    const [stamp] = await db
      .insert(approvals)
      .values({
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
        approvedBy: world.humanId,
      })
      .returning({ id: approvals.id });
    await mirrorHumanApproval({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      legacyApprovalId: stamp!.id,
      actorRef: `user:${world.humanId}`,
    });
    await advanceTo('generic_read');

    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('generic');
    expect(resolved.info.level).toBe(resolved.legacy.level);
    expect(resolved.info).toEqual(resolved.legacy);
  });

  it('falls back when a human stamp has not been mirrored', async () => {
    // The guard that makes the case above safe. Counting only agent verdicts
    // would call this target complete and serve a level lower than the truth.
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await db.insert(approvals).values({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      approvedBy: world.humanId,
    });
    await advanceTo('generic_read');

    expect(
      await linkageIsComplete(db, {
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
      }),
    ).toBe(false);
    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('legacy_fallback_incomplete');
    expect(resolved.info).toEqual(resolved.legacy);
  });
});

describe('fallback', () => {
  it('serves legacy for a target with nothing mirrored', async () => {
    const world = await seedRevision();
    await db.insert(agentVerifications).values({
      agentId: world.verifierAgentIds[0]!,
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      verdict: 'approve',
    });
    await advanceTo('generic_read');

    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('legacy_fallback_incomplete');
    expect(resolved.info).toEqual(resolved.legacy);
    // And the legacy answer is not level 0 — the point is that falling back
    // preserves the real level rather than serving an empty profile.
    expect(resolved.info.level).toBeGreaterThan(0);
  });

  it('serves legacy when only some verdicts were mirrored', async () => {
    // Shadow mirroring is allowed to fail. A partially-mirrored target would
    // project a *lower* level than the truth.
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await db.insert(agentVerifications).values({
      agentId: world.verifierAgentIds[1]!,
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      verdict: 'approve',
    });
    await advanceTo('generic_read');

    expect(
      await linkageIsComplete(db, {
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
      }),
    ).toBe(false);
    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('legacy_fallback_incomplete');
    expect(resolved.info).toEqual(resolved.legacy);
  });

  it('serves legacy when the generic read throws', async () => {
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await advanceTo('generic_read');
    await db.execute(sql`alter table kg_assessments rename to kg_assessments_hidden`);
    try {
      const resolved = await resolveVerificationLevel({
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
        db,
      });
      expect(resolved.source).toBe('legacy_fallback_error');
      expect(resolved.info).toEqual(resolved.legacy);
    } finally {
      await db.execute(
        sql`alter table kg_assessments_hidden rename to kg_assessments`,
      );
    }
  });

  it('returns null for an unmirrored target rather than an empty profile', async () => {
    // "Not available" and "nothing approved it" are different answers, and an
    // empty profile projects to level 0.
    const world = await seedRevision();
    expect(
      await genericAssuranceProfile(db, {
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
      }),
    ).toBeNull();
  });
});

describe('rollback', () => {
  it('serves legacy in any mode below generic_read', async () => {
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    // Mirrored (so the generic side is complete) but deliberately left at
    // `shadow`: participating in the mirror is not the same as being read from.
    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('legacy');
    expect(resolved.generic).toBeNull();
  });

  it('reverts to legacy when the target type is rolled back', async () => {
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await advanceTo('generic_read');
    expect(
      (
        await resolveVerificationLevel({
          targetType: 'drug_parameter_revision',
          targetId: world.revisionId,
          db,
        })
      ).source,
    ).toBe('generic');

    await setMigrationMode({
      targetType: 'drug_parameter_revision',
      mode: 'legacy_only',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    expect(
      (
        await resolveVerificationLevel({
          targetType: 'drug_parameter_revision',
          targetId: world.revisionId,
          db,
        })
      ).source,
    ).toBe('legacy');
  });

  it('reverts to legacy under the force-legacy flag, with no cache flush', async () => {
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await advanceTo('generic_read');
    process.env[FORCE_LEGACY_ENV] = '1';
    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('legacy');
  });
});

describe('the served shape does not change', () => {
  it('returns exactly { level, disputed } from either source', async () => {
    // §7.3: the 0–3 level is a Kinetix projection, not the canonical generic
    // state, and the UI must not have to change during the backend migration.
    const world = await seedRevision();
    await verdictAndMirror(world, 0, 'approve');
    await advanceTo('generic_read');
    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(Object.keys(resolved.info).sort()).toEqual(['disputed', 'level']);
    expect(Object.keys(resolved.legacy).sort()).toEqual(['disputed', 'level']);
  });
});
