/**
 * The agent-focus gate on conversation ingestion — the third door into wiki
 * content.
 *
 * `POST /api/conversation-ingestion` is an admin route, but
 * `admin.conversationIngestion.run` carries `floorTier: 'editor'` in
 * `src/lib/permissions.ts` exactly like the whole-page capabilities. Delegate
 * it, run an editor-tier agent identity through it, and the run inserts
 * `wiki_pages` and `wiki_revisions` directly and files `pending_edits` — while
 * the focus config says the agents write no wiki content at all. A guarantee
 * that stops holding the day someone adjusts the permission matrix is not a
 * guarantee, so this door is gated with the others.
 *
 * The refusal is a per-item SKIP rather than a failed run: the admin gets a
 * receipt naming what did not apply and why, which is the same shape every
 * other ingestion refusal takes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentFocusConfig,
  agents,
  analyticalMethodComponents,
  analyticalMethods,
  citations,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import { parseConversationIngestion } from '../../src/lib/conversationIngestion.js';
import { applyIngestion } from '../../api/_lib/conversationIngestionStore.js';
import { ensureDrugMonograph } from '../../api/_lib/monograph-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let humanId: number;
let agentUserId: number;
let drugId: number;
let monographId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  humanId = await seedUser(db, {
    email: 'ingest@example.com',
    username: 'ingester',
    role: 'admin',
  });
  // An agent identity that clears the capability tier. The path past
  // `callerCan` is the same however the caller cleared it, and that path is
  // what the gate has to cover.
  agentUserId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'maintainer-agent',
    role: 'admin',
  });
  await db.insert(agents).values({
    userId: agentUserId,
    name: 'Vedlikeholdsagent',
    slug: 'vedlikeholdsagent',
    status: 'active',
  });
  drugId = await seedDrug(db, {
    slug: 'morfin',
    names: { nb: 'Morfin', en: 'Morphine' },
    pubchemCid: 5288826,
    searchKey: 'morfin\tmorphine',
  });
  const ensured = await ensureDrugMonograph(
    db as never,
    { id: drugId, names: { nb: 'Morfin', en: 'Morphine' }, pubchemCid: 5288826 },
    humanId,
  );
  monographId = ensured.page.id;
});

const BUNDLE = {
  schemaVersion: 'kinetix-conversation-ingestion-v1',
  idempotencyKey: 'conv-focus-01',
  mode: 'auto',
  conversationDigest: 'b'.repeat(64),
  createdAt: '2026-09-22T09:12:00Z',
  sources: [
    {
      key: 'S1',
      type: 'pmid',
      identifier: '10201674',
      verification: {
        readInFull: true,
        locator: 'Results',
        evidenceSummary: 'Cardiac/peripheral ratio varies with decomposition.',
        reviewMarkdown: 'Retrospective case series with paired sampling sites.',
      },
    },
  ],
  items: [
    {
      type: 'wiki_fact',
      target: {
        pageType: 'monograph',
        drug: { drugName: 'Morphine', pubchemCid: 5288826 },
        sectionId: 'forensic',
      },
      operation: 'add',
      statement: 'Forholdet varierer med forråtnelsesgrad.',
      sourceKeys: ['S1'],
      editSummary: 'Ny setning.',
    },
  ],
};

function parse(over: Record<string, unknown> = {}) {
  const parsed = parseConversationIngestion({ ...BUNDLE, ...over });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.data;
}

/** Nothing reached the page, the queue, or the citation table. */
async function assertNothingWritten() {
  expect(await db.select().from(pendingEdits)).toHaveLength(0);
  expect(await db.select().from(citations)).toHaveLength(0);
  const [page] = await db
    .select({ content: wikiPages.content })
    .from(wikiPages)
    .where(eq(wikiPages.id, monographId));
  expect(JSON.stringify(page!.content)).not.toContain('forråtnelsesgrad');
}

describe('conversation ingestion — agent focus gate', () => {
  it('skips an agent wiki item while the switch is on', async () => {
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const result = await applyIngestion(parse(), {
      userId: agentUserId,
      accept: [0],
    });

    expect(result.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'agent_focus_out_of_scope',
    });
    // Refused before a single source is written, like the digest check: an
    // item that did not apply must not leave a citation and a paper appraisal
    // published in the actor's name behind it.
    await assertNothingWritten();
  });

  it('skips an agent wiki item for a drug outside a methods focus', async () => {
    const other = await seedDrug(db, { slug: 'kokain' });
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M1', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId: other });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const result = await applyIngestion(parse({ idempotencyKey: 'conv-focus-02' }), {
      userId: agentUserId,
      accept: [0],
    });

    expect(result.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'agent_focus_out_of_scope',
    });
    await assertNothingWritten();
  });

  it('applies an agent wiki item the methods focus does name', async () => {
    // The control: same actor, same bundle, a focus whose components include
    // this monograph's drug.
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: 'M2', name: 'Screening' })
      .returning({ id: analyticalMethods.id });
    await db
      .insert(analyticalMethodComponents)
      .values({ methodId: method!.id, drugId });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'methods', methodIds: [method!.id] });

    const result = await applyIngestion(parse({ idempotencyKey: 'conv-focus-03' }), {
      userId: agentUserId,
      accept: [0],
    });

    expect(result.items[0]).not.toMatchObject({
      reason: 'agent_focus_out_of_scope',
    });
  });

  it('does not gate a human admin while the switch is on', async () => {
    // Narrowing the agents is not narrowing the people, on this door too.
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'all', skipWikiContent: true });

    const result = await applyIngestion(parse({ idempotencyKey: 'conv-focus-04' }), {
      userId: humanId,
      accept: [0],
    });

    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
  });
});
