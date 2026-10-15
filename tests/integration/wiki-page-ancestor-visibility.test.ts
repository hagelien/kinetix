/**
 * Breadcrumbs on a published wiki page do not name unpublished ancestors.
 *
 * A parent need not be published, so a published page can sit under a draft
 * one. The page read returned every ancestor's slug and title regardless of
 * status, to anonymous callers, in a response cached publicly at the edge.
 * Children were already limited to published pages; ancestors now are too
 * for a caller who may not read drafts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wikiPages } from '../../db/schema.js';
import handler from '../../api/wiki/pages.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;
let authorId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authorId = await seedUser(db);
});

async function seedPage(
  slug: string,
  status: 'published' | 'draft' | 'archived',
  parentId: number | null = null,
): Promise<number> {
  const [row] = await db
    .insert(wikiPages)
    .values({
      slug,
      title: `Title of ${slug}`,
      status,
      parentId,
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });
  return row!.id;
}

/** An anonymous GET (no auth cookie) of one page by slug. */
async function readPage(slug: string) {
  const req = {
    method: 'GET',
    url: `/api/wiki/pages?slug=${slug}`,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;
  const state = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (statusCode: number) => {
      state.statusCode = statusCode;
    },
    end: (body?: string) => {
      state.body = body ?? '';
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return {
    status: state.statusCode,
    body: JSON.parse(state.body) as {
      ancestors: Array<{ slug: string; title: string }>;
    },
  };
}

describe('wiki page breadcrumbs for an anonymous reader', () => {
  it('lists published ancestors', async () => {
    const root = await seedPage('root', 'published');
    await seedPage('child', 'published', root);

    const { status, body } = await readPage('child');

    expect(status).toBe(200);
    expect(body.ancestors.map((a) => a.slug)).toEqual(['root']);
  });

  it('leaves out draft and archived ancestors', async () => {
    const root = await seedPage('root', 'published');
    const secret = await seedPage('secret-draft', 'draft', root);
    const archived = await seedPage('old-archived', 'archived', secret);
    await seedPage('child', 'published', archived);

    const { status, body } = await readPage('child');

    expect(status).toBe(200);
    expect(body.ancestors.map((a) => a.slug)).toEqual(['root']);
    expect(JSON.stringify(body)).not.toContain('secret-draft');
    expect(JSON.stringify(body)).not.toContain('old-archived');
  });
});
