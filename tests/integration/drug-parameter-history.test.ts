/**
 * `GET /api/drug-parameter-history?drugId=&parameter=`
 *
 * Covers what #1358 asked for: the edit-history payload should say why a
 * revision's pooled sources changed (`sourceDiff`), not just that they did,
 * and should carry the review "round" behind it — agent verdicts and human
 * disputes raised against the revision itself.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import {
  agents,
  agentVerifications,
  citations,
  disputes,
  drugParameterRevisions,
  parameterEntries,
} from '../../db/schema.js';
import handler from '../../api/drug-parameter-history.js';
import { recomputeAndCacheParameterSummary } from '../../api/_lib/parameter-entries-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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
  getUserFromRequestMock.mockResolvedValue(null);
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

async function callHistory(drugId: number, parameter: string, query = '') {
  const req = {
    method: 'GET',
    url: `/api/drug-parameter-history?drugId=${drugId}&parameter=${parameter}${query}`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
}

async function seedEntry(drugId: number, over: Partial<typeof parameterEntries.$inferInsert>) {
  const [row] = await db
    .insert(parameterEntries)
    .values({
      drugId,
      parameter: 'therapeuticConcentration',
      unit: 'mg/L',
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      origin: 'legacy',
      ...over,
    })
    .returning({ id: parameterEntries.id });
  return row!.id;
}

async function seedAgent(userId: number, slug: string): Promise<number> {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active', selfReviewEnabled: false })
    .returning({ id: agents.id });
  return row!.id;
}

/** Seeds a revision with a resolved source diff, an agent verdict and a human dispute on it. */
async function seedRevisionWithReviewRound(drugId: number, userId: number) {
  const [cite] = await db
    .insert(citations)
    .values({ type: 'pmid', identifier: '999', metadata: { title: 'Dropped paper' } })
    .returning({ id: citations.id });
  await seedEntry(drugId, { median: '10' });
  const droppedEntry = await seedEntry(drugId, { median: '20', citationId: cite!.id });

  await recomputeAndCacheParameterSummary(drugId, 'therapeuticConcentration', userId);
  await db.delete(parameterEntries).where(eq(parameterEntries.id, droppedEntry));
  const revisionId = await recomputeAndCacheParameterSummary(
    drugId,
    'therapeuticConcentration',
    userId,
  );
  expect(revisionId).not.toBeNull();

  const agentUserId = await seedUser(db, { email: 'agent@example.com', username: 'agent-user' });
  const agentId = await seedAgent(agentUserId, 'reviewer-agent');
  await db.insert(agentVerifications).values({
    agentId,
    targetType: 'drug_parameter_revision',
    targetId: revisionId!,
    verdict: 'approve',
    rationaleMd: 'Matches the surviving source.',
    isImplicit: false,
  });

  const humanId = await seedUser(db, { email: 'human@example.com', username: 'human-reviewer' });
  await db.insert(disputes).values({
    targetType: 'drug_parameter_revision',
    targetId: revisionId!,
    createdBy: humanId,
    source: 'human',
    reasonMd: 'This recompute dropped a source without explanation.',
  });

  return { revisionId: revisionId!, citeId: cite!.id };
}

describe('GET /api/drug-parameter-history', () => {
  it("carries the source diff, verdicts and the target author's own disputes", async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const { revisionId, citeId } = await seedRevisionWithReviewRound(drugId, userId);

    // Authenticated as the revision's own author (drugParameterRevisions.createdBy
    // is `userId` here) — one of the three callers GET /api/disputes itself allows.
    getUserFromRequestMock.mockResolvedValue({ userId, role: 'contributor' });
    const { status, body } = await callHistory(drugId, 'therapeuticConcentration');
    expect(status).toBe(200);
    expect(body.revisions).toHaveLength(2);

    const latest = body.revisions[0];
    expect(latest.id).toBe(revisionId);
    expect(latest.sourceDiff).toEqual({
      added: [],
      removed: [{ citationId: citeId, label: 'Dropped paper' }],
    });
    expect(latest.referenceIds).toBeNull();
    expect(latest.reviewVerdicts).toHaveLength(1);
    expect(latest.reviewVerdicts[0]).toMatchObject({
      verdict: 'approve',
      rationaleMd: 'Matches the surviving source.',
      agent: { slug: 'reviewer-agent' },
    });
    expect(latest.disputes).toHaveLength(1);
    expect(latest.disputes[0]).toMatchObject({
      source: 'human',
      reasonMd: 'This recompute dropped a source without explanation.',
      status: 'open',
    });

    // The first revision (the cited source newly pooled) carries no verdicts.
    const first = body.revisions[1];
    expect(first.sourceDiff.added).toEqual([{ citationId: citeId, label: 'Dropped paper' }]);
    expect(first.reviewVerdicts).toEqual([]);
    expect(first.disputes).toEqual([]);
  });

  it('never leaks dispute content to a caller who is not an agent, reviewer, or the target author', async () => {
    // Regression for a Codex P1 finding on #1363: the dedicated GET
    // /api/disputes route restricts a dispute's author identity + reasonMd to
    // an active agent, a reviewer, or the target's own author. This endpoint
    // has no auth gate at all, so an anonymous (or unrelated-user) request
    // must never see that content even though the revision itself is public.
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const { revisionId } = await seedRevisionWithReviewRound(drugId, userId);

    // Anonymous caller.
    getUserFromRequestMock.mockResolvedValue(null);
    const anon = await callHistory(drugId, 'therapeuticConcentration');
    const anonLatest = anon.body.revisions.find((r: { id: number }) => r.id === revisionId);
    expect(anonLatest.disputes).toEqual([]);
    // Agent verdicts are a different, already-public read for this target
    // type, so they're unaffected by the dispute gate.
    expect(anonLatest.reviewVerdicts).toHaveLength(1);

    // An authenticated contributor who is neither the author nor a reviewer.
    const strangerId = await seedUser(db, { email: 'stranger@example.com', username: 'stranger' });
    getUserFromRequestMock.mockResolvedValue({ userId: strangerId, role: 'contributor' });
    const stranger = await callHistory(drugId, 'therapeuticConcentration');
    const strangerLatest = stranger.body.revisions.find(
      (r: { id: number }) => r.id === revisionId,
    );
    expect(strangerLatest.disputes).toEqual([]);
  });

  it('shows disputes to a reviewer regardless of authorship', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const { revisionId } = await seedRevisionWithReviewRound(drugId, userId);

    const reviewerId = await seedUser(db, { email: 'reviewer@example.com', username: 'reviewer' });
    getUserFromRequestMock.mockResolvedValue({ userId: reviewerId, role: 'editor' });
    const { body } = await callHistory(drugId, 'therapeuticConcentration');
    const latest = body.revisions.find((r: { id: number }) => r.id === revisionId);
    expect(latest.disputes).toHaveLength(1);
  });
});

describe('a revision a notification links to', () => {
  it('is included even when it is older than the newest 100', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db, { email: 'h@example.com', username: 'h' });
    const base = Date.UTC(2026, 0, 1);
    const inserted = await db
      .insert(drugParameterRevisions)
      .values(
        Array.from({ length: 101 }, (_, i) => ({
          drugId,
          parameter: 'halfLife',
          createdBy: userId,
          createdAt: new Date(base + i * 60_000),
        })),
      )
      .returning({ id: drugParameterRevisions.id, createdAt: drugParameterRevisions.createdAt });
    const oldest = inserted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!.id;
    // Another parameter's revision: an id from elsewhere must not leak in.
    const [other] = await db
      .insert(drugParameterRevisions)
      .values({ drugId, parameter: 'tmax', createdBy: userId, createdAt: new Date(base) })
      .returning({ id: drugParameterRevisions.id });

    const plain = await callHistory(drugId, 'halfLife');
    const plainIds = plain.body.revisions.map((r: { id: number }) => r.id);
    expect(plainIds).toHaveLength(100);
    expect(plainIds).not.toContain(oldest);

    const linked = await callHistory(drugId, 'halfLife', `&revision=${oldest}`);
    expect(linked.body.revisions.map((r: { id: number }) => r.id)).toContain(oldest);

    const foreign = await callHistory(drugId, 'halfLife', `&revision=${other!.id}`);
    expect(foreign.body.revisions.map((r: { id: number }) => r.id)).not.toContain(other!.id);

    expect((await callHistory(drugId, 'halfLife', '&revision=abc')).status).toBe(400);
  });
});
