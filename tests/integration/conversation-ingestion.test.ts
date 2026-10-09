/**
 * Conversation ingestion against a real (PGlite) database.
 *
 * The unit suite mocks `db.js`, which is precisely the wrong harness for this
 * feature: the whole point of the per-item gate is what it reports about LIVE
 * data, and every write it performs goes through machinery (fact splicing,
 * revision writing, aggregate recompute, duplicate detection) that only exists
 * in SQL. So the plan/apply cycle is exercised end to end here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  citations,
  drugs,
  drugParameters,
  paperReviews,
  parameterEntries,
  pendingEdits,
  wikiCategories,
  wikiPageCategories,
  wikiPages,
  wikiRevisions,
} from '../../db/schema.js';
import { parseConversationIngestion } from '../../src/lib/conversationIngestion.js';
import { renderHtml } from '../../api/_lib/tiptap-utils.js';
import {
  applyIngestion,
  planIngestion,
  liveFactVerdict,
  CONVERSATION_ENTRY_ORIGIN,
} from '../../api/_lib/conversationIngestionStore.js';
import { ensureDrugMonograph } from '../../api/_lib/monograph-helpers.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;
let monographId: number;

const DIGEST = 'a'.repeat(64);

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db, {
    email: 'ingest@example.com',
    username: 'ingester',
    role: 'admin',
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
    userId,
  );
  monographId = ensured.page.id;
});

function source(key: string, pmid: string) {
  return {
    key,
    type: 'pmid' as const,
    identifier: pmid,
    metadata: { title: `Paper ${pmid}`, year: 1989 },
    verification: {
      readInFull: true,
      locator: 'Table 2, p. 501',
      evidenceSummary: 'Absolute oral bioavailability was 23.9% in six volunteers.',
      reviewMarkdown: 'Crossover study with an intravenous reference arm.',
      reviewConfidence: 'medium' as const,
      overallScore: 68,
    },
    pdfRequestNeeded: false,
  };
}

function bundle(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'kinetix-conversation-ingestion-v1',
    idempotencyKey: 'conv-test-01',
    mode: 'auto',
    conversationDigest: DIGEST,
    createdAt: '2026-08-06T09:12:00Z',
    sources: [source('S1', '2719903'), source('S2', '10201674')],
    items: [
      {
        type: 'parameter_observation',
        target: { drugName: 'Morphine', pubchemCid: 5288826 },
        parameter: 'bioavailability',
        low: 0.2,
        high: 0.4,
        median: 0.239,
        unit: 'fraction',
        n: 6,
        sourceKey: 'S1',
        context: { route: 'oral', derivation: { kind: 'reported' } },
        editSummary: 'Absolute oral bioavailability, six healthy volunteers.',
      },
      {
        type: 'wiki_fact',
        target: {
          pageType: 'monograph',
          drug: { drugName: 'Morphine', pubchemCid: 5288826 },
          sectionId: 'forensic',
        },
        operation: 'add',
        statement:
          'Forholdet mellom morfin i hjerteblod og perifert blod varierer med forråtnelsesgrad.',
        sourceKeys: ['S2'],
        editSummary: 'Ny setning om C/P-forholdet for morfin.',
      },
    ],
    ...over,
  };
}

function parse(raw: unknown) {
  const parsed = parseConversationIngestion(raw);
  if (!parsed.ok) throw new Error(`bundle did not validate: ${parsed.errors.join('; ')}`);
  return parsed.data;
}

describe('conversation ingestion — plan', () => {
  it('reports both items ready and writes nothing', async () => {
    const plan = await planIngestion(parse(bundle()));

    expect(plan.counts).toEqual({ ready: 2, review: 0, duplicate: 0, blocked: 0 });
    expect(plan.items[0]).toMatchObject({
      type: 'parameter_observation',
      disposition: 'ready',
      drugId,
      parameter: 'bioavailability',
      current: null,
    });
    expect(plan.items[1]).toMatchObject({
      type: 'wiki_fact',
      disposition: 'ready',
      pageId: monographId,
      sectionId: 'forensic',
      sectionFactCount: 0,
    });
    // Both sources are new, so both would be minted — and nothing was.
    expect(plan.sources.map((s) => s.citationAction)).toEqual(['create', 'create']);
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(parameterEntries)).toHaveLength(0);
  });

  it('blocks an item whose drug cannot be resolved', async () => {
    const doc = bundle({
      items: [
        {
          ...bundle().items[0],
          target: { drugName: 'Notadrug', pubchemCid: 999999 },
        },
      ],
    });
    const plan = await planIngestion(parse(doc));

    expect(plan.items[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'drug_not_found',
    });
  });

  it('blocks a topic fact whose section is not on the page', async () => {
    // Monograph section ids are a fixed list the bundle parser already checks;
    // a topic page's sections are minted into its own headings, so only the
    // live page can say whether the heading the conversation aimed at exists.
    await db.insert(wikiPages).values({
      slug: 'temaside',
      title: 'Temaside',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2, sectionId: 'bakgrunn' },
            content: [{ type: 'text', text: 'Bakgrunn' }],
          },
        ],
      } as never,
      pageType: 'topic',
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });

    const doc = bundle({
      items: [
        {
          ...bundle().items[1],
          target: {
            pageType: 'topic',
            pageSlug: 'temaside',
            sectionId: 'ingen-seksjon',
          },
        },
      ],
    });
    const plan = await planIngestion(parse(doc));

    expect(plan.items[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'section_not_found',
      detail: 'ingen-seksjon',
    });
  });
});

describe('conversation ingestion — apply', () => {
  it('writes only the accepted items', async () => {
    const doc = parse(bundle());
    const result = await applyIngestion(doc, { userId, accept: [0] });

    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
    expect(result.items[1]).toMatchObject({ status: 'skipped', reason: 'not_accepted' });

    const entries = await db.select().from(parameterEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      drugId,
      parameter: 'bioavailability',
      origin: CONVERSATION_ENTRY_ORIGIN,
    });
    // The study context is written to its own column (#1257), not folded into
    // curator commentary.
    expect(entries[0]!.observationContext).toContain('Administrasjonsvei: oral');
    expect(entries[0]!.observationContext).toContain('Table 2, p. 501');

    // Only the accepted item's source was touched: the declined fact's paper is
    // not on file, and its review was not written on the admin's behalf.
    const rows = await db.select().from(citations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).toBe('2719903');
    expect(await db.select().from(paperReviews)).toHaveLength(1);

    // The displayed value is the recomputed aggregate, not the raw reading.
    const [summary] = await db
      .select()
      .from(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, drugId),
          eq(drugParameters.parameter, 'bioavailability'),
        ),
      );
    expect(summary).toBeDefined();
  });

  it('splices an accepted fact into the monograph through the approval path', async () => {
    const doc = parse(bundle());
    const result = await applyIngestion(doc, { userId, accept: [1] });

    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const forensic = (page!.content as { sections?: Record<string, { body?: { content?: unknown[] } }> })
      .sections?.forensic;
    const facts = (forensic?.body?.content ?? []).filter(
      (n) => (n as { type?: string }).type === 'fact',
    );
    expect(facts).toHaveLength(1);

    // The fact went in as a pending edit the admin approved in the same call —
    // the audit trail says who accepted it, and the page carries a revision.
    const edits = await db.select().from(pendingEdits);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      editType: 'wiki_fact',
      status: 'approved',
      submittedBy: userId,
      reviewedBy: userId,
    });
    const revisions = await db
      .select()
      .from(wikiRevisions)
      .where(eq(wikiRevisions.pageId, monographId));
    expect(revisions.length).toBeGreaterThan(1);
  });

  it('refuses an accepted item the plan blocked', async () => {
    const doc = parse(
      bundle({
        items: [
          {
            ...bundle().items[0],
            target: { drugName: 'Notadrug', pubchemCid: 999999 },
          },
        ],
      }),
    );
    const result = await applyIngestion(doc, { userId, accept: [0] });

    expect(result.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'drug_not_found',
    });
    expect(await db.select().from(parameterEntries)).toHaveLength(0);
    // And its source was left alone: a paper filed and reviewed in the admin's
    // name, backing nothing, is not a harmless leftover.
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(paperReviews)).toHaveLength(0);
  });

  // The dedup identity deliberately ignores the source quote, so an item that
  // matches an existing row in every compared field may still carry the
  // sentence that row is missing. For a row written before migration 0119 this
  // is the only route by which it can acquire one, and dropping the item as
  // "already present" would make the duplicate check a barrier to the
  // enrichment it should permit.
  it('enriches an unquoted duplicate with the quote the bundle carries', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [0] });
    const [before] = await db.select().from(parameterEntries);
    expect(before!.sourceQuote).toBeNull();

    const quote = 'Absolute oral bioavailability averaged 23.9%.';
    const quoted = bundle();
    (quoted.items[0] as { quote?: string }).quote = quote;

    const replan = await planIngestion(parse(quoted));
    // Not a duplicate: it has something to add. (The bundle's second item is a
    // wiki fact this test never applied, so it is `ready` too — hence the
    // assertion is on the observation itself rather than the counts.)
    expect(replan.items[0]).toMatchObject({ disposition: 'ready' });

    await applyIngestion(parse(quoted), { userId, accept: [0] });
    const rows = await db.select().from(parameterEntries);
    // Enriched in place — still one observation, not two.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceQuote).toBe(quote);
  });

  // A race: another request fills the quote between the admin reading the card
  // and the apply running. Apply re-plans each item under the citations it has
  // just committed, so the common case is caught there — the row now has a
  // quote, the item has nothing to add, and it is reported as the duplicate it
  // has become. What matters is that the receipt never claims `applied` for a
  // write that did not happen, and that the sentence already stored is never
  // clobbered. (The narrower window between that re-plan and the write is
  // guarded inside `attachSourceQuoteIfMissing`, tested at the store.)
  it('reports a duplicate, not an apply, when another quote won the race', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [0] });
    const [row] = await db.select().from(parameterEntries);

    const quoted = bundle();
    (quoted.items[0] as { quote?: string }).quote =
      'Absolute oral bioavailability averaged 23.9%.';
    // Before the admin's acceptance is applied, it had something to add.
    expect((await planIngestion(parse(quoted))).items[0]).toMatchObject({
      disposition: 'ready',
    });

    // Somebody else gets there first, with a different sentence.
    await db
      .update(parameterEntries)
      .set({ sourceQuote: 'A different reading of the same table.' })
      .where(eq(parameterEntries.id, row!.id));

    const result = await applyIngestion(parse(quoted), { userId, accept: [0] });
    expect(result.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'entry_exists',
    });
    expect(result.counts).toMatchObject({ applied: 0 });
    // And the sentence that was there is still there — never clobbered.
    const [after] = await db.select().from(parameterEntries);
    expect(after!.sourceQuote).toBe('A different reading of the same table.');
  });

  // `n` sits outside the dedup identity on purpose — two readings of one
  // number from one paper are one observation whatever cohort size is recorded
  // — but it is inside what a quote attests to, and it weights the row in the
  // pooled aggregate. Attaching "in 24 subjects" to a row filed as n=6 would be
  // a fabricated attribution of exactly the kind this field exists to expose,
  // and the admin card shows the INCOMING sample size, so nothing on screen
  // would give it away.
  it('withholds the quote when the item reports a different sample size', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [0] });
    const [row] = await db.select().from(parameterEntries);
    expect(row!.sourceQuote).toBeNull();
    expect(row!.n).toBe(6);

    const corrected = bundle();
    (corrected.items[0] as { quote?: string; n?: number }).quote =
      'In 24 subjects, absolute oral bioavailability averaged 23.9%.';
    (corrected.items[0] as { n?: number }).n = 24;

    const replan = await planIngestion(parse(corrected));
    expect(replan.items[0]).toMatchObject({
      disposition: 'duplicate',
      reason: 'entry_observation_mismatch',
    });

    const result = await applyIngestion(parse(corrected), {
      userId,
      accept: [0],
    });
    expect(result.counts).toMatchObject({ applied: 0 });
    // The row is untouched: no sentence about 24 subjects on a row of 6, and
    // the ingestion never rewrites what an existing row already asserts.
    const [after] = await db.select().from(parameterEntries);
    expect(after!.sourceQuote).toBeNull();
    expect(after!.n).toBe(6);
  });

  // Attaching a quote is a direct write to `parameter_entries`, so it owes the
  // review queue what every other direct writer owes it. Without the marking a
  // contributor's pending update stays approvable and can clear or replace the
  // sentence the admin just reviewed — and nothing warns the reviewer, because
  // the proposal's review token covers the PROPOSAL, and only the live entry
  // moved.
  it('conflicts a pending proposal against the row it quotes', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [0] });
    const [row] = await db.select().from(parameterEntries);

    const [proposal] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: row!.id,
        parameter: 'bioavailability',
        proposedValue: {
          op: 'update',
          patch: { median: 0.239, unit: 'fraction', comments: 'Typo fixed.' },
        } as never,
        status: 'pending',
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });

    const quoted = bundle();
    (quoted.items[0] as { quote?: string }).quote =
      'Absolute oral bioavailability averaged 23.9%.';
    const result = await applyIngestion(parse(quoted), { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 1 });

    const [after] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, proposal!.id));
    expect(
      (after!.proposedMeta as Record<string, unknown> | null)?.conflict,
    ).toBeTruthy();
  });

  // The study context is the same argument with the widest reach:
  // `contextComments` records dose, route, formulation and population —
  // everything that makes this reading a reading OF something — and none of it
  // is in the dedup identity either. A same-paper, same-number item for another
  // condition therefore matches, and attaching only its quote would file a
  // sentence about one condition against the row for another. The card shows
  // the INCOMING context, so the pairing looks coherent to the admin.
  it('withholds the quote when the study context differs', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [0] });
    const [row] = await db.select().from(parameterEntries);
    expect(row!.sourceQuote).toBeNull();

    const other = bundle();
    const item = other.items[0] as {
      quote?: string;
      context?: Record<string, unknown>;
    };
    item.quote = 'After a 30 mg dose, bioavailability averaged 23.9%.';
    item.context = { ...(item.context ?? {}), dose: '30 mg' };

    const replan = await planIngestion(parse(other));
    expect(replan.items[0]).toMatchObject({
      disposition: 'duplicate',
      reason: 'entry_observation_mismatch',
    });

    const result = await applyIngestion(parse(other), { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 0 });
    const [after] = await db.select().from(parameterEntries);
    expect(after!.sourceQuote).toBeNull();
  });

  it('still treats a duplicate that adds no quote as a duplicate', async () => {
    const quote = 'Absolute oral bioavailability averaged 23.9%.';
    const quoted = bundle();
    (quoted.items[0] as { quote?: string }).quote = quote;
    await applyIngestion(parse(quoted), { userId, accept: [0] });

    // Re-applying the same quoted bundle has nothing to add, and an item with
    // no quote at all never did.
    const replan = await planIngestion(parse(quoted));
    expect(replan.items[0]).toMatchObject({ reason: 'entry_exists' });
    const plain = await planIngestion(parse(bundle()));
    expect(plain.items[0]).toMatchObject({ reason: 'entry_exists' });

    // And the stored sentence was never replaced by the unquoted item.
    const rows = await db.select().from(parameterEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceQuote).toBe(quote);
  });

  it('is idempotent: re-applying the same bundle writes nothing further', async () => {
    const doc = parse(bundle());
    await applyIngestion(doc, { userId, accept: [0, 1] });

    const replan = await planIngestion(doc);
    expect(replan.counts).toMatchObject({ ready: 0, duplicate: 2 });
    expect(replan.items[0]).toMatchObject({ reason: 'entry_exists' });
    expect(replan.items[1]).toMatchObject({ reason: 'statement_exists' });

    const second = await applyIngestion(doc, { userId, accept: [0, 1] });
    expect(second.counts).toMatchObject({ applied: 0, failed: 0 });
    expect(await db.select().from(parameterEntries)).toHaveLength(1);
    const facts = await db.select().from(pendingEdits);
    expect(facts).toHaveLength(1);
  });

  it('keeps an existing read-in-full review rather than overwriting it', async () => {
    const [citation] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '2719903', createdBy: userId })
      .returning({ id: citations.id });
    await db.insert(paperReviews).values({
      citationId: citation!.id,
      reviewMarkdown: 'Human appraisal that must survive the import.',
      readInFull: true,
      createdBy: userId,
    });

    const doc = parse(bundle());
    const plan = await planIngestion(doc);
    expect(plan.sources[0]).toMatchObject({
      citationAction: 'reuse',
      reviewAction: 'keep',
    });

    await applyIngestion(doc, { userId, accept: [0] });
    const [review] = await db
      .select()
      .from(paperReviews)
      .where(eq(paperReviews.citationId, citation!.id));
    expect(review!.reviewMarkdown).toBe(
      'Human appraisal that must survive the import.',
    );
  });

  it('creates a proposed topic page with targetable sections', async () => {
    const doc = parse(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Postmortem redistribusjon',
            slug: 'postmortem-redistribusjon',
            categories: [],
            sections: [
              {
                sectionId: 'bakgrunn',
                titleNb: 'Bakgrunn',
                facts: [
                  {
                    statement:
                      'Postmortem redistribusjon endrer konsentrasjonen mellom sentrale og perifere prøvesteder.',
                    sourceKeys: ['S2'],
                  },
                ],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    const result = await applyIngestion(doc, { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });

    const [page] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'postmortem-redistribusjon'));
    expect(page).toBeDefined();
    expect(page!.pageType).toBe('topic');
    const content = page!.content as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> };
    const heading = content.content?.find((n) => n.type === 'heading');
    // A minted sectionId is what lets a later conversation add a fact here.
    expect(heading?.attrs?.sectionId).toBe('bakgrunn');

    // Re-planning the same proposal now reports the slug as taken rather than
    // creating a second page.
    const replan = await planIngestion(doc);
    expect(replan.items[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'slug_taken',
    });
  });
});

describe('conversation ingestion — identity and anchoring', () => {
  it('blocks a bundle whose drugId and PubChem CID name different drugs', async () => {
    const other = await seedDrug(db, {
      slug: 'kodein',
      names: { nb: 'Kodein', en: 'Codeine' },
      pubchemCid: 5284371,
      searchKey: 'kodein\tcodeine',
    });

    // The id points at codeine while the CID and name still say morphine —
    // exactly the shape a stale conversation produces, and the one where
    // accepting a row labelled "Morphine" would file the reading on codeine.
    const doc = parse(
      bundle({
        items: [
          {
            ...bundle().items[0],
            target: { drugId: other, drugName: 'Morphine', pubchemCid: 5288826 },
          },
        ],
      }),
    );
    const plan = await planIngestion(doc);
    expect(plan.items[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'drug_identity_conflict',
    });

    await applyIngestion(doc, { userId, accept: [0] });
    expect(await db.select().from(parameterEntries)).toHaveLength(0);
  });

  it('shows the resolved drug name, not the name the bundle claimed', async () => {
    const doc = parse(
      bundle({
        items: [
          {
            ...bundle().items[0],
            // Right substance by CID, stale label.
            target: { drugName: 'Morphinum', pubchemCid: 5288826 },
          },
        ],
      }),
    );
    const plan = await planIngestion(doc);
    expect(plan.items[0]).toMatchObject({
      disposition: 'ready',
      drugId,
      drugName: 'Morfin',
      targetName: 'Morphinum',
    });
    expect((plan.items[0] as { notes: string[] }).notes).toContain('drug_name_mismatch');
  });

  it('anchors a replace on where the fact actually is, not where the bundle looked', async () => {
    // Land a fact, then move it to another section behind the importer's back —
    // an editor reorganising a monograph does exactly this.
    const first = parse(bundle());
    await applyIngestion(first, { userId, accept: [1] });

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const content = page!.content as {
      sections: Record<string, { body?: { type: string; content: unknown[] } }>;
    };
    const node = content.sections.forensic!.body!.content[0] as {
      attrs: { factId: string };
    };
    const factId = node.attrs.factId;
    const moved = {
      ...content,
      sections: {
        ...content.sections,
        forensic: { body: { type: 'doc', content: [] } },
        pk: { body: { type: 'doc', content: [node] } },
      },
    };
    await db
      .update(wikiPages)
      .set({ content: moved as never, contentHtml: renderHtml(moved) })
      .where(eq(wikiPages.id, monographId));

    const replacement = parse(
      bundle({
        idempotencyKey: 'conv-test-02',
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'replace',
            factId,
            statement: 'Forholdet varierer også med administrasjonsvei.',
            sourceKeys: ['S2'],
            editSummary: 'Presisert setning.',
          },
        ],
      }),
    );

    const plan = await planIngestion(replacement);
    expect(plan.items[0]).toMatchObject({ disposition: 'ready' });
    expect((plan.items[0] as { notes: string[] }).notes).toContain('fact_moved_section');

    const result = await applyIngestion(replacement, { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });

    const [after] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const pk = (after!.content as {
      sections: Record<string, { body?: { content?: Array<{ content?: unknown }> } }>;
    }).sections.pk;
    expect(JSON.stringify(pk)).toContain('administrasjonsvei');
  });

  it('treats an already-applied replacement as a duplicate', async () => {
    const first = parse(bundle());
    await applyIngestion(first, { userId, accept: [1] });

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const factId = (
      (page!.content as {
        sections: Record<string, { body: { content: Array<{ attrs: { factId: string } }> } }>;
      }).sections.forensic.body.content[0]
    ).attrs.factId;

    const replacement = parse(
      bundle({
        idempotencyKey: 'conv-test-03',
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'replace',
            factId,
            statement: 'Presisert setning om C/P-forholdet.',
            sourceKeys: ['S2'],
            editSummary: 'Presisering.',
          },
        ],
      }),
    );

    const applied = await applyIngestion(replacement, { userId, accept: [0] });
    expect(applied.counts).toMatchObject({ applied: 1, failed: 0 });

    // Second run: the anchor still exists, but the stored statement and
    // citations already equal the proposal, so there is nothing to do.
    const replan = await planIngestion(replacement);
    expect(replan.items[0]).toMatchObject({
      disposition: 'duplicate',
      reason: 'statement_exists',
    });
    const again = await applyIngestion(replacement, { userId, accept: [0] });
    expect(again.counts).toMatchObject({ applied: 0 });
    const revisions = await db
      .select()
      .from(wikiRevisions)
      .where(eq(wikiRevisions.pageId, monographId));
    // Creation + the add + the replace. The re-apply added nothing.
    expect(revisions).toHaveLength(3);
  });

  it('does not write the same statement twice from one bundle', async () => {
    const doc = parse(
      bundle({
        items: [
          bundle().items[1],
          // The same statement again — a conversation that repeated itself.
          { ...bundle().items[1], editSummary: 'Duplikat i samme pakke.' },
        ],
      }),
    );

    const result = await applyIngestion(doc, { userId, accept: [0, 1] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
    expect(result.items[1]).toMatchObject({
      status: 'skipped',
      reason: 'statement_exists',
    });

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const facts = (
      (page!.content as {
        sections: Record<string, { body?: { content?: unknown[] } }>;
      }).sections.forensic?.body?.content ?? []
    ).filter((n) => (n as { type?: string }).type === 'fact');
    expect(facts).toHaveLength(1);
  });
});

describe('conversation ingestion — collision and concurrency', () => {
  it('does not adopt another drug\'s monograph when a CID collides with its id', async () => {
    // The classic Kinetix collision: this drug's PubChem CID is another drug's
    // internal id, so the other drug's modern monograph carries `drug_cid` =
    // our CID. Treating that as a legacy link would splice the fact into the
    // wrong drug's page.
    const other = await seedDrug(db, {
      slug: 'karbonmonoksid',
      names: { nb: 'Karbonmonoksid', en: 'Carbon monoxide' },
      searchKey: 'karbonmonoksid\tcarbon monoxide',
    });
    const collidingId = other;
    await ensureDrugMonograph(
      db as never,
      { id: other, names: { nb: 'Karbonmonoksid', en: 'Carbon monoxide' } },
      userId,
    );
    // A drug whose CID equals the other drug's id, and with no monograph of
    // its own.
    const orphan = await seedDrug(db, {
      slug: 'nbome',
      names: { nb: '25C-NBOMe', en: '25C-NBOMe' },
      pubchemCid: collidingId,
      searchKey: '25c-nbome',
    });

    const doc = parse(
      bundle({
        items: [
          {
            ...bundle().items[1],
            target: {
              pageType: 'monograph',
              drug: { drugName: '25C-NBOMe', pubchemCid: collidingId },
              sectionId: 'forensic',
            },
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    // No monograph of its own yet, so none is adopted: one is minted on apply.
    expect(plan.items[0]).toMatchObject({ disposition: 'ready', pageId: null });

    await applyIngestion(doc, { userId, accept: [0] });

    const pages = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.pageType, 'drug_monograph'));
    const orphanPage = pages.find((p) => p.drugCid === orphan);
    const otherPage = pages.find((p) => p.drugCid === other);
    expect(orphanPage).toBeDefined();
    // The fact landed on the drug it names, and the colliding page is untouched.
    expect(JSON.stringify(orphanPage!.content)).toContain('forr\u00e5tnelsesgrad');
    expect(JSON.stringify(otherPage!.content)).not.toContain('forr\u00e5tnelsesgrad');
  });

  it('does not double-insert an observation when two applies race', async () => {
    const doc = parse(bundle());
    // Both requests plan before either inserts. What this pins down is that the
    // duplicate decision is re-taken inside the write transaction rather than
    // trusted from the plan — PGlite is single-connection, so it cannot prove
    // the advisory lock resolves true contention, only that the re-check exists
    // and is what one of the two applies hits.
    const [first, second] = await Promise.all([
      applyIngestion(doc, { userId, accept: [0] }),
      applyIngestion(doc, { userId, accept: [0] }),
    ]);

    const applied =
      first.counts.applied + second.counts.applied;
    expect(applied).toBe(1);
    expect(await db.select().from(parameterEntries)).toHaveLength(1);
  });

  it('carries every proposed heading and statement into the plan', async () => {
    const doc = parse(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Postmortem redistribusjon',
            slug: 'postmortem-redistribusjon-2',
            categories: [],
            sections: [
              {
                sectionId: 'bakgrunn',
                titleNb: 'Bakgrunn',
                facts: [
                  { statement: 'F\u00f8rste p\u00e5stand.', sourceKeys: ['S2'] },
                  { statement: 'Andre p\u00e5stand.', sourceKeys: ['S1', 'S2'] },
                ],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    // The admin must be able to read what accepting this would publish, not
    // just how much of it there is.
    expect(plan.items[0]).toMatchObject({
      disposition: 'ready',
      sections: [
        {
          titleNb: 'Bakgrunn',
          facts: [
            { statement: 'F\u00f8rste p\u00e5stand.', sourceKeys: ['S2'] },
            { statement: 'Andre p\u00e5stand.', sourceKeys: ['S1', 'S2'] },
          ],
        },
      ],
    });
  });
});

describe('conversation ingestion — what the gate must disclose', () => {
  it('carries the appraisal that would be published, and what it replaces', async () => {
    const [citation] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '2719903', createdBy: userId })
      .returning({ id: citations.id });
    // An abstract-only review on file: not read-in-full, so the bundle's
    // appraisal would replace it — and the admin has to see both.
    await db.insert(paperReviews).values({
      citationId: citation!.id,
      reviewMarkdown: 'Abstract-only note that will be replaced.',
      readInFull: false,
      createdBy: userId,
    });

    const plan = await planIngestion(parse(bundle()));
    const s1 = plan.sources.find((s) => s.key === 'S1')!;
    expect(s1).toMatchObject({ citationAction: 'reuse', reviewAction: 'record' });
    expect(s1.review).toMatchObject({
      readInFull: true,
      locator: 'Table 2, p. 501',
    });
    expect(s1.review!.reviewMarkdown).toContain(
      'Crossover study with an intravenous reference arm.',
    );
    expect(s1.replacedReview).toMatchObject({
      readInFull: false,
      reviewMarkdown: 'Abstract-only note that will be replaced.',
    });

    // A source whose review would be kept discloses no proposed appraisal,
    // because none is written.
    const [other] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '10201674', createdBy: userId })
      .returning({ id: citations.id });
    await db.insert(paperReviews).values({
      citationId: other!.id,
      reviewMarkdown: 'Published read-in-full review.',
      readInFull: true,
      createdBy: userId,
    });
    const second = await planIngestion(parse(bundle()));
    const s2 = second.sources.find((s) => s.key === 'S2')!;
    // Nothing would be written today — but the appraisal is still disclosed,
    // because `keep` is a fact about the database now, not a promise: withdraw
    // that review before Apply and this is the text that would land.
    expect(s2).toMatchObject({ reviewAction: 'keep', replacedReview: null });
    expect(s2.review).not.toBeNull();
  });

  it('records no review for an item that turns out to be a duplicate', async () => {
    // Two accepted facts with the same statement but different sources. The
    // first lands; the second re-plans as a duplicate — and its source must not
    // be left reviewed in the admin's name, backing nothing.
    const doc = parse(
      bundle({
        items: [
          bundle().items[1],
          { ...bundle().items[1], sourceKeys: ['S1'], editSummary: 'Samme setning, annen kilde.' },
        ],
      }),
    );

    const result = await applyIngestion(doc, { userId, accept: [0, 1] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
    expect(result.items[1]).toMatchObject({
      status: 'skipped',
      reason: 'statement_exists',
    });

    const rows = await db.select().from(citations);
    expect(rows.map((r) => r.identifier)).toEqual(['10201674']);
    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(result.reviewsRecorded).toBe(1);
  });
});

describe('conversation ingestion — trust boundaries', () => {
  it('ignores the bundle\'s own alternate handles when resolving a paper', async () => {
    // A different paper, already on file under the DOI this bundle wrongly
    // claims for S1. Trusting the model's alias would resolve S1 onto it —
    // and `resolveCitation` may merge, repointing that paper's references and
    // reviews onto a citation it has nothing to do with.
    const [unrelated] = await db
      .insert(citations)
      .values({
        type: 'doi',
        identifier: '10.1111/j.1365-2125.1989.tb05399.x',
        createdBy: userId,
      })
      .returning({ id: citations.id });

    const doc = parse(
      bundle({
        sources: [
          {
            ...source('S1', '2719903'),
            altIds: { doi: '10.1111/j.1365-2125.1989.tb05399.x' },
          },
          source('S2', '10201674'),
        ],
      }),
    );

    // No crosswalk is passed, so nothing but the declared PMID is addressable.
    const plan = await planIngestion(doc);
    expect(plan.sources.find((s) => s.key === 'S1')).toMatchObject({
      citationAction: 'create',
    });

    await applyIngestion(doc, { userId, accept: [0] });
    const rows = await db.select().from(citations);
    const created = rows.find((r) => r.identifier === '2719903');
    expect(created).toBeDefined();
    expect(created!.id).not.toBe(unrelated!.id);
    // The unrelated paper is untouched — not merged, not re-filed.
    expect(rows.some((r) => r.id === unrelated!.id)).toBe(true);
  });

  it('uses a verified crosswalk to reuse the paper already on file', async () => {
    const [existing] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/verified', createdBy: userId })
      .returning({ id: citations.id });

    const doc = parse(bundle());
    const crosswalk = new Map([['S1', { doi: '10.1000/verified' }]]);

    const plan = await planIngestion(doc, { crosswalk });
    expect(plan.sources.find((s) => s.key === 'S1')).toMatchObject({
      citationAction: 'reuse',
      citationId: existing!.id,
    });

    const result = await applyIngestion(doc, { userId, accept: [0], crosswalk });
    expect(result.citationsCreated).toBe(0);
    const entries = await db.select().from(parameterEntries);
    expect(entries[0]!.citationId).toBe(existing!.id);
  });

  it('drops a parent that would push the wiki tree past its depth limit', async () => {
    // Build a chain down to the maximum nesting depth, then propose a page
    // under its deepest page.
    let parentId: number | null = null;
    let deepest = 0;
    for (let level = 0; level < 5; level += 1) {
      const [row] = await db
        .insert(wikiPages)
        .values({
          slug: `niva-${level}`,
          title: `Nivå ${level}`,
          content: { type: 'doc', content: [] } as never,
          pageType: 'topic',
          status: 'published',
          parentId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning({ id: wikiPages.id });
      parentId = row!.id;
      deepest = row!.id;
    }
    expect(deepest).toBeGreaterThan(0);

    const doc = parse(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'For dypt',
            slug: 'for-dypt',
            parentSlug: 'niva-4',
            categories: [],
            sections: [
              {
                sectionId: 'bakgrunn',
                titleNb: 'Bakgrunn',
                facts: [{ statement: 'En påstand.', sourceKeys: ['S2'] }],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    const notes = (plan.items[0] as { notes: string[] }).notes;
    // The page is still offered — only the illegal parent is dropped.
    expect(plan.items[0]).toMatchObject({ disposition: 'ready' });
    expect(notes).toContain('parent_invalid');

    await applyIngestion(doc, { userId, accept: [0] });
    const [created] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'for-dypt'));
    expect(created).toBeDefined();
    expect(created!.parentId).toBeNull();
  });
});

describe('conversation ingestion — failure containment and disclosure', () => {
  it('carries the exact stored study context into the plan', async () => {
    const plan = await planIngestion(parse(bundle()));
    const item = plan.items[0] as { comments: string | null };
    // The prose that will land in `parameter_entries.observationContext` is
    // scientific content the admin is publishing, so the gate must carry it
    // verbatim. This bundle's item carries no curator note of its own, so the
    // plan's (combined) preview and the stored (context-only) column agree
    // exactly.
    expect(item.comments).toContain('Administrasjonsvei: oral');
    expect(item.comments).toContain('Table 2, p. 501');

    await applyIngestion(parse(bundle()), { userId, accept: [0] });
    const [entry] = await db.select().from(parameterEntries);
    expect(entry!.observationContext).toBe(item.comments);
    expect(entry!.comments).toBeNull();
  });

  it('keeps a collision-suffixed section id inside the length limit', async () => {
    // Two sections whose headings slugify to the same 40-character id. The
    // fallback must mint a SHORTER base plus the suffix, not a 42-character id
    // the plan advertises and the page never carries.
    const heading = 'A'.repeat(40);
    const doc = parse(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Lange overskrifter',
            slug: 'lange-overskrifter',
            categories: [],
            sections: [
              {
                sectionId: 'x'.repeat(60), // malformed → falls back to minting
                titleNb: heading,
                facts: [{ statement: 'Første påstand.', sourceKeys: ['S2'] }],
              },
              {
                sectionId: 'y'.repeat(60),
                titleNb: heading,
                facts: [{ statement: 'Andre påstand.', sourceKeys: ['S2'] }],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    const shown = (plan.items[0] as { sections: Array<{ sectionId: string }> }).sections;
    for (const section of shown) {
      expect(section.sectionId.length).toBeLessThanOrEqual(40);
    }

    await applyIngestion(doc, { userId, accept: [0] });
    const [page] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'lange-overskrifter'));
    const published = (
      page!.content as { content: Array<{ type?: string; attrs?: Record<string, unknown> }> }
    ).content
      .filter((n) => n.type === 'heading')
      .map((n) => n.attrs?.sectionId);
    // What the gate advertised is what a later fact can anchor on.
    expect(published).toEqual(shown.map((s) => s.sectionId));
  });

  it('publishes a proposed topic page under the section ids it declared', async () => {
    const doc = parse(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Postmortem redistribusjon',
            slug: 'pm-redistribusjon',
            categories: [],
            sections: [
              {
                // Declared id differs from the slug of the Norwegian heading;
                // a later fact would anchor on THIS.
                sectionId: 'background',
                titleNb: 'Bakgrunn',
                facts: [{ statement: 'En påstand.', sourceKeys: ['S2'] }],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect((plan.items[0] as { sections: Array<{ sectionId: string }> }).sections[0]).
      toMatchObject({ sectionId: 'background' });

    await applyIngestion(doc, { userId, accept: [0] });
    const [page] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'pm-redistribusjon'));
    const heading = (
      page!.content as { content: Array<{ type?: string; attrs?: Record<string, unknown> }> }
    ).content.find((n) => n.type === 'heading');
    expect(heading?.attrs?.sectionId).toBe('background');
  });
});

describe('conversation ingestion — consent held to what was shown', () => {
  it('refuses an item whose source review turned from kept into recorded', async () => {
    // Analyse time: the paper carries a read-in-full review, so the gate says
    // `keep` and the admin accepts on that basis.
    const [citation] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '2719903', createdBy: userId })
      .returning({ id: citations.id });
    await db.insert(paperReviews).values({
      citationId: citation!.id,
      reviewMarkdown: 'Published read-in-full review.',
      readInFull: true,
      createdBy: userId,
    });

    const doc = parse(bundle());
    const plan = await planIngestion(doc);
    const shown = new Map(
      plan.sources.map((s) => [s.key, s.reviewAction] as const),
    );
    expect(shown.get('S1')).toBe('keep');

    // Between Analyse and Apply the review is withdrawn — which is exactly what
    // recording a replacement PDF does, to stop a wrong-paper upload
    // authorising facts.
    await db
      .update(paperReviews)
      .set({ readInFull: false })
      .where(eq(paperReviews.citationId, citation!.id));

    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedReviewActions: shown,
    });

    expect(result.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'source_review_changed',
    });
    // The withdrawn authorisation stays withdrawn, and no appraisal the admin
    // never saw was published.
    const [review] = await db
      .select()
      .from(paperReviews)
      .where(eq(paperReviews.citationId, citation!.id));
    expect(review!.readInFull).toBe(false);
    expect(review!.reviewMarkdown).toBe('Published read-in-full review.');
    expect(await db.select().from(parameterEntries)).toHaveLength(0);
  });

  it('applies normally when the shown disposition still holds', async () => {
    const doc = parse(bundle());
    const plan = await planIngestion(doc);
    const shown = new Map(plan.sources.map((s) => [s.key, s.reviewAction] as const));

    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedReviewActions: shown,
    });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
  });

  it('names the parent and the categories a page proposal would publish', async () => {
    await db.insert(wikiPages).values({
      slug: 'foreldre',
      title: 'Foreldreside',
      content: { type: 'doc', content: [] } as never,
      pageType: 'topic',
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });
    await db.insert(wikiCategories).values({ name: 'Forensisk toksikologi', slug: 'forensisk-toksikologi' });

    const doc = parse(
      bundle({
        items: [
          {
            type: 'topic_page_proposal',
            titleNb: 'Ny temaside',
            slug: 'ny-temaside',
            parentSlug: 'foreldre',
            categories: ['Forensisk toksikologi', 'Finnes Ikke'],
            sections: [
              {
                sectionId: 'bakgrunn',
                titleNb: 'Bakgrunn',
                facts: [{ statement: 'En påstand.', sourceKeys: ['S2'] }],
              },
            ],
            rationale: 'Ingen eksisterende side dekker temaet.',
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect(plan.items[0]).toMatchObject({
      disposition: 'ready',
      parent: { slug: 'foreldre', title: 'Foreldreside' },
      categories: { matched: ['Forensisk toksikologi'], dropped: ['Finnes Ikke'] },
    });

    await applyIngestion(doc, { userId, accept: [0] });
    const [created] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.slug, 'ny-temaside'));
    const links = await db
      .select()
      .from(wikiPageCategories)
      .where(eq(wikiPageCategories.pageId, created!.id));
    // What the gate promised is what landed.
    expect(created!.parentId).toBeDefined();
    expect(links).toHaveLength(1);
  });
});

describe('conversation ingestion — the row you agreed to', () => {
  it('refuses an item whose resolved target moved since the gate rendered it', async () => {
    // A name-only target: no CID, so identity rests on the alias index.
    const doc = parse(
      bundle({
        items: [
          { ...bundle().items[0], target: { drugName: 'Morphine' } },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect(plan.items[0]).toMatchObject({ disposition: 'ready', drugId });
    const shownPrints = new Map(
      plan.items.map((i) => [i.index, i.fingerprint] as const),
    );
    const shownReviews = new Map(
      plan.sources.map((s) => [s.key, s.reviewAction] as const),
    );

    // Someone moves the name to a different drug in the meantime, so the same
    // bundle now resolves elsewhere. The item stays perfectly applicable — to
    // the wrong substance, which is the whole danger.
    const other = await seedDrug(db, {
      slug: 'annet',
      names: { nb: 'Annet', en: 'Morphine' },
      searchKey: 'annet\tmorphine',
    });
    await db
      .update(drugs)
      .set({ names: { nb: 'Utgått', en: 'Retired' }, searchKey: 'utgatt\tretired' })
      .where(eq(drugs.id, drugId));

    const recheck = await planIngestion(doc);
    // Confirm the premise: it now resolves to the other drug, still `ready`.
    expect(recheck.items[0]).toMatchObject({ disposition: 'ready', drugId: other });

    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedReviewActions: shownReviews,
      expectedFingerprints: shownPrints,
    });

    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'item_changed' });
    expect(await db.select().from(parameterEntries)).toHaveLength(0);
  });

  it('refuses a replacement whose target text was rewritten since', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [1] });
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const node = (
      page!.content as {
        sections: Record<string, { body: { content: Array<{ attrs: { factId: string } }> } }>;
      }
    ).sections.forensic.body.content[0]!;
    const factId = node.attrs.factId;

    const replacement = parse(
      bundle({
        idempotencyKey: 'conv-test-fp',
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'replace',
            factId,
            statement: 'Presisert setning.',
            sourceKeys: ['S2'],
            editSummary: 'Presisering.',
          },
        ],
      }),
    );

    const plan = await planIngestion(replacement);
    const shownPrints = new Map(plan.items.map((i) => [i.index, i.fingerprint] as const));
    const shownReviews = new Map(
      plan.sources.map((s) => [s.key, s.reviewAction] as const),
    );

    // An editor rewrites the fact the admin was told would be replaced.
    const rewritten = JSON.parse(JSON.stringify(page!.content)) as {
      sections: Record<string, { body: { content: Array<{ content: unknown[] }> } }>;
    };
    rewritten.sections.forensic.body.content[0]!.content = [
      { type: 'paragraph', content: [{ type: 'text', text: 'Helt ny tekst.' }] },
    ];
    await db
      .update(wikiPages)
      .set({ content: rewritten as never })
      .where(eq(wikiPages.id, monographId));

    const result = await applyIngestion(replacement, {
      userId,
      accept: [0],
      expectedReviewActions: shownReviews,
      expectedFingerprints: shownPrints,
    });

    // Overwriting prose the admin never read is exactly what the digest stops.
    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'item_changed' });
    const [after] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    expect(JSON.stringify(after!.content)).toContain('Helt ny tekst.');
  });

  it('applies when the digest still matches', async () => {
    const doc = parse(bundle());
    const plan = await planIngestion(doc);
    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedFingerprints: new Map(
        plan.items.map((i) => [i.index, i.fingerprint] as const),
      ),
      expectedReviewActions: new Map(
        plan.sources.map((s) => [s.key, s.reviewAction] as const),
      ),
    });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });
  });

  it('carries every stored bibliographic field into the plan', async () => {
    const doc = parse(
      bundle({
        sources: [
          {
            ...source('S1', '2719903'),
            metadata: {
              title: 'A paper',
              authors: ['Hoskin PJ', 'Hanks GW'],
              journal: 'Br J Clin Pharmacol',
              year: 1989,
            },
          },
          source('S2', '10201674'),
        ],
      }),
    );
    const plan = await planIngestion(doc);
    // Authors and journal drive reference search and grouping, so they are
    // publishable content the gate has to show.
    expect(plan.sources[0]!.metadata).toEqual({
      authors: ['Hoskin PJ', 'Hanks GW'],
      journal: 'Br J Clin Pharmacol',
      year: 1989,
    });
  });
});

describe('conversation ingestion — refusals leave nothing behind', () => {
  it('writes no citation for an item refused as item_changed', async () => {
    const doc = parse(
      bundle({ items: [{ ...bundle().items[0], target: { drugName: 'Morphine' } }] }),
    );
    const plan = await planIngestion(doc);
    const shownPrints = new Map(plan.items.map((i) => [i.index, i.fingerprint] as const));
    const shownReviews = new Map(
      plan.sources.map((s) => [s.key, s.reviewAction] as const),
    );

    const other = await seedDrug(db, {
      slug: 'annet',
      names: { nb: 'Annet', en: 'Morphine' },
      searchKey: 'annet\tmorphine',
    });
    expect(other).toBeGreaterThan(0);
    await db
      .update(drugs)
      .set({ names: { nb: 'Utgått', en: 'Retired' }, searchKey: 'utgatt\tretired' })
      .where(eq(drugs.id, drugId));

    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedReviewActions: shownReviews,
      expectedFingerprints: shownPrints,
    });

    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'item_changed' });
    // The refusal has to come BEFORE the source write, or the run leaves a
    // paper reviewed in the admin's name backing a row that never landed.
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(paperReviews)).toHaveLength(0);
    expect(result.reviewsRecorded).toBe(0);
  });

  it('names which appraisal wins when two keys are the same paper', async () => {
    // Two keys, one paper. Only the first key's appraisal can be written — the
    // second meets the review the first just published.
    const doc = parse(
      bundle({
        sources: [
          source('S1', '2719903'),
          { ...source('S2', '2719903'), verification: {
            ...source('S2', '2719903').verification,
            reviewMarkdown: 'A second, different appraisal of the same paper.',
          } },
        ],
        items: [
          bundle().items[0],
          { ...bundle().items[0], sourceKey: 'S2', median: 0.34, editSummary: 'Andre avlesning.' },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect(plan.sources[0]).toMatchObject({ key: 'S1', reviewAction: 'record', sameAs: null });
    // The gate says so rather than promising an appraisal that never lands.
    expect(plan.sources[1]).toMatchObject({ key: 'S2', reviewAction: 'keep', sameAs: 'S1' });

    await applyIngestion(doc, {
      userId,
      accept: [0, 1],
      expectedReviewActions: new Map(
        plan.sources.map((s) => [s.key, s.reviewAction] as const),
      ),
      expectedFingerprints: new Map(
        plan.items.map((i) => [i.index, i.fingerprint] as const),
      ),
    });

    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.reviewMarkdown).toContain(
      'Crossover study with an intravenous reference arm.',
    );
    // One paper, one row — both readings hang off it.
    expect(await db.select().from(citations)).toHaveLength(1);
  });
});

describe('conversation ingestion — handles and anchors as displayed', () => {
  it('files a resolver URL under the paper it points at, not as a new URL row', async () => {
    // The paper is already on file under its DOI.
    const [existing] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1111/abc', createdBy: userId })
      .returning({ id: citations.id });

    const doc = parse(
      bundle({
        sources: [
          {
            ...source('S1', '2719903'),
            type: 'url' as const,
            identifier: 'https://doi.org/10.1111/abc',
          },
          source('S2', '10201674'),
        ],
      }),
    );

    // `https://doi.org/…` IS the DOI; filing it verbatim would mint a second
    // row for one paper, each with its own review and its own answer to the
    // read-in-full gate.
    const plan = await planIngestion(doc);
    expect(plan.sources[0]).toMatchObject({
      citationAction: 'reuse',
      citationId: existing!.id,
    });

    await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedReviewActions: new Map(
        plan.sources.map((s) => [s.key, s.reviewAction] as const),
      ),
      expectedFingerprints: new Map(
        plan.items.map((i) => [i.index, i.fingerprint] as const),
      ),
    });

    const rows = await db.select().from(citations);
    expect(rows).toHaveLength(1);
    const entries = await db.select().from(parameterEntries);
    expect(entries[0]!.citationId).toBe(existing!.id);
  });

  it('shows the section a moved fact will really be written to', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [1] });
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const content = page!.content as {
      sections: Record<string, { body?: { type: string; content: unknown[] } }>;
    };
    const node = content.sections.forensic!.body!.content[0] as {
      attrs: { factId: string };
    };
    const moved = {
      ...content,
      sections: {
        ...content.sections,
        forensic: { body: { type: 'doc', content: [] } },
        pk: { body: { type: 'doc', content: [node] } },
      },
    };
    await db
      .update(wikiPages)
      .set({ content: moved as never, contentHtml: renderHtml(moved) })
      .where(eq(wikiPages.id, monographId));

    const replacement = parse(
      bundle({
        idempotencyKey: 'conv-test-moved',
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'replace',
            factId: node.attrs.factId,
            statement: 'Presisert setning.',
            sourceKeys: ['S2'],
            editSummary: 'Presisering.',
          },
        ],
      }),
    );

    const plan = await planIngestion(replacement);
    // The row is labelled with where the edit lands, not where the conversation
    // looked — and the digest is derived from that, so a later move is caught.
    expect(plan.items[0]).toMatchObject({ sectionId: 'pk', disposition: 'ready' });
    expect((plan.items[0] as { notes: string[] }).notes).toContain('fact_moved_section');
  });
});

describe('conversation ingestion — a page id is an assertion, not a fact', () => {
  it('blocks a monograph target naming another drug\'s monograph', async () => {
    const other = await seedDrug(db, {
      slug: 'kodein',
      names: { nb: 'Kodein', en: 'Codeine' },
      pubchemCid: 5284371,
      searchKey: 'kodein\tcodeine',
    });
    const otherPage = await ensureDrugMonograph(
      db as never,
      { id: other, names: { nb: 'Kodein', en: 'Codeine' }, pubchemCid: 5284371 },
      userId,
    );

    // Right drug, wrong page id — the shape a model produces when it guesses an
    // id. Without the cross-check, morphine's fact lands on codeine's page.
    const doc = parse(
      bundle({
        items: [
          {
            ...bundle().items[1],
            target: {
              pageType: 'monograph',
              pageId: otherPage.page.id,
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect(plan.items[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'page_identity_conflict',
    });

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, otherPage.page.id));
    expect(JSON.stringify(page!.content)).not.toContain('forråtnelsesgrad');
  });

  it('blocks a monograph target naming a topic page', async () => {
    const [topic] = await db
      .insert(wikiPages)
      .values({
        slug: 'temaside',
        title: 'Temaside',
        content: { type: 'doc', content: [] } as never,
        pageType: 'topic',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });

    const doc = parse(
      bundle({
        items: [
          {
            ...bundle().items[1],
            target: {
              pageType: 'monograph',
              pageId: topic!.id,
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
          },
        ],
      }),
    );

    expect((await planIngestion(doc)).items[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'page_identity_conflict',
    });
  });

  it('records the appraisal the gate named even when only the later key applies', async () => {
    // Two keys, one paper. The gate says S1's appraisal is the one recorded —
    // so it must be, whichever key's item the admin actually accepts.
    const doc = parse(
      bundle({
        sources: [
          source('S1', '2719903'),
          {
            ...source('S2', '2719903'),
            verification: {
              ...source('S2', '2719903').verification,
              reviewMarkdown: 'The later key\'s appraisal, which the gate did not promise.',
            },
          },
        ],
        items: [
          bundle().items[0],
          {
            ...bundle().items[0],
            sourceKey: 'S2',
            median: 0.34,
            editSummary: 'Andre avlesning.',
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect(plan.sources[1]).toMatchObject({ key: 'S2', reviewAction: 'keep', sameAs: 'S1' });

    // Accept ONLY the second item, so S1 is never committed.
    await applyIngestion(doc, {
      userId,
      accept: [1],
      expectedReviewActions: new Map(
        plan.sources.map((s) => [s.key, s.reviewAction] as const),
      ),
      expectedFingerprints: new Map(
        plan.items.map((i) => [i.index, i.fingerprint] as const),
      ),
    });

    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    // S1's text, because that is what the admin was shown — not S2's.
    expect(reviews[0]!.reviewMarkdown).toContain(
      'Crossover study with an intravenous reference arm.',
    );
    expect(reviews[0]!.reviewMarkdown).not.toContain('did not promise');
  });
});

describe('conversation ingestion — provenance and paper-wide state', () => {
  it('refuses an alias key when the paper\'s review was withdrawn', async () => {
    // One paper, two keys, and a read-in-full review on file at Analyse: the
    // owner reads `keep` because of the review, the alias because an owner
    // exists.
    const [citation] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '2719903', createdBy: userId })
      .returning({ id: citations.id });
    await db.insert(paperReviews).values({
      citationId: citation!.id,
      reviewMarkdown: 'Published read-in-full review.',
      readInFull: true,
      createdBy: userId,
    });

    const doc = parse(
      bundle({
        sources: [source('S1', '2719903'), source('S2', '2719903')],
        items: [
          bundle().items[0],
          { ...bundle().items[0], sourceKey: 'S2', median: 0.34, editSummary: 'Andre.' },
        ],
      }),
    );
    const plan = await planIngestion(doc);
    expect(plan.sources.map((s) => s.reviewAction)).toEqual(['keep', 'keep']);
    const shown = new Map(plan.sources.map((s) => [s.key, s.reviewAction] as const));

    // The review is withdrawn. Only the OWNER's action changes — the alias
    // still reads `keep` — so a guard that tracked keys rather than papers
    // would let the alias publish the owner's appraisal unasked.
    await db
      .update(paperReviews)
      .set({ readInFull: false })
      .where(eq(paperReviews.citationId, citation!.id));

    const result = await applyIngestion(doc, {
      userId,
      accept: [1],
      expectedReviewActions: shown,
      expectedFingerprints: new Map(
        plan.items.map((i) => [i.index, i.fingerprint] as const),
      ),
    });

    expect(result.items[1]).toMatchObject({
      status: 'skipped',
      reason: 'source_review_changed',
    });
    const [review] = await db
      .select()
      .from(paperReviews)
      .where(eq(paperReviews.citationId, citation!.id));
    expect(review!.reviewMarkdown).toBe('Published read-in-full review.');
  });

  it('names the citations a replacement would discard, and digests them', async () => {
    await applyIngestion(parse(bundle()), { userId, accept: [1] });
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const node = (
      page!.content as {
        sections: Record<
          string,
          { body: { content: Array<{ attrs: { factId: string; referenceIds: number[] } }> } }
        >;
      }
    ).sections.forensic.body.content[0]!;

    const replacement = parse(
      bundle({
        idempotencyKey: 'conv-test-refs',
        items: [
          {
            type: 'wiki_fact',
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'forensic',
            },
            operation: 'replace',
            factId: node.attrs.factId,
            statement: 'Presisert setning.',
            sourceKeys: ['S2'],
            editSummary: 'Presisering.',
          },
        ],
      }),
    );

    const plan = await planIngestion(replacement);
    const shown = plan.items[0] as {
      existingReferences: Array<{ id: number; identifier: string }>;
      fingerprint: string;
    };
    // The papers behind the sentence being replaced are the more consequential
    // half of the edit, so the gate names them.
    expect(shown.existingReferences.map((c) => c.identifier)).toEqual(['10201674']);
    expect(shown.existingReferences[0]!.id).toBe(node.attrs.referenceIds[0]);

    // A reference-only edit by someone else moves the digest, so the acceptance
    // no longer covers what would be discarded.
    const [otherCitation] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '99999999', createdBy: userId })
      .returning({ id: citations.id });
    const rewritten = JSON.parse(JSON.stringify(page!.content)) as {
      sections: Record<
        string,
        { body: { content: Array<{ attrs: { referenceIds: number[] } }> } }
      >;
    };
    rewritten.sections.forensic.body.content[0]!.attrs.referenceIds = [
      otherCitation!.id,
    ];
    await db
      .update(wikiPages)
      .set({ content: rewritten as never })
      .where(eq(wikiPages.id, monographId));

    const after = await planIngestion(replacement);
    expect(after.items[0]!.fingerprint).not.toBe(shown.fingerprint);
  });
});

describe('conversation ingestion — unverified facts go to the review queue', () => {
  /** The same monograph fact, but its paper was never read in full. */
  function unverifiedBundle(over: Record<string, unknown> = {}) {
    const unread = {
      ...source('S2', '10201674'),
      verification: { ...source('S2', '10201674').verification, readInFull: false },
      pdfRequestNeeded: true,
    };
    return bundle({
      sources: [source('S1', '2719903'), unread],
      items: [bundle().items[1]],
      ...over,
    });
  }

  it('plans it as `review`, naming the source that was not read', async () => {
    const plan = await planIngestion(parse(unverifiedBundle()));

    expect(plan.counts).toEqual({ ready: 0, review: 1, duplicate: 0, blocked: 0 });
    expect(plan.items[0]).toMatchObject({
      type: 'wiki_fact',
      disposition: 'review',
      reason: 'sources_not_read_in_full',
      detail: 'S2',
      unverifiedSourceKeys: ['S2'],
      pageId: monographId,
    });
  });

  it('stages a pending edit and leaves the monograph untouched', async () => {
    const doc = parse(unverifiedBundle());
    const result = await applyIngestion(doc, { userId, accept: [0] });

    // `queued`, not `applied`: a receipt that conflated the two would report an
    // unpublished fact as published.
    expect(result.counts).toMatchObject({ applied: 0, queued: 1, failed: 0 });
    expect(result.items[0]).toMatchObject({ status: 'queued' });

    const edits = await db.select().from(pendingEdits);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      editType: 'wiki_fact',
      status: 'pending',
      targetId: monographId,
      sectionId: 'forensic',
      factOperation: 'add',
      submittedBy: userId,
      reviewedBy: null,
    });
    // The reviewer needs to know the claim is unverified, and cannot work that
    // out from the proposal alone.
    expect(edits[0]!.proposedMeta).toMatchObject({ unverifiedSourceKeys: ['S2'] });
    // Its citation is real and attached, so the reviewer can open the paper.
    expect(edits[0]!.referenceIds).toHaveLength(1);
    // And the unread paper is named by CITATION id, not by the bundle-local
    // key: `S2` means nothing once the bundle is closed, and the review card
    // resolves these against the references it lists.
    const meta = edits[0]!.proposedMeta as { unverifiedReferenceIds?: number[] };
    expect(meta.unverifiedReferenceIds).toEqual(edits[0]!.referenceIds);

    // Nothing was published: no fact on the page, no new revision.
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const forensic = (
      page!.content as { sections?: Record<string, { body?: { content?: unknown[] } }> }
    ).sections?.forensic;
    const facts = (forensic?.body?.content ?? []).filter(
      (n) => (n as { type?: string }).type === 'fact',
    );
    expect(facts).toHaveLength(0);
  });

  it('records the appraisal as NOT read in full, so it authorises nothing', async () => {
    const doc = parse(unverifiedBundle());
    await applyIngestion(doc, { userId, accept: [0] });

    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.readInFull).toBe(false);
  });

  it('re-applying the same bundle does not stack a second proposal', async () => {
    // The queued fact never lands on the page, so the live-content duplicate
    // check cannot see it — the open proposal is what makes this idempotent.
    const doc = parse(unverifiedBundle());
    await applyIngestion(doc, { userId, accept: [0] });

    const second = await planIngestion(doc);
    expect(second.items[0]).toMatchObject({
      disposition: 'duplicate',
      reason: 'already_in_review_queue',
    });

    const result = await applyIngestion(doc, { userId, accept: [0] });
    expect(result.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'already_in_review_queue',
    });
    expect(await db.select().from(pendingEdits)).toHaveLength(1);
  });

  it('reports a fact already live as a duplicate, not a queue entry', async () => {
    // Verified first, so the statement is on the page; the unverified re-run of
    // the same claim has nothing left to propose.
    await applyIngestion(parse(bundle()), { userId, accept: [1] });

    const plan = await planIngestion(parse(unverifiedBundle()));
    expect(plan.items[0]).toMatchObject({
      disposition: 'duplicate',
      reason: 'statement_exists',
    });
  });

  it('refuses to publish it even when the client claims it is ready', async () => {
    // The fingerprint carries the disposition, so a caller that hand-edits the
    // gate's snapshot to say `ready` is refused rather than obeyed.
    const doc = parse(unverifiedBundle());
    const shown = await planIngestion(doc);
    const tampered = shown.items[0]!.fingerprint.replace('"review"', '"ready"');

    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      expectedFingerprints: new Map([[0, tampered]]),
    });
    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'item_changed' });
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
  });

  it('names only the unread paper when a fact cites a read one too', async () => {
    // The case the ids exist for: two references on the card, one of them
    // read. Marking both, or neither, would leave the reviewer guessing which
    // paper the queue is actually asking them to open.
    const unread = {
      ...source('S2', '10201674'),
      verification: { ...source('S2', '10201674').verification, readInFull: false },
    };
    const doc = parse(
      bundle({
        sources: [source('S1', '2719903'), unread],
        items: [
          {
            ...bundle().items[1],
            sourceKeys: ['S1', 'S2'],
          },
        ],
      }),
    );
    await applyIngestion(doc, { userId, accept: [0] });

    const [staged] = await db.select().from(pendingEdits);
    const meta = staged!.proposedMeta as { unverifiedReferenceIds?: number[] };
    expect(staged!.referenceIds).toHaveLength(2);
    expect(meta.unverifiedReferenceIds).toHaveLength(1);

    const [unreadCitation] = await db
      .select({ id: citations.id })
      .from(citations)
      .where(eq(citations.identifier, '10201674'));
    expect(meta.unverifiedReferenceIds).toEqual([unreadCitation!.id]);
  });

  it('does not collapse the same sentence proposed into two sections', async () => {
    // An `add` is identified by section AND statement, because that is what
    // the live-content check compares. Keying on the page alone would report
    // the second section's proposal as already queued and silently drop it.
    const doc = parse(
      unverifiedBundle({
        items: [
          bundle().items[1],
          {
            ...(bundle().items[1] as Record<string, unknown>),
            target: {
              pageType: 'monograph',
              drug: { drugName: 'Morphine', pubchemCid: 5288826 },
              sectionId: 'pk',
            },
          },
        ],
      }),
    );

    const plan = await planIngestion(doc);
    expect(plan.counts).toEqual({ ready: 0, review: 2, duplicate: 0, blocked: 0 });

    const result = await applyIngestion(doc, { userId, accept: [0, 1] });
    expect(result.counts).toMatchObject({ queued: 2, skipped: 0, failed: 0 });

    const edits = await db.select().from(pendingEdits);
    expect(edits.map((e) => e.sectionId).sort()).toEqual(['forensic', 'pk']);
  });

  it('holds the queue check and the insert together under a page lock', async () => {
    // Two applies of the same bundle racing: without the in-transaction
    // re-check both would read "nothing queued" and both insert, and the
    // idempotency this route promises would hold only for serial callers.
    const doc = parse(unverifiedBundle());
    const [a, b] = await Promise.all([
      applyIngestion(doc, { userId, accept: [0] }),
      applyIngestion(doc, { userId, accept: [0] }),
    ]);

    expect(await db.select().from(pendingEdits)).toHaveLength(1);
    // Exactly one queued it; the loser reports honestly rather than claiming a
    // write it did not make.
    const statuses = [a.items[0]!.status, b.items[0]!.status].sort();
    expect(statuses).toEqual(['queued', 'skipped']);
  });

  it('keeps a second replacement that re-cites the same sentence differently', async () => {
    // The live check calls a replace a duplicate only when statement AND
    // citations match, and the item fingerprint counts `existingReferences` for
    // the same reason: re-citing one sentence to different papers is a real
    // edit. The queued identity has to agree, or the better-sourced proposal is
    // dropped instead of reaching the reviewer.
    await applyIngestion(parse(bundle()), { userId, accept: [1] });
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const factId = (
      page!.content as {
        sections: Record<
          string,
          { body: { content: Array<{ attrs: { factId: string } }> } }
        >;
      }
    ).sections.forensic.body.content[0]!.attrs.factId;

    const unread = (key: string, pmid: string) => ({
      ...source(key, pmid),
      verification: { ...source(key, pmid).verification, readInFull: false },
    });
    const replacement = (key: string, idempotencyKey: string) =>
      parse(
        bundle({
          idempotencyKey,
          sources: [unread('S1', '2719903'), unread('S2', '10201674')],
          items: [
            {
              type: 'wiki_fact',
              target: {
                pageType: 'monograph',
                drug: { drugName: 'Morphine', pubchemCid: 5288826 },
                sectionId: 'forensic',
              },
              operation: 'replace',
              factId,
              statement: 'Presisert setning om C/P-forholdet.',
              sourceKeys: [key],
              editSummary: 'Presisering.',
            },
          ],
        }),
      );

    const first = await applyIngestion(replacement('S1', 'conv-repl-a'), {
      userId,
      accept: [0],
    });
    expect(first.items[0]).toMatchObject({ status: 'queued' });

    // Same anchor, same sentence, a different paper behind it.
    const second = await applyIngestion(replacement('S2', 'conv-repl-b'), {
      userId,
      accept: [0],
    });
    expect(second.items[0]).toMatchObject({ status: 'queued' });

    const queued = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.status, 'pending'));
    expect(queued).toHaveLength(2);
    expect(queued.map((e) => e.referenceIds)).not.toEqual([
      queued[0]!.referenceIds,
      queued[0]!.referenceIds,
    ]);

    // And the identical one still collapses, so this did not just disable the
    // check for replacements.
    const repeat = await applyIngestion(replacement('S2', 'conv-repl-b'), {
      userId,
      accept: [0],
    });
    expect(repeat.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'already_in_review_queue',
    });
  });

  it('does not re-queue a statement a reviewer has since published', async () => {
    // Sequential form: the plan catches this one on its own. Kept because it
    // is the case an operator actually hits — queue it, someone approves it,
    // re-paste the bundle — and it pins that approving a queued fact does not
    // leave the bundle able to propose it again. The genuinely concurrent
    // form, where the approval lands after the plan, is what the locked
    // `liveFactDuplicate` re-check covers; that predicate is pinned directly
    // below, because a test at this level cannot observe the window.
    const doc = parse(unverifiedBundle());
    await applyIngestion(doc, { userId, accept: [0] });
    const [staged] = await db.select().from(pendingEdits);

    const reviewerId = await seedUser(db, {
      email: 'reviewer2@example.com',
      username: 'reviewer2',
      role: 'admin',
    });
    await applyApprovedEdit(staged!.id, reviewerId);

    // Nothing is `pending` now, so only a live-page read can catch this.
    const stillPending = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.status, 'pending'));
    expect(stillPending).toHaveLength(0);

    const again = await applyIngestion(doc, { userId, accept: [0] });
    expect(again.items[0]!.status).not.toBe('queued');
    expect(
      await db.select().from(pendingEdits).where(eq(pendingEdits.status, 'pending')),
    ).toHaveLength(0);

    // And the page still carries the sentence once.
    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const forensic = (
      page!.content as { sections?: Record<string, { body?: { content?: unknown[] } }> }
    ).sections?.forensic;
    const facts = (forensic?.body?.content ?? []).filter(
      (n) => (n as { type?: string }).type === 'fact',
    );
    expect(facts).toHaveLength(1);
  });

  describe('liveFactVerdict — the guard the locked write re-asks', () => {
    // What the queue check cannot see: a matching proposal approved between
    // the plan and the insert leaves `pending`, so `findOpenFactProposal` goes
    // quiet, while the statement it carried is now on the page. Without this
    // predicate an `add` would be queued twice and a later reviewer would
    // splice the same sentence in twice.
    async function liveFactId(): Promise<string> {
      const [page] = await db
        .select({ content: wikiPages.content })
        .from(wikiPages)
        .where(eq(wikiPages.id, monographId));
      return (
        page!.content as {
          sections: Record<
            string,
            { body: { content: Array<{ attrs: { factId: string } }> } }
          >;
        }
      ).sections.forensic.body.content[0]!.attrs.factId;
    }

    const statement =
      'Forholdet mellom morfin i hjerteblod og perifert blod varierer med forråtnelsesgrad.';

    it('sees an `add` whose statement is already live in that section', async () => {
      await applyIngestion(parse(bundle()), { userId, accept: [1] });

      await expect(
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'forensic',
          operation: 'add',
          statement,
          factId: null,
          referenceIds: [],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'already_applied' });

      // Section-local, exactly as the planner's check is.
      await expect(
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'pk',
          operation: 'add',
          statement,
          factId: null,
          referenceIds: [],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'proceed' });
    });

    it('sees a `replace` only when statement AND citations already match', async () => {
      await applyIngestion(parse(bundle()), { userId, accept: [1] });
      const factId = await liveFactId();
      const [citation] = await db
        .select({ id: citations.id })
        .from(citations)
        .where(eq(citations.identifier, '10201674'));

      const ask = (referenceIds: number[]) =>
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'forensic',
          operation: 'replace',
          statement,
          factId,
          referenceIds,
          referencesKnown: true,
        });

      await expect(ask([citation!.id])).resolves.toMatchObject({ verdict: 'already_applied' });
      // A different citation set is a different edit, not a repeat.
      await expect(ask([citation!.id + 999])).resolves.toMatchObject({ verdict: 'proceed' });
    });

    it('declines to answer a `replace` whose citations are not yet minted', async () => {
      await applyIngestion(parse(bundle()), { userId, accept: [1] });
      const factId = await liveFactId();

      await expect(
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'forensic',
          operation: 'replace',
          statement,
          factId,
          referenceIds: [],
          referencesKnown: false,
        }),
      ).resolves.toMatchObject({ verdict: 'proceed' });
    });

    it('refuses a `replace` whose anchor vanished, rather than queueing it', async () => {
      // `applyApprovedWikiFact` resolves the anchor at approval time and throws
      // when it has gone, so staging this would put a proposal in someone
      // else's queue that they can never approve.
      await expect(
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'forensic',
          operation: 'replace',
          statement: 'Uansett hvilken setning.',
          factId: 'not-on-this-page',
          referenceIds: [1],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'anchor_gone' });
    });

    it('reports where a moved fact lives now, not where the plan found it', async () => {
      // The staged row must point at the fact's CURRENT home: approval resolves
      // the anchor by section, so a row written against the old one fails even
      // though the fact still exists.
      await applyIngestion(parse(bundle()), { userId, accept: [1] });
      const factId = await liveFactId();

      const [before] = await db
        .select({ content: wikiPages.content })
        .from(wikiPages)
        .where(eq(wikiPages.id, monographId));
      const content = before!.content as {
        sections: Record<string, { body: { content: unknown[] } }>;
      };
      // Move the fact from `forensic` to `pk`.
      const node = content.sections.forensic!.body.content[0];
      content.sections.forensic!.body.content = [];
      content.sections.pk = content.sections.pk ?? { body: { content: [] } };
      content.sections.pk.body.content = [node];
      await db
        .update(wikiPages)
        .set({ content: content as never })
        .where(eq(wikiPages.id, monographId));

      await expect(
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'forensic',
          operation: 'replace',
          statement: 'Noe annet.',
          factId,
          referenceIds: [1],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'proceed', sectionId: 'pk' });
    });

    it('refuses an `add` whose topic section was deleted', async () => {
      // `sectionFacts` returns [] for a missing section and for an empty one
      // alike, so this needs the page asked directly.
      const [topic] = await db
        .insert(wikiPages)
        .values({
          slug: 'et-tema',
          title: 'Et tema',
          content: { type: 'doc', content: [] } as never,
          pageType: 'topic',
          status: 'published',
          createdBy: userId,
          updatedBy: userId,
        })
        .returning({ id: wikiPages.id });

      await expect(
        liveFactVerdict(db as never, {
          pageId: topic!.id,
          sectionId: 'en-seksjon-som-ikke-finnes',
          operation: 'add',
          statement: 'En påstand.',
          factId: null,
          referenceIds: [],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'section_gone' });
    });

    it('refuses when the target page itself is gone', async () => {
      // `pending_edits.target_id` has no FK to `wiki_pages`, so the insert
      // would succeed and leave a proposal `applyApprovedWikiFact` refuses
      // forever.
      await expect(
        liveFactVerdict(db as never, {
          pageId: 999_999,
          sectionId: 'forensic',
          operation: 'add',
          statement: 'En påstand.',
          factId: null,
          referenceIds: [],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'page_gone' });
    });

    it('treats a `remove` whose anchor is gone as already done', async () => {
      await expect(
        liveFactVerdict(db as never, {
          pageId: monographId,
          sectionId: 'forensic',
          operation: 'remove',
          statement: null,
          factId: 'not-on-this-page',
          referenceIds: [],
          referencesKnown: true,
        }),
      ).resolves.toMatchObject({ verdict: 'already_applied' });
    });
  });

  it('queues when an alias of the cited paper is the one nobody read', async () => {
    // The pair the bundle could not know about: two keys the NCBI converter
    // joins into one citation row. They share one review, and
    // `commitSourcesFor` records the FIRST key's appraisal for both — so an
    // item citing the verified alias would publish while the review actually
    // stored says `readInFull: false`. Routing asks about the paper, not the
    // key, so it queues instead.
    // Two DOIs the bundle has no reason to connect — the validator's
    // declared-handle check cannot see this pair, which is the point.
    const asDoi = (key: string, doi: string) => ({
      ...source(key, '0'),
      type: 'doi' as const,
      identifier: doi,
    });
    const unread = {
      ...asDoi('S1', '10.1000/paper-a'),
      verification: { ...source('S1', '1').verification, readInFull: false },
    };
    const doc = parse(
      bundle({
        sources: [unread, asDoi('S2', '10.1000/paper-b')],
        items: [{ ...(bundle().items[1] as Record<string, unknown>), sourceKeys: ['S2'] }],
      }),
    );

    // The NCBI converter reports both DOIs as the same PMID, which outranks a
    // DOI — so both keys canonicalize onto one citation row.
    const crosswalk = new Map([
      ['S1', { pmid: '2719903' }],
      ['S2', { pmid: '2719903' }],
    ]);

    const plan = await planIngestion(doc, { crosswalk: crosswalk as never });
    expect(plan.items[0]).toMatchObject({
      disposition: 'review',
      reason: 'sources_not_read_in_full',
      // Names the key whose appraisal will actually land, not the cited one.
      unverifiedSourceKeys: ['S1'],
    });

    const result = await applyIngestion(doc, {
      userId,
      accept: [0],
      crosswalk: crosswalk as never,
    });
    expect(result.items[0]).toMatchObject({ status: 'queued' });

    // The stored review and the routing decision now agree: unread paper,
    // unpublished claim.
    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.readInFull).toBe(false);

    // And the staged proposal names the paper by CITATION id. The unread key
    // (S1) is not the cited one (S2), so a key-local lookup would record
    // nothing and the review card would have no paper to mark.
    const [staged] = await db.select().from(pendingEdits);
    const meta = staged!.proposedMeta as {
      unverifiedSourceKeys?: string[];
      unverifiedReferenceIds?: number[];
    };
    expect(meta.unverifiedSourceKeys).toEqual(['S1']);
    expect(meta.unverifiedReferenceIds).toEqual(staged!.referenceIds);
    expect(meta.unverifiedReferenceIds).toHaveLength(1);
  });

  it('does not rewrite an unread paper review that is already identical', async () => {
    // Two applies of one bundle overlap: both commit sources before either
    // reaches the page lock, so the one that goes on to skip its item as a
    // duplicate has already been through `recordPaperReview`. Rewriting an
    // unread review appends a revision and resets the peer verifications the
    // live review carried, so an identical write must be a no-op.
    const doc = parse(unverifiedBundle());
    const first = await applyIngestion(doc, { userId, accept: [0] });
    expect(first.reviewsRecorded).toBe(1);

    const second = await applyIngestion(doc, { userId, accept: [0] });
    expect(second.items[0]).toMatchObject({ reason: 'already_in_review_queue' });
    expect(second.reviewsRecorded).toBe(0);

    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.readInFull).toBe(false);
  });

  it('re-records when only the rubric score changed', async () => {
    // The no-op must mean "identical", not "identical in the two fields I
    // happened to load". Reached through a SECOND fact citing the same paper:
    // a duplicate item never commits its sources at all, so the guard only
    // ever decides for an item that is really being written.
    const doc = parse(unverifiedBundle());
    const first = await applyIngestion(doc, { userId, accept: [0] });
    expect(first.reviewsRecorded).toBe(1);
    expect((await db.select().from(paperReviews))[0]!.overallScore).toBe(68);

    const rescored = parse(
      unverifiedBundle({
        idempotencyKey: 'conv-rescored',
        sources: [
          source('S1', '2719903'),
          {
            ...source('S2', '10201674'),
            verification: {
              ...source('S2', '10201674').verification,
              readInFull: false,
              overallScore: 12,
            },
          },
        ],
        items: [
          {
            ...(bundle().items[1] as Record<string, unknown>),
            statement: 'En annen setning om det samme forholdet.',
          },
        ],
      }),
    );
    const second = await applyIngestion(rescored, { userId, accept: [0] });
    expect(second.items[0]).toMatchObject({ status: 'queued' });

    const reviews = await db.select().from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.overallScore).toBe(12);
  });

  it('the queued proposal is approvable, and publishes when a reviewer takes it', async () => {
    // The point of routing here rather than blocking: a human can finish the
    // job. If the staged row could not be approved, the queue would just be a
    // slower dead end.
    const doc = parse(unverifiedBundle());
    await applyIngestion(doc, { userId, accept: [0] });

    const [staged] = await db.select().from(pendingEdits);
    const reviewerId = await seedUser(db, {
      email: 'reviewer@example.com',
      username: 'reviewer',
      role: 'admin',
    });
    await applyApprovedEdit(staged!.id, reviewerId);

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, monographId));
    const forensic = (
      page!.content as { sections?: Record<string, { body?: { content?: unknown[] } }> }
    ).sections?.forensic;
    const facts = (forensic?.body?.content ?? []).filter(
      (n) => (n as { type?: string }).type === 'fact',
    );
    expect(facts).toHaveLength(1);
  });

  it('publishes a fact whose sources WERE read in full, unchanged', async () => {
    // The relaxation must not leak into the verified path: those still splice.
    const result = await applyIngestion(parse(bundle()), { userId, accept: [1] });
    expect(result.counts).toMatchObject({ applied: 1, queued: 0 });
  });
});
