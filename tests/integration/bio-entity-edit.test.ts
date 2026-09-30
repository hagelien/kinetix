import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  bioEntities,
  bioEntityFunctions,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import { getDb } from '../../api/_lib/db.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedUser } from './setup/seed.js';

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

async function insertBioEntityEdit(input: {
  submittedBy: number;
  targetId: number | null;
  proposedValue: unknown;
}): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'bio_entity',
      targetId: input.targetId,
      proposedValue: input.proposedValue as never,
      proposedMeta: null,
      status: 'pending',
      submittedBy: input.submittedBy,
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

describe('bio_entity review edits applied over real SQL', () => {
  it('creates a new entity (with functions + monograph) on approval', async () => {
    const author = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'reviewer@example.com',
      username: 'reviewer',
    });

    const editId = await insertBioEntityEdit({
      submittedBy: author,
      targetId: null,
      proposedValue: {
        op: 'create',
        entity: {
          symbol: 'SLC6A4',
          name: 'Serotonintransportør',
          nameEn: 'Serotonin transporter',
          functions: ['transporter', 'drug_target'],
        },
      },
    });

    await applyApprovedEdit(editId, reviewer);

    const [entity] = await db
      .select()
      .from(bioEntities)
      .where(eq(bioEntities.symbol, 'SLC6A4'));
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('Serotonintransportør');

    const fns = await db
      .select({ fn: bioEntityFunctions.function })
      .from(bioEntityFunctions)
      .where(eq(bioEntityFunctions.entityId, entity!.id));
    expect(fns.map((f) => f.fn).sort()).toEqual(['drug_target', 'transporter']);

    // An empty monograph is minted up front, mirroring the admin direct-write
    // path and drug creation.
    const [monograph] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.pageType, 'entity_monograph'),
          eq(wikiPages.entityId, entity!.id),
        ),
      );
    expect(monograph).toBeDefined();

    const [applied] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect(applied!.status).toBe('approved');
  });

  it('applies a partial patch to an existing entity on approval', async () => {
    const author = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'reviewer@example.com',
      username: 'reviewer',
    });
    const entityId = await seedBioEntity(
      db,
      { slug: 'drd2', symbol: 'DRD2', name: 'Dopamin D2' },
      ['drug_target'],
    );

    const editId = await insertBioEntityEdit({
      submittedBy: author,
      targetId: entityId,
      proposedValue: {
        op: 'update',
        patch: { entityClass: 'GPCR', nameEn: 'Dopamine D2 receptor' },
      },
    });

    await applyApprovedEdit(editId, reviewer);

    const [entity] = await db
      .select()
      .from(bioEntities)
      .where(eq(bioEntities.id, entityId));
    expect(entity!.entityClass).toBe('GPCR');
    expect(entity!.nameEn).toBe('Dopamine D2 receptor');
    // Untouched fields survive the partial patch.
    expect(entity!.name).toBe('Dopamin D2');
  });
});
