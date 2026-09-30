/**
 * §22: the rollback playbook, rehearsed.
 *
 * §22 lists four rollback levels and then names a six-step rehearsal that must
 * be run *before* a high-risk cutover:
 *
 *   1. create pending edit;
 *   2. run generic shadow path;
 *   3. switch target to generic authoritative;
 *   4. submit/verdict/apply test edit;
 *   5. switch back to legacy;
 *   6. confirm old UI/API can still inspect and continue existing proposals.
 *
 * That drill needs a live-ish environment, which is exactly what the PGlite
 * harness is — so it runs here, end to end, rather than living as prose nobody
 * has executed.
 *
 * Level 4 (data repair) had no implementation at all until now: the
 * reconciliation scanner detected divergence and nothing rebuilt it. Those
 * tests are below the drill.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  kgProposals,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import { applyOnAgentConsensus } from '../../../api/agent-verifications.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
import { publishOnAgentConsensus } from '../../../api/_lib/knowledge-governance/publication.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  REPAIRABLE,
  UNREPAIRABLE,
  describeRepair,
  repairMirrors,
} from '../../../api/_lib/knowledge-governance/repair.js';
import { reconcile } from '../../../api/_lib/knowledge-governance/reconciliation.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import { moderatorViewForLegacy } from '../../../api/_lib/knowledge-governance/moderator-view.js';
import { findByLegacy } from '../../../api/_lib/knowledge-governance/store/postgres.js';
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
  delete process.env[FORCE_LEGACY_ENV];
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  delete process.env[FORCE_LEGACY_ENV];
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
});

interface World {
  editId: number;
  verifierUserId: number;
  verificationIds: number[];
  agentUserIds: number[];
}

/** Step 1: create a pending edit, with a pool that can clear the gate. */
async function createPendingEdit(): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId: authorId,
    name: 'author-agent',
    slug: 'author-agent',
    status: 'active',
  });

  const agentUserIds: number[] = [];
  const agentIds: number[] = [];
  for (const [i, tier] of ['flagship', 'mid'].entries()) {
    const userId = await seedUser(db, {
      email: `v${i}@example.com`,
      username: `verifier-${i}`,
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId,
        name: `verifier-${i}`,
        slug: `verifier-${i}`,
        status: 'active',
        modelTier: tier,
      })
      .returning({ id: agents.id });
    agentUserIds.push(userId);
    agentIds.push(agent!.id);
  }

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      pageType: 'drug_monograph',
      content: { version: 2, sections: { pk: { body: { type: 'doc', content: [] } } } },
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 30 timer.',
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f-1', referenceIds: [] },
        content: [{ type: 'text', text: 'Halveringstiden er 30 timer.' }],
      },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  const verifications = await db
    .insert(agentVerifications)
    .values(
      agentIds.map((agentId, i) => ({
        agentId,
        targetType: 'pending_edit' as const,
        targetId: edit!.id,
        verdict: 'approve' as const,
        verifierTier: i === 0 ? 'flagship' : 'mid',
      })),
    )
    .returning({ id: agentVerifications.id });

  return {
    editId: edit!.id,
    verifierUserId: agentUserIds[0]!,
    verificationIds: verifications.map((v) => v.id),
    agentUserIds,
  };
}

/** Step 2: run the generic shadow path. */
async function runShadowPath(world: World): Promise<void> {
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  invalidateMigrationStateCache();
  const mirrored = await mirrorProposalVersion({
    targetType: 'pending_edit',
    targetId: world.editId,
    legacyPendingEditId: world.editId,
  });
  expect(mirrored.mirrored).toBe(true);
  for (const [i, id] of world.verificationIds.entries()) {
    await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyVerificationId: id,
      actorRef: `user:${world.agentUserIds[i]}`,
      verdict: 'approve',
    });
  }
}

describe('§22 — the six-step rollback rehearsal', () => {
  it('runs end to end and leaves the proposal inspectable', async () => {
    // 1. create pending edit
    const world = await createPendingEdit();
    expect(await editStatus(world.editId)).toBe('pending');

    // 2. run generic shadow path
    await runShadowPath(world);
    const report = await reconcile(db, { limit: 100 });
    expect(report.divergences).toEqual([]);

    // 3. switch target to generic authoritative
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'generic_authoritative',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    // 4. submit/verdict/apply the test edit through the generic path
    const published = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(published.outcome).toBe('applied');
    expect(await editStatus(world.editId)).toBe('approved');

    // 5. switch back to legacy
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'legacy_only',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    // 6. confirm the old API can still inspect and continue existing proposals.
    // The pending_edits row is what the moderator UI and admin tooling read,
    // and it is stamped exactly as a legacy approval would have stamped it.
    const [row] = await db
      .select({
        status: pendingEdits.status,
        reviewedBy: pendingEdits.reviewedBy,
      })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, world.editId));
    expect(row!.status).toBe('approved');
    expect(row!.reviewedBy).toBe(world.verifierUserId);

    // And the generic history is still readable after the rollback — §22:
    // do not delete generic history as part of rollback.
    const view = await moderatorViewForLegacy('pending_edit', world.editId, { db });
    expect(view!.publicationEvents.map((e) => e.action)).toContain('applied');
  });

  it('publishes through legacy again once rolled back', async () => {
    // The half of step 6 that matters most: after retreating, an ordinary
    // consensus still works, by the path it used before the cutover existed.
    const world = await createPendingEdit();
    await runShadowPath(world);
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'legacy_only',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    expect(
      await applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.verifierUserId,
      }),
    ).toBe(true);
    expect(await editStatus(world.editId)).toBe('approved');
  });

  it('level 2 overrides an advanced target without a state change', async () => {
    const world = await createPendingEdit();
    await runShadowPath(world);
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'generic_authoritative',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    process.env[FORCE_LEGACY_ENV] = '1';
    invalidateMigrationStateCache();
    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('fell_back');
  });
});

describe('§22 level 4 — data repair', () => {
  it('rebuilds a proposal the mirror never wrote', async () => {
    const world = await createPendingEdit();
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    // Deliberately not mirrored: the scanner should find it, and repair should
    // rebuild it from legacy, which is the source of truth during migration.
    const before = await reconcile(db, { limit: 100 });
    expect(before.counts.missing_proposal).toBeGreaterThan(0);

    const repaired = await repairMirrors({ db, dryRun: false });
    expect(repaired.repaired).toBeGreaterThan(0);
    expect(await findByLegacy(db, 'pending_edit', world.editId)).not.toBeNull();

    const after = await reconcile(db, { limit: 100 });
    expect(after.counts.missing_proposal).toBe(0);
  });

  it('defaults to a dry run', async () => {
    // A repair tool that writes by default is one someone runs to "have a
    // look" and then has to explain — in the middle of an incident.
    await createPendingEdit();
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();

    const report = await repairMirrors({ db });
    expect(report.dryRun).toBe(true);
    expect(report.repaired).toBe(0);
    expect(report.examined).toBeGreaterThan(0);
    expect(describeRepair(report)).toContain('DRY RUN');
  });

  it('deletes nothing, ever', async () => {
    // §22 says so outright, and the reason is stronger than the instruction:
    // a repair path that could delete is one someone could use to remove an
    // inconvenient assessment.
    const world = await createPendingEdit();
    await runShadowPath(world);
    const countBefore = await proposalCount();

    await repairMirrors({ db, dryRun: false });
    expect(await proposalCount()).toBe(countBefore);
  });

  it('leaves an orphaned proposal alone rather than removing it', async () => {
    // An immutable record of a review that happened does not stop having
    // happened because someone deleted the row it mirrored.
    const world = await createPendingEdit();
    await runShadowPath(world);
    await db.delete(pendingEdits).where(eq(pendingEdits.id, world.editId));

    const report = await repairMirrors({ db, dryRun: false });
    expect(report.unrepairable.legacy_row_gone).toBeGreaterThan(0);
    expect(await proposalCount()).toBeGreaterThan(0);
  });

  it('refuses the classes that would need a decision or invent history', () => {
    expect(UNREPAIRABLE.fingerprint_mismatch).toBe('needs_human_decision');
    expect(UNREPAIRABLE.state_mismatch).toBe('needs_human_decision');
    // Manufacturing a publication event after the fact would be claiming this
    // engine published something it did not.
    expect(UNREPAIRABLE.missing_publication).toBe('would_invent_history');
    expect([...REPAIRABLE]).toEqual(['missing_proposal', 'missing_assessment']);
  });

  it('scopes to one target type when asked', async () => {
    await createPendingEdit();
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    const scoped = await repairMirrors({ db, targetType: 'wiki_revision' });
    expect(scoped.examined).toBe(0);
  });
});

async function editStatus(editId: number): Promise<string> {
  const [row] = await db
    .select({ status: pendingEdits.status })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  return row!.status;
}

async function proposalCount(): Promise<number> {
  return (await db.select({ id: kgProposals.id }).from(kgProposals)).length;
}
