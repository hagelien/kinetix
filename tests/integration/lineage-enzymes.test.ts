/**
 * Lineage enzymes against real SQL (plan §7.2, §10 Phase 2).
 *
 * The whole of `getLineageEnzymes` is one statement, so a mocked query builder
 * would test nothing that can fail — and the first version of it failed in the
 * way only real SQL catches: it selected `d.name`, a column migration 0013
 * dropped, so Postgres rejected the statement whether or not any row matched.
 * Because the endpoint answers the graph and the enzymes together, that took
 * the metabolism graph down with it and hid every profile.
 *
 * What is worth pinning here is therefore the shape of the answer as the
 * database gives it, and the three scopes that decide what a curator is
 * offered: the module's own substances, the roles that move an enzyme, and the
 * routes that name one at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  citations,
  drugEliminationRoutes,
  drugEnzymeInteractions,
  drugMetabolites,
} from '../../db/schema.js';
import { getLineageEnzymes } from '../../api/_lib/metabolismGraphStore.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedDrug } from './setup/seed.js';

let db: IntegrationDb;
let methadoneId: number;
let cyp2b6Id: number;
let cyp3a4Id: number;

const METHADONE_CID = 4095;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});

beforeEach(async () => {
  await resetIntegrationDb(db);
  methadoneId = await seedDrug(db, {
    slug: 'metadon',
    names: { nb: 'Metadon', en: 'Methadone' },
    pubchemCid: METHADONE_CID,
  });
  cyp2b6Id = await seedBioEntity(db, { slug: 'cyp2b6', symbol: 'CYP2B6', name: 'CYP2B6' });
  cyp3a4Id = await seedBioEntity(db, { slug: 'cyp3a4', symbol: 'CYP3A4', name: 'CYP3A4' });
});

describe('the enzymes a lineage routes through', () => {
  it('answers with the routes the catalog records, and their modulators', async () => {
    const inducerId = await seedDrug(db, {
      slug: 'karbamazepin',
      names: { nb: 'Karbamazepin', en: 'Carbamazepine' },
      pubchemCid: 2554,
    });
    await db.insert(drugEliminationRoutes).values({
      drugId: methadoneId,
      kind: 'enzyme',
      bioEntityId: cyp2b6Id,
      label: 'CYP2B6',
    });
    await db.insert(drugEnzymeInteractions).values({
      drugId: inducerId,
      bioEntityId: cyp2b6Id,
      role: 'inducer',
      strength: 'strong',
    });

    const enzymes = await getLineageEnzymes(db, [METHADONE_CID]);

    expect(enzymes.substrates).toEqual([
      { enzymeSlug: 'cyp2b6', drug: { pubchemCid: METHADONE_CID, slug: 'metadon' } },
    ]);
    // The names object, per language, because the reader's locale decides which
    // to show and this endpoint has no reader attached.
    expect(enzymes.modulators).toEqual([
      {
        enzymeSlug: 'cyp2b6',
        drug: { pubchemCid: 2554, slug: 'karbamazepin' },
        names: { nb: 'Karbamazepin', en: 'Carbamazepine' },
        role: 'inducer',
        strength: 'strong',
        citations: [],
      },
    ]);
  });

  it('resolves the interaction’s own references to handles', async () => {
    const inducerId = await seedDrug(db, {
      slug: 'karbamazepin',
      names: { nb: 'Karbamazepin' },
      pubchemCid: 2554,
    });
    const [pmid] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '12345678' })
      .returning({ id: citations.id });
    // Free text resolves to nothing, so it could only print as a claim with a
    // citation-shaped hole in it.
    const [freetext] = await db
      .insert(citations)
      .values({ type: 'freetext', identifier: 'personal communication' })
      .returning({ id: citations.id });
    await db.insert(drugEliminationRoutes).values({
      drugId: methadoneId,
      kind: 'enzyme',
      bioEntityId: cyp2b6Id,
      label: 'CYP2B6',
    });
    await db.insert(drugEnzymeInteractions).values({
      drugId: inducerId,
      bioEntityId: cyp2b6Id,
      role: 'inducer',
      referenceIds: [pmid!.id, freetext!.id],
    });

    // Row ids a client cannot follow, resolved here into handles it can — the
    // catalog's answer to "who says this substance moves this enzyme".
    const [modulator] = (await getLineageEnzymes(db, [METHADONE_CID])).modulators;
    expect(modulator?.citations).toEqual([{ type: 'pmid', identifier: '12345678' }]);
  });

  it('answers for a lineage with no interactions rather than failing', async () => {
    await db.insert(drugEliminationRoutes).values({
      drugId: methadoneId,
      kind: 'enzyme',
      bioEntityId: cyp2b6Id,
      label: 'CYP2B6',
    });

    // The case the dropped-column bug hid behind: nothing to return is a real
    // answer, and the statement has to be executable to give it.
    const enzymes = await getLineageEnzymes(db, [METHADONE_CID]);
    expect(enzymes.substrates).toHaveLength(1);
    expect(enzymes.modulators).toEqual([]);
  });

  it('names no enzyme for a route that names none', async () => {
    // Renal and biliary routes carry no entity, and neither does an enzyme
    // route whose entity nobody matched — a free-text label the field cannot
    // name, and must not invent a slug for.
    await db.insert(drugEliminationRoutes).values([
      { drugId: methadoneId, kind: 'other_unchanged', bioEntityId: null, label: 'Renal' },
      { drugId: methadoneId, kind: 'enzyme', bioEntityId: null, label: 'CYP2B6-ish' },
    ]);

    expect(await getLineageEnzymes(db, [METHADONE_CID])).toEqual({
      substrates: [],
      modulators: [],
    });
  });

  it('offers what moves the enzyme, not what competes for it', async () => {
    const substrateId = await seedDrug(db, {
      slug: 'annet-substrat',
      names: { nb: 'Annet substrat' },
      pubchemCid: 999001,
    });
    await db.insert(drugEliminationRoutes).values({
      drugId: methadoneId,
      kind: 'enzyme',
      bioEntityId: cyp2b6Id,
      label: 'CYP2B6',
    });
    await db.insert(drugEnzymeInteractions).values({
      drugId: substrateId,
      bioEntityId: cyp2b6Id,
      role: 'substrate',
    });

    // A fellow substrate makes a different claim from a co-medication that
    // induces or inhibits, and this field does not make it.
    expect((await getLineageEnzymes(db, [METHADONE_CID])).modulators).toEqual([]);
  });

  it('says nothing about an enzyme the lineage does not route through', async () => {
    const inhibitorId = await seedDrug(db, {
      slug: 'kinidin',
      names: { nb: 'Kinidin' },
      pubchemCid: 5280343,
    });
    await db.insert(drugEliminationRoutes).values({
      drugId: methadoneId,
      kind: 'enzyme',
      bioEntityId: cyp2b6Id,
      label: 'CYP2B6',
    });
    await db.insert(drugEnzymeInteractions).values({
      drugId: inhibitorId,
      bioEntityId: cyp3a4Id,
      role: 'inhibitor',
    });

    // CYP3A4 is a real enzyme with a real inhibitor, and this lineage has no
    // recorded route through it — so offering the substance here would put a
    // question on screen the catalog does not raise.
    expect((await getLineageEnzymes(db, [METHADONE_CID])).modulators).toEqual([]);
  });

  it('answers empty for a module whose substances the catalog has not entered', async () => {
    expect(await getLineageEnzymes(db, [123456789])).toEqual({
      substrates: [],
      modulators: [],
    });
    // And for a module naming nothing at all, without asking the database.
    expect(await getLineageEnzymes(db, [])).toEqual({ substrates: [], modulators: [] });
  });
});
