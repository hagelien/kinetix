/**
 * Page-row lock on POST /api/pending-edits for pages without a drug lock (issue #164).
 *
 * A topic page has no per-drug lock, and pending_edits.target_id has no
 * foreign key, so a submission racing the page delete could outlive the page.
 * The submit now share-locks the page row around its insert and the delete
 * locks it FOR UPDATE before sweeping. PGlite runs on one connection, so the
 * interleaving itself cannot be reproduced; this pins the path's outcomes.
  */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/pending-edits.js';
import { runInPoolTransaction } from '../../api/_lib/db.js';
import { lockWikiPageShared } from '../../api/_lib/wiki-page-lock.js';
import { eq } from 'drizzle-orm';
import { pendingEdits, wikiPages } from '../../db/schema.js';
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

describe('POST /api/pending-edits — topic page proposals take the page row lock', () => {
  it('files a wiki_page proposal against an existing topic page', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'sedativer',
        title: 'Sedativer',
        content: {},
        pageType: 'topic',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        editType: 'wiki_page',
        targetId: page!.id,
        proposedValue: { title: 'Sedativer', content: {} },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    const rows = await db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(eq(pendingEdits.targetId, page!.id));
    expect(rows).toHaveLength(1);
  });

  it('refuses a proposal whose topic page is gone and writes nothing', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'admin' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        editType: 'wiki_page',
        targetId: 987654,
        proposedValue: { title: 'Gone', content: {} },
      }),
      res,
    );

    expect(state.statusCode).toBe(404);
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
  });
});

describe('lockWikiPageShared', () => {
  it('reports whether the page row still exists inside a transaction', async () => {
    const userId = await seedUser(db);
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'sedativer',
        title: 'Sedativer',
        content: {},
        pageType: 'topic',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });

    const found = await runInPoolTransaction(() => lockWikiPageShared(page!.id));
    const missing = await runInPoolTransaction(() => lockWikiPageShared(987654));
    expect(found).toBe(true);
    expect(missing).toBe(false);
  });
});
