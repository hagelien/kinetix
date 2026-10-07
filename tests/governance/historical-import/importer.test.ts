/**
 * The historical snapshot importer (Step B of
 * docs/plans/2026-09-05-assurance-transition-continuation.md).
 *
 * The reproduction this suite is built around is the blocker recorded in that
 * plan, and it is the first test below: seed one approved and one rejected
 * `wiki_fact` edit, run the old repair path, and watch it report "2/2
 * repaired" while leaving two proposals projected `pending` — two
 * `state_mismatch` findings and one `missing_publication`. Applying that
 * against production would have turned missing history into incorrectly
 * projected history.
 *
 * Everything else here is the acceptance list from the same section: outcomes
 * preserved and closed, re-runs inert, batches resumable, imports atomic,
 * captures re-checked under the lock, provenance required rather than assumed,
 * and — the half that matters most — the `missing_publication` finding still
 * firing everywhere the exception does not reach.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  citations,
  kgAssessments,
  kgAuditEvents,
  kgLegacyLinks,
  kgProposals,
  kgProposalVersions,
  kgPublicationEvents,
  paperReviews,
  pendingEdits,
  users,
  wikiPages,
} from '../../../db/schema.js';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  HISTORICAL_IMPORT_EVENT,
  describeHistoricalImport,
  historicalImportForVersion,
  importHistoricalProposal,
  importHistoricalSnapshots,
  planOne,
  rebuildImportedProjection,
  versionBinding,
  readLegacySnapshot,
} from '../../../api/_lib/knowledge-governance/historical-import.js';
import { repairMirrors } from '../../../api/_lib/knowledge-governance/repair.js';
import { reconcile } from '../../../api/_lib/knowledge-governance/reconciliation.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
  mirrorPublicationOutcome,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import { buildDossier } from '../../../api/_lib/knowledge-governance/dossier.js';
import { moderatorViewForLegacy } from '../../../api/_lib/knowledge-governance/moderator-view.js';
import { governanceClient } from '../../../api/_lib/knowledge-governance/sdk/client.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import { findByLegacy } from '../../../api/_lib/knowledge-governance/store/legacy-links.js';
import {
  ensureKinetixSpace,
  ensureKinetixTarget,
  snapshotLegacyVerifications,
} from '../../../api/_lib/knowledge-governance/backfill.js';
import { recordAuditEvent } from '../../../api/_lib/knowledge-governance/store/audit.js';
import { latestVersion } from '../../../api/_lib/knowledge-governance/store/versions.js';
import {
  listPublicationEvents,
  recordPublicationEvent,
} from '../../../api/_lib/knowledge-governance/store/decisions.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;
let authorId: number;
let pageId: number;

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
  authorId = await seedUser(db, {
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
  pageId = page!.id;
});

async function enableShadow(): Promise<void> {
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  invalidateMigrationStateCache();
}

interface EditOpts {
  status: string;
  statement?: string;
  submittedAt?: Date;
  reviewedAt?: Date | null;
  editType?: string;
  /** Defaults to the agent-backed author; pass a plain user for a human edit. */
  submittedBy?: number;
}

async function seedEdit(opts: EditOpts): Promise<number> {
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: opts.editType ?? 'wiki_fact',
      targetId: pageId,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: opts.statement ?? 'Halveringstiden er 30 timer.',
      proposedValue: {
        type: 'fact',
        attrs: { factId: `f-${opts.statement ?? opts.status}`, referenceIds: [] },
        content: [{ type: 'text', text: opts.statement ?? 'Halveringstiden er 30 timer.' }],
      },
      submittedBy: opts.submittedBy ?? authorId,
      status: opts.status,
      ...(opts.submittedAt ? { submittedAt: opts.submittedAt } : {}),
      ...(opts.reviewedAt !== undefined ? { reviewedAt: opts.reviewedAt } : {}),
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

/**
 * The import provenance of a stored assessment.
 *
 * Host-owned bookkeeping, so it lives under `host` in the canonical snapshot:
 * the generic store carries it and never reads it, which is the property that
 * lets the store be extracted without Kinetix's import vocabulary going with
 * it.
 */
function hostProvenance(snapshot: unknown): Record<string, string | null> {
  return (snapshot as { host: { provenance: Record<string, string | null> } }).host
    .provenance;
}

async function seedVerdict(args: {
  editId: number;
  slug: string;
  verdict?: string;
  createdAt?: Date;
  /** When the surviving judgment was written; defaults to `createdAt`. */
  updatedAt?: Date;
  tier?: string;
}): Promise<{ verificationId: number; agentUserId: number }> {
  const userId = await seedUser(db, {
    email: `${args.slug}@example.com`,
    username: args.slug,
    role: 'contributor',
  });
  const [agent] = await db
    .insert(agents)
    .values({
      userId,
      name: args.slug,
      slug: args.slug,
      status: 'active',
      modelTier: args.tier ?? 'mid',
    })
    .returning({ id: agents.id });
  const [verification] = await db
    .insert(agentVerifications)
    .values({
      agentId: agent!.id,
      targetType: 'pending_edit',
      targetId: args.editId,
      verdict: args.verdict ?? 'approve',
      verifierTier: args.tier ?? 'mid',
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      ...(args.updatedAt ?? args.createdAt
        ? { updatedAt: args.updatedAt ?? args.createdAt }
        : {}),
    })
    .returning({ id: agentVerifications.id });
  return { verificationId: verification!.id, agentUserId: userId };
}

/**
 * Write the generic rows the pre-fix mirror wrote: linked, versioned, and
 * projected `pending` whatever the legacy row says.
 *
 * Built by hand rather than by calling the mirror, because the mirror no longer
 * does this — which is the change under test, and a fixture that used it would
 * stop reproducing the state production is carrying.
 */
async function mirrorTheOldWay(editId: number): Promise<void> {
  const space = await ensureKinetixSpace(db);
  const target = await ensureKinetixTarget(
    db,
    { type: 'pending_edit', id: String(editId) },
    space,
  );
  const [proposal] = await db
    .insert(kgProposals)
    .values({
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: `user:${authorId}`,
      authorKind: 'agent',
      state: 'pending',
      legacyPendingEditId: editId,
    })
    .returning({ id: kgProposals.id });
  await db.insert(kgLegacyLinks).values({
    genericType: 'proposal',
    genericId: proposal!.id,
    legacyType: 'pending_edit',
    legacyId: editId,
  });
  const [row] = await db
    .select({ submittedAt: pendingEdits.submittedAt, status: pendingEdits.status })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  await db.insert(kgProposalVersions).values({
    proposalId: proposal!.id,
    versionNo: 1,
    payload: {},
    payloadFingerprint: 'stale-fingerprint',
    authorActorRef: `user:${authorId}`,
    actorKind: 'agent',
    legacyReviewToken: `${row!.submittedAt.toISOString()}|${row!.status}`,
  });
}

async function proposalFor(editId: number) {
  const link = await findByLegacy(db, 'pending_edit', editId);
  if (!link) return null;
  const [row] = await db
    .select({
      id: kgProposals.id,
      state: kgProposals.state,
      closedAt: kgProposals.closedAt,
      createdAt: kgProposals.createdAt,
    })
    .from(kgProposals)
    .where(eq(kgProposals.id, link.genericId));
  return row ?? null;
}

async function proposalKinds(
  editId: number,
): Promise<{ authorKind: string; actorKind: string } | null> {
  const link = await findByLegacy(db, 'pending_edit', editId);
  if (!link) return null;
  const [proposal] = await db
    .select({ authorKind: kgProposals.authorKind })
    .from(kgProposals)
    .where(eq(kgProposals.id, link.genericId));
  const version = await latestVersion(db, link.genericId);
  return {
    authorKind: proposal!.authorKind,
    actorKind: version!.actorKind,
  };
}

async function countRows(): Promise<Record<string, number>> {
  const [proposals, versions, assessments, links, audits] = await Promise.all([
    db.select({ id: kgProposals.id }).from(kgProposals),
    db.select({ id: kgProposalVersions.id }).from(kgProposalVersions),
    db.select({ id: kgAssessments.id }).from(kgAssessments),
    db.select({ id: kgLegacyLinks.id }).from(kgLegacyLinks),
    db.select({ id: kgAuditEvents.id }).from(kgAuditEvents),
  ]);
  return {
    proposals: proposals.length,
    versions: versions.length,
    assessments: assessments.length,
    links: links.length,
    audits: audits.length,
  };
}

describe('the reproduction: live mirroring is not a historical importer', () => {
  it('repair no longer reopens the decided rows it rebuilds', async () => {
    // The plan's reproduction, run through the path that produced it. Before
    // this change `repairMirrors` reported "2/2 repaired" and left both
    // proposals projected `pending` — two `state_mismatch` findings and one
    // `missing_publication`. It repairs through the live mirror, so fixing the
    // mirror's first-contact rule fixes this caller too, which is the point of
    // fixing it there rather than only in the new CLI.
    const approved = await seedEdit({ status: 'approved', statement: 'A' });
    const rejected = await seedEdit({ status: 'rejected', statement: 'R' });
    await enableShadow();

    const preview = await repairMirrors({ db, targetType: 'pending_edit' });
    expect(preview.examined).toBe(2);

    const applied = await repairMirrors({ db, targetType: 'pending_edit', dryRun: false });
    expect(applied.repaired).toBe(2);

    expect(await proposalFor(approved)).toMatchObject({ state: 'applied' });
    expect(await proposalFor(rejected)).toMatchObject({ state: 'rejected' });

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.state_mismatch).toBe(0);
    expect(report.counts.missing_publication).toBe(0);
  });

  it('the importer preserves both outcomes, closes them, and reconciles clean', async () => {
    const approved = await seedEdit({ status: 'approved', statement: 'A' });
    const rejected = await seedEdit({ status: 'rejected', statement: 'R' });
    await enableShadow();

    const run = await importHistoricalSnapshots({ db, dryRun: false });
    expect(run.imported).toBe(2);

    const approvedProposal = await proposalFor(approved);
    expect(approvedProposal!.state).toBe('applied');
    expect(approvedProposal!.closedAt).not.toBeNull();
    const rejectedProposal = await proposalFor(rejected);
    expect(rejectedProposal!.state).toBe('rejected');
    expect(rejectedProposal!.closedAt).not.toBeNull();

    const report = await reconcile(db, { limit: 100 });
    expect(report.divergences).toEqual([]);

    // And no synthetic publication events were written to get there.
    const version = await latestVersion(db, approvedProposal!.id);
    const events = await db
      .select({ id: sql<number>`1` })
      .from(kgAuditEvents)
      .where(eq(kgAuditEvents.eventType, 'publication'));
    expect(events).toEqual([]);
    const provenance = await historicalImportForVersion(db, version!.id);
    expect(provenance?.importedState).toBe('applied');
    expect(provenance?.sourceState).toBe('approved');
    expect(provenance?.historicalCompleteness).toBe('current_state_only');
  });

  it('imports draft, pending and returned rows without closing them', async () => {
    const draft = await seedEdit({ status: 'draft', statement: 'D' });
    const pending = await seedEdit({ status: 'pending', statement: 'P' });
    const returned = await seedEdit({ status: 'returned', statement: 'T' });
    await enableShadow();

    await importHistoricalSnapshots({ db, dryRun: false });

    expect((await proposalFor(draft))!.state).toBe('draft');
    expect((await proposalFor(pending))!.state).toBe('pending');
    expect((await proposalFor(returned))!.state).toBe('returned');
    for (const id of [draft, pending, returned]) {
      expect((await proposalFor(id))!.closedAt).toBeNull();
    }
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('preserves the source submission time as the proposal creation time', async () => {
    const submittedAt = new Date('2024-03-04T05:06:07.000Z');
    const editId = await seedEdit({ status: 'approved', submittedAt });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    expect((await proposalFor(editId))!.createdAt.toISOString()).toBe(
      submittedAt.toISOString(),
    );
  });
});

describe('re-running an import', () => {
  it('writes nothing the second time', async () => {
    await seedEdit({ status: 'approved', statement: 'A' });
    await seedEdit({ status: 'pending', statement: 'P' });
    await seedVerdict({ editId: 1, slug: 'verifier-a' });
    await enableShadow();

    await importHistoricalSnapshots({ db, dryRun: false });
    const before = await countRows();
    const second = await importHistoricalSnapshots({ db, dryRun: false });

    expect(second.imported).toBe(0);
    expect(second.planCounts.already_imported).toBe(2);
    expect(await countRows()).toEqual(before);
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('resumes a bounded batch without re-examining the first page', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedEdit({ status: 'approved', statement: `A${i}` }));
    }
    await enableShadow();

    const first = await importHistoricalSnapshots({ db, dryRun: false, limit: 2, pageSize: 2 });
    expect(first.imported).toBe(2);
    expect(first.scanComplete).toBe(false);
    expect(first.nextCursor).toBe(ids[1]);

    const second = await importHistoricalSnapshots({
      db,
      dryRun: false,
      limit: 2,
      pageSize: 2,
      after: first.nextCursor!,
    });
    expect(second.imported).toBe(2);
    expect(second.outcomes.map((o) => o.plan.legacyId)).toEqual([ids[2], ids[3]]);
    expect(second.scanComplete).toBe(false);

    const third = await importHistoricalSnapshots({
      db,
      dryRun: false,
      limit: 2,
      pageSize: 2,
      after: second.nextCursor!,
    });
    expect(third.imported).toBe(1);
    expect(third.scanComplete).toBe(true);
    expect(third.nextCursor).toBeNull();
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('never reports a partial scan as complete', async () => {
    for (let i = 0; i < 4; i++) await seedEdit({ status: 'approved', statement: `A${i}` });
    await enableShadow();
    const report = await importHistoricalSnapshots({ db, limit: 3, pageSize: 2 });
    expect(report.examined).toBe(3);
    expect(report.scanComplete).toBe(false);
    expect(describeHistoricalImport(report)).toContain('scan complete:    NO');
  });

  it('pages through a population larger than one scan page', async () => {
    for (let i = 0; i < 7; i++) await seedEdit({ status: 'approved', statement: `A${i}` });
    await enableShadow();
    const report = await importHistoricalSnapshots({ db, dryRun: false, limit: 100, pageSize: 2 });
    expect(report.examined).toBe(7);
    expect(report.imported).toBe(7);
    expect(report.scanComplete).toBe(true);
  });
});

describe('atomicity and concurrency', () => {
  it('writes nothing at all when part of the import fails', async () => {
    const editId = await seedEdit({ status: 'approved' });
    // `agent_verifications.verdict` is VARCHAR(20) and `kg_assessments.verdict`
    // is VARCHAR(16), so a legacy row can hold a verdict the generic table
    // refuses. It fails on the assessment insert — after the proposal, the
    // version and the provenance record have been written — which is exactly
    // the shape that leaves a proposal claiming a history it does not have when
    // the import is not one unit of work.
    await seedVerdict({ editId, slug: 'verifier-a', verdict: 'approve-with-notes' });
    await enableShadow();

    const outcome = await importHistoricalProposal({
      legacyType: 'pending_edit',
      legacyId: editId,
    });
    expect(outcome.result).toBe('failed');
    expect(await proposalFor(editId)).toBeNull();
    const versions = await db.select({ id: kgProposalVersions.id }).from(kgProposalVersions);
    expect(versions).toEqual([]);
    const provenance = await db
      .select({ id: kgAuditEvents.id })
      .from(kgAuditEvents)
      .where(eq(kgAuditEvents.eventType, HISTORICAL_IMPORT_EVENT));
    expect(provenance).toEqual([]);
  });

  it('lets a failure escape an ambient transaction rather than swallowing it', async () => {
    // `inTransaction` joins a caller's transaction instead of opening its own,
    // and `mirrorAssessment` reaches the import that way. A catch here would
    // turn a half-written import into a resolved `failed` outcome and let the
    // caller commit the rows already inserted — the all-or-nothing promise
    // holding everywhere except the one path that joins a caller.
    const editId = await seedEdit({ status: 'approved' });
    // VARCHAR(20) in legacy, VARCHAR(16) in `kg_assessments`: fails on the
    // assessment insert, after the proposal, version and provenance are in.
    await seedVerdict({ editId, slug: 'verifier-a', verdict: 'approve-with-notes' });
    await enableShadow();

    await expect(
      runInPoolTransaction(async () => {
        await importHistoricalProposal({
          legacyType: 'pending_edit',
          legacyId: editId,
        });
      }),
    ).rejects.toThrow();

    // The outer transaction rolled back, so none of the partial writes stand.
    expect(await proposalFor(editId)).toBeNull();
    expect(await db.select({ id: kgProposalVersions.id }).from(kgProposalVersions)).toEqual([]);
  });

  it('joins an ambient transaction, so an outer rollback discards the import', async () => {
    // The transaction-context check the PGlite harness *can* discharge: it
    // cannot prove real pool-lock behaviour (one connection, re-entrant
    // advisory locks), but it can prove the import is not opening a second
    // transaction that commits independently of its caller.
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();

    await expect(
      runInPoolTransaction(async () => {
        const outcome = await importHistoricalProposal({
          legacyType: 'pending_edit',
          legacyId: editId,
        });
        expect(outcome.result).toBe('imported');
        expect(await findByLegacy(getDb(), 'pending_edit', editId)).not.toBeNull();
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(await proposalFor(editId)).toBeNull();
  });

  it('leaves a row alone when the source moved since it was captured', async () => {
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();

    const outcome = await importHistoricalProposal({
      legacyType: 'pending_edit',
      legacyId: editId,
      expect: { sourceState: 'approved', sourceVersionToken: 'stale|approved' },
    });
    expect(outcome.result).toBe('stale_capture');
    expect(await proposalFor(editId)).toBeNull();
  });

  it('does not duplicate history when two imports race the same row', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();

    const [a, b] = await Promise.all([
      importHistoricalProposal({ legacyType: 'pending_edit', legacyId: editId }),
      importHistoricalProposal({ legacyType: 'pending_edit', legacyId: editId }),
    ]);
    const results = [a.result, b.result].sort();
    expect(results).toEqual(['imported', 'skipped']);
    const proposals = await db.select({ id: kgProposals.id }).from(kgProposals);
    expect(proposals).toHaveLength(1);
  });
});

describe('provenance', () => {
  it('rebuilds the imported outcome from the record instead of reopening it', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    const proposal = await proposalFor(editId);

    // Corrupt the projection the way a half-finished write would.
    await db
      .update(kgProposals)
      .set({ state: 'pending', closedAt: null })
      .where(eq(kgProposals.id, proposal!.id));

    expect(await rebuildImportedProjection(db, proposal!.id)).toBe('applied');
    const rebuilt = await proposalFor(editId);
    expect(rebuilt!.state).toBe('applied');
    expect(rebuilt!.closedAt).not.toBeNull();
  });

  it('does not reopen a proposal that was imported open and published later', async () => {
    // The import record is that version's history, but not necessarily all of
    // it: a row imported while still open can be published afterwards, and that
    // publication is an ordinary event against the same version. Reading only
    // the record put the proposal back to the state the snapshot captured —
    // and `setProposalState` derives `closed_at` from the state, so the rebuild
    // did not merely fail to notice the publication, it actively reopened
    // applied work.
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    const proposal = await proposalFor(editId);
    expect(proposal!.state).toBe('pending');

    // Published for real, after the import — through the live mirror, so the
    // event is written exactly as production would write it.
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));
    const published = await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: `user:${authorId}`,
    });
    expect(published.mirrored).toBe(true);

    expect(await rebuildImportedProjection(db, proposal!.id)).toBe('applied');
    const rebuilt = await proposalFor(editId);
    expect(rebuilt!.state).toBe('applied');
    expect(rebuilt!.closedAt).not.toBeNull();
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('keeps the closure at the time it was published, not the time it was rebuilt', async () => {
    // `setProposalState` derives `closed_at` from the state and defaults it to
    // now. That is right when `mirrorPublicationOutcome` writes it — the event
    // has just been recorded — and wrong on a rebuild, which may run months
    // later and would restamp the closure with the day it ran.
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    const proposal = await proposalFor(editId);

    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));
    await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: `user:${authorId}`,
    });
    const version = await latestVersion(db, proposal!.id);
    const [event] = await listPublicationEvents(db, version!.id);

    // Backdate the event, so "the event's time" and "now" are far apart and the
    // assertion cannot pass by coincidence.
    const publishedAt = new Date('2025-03-04T05:06:07.000Z');
    await db
      .update(kgPublicationEvents)
      .set({ createdAt: publishedAt })
      .where(eq(kgPublicationEvents.id, event!.id));

    expect(await rebuildImportedProjection(db, proposal!.id)).toBe('applied');
    const rebuilt = await proposalFor(editId);
    expect(rebuilt!.closedAt!.toISOString()).toBe(publishedAt.toISOString());
  });

  it('finds the import record behind any amount of later audit noise', async () => {
    // The record was read out of a newest-first window of every event on the
    // version, so unrelated volume could answer the question. Fifty later
    // events — `authoritative_publish_failed` retries are recorded against this
    // same subject — pushed the import out of sight, and every reader treats
    // "no record" as "never imported": the rebuild stops recovering the
    // outcome, and reconciliation holds the version to the ordinary
    // `missing_publication` rule.
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    const proposal = await proposalFor(editId);
    const version = await latestVersion(db, proposal!.id);
    const space = await ensureKinetixSpace(db);

    for (let i = 0; i < 60; i += 1) {
      await recordAuditEvent(db, {
        spaceId: space.id,
        eventType: 'authoritative_publish_failed',
        subjectType: 'proposal_version',
        subjectId: version!.id,
        payload: { pendingEditId: editId, error: `attempt ${i}` },
      });
    }

    const record = await historicalImportForVersion(db, version!.id);
    expect(record).not.toBeNull();
    expect(record!.importedState).toBe('applied');
    expect(await rebuildImportedProjection(db, proposal!.id)).toBe('applied');
    // And the reconciliation exception, which reads the same record: still
    // excused, not suddenly a `missing_publication`.
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('keeps the finding when the import record is missing', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    await db
      .delete(kgAuditEvents)
      .where(eq(kgAuditEvents.eventType, HISTORICAL_IMPORT_EVENT));

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_publication).toBe(1);
    expect(report.divergences[0]!.detail).toContain('no_import_record');
    void editId;
  });

  it('keeps the finding when the import record is malformed', async () => {
    await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    await db
      .update(kgAuditEvents)
      .set({ payload: { origin: 'legacy_snapshot', capturedAt: 'yesterday' } })
      .where(eq(kgAuditEvents.eventType, HISTORICAL_IMPORT_EVENT));

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_publication).toBe(1);
    expect(report.divergences[0]!.detail).toContain('malformed_import_record');
  });

  it('keeps the finding when the source state has moved since capture', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    // Same row, imported as applied, now says something else about itself: the
    // recorded evidence no longer describes the source, so it stops excusing
    // anything. (`state_mismatch` fires too — that is the point.)
    await db
      .update(pendingEdits)
      .set({ status: 'approved', submittedAt: new Date('2030-01-01T00:00:00.000Z') })
      .where(eq(pendingEdits.id, editId));

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_publication).toBe(1);
    expect(report.divergences.some((d) => d.detail.includes('source_version_changed'))).toBe(true);
  });

  it('still requires a publication event for a natively mirrored proposal', async () => {
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    // Legacy approves without the publication mirror ever landing.
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_publication).toBe(1);
    expect(report.divergences.some((d) => d.detail.includes('no_import_record'))).toBe(true);
  });

  it('still requires a publication event for a proposal imported open', async () => {
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, editId));

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_publication).toBe(1);
    expect(
      report.divergences.some(
        (d) => d.kind === 'missing_publication' && d.detail.includes('imported_open'),
      ),
    ).toBe(true);
  });

  it('still requires a publication event for a later version of an imported proposal', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    const proposal = await proposalFor(editId);

    // A second version of the same proposal carries no import record of its
    // own, so nothing excuses it. The exception is version-scoped precisely so
    // an import cannot become a blanket exemption for a proposal.
    const first = await latestVersion(db, proposal!.id);
    await db.insert(kgProposalVersions).values({
      proposalId: proposal!.id,
      versionNo: first!.versionNo + 1,
      payload: first!.payload,
      payloadFingerprint: first!.payloadFingerprint,
      authorActorRef: first!.authorActorRef,
      actorKind: first!.actorKind,
      legacyReviewToken: first!.legacyReviewToken,
    });

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_publication).toBe(1);
    expect(report.divergences.some((d) => d.detail.includes('no_import_record'))).toBe(true);
  });

  it('accepts a real publication event on an imported version too', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    const proposal = await proposalFor(editId);
    const version = await latestVersion(db, proposal!.id);
    await recordPublicationEvent(db, {
      proposalVersionId: version!.id,
      action: 'applied',
      actorRef: `user:${authorId}`,
    });
    expect((await reconcile(db, { limit: 100 })).counts.missing_publication).toBe(0);
  });
});

describe('imported assessments', () => {
  it('binds a verdict to the version only when the source is still open', async () => {
    const openEdit = await seedEdit({ status: 'pending', statement: 'P' });
    const closedEdit = await seedEdit({ status: 'approved', statement: 'A' });
    const open = await seedVerdict({ editId: openEdit, slug: 'verifier-open' });
    const closed = await seedVerdict({ editId: closedEdit, slug: 'verifier-closed' });
    await enableShadow();

    await importHistoricalSnapshots({ db, dryRun: false });

    const rows = await db
      .select({
        subjectType: kgAssessments.subjectType,
        capabilitySnapshot: kgAssessments.capabilitySnapshot,
        actorRef: kgAssessments.actorRef,
        createdAt: kgAssessments.createdAt,
      })
      .from(kgAssessments);
    const byActor = new Map(rows.map((r) => [r.actorRef, r]));

    const bound = byActor.get(`user:${open.agentUserId}`)!;
    expect(bound.subjectType).toBe('proposal_version');
    expect(hostProvenance(bound.capabilitySnapshot).versionBinding).toBe('established');

    const unbound = byActor.get(`user:${closed.agentUserId}`)!;
    expect(unbound.subjectType).toBe('target');
    const provenance = hostProvenance(unbound.capabilitySnapshot);
    expect(provenance.versionBinding).toBe('unestablished');
    expect(provenance.versionBindingReason).toBe('source_closed_after_review');
    void closed;
  });

  it('does not attach a verdict cast before the current revision', async () => {
    const submittedAt = new Date('2025-06-01T00:00:00.000Z');
    const editId = await seedEdit({ status: 'pending', submittedAt });
    const stale = await seedVerdict({
      editId,
      slug: 'verifier-stale',
      createdAt: new Date('2025-05-01T00:00:00.000Z'),
    });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const [row] = await db
      .select({
        subjectType: kgAssessments.subjectType,
        capabilitySnapshot: kgAssessments.capabilitySnapshot,
      })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${stale.agentUserId}`));
    expect(row!.subjectType).toBe('target');
    expect(hostProvenance(row!.capabilitySnapshot).versionBindingReason).toBe(
      'verdict_predates_current_revision',
    );
  });

  it('dates a recast verdict by when it was recast, not when it was first cast', async () => {
    // `recordVerification` upserts on `(agent_id, target_type, target_id)`: the
    // `onConflictDoUpdate` keeps `created_at` and moves `updated_at`. So on a
    // row an agent changed its mind about, `created_at` belongs to a verdict
    // that no longer exists, and importing at it would date the surviving
    // judgment to the overwritten one.
    const firstJudged = new Date('2025-01-01T00:00:00.000Z');
    const recastAt = new Date('2025-07-01T00:00:00.000Z');
    const editId = await seedEdit({ status: 'approved' });
    const verdict = await seedVerdict({
      editId,
      slug: 'verifier-recast',
      createdAt: firstJudged,
      updatedAt: recastAt,
    });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const [row] = await db
      .select({
        createdAt: kgAssessments.createdAt,
        capabilitySnapshot: kgAssessments.capabilitySnapshot,
      })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(row!.createdAt.toISOString()).toBe(recastAt.toISOString());
    // The overwritten judgment's time is not lost, and is labelled as what it
    // is — the difference between the two IS the declared incompleteness.
    const provenance = hostProvenance(row!.capabilitySnapshot);
    expect(provenance.sourceJudgedAt).toBe(recastAt.toISOString());
    expect(provenance.sourceFirstJudgedAt).toBe(firstJudged.toISOString());
  });

  it('binds a verdict recast against the current revision', async () => {
    // The consequence of reading the wrong timestamp: this verdict was first
    // cast before the row was revised and recast after, so it judged the
    // current payload. Dated by `created_at` it looks like it predates the
    // revision, and a genuinely current approval gets filed as unbindable.
    const submittedAt = new Date('2025-06-01T00:00:00.000Z');
    const editId = await seedEdit({ status: 'pending', submittedAt });
    const verdict = await seedVerdict({
      editId,
      slug: 'verifier-recast-open',
      createdAt: new Date('2025-05-01T00:00:00.000Z'),
      updatedAt: new Date('2025-06-02T00:00:00.000Z'),
    });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const [row] = await db
      .select({
        subjectType: kgAssessments.subjectType,
        capabilitySnapshot: kgAssessments.capabilitySnapshot,
      })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(row!.subjectType).toBe('proposal_version');
    expect(hostProvenance(row!.capabilitySnapshot).versionBinding).toBe('established');
  });

  it('binds a verdict a target-level snapshot already claimed', async () => {
    // `snapshotLegacyVerifications` reads verdicts by `(target_type,
    // target_id)` and can never establish which revision each one judged, so it
    // links a *target-level* assessment. The importer is the path that can
    // establish the binding — and skipping on the link alone made it decline
    // to. The failure is quiet in the worst way: reconciliation checks only
    // that the legacy row is linked, so the row reads clean while the version
    // carries no assessment at all, and no later mirror repairs it because an
    // unchanged verdict never triggers one.
    const editId = await seedEdit({ status: 'pending' });
    const verdict = await seedVerdict({ editId, slug: 'verifier-snapshotted' });
    await enableShadow();
    const snapshot = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    expect(snapshot.imported).toBe(1);

    await importHistoricalSnapshots({ db, dryRun: false });

    const rows = await db
      .select({
        id: kgAssessments.id,
        subjectType: kgAssessments.subjectType,
        subjectId: kgAssessments.subjectId,
      })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    const proposal = await proposalFor(editId);
    const version = await latestVersion(db, proposal!.id);
    const boundRows = rows.filter(
      (r) => r.subjectType === 'proposal_version' && r.subjectId === version!.id,
    );
    expect(boundRows).toHaveLength(1);
    // The history it was imported as stays exactly where it was: a different
    // subject is not a supersession, and the snapshot is still true.
    expect(rows.filter((r) => r.subjectType === 'target')).toHaveLength(1);

    // One legacy row, one link — the store refuses two generic records claiming
    // it, so the binding is added without a second link.
    const links = await db
      .select({ genericId: kgLegacyLinks.genericId })
      .from(kgLegacyLinks)
      .where(
        and(
          eq(kgLegacyLinks.legacyType, 'agent_verification'),
          eq(kgLegacyLinks.legacyId, verdict.verificationId),
        ),
      );
    expect(links).toHaveLength(1);

    // Inert on a second pass: the binding now exists, so there is nothing left
    // to write.
    await importHistoricalSnapshots({ db, dryRun: false });
    expect(
      await db
        .select({ id: kgAssessments.id })
        .from(kgAssessments)
        .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`)),
    ).toHaveLength(2);
  });

  it('leaves an unbindable snapshotted verdict as history', async () => {
    // The other half of the same rule: where the source does not prove the
    // verdict judged this revision, the link means what it always meant and the
    // importer writes nothing.
    const editId = await seedEdit({ status: 'approved' });
    const verdict = await seedVerdict({ editId, slug: 'verifier-snapshot-closed' });
    await enableShadow();
    await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    await importHistoricalSnapshots({ db, dryRun: false });

    const rows = await db
      .select({ subjectType: kgAssessments.subjectType })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectType).toBe('target');
  });

  it('preserves the original judgment time and the server-owned tier', async () => {
    const castAt = new Date('2025-02-03T04:05:06.000Z');
    const editId = await seedEdit({ status: 'approved' });
    const verdict = await seedVerdict({
      editId,
      slug: 'verifier-tiered',
      createdAt: castAt,
      tier: 'flagship',
    });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const [row] = await db
      .select({
        createdAt: kgAssessments.createdAt,
        capabilitySnapshot: kgAssessments.capabilitySnapshot,
        supersedes: kgAssessments.supersedesAssessmentId,
      })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(row!.createdAt.toISOString()).toBe(castAt.toISOString());
    // The tier is stored as the capability a gate reads, not as a raw tier
    // field — the canonical shape states the qualification once.
    expect(
      (row!.capabilitySnapshot as { assuranceCapabilities: string[] })
        .assuranceCapabilities,
    ).toEqual(['model_tier:flagship']);
    // §6.4: no invented supersession chain for a table that upserts.
    expect(row!.supersedes).toBeNull();
  });

  it('satisfies the scanner without leaving a missing_assessment finding', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await seedVerdict({ editId, slug: 'verifier-a' });
    await seedVerdict({ editId, slug: 'verifier-b', verdict: 'dispute' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('shows an unbound imported verdict in the history, without making it version evidence', async () => {
    // The two halves have to hold together. An imported verdict whose reviewed
    // version the source cannot establish is deliberately not version evidence
    // — but it is history, and both readers of "the complete record" collected
    // assessments per version only, so it appeared in neither. The legacy link
    // exists, so reconciliation reports the row clean; the judgment was then
    // visible nowhere but the CLI run that imported it.
    const editId = await seedEdit({ status: 'approved' });
    const verdict = await seedVerdict({ editId, slug: 'verifier-history' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const view = (await moderatorViewForLegacy('pending_edit', editId, { db }))!;
    expect(view.targetAssessments.map((a) => a.actorRef)).toEqual([
      `user:${verdict.agentUserId}`,
    ]);
    // Still not attached to any version, and still absent from what a gate
    // reads — the separation the importer recorded has to survive the read.
    expect(view.assessments).toEqual([]);
    expect(view.effectiveAssessments).toEqual([]);

    const history = await governanceClient({ db }).history.forLegacy(
      'pending_edit',
      editId,
    );
    expect(history!.targetAssessments.map((a) => a.actorRef)).toEqual([
      `user:${verdict.agentUserId}`,
    ]);
    expect(history!.assessments).toEqual([]);
  });

  it('does not inflate fresh policy observations', async () => {
    // A dossier's `policy.observed` is the evidence an operator advances a
    // target on. Historical rows are decided; counting them would report
    // observation the migration has not actually accumulated.
    await seedEdit({ status: 'approved', statement: 'A' });
    await seedEdit({ status: 'rejected', statement: 'R' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const dossier = await buildDossier('wiki_fact', { db, limit: 50 });
    expect(dossier.policy.observed).toBe(0);
    expect(dossier.coverage.mirrored).toBe(2);
  });
});

describe('the preview', () => {
  it('predicts exactly what the apply run does', async () => {
    await seedEdit({ status: 'approved', statement: 'A' });
    await seedEdit({ status: 'rejected', statement: 'R' });
    await seedEdit({ status: 'pending', statement: 'P' });
    await enableShadow();

    const preview = await importHistoricalSnapshots({ db, limit: 50 });
    expect(preview.dryRun).toBe(true);
    expect(preview.imported).toBe(0);
    expect(await countRows()).toMatchObject({ proposals: 0, versions: 0 });

    const applied = await importHistoricalSnapshots({ db, dryRun: false, limit: 50 });
    expect(applied.planCounts).toEqual(preview.planCounts);
    expect(applied.stateCounts).toEqual(preview.stateCounts);
    expect(applied.imported).toBe(preview.planCounts.import);
    expect(applied.outcomes.map((o) => o.plan.proposedState)).toEqual(
      preview.outcomes.map((o) => o.plan.proposedState),
    );
  });

  it('reports nothing left over when a completed import is previewed again', async () => {
    // The mirror image of the test below, and the failure it guards is the
    // opposite one: planning a rerun as though no version existed classified a
    // verdict already bound to that version as work this run would do, the
    // skipped branch then recast it as `unresolved`, and the CLI reported
    // `LEFT UNMIRRORED` — with a non-zero exit — for a row reconciliation calls
    // clean. A preview that invents work stops a batch runner just as
    // effectively as one that hides it.
    const editId = await seedEdit({ status: 'pending' });
    await seedVerdict({ editId, slug: 'verifier-rerun' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);

    const rerun = await importHistoricalSnapshots({ db, limit: 50 });
    expect(rerun.planCounts.already_imported).toBe(1);
    expect(rerun.assessments.unresolved).toBe(0);
    expect(rerun.assessments.alreadyImported).toBe(1);
    expect(rerun.outcomes[0]!.plan.predictedFindings).toEqual([]);
    expect(describeHistoricalImport(rerun)).not.toContain('LEFT UNMIRRORED');
  });

  it('reports nothing left over when a snapshotted verdict was bound by an earlier import', async () => {
    // The residue of the binding fix. When a target-level snapshot already
    // claims the legacy row, the version-bound assessment the import writes
    // carries no second link — the store refuses two generic records for one
    // legacy row. So on a rerun the link still names the target-level record,
    // and a plan that asks only that question reports the binding as work it
    // will do, every time: `LEFT UNMIRRORED` and a non-zero exit for a row
    // reconciliation calls clean, for as long as the row exists.
    const editId = await seedEdit({ status: 'pending' });
    await seedVerdict({ editId, slug: 'verifier-rebound' });
    await enableShadow();
    await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    await importHistoricalSnapshots({ db, dryRun: false });
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);

    const rerun = await importHistoricalSnapshots({ db, limit: 50 });
    expect(rerun.assessments.unresolved).toBe(0);
    expect(rerun.assessments.alreadyImported).toBe(1);
    expect(rerun.outcomes[0]!.plan.predictedFindings).toEqual([]);
    expect(describeHistoricalImport(rerun)).not.toContain('LEFT UNMIRRORED');
  });

  it('reports a binding that no longer says what legacy says', async () => {
    // A binding that exists is not automatically a binding that is current.
    // The verdict can have been recast since, with the mirror that would have
    // revised it lost — it is fire-and-forget — leaving the version holding a
    // withdrawn approval. Matching on the actor alone would put the preview's
    // name to that, and reconciliation cannot contradict it: `missing_assessment`
    // asks only whether the legacy row is linked.
    const editId = await seedEdit({ status: 'pending' });
    const verdict = await seedVerdict({ editId, slug: 'verifier-stale-bind' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    // The agent changes its mind; the mirror that would have revised the
    // assessment never runs.
    await db
      .update(agentVerifications)
      .set({ verdict: 'dispute', updatedAt: new Date() })
      .where(eq(agentVerifications.id, verdict.verificationId));

    const rerun = await importHistoricalSnapshots({ db, limit: 50 });
    expect(rerun.assessments.staleBindings).toBe(1);
    expect(rerun.assessments.alreadyImported).toBe(0);
    // And named for a human. Counting it while exiting 0 would let a batch
    // runner walk past a version still serving a withdrawn approval.
    expect(rerun.revisit).toEqual([editId]);
    // Not a `missing_assessment`: there *is* a record, so predicting one would
    // be predicting something reconciliation will not say.
    expect(rerun.outcomes[0]!.plan.predictedFindings).toEqual([]);
    expect(rerun.assessments.unresolved).toBe(0);
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
    expect(describeHistoricalImport(rerun)).toContain('BOUND BUT STALE');
    expect(describeHistoricalImport(rerun)).toContain('NEEDS ATTENTION');
  });

  it('refuses a target type it cannot scan, rather than reporting a clean sweep of it', async () => {
    // The scan walks `pending_edits` and nothing else. Accepting another
    // `--target-type` and walking it anyway gave every row `no_source_row`, so
    // the command reported a complete scan of the requested population and
    // exited 0 having examined none of it.
    await seedEdit({ status: 'approved' });
    await enableShadow();
    await expect(
      importHistoricalSnapshots({ db, legacyType: 'drug_parameter' }),
    ).rejects.toThrow(/no source scan for target type/);
  });

  it('predicts the assessments a skipped row leaves unmirrored', async () => {
    // A row whose proposal already exists is skipped whole, so its unmirrored
    // verdicts stay unmirrored and the scanner keeps reporting each one. A
    // preview that counted them as bindings it was about to make — and then
    // said "expected findings: none" — would describe an import that is not
    // going to happen, and hide the work that remains.
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    await seedVerdict({ editId, slug: 'verifier-unmirrored' });

    const preview = await importHistoricalSnapshots({ db, limit: 50 });
    const item = preview.outcomes[0]!.plan;
    expect(item.kind).toBe('already_mirrored');
    expect(item.predictedFindings).toContain('missing_assessment');
    // Reported as work left, not as a binding the run will make.
    expect(item.assessments).toMatchObject({
      total: 1,
      versionBound: 0,
      unbound: 0,
      unresolved: 1,
    });
    expect(preview.predictedFindings.missing_assessment).toBe(1);
    expect(describeHistoricalImport(preview)).toContain('LEFT UNMIRRORED');

    // And the prediction is what reconciliation actually reports.
    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.missing_assessment).toBe(1);
  });

  it('does not exit clean over a legacy status it cannot map', async () => {
    // A status added to `pending_edits` before this importer learned about it.
    // The plan says `unmappable_state` and predicts `missing_proposal`, so the
    // run reports the divergence — and used to exit 0 anyway, advancing the
    // cursor past a row it had explicitly said it could not import. That reads
    // as a completed backfill over a lifecycle value nobody has supported yet.
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await db
      .update(pendingEdits)
      .set({ status: 'escalated' })
      .where(eq(pendingEdits.id, editId));

    const applied = await importHistoricalSnapshots({ db, dryRun: false, limit: 50 });
    const plan = applied.outcomes[0]!.plan;
    expect(plan.kind).toBe('unmappable_state');
    expect(plan.predictedFindings).toContain('missing_proposal');
    expect(applied.revisit).toEqual([editId]);
    expect(describeHistoricalImport(applied)).toContain('NEEDS ATTENTION');
  });

  it('does not exit clean over a verdict a skipped row leaves unmirrored', async () => {
    // Predicting the divergence is not the same as stopping for it. `--apply`
    // skips an already-mirrored row whole, so its unmirrored verdicts stay
    // unmirrored; with `revisit` empty the command exits 0 and a cursor-driven
    // batch advances past work it has just finished reporting. The exit code
    // exists for exactly that, and a stale binding — the other divergence this
    // run finds and does not fix — is already listed on the same argument.
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    await seedVerdict({ editId, slug: 'verifier-left-behind' });

    const applied = await importHistoricalSnapshots({ db, dryRun: false, limit: 50 });
    expect(applied.outcomes[0]!.plan.kind).toBe('already_mirrored');
    expect(applied.assessments.unresolved).toBe(1);
    expect(applied.revisit).toEqual([editId]);
    expect(describeHistoricalImport(applied)).toContain('NEEDS ATTENTION');

    // And it is a real divergence, not a bookkeeping artefact.
    expect((await reconcile(db, { limit: 100 })).counts.missing_assessment).toBe(1);
  });

  it('predicts the findings a row already mirrored the old way will leave', async () => {
    // Production already holds rows mirrored before this fix existed, and the
    // importer will not touch them — a linked proposal is not its to rewrite.
    // What it must not do is call them "nothing to do": the preview says which
    // findings they will still produce, so the operator sees the work rather
    // than reading a clean plan over a diverging table.
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await mirrorTheOldWay(editId);

    const preview = await importHistoricalSnapshots({ db, limit: 50 });
    const item = preview.outcomes[0]!.plan;
    expect(item.kind).toBe('already_mirrored');
    expect([...item.predictedFindings].sort()).toEqual([
      'missing_publication',
      'state_mismatch',
    ]);
    expect(preview.predictedFindings.state_mismatch).toBe(1);

    const report = await reconcile(db, { limit: 100 });
    expect(report.counts.state_mismatch).toBe(1);
    expect(report.counts.missing_publication).toBe(1);
  });

  it('names the rows the resume cursor would walk past', async () => {
    // `--after` records where the *scan* stopped, not which rows landed. A row
    // examined and not imported sits behind the cursor, so a batch runner
    // following it would never come back — and a later run would then report a
    // complete scan over a population it had not imported. `revisit` is what
    // makes that hole visible, and what the CLI exits non-zero on.
    const first = await seedEdit({ status: 'approved', statement: 'A' });
    const second = await seedEdit({ status: 'approved', statement: 'B' });

    // No shadow: every row is examined and none is written.
    const blocked = await importHistoricalSnapshots({ db, dryRun: false });
    expect(blocked.imported).toBe(0);
    expect(blocked.scanComplete).toBe(true);
    expect(blocked.revisit).toEqual([first, second]);
    expect(describeHistoricalImport(blocked)).toContain('NEEDS ATTENTION');

    // And a run that imported everything leaves nothing to come back to, so the
    // signal means something when it does fire.
    await enableShadow();
    const clean = await importHistoricalSnapshots({ db, dryRun: false });
    expect(clean.imported).toBe(2);
    expect(clean.revisit).toEqual([]);
    expect(describeHistoricalImport(clean)).not.toContain('NEEDS ATTENTION');
  });

  it('says so rather than writing when the migration mode forbids it', async () => {
    await seedEdit({ status: 'approved' });
    // No shadow: `pending_edit` resolves `legacy_only`.
    const report = await importHistoricalSnapshots({ db, dryRun: false });
    expect(report.writable).toBe(false);
    expect(report.imported).toBe(0);
    expect(report.outcomes[0]!.result).toBe('blocked_by_mode');
    expect(await countRows()).toMatchObject({ proposals: 0 });
    expect(describeHistoricalImport(report)).toContain('generic writes are not permitted');
  });

  it('scopes to one edit type', async () => {
    await seedEdit({ status: 'approved', statement: 'A' });
    await seedEdit({ status: 'approved', statement: 'B', editType: 'wiki_section' });
    await enableShadow();
    const report = await importHistoricalSnapshots({ db, editType: 'wiki_fact', limit: 50 });
    expect(report.examined).toBe(1);
  });
});

describe('first-contact live mirroring', () => {
  it('imports rather than reopening an already-decided row', async () => {
    // Fixing only the CLI would leave the request path recreating the same bad
    // state: the mirror meets a closed row on first contact whenever an earlier
    // mirror was lost and the row has since been moderated.
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();

    const outcome = await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    expect(outcome.mirrored).toBe(true);

    const proposal = await proposalFor(editId);
    expect(proposal!.state).toBe('applied');
    expect(proposal!.closedAt).not.toBeNull();
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('still mirrors an open row as an ordinary live proposal', async () => {
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    const proposal = await proposalFor(editId);
    expect(proposal!.state).toBe('pending');
    const version = await latestVersion(db, proposal!.id);
    expect(await historicalImportForVersion(db, version!.id)).toBeNull();
  });

  it('does not promote an imported historical judgment onto the version', async () => {
    // The seam that could undo the importer's care. `mirrorAssessment` finds a
    // legacy link for the verdict — the importer wrote it — and its
    // change-of-mind branch reads only version-bound rows, so without the guard
    // it sees "no current assessment", inserts a fresh one against the version,
    // and quietly attaches to today's payload the approval the importer
    // deliberately kept as target-level history.
    const editId = await seedEdit({ status: 'approved' });
    const verdict = await seedVerdict({ editId, slug: 'verifier-a' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const outcome = await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: verdict.verificationId,
      actorRef: `user:${verdict.agentUserId}`,
      verdict: 'approve',
    });
    // `unbindable_history`, not `already_mirrored`: nothing about this verdict
    // is mirrored against this version, and the skip must not read as though
    // the two sides had converged.
    expect(outcome).toMatchObject({ mirrored: false, skipped: 'unbindable_history' });

    const rows = await db
      .select({ subjectType: kgAssessments.subjectType })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectType).toBe('target');
  });

  it('lets a genuinely recast verdict reach the current version', async () => {
    // The other half of the guard above, and the failure mode it must not
    // create. A `returned` edit is imported as history (its reviewed version
    // cannot be established), then resubmitted and re-judged. The legacy id is
    // the same — `agent_verifications` upserts — so a guard that read the link
    // as permanent proof would skip every later verdict and the generic side
    // could never converge for that row.
    const submittedAt = new Date('2025-06-01T00:00:00.000Z');
    const editId = await seedEdit({ status: 'returned', submittedAt });
    const verdict = await seedVerdict({
      editId,
      slug: 'verifier-returned',
      createdAt: new Date('2025-06-02T00:00:00.000Z'),
    });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const [imported] = await db
      .select({ subjectType: kgAssessments.subjectType })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(imported!.subjectType).toBe('target');

    // The author revises and resubmits; the agent recasts, which moves
    // `updated_at` and leaves `created_at` alone.
    const resubmittedAt = new Date('2025-08-01T00:00:00.000Z');
    await db
      .update(pendingEdits)
      .set({ status: 'pending', submittedAt: resubmittedAt })
      .where(eq(pendingEdits.id, editId));
    await db
      .update(agentVerifications)
      .set({ verdict: 'dispute', updatedAt: new Date('2025-08-02T00:00:00.000Z') })
      .where(eq(agentVerifications.id, verdict.verificationId));

    const outcome = await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: verdict.verificationId,
      actorRef: `user:${verdict.agentUserId}`,
      verdict: 'dispute',
    });
    expect(outcome.mirrored).toBe(true);

    const rows = await db
      .select({
        subjectType: kgAssessments.subjectType,
        verdict: kgAssessments.verdict,
        supersedes: kgAssessments.supersedesAssessmentId,
      })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verdict.agentUserId}`));
    expect(rows).toHaveLength(2);
    const bound = rows.find((r) => r.subjectType === 'proposal_version')!;
    expect(bound.verdict).toBe('dispute');
    // A different subject is not a chain: the new judgment does not claim to
    // supersede the target-level historical row.
    expect(bound.supersedes).toBeNull();
  });

  it('refuses to bind a recast verdict to a version it never reviewed', async () => {
    // The gap between "newer than the import" and "judged this payload". The
    // verdict is recast after the resubmission, so it is genuinely newer than
    // the imported snapshot — and then the payload is revised again with no
    // further verdict. Binding on recency alone attaches that approval to a
    // version its author never saw, which is the promotion the guard exists to
    // prevent, reached from the other side.
    const editId = await seedEdit({
      status: 'returned',
      submittedAt: new Date('2025-06-01T00:00:00.000Z'),
    });
    const verdict = await seedVerdict({
      editId,
      slug: 'verifier-unreviewed',
      createdAt: new Date('2025-06-02T00:00:00.000Z'),
    });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    // Resubmitted, and the agent recasts against that revision.
    await db
      .update(pendingEdits)
      .set({ status: 'pending', submittedAt: new Date('2025-08-01T00:00:00.000Z') })
      .where(eq(pendingEdits.id, editId));
    await db
      .update(agentVerifications)
      .set({ verdict: 'approve', updatedAt: new Date('2025-08-02T00:00:00.000Z') })
      .where(eq(agentVerifications.id, verdict.verificationId));

    // Revised again — a new version nobody has judged. A mirror dispatched
    // earlier and not awaited can arrive right here.
    await db
      .update(pendingEdits)
      .set({
        submittedAt: new Date('2025-09-01T00:00:00.000Z'),
        factStatement: 'Halveringstiden er 40 timer.',
      })
      .where(eq(pendingEdits.id, editId));

    const outcome = await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: verdict.verificationId,
      actorRef: `user:${verdict.agentUserId}`,
      verdict: 'approve',
    });
    expect(outcome).toMatchObject({ mirrored: false, skipped: 'unbindable_history' });

    // Nothing is attached to the version nobody reviewed.
    const link = await findByLegacy(db, 'pending_edit', editId);
    const current = await latestVersion(db, link!.genericId);
    const bound = await db
      .select({ id: kgAssessments.id })
      .from(kgAssessments)
      .where(
        and(
          eq(kgAssessments.subjectType, 'proposal_version'),
          eq(kgAssessments.subjectId, current!.id),
        ),
      );
    expect(bound).toEqual([]);
  });

  it('records a real publication event when the seam fires after the import', async () => {
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    const published = await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: `user:${authorId}`,
    });
    expect(published.mirrored).toBe(true);
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });
});

describe('authorship, capture time, and the source row', () => {
  it('records a human submitter as human, not as an agent', async () => {
    // Every `pending_edits` row has a `submitted_by`, so deriving `agent` from
    // the reference being present labels a person's proposal as an agent's,
    // which misstates the pool arithmetic and the decision record's account of
    // who wrote it.
    const moderator = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'moderator',
    });
    const humanEdit = await seedEdit({
      status: 'pending',
      statement: 'H',
      submittedBy: moderator,
    });
    const agentEdit = await seedEdit({ status: 'pending', statement: 'A' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const human = await proposalKinds(humanEdit);
    expect(human).toEqual({ authorKind: 'human', actorKind: 'human' });
    const agent = await proposalKinds(agentEdit);
    expect(agent).toEqual({ authorKind: 'agent', actorKind: 'agent' });
  });

  it('treats a revoked agent as human', async () => {
    // The exemption belongs to an *active* agent, which is the test the legacy
    // gate applies before it will auto-apply anything.
    await db.update(agents).set({ status: 'revoked' }).where(eq(agents.userId, authorId));
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    expect(await proposalKinds(editId)).toEqual({
      authorKind: 'human',
      actorKind: 'human',
    });
  });

  it('treats a demoted agent as human, even while its status is active', async () => {
    // The kill switch does not touch `agents.status`: it demotes the backing
    // user below contributor, which is the second gate `resolveActiveAgent`,
    // `isActiveAgentUser` and `countActiveVerifierAgents` all apply. A
    // status-only predicate answers `agent` for an agent legacy has already
    // stopped, and the imported proposal then loses the `humanApproval()`
    // requirement that legacy still enforces on it.
    await db
      .update(users)
      .set({ role: 'authenticated' })
      .where(eq(users.id, authorId));
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    expect(await proposalKinds(editId)).toEqual({
      authorKind: 'human',
      actorKind: 'human',
    });

    // And the live mirror, which writes the rows an eventual `generic_read`
    // serves, has to agree — the two paths share one predicate precisely so
    // this cannot drift.
    const mirrored = await seedEdit({ status: 'pending', statement: 'D' });
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: mirrored,
      legacyPendingEditId: mirrored,
    });
    expect(await proposalKinds(mirrored)).toEqual({
      authorKind: 'human',
      actorKind: 'human',
    });
  });

  it('the live mirror resolves authorship the same way', async () => {
    const moderator = await seedUser(db, {
      email: 'person2@example.com',
      username: 'person2',
      role: 'moderator',
    });
    const editId = await seedEdit({ status: 'pending', submittedBy: moderator });
    await enableShadow();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    expect(await proposalKinds(editId)).toEqual({
      authorKind: 'human',
      actorKind: 'human',
    });
  });

  it('never claims to have observed a closure before it happened', async () => {
    // A batch that stamped one capture time before scanning would record
    // `closureObservedAt` earlier than the moderation it is describing, in the
    // one record whose purpose is to say honestly when the importer looked.
    const reviewedAt = new Date(Date.now() + 60_000);
    const editId = await seedEdit({ status: 'approved', reviewedAt });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    const proposal = await proposalFor(editId);
    const version = await latestVersion(db, proposal!.id);
    const record = await historicalImportForVersion(db, version!.id);
    expect(record!.sourceClosedAt).toBe(reviewedAt.toISOString());
    // Stamped when the row was read, so it is a real observation time rather
    // than a batch-wide constant that may predate the row's own outcome.
    expect(new Date(record!.capturedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(record!.sourceCreatedAt).getTime(),
    );
  });

  it('takes a row lock on the source table while it captures and writes', async () => {
    // The advisory lock is cooperative and the legacy PATCH does not take it —
    // it issues a plain UPDATE. Without a row lock a reviewer can decide an
    // edit between the importer's read and its commit, and the import then
    // records a `pending` proposal for a row that is already approved.
    //
    // What PGlite can prove is that the lock is *taken*: `SELECT … FOR UPDATE`
    // holds a RowShareLock on `pending_edits` for the life of the transaction,
    // and nothing else in this path would. That it actually *excludes* a
    // concurrent legacy write needs two connections, so it lives in the
    // real-Postgres suite.
    const editId = await seedEdit({ status: 'pending' });
    await enableShadow();

    await runInPoolTransaction(async () => {
      const outcome = await importHistoricalProposal({
        legacyType: 'pending_edit',
        legacyId: editId,
      });
      expect(outcome.result).toBe('imported');
      const locks = await getDb().execute<{ mode: string }>(sql`
        SELECT mode FROM pg_locks
        WHERE relation = 'pending_edits'::regclass AND granted
      `);
      expect(locks.rows.map((r) => r.mode)).toContain('RowShareLock');
    });

    expect((await proposalFor(editId))!.state).toBe('pending');
  });

  it('holds the verdict row while the live mirror copies it', async () => {
    // The same exposure as the importer's, one layer up. `mirrorAssessment`
    // reads the verdict off the row rather than trusting the caller — but a
    // plain read can capture an approval that a second `recordVerification`
    // upsert replaces before the assessment is written, and the identity lock
    // does not reach that table.
    const editId = await seedEdit({ status: 'pending' });
    const verdict = await seedVerdict({ editId, slug: 'verifier-live-lock' });
    await enableShadow();

    await runInPoolTransaction(async () => {
      const outcome = await mirrorAssessment({
        targetType: 'pending_edit',
        targetId: editId,
        legacyVerificationId: verdict.verificationId,
        actorRef: `user:${verdict.agentUserId}`,
        verdict: 'approve',
      });
      expect(outcome.error).toBeUndefined();
      const held = async (table: string): Promise<string[]> => {
        const locks = await getDb().execute<{ mode: string }>(sql`
          SELECT mode FROM pg_locks
          WHERE relation = ${sql.raw(`'${table}'::regclass`)} AND granted
        `);
        return locks.rows.map((r) => r.mode);
      };
      expect(await held('agent_verifications')).toContain('RowShareLock');
      // Never the agents row: the upsert locks that one first, so taking it
      // here would invert the order and deadlock instead of queueing.
      expect(await held('agents')).not.toContain('RowShareLock');
    });
  });

  it('holds the verdict rows it is importing, and not the agents rows', async () => {
    // The source-row lock does not reach `agent_verifications`:
    // `recordVerification` upserts on `(agent_id, target_type, target_id)`
    // without consulting the edit row, so an agent recasting an approval into a
    // dispute is not excluded by the lock that keeps a moderator out. The
    // import would then write an approval legacy no longer holds — and nothing
    // would report it, because the row is linked and reconciliation's
    // `missing_assessment` check asks only whether a link exists.
    //
    // Both halves are asserted. `agent_verifications` must be held, and
    // `agents` must NOT be: `recordVerification` takes `FOR UPDATE` on the
    // agents row inside its upsert, so locking the joined agents rows here
    // would invert the two paths' lock order and turn a queue into a deadlock.
    const editId = await seedEdit({ status: 'pending' });
    await seedVerdict({ editId, slug: 'verifier-locked' });
    await enableShadow();

    await runInPoolTransaction(async () => {
      const outcome = await importHistoricalProposal({
        legacyType: 'pending_edit',
        legacyId: editId,
      });
      expect(outcome.result).toBe('imported');
      const held = async (table: string): Promise<string[]> => {
        const locks = await getDb().execute<{ mode: string }>(sql`
          SELECT mode FROM pg_locks
          WHERE relation = ${sql.raw(`'${table}'::regclass`)} AND granted
        `);
        return locks.rows.map((r) => r.mode);
      };
      expect(await held('agent_verifications')).toContain('RowShareLock');
      expect(await held('agents')).not.toContain('RowShareLock');
    });
  });
});

describe('an imported open row that moves afterwards', () => {
  it('follows the source when a returned edit is revised and resubmitted', async () => {
    // Appending a version left the proposal state alone. That was invisible
    // while every proposal was created `pending` — the projection was already
    // where a resubmission would put it — and stopped being invisible as soon
    // as a proposal could start life `returned`. The result is a
    // `state_mismatch` the repair tool explicitly cannot fix, standing between
    // the migration and its exit gate.
    const editId = await seedEdit({ status: 'returned' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });
    expect((await proposalFor(editId))!.state).toBe('returned');

    // Revised and resubmitted, as the legacy route does it.
    await db
      .update(pendingEdits)
      .set({ status: 'pending', factStatement: 'Halveringstiden er 40 timer.' })
      .where(eq(pendingEdits.id, editId));
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });

    expect((await proposalFor(editId))!.state).toBe('pending');
    expect((await proposalFor(editId))!.closedAt).toBeNull();
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('does not reopen a closed row when its payload is re-mirrored', async () => {
    // The other half: a decided row is owned by whoever decided it, and a
    // re-mirror of its payload must not put it back under review.
    const editId = await seedEdit({ status: 'approved' });
    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    await db
      .update(pendingEdits)
      .set({ factStatement: 'Halveringstiden er 50 timer.' })
      .where(eq(pendingEdits.id, editId));
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });

    const proposal = await proposalFor(editId);
    expect(proposal!.state).toBe('applied');
    expect(proposal!.closedAt).not.toBeNull();
  });
});

describe('binding a verdict on a target with no legacy lifecycle', () => {
  it('re-binds a recast verdict that a target-level snapshot had claimed', async () => {
    // The binding guard asked `readLegacySnapshot`, which reads `pending_edits`
    // and returns null for every other adapter — `paper_review`,
    // `wiki_revision`, `drug_parameter_revision`, `drug_discussion`. So for
    // those types the answer was "unbindable" unconditionally and permanently:
    // a verdict `snapshotLegacyVerifications` had linked target-level could
    // never be re-bound after a recast, while reconciliation went on accepting
    // the link. The generic side stayed on the historical judgment with nothing
    // reporting it — the silence the rule exists to prevent, reached by having
    // no rule to apply rather than by applying a lax one.
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/kinetix-test' })
      .returning({ id: citations.id });
    const [review] = await db
      .insert(paperReviews)
      .values({
        citationId: citation!.id,
        reviewMarkdown: 'Solid methods.',
        readInFull: true,
        createdBy: authorId,
      })
      .returning({ id: paperReviews.id });

    await setMigrationMode({
      targetType: 'paper_review',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();

    const verifierId = await seedUser(db, {
      email: 'paper-verifier@example.com',
      username: 'paper-verifier',
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId: verifierId,
        name: 'paper-verifier',
        slug: 'paper-verifier',
        status: 'active',
        modelTier: 'mid',
      })
      .returning({ id: agents.id });
    const [verification] = await db
      .insert(agentVerifications)
      .values({
        agentId: agent!.id,
        targetType: 'paper_review',
        targetId: review!.id,
        verdict: 'approve',
        verifierTier: 'mid',
      })
      .returning({ id: agentVerifications.id });

    // Linked target-level, exactly as the backfill leaves it.
    await snapshotLegacyVerifications(db, {
      type: 'paper_review',
      id: String(review!.id),
    });

    // The agent changes its mind, and the mirror runs for the recast.
    await db
      .update(agentVerifications)
      .set({ verdict: 'dispute', updatedAt: new Date(Date.now() + 1000) })
      .where(eq(agentVerifications.id, verification!.id));
    const mirrored = await mirrorAssessment({
      targetType: 'paper_review',
      targetId: review!.id,
      legacyVerificationId: verification!.id,
      actorRef: `user:${verifierId}`,
      verdict: 'dispute',
    });

    expect(mirrored.skipped).toBeUndefined();
    expect(mirrored.mirrored).toBe(true);
    const rows = await db
      .select({ subjectType: kgAssessments.subjectType, verdict: kgAssessments.verdict })
      .from(kgAssessments)
      .where(eq(kgAssessments.actorRef, `user:${verifierId}`));
    // The target-level history survives; the correction is bound to the version.
    expect(rows.filter((r) => r.subjectType === 'target')).toHaveLength(1);
    const bound = rows.filter((r) => r.subjectType === 'proposal_version');
    expect(bound).toHaveLength(1);
    expect(bound[0]!.verdict).toBe('dispute');
  });
});

describe('withdrawal is not rejection', () => {
  it('imports a submitter self-cancellation as withdrawn', async () => {
    // `isOwnCancel` in api/pending-edits.ts stores a withdrawal as
    // `status: 'rejected'` with `reviewed_by` set to the canceller, who is the
    // submitter. Importing on status alone gives every withdrawn proposal a
    // rejection it never received — in an immutable record.
    const withdrawn = await seedEdit({ status: 'rejected', statement: 'W' });
    await db
      .update(pendingEdits)
      .set({ reviewedBy: authorId, reviewedAt: new Date() })
      .where(eq(pendingEdits.id, withdrawn));

    const moderator = await seedUser(db, {
      email: 'mod@example.com',
      username: 'mod',
      role: 'moderator',
    });
    const refused = await seedEdit({ status: 'rejected', statement: 'R' });
    await db
      .update(pendingEdits)
      .set({ reviewedBy: moderator, reviewedAt: new Date() })
      .where(eq(pendingEdits.id, refused));

    await enableShadow();
    await importHistoricalSnapshots({ db, dryRun: false });

    expect((await proposalFor(withdrawn))!.state).toBe('withdrawn');
    expect((await proposalFor(refused))!.state).toBe('rejected');
    // Both are terminal, so both leave the open-proposals index.
    expect((await proposalFor(withdrawn))!.closedAt).not.toBeNull();

    // And the scanner applies the same rule, so neither reads as a mismatch.
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });
});

describe('the pieces on their own', () => {
  it('reads a legacy lifecycle only for target types it has a rule for', async () => {
    const editId = await seedEdit({ status: 'approved' });
    const snapshot = await readLegacySnapshot(db, 'pending_edit', editId);
    expect(snapshot).toMatchObject({ sourceState: 'approved', genericState: 'applied', closed: true });
    expect(await readLegacySnapshot(db, 'wiki_revision', editId)).toBeNull();
    expect(await readLegacySnapshot(db, 'pending_edit', 999999)).toBeNull();
  });

  it('refuses to call a binding established for a closed source', () => {
    const closed = {
      legacyType: 'pending_edit',
      legacyId: 1,
      sourceState: 'approved',
      genericState: 'applied' as const,
      closed: true,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      closedAt: null,
      editType: 'wiki_fact',
    };
    expect(versionBinding(closed, new Date('2025-02-01T00:00:00.000Z'))).toBe(
      'source_closed_after_review',
    );
    expect(
      versionBinding({ ...closed, sourceState: 'pending', genericState: 'pending', closed: false }, new Date('2025-02-01T00:00:00.000Z')),
    ).toBe('established');
  });
});

describe('the verdicts a plan is allowed to describe', () => {
  // `lockLegacyVerdicts` takes `FOR UPDATE` on the verdicts of one row, and
  // `FOR UPDATE` holds rows, not the predicate. A verdict that commits after
  // that lock is therefore visible to the planning read under READ COMMITTED,
  // while the write side — which filters against the captured ids — will not
  // import it. The frozen set is passed into planning so the two agree.
  //
  // The window itself is inside the import's own transaction and has no yield
  // point, so it cannot be opened from a test; what is asserted here is the
  // contract that closes it, exercised directly on `planOne`.
  it('does not plan a verdict outside the set the caller froze', async () => {
    const editId = await seedEdit({ status: 'pending' });
    const held = await seedVerdict({ editId, slug: 'verifier-held' });
    const phantom = await seedVerdict({ editId, slug: 'verifier-phantom' });
    await enableShadow();

    const plan = await planOne(db, {
      legacyType: 'pending_edit',
      legacyId: editId,
      verdictIds: [held.verificationId],
    });

    expect(plan.kind).toBe('import');
    // Both are there; only one is work this run will do.
    expect(plan.assessments.total).toBe(2);
    expect(plan.assessments.versionBound).toBe(1);
    expect(plan.assessments.unbound).toBe(0);
    // And the one it will not do is predicted as the divergence it leaves,
    // rather than dropped — a plan that merely stops claiming the assessment
    // would still read clean over a `missing_assessment`.
    expect(plan.assessments.unresolved).toBe(1);
    expect(plan.predictedFindings).toContain('missing_assessment');
    void phantom;
  });

  it('plans every verdict when no set is frozen', async () => {
    // The preview holds nothing and passes nothing: it describes what is there
    // now. Without this the filter would have to be the default, and every
    // preview would report zero assessment work.
    const editId = await seedEdit({ status: 'pending' });
    await seedVerdict({ editId, slug: 'verifier-a' });
    await seedVerdict({ editId, slug: 'verifier-b' });
    await enableShadow();

    const plan = await planOne(db, { legacyType: 'pending_edit', legacyId: editId });

    expect(plan.assessments.total).toBe(2);
    expect(plan.assessments.versionBound).toBe(2);
    expect(plan.assessments.unresolved).toBe(0);
    expect(plan.predictedFindings).toEqual([]);
  });
});
