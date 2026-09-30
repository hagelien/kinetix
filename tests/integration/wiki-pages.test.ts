import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { wikiPages } from '../../db/schema.js';
import pagesHandler from '../../api/wiki/pages.ts';
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
});

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

describe('wiki pages summary filters', () => {
  it('can exclude drug monographs before paginating summary rows', async () => {
    const userId = await seedUser(db);
    await db.insert(wikiPages).values([
      {
        slug: 'morphine',
        title: 'Morphine',
        pageType: 'drug_monograph',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      },
      {
        slug: 'sedatives',
        title: 'Sedatives',
        pageType: 'topic',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      },
      {
        slug: 'about',
        title: 'About',
        pageType: 'article',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      },
    ]);

    const { res, state } = createResponse();
    await pagesHandler(
      createRequest(
        '/api/wiki/pages?view=summary&limit=10&excludePageType=drug_monograph',
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body) as {
      pages: Array<{ slug: string }>;
      hasMore: boolean;
    };
    expect(body.pages.map((page) => page.slug).sort()).toEqual([
      'about',
      'sedatives',
    ]);
    expect(body.hasMore).toBe(false);
  });
});
