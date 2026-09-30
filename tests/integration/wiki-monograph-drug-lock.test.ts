/**
 * The drug-existence recheck around the monograph write paths (issue #1076,
 * item 3).
 *
 * `POST /api/wiki/pages` already took the per-drug advisory lock
 * (`withDrugApplicabilityLock`) before publishing a `drug_monograph`, but
 * never re-verified the drug was still there once the lock was held — a
 * merge or delete that ran while the request waited for the lock could
 * commit a monograph linked to a drug that no longer exists. `PUT
 * /api/wiki/pages` took no lock at all when a request assigned or changed
 * `drugCid`, so the same race was wide open on every edit that (re)links a
 * page to a drug.
 *
 * These tests exercise both gaps directly: rather than choreograph an actual
 * concurrent delete mid-request (which the lock makes hard to land as a
 * deterministic test), they assert the recheck itself — a request naming a
 * drugCid that is already gone must fail cleanly (404) and must not write
 * anything, which is exactly the outcome the recheck exists to guarantee
 * regardless of how the drug came to be missing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import handler from '../../api/wiki/pages.js';
import { wikiPages } from '../../db/schema.js';
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

function jsonRequest(
  method: string,
  url: string,
  body: unknown,
): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

const EMPTY_DOC = { type: 'doc', content: [] };

describe('POST /api/wiki/pages — drug-existence recheck under the lock', () => {
  it('refuses a monograph linked to a drugCid that does not exist, and writes nothing', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });

    const { res, state } = createResponse();
    await handler(
      jsonRequest('POST', '/api/wiki/pages', {
        title: 'Spøkelsesmiddel',
        content: EMPTY_DOC,
        pageType: 'drug_monograph',
        drugCid: 999_999,
      }),
      res,
    );

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).error).toMatch(/drug not found/i);

    const rows = await db.select().from(wikiPages);
    expect(rows).toHaveLength(0);
  });

  it('still publishes the monograph when the drug is real', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });
    const drugId = await seedDrug(db, { slug: 'ekte-middel' });

    const { res, state } = createResponse();
    await handler(
      jsonRequest('POST', '/api/wiki/pages', {
        title: 'Ekte Middel',
        content: EMPTY_DOC,
        pageType: 'drug_monograph',
        drugCid: drugId,
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    const [row] = await db.select().from(wikiPages);
    expect(row?.drugCid).toBe(drugId);
  });
});

describe('PUT /api/wiki/pages — locking a (re)assigned drugCid', () => {
  async function seedTopicPage(userId: number): Promise<{
    slug: string;
    updatedAt: Date;
  }> {
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'topic-page',
        title: 'Topic page',
        content: EMPTY_DOC,
        pageType: 'topic',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ slug: wikiPages.slug, updatedAt: wikiPages.updatedAt });
    return { slug: page!.slug, updatedAt: page!.updatedAt };
  }

  it('refuses to link the page to a drugCid that does not exist, and leaves the page untouched', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });
    const { slug, updatedAt } = await seedTopicPage(userId);

    const { res, state } = createResponse();
    await handler(
      jsonRequest('PUT', `/api/wiki/pages?slug=${slug}`, {
        drugCid: 999_999,
      }),
      res,
    );

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).error).toMatch(/drug not found/i);

    const [row] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug));
    expect(row?.drugCid).toBeNull();
    expect(row?.updatedAt.getTime()).toBe(updatedAt.getTime());
  });

  it('links the page when the drugCid names a real drug', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });
    const { slug } = await seedTopicPage(userId);
    const drugId = await seedDrug(db, { slug: 'ekte-middel-2' });

    const { res, state } = createResponse();
    await handler(
      jsonRequest('PUT', `/api/wiki/pages?slug=${slug}`, { drugCid: drugId }),
      res,
    );

    expect(state.statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug));
    expect(row?.drugCid).toBe(drugId);
  });

  it('does not re-lock (or re-check) a resubmit that leaves drugCid unchanged', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });
    const drugId = await seedDrug(db, { slug: 'ekte-middel-3' });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'linked-page',
        title: 'Linked page',
        content: EMPTY_DOC,
        pageType: 'topic',
        drugCid: drugId,
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ slug: wikiPages.slug });

    const { res, state } = createResponse();
    await handler(
      jsonRequest('PUT', `/api/wiki/pages?slug=${page!.slug}`, {
        title: 'Linked page (revised)',
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, page!.slug));
    expect(row?.drugCid).toBe(drugId);
    expect(row?.title).toBe('Linked page (revised)');
  });
});
