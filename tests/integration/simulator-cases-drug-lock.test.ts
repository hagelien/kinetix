/**
 * Drug-existence validation on simulator case saves (issue #1076, item 4).
 *
 * A case's `case_data.drugs[].drugId` is arbitrary client-supplied data with
 * no FK behind it, so nothing stopped a save from pointing at a drug that a
 * concurrent merge/delete had already removed. `saveCaseWithMergeLock`
 * resolves every referenced drug, takes the per-drug advisory lock the merge
 * admin holds (`lockDrugForEntryApplicability`), and re-verifies existence
 * under that lock before writing — closing the same window a page or
 * pending-edit submission closes. These tests pin the outward behaviour: a
 * case naming a drug that doesn't exist is rejected (409) and never
 * persisted, while an ordinary case against a real drug saves normally.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/simulator/cases.js';
import { simulatorCases } from '../../db/schema.js';
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
  req.url = '/api/simulator/cases';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

describe('POST /api/simulator/cases — drug existence under the merge lock', () => {
  it('refuses a case referencing a drugId that does not exist, and saves nothing', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        name: 'Spøkelsescase',
        caseData: { drugs: [{ drugId: '999999' }] },
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('case_drug_missing');
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(0);
  });

  it('saves a case whose referenced drug is real', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const drugId = await seedDrug(db, { slug: 'ekte-simulator-middel' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        name: 'Ekte case',
        caseData: { drugs: [{ drugId: String(drugId) }] },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(1);
  });

  it('saves a case with no drug references at all (no lock needed)', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        name: 'Case uten legemiddel',
        caseData: { notes: 'plain payload' },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(1);
  });
});
