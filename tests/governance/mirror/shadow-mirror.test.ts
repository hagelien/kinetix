/**
 * Phase 4: shadow mirroring through the real routes (§12.1).
 *
 * The single rule that outranks everything else here is §12.1.4 / §12.4:
 *
 *   > Mirror failures do not reject successful Kinetix actions during this
 *   > phase.
 *
 * So the tests that matter most are the negative ones — that a broken mirror
 * still leaves a 201 and a recorded verdict behind, and that a target nobody
 * advanced past `legacy_only` produces no generic rows at all. Correctness of
 * what gets written is necessary; not being able to break Kinetix is the
 * property the phase is *for*.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { eq, sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  kgAssessments,
  kgProposalVersions,
  kgProposals,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import agentVerificationsHandler from '../../../api/agent-verifications.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
  mirrorPublicationOutcome,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  readMetric,
  resetMetricsForTests,
} from '../../../api/_lib/knowledge-governance/metrics.js';
import { ensureKinetixSpace } from '../../../api/_lib/knowledge-governance/backfill.js';
import {
  currentAssessments,
  listAuditEventsByType,
  listVersions,
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
  invalidateMigrationStateCache();
  resetMetricsForTests();
});

function createResponse() {
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
  return { res, state };
}

function jsonRequest(method: string, url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

async function countRows(table: string): Promise<number> {
  const result = await db.execute(
    sql.raw(`select count(*)::int as n from ${table}`),
  );
  const rows = (result as unknown as { rows?: Array<{ n: number }> }).rows ?? [];
  return rows[0]?.n ?? 0;
}

/**
 * Run `fn` with one table temporarily invisible, then put it back.
 *
 * A rename rather than a `DROP`: dropping is not reversible inside a test file
 * (`resetIntegrationDb` truncates, it does not replay the migrations), so the
 * first destructive test would silently break every later one in the same file
 * — which is exactly what happened when this was written with DROP. A renamed
 * table takes its indexes and foreign keys with it, so a write against the old
 * name fails with "relation does not exist", which is the failure being
 * simulated.
 */
async function withMissingTable<T>(
  table: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.execute(sql.raw(`alter table ${table} rename to ${table}_hidden`));
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw(`alter table ${table}_hidden rename to ${table}`));
  }
}

async function seedAgent(userId: number, slug: string, modelTier: string | null) {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active', modelTier })
    .returning({ id: agents.id });
  return row!.id;
}

/** An author's pending edit plus a separate agent that can verify it. */
async function seedEditAwaitingVerdict(): Promise<{
  editId: number;
  verifierUserId: number;
  targetVersion: string;
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
  await seedAgent(authorId, 'author-agent', 'mid');
  await seedAgent(verifierId, 'verifier-agent', 'flagship');

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
    .returning({ id: pendingEdits.id, submittedAt: pendingEdits.submittedAt });

  return {
    editId: edit!.id,
    verifierUserId: verifierId,
    targetVersion: `${edit!.submittedAt.toISOString()}|pending`,
  };
}

/** POST a verdict through the real route. */
async function postVerdict(args: {
  callerUserId: number;
  targetId: number;
  targetVersion: string;
  verdict: 'approve' | 'dispute' | 'abstain';
  rationaleMd?: string;
}) {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.callerUserId,
    role: 'contributor',
  });
  const req = jsonRequest('POST', '/api/agent-verifications', {
    targetType: 'pending_edit',
    targetId: args.targetId,
    targetVersion: args.targetVersion,
    verdict: args.verdict,
    rationaleMd: args.rationaleMd ?? '',
  });
  const { res, state } = createResponse();
  await agentVerificationsHandler(req, res);
  return state;
}

describe('legacy_only means nothing is mirrored', () => {
  it('writes no generic rows for a verdict on an unadvanced target', async () => {
    // The mode nothing ships as, and the reason this phase can be deployed
    // without changing a single request.
    const { editId, verifierUserId, targetVersion } =
      await seedEditAwaitingVerdict();
    const state = await postVerdict({
      callerUserId: verifierUserId,
      targetId: editId,
      targetVersion,
      verdict: 'approve',
    });

    expect(state.statusCode).toBe(201);
    expect(await countRows('kg_spaces')).toBe(0);
    expect(await countRows('kg_proposals')).toBe(0);
    expect(await countRows('kg_assessments')).toBe(0);
    // Not even an attempt is counted: the mode is checked first.
    expect(readMetric('kg_mirror_attempt_total', 'pending_edit')).toBe(0);
  });
});

describe('shadow mode mirrors after the legacy write', () => {
  beforeEach(async () => {
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
  });

  it('mirrors a verdict as a version-bound assessment', async () => {
    const { editId, verifierUserId, targetVersion } =
      await seedEditAwaitingVerdict();
    const state = await postVerdict({
      callerUserId: verifierUserId,
      targetId: editId,
      targetVersion,
      verdict: 'approve',
    });
    expect(state.statusCode).toBe(201);

    // The hook is fire-and-forget, so give the microtask queue a turn. In
    // production the mirror simply completes after the response; here the test
    // has to wait for what the request deliberately did not.
    await vi.waitFor(async () => {
      expect(await countRows('kg_assessments')).toBeGreaterThan(0);
    });

    const [proposal] = await db.select().from(kgProposals);
    expect(proposal).toBeDefined();
    const versions = await listVersions(db, proposal!.id);
    expect(versions).toHaveLength(1);

    // §8.3: bound to the version, not to the target, so a later revision
    // cannot inherit it.
    const assessments = await currentAssessments(db, {
      subjectType: 'proposal_version',
      subjectId: versions[0]!.id,
    });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.verdict).toBe('approve');
  });

  it('carries the tier stamped on the verdict row, not the live agent tier', async () => {
    const { editId, verifierUserId, targetVersion } =
      await seedEditAwaitingVerdict();
    await postVerdict({
      callerUserId: verifierUserId,
      targetId: editId,
      targetVersion,
      verdict: 'approve',
    });
    await vi.waitFor(async () => {
      expect(await countRows('kg_assessments')).toBe(1);
    });
    // Downgrade afterwards. The snapshot must not move — this is the
    // retroactive reclassification migration 0113 closed.
    await db.execute(sql`update agents set model_tier = 'light'`);
    const [assessment] = await db.select().from(kgAssessments);
    expect(
      (assessment!.capabilitySnapshot as { assuranceCapabilities: string[] })
        .assuranceCapabilities,
    ).toEqual(['model_tier:flagship']);
  });

  it('appends no second version when the payload has not moved', async () => {
    // What makes the hooks safe to call on every write, including the upsert
    // path where "was this an insert?" is only best-effort knowable.
    const { editId } = await seedEditAwaitingVerdict();
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    expect(await countRows('kg_proposals')).toBe(1);
    expect(await countRows('kg_proposal_versions')).toBe(1);
  });

  it('appends a new version when the payload does move', async () => {
    const { editId } = await seedEditAwaitingVerdict();
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    await db
      .update(pendingEdits)
      .set({ factStatement: 'Halveringstiden er 43 timer.' })
      .where(eq(pendingEdits.id, editId));
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });

    const versions = await db
      .select({ versionNo: kgProposalVersions.versionNo })
      .from(kgProposalVersions);
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
  });

  it('does not mirror the same verdict twice', async () => {
    const { editId, verifierUserId, targetVersion } =
      await seedEditAwaitingVerdict();
    await postVerdict({
      callerUserId: verifierUserId,
      targetId: editId,
      targetVersion,
      verdict: 'approve',
    });
    await vi.waitFor(async () => {
      expect(await countRows('kg_assessments')).toBe(1);
    });
    const [verdict] = await db
      .select({ id: agentVerifications.id })
      .from(agentVerifications)
      .where(eq(agentVerifications.isImplicit, false))
      .limit(1);

    const second = await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: verdict!.id,
      actorRef: `user:${verifierUserId}`,
      verdict: 'approve',
    });
    expect(second).toEqual({ mirrored: false, skipped: 'already_mirrored' });
    expect(await countRows('kg_assessments')).toBe(1);
  });

  it('skips a target type with no adapter rather than failing', async () => {
    await setMigrationMode({
      targetType: 'invented_type',
      mode: 'shadow',
      updatedBy: null,
    });
    const outcome = await mirrorProposalVersion({
      targetType: 'invented_type',
      targetId: 1,
    });
    expect(outcome).toEqual({ mirrored: false, skipped: 'no_adapter' });
  });

  it('skips a row that no longer exists rather than failing', async () => {
    const outcome = await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: 999_999,
    });
    expect(outcome).toEqual({ mirrored: false, skipped: 'no_row' });
  });

  it('records a publication outcome against the current version', async () => {
    const { editId } = await seedEditAwaitingVerdict();
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    const outcome = await mirrorPublicationOutcome({
      targetType: 'pending_edit',
      targetId: editId,
      action: 'applied',
      actorRef: 'system:agent-consensus',
      appliedRevisionRef: 'wiki_revision:5',
    });
    expect(outcome.mirrored).toBe(true);
    expect(await countRows('kg_publication_events')).toBe(1);
  });
});

describe('a mirror failure cannot reject a Kinetix action', () => {
  beforeEach(async () => {
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
  });

  it('leaves the verdict recorded and the response a 201', async () => {
    // The rule that outranks everything else in this phase. Simulated by
    // dropping the table the mirror writes into, which is as broken as a
    // generic-schema bug can plausibly get.
    const { editId, verifierUserId, targetVersion } =
      await seedEditAwaitingVerdict();

    const state = await withMissingTable('kg_assessments', async () => {
      const posted = await postVerdict({
        callerUserId: verifierUserId,
        targetId: editId,
        targetVersion,
        verdict: 'approve',
        rationaleMd: 'Verdien stemmer med referansen som er oppgitt.',
      });
      // Let the fire-and-forget mirror actually fail inside the window where
      // the table is missing, rather than after it has been restored.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return posted;
    });

    expect(state.statusCode).toBe(201);
    const verdicts = await db
      .select({ id: agentVerifications.id })
      .from(agentVerifications)
      .where(eq(agentVerifications.isImplicit, false));
    expect(verdicts).toHaveLength(1);
  });

  it('never throws out of the mirror entry points', async () => {
    const { editId } = await seedEditAwaitingVerdict();
    await withMissingTable('kg_proposal_versions', async () => {
      await expect(
        mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId }),
      ).resolves.toMatchObject({ mirrored: false });
    });
  });

  it('files a durable repair item and counts the failure', async () => {
    // The counter lives in one warm instance; the audit row is the record that
    // survives a cold start and is what a repair is driven from.
    const { editId } = await seedEditAwaitingVerdict();
    await mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId });
    const space = await ensureKinetixSpace(db);

    await db
      .update(pendingEdits)
      .set({ factStatement: 'Endret.' })
      .where(eq(pendingEdits.id, editId));
    const outcome = await withMissingTable('kg_proposal_versions', () =>
      mirrorProposalVersion({ targetType: 'pending_edit', targetId: editId }),
    );

    expect(outcome.mirrored).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(readMetric('kg_mirror_failure_total', 'pending_edit')).toBe(1);
    const repairs = await listAuditEventsByType(db, {
      spaceId: space.id,
      eventType: 'mirror_failed',
    });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.payload).toMatchObject({
      targetType: 'pending_edit',
      operation: 'proposal_version',
    });
  });
});
