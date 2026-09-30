/**
 * The per-drug advisory lock around metabolism / receptor-target /
 * enzyme-interaction pending-edit submissions (issue #1076, item 1).
 *
 * `PUT /api/drug-metabolism`, `/api/drug-receptor-targets` and
 * `/api/drug-enzyme-interactions` queue a contributor's submission as a
 * `pending_edits` row. The admin *direct-write* branch of all three already
 * took the per-drug advisory lock the merge admin uses
 * (`withDrugApplicabilityLock`/`lockDrugForEntryApplicability`), but the
 * *queue* branch did not — so a submission landing between the merge's
 * up-front refusal check and its teardown delete was neither caught nor
 * serialized against it. `api/_lib/drug-merge.ts`'s own "item 11a" comment
 * named this as deferred work; this closes it by taking the lock (and
 * re-verifying the drug still exists under it) before the insert.
 *
 * A bare existence re-check isn't enough on its own (flagged by Codex review
 * on #1426): a submission against the merge's WINNER still finds the drug
 * there after the merge commits, so it would happily queue a
 * full-replacement proposal built from pre-merge state read outside the
 * lock — right after the merge folded the loser's rows onto that winner.
 * Approving that proposal later deletes exactly the rows the merge just
 * preserved. The fix mirrors the admin direct-write branch's existing
 * snapshot-and-compare: `drugs.updatedAt` is bumped by the merge on the
 * winner, so a drift between a pre-lock snapshot and the post-lock read
 * means a merge landed while the request waited.
 *
 * A real concurrent race is not reproducible against the single-connection
 * PGlite harness (see `wiki-monograph-drug-lock.test.ts` and
 * `parameter-applicability-write-paths.test.ts` for the same limitation), so
 * these tests assert the structural property directly: the lock is taken,
 * for the right drug, before the row is inserted; a drug whose `updatedAt`
 * moved between the snapshot and the lock is rejected rather than queued
 * (simulated by bumping it from inside the mocked lock call, which runs
 * exactly where a concurrent merge's commit would land); plus a plain
 * regression check that a normal submission still queues correctly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { getDb } from '../../api/_lib/db.js';
import { drugs } from '../../db/schema.js';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

const lockCalls: number[] = [];
let bumpUpdatedAtFor: number | null = null;
vi.mock('../../api/_lib/parameterApplicabilityStore.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../api/_lib/parameterApplicabilityStore.js')
  >();
  return {
    ...actual,
    withDrugApplicabilityLock: (async (
      drugId: number,
      fn: () => Promise<unknown>,
    ) => {
      lockCalls.push(drugId);
      // Simulate a concurrent merge committing (bumping `updatedAt`) in the
      // window between the caller's pre-lock snapshot and this lock actually
      // being acquired — the exact race the post-lock recheck exists to
      // catch.
      if (bumpUpdatedAtFor === drugId) {
        await getDb()
          .update(drugs)
          .set({ updatedAt: new Date(Date.now() + 60_000) })
          .where(eq(drugs.id, drugId));
      }
      return actual.withDrugApplicabilityLock(drugId, fn);
    }) as typeof actual.withDrugApplicabilityLock,
  };
});

import metabolismHandler from '../../api/drug-metabolism.js';
import receptorTargetsHandler from '../../api/drug-receptor-targets.js';
import enzymeInteractionsHandler from '../../api/drug-enzyme-interactions.js';
import { pendingEdits } from '../../db/schema.js';
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
  authMock.mockReset();
  lockCalls.length = 0;
  bumpUpdatedAtFor = null;
});

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function putRequest(url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PUT';
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const CASES: {
  name: string;
  handler: Handler;
  path: string;
  editType: 'metabolism' | 'receptor_targets' | 'enzyme_interaction';
}[] = [
  {
    name: 'metabolism',
    handler: metabolismHandler,
    path: '/api/drug-metabolism',
    editType: 'metabolism',
  },
  {
    name: 'receptor_targets',
    handler: receptorTargetsHandler,
    path: '/api/drug-receptor-targets',
    editType: 'receptor_targets',
  },
  {
    name: 'enzyme_interaction',
    handler: enzymeInteractionsHandler,
    path: '/api/drug-enzyme-interactions',
    editType: 'enzyme_interaction',
  },
];

describe.each(CASES)(
  'PUT $path — queue submission takes the per-drug advisory lock',
  ({ handler, path, editType }) => {
    it('locks the target drug before inserting the pending edit, and queues it', async () => {
      const userId = await seedUser(db);
      authMock.mockResolvedValue({ userId, role: 'contributor' });
      const drugId = await seedDrug(db, { slug: `${editType}-lock-drug` });

      const { res, state } = createResponse();
      await handler(putRequest(`${path}?drugId=${drugId}`, {}), res);

      expect(state.statusCode).toBe(201);
      const parsed = JSON.parse(state.body) as {
        pending: boolean;
        pendingEditId: number;
      };
      expect(parsed.pending).toBe(true);

      // The lock was taken for this exact drug — the fix under test.
      expect(lockCalls).toEqual([drugId]);

      const [row] = await db
        .select()
        .from(pendingEdits)
        .where(eq(pendingEdits.id, parsed.pendingEditId));
      expect(row?.editType).toBe(editType);
      expect(row?.targetId).toBe(drugId);
      expect(row?.status).toBe('pending');
      expect(row?.submittedBy).toBe(userId);
    });

    it('does not take the lock (or write anything) when the drug does not exist', async () => {
      const userId = await seedUser(db);
      authMock.mockResolvedValue({ userId, role: 'contributor' });

      const { res, state } = createResponse();
      await handler(putRequest(`${path}?drugId=999999`, {}), res);

      expect(state.statusCode).toBe(404);
      expect(lockCalls).toEqual([]);
      expect(await db.select().from(pendingEdits)).toHaveLength(0);
    });

    it('rejects the submission, and writes nothing, when the drug changed while waiting for the lock', async () => {
      const userId = await seedUser(db);
      authMock.mockResolvedValue({ userId, role: 'contributor' });
      const drugId = await seedDrug(db, { slug: `${editType}-changed-drug` });
      bumpUpdatedAtFor = drugId;

      const { res, state } = createResponse();
      await handler(putRequest(`${path}?drugId=${drugId}`, {}), res);

      expect(state.statusCode).toBe(409);
      expect(JSON.parse(state.body).code).toBe('drug_changed');
      expect(await db.select().from(pendingEdits)).toHaveLength(0);
    });
  },
);
