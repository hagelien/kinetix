import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bioEntities, bioEntityFunctions } from '../../db/schema.js';
import { findOrCreateEntityBySymbol } from '../../api/_lib/bioEntityStore.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity } from './setup/seed.js';

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

describe('findOrCreateEntityBySymbol over real SQL', () => {
  it('reuses a cosmetic symbol match and adds the requested function', async () => {
    const entityId = await seedBioEntity(db, {
      slug: 'mao-a',
      symbol: 'MAO-A',
      name: 'Monoamine oxidase A',
    });

    const resolvedId = await findOrCreateEntityBySymbol(
      db,
      { symbol: 'MAOA', name: 'Monoaminoksidase A' },
      'drug_target',
    );

    expect(resolvedId).toBe(entityId);
    const [functionRow] = await db
      .select({ id: bioEntityFunctions.id })
      .from(bioEntityFunctions)
      .where(
        and(
          eq(bioEntityFunctions.entityId, entityId),
          eq(bioEntityFunctions.function, 'drug_target'),
        ),
      );
    expect(functionRow).toBeDefined();
  });

  // #1017. The SQL predicate and `normalizeOrganismKey` must agree: a rat row
  // that matched in SQL but was rejected in TS would create a second rat entity
  // on every import.
  it('keeps a non-human ortholog apart from the human entity', async () => {
    const humanId = await seedBioEntity(db, {
      slug: 'slc6a3',
      symbol: 'SLC6A3',
      name: 'Dopamintransportør',
      organism: 'Homo sapiens',
    });
    const ratId = await seedBioEntity(db, {
      slug: 'slc6a3-rat',
      symbol: 'SLC6A3',
      name: 'Dopamintransportør (rotte)',
      organism: 'Rattus norvegicus',
    });

    expect(
      await findOrCreateEntityBySymbol(db, { symbol: 'SLC6A3' }, 'drug_target'),
    ).toBe(humanId);
    expect(
      await findOrCreateEntityBySymbol(
        db,
        { symbol: 'slc6a3', organism: '  rattus   norvegicus ' },
        'drug_target',
      ),
    ).toBe(ratId);
  });

  it('creates the non-human row rather than binding the human one', async () => {
    const humanId = await seedBioEntity(db, {
      slug: 'htr2a',
      symbol: 'HTR2A',
      name: '5-HT2A-reseptor',
    });

    const ratId = await findOrCreateEntityBySymbol(
      db,
      { symbol: 'HTR2A', name: '5-HT2A (rotte)', organism: 'Rattus norvegicus' },
      'drug_target',
    );

    expect(ratId).not.toBe(humanId);
    const [row] = await db
      .select({ organism: bioEntities.organism })
      .from(bioEntities)
      .where(eq(bioEntities.id, ratId));
    expect(row?.organism).toBe('Rattus norvegicus');
    // The human row is untouched — it is shared by every other drug.
    const [human] = await db
      .select({ organism: bioEntities.organism })
      .from(bioEntities)
      .where(eq(bioEntities.id, humanId));
    expect(human?.organism).toBe('Homo sapiens');
  });

  it('reuses a shared UniProt id when the symbol differs', async () => {
    const entityId = await seedBioEntity(db, {
      slug: 'dpyd',
      symbol: 'DPYD',
      name: 'Dihydropyrimidine dehydrogenase',
      externalIds: { uniprot: 'Q12882' },
    });

    const resolvedId = await findOrCreateEntityBySymbol(
      db,
      { symbol: 'DPD', name: 'DPD', externalIds: { uniprot: 'q12882' } },
      'metabolic_enzyme',
    );

    expect(resolvedId).toBe(entityId);
  });
});
