/**
 * Phase 4: the reconciliation scanner (§12.2).
 *
 * Shadow mirroring is allowed to fail, so this is what the exit gate is
 * actually measured with — "unexplained mirror loss = 0 after reconciliation"
 * is a claim about what this reports, not about a counter in a warm serverless
 * instance. Each of §12.2's six divergence classes gets a test that produces it
 * deliberately, plus one that a fully mirrored world reports clean, because a
 * scanner that finds everything is as useless as one that finds nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  kgProposals,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import {
  describeReport,
  reconcile,
} from '../../../api/_lib/knowledge-governance/reconciliation.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
  mirrorPublicationOutcome,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import { setProposalState } from '../../../api/_lib/knowledge-governance/store/postgres.js';
import { resetMetricsForTests } from '../../../api/_lib/knowledge-governance/metrics.js';
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
  resetMetricsForTests();
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
});

async function seedEdit(): Promise<{ editId: number; verifierUserId: number }> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author-agent',
    role: 'contributor',
  });
  const verifierId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier-agent',
    role: 'contributor',
  });
  const [authorAgent] = await db
    .insert(agents)
    .values({
      userId: authorId,
      name: 'author-agent',
      slug: 'author-agent',
      status: 'active',
    })
    .returning({ id: agents.id });
  const [verifierAgent] = await db
    .insert(agents)
    .values({
      userId: verifierId,
      name: 'verifier-agent',
      slug: 'verifier-agent',
      status: 'active',
      modelTier: 'flagship',
    })
    .returning({ id: agents.id });

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      content: { type: 'doc', content: [] },
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
      proposedValue: { factStatement: 'Halveringstiden er 30 timer.' },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  await db.insert(agentVerifications).values({
    agentId: verifierAgent!.id,
    targetType: 'pending_edit',
    targetId: edit!.id,
    verdict: 'approve',
    verifierTier: 'flagship',
  });
  void authorAgent;

  return { editId: edit!.id, verifierUserId: verifierId };
}

/** Mirror everything the scanner knows how to check. */
async function mirrorEverything(editId: number, verifierUserId: number) {
  await mirrorProposalVersion({
    targetType: 'pending_edit',
    targetId: editId,
    legacyPendingEditId: editId,
  });
  const [verdict] = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .limit(1);
  await mirrorAssessment({
    targetType: 'pending_edit',
    targetId: editId,
    legacyVerificationId: verdict!.id,
    actorRef: `user:${verifierUserId}`,
    verdict: 'approve',
  });
}

describe('a fully mirrored world reports clean', () => {
  it('finds nothing when every legacy row has its generic counterpart', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    const report = await reconcile(db);
    expect(report.divergences).toEqual([]);
    expect(describeReport(report)).toContain('clean');
    // A clean report has to be legible as "examined things and found nothing",
    // not as "examined nothing".
    expect(report.examined.pendingEdits).toBe(1);
    expect(report.examined.verifications).toBe(1);
    expect(report.examined.proposals).toBe(1);
  });

  it('reports nothing at all before the space exists', async () => {
    // The migration simply has not been turned on. Reporting every legacy row
    // as missing would be noise, not a finding.
    await resetIntegrationDb(db);
    invalidateMigrationStateCache();
    await seedEdit();
    const report = await reconcile(db);
    expect(report.divergences).toEqual([]);
  });
});

describe('divergence classes', () => {
  it('1. finds a pending edit with no generic proposal', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db.execute(
      sql`delete from kg_legacy_links where legacy_type = 'pending_edit'`,
    );
    const report = await reconcile(db);
    expect(report.counts.missing_proposal).toBe(1);
    expect(report.divergences[0]!.legacyId).toBe(editId);
  });

  it('2. finds a verdict with no mirrored assessment', async () => {
    const { editId } = await seedEdit();
    // Proposal mirrored, verdict not.
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    const report = await reconcile(db);
    expect(report.counts.missing_assessment).toBe(1);
  });

  it('ignores a verdict on a target type no adapter covers', async () => {
    // Reporting those would be reporting a decision, not a loss.
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(agentVerifications)
      .set({ targetType: 'invented_type' })
      .where(eq(agentVerifications.targetType, 'pending_edit'));
    const report = await reconcile(db);
    expect(report.counts.missing_assessment).toBe(0);
  });

  it('3. finds a proposal whose legacy row is gone', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db.delete(pendingEdits).where(eq(pendingEdits.id, editId));
    const report = await reconcile(db);
    expect(report.counts.orphaned_proposal).toBe(1);
  });

  it('3b. finds a proposal with no legacy link at all', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db.execute(
      sql`delete from kg_legacy_links where generic_type = 'proposal'`,
    );
    const report = await reconcile(db);
    expect(report.counts.orphaned_proposal).toBe(1);
  });

  it('4b. does not flag a closed proposal whose payload has since moved', async () => {
    // The fingerprint class is about work still under review. A Kinetix payload
    // includes the row's moderation status — the legacy stale-verdict token
    // folds it in for the same reason — so approving an edit necessarily
    // changes its fingerprint. Reporting that would mark every applied edit
    // permanently divergent and make "unexplained mirror loss = 0"
    // unreachable. The reviewed version is a historical record, not a stale
    // copy of a live row.
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));
    await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: 'system:agent-consensus',
    });
    expect((await reconcile(db)).counts.fingerprint_mismatch).toBe(0);
  });

  it('4. finds a payload that moved without a new version', async () => {
    // The class that catches a *silently* lost mirror: the row is linked and
    // the projection looks fine, but what a reviewer would be handed today is
    // not what the newest mirrored version says.
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ factStatement: 'Halveringstiden er 43 timer.' })
      .where(eq(pendingEdits.id, editId));
    const report = await reconcile(db);
    expect(report.counts.fingerprint_mismatch).toBe(1);
    expect(report.divergences.find((d) => d.kind === 'fingerprint_mismatch')?.detail)
      .toContain('now fingerprints');
  });

  it('5. finds a projection that disagrees with the legacy status', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ status: 'rejected' })
      .where(eq(pendingEdits.id, editId));
    const report = await reconcile(db);
    expect(report.counts.state_mismatch).toBe(1);
    expect(
      report.divergences.find((d) => d.kind === 'state_mismatch')?.detail,
    ).toContain("expected 'rejected'");
  });

  it('6. finds an approved edit with no publication event', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));
    // Move only the projection, leaving the publication event unwritten — the
    // exact shape of a lost apply mirror.
    const [proposal] = await db.select().from(kgProposals);
    await setProposalState(db, proposal!.id, 'applied');

    const report = await reconcile(db);
    expect(report.counts.missing_publication).toBe(1);
    // And is satisfied once the outcome is mirrored.
    await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: 'system:agent-consensus',
    });
    expect((await reconcile(db)).counts.missing_publication).toBe(0);
  });

  it('mirroring an apply leaves no state mismatch behind', async () => {
    // Recording the event without moving the projection would report every
    // applied edit as a state_mismatch forever, and the exit gate
    // ("unexplained mirror loss = 0 after reconciliation") could never be met.
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));
    await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: 'system:agent-consensus',
    });

    const report = await reconcile(db);
    expect(report.divergences).toEqual([]);
  });
});

describe('reporting', () => {
  it('summarises every class it found', async () => {
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ status: 'rejected', factStatement: 'Endret.' })
      .where(eq(pendingEdits.id, editId));
    const report = await reconcile(db);
    const described = describeReport(report);
    expect(described).toContain('fingerprint_mismatch=1');
    expect(described).toContain('state_mismatch=1');
  });

  it('repairs itself: re-mirroring clears a fingerprint mismatch', async () => {
    // The scanner reports; repair is a separate deliberate action. This is what
    // that action looks like, and that it converges is the point.
    const { editId, verifierUserId } = await seedEdit();
    await mirrorEverything(editId, verifierUserId);
    await db
      .update(pendingEdits)
      .set({ factStatement: 'Endret.' })
      .where(eq(pendingEdits.id, editId));
    expect((await reconcile(db)).counts.fingerprint_mismatch).toBe(1);

    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    expect((await reconcile(db)).counts.fingerprint_mismatch).toBe(0);
  });
});
