/**
 * The agent-focus gate on the OTHER door into wiki content: direct writes
 * through `/api/wiki/pages`, rather than proposals through `/api/pending-edits`.
 *
 * Both whole-page routes are admin-tier by default, which is why the gate
 * began life covering only agent `wiki_fact` / `wiki_section` submissions. But
 * `wiki.page.submit` and `edit.directWrite` each carry `floorTier: 'editor'`
 * in `src/lib/permissions.ts`, so an admin may delegate whole-page authoring —
 * and an agent identity at that tier would then create and edit monographs
 * here while the focus config says the agents write no wiki content at all. A
 * guarantee that holds only until someone adjusts the permission matrix is not
 * a guarantee, so the two doors are gated together.
 *
 * The tier check is driven with an admin-role agent rather than by rewriting
 * the permission matrix: the code path past `callerCan` is identical however
 * the caller cleared it, and that path is what the gate has to cover.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import handler from '../../api/wiki/pages.js';
import drugsHandler from '../../api/drugs.js';
import drugMergeHandler from '../../api/drug-merge.js';
import {
  agentFocusConfig,
  agents,
  analyticalMethodComponents,
  analyticalMethods,
  drugs,
  wikiPages,
} from '../../db/schema.js';
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

async function seedAgentUser(): Promise<number> {
  const userId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'maintainer-agent',
    role: 'admin',
  });
  await db.insert(agents).values({
    userId,
    name: 'Vedlikeholdsagent',
    slug: 'vedlikeholdsagent',
    status: 'active',
  });
  return userId;
}

async function seedPage(
  authorId: number,
  over: Partial<typeof wikiPages.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(wikiPages)
    .values({
      slug: over.slug ?? 'kokain',
      title: over.title ?? 'Kokain',
      content: over.content ?? {},
      pageType: over.pageType ?? 'drug_monograph',
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
      ...over,
    })
    .returning({ id: wikiPages.id });
  return row!.id;
}

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

async function call(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: unknown,
  userId: number,
) {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  authMock.mockResolvedValue({ userId, role: 'admin' });
  const { res, state } = createResponse();
  await handler(req, res);
  return state;
}

/** A one-component analytical method, returning `{ methodId, drugId }`. */
async function seedMethodWithComponent(): Promise<{
  methodId: number;
  drugId: number;
}> {
  const drugId = await seedDrug(db, { slug: 'kokain' });
  const [method] = await db
    .insert(analyticalMethods)
    .values({ code: 'M1', name: 'Screening' })
    .returning({ id: analyticalMethods.id });
  await db
    .insert(analyticalMethodComponents)
    .values({ methodId: method!.id, drugId });
  return { methodId: method!.id, drugId };
}

describe('POST /api/wiki/pages — agent focus gate', () => {
  it('refuses an agent creating a page while the switch is on', async () => {
    const agentUserId = await seedAgentUser();
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await call(
      'POST',
      '/api/wiki/pages',
      { title: 'Postmortal redistribusjon', content: {}, pageType: 'topic' },
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it("refuses a monograph for a drug the methods focus does not name", async () => {
    const agentUserId = await seedAgentUser();
    const { methodId } = await seedMethodWithComponent();
    const outsider = await seedDrug(db, { slug: 'koffein' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await call(
      'POST',
      '/api/wiki/pages',
      {
        title: 'Koffein',
        content: {},
        pageType: 'drug_monograph',
        drugCid: outsider,
      },
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('does not refuse a human admin while the switch is on', async () => {
    // Narrowing the agents is not narrowing the people, on this door as on
    // the other one.
    const human = await seedUser(db, {
      email: 'human@example.com',
      username: 'human',
      role: 'admin',
    });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await call(
      'POST',
      '/api/wiki/pages',
      { title: 'Postmortal redistribusjon', content: {}, pageType: 'topic' },
      human,
    );

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});

describe('PUT /api/wiki/pages — agent focus gate', () => {
  it('refuses an agent editing a page while the switch is on', async () => {
    // Ahead of both branches on purpose: the direct-write branch would publish
    // immediately, and the queued branch would file a proposal that the
    // pending-edit gate then has to refuse at approval time instead.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    await seedPage(author, { slug: 'kokain' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await call(
      'PUT',
      '/api/wiki/pages?slug=kokain',
      { title: 'Kokain', content: {} },
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('refuses converting an in-scope monograph into a topic page', async () => {
    // The before-picture is in scope and the after-picture is not. Judging the
    // current row alone makes an in-scope monograph a licence to publish
    // out-of-scope content: the direct-write branch applies `pageType` with
    // nothing further to check.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const { methodId, drugId } = await seedMethodWithComponent();
    await seedPage(author, { slug: 'kokain', drugCid: drugId });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await call(
      'PUT',
      '/api/wiki/pages?slug=kokain',
      { title: 'Kokain', content: {}, pageType: 'topic' },
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('refuses repointing an in-scope monograph at a drug outside the focus', async () => {
    // The other half of the same trick: keep the page type, move the drug.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const { methodId, drugId } = await seedMethodWithComponent();
    const outsider = await seedDrug(db, { slug: 'koffein' });
    await seedPage(author, { slug: 'kokain', drugCid: drugId });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await call(
      'PUT',
      '/api/wiki/pages?slug=kokain',
      { title: 'Kokain', content: {}, drugCid: outsider },
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('lets an in-scope monograph be edited without touching its identity', async () => {
    // The control for the two above: the same page, the same agent, a payload
    // that leaves `pageType` and `drugCid` alone. The after-check must not
    // turn an ordinary content edit into a refusal.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const { methodId, drugId } = await seedMethodWithComponent();
    await seedPage(author, { slug: 'kokain', drugCid: drugId });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await call(
      'PUT',
      '/api/wiki/pages?slug=kokain',
      { title: 'Kokain', content: {} },
      agentUserId,
    );

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });

  it('lets an agent edit a page the focus does name', async () => {
    // The control: same route, same tier, a page inside the focus set, so the
    // 403 above is the focus gate rather than some other invariant.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const page = await seedPage(author, { slug: 'kokain' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'pages', pageIds: [page] });

    const state = await call(
      'PUT',
      '/api/wiki/pages?slug=kokain',
      { title: 'Kokain', content: {} },
      agentUserId,
    );

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});

describe('DELETE /api/wiki/pages — agent focus gate', () => {
  it('refuses an agent deleting a page while the switch is on', async () => {
    // `wiki.page.delete` carries the same editor floor, and a deletion has no
    // undo: a gate that stops an agent adding a sentence while leaving it free
    // to remove the page is not closing the wiki action.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    await seedPage(author, { slug: 'kokain' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await call(
      'DELETE',
      '/api/wiki/pages?slug=kokain',
      null,
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });

  it('refuses an agent deleting a page outside a methods focus', async () => {
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const { methodId } = await seedMethodWithComponent();
    const outsider = await seedDrug(db, { slug: 'koffein' });
    await seedPage(author, { slug: 'koffein', drugCid: outsider });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await call(
      'DELETE',
      '/api/wiki/pages?slug=koffein',
      null,
      agentUserId,
    );

    expect(state.statusCode).toBe(403);
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });

  it('does not refuse a human admin while the switch is on', async () => {
    const author = await seedUser(db, { email: 'author@example.com' });
    const human = await seedUser(db, {
      email: 'human-delete@example.com',
      username: 'human-delete',
      role: 'admin',
    });
    await seedPage(author, { slug: 'kokain' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await call(
      'DELETE',
      '/api/wiki/pages?slug=kokain',
      null,
      human,
    );

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});

/** Drive `DELETE /api/drugs?id=` as the given user. */
async function deleteDrug(id: number, userId: number) {
  const req = Readable.from(['']) as IncomingMessage;
  req.method = 'DELETE';
  req.url = `/api/drugs?id=${id}`;
  req.headers = { host: 'localhost' };
  authMock.mockResolvedValue({ userId, role: 'admin' });
  const { res, state } = createResponse();
  await drugsHandler(req, res);
  return state;
}

describe('DELETE /api/drugs — agent focus gate on the monograph teardown', () => {
  it('refuses an agent deleting a drug whose monograph the switch protects', async () => {
    // The drug teardown deletes the monograph as a side effect, so this is
    // another door into wiki content — and `drug.delete` carries the same
    // editor floor. Gating the wiki route while leaving this open would close
    // the front door and label the side one.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await seedPage(author, { slug: 'kokain', drugCid: drugId });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await deleteDrug(drugId, agentUserId);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
    expect(await db.select().from(wikiPages)).toHaveLength(1);
    expect(await db.select().from(drugs)).toHaveLength(1);
  });

  it('refuses an agent deleting a drug outside a methods focus', async () => {
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const { methodId } = await seedMethodWithComponent();
    const outsider = await seedDrug(db, { slug: 'koffein' });
    await seedPage(author, { slug: 'koffein', drugCid: outsider });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await deleteDrug(outsider, agentUserId);

    expect(state.statusCode).toBe(403);
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });

  it('does not gate a drug that has no monograph', async () => {
    // The focus governs what agents may author, not the catalog. A drug with
    // no monograph takes no wiki content with it, so there is nothing for the
    // wiki gate to refuse.
    const agentUserId = await seedAgentUser();
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await deleteDrug(drugId, agentUserId);

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });

  it('does not gate a human admin while the switch is on', async () => {
    const author = await seedUser(db, { email: 'author@example.com' });
    const human = await seedUser(db, {
      email: 'human-drugdelete@example.com',
      username: 'human-drugdelete',
      role: 'admin',
    });
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await seedPage(author, { slug: 'kokain', drugCid: drugId });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await deleteDrug(drugId, human);

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});

/** Drive `POST /api/drug-merge` in apply mode as the given user. */
async function applyMerge(winnerId: number, loserId: number, userId: number) {
  const raw = JSON.stringify({
    action: 'apply',
    winnerId,
    loserId,
    planFingerprint: 'deadbeef',
  });
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/drug-merge';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  authMock.mockResolvedValue({ userId, role: 'admin' });
  const { res, state } = createResponse();
  await drugMergeHandler(req, res);
  return state;
}

describe('POST /api/drug-merge — agent focus gate on the monographs it folds', () => {
  it('refuses an agent merging while the switch is on', async () => {
    // A merge relinks the loser's monograph, deletes one of the two, and
    // rewrites page content and revisions. `drug.merge` carries the same
    // editor floor, so the fold is a wiki-content write like any other.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-duplikat' });
    await seedPage(author, { slug: 'kokain', drugCid: winner });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await applyMerge(winner, loser, agentUserId);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
    expect(await db.select().from(drugs)).toHaveLength(2);
    expect(await db.select().from(wikiPages)).toHaveLength(1);
  });

  it("refuses when only one side's monograph is in a methods focus", async () => {
    // Half a merge is not a thing this route can do: the fold touches both
    // monographs, so admitting one and not the other must refuse.
    const author = await seedUser(db, { email: 'author@example.com' });
    const agentUserId = await seedAgentUser();
    const { methodId, drugId: component } = await seedMethodWithComponent();
    const outsider = await seedDrug(db, { slug: 'koffein' });
    await seedPage(author, { slug: 'kokain', drugCid: component });
    await seedPage(author, { slug: 'koffein', drugCid: outsider });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [methodId] });

    const state = await applyMerge(component, outsider, agentUserId);

    expect(state.statusCode).toBe(403);
    expect(await db.select().from(drugs)).toHaveLength(2);
  });

  it('does not gate a human admin while the switch is on', async () => {
    const author = await seedUser(db, { email: 'author@example.com' });
    const human = await seedUser(db, {
      email: 'human-merge@example.com',
      username: 'human-merge',
      role: 'admin',
    });
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-duplikat' });
    await seedPage(author, { slug: 'kokain', drugCid: winner });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await applyMerge(winner, loser, human);

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});
