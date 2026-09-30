/**
 * Phase 3 exit gate: the backfill is idempotent, honest about what it imported,
 * and invisible to Kinetix.
 *
 * §6 is the part worth guarding hardest. Kinetix cannot supply an append-only
 * history — `agent_verifications` upserts, so an agent that changed its verdict
 * overwrote the earlier one and it is gone. The migration must therefore import
 * a *snapshot* and say so on every row, rather than reconstructing a sequence
 * that no longer exists. A backfill that quietly looked like native history
 * would corrupt every later parity report, because nothing downstream could
 * tell reconstructed state from observed state.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import queueHandler from '../../../api/agent-verifications-queue.js';
import {
  ensureKinetixSpace,
  ensureKinetixTarget,
  kinetixTargetKey,
  snapshotLegacyVerifications,
  KINETIX_POLICY_VERSION,
} from '../../../api/_lib/knowledge-governance/backfill.js';
import {
  currentAssessments,
  findByLegacy,
  isLegacySnapshot,
  listAssessments,
  listAuditEventsByType,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
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
  getUserFromRequestMock.mockReset();
});

async function countRows(table: string): Promise<number> {
  const result = await db.execute(
    sql.raw(`select count(*)::int as n from ${table}`),
  );
  const rows = (result as unknown as { rows?: Array<{ n: number }> }).rows ?? [];
  return rows[0]?.n ?? 0;
}

async function seedAgent(userId: number, slug: string, modelTier: string | null) {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active', modelTier })
    .returning({ id: agents.id });
  return row!.id;
}

/** One pending edit with two agent verdicts against it, one of them implicit. */
async function seedVerifiedPendingEdit(): Promise<{
  editId: number;
  verifierUserId: number;
}> {
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
  const authorAgentId = await seedAgent(authorId, 'author-agent', 'mid');
  const verifierAgentId = await seedAgent(verifierId, 'verifier-agent', 'flagship');

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

  await db.insert(agentVerifications).values([
    {
      agentId: authorAgentId,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      isImplicit: true,
      verifierTier: 'mid',
    },
    {
      agentId: verifierAgentId,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      rationaleMd: 'Verdien stemmer med referansen.',
      model: 'some-model-id',
      verifierTier: 'flagship',
    },
  ]);

  return { editId: edit!.id, verifierUserId: verifierId };
}

describe('ensureKinetixSpace', () => {
  it('creates the space pointed at the Phase 1 policy', async () => {
    const space = await ensureKinetixSpace(db);
    expect(space.slug).toBe('kinetix');
    expect(space.activePolicyVersion).toBe(KINETIX_POLICY_VERSION);
  });

  it('is idempotent', async () => {
    const first = await ensureKinetixSpace(db);
    const second = await ensureKinetixSpace(db);
    expect(second.id).toBe(first.id);
    expect(await countRows('kg_spaces')).toBe(1);
  });
});

describe('target identities are created on demand', () => {
  it('addresses a Kinetix row by type and id', async () => {
    const target = await ensureKinetixTarget(db, {
      type: 'pending_edit',
      id: '42',
    });
    expect(target.targetKey).toBe('pending_edit:42');
    expect(kinetixTargetKey({ type: 'pending_edit', id: '42' })).toBe(
      'pending_edit:42',
    );
  });

  it('creates nothing beyond the space and the one target asked for', async () => {
    // "Do not run a giant speculative backfill" — this is that rule, enforced.
    await seedVerifiedPendingEdit();
    await ensureKinetixTarget(db, { type: 'pending_edit', id: '1' });
    expect(await countRows('kg_targets')).toBe(1);
    expect(await countRows('kg_assessments')).toBe(0);
  });
});

describe('snapshotLegacyVerifications', () => {
  it('imports every current verdict for the target', async () => {
    const { editId } = await seedVerifiedPendingEdit();
    const result = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    const assessments = await listAssessments(db, {
      subjectType: 'target',
      subjectId: result.targetId,
    });
    expect(assessments).toHaveLength(2);
    expect(assessments.every((a) => a.verdict === 'approve')).toBe(true);
  });

  it('stamps every imported row as a current-state-only snapshot', async () => {
    // §6: the migration must not pretend to reconstruct a history that no
    // longer exists, and a reader must be able to tell without a timestamp.
    const { editId } = await seedVerifiedPendingEdit();
    const { targetId } = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    const assessments = await listAssessments(db, {
      subjectType: 'target',
      subjectId: targetId,
    });
    for (const assessment of assessments) {
      // Under `host`: import provenance is Kinetix bookkeeping the generic
      // store carries and never reads.
      const snapshot = assessment.capabilitySnapshot as {
        host?: { provenance?: unknown };
      };
      expect(isLegacySnapshot(snapshot.host?.provenance)).toBe(true);
      expect(snapshot.host?.provenance).toMatchObject({
        origin: 'legacy_snapshot',
        historicalCompleteness: 'current_state_only',
        legacyType: 'agent_verification',
      });
    }
  });

  it('never invents a supersession chain', async () => {
    // §6.4: inferring that a current approval replaced an earlier dispute is
    // exactly the fabrication the append-only model exists to avoid, and the
    // source row for that earlier dispute is gone.
    const { editId } = await seedVerifiedPendingEdit();
    const { targetId } = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    const assessments = await listAssessments(db, {
      subjectType: 'target',
      subjectId: targetId,
    });
    expect(assessments.every((a) => a.supersedesAssessmentId === null)).toBe(true);
    // With no supersessions, every imported row is effective — which is the
    // truthful reading of an upsert-based source.
    expect(
      await currentAssessments(db, { subjectType: 'target', subjectId: targetId }),
    ).toHaveLength(2);
  });

  it('carries the server-owned tier, not the agent’s current one', async () => {
    const { editId } = await seedVerifiedPendingEdit();
    const { targetId } = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    // Re-tier the agent afterwards. The snapshot must not move.
    await db.execute(sql`update agents set model_tier = 'light'`);
    const assessments = await listAssessments(db, {
      subjectType: 'target',
      subjectId: targetId,
    });
    // Stored as the capability a gate reads, so a backfilled row and a native
    // one qualify identically rather than through two different fields.
    const tiers = assessments
      .flatMap(
        (a) =>
          (a.capabilitySnapshot as { assuranceCapabilities: string[] })
            .assuranceCapabilities,
      )
      .sort();
    expect(tiers).toEqual(['model_tier:flagship', 'model_tier:mid']);
  });

  it('keeps the self-reported model out of the capability snapshot', async () => {
    // §2.3: a claim about yourself is audit metadata, never what qualifies you.
    const { editId } = await seedVerifiedPendingEdit();
    const { targetId } = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    const assessments = await listAssessments(db, {
      subjectType: 'target',
      subjectId: targetId,
    });
    for (const assessment of assessments) {
      expect(
        JSON.stringify(assessment.capabilitySnapshot),
      ).not.toContain('some-model-id');
    }
  });

  it('writes nothing on a second run', async () => {
    const { editId } = await seedVerifiedPendingEdit();
    const ref = { type: 'pending_edit', id: String(editId) };
    await snapshotLegacyVerifications(db, ref);
    const before = {
      assessments: await countRows('kg_assessments'),
      links: await countRows('kg_legacy_links'),
      audit: await countRows('kg_audit_events'),
      targets: await countRows('kg_targets'),
      spaces: await countRows('kg_spaces'),
    };

    const second = await snapshotLegacyVerifications(db, ref);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect({
      assessments: await countRows('kg_assessments'),
      links: await countRows('kg_legacy_links'),
      audit: await countRows('kg_audit_events'),
      targets: await countRows('kg_targets'),
      spaces: await countRows('kg_spaces'),
    }).toEqual(before);
  });

  it('links each assessment to the verdict it came from', async () => {
    const { editId } = await seedVerifiedPendingEdit();
    const { targetId } = await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    const [verdict] = await db
      .select({ id: agentVerifications.id })
      .from(agentVerifications)
      .limit(1);
    const link = await findByLegacy(db, 'agent_verification', verdict!.id);
    expect(link?.genericType).toBe('assessment');
    const assessments = await listAssessments(db, {
      subjectType: 'target',
      subjectId: targetId,
    });
    expect(assessments.map((a) => a.id)).toContain(link!.genericId);
  });

  it('records one audit event for the import and none for a no-op', async () => {
    const { editId } = await seedVerifiedPendingEdit();
    const ref = { type: 'pending_edit', id: String(editId) };
    const space = await ensureKinetixSpace(db);
    await snapshotLegacyVerifications(db, ref);
    await snapshotLegacyVerifications(db, ref);
    const events = await listAuditEventsByType(db, {
      spaceId: space.id,
      eventType: 'legacy_snapshot_imported',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ imported: 2, skipped: 0 });
  });
});

describe('Kinetix is unaffected by the generic tables', () => {
  /** The live queue's response, as an agent sees it. */
  async function fetchQueue(callerUserId: number): Promise<unknown> {
    getUserFromRequestMock.mockResolvedValue({
      userId: callerUserId,
      role: 'contributor',
    });
    const req = {
      method: 'GET',
      url: '/api/agent-verifications-queue?minAgeMinutes=0&limit=100',
      headers: { host: 'localhost' },
    } as IncomingMessage;
    const state = { statusCode: 0, body: '' };
    const res = {
      headersSent: false,
      writeHead: vi.fn((statusCode: number) => {
        state.statusCode = statusCode;
        res.headersSent = true;
        return res;
      }),
      end: vi.fn((body?: string) => {
        state.body = body ?? '';
        return res;
      }),
    } as unknown as ServerResponse & { headersSent: boolean };
    await queueHandler(req, res);
    expect(state.statusCode).toBe(200);
    return JSON.parse(state.body);
  }

  it('serves an identical queue with the kg_* tables empty and populated', async () => {
    // The phase's whole safety property: the tables exist, and Kinetix behaves
    // the same whether they are empty or full. Rollback is to leave them.
    const { editId, verifierUserId } = await seedVerifiedPendingEdit();
    expect(await countRows('kg_spaces')).toBe(0);
    const withEmptyTables = await fetchQueue(verifierUserId);

    await snapshotLegacyVerifications(db, {
      type: 'pending_edit',
      id: String(editId),
    });
    expect(await countRows('kg_assessments')).toBe(2);
    const withPopulatedTables = await fetchQueue(verifierUserId);

    expect(withPopulatedTables).toEqual(withEmptyTables);
  });
});
