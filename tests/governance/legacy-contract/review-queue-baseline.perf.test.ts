/**
 * Phase 0 gap 5 (docs/plans/2026-08-26-general-knowledge-governance-
 * extraction.md): "Capture baseline performance for review queue and
 * moderation endpoints" / "Performance acceptance should compare p50/p95
 * endpoint latency to Phase 0 baseline."
 *
 * This is a regression tripwire and a documented methodology, not a strict
 * perf gate: PGlite (WASM, single connection, no query planner tuned for
 * production Postgres) is not representative of production timing, so the
 * assertions below are generous sanity ceilings. What matters is that the
 * numbers are logged with a recognizable prefix (`[phase0-baseline]`) so a
 * future run's CI output can be diffed against this one by eye.
 *
 * Times two real endpoints against a moderately large seeded backlog:
 *   (a) the agent-verification queue selection path (GET /api/agent-
 *       verifications-queue), which does the interleaved reserved-fraction
 *       merge over every candidate type;
 *   (b) one PATCH /api/pending-edits decision (approve), the full apply path
 *       for a single edit sitting behind that backlog.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { agents, citations, pendingEdits, wikiPages } from '../../../db/schema.js';
import agentVerificationsQueueHandler from '../../../api/agent-verifications-queue.js';
import pendingEditsHandler from '../../../api/pending-edits.js';
import { pendingEditReviewToken } from '../../../api/_lib/pending-edit-review-token.js';
import { createFactNode } from '../../../src/lib/monographContent.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

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

function getRequest(url: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function patchRequest(url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

const BACKLOG_PARAM_ENTRY_COUNT = 120;
const BACKLOG_WIKI_FACT_COUNT = 40;
// Comfortably beyond default minAgeMinutes=5 so the whole seeded backlog is
// eligible without the test having to pass a minAgeMinutes override.
const AGE_MINUTES_START = 30;

async function seedBacklog(): Promise<{
  verifierUserId: number;
  bulkSubmitterId: number;
}> {
  const bulkSubmitterId = await seedUser(db, {
    email: 'bulk-submitter@example.com',
    username: 'bulk-submitter',
    role: 'contributor',
  });
  const verifierUserId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier',
    role: 'editor',
  });
  await db.insert(agents).values([
    {
      userId: verifierUserId,
      name: 'baseline-verifier',
      slug: 'baseline-verifier',
      status: 'active',
      selfReviewEnabled: false,
    },
  ]);
  // A couple more active agents, unused as callers here — just present so the
  // fixture isn't a single-agent pool, matching a realistic deployment.
  for (let i = 0; i < 2; i += 1) {
    const backingUserId = await seedUser(db, {
      email: `agent-${i}@example.com`,
      username: `agent-${i}`,
      role: 'editor',
    });
    await db.insert(agents).values({
      userId: backingUserId,
      name: `pool-agent-${i}`,
      slug: `pool-agent-${i}`,
      status: 'active',
      selfReviewEnabled: false,
    });
  }

  const drugId = await seedDrug(db);
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'baseline-topic',
      title: 'Baseline topic',
      pageType: 'topic',
      status: 'published',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2, sectionId: 'overview' },
            content: [{ type: 'text', text: 'Overview' }],
          },
        ],
      },
      createdBy: bulkSubmitterId,
      updatedBy: bulkSubmitterId,
    })
    .returning({ id: wikiPages.id });

  const paramEntryRows = Array.from(
    { length: BACKLOG_PARAM_ENTRY_COUNT },
    (_, i) => ({
      editType: 'param_entry' as const,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      proposedValue: {
        op: 'create' as const,
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10 + i,
          high: 20 + i,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
        },
      } as never,
      submittedBy: bulkSubmitterId,
      status: 'pending' as const,
      submittedAt: new Date(
        Date.now() - (AGE_MINUTES_START + i) * 60_000,
      ),
    }),
  );
  const wikiFactRows = Array.from(
    { length: BACKLOG_WIKI_FACT_COUNT },
    (_, i) => ({
      editType: 'wiki_fact' as const,
      targetId: page!.id,
      sectionId: 'overview',
      factOperation: 'add' as const,
      factStatement: `Baseline-faktum nummer ${i}.`,
      proposedValue: createFactNode({
        factId: `baseline-fact-${i}`,
        statement: `Baseline-faktum nummer ${i}.`,
        referenceIds: [],
      }) as never,
      submittedBy: bulkSubmitterId,
      status: 'pending' as const,
      submittedAt: new Date(
        Date.now() - (AGE_MINUTES_START + i) * 60_000,
      ),
    }),
  );

  await db.insert(pendingEdits).values(paramEntryRows);
  await db.insert(pendingEdits).values(wikiFactRows);

  return { verifierUserId, bulkSubmitterId };
}

describe('[phase0-baseline] review-queue and moderation endpoint timing', () => {
  it(
    `times the agent-verification queue (~${
      BACKLOG_PARAM_ENTRY_COUNT + BACKLOG_WIKI_FACT_COUNT
    } pending_edit backlog) and a single approve decision`,
    async () => {
      const { verifierUserId } = await seedBacklog();

      getUserFromRequestMock.mockResolvedValue({
        userId: verifierUserId,
        role: 'editor',
      });
      const { res: queueRes, state: queueState } = createResponse();
      const queueStart = performance.now();
      await agentVerificationsQueueHandler(
        getRequest('/api/agent-verifications-queue?targetType=pending_edit&limit=20'),
        queueRes,
      );
      const queueMs = performance.now() - queueStart;
      expect(queueState.statusCode).toBeLessThan(300);
      const queueBody = JSON.parse(queueState.body) as { items: unknown[] };
      expect(queueBody.items.length).toBeGreaterThan(0);

      // A single, independently-seeded edit for the approve timing, so its
      // cost isn't entangled with the unrelated backlog rows above.
      const submitterId = await seedUser(db, {
        email: 'approve-submitter@example.com',
        username: 'approve-submitter',
        role: 'contributor',
      });
      const reviewerId = await seedUser(db, {
        email: 'approve-reviewer@example.com',
        username: 'approve-reviewer',
        role: 'editor',
      });
      const drugId = await seedDrug(db, {
        slug: 'baseline-approve-drug',
        names: { nb: 'Baseline B', en: 'Baseline B' },
      });
      const [citation] = await db
        .insert(citations)
        .values({ type: 'doi', identifier: '10.1/baseline-approve', metadata: {} })
        .returning({ id: citations.id });
      const [edit] = await db
        .insert(pendingEdits)
        .values({
          editType: 'param_entry',
          targetId: drugId,
          parameter: 'therapeuticConcentration',
          referenceIds: [citation!.id],
          proposedValue: {
            op: 'create',
            input: {
              drugId,
              parameter: 'therapeuticConcentration',
              low: 10,
              high: 20,
              unit: 'mg/L',
              matrix: 'whole_blood',
              scenario: 'living_therapeutic',
              citationId: citation!.id,
            },
          } as never,
          submittedBy: submitterId,
          status: 'pending',
        })
        .returning();

      getUserFromRequestMock.mockResolvedValue({
        userId: reviewerId,
        role: 'editor',
      });
      const { res: approveRes, state: approveState } = createResponse();
      const approveStart = performance.now();
      await pendingEditsHandler(
        patchRequest(`/api/pending-edits?id=${edit!.id}`, {
          status: 'approved',
          reviewToken: pendingEditReviewToken(edit!),
        }),
        approveRes,
      );
      const approveMs = performance.now() - approveStart;
      expect(approveState.statusCode).toBeLessThan(300);

      console.info(
        `[phase0-baseline] agent-verifications-queue (targetType=pending_edit, ` +
          `backlog=${BACKLOG_PARAM_ENTRY_COUNT + BACKLOG_WIKI_FACT_COUNT}): ` +
          `${queueMs.toFixed(1)}ms`,
      );
      console.info(
        `[phase0-baseline] PATCH /api/pending-edits approve (param_entry, ` +
          `single decision): ${approveMs.toFixed(1)}ms`,
      );

      // Generous sanity ceilings, not a perf gate — PGlite has no
      // production-representative query planner or connection pooling. The
      // point of this test is the logged numbers above, kept as a baseline a
      // future run can be compared against.
      expect(queueMs).toBeLessThan(5000);
      expect(approveMs).toBeLessThan(5000);
    },
  );
});
