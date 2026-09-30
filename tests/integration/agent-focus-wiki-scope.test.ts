/**
 * The admin focus config as a gate on **agent-authored wiki content**.
 *
 * The production complaint this closes: an admin set Agentfokus to "Bare
 * utvalgte parametere" and picked a couple of dozen parameter ids, and the
 * scheduled agents kept filing monograph facts on unrelated drugs anyway. Only
 * the parameter queues were ever narrowed — `agents/drug-db-maintainer.md` §3
 * said in so many words that the monograph action "is not parameter-scoped, so
 * [it] proceeds by popularity as usual" — so the admin's choice governed which
 * of several queues got filtered rather than what the agents were allowed to
 * write.
 *
 * These tests pin the gate at the door every agent-authored fact goes through
 * (`POST /api/pending-edits`), not just at the resolver, because a prompt is
 * advice a model can drift from and this is the thing that actually holds.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import { wikiContentFocusRefusal } from '../../api/agent-focus.js';
import handler from '../../api/pending-edits.js';
import {
  agentFocusConfig,
  agents,
  analyticalMethodComponents,
  analyticalMethods,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

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

async function seedAuthor(email = 'author@example.com'): Promise<number> {
  return await seedUser(db, { email, username: email.split('@')[0] });
}

/** A published monograph page for `drugId` (or a topic page when omitted). */
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

/** An active agent identity, plus the contributor user backing it. */
async function seedAgent(): Promise<number> {
  const userId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'maintainer-agent',
    role: 'contributor',
  });
  await db
    .insert(agents)
    .values({
      userId,
      name: 'Vedlikeholdsagent',
      slug: 'vedlikeholdsagent',
      status: 'active',
    });
  return userId;
}

describe('wikiContentFocusRefusal', () => {
  it('allows any page when no config row exists', async () => {
    const author = await seedAuthor();
    const page = await seedPage(author);
    expect(await wikiContentFocusRefusal(page)).toBeNull();
  });

  it('allows any page under mode=all', async () => {
    const author = await seedAuthor();
    const page = await seedPage(author);
    await db.insert(agentFocusConfig).values({ id: 1, mode: 'all' });
    expect(await wikiContentFocusRefusal(page)).toBeNull();
  });

  it('refuses every page under mode=parameters', async () => {
    // The bug this file exists for. A parameter focus is a statement about
    // what the agents may author, so there is no page — not even a monograph
    // of a drug carrying the selected parameters — that is in scope.
    const author = await seedAuthor();
    const drugId = await seedDrug(db, { slug: 'diazepam' });
    const monograph = await seedPage(author, {
      slug: 'diazepam',
      drugCid: drugId,
    });
    const topic = await seedPage(author, {
      slug: 'postmortal-redistribusjon',
      pageType: 'topic',
    });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'parameters', parameters: ['halfLife', 'logP'] });

    expect(await wikiContentFocusRefusal(monograph)).toMatch(/"parameters"/);
    expect(await wikiContentFocusRefusal(topic)).toMatch(/"parameters"/);
  });

  it('allows only the listed pages under mode=pages', async () => {
    const author = await seedAuthor();
    const inScope = await seedPage(author, { slug: 'in-scope' });
    const outOfScope = await seedPage(author, { slug: 'out-of-scope' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'pages', pageIds: [inScope] });

    expect(await wikiContentFocusRefusal(inScope)).toBeNull();
    expect(await wikiContentFocusRefusal(outOfScope)).toMatch(/"pages"/);
  });

  it('refuses everything when a pages focus lists nothing', async () => {
    // An empty selection stays empty, exactly as it does on the parameter
    // axis: widening it to the whole wiki would override an admin instruction
    // invisibly, since a populated queue looks like ordinary work.
    const author = await seedAuthor();
    const page = await seedPage(author);
    await db.insert(agentFocusConfig).values({ id: 1, mode: 'pages', pageIds: [] });

    expect(await wikiContentFocusRefusal(page)).toMatch(/"pages"/);
  });

  it('allows only monographs of method components under mode=methods', async () => {
    const author = await seedAuthor();
    const component = await seedDrug(db, { slug: 'kokain' });
    const outsider = await seedDrug(db, { slug: 'koffein' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M1', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });

    const inScope = await seedPage(author, {
      slug: 'kokain',
      drugCid: component,
    });
    const outOfScope = await seedPage(author, {
      slug: 'koffein',
      drugCid: outsider,
    });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    expect(await wikiContentFocusRefusal(inScope)).toBeNull();
    expect(await wikiContentFocusRefusal(outOfScope)).toMatch(/"methods"/);
  });

  it('refuses a topic page that still carries a component drug link under mode=methods', async () => {
    // `drug_cid` outlives `page_type`: PUT /api/wiki/pages sets the two
    // independently, so a monograph converted to a topic article without
    // also clearing drugCid keeps pointing at its drug. Resolving the drug
    // alone would admit that topic page whenever the drug is a selected
    // method's component — topic content under a mode defined as
    // "components of these panels".
    const author = await seedAuthor();
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M1', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });

    const converted = await seedPage(author, {
      slug: 'kokain-i-rettstoksikologi',
      pageType: 'topic',
      drugCid: component,
    });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    expect(await wikiContentFocusRefusal(converted)).toMatch(/"methods"/);
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

function createJsonRequest(body: unknown): IncomingMessage {
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

function factBody(pageId: number, referenceId: number) {
  return {
    editType: 'wiki_fact',
    targetId: pageId,
    sectionId: 'pk',
    factOperation: 'add',
    factStatement:
      'Halveringstiden er 30–56 timer hos voksne etter peroral dosering.',
    referenceIds: [referenceId],
  };
}

async function submitFact(
  userId: number,
  role: string,
  pageId: number,
  referenceId: number,
) {
  authMock.mockResolvedValue({ userId, role });
  const { res, state } = createResponse();
  await handler(createJsonRequest(factBody(pageId, referenceId)), res);
  return state;
}

describe('POST /api/pending-edits — agent focus gate', () => {
  it('refuses an agent wiki_fact under mode=parameters', async () => {
    const author = await seedAuthor();
    const agentUserId = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'parameters', parameters: ['halfLife'] });

    const state = await submitFact(agentUserId, 'contributor', page, citationId);
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('lets the same submission past the gate under mode=all', async () => {
    // The control for the test above: everything else about the request is
    // identical, so clearing the gate here proves the 403 came from the focus
    // mode and not from some other invariant the fixture trips. It is asserted
    // as "not the focus refusal" rather than as a 201 because this test is
    // only about the focus-mode outcome — something else further down the
    // submission chain is free to reject the request for unrelated reasons.
    const author = await seedAuthor();
    const agentUserId = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    await db.insert(agentFocusConfig).values({ id: 1, mode: 'all' });

    const state = await submitFact(agentUserId, 'contributor', page, citationId);
    expect(state.body).not.toContain('agent_focus_out_of_scope');
    expect(state.statusCode).not.toBe(403);
  });

  it('refuses an agent wiki_fact when skipWikiContent is on under mode=all', async () => {
    // The switch has to hold at the door, not only in the resolver: the door
    // is the thing that actually stops a drifting routine, and `all` is the
    // mode that refuses nothing on its own — so this is the case where a gate
    // checked only inside the mode switch would let the fact straight through.
    const author = await seedAuthor();
    const agentUserId = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await submitFact(agentUserId, 'contributor', page, citationId);
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('does not refuse a human contributor when skipWikiContent is on', async () => {
    // Same boundary as the mode gate below: the switch narrows the AGENTS.
    // An editor who told the scheduled routines to stay off the monographs has
    // not told themselves to.
    const author = await seedAuthor();
    const human = await seedUser(db, {
      email: 'human2@example.com',
      username: 'human2',
      role: 'contributor',
    });
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await submitFact(human, 'contributor', page, citationId);
    expect(state.body).not.toContain('agent_focus_out_of_scope');
    expect(state.statusCode).not.toBe(403);
  });

  it('does not refuse a human contributor under mode=parameters', async () => {
    // Narrowing the *agents* has not narrowed the people. A human's
    // submission never sees this gate — it goes on to succeed or fail on the
    // ordinary wiki_fact rules while the agents are held to the focus set.
    const author = await seedAuthor();
    const human = await seedUser(db, {
      email: 'human@example.com',
      username: 'human',
      role: 'contributor',
    });
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'parameters', parameters: ['halfLife'] });

    const state = await submitFact(human, 'contributor', page, citationId);
    expect(state.body).not.toContain('agent_focus_out_of_scope');
    expect(state.statusCode).not.toBe(403);
  });
});

function pageBody(editType: 'wiki_page' | 'wiki_new', over: Record<string, unknown>) {
  return {
    editType,
    proposedValue: { title: 'Kokain', content: {} },
    ...over,
  };
}

/**
 * A whole-page submission from an agent identity whose role clears the
 * `wiki.page.submit` tier check.
 *
 * These edit types are admin-tier by DEFAULT, which is why the focus gate
 * originally covered only `wiki_fact` / `wiki_section`. But the capability
 * carries `floorTier: 'editor'`, so an admin may delegate it — and the guard
 * would then promise "agents author no wiki content" while an agent published
 * monographs through this door. The test drives the tier check with an
 * admin-role agent rather than by rewriting the permission matrix: the code
 * path past `callerCan` is the same however the caller cleared it, and that
 * path is what the gate has to cover.
 */
async function submitWholePage(
  userId: number,
  body: Record<string, unknown>,
) {
  authMock.mockResolvedValue({ userId, role: 'admin' });
  const { res, state } = createResponse();
  await handler(createJsonRequest(body), res);
  return state;
}

describe('POST /api/pending-edits — whole-page agent writes', () => {
  it('refuses an agent wiki_page while the switch is on', async () => {
    const author = await seedAuthor();
    const agentUserId = await seedAgent();
    const page = await seedPage(author);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await submitWholePage(
      agentUserId,
      pageBody('wiki_page', { targetId: page }),
    );
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('refuses an agent wiki_new while the switch is on', async () => {
    // `wiki_new` names no page — it proposes one — so the drug in
    // proposed_meta is all there is to judge by. With the switch on, no drug
    // makes it in scope.
    const agentUserId = await seedAgent();
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await submitWholePage(
      agentUserId,
      pageBody('wiki_new', { proposedMeta: { drugCid: drugId } }),
    );
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('refuses an agent wiki_new for a drug outside a methods focus', async () => {
    const agentUserId = await seedAgent();
    const outsider = await seedDrug(db, { slug: 'koffein' });
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M1', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const state = await submitWholePage(
      agentUserId,
      pageBody('wiki_new', { proposedMeta: { drugCid: outsider } }),
    );
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('refuses a topic page for an in-scope drug under a methods focus', async () => {
    // Naming a component drug is not enough. `applyApprovedEdit` reads
    // `meta.pageType` for the page it creates, so a wiki_new carrying an
    // in-scope drugCid AND `pageType: "topic"` would publish a topic article
    // under a mode that permits only that component's monograph — the drug
    // makes it look in scope while the page that lands is not.
    const agentUserId = await seedAgent();
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M2', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const state = await submitWholePage(
      agentUserId,
      pageBody('wiki_new', {
        proposedMeta: { drugCid: component, pageType: 'topic' },
      }),
    );
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('refuses a wiki_new that names no page type at all', async () => {
    // The default matters: `meta.pageType ?? 'topic'` is what the approval
    // path applies, so silence about the type is a topic page, not a
    // monograph, however the drug resolves.
    const agentUserId = await seedAgent();
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M3', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const state = await submitWholePage(
      agentUserId,
      pageBody('wiki_new', { proposedMeta: { drugCid: component } }),
    );
    expect(state.statusCode).toBe(403);
  });

  it("lets an agent wiki_new for an in-scope component's monograph past the gate", async () => {
    // The control: same request, same tier, a drug the focus names and the
    // page type the mode permits. Asserted as "not the focus refusal" rather
    // than as a 201 for the same reason as the wiki_fact control above — this
    // test is only about the focus-mode outcome.
    const agentUserId = await seedAgent();
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M2', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const state = await submitWholePage(
      agentUserId,
      pageBody('wiki_new', {
        proposedMeta: { drugCid: component, pageType: 'drug_monograph' },
      }),
    );
    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });

  it('does not refuse a human admin while the switch is on', async () => {
    const author = await seedAuthor();
    const page = await seedPage(author);
    const human = await seedUser(db, {
      email: 'wholepage@example.com',
      username: 'wholepage',
      role: 'admin',
    });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const state = await submitWholePage(
      human,
      pageBody('wiki_page', { targetId: page }),
    );
    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});

function createPatchRequest(id: number, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = `/api/pending-edits?id=${id}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

/** An open wiki_fact proposal already owned by `submittedBy`. */
async function seedOpenFact(
  submittedBy: number,
  pageId: number,
  referenceId: number,
): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: pageId,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Opprinnelig påstand fra før fokuset ble endret.',
      proposedValue: { type: 'fact', attrs: { factId: 'f1', referenceIds: [referenceId] } },
      referenceIds: [referenceId],
      status: 'returned',
      submittedBy,
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

/** An open `wiki_new` proposal for a drug monograph, owned by `submittedBy`. */
async function seedOpenNewMonograph(
  submittedBy: number,
  drugId: number,
): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_new',
      proposedValue: { title: 'Kokain', content: {} },
      proposedMeta: { drugCid: drugId, pageType: 'drug_monograph' },
      status: 'returned',
      submittedBy,
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

async function patchFact(userId: number, role: string, id: number, body: unknown) {
  authMock.mockResolvedValue({ userId, role });
  const { res, state } = createResponse();
  await handler(createPatchRequest(id, body), res);
  return state;
}

describe('PATCH /api/pending-edits — agent focus gate', () => {
  it('refuses an agent revising its own wiki_fact that focus has since closed', async () => {
    // The row predates the admin's focus change. Without the gate here the
    // agent could replace the statement and references outright — filing new
    // out-of-scope content through a row it already owns, while an identical
    // fresh submission is refused.
    const author = await seedAuthor();
    const agentUserId = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const editId = await seedOpenFact(agentUserId, page, citationId);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'parameters', parameters: ['halfLife'] });

    const state = await patchFact(agentUserId, 'contributor', editId, {
      status: 'pending',
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f1', referenceIds: [citationId] },
      },
    });
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('still lets the agent withdraw that edit', async () => {
    // Withdrawing is the outcome a closed focus wants: the gate must not trap
    // an out-of-scope proposal in the reviewers' queue with no way to retract
    // it. A status-only 'rejected' is an own-cancel, not a submitter update.
    const author = await seedAuthor();
    const agentUserId = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const editId = await seedOpenFact(agentUserId, page, citationId);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'parameters', parameters: ['halfLife'] });

    const state = await patchFact(agentUserId, 'contributor', editId, {
      status: 'rejected',
      rejectionReason: 'other',
      rejectionComment: 'Trukket: agentfokuset dekker ikke monografiinnhold.',
    });
    expect(state.statusCode).toBe(200);
  });
});

describe('PATCH /api/pending-edits — an explicit null proposedMeta', () => {
  it('judges the metadata the update will store, not the one it replaces', async () => {
    // The payload that separates the two readings. `proposedMeta: null` is an
    // explicit clear the write honours, so judging the stored bag — which here
    // names an in-scope component drug and its monograph — passes a resubmit
    // whose approval will read `meta.pageType ?? 'topic'` off the null and
    // publish a topic page the methods focus never admitted.
    const agentUserId = await seedAgent();
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M4', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });
    const editId = await seedOpenNewMonograph(agentUserId, component);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const state = await patchFact(agentUserId, 'admin', editId, {
      status: 'pending',
      proposedMeta: null,
    });

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_focus_out_of_scope',
    });
  });

  it('still lets an omitted proposedMeta ride on the stored one', async () => {
    // The control, and the reason `??` looked right: omitting the field leaves
    // the stored metadata in place, so the in-scope monograph it names is
    // exactly what the write will leave behind.
    const agentUserId = await seedAgent();
    const component = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M5', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: component });
    const editId = await seedOpenNewMonograph(agentUserId, component);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const state = await patchFact(agentUserId, 'admin', editId, {
      status: 'pending',
    });

    expect(state.body).not.toContain('agent_focus_out_of_scope');
  });
});
