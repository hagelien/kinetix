/**
 * POST /api/bio-entities (admin direct write) mints the entity and its
 * monograph under the Bioentiteter hub. An unusable hub page must refuse the
 * request before anything is committed, not after the entity is already saved.
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

const { failMonograph } = vi.hoisted(() => ({ failMonograph: { on: false } }));
vi.mock('../../api/_lib/monograph-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/monograph-helpers.js')>();
  return {
    ...actual,
    // Stands in for another admin demoting the hub after the preflight passed.
    ensureEntityMonograph: (...args: Parameters<typeof actual.ensureEntityMonograph>) => {
      if (failMonograph.on) throw new Error('hub became unusable');
      return actual.ensureEntityMonograph(...args);
    },
  };
});

import handler from '../../api/bio-entities.js';
import { bioEntities, wikiPages } from '../../db/schema.js';
import { ENTITY_HUB_SLUG } from '../../api/_lib/monograph-helpers.js';
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
  failMonograph.on = false;
});

async function createEntity(userId: number) {
  authMock.mockResolvedValue({ userId, role: 'admin' });
  const raw = JSON.stringify({ symbol: 'CYP2D6', name: 'Cytokrom P450 2D6' });
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/bio-entities';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
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
  await handler(req, res).catch((err) => {
    state.statusCode = 500;
    state.body = String(err);
  });
  return state;
}

describe('POST /api/bio-entities with an unusable hub page', () => {
  it('leaves no entity behind when the hub is a draft', async () => {
    const userId = await seedUser(db);
    await db.insert(wikiPages).values({
      slug: ENTITY_HUB_SLUG,
      title: 'Bioentiteter',
      pageType: 'topic',
      status: 'draft',
      createdBy: userId,
      updatedBy: userId,
    });

    const state = await createEntity(userId);

    expect(state.statusCode).toBe(500);
    expect(await db.select().from(bioEntities)).toHaveLength(0);
  });

  it('creates the entity and its monograph under a published hub', async () => {
    const userId = await seedUser(db);

    const state = await createEntity(userId);

    expect(state.statusCode).toBe(201);
    expect(await db.select().from(bioEntities)).toHaveLength(1);
    const [hub] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, ENTITY_HUB_SLUG));
    const children = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.parentId, hub!.id));
    expect(children).toHaveLength(1);
  });

  it('rolls the entity back when the monograph step fails after the preflight', async () => {
    const userId = await seedUser(db);
    failMonograph.on = true;

    const state = await createEntity(userId);

    expect(state.statusCode).toBe(500);
    expect(await db.select().from(bioEntities)).toHaveLength(0);
  });
});
