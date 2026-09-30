/**
 * The drug-scoped advisory lock on POST /api/pending-edits (issue #1076, item 1).
 *
 * A `wiki_new` submission carries its target drug in
 * `proposedMeta.drugCid` rather than `targetId`, so — unlike `wiki_fact` /
 * `wiki_page`, which look up their target page (and 404 if it's gone) before
 * ever reaching the lock — nothing checked the drug existed until
 * `resolveLockDrugId` takes the per-drug advisory lock and re-verifies under
 * it. This pins that outward behaviour: a `wiki_new` naming a drugCid that
 * doesn't exist is refused (404) and nothing is written, closing the window
 * where a submission could land against a drug a concurrent merge/delete
 * just removed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/pending-edits.js';
import { pendingEdits } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

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

function postRequest(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/pending-edits';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

describe('POST /api/pending-edits — wiki_new drug-existence recheck under the lock', () => {
  it('refuses a wiki_new submission naming a drugCid that does not exist, and writes nothing', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        editType: 'wiki_new',
        proposedValue: { type: 'doc', content: [] },
        proposedMeta: {
          title: 'Spøkelsesmonografi',
          pageType: 'drug_monograph',
          drugCid: 999_999,
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(404);
    const rows = await db.select().from(pendingEdits);
    expect(rows).toHaveLength(0);
  });
});
