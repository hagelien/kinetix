/**
 * The half of the historical importer's concurrency story PGlite cannot prove.
 *
 * `importer.test.ts` asserts what the everyday harness can: the import is one
 * unit of work, it joins an ambient transaction rather than committing
 * independently of its caller, a stale capture is abandoned, and two sequential
 * attempts produce one proposal. What it cannot assert is that the advisory
 * lock *serializes* anything — PGlite is a single connection, so the lock is
 * re-entrant and two "concurrent" imports are two turns on the same backend.
 * A green run there is silent about the property the plan actually asks for.
 *
 * So the real contention lives here, gated the same way `real-postgres-
 * deadlock.test.ts` gates its own: `KINETIX_TEST_PG_URL` selects a real server
 * and the suite skips without it, never falling back to PGlite.
 *
 * A gate like that has its own failure mode, and this suite shipped with it:
 * the workflow set the variable in a step that named one *other* test file, so
 * these cases skipped inside a green `migrations` job, and the job then read as
 * evidence for contention it had never run. The block at the bottom therefore
 * asserts the association — this file named in the same step as the variable —
 * rather than the variable's mere presence. Losing the coverage is a red build,
 * not a quieter green one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { eq, sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  citations,
  kgAssessments,
  kgProposalVersions,
  kgProposals,
  paperReviews,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { importHistoricalProposal } from '../../../api/_lib/knowledge-governance/historical-import.js';
import { runInPoolTransaction } from '../../../api/_lib/db.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import { reconcile } from '../../../api/_lib/knowledge-governance/reconciliation.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import {
  REAL_PG_URL_ENV,
  realPostgresUrl,
  resetRealPostgresDb,
  setupRealPostgresDb,
  teardownRealPostgresDb,
  type RealPostgresDb,
} from '../../integration/setup/real-postgres.js';
import { snapshotLegacyVerifications } from '../../../api/_lib/knowledge-governance/backfill.js';
import {
  StaleVerificationTargetError,
  recordVerification,
  verificationTargetVersion,
} from '../../../api/_lib/agent-verifications.js';
import { seedUser } from '../../integration/setup/seed.js';

const hasRealPostgres = realPostgresUrl() !== null;

/**
 * The import provenance of a stored assessment.
 *
 * Host-owned bookkeeping, so the canonical snapshot keeps it under `host`: the
 * generic store carries it and never reads it.
 */
function hostProvenance(snapshot: unknown): { capturedAt: string; sourceJudgedAt: string } {
  return (
    snapshot as { host: { provenance: { capturedAt: string; sourceJudgedAt: string } } }
  ).host.provenance;
}

describe.skipIf(!hasRealPostgres)('competing imports on a real server', () => {
  let db: RealPostgresDb;
  let authorId: number;
  let editId: number;

  beforeAll(async () => {
    db = await setupRealPostgresDb();
  }, 120_000);
  afterAll(async () => {
    await teardownRealPostgresDb();
  });
  beforeEach(async () => {
    await resetRealPostgresDb(db);
    invalidateMigrationStateCache();
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
        status: 'approved',
      })
      .returning({ id: pendingEdits.id });
    editId = edit!.id;

    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
  });

  it('hands out separate backends, so the contention below is real', async () => {
    // Non-vacuity, in the shape `real-postgres-deadlock.test.ts` establishes it:
    // if two concurrent transactions share a backend, this target has collapsed
    // to PGlite's behaviour and nothing after this test proves anything.
    const pids = await Promise.all([
      db.transaction(async (tx) => {
        const r = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        return Number(r.rows[0]!.pid);
      }),
      db.transaction(async (tx) => {
        const r = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        return Number(r.rows[0]!.pid);
      }),
    ]);
    expect(pids[0]).not.toBe(pids[1]);
  });

  it('imports a row exactly once when two imports race it', async () => {
    const results = await Promise.all([
      importHistoricalProposal({ legacyType: 'pending_edit', legacyId: editId }),
      importHistoricalProposal({ legacyType: 'pending_edit', legacyId: editId }),
      importHistoricalProposal({ legacyType: 'pending_edit', legacyId: editId }),
    ]);
    expect(results.filter((r) => r.result === 'imported')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'failed')).toHaveLength(0);

    const proposals = await db.select({ id: kgProposals.id }).from(kgProposals);
    expect(proposals).toHaveLength(1);
    const versions = await db.select({ id: kgProposalVersions.id }).from(kgProposalVersions);
    expect(versions).toHaveLength(1);
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('does not duplicate history when an import races the live mirror', async () => {
    // The two writers the plan names. They meet on the same identity, one
    // through the operator CLI and one through the request path, and the
    // outcome must be one proposal in the right state either way.
    const [imported, mirrored] = await Promise.all([
      importHistoricalProposal({ legacyType: 'pending_edit', legacyId: editId }),
      mirrorProposalVersion({
        targetType: 'pending_edit',
        targetId: editId,
        legacyPendingEditId: editId,
      }),
    ]);
    expect(imported.result === 'imported' || mirrored.mirrored).toBe(true);

    const proposals = await db
      .select({ id: kgProposals.id, state: kgProposals.state })
      .from(kgProposals);
    expect(proposals).toHaveLength(1);
    // Whichever writer won, the decided row is not reopened.
    expect(proposals[0]!.state).toBe('applied');
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('blocks a legacy transition while an import holds the source row', async () => {
    // The exclusion PGlite cannot show. The advisory lock is cooperative and
    // `PATCH /api/pending-edits` does not take it — it issues a plain UPDATE —
    // so only a row lock on `pending_edits` keeps a reviewer from deciding an
    // edit between the importer's read and its commit. With two real backends,
    // that UPDATE must wait rather than racing ahead.
    await db
      .update(pendingEdits)
      .set({ status: 'pending' })
      .where(eq(pendingEdits.id, editId));

    let updateResolvedAt = 0;
    let importCommittedAt = 0;

    const contender = (async () => {
      // Runs on its own backend, as the request path does.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await db
        .update(pendingEdits)
        .set({ status: 'approved' })
        .where(eq(pendingEdits.id, editId));
      updateResolvedAt = Date.now();
    })();

    await runInPoolTransaction(async () => {
      const outcome = await importHistoricalProposal({
        legacyType: 'pending_edit',
        legacyId: editId,
      });
      expect(outcome.result).toBe('imported');
      // Hold the row lock past the moment the contender tries to write.
      await new Promise((resolve) => setTimeout(resolve, 600));
      importCommittedAt = Date.now();
    });
    await contender;

    // The legacy write landed only after the import committed, so the imported
    // state describes a row nobody moved underneath it.
    expect(updateResolvedAt).toBeGreaterThanOrEqual(importCommittedAt);
    const proposals = await db
      .select({ state: kgProposals.state })
      .from(kgProposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.state).toBe('pending');
  });

  it('classifies first contact under the lock, not before it', async () => {
    // The live mirror's first-contact branch reads the legacy row, decides
    // whether it is an open proposal or finished history, and writes that
    // conclusion. Reading before taking the lock makes the decision about a row
    // that may already have moved: a plain SELECT sees the last committed
    // value, so a reviewer's in-flight approval is invisible, and the mirror
    // then waits for the lock and creates a `pending` proposal for a row that
    // is `approved` by the time it writes. That is the `state_mismatch` plus
    // `missing_publication` this whole module exists to stop producing,
    // recreated by the request path — and it does not heal, because the
    // approval's own publication mirror ran while no link existed and skipped.
    //
    // Deterministic here, and only here: the contender holds the row across the
    // window, so with the read outside the lock the mirror is *guaranteed* to
    // see the stale state, and with the read inside it the mirror cannot begin
    // until the approval has committed. On one backend there is no window to
    // hold.
    await db
      .update(pendingEdits)
      .set({ status: 'pending', reviewedAt: null })
      .where(eq(pendingEdits.id, editId));

    const contender = new Client({ connectionString: realPostgresUrl()! });
    await contender.connect();
    try {
      await contender.query('BEGIN');
      await contender.query('SELECT id FROM pending_edits WHERE id = $1 FOR UPDATE', [
        editId,
      ]);
      await contender.query(
        "UPDATE pending_edits SET status = 'approved', reviewed_at = now() WHERE id = $1",
        [editId],
      );

      const mirrored = mirrorProposalVersion({
        targetType: 'pending_edit',
        targetId: editId,
        legacyPendingEditId: editId,
      });
      // Long enough that the mirror has reached the row lock and is waiting on
      // it; short enough to stay well inside the harness's `lock_timeout`.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await contender.query('COMMIT');
      const outcome = await mirrored;
      expect(outcome.error).toBeUndefined();
    } finally {
      await contender.end();
    }

    // The decision describes the row as it stood when the lock was held, so the
    // approved edit is imported as history rather than reopened for review.
    const proposals = await db
      .select({ state: kgProposals.state })
      .from(kgProposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.state).toBe('applied');
    expect((await reconcile(db, { limit: 100 })).divergences).toEqual([]);
  });

  it('blocks a verdict recast while an import is reading the verdicts', async () => {
    // The source-row lock does not reach `agent_verifications`.
    // `recordVerification` upserts on `(agent_id, target_type, target_id)` and
    // never consults the edit row, so an agent changing its mind is not
    // excluded by the lock that keeps a moderator out. Under READ COMMITTED the
    // import reads the verdict committed before its SELECT and the recast can
    // commit after it — the import then writes an approval legacy no longer
    // holds.
    //
    // Nothing reports that afterwards, which is why it is worth a lock rather
    // than a retry: the row is linked, and reconciliation's
    // `missing_assessment` check asks only whether a link exists. The recast's
    // own mirror would normally repair it, but it is fire-and-forget.
    await db
      .update(pendingEdits)
      .set({ status: 'pending', reviewedAt: null })
      .where(eq(pendingEdits.id, editId));
    const verifierId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier',
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId: verifierId,
        name: 'verifier',
        slug: 'verifier',
        status: 'active',
        modelTier: 'mid',
      })
      .returning({ id: agents.id });
    await db.insert(agentVerifications).values({
      agentId: agent!.id,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'approve',
      verifierTier: 'mid',
    });

    let recastResolvedAt = 0;
    let importCommittedAt = 0;

    const contender = (async () => {
      // Its own backend, as the verdict route has.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await db
        .update(agentVerifications)
        .set({ verdict: 'dispute', updatedAt: new Date() })
        .where(eq(agentVerifications.targetId, editId));
      recastResolvedAt = Date.now();
    })();

    await runInPoolTransaction(async () => {
      const outcome = await importHistoricalProposal({
        legacyType: 'pending_edit',
        legacyId: editId,
      });
      expect(outcome.result).toBe('imported');
      // Hold the verdict rows past the moment the recast tries to write.
      await new Promise((resolve) => setTimeout(resolve, 600));
      importCommittedAt = Date.now();
    });
    await contender;

    // The recast landed only after the import committed, so what was imported
    // is what legacy held at the time — not a judgment already replaced.
    expect(recastResolvedAt).toBeGreaterThanOrEqual(importCommittedAt);
    const assessments = await db
      .select({ verdict: kgAssessments.verdict })
      .from(kgAssessments);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.verdict).toBe('approve');
  });

  it('blocks a verdict recast while the live mirror is copying it', async () => {
    // The same exclusion as the import case above, on the path a request
    // actually takes. `mirrorAssessment` reads the verdict off the row so the
    // mirror copies what legacy holds rather than what the caller passed —
    // which is only true if the row cannot move between the read and the write.
    //
    // Deterministic here: the contender holds the verdict row across the
    // window, so without the lock the mirror is guaranteed to read the stale
    // approval, and with it the mirror cannot proceed until the dispute has
    // committed.
    await db
      .update(pendingEdits)
      .set({ status: 'pending', reviewedAt: null })
      .where(eq(pendingEdits.id, editId));
    const verifierId = await seedUser(db, {
      email: 'live-verifier@example.com',
      username: 'live-verifier',
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId: verifierId,
        name: 'live-verifier',
        slug: 'live-verifier',
        status: 'active',
        modelTier: 'mid',
      })
      .returning({ id: agents.id });
    const [verification] = await db
      .insert(agentVerifications)
      .values({
        agentId: agent!.id,
        targetType: 'pending_edit',
        targetId: editId,
        verdict: 'approve',
        verifierTier: 'mid',
      })
      .returning({ id: agentVerifications.id });

    const contender = new Client({ connectionString: realPostgresUrl()! });
    await contender.connect();
    try {
      await contender.query('BEGIN');
      await contender.query('SELECT id FROM agent_verifications WHERE id = $1 FOR UPDATE', [
        verification!.id,
      ]);
      await contender.query(
        "UPDATE agent_verifications SET verdict = 'dispute', updated_at = now() WHERE id = $1",
        [verification!.id],
      );

      const mirrored = mirrorAssessment({
        targetType: 'pending_edit',
        targetId: editId,
        legacyVerificationId: verification!.id,
        actorRef: `user:${verifierId}`,
        verdict: 'approve',
      });
      // Long enough that the mirror has reached the row lock and is waiting on
      // it; short enough to stay inside the harness's `lock_timeout`.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await contender.query('COMMIT');
      const outcome = await mirrored;
      expect(outcome.error).toBeUndefined();
    } finally {
      await contender.end();
    }

    // What legacy holds is what was mirrored — not the judgment it replaced.
    const assessments = await db
      .select({ verdict: kgAssessments.verdict })
      .from(kgAssessments);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.verdict).toBe('dispute');
  });

  it('never claims to have captured a verdict before it was cast', async () => {
    // The capture clock has to be read after everything it describes is held.
    // Stamping it under the identity lock alone left the verdicts unheld for
    // the rest of the transaction: a recast between the stamp and the verdict
    // lock makes the import wait, then record that judgment with a
    // `sourceJudgedAt` *later* than the `capturedAt` beside it — an immutable
    // record claiming to have observed a verdict before it existed.
    await db
      .update(pendingEdits)
      .set({ status: 'pending', reviewedAt: null })
      .where(eq(pendingEdits.id, editId));
    const verifierId = await seedUser(db, {
      email: 'clock-verifier@example.com',
      username: 'clock-verifier',
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId: verifierId,
        name: 'clock-verifier',
        slug: 'clock-verifier',
        status: 'active',
        modelTier: 'mid',
      })
      .returning({ id: agents.id });
    const [verification] = await db
      .insert(agentVerifications)
      .values({
        agentId: agent!.id,
        targetType: 'pending_edit',
        targetId: editId,
        verdict: 'approve',
        verifierTier: 'mid',
      })
      .returning({ id: agentVerifications.id });

    const contender = new Client({ connectionString: realPostgresUrl()! });
    await contender.connect();
    try {
      // Hold the row first and write to it *later*, so the recast lands after
      // any capture time an unfixed import would already have stamped. The
      // order is what this test is about: taking the row up front and only then
      // starting the import means an import that stamps before locking the
      // verdicts has, by construction, stamped too early.
      await contender.query('BEGIN');
      await contender.query('SELECT id FROM agent_verifications WHERE id = $1 FOR UPDATE', [
        verification!.id,
      ]);

      const importing = importHistoricalProposal({
        legacyType: 'pending_edit',
        legacyId: editId,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // `clock_timestamp()`, not `now()`: `now()` is the *transaction start*
      // time, which precedes this BEGIN and would therefore precede any capture
      // time whatever the code does — the assertion would hold vacuously.
      await contender.query(
        "UPDATE agent_verifications SET verdict = 'dispute', updated_at = clock_timestamp() WHERE id = $1",
        [verification!.id],
      );
      await contender.query('COMMIT');
      expect((await importing).result).toBe('imported');
    } finally {
      await contender.end();
    }

    const [assessment] = await db
      .select({ capabilitySnapshot: kgAssessments.capabilitySnapshot })
      .from(kgAssessments);
    const provenance = hostProvenance(assessment!.capabilitySnapshot);
    // The record it wrote describes a judgment that already existed when it
    // looked, which is the only honest thing a capture time can say.
    expect(new Date(provenance.sourceJudgedAt).getTime()).toBeLessThanOrEqual(
      new Date(provenance.capturedAt).getTime(),
    );
  });

  it('never claims the target snapshot captured a verdict before it was cast', async () => {
    // `snapshotLegacyVerifications` is the importer's sibling: same clock, same
    // provenance fields, same multi-statement capture. It read `capturedAt`
    // before the verdicts and held nothing across them, so the same recast that
    // the importer now excludes produced the same impossible record here.
    const verifierId = await seedUser(db, {
      email: 'snapshot-verifier@example.com',
      username: 'snapshot-verifier',
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId: verifierId,
        name: 'snapshot-verifier',
        slug: 'snapshot-verifier',
        status: 'active',
        modelTier: 'mid',
      })
      .returning({ id: agents.id });
    const [verification] = await db
      .insert(agentVerifications)
      .values({
        agentId: agent!.id,
        targetType: 'pending_edit',
        targetId: editId,
        verdict: 'approve',
        verifierTier: 'mid',
      })
      .returning({ id: agentVerifications.id });

    const contender = new Client({ connectionString: realPostgresUrl()! });
    await contender.connect();
    try {
      await contender.query('BEGIN');
      await contender.query('SELECT id FROM agent_verifications WHERE id = $1 FOR UPDATE', [
        verification!.id,
      ]);

      const snapshotting = snapshotLegacyVerifications(db, {
        type: 'pending_edit',
        id: String(editId),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await contender.query(
        "UPDATE agent_verifications SET verdict = 'dispute', updated_at = clock_timestamp() WHERE id = $1",
        [verification!.id],
      );
      await contender.query('COMMIT');
      expect((await snapshotting).imported).toBe(1);
    } finally {
      await contender.end();
    }

    const [assessment] = await db
      .select({
        verdict: kgAssessments.verdict,
        capabilitySnapshot: kgAssessments.capabilitySnapshot,
      })
      .from(kgAssessments);
    // The judgment it linked is the one legacy holds, and it does not claim to
    // have seen it before it was written.
    expect(assessment!.verdict).toBe('dispute');
    const provenance = hostProvenance(assessment!.capabilitySnapshot);
    expect(new Date(provenance.sourceJudgedAt).getTime()).toBeLessThanOrEqual(
      new Date(provenance.capturedAt).getTime(),
    );
  });

  it('blocks a revision of a non-pending-edit source while a mirror holds it', async () => {
    // The source-row lock used to cover `pending_edit` alone. Everything else
    // got the advisory lock only, which is cooperative and which no legacy
    // writer takes — so for those types the mirror's two reads sat at two
    // different points in legacy time.
    //
    // `paper_review` is where that bites: the row is revised in place (its
    // `targetVersion` is `updated_at`, and a re-review moves it), so a mirror
    // could select the pre-revision version, then read the verdict the agent
    // recast against the revision, and bind the new judgment to the old
    // payload. The legacy link then exists, so reconciliation reports the row
    // clean, and the recast's own mirror is fire-and-forget — lose that
    // dispatch and the current version keeps an assessment nobody made for it.
    //
    // Two backends are what makes this provable: the re-review's UPDATE must
    // wait for the mirror's transaction rather than landing inside it.
    const [citation] = await db
      .insert(citations)
      .values({
        type: 'pmid',
        identifier: '12345678',
        metadata: { title: 'A paper' },
        createdBy: authorId,
      })
      .returning({ id: citations.id });
    const [review] = await db
      .insert(paperReviews)
      .values({
        citationId: citation!.id,
        reviewMarkdown: 'Første gjennomgang.',
        overallScore: 60,
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

    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, 'author-agent'))
      .limit(1);
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

    let updateResolvedAt = 0;
    let mirrorCommittedAt = 0;

    const reReview = (async () => {
      // The re-review path, on its own backend: a plain UPDATE that takes no
      // advisory lock, exactly as the request path issues it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await db
        .update(paperReviews)
        .set({ reviewMarkdown: 'Ny gjennomgang.', updatedAt: new Date() })
        .where(eq(paperReviews.id, review!.id));
      updateResolvedAt = Date.now();
    })();

    await runInPoolTransaction(async () => {
      const outcome = await mirrorAssessment({
        targetType: 'paper_review',
        targetId: review!.id,
        legacyVerificationId: verification!.id,
        actorRef: `user:${authorId}`,
        verdict: 'approve',
      });
      expect(outcome.mirrored).toBe(true);
      // Hold past the moment the re-review tries to write.
      await new Promise((resolve) => setTimeout(resolve, 600));
      mirrorCommittedAt = Date.now();
    });
    await reReview;

    expect(updateResolvedAt).toBeGreaterThanOrEqual(mirrorCommittedAt);

    // And what the mirror wrote describes the payload it actually read: one
    // version, carrying the pre-revision token, with the assessment on it.
    const versions = await db
      .select({ id: kgProposalVersions.id, token: kgProposalVersions.legacyReviewToken })
      .from(kgProposalVersions);
    expect(versions).toHaveLength(1);
    const assessments = await db
      .select({ subjectId: kgAssessments.subjectId })
      .from(kgAssessments);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.subjectId).toBe(versions[0]!.id);
  });

  it('refuses a verdict whose target moves while the write waits for the row', async () => {
    // The route validates `verificationTargetVersion` and then writes, with the
    // author lookup, the self-review rules and the citation resolution in
    // between. `agent_verifications` has no version column, so a revision
    // landing in that window leaves a verdict that reads as a judgment of a
    // payload its author never saw.
    //
    // The re-check inside the write closes it, and only because it holds the
    // source row: without the lock the re-read sees the contender's
    // last-committed value — still the queued one — and admits the verdict that
    // the very next commit invalidates. Two backends are what make that
    // visible, which is why this case lives here rather than beside the
    // contract test.
    await db
      .update(pendingEdits)
      .set({ status: 'pending' })
      .where(eq(pendingEdits.id, editId));
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, 'author-agent'))
      .limit(1);
    const queued = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    });
    expect(queued).toContain('|pending');

    // Holds the row, then moves it — the reviewer whose PATCH is in flight
    // while the verdict is being written.
    const contender = db.transaction(async (tx) => {
      await tx
        .select({ id: pendingEdits.id })
        .from(pendingEdits)
        .where(eq(pendingEdits.id, editId))
        .limit(1)
        .for('update');
      await new Promise((resolve) => setTimeout(resolve, 400));
      await tx
        .update(pendingEdits)
        .set({ status: 'returned' })
        .where(eq(pendingEdits.id, editId));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await expect(
      recordVerification({
        agentId: agent!.id,
        targetType: 'pending_edit',
        targetId: editId,
        verdict: 'approve',
        rationaleMd: '',
        evidenceRefs: [],
        expectTargetVersion: queued!,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationTargetError);
    await contender;

    expect(
      await db.select({ id: agentVerifications.id }).from(agentVerifications),
    ).toEqual([]);
  });

  it('abandons an import whose source changed while it was being captured', async () => {
    // The capture the plan asks to be re-read under the concurrency guard. The
    // expectation names the state a preview saw; by the time the lock is held
    // legacy says something else, so the outcome about to be written as history
    // is not the outcome any more.
    await db
      .update(pendingEdits)
      .set({ status: 'rejected' })
      .where(eq(pendingEdits.id, editId));

    const outcome = await importHistoricalProposal({
      legacyType: 'pending_edit',
      legacyId: editId,
      expect: { sourceState: 'approved', sourceVersionToken: null },
    });
    expect(outcome.result).toBe('stale_capture');
    expect(await db.select({ id: kgProposals.id }).from(kgProposals)).toEqual([]);
  });
});

describe('the real-Postgres target stays wired up', () => {
  const WORKFLOW = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'migrations.yml',
  );

  /** The other suite that drops and replays this same database. */
  const DEADLOCK_SUITE = 'tests/governance/transaction/real-postgres-deadlock.test.ts';
  const THIS_SUITE =
    'tests/governance/historical-import/real-postgres-concurrency.test.ts';

  /**
   * The workflow steps that actually assign the connection string.
   *
   * The assignment, not the bare name: prose about the variable — including the
   * comments explaining these very requirements — mentions it too, and matching
   * that would point an assertion at the wrong step.
   */
  function databaseSteps(): string[] {
    const source = fs.readFileSync(WORKFLOW, 'utf8');
    const assignment = new RegExp(`^\\s*${REAL_PG_URL_ENV}:\\s*\\S`, 'm');
    return source.split(/^      - name: /m).filter((step) => assignment.test(step));
  }

  it('a database-enabled step actually runs THIS suite', () => {
    // Not "the workflow mentions the env var somewhere". It did, and this suite
    // still never ran against the service container: the step that sets
    // `KINETIX_TEST_PG_URL` named one test file explicitly, so these cases
    // skipped inside a green job and the job read as evidence for contention it
    // had not exercised.
    //
    // So the assertion is the association — the file must appear in a step that
    // supplies the variable — which is the thing that was actually missing.
    const steps = databaseSteps();
    expect(steps.length, `no workflow step sets ${REAL_PG_URL_ENV}`).toBeGreaterThan(0);
    expect(steps.some((step) => step.includes(THIS_SUITE))).toBe(true);
  });

  it('never shares one invocation with the other destructive suite', () => {
    // `setupRealPostgresDb()` drops the public schema and replays the whole
    // chain, and `beforeEach` truncates every table — against the one database
    // the service container provides. Vitest runs files in parallel by default,
    // so naming both suites in a single `vitest run` lets one worker reset the
    // database underneath the other. The failure that produces is a missing
    // relation or a vanished fixture, which reads as this suite's concurrency
    // property being false rather than as the scheduling accident it is.
    //
    // Asserting on the invocation rather than on a flag keeps the guarantee
    // legible: two processes cannot interleave their setups.
    for (const step of databaseSteps()) {
      const runsBoth = step.includes(THIS_SUITE) && step.includes(DEADLOCK_SUITE);
      expect(runsBoth, 'both destructive suites share one workflow step').toBe(false);
    }
  });

  it('reports whether this run exercised a real server', () => {
    // Not an assertion about the environment — a local run without Postgres is
    // legitimate. It puts the fact in the output so a green run is never read
    // as "concurrent import was checked" when it was skipped.
    if (!hasRealPostgres) {
      console.warn(
        `[historical-import] SKIPPED: ${REAL_PG_URL_ENV} not set, ` +
          'real import contention NOT exercised',
      );
    }
    expect(true).toBe(true);
  });
});
