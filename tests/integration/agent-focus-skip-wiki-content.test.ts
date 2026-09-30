/**
 * `skip_wiki_content` — the mode-independent "parameters only" switch.
 *
 * The complaint behind it: an admin had scoped the scheduled agents to the
 * components of one analytical method and wanted those drugs' parameters
 * filled, but every cycle also produced a monograph fact waiting in the review
 * queue. The only existing way to silence the wiki action was
 * `mode = "parameters"`, which throws the drug axis away — the admin would have
 * had to give up the method scope to stop the prose.
 *
 * So the switch sits beside `mode` rather than being a fifth mode, and these
 * tests pin the three things that makes true:
 *
 *   1. it refuses agent wiki content under EVERY mode, not just one;
 *   2. it leaves the drug/parameter narrowing the mode set completely intact —
 *      losing that is the whole reason the switch exists;
 *   3. its stored value and the value the config REPORTS are allowed to differ
 *      under `mode = "parameters"` (which closes the action on its own), and
 *      the write path must never persist that derived answer as a setting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import focusHandler, {
  resolveFocusNarrowing,
  wikiContentFocusRefusal,
} from '../../api/agent-focus.js';
import {
  agentFocusConfig,
  analyticalMethodComponents,
  analyticalMethods,
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

async function seedPage(
  authorId: number,
  over: Partial<typeof wikiPages.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(wikiPages)
    .values({
      slug: over.slug ?? 'a-page',
      title: over.title ?? 'A page',
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

describe('wikiContentFocusRefusal — skipWikiContent', () => {
  it('refuses any page under mode=all when the switch is on', async () => {
    const author = await seedUser(db, { email: 'a@example.com' });
    const page = await seedPage(author);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    // The message names the switch, not a mode: under `all` there is no mode
    // to blame, and an agent told "focus is set to all" would read the refusal
    // as a bug rather than as the instruction it is.
    expect(await wikiContentFocusRefusal(page)).toMatch(/switched off/);
  });

  it('refuses a page that the pages focus itself lists', async () => {
    // The switch is not a second opinion the mode can overrule. A page inside
    // the focus set is exactly the case that would otherwise slip through.
    const author = await seedUser(db, { email: 'a@example.com' });
    const listed = await seedPage(author, { slug: 'listed' });
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'pages',
      pageIds: [listed],
      skipWikiContent: true,
    });

    expect(await wikiContentFocusRefusal(listed)).toMatch(/switched off/);
  });

  it("refuses a method component's own monograph under mode=methods", async () => {
    const author = await seedUser(db, { email: 'a@example.com' });
    const { methodId, drugId } = await seedMethodWithComponent();
    const monograph = await seedPage(author, {
      slug: 'kokain',
      drugCid: drugId,
    });
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: true,
    });

    expect(await wikiContentFocusRefusal(monograph)).toMatch(/switched off/);
  });

  it('leaves the method narrowing fully intact', async () => {
    // The point of the switch. `mode = "parameters"` would also silence the
    // wiki action, but it would take the method scope with it — the agents
    // would work the selected parameters across the whole catalogue instead of
    // the panel's components. Closing one action must not move the other.
    const { methodId, drugId } = await seedMethodWithComponent();
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'methods',
      methodIds: [methodId],
      parameters: ['halfLife'],
      methodsParametersOptIn: true,
      skipWikiContent: true,
    });

    await expect(resolveFocusNarrowing()).resolves.toEqual({
      parameters: ['halfLife'],
      drugIds: [drugId],
    });
  });

  it('changes nothing while it is off', async () => {
    const author = await seedUser(db, { email: 'a@example.com' });
    const page = await seedPage(author);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: false });

    expect(await wikiContentFocusRefusal(page)).toBeNull();
  });
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

function createRequest(method: 'GET' | 'PUT', body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = '/api/agent-focus';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

/** Drive the real route as an admin and return the config it answers with. */
async function callFocus(
  method: 'GET' | 'PUT',
  body?: unknown,
): Promise<{ statusCode: number; config: Record<string, unknown> }> {
  const adminId = await seedUser(db, {
    email: `admin-${method}-${Math.random()}@example.com`,
    username: `admin-${Math.random()}`,
    role: 'admin',
  });
  authMock.mockResolvedValue({ userId: adminId, role: 'admin' });
  const { res, state } = createResponse();
  await focusHandler(createRequest(method, body), res);
  const parsed = state.body ? JSON.parse(state.body) : {};
  return { statusCode: state.statusCode, config: parsed.config ?? parsed };
}

/** The raw stored column, bypassing the config's mode-aware reporting. */
async function storedSkipWikiContent(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ skipWikiContent: agentFocusConfig.skipWikiContent })
    .from(agentFocusConfig)
    .where(eq(agentFocusConfig.id, 1))
    .limit(1);
  return row?.skipWikiContent;
}

describe('PUT /api/agent-focus — skipWikiContent', () => {
  it('stores the switch alongside a method scope', async () => {
    const { methodId } = await seedMethodWithComponent();
    const { statusCode, config } = await callFocus('PUT', {
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: true,
    });

    expect(statusCode).toBe(200);
    expect(config).toMatchObject({
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: true,
    });
    await expect(storedSkipWikiContent()).resolves.toBe(true);
  });

  it('treats an absent switch as UNCHANGED, not as off', async () => {
    // A guard must not drop off a request that simply predates it. The arrays
    // above are the instruction itself and default to empty; this one is a
    // restriction an admin put in place, and a client old enough not to send
    // it is exactly the client that must not be able to lift it.
    const { methodId } = await seedMethodWithComponent();
    await callFocus('PUT', {
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: true,
    });

    const { config } = await callFocus('PUT', {
      mode: 'methods',
      methodIds: [methodId],
    });

    expect(config).toMatchObject({ skipWikiContent: true });
    await expect(storedSkipWikiContent()).resolves.toBe(true);
  });

  it('survives an unrelated scope change that omits it', async () => {
    // The realistic shape of the previous test: an admin (or an older client)
    // saving a DIFFERENT scope, with the switch nowhere in the payload. The
    // write leaves the column out of the statement entirely rather than
    // reading the old value and writing it back — a read-then-write would be
    // a lost update, reopening agent wiki authoring with another admin's tick
    // in the window between the two.
    const { methodId } = await seedMethodWithComponent();
    await callFocus('PUT', {
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: true,
    });

    const { config } = await callFocus('PUT', { mode: 'all' });

    expect(config).toMatchObject({
      mode: 'all',
      skipWikiContent: true,
      skipWikiContentSetting: true,
    });
    await expect(storedSkipWikiContent()).resolves.toBe(true);
  });

  it('defaults to off when the very first save omits it', async () => {
    // The insert branch: with no row yet there is nothing to preserve, and the
    // column's own DEFAULT answers. Off is the shipped, permissive status quo.
    const { config } = await callFocus('PUT', { mode: 'all' });

    expect(config).toMatchObject({
      skipWikiContent: false,
      skipWikiContentSetting: false,
    });
  });

  it('turns the switch off when an admin explicitly sends false', async () => {
    const { methodId } = await seedMethodWithComponent();
    await callFocus('PUT', {
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: true,
    });

    const { config } = await callFocus('PUT', {
      mode: 'methods',
      methodIds: [methodId],
      skipWikiContent: false,
    });

    expect(config).toMatchObject({ skipWikiContent: false });
    await expect(storedSkipWikiContent()).resolves.toBe(false);
  });

  it('reports the switch as on under mode=parameters without storing it', async () => {
    // Two halves of one rule, and the reason the response carries both fields.
    // An agent reading the config under a parameter focus must see
    // `skipWikiContent: true`, because every wiki write will be refused —
    // reporting the stored `false` would have it survey a monograph it cannot
    // file against. But the SETTING is still off, and saying so is what lets
    // the admin form show the implication without adopting it: persisting that
    // derived answer would turn a mode's implication into a stored setting.
    const { config } = await callFocus('PUT', {
      mode: 'parameters',
      parameters: ['halfLife'],
      skipWikiContent: false,
    });

    expect(config).toMatchObject({
      mode: 'parameters',
      skipWikiContent: true,
      skipWikiContentSetting: false,
    });
    await expect(storedSkipWikiContent()).resolves.toBe(false);

    const { config: after } = await callFocus('PUT', {
      mode: 'all',
      skipWikiContent: false,
    });
    expect(after).toMatchObject({ mode: 'all', skipWikiContent: false });
  });

  it('keeps a stored switch reported as a setting under mode=parameters', async () => {
    // The other half: a switch that IS on, under the mode that would imply it
    // anyway. The effective answer and the setting agree here, and the setting
    // is what the form needs — without it the form could not tell this row
    // from the one above, and the next save under another mode would write
    // back a guess. A guard a mode switch can drop is not a guard.
    const { config } = await callFocus('PUT', {
      mode: 'parameters',
      parameters: ['halfLife'],
      skipWikiContent: true,
    });

    expect(config).toMatchObject({
      skipWikiContent: true,
      skipWikiContentSetting: true,
    });

    const { config: after } = await callFocus('PUT', { mode: 'methods' });
    expect(after).toMatchObject({
      mode: 'methods',
      skipWikiContent: true,
      skipWikiContentSetting: true,
    });
  });
});
