/**
 * DELETE /api/wiki/pages removes a page together with everything that hangs
 * off it. Revisions, categories and fact discussions cascade on their foreign
 * keys; the rows that point at the page by a plain integer — wiki-scoped
 * pending edits, sub-pages' parent_id and the agent-focus page selection —
 * are cleaned up by the handler and checked here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import handler from '../../api/wiki/pages.js';
import {
  agentFocusConfig,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedDrug, seedUser } from './setup/seed.js';

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

async function seedPage(
  authorId: number,
  over: Partial<typeof wikiPages.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(wikiPages)
    .values({
      slug: 'sedativer',
      title: 'Sedativer',
      content: {},
      pageType: 'topic',
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
      ...over,
    })
    .returning({ id: wikiPages.id });
  return row!.id;
}

async function callDelete(slug: string, role = 'admin') {
  const req = {
    method: 'DELETE',
    url: `/api/wiki/pages?slug=${slug}`,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;
  authMock.mockResolvedValue({ userId: 1, role });
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
  return state;
}

describe('DELETE /api/wiki/pages', () => {
  it('removes the page with its revisions, proposals and references to it', async () => {
    const userId = await seedUser(db);
    const pageId = await seedPage(userId);
    const otherId = await seedPage(userId, { slug: 'opioider', title: 'Opioider' });
    const childId = await seedPage(userId, {
      slug: 'benzodiazepiner',
      title: 'Benzodiazepiner',
      parentId: pageId,
    });
    await db.insert(wikiRevisions).values({
      pageId,
      content: {},
      createdBy: userId,
    });
    await db.insert(pendingEdits).values([
      { editType: 'wiki_fact', targetId: pageId, proposedValue: {}, submittedBy: userId },
      { editType: 'wiki_section', targetId: pageId, proposedValue: {}, submittedBy: userId },
      { editType: 'wiki_page', targetId: pageId, proposedValue: {}, submittedBy: userId },
      // Same number, but a drug-scoped type: its target is a drugs.id.
      { editType: 'parameter', targetId: pageId, proposedValue: {}, submittedBy: userId },
      { editType: 'wiki_fact', targetId: otherId, proposedValue: {}, submittedBy: userId },
    ]);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'pages', pageIds: [pageId, otherId] });

    const state = await callDelete('sedativer');

    expect(state.statusCode).toBe(200);
    const pages = await db.select({ id: wikiPages.id }).from(wikiPages);
    expect(pages.map((p) => p.id).sort()).toEqual([otherId, childId].sort());
    expect(await db.select().from(wikiRevisions)).toHaveLength(0);
    const edits = await db
      .select({ editType: pendingEdits.editType, targetId: pendingEdits.targetId })
      .from(pendingEdits);
    expect(edits).toHaveLength(2);
    expect(edits).toEqual(
      expect.arrayContaining([
        { editType: 'parameter', targetId: pageId },
        { editType: 'wiki_fact', targetId: otherId },
      ]),
    );
    const [child] = await db
      .select({ parentId: wikiPages.parentId })
      .from(wikiPages)
      .where(eq(wikiPages.id, childId));
    expect(child!.parentId).toBeNull();
    const [focus] = await db.select().from(agentFocusConfig);
    expect(focus!.pageIds).toEqual([otherId]);
  });

  it('refuses a drug monograph while its drug exists', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await seedPage(userId, {
      slug: 'kokain',
      title: 'Kokain',
      pageType: 'drug_monograph',
      drugCid: drugId,
    });

    const state = await callDelete('kokain');

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'monograph_owned_by_record',
    });
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });

  it('deletes a drug monograph whose drug is gone', async () => {
    const userId = await seedUser(db);
    await seedPage(userId, {
      slug: 'kokain',
      title: 'Kokain',
      pageType: 'drug_monograph',
      drugCid: 999_999,
    });

    const state = await callDelete('kokain');

    expect(state.statusCode).toBe(200);
    expect(await db.select().from(wikiPages)).toHaveLength(0);
  });

  it('refuses a bio-entity monograph while its entity exists', async () => {
    const userId = await seedUser(db);
    const entityId = await seedBioEntity(db);
    await seedPage(userId, {
      slug: 'cyp2d6',
      title: 'CYP2D6',
      pageType: 'entity_monograph',
      entityId,
    });

    const state = await callDelete('cyp2d6');

    expect(state.statusCode).toBe(409);
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });

  it('refuses a caller without the delete capability', async () => {
    const userId = await seedUser(db);
    await seedPage(userId);

    const state = await callDelete('sedativer', 'contributor');

    expect(state.statusCode).toBe(403);
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });
});
