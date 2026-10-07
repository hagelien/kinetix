/**
 * The open PDF-request queue never shows a PubChem compound record.
 *
 * POST refuses new requests for them and migration 0137 cancelled the old
 * ones, but the previous deployment keeps serving POST until this one is live,
 * so a request can land after the migration ran. The open list and the header
 * badge count both filter on read; this pins that against real SQL, including
 * the shared regex running under PostgreSQL rather than JavaScript.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import handler from '../../api/pdf-requests.js';
import { citations, pdfRequests } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  authMock.mockResolvedValue({ userId, role: 'admin' });
});

/** An open request as the previous deployment would have written it. */
async function seedOpenRequest(identifier: string): Promise<number> {
  const [citation] = await db
    .insert(citations)
    .values({ type: 'url', identifier })
    .returning({ id: citations.id });
  await db
    .insert(pdfRequests)
    .values({ citationId: citation!.id, status: 'open', requestedBy: userId });
  return citation!.id;
}

async function get(url: string): Promise<{ statusCode: number; body: any }> {
  const req = Readable.from(['']) as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost' };
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
  await handler(req, res);
  return { statusCode: state.statusCode, body: JSON.parse(state.body) };
}

describe('GET /api/pdf-requests and PubChem compound records', () => {
  it('keeps a late-filed PubChem request out of the open list and the badge count', async () => {
    await seedOpenRequest('https://pubchem.ncbi.nlm.nih.gov/compound/115237');
    const paper = await seedOpenRequest('https://example.org/paper.pdf');
    // Not a record the helper can fetch, so it stays on the ordinary path.
    const substance = await seedOpenRequest(
      'https://pubchem.ncbi.nlm.nih.gov/substance/12345',
    );

    // Neither of these can take a PDF either.
    await seedOpenRequest('https://go.drugbank.com/drugs/DB00820');
    await seedOpenRequest('https://www.noklus.no');

    const list = await get('/api/pdf-requests');
    expect(list.statusCode).toBe(200);
    expect(
      list.body.requests.map((r: { citationId: number }) => r.citationId).sort(),
    ).toEqual([paper, substance].sort());

    const count = await get('/api/pdf-requests?countOnly=1');
    expect(count.body).toEqual({ count: 2 });
  });
});
