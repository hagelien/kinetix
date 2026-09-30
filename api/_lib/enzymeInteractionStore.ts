import { asc, eq, inArray } from 'drizzle-orm';
import {
  bioEntities,
  drugEnzymeInteractions,
  drugInteractions,
  drugs,
} from '../../db/schema.js';
import {
  isEnzymeInteractionRole,
  isEnzymeInteractionStrength,
  type DrugEnzymeInteractionSummary,
} from '../../src/lib/enzymeInteractions.js';
import type { EnzymeInteractionInput } from './schemas.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

export class EnzymeInteractionWriteError extends Error {
  constructor(
    message: string,
    public readonly statusHint = 400,
  ) {
    super(message);
    this.name = 'EnzymeInteractionWriteError';
  }
}

/** Read a drug's enzyme-interaction rows, hydrated with the enzyme entity. */
export async function getDrugEnzymeInteractions(
  db: Db,
  drugId: number,
): Promise<DrugEnzymeInteractionSummary[]> {
  const rows = await db
    .select({
      id: drugEnzymeInteractions.id,
      drugId: drugEnzymeInteractions.drugId,
      bioEntityId: drugEnzymeInteractions.bioEntityId,
      role: drugEnzymeInteractions.role,
      strength: drugEnzymeInteractions.strength,
      note: drugEnzymeInteractions.note,
      referenceIds: drugEnzymeInteractions.referenceIds,
      entitySlug: bioEntities.slug,
      entitySymbol: bioEntities.symbol,
      entityName: bioEntities.name,
      entityNameEn: bioEntities.nameEn,
      entityClass: bioEntities.entityClass,
    })
    .from(drugEnzymeInteractions)
    .innerJoin(
      bioEntities,
      eq(drugEnzymeInteractions.bioEntityId, bioEntities.id),
    )
    .where(eq(drugEnzymeInteractions.drugId, drugId))
    .orderBy(
      asc(drugEnzymeInteractions.sortOrder),
      asc(drugEnzymeInteractions.id),
    );

  return rows
    .filter((r) => isEnzymeInteractionRole(r.role))
    .map((r) => ({
      id: r.id,
      drugId: r.drugId,
      bioEntityId: r.bioEntityId,
      role: r.role as DrugEnzymeInteractionSummary['role'],
      strength: isEnzymeInteractionStrength(r.strength) ? r.strength : null,
      note: r.note,
      referenceIds: r.referenceIds ?? [],
      enzyme: {
        id: r.bioEntityId,
        slug: r.entitySlug,
        symbol: r.entitySymbol,
        name: r.entityName,
        nameEn: r.entityNameEn,
        enzymeClass: r.entityClass,
      },
    }));
}

/**
 * Validate without mutating: the drug must exist, every linked enzyme must
 * resolve to a bio_entities row, and no (enzyme, role) pair may repeat (the
 * unique index).
 */
export async function validateEnzymeInteractionsInput(
  db: Db,
  drugId: number,
  interactions: EnzymeInteractionInput[],
): Promise<void> {
  const [drug] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!drug) throw new EnzymeInteractionWriteError('Drug not found', 404);

  const entityIds = [...new Set(interactions.map((i) => i.bioEntityId))];
  if (entityIds.length > 0) {
    const found = await db
      .select({ id: bioEntities.id })
      .from(bioEntities)
      .where(inArray(bioEntities.id, entityIds));
    const foundSet = new Set(found.map((r) => r.id));
    const missing = entityIds.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new EnzymeInteractionWriteError(
        `Enzyme(s) not found: ${missing.join(', ')}`,
        400,
      );
    }
  }

  const seen = new Set<string>();
  for (const i of interactions) {
    const key = `${i.bioEntityId}|${i.role}`;
    if (seen.has(key)) {
      throw new EnzymeInteractionWriteError(
        'Each enzyme may appear only once per role',
        409,
      );
    }
    seen.add(key);
  }
}

/** Full-replace a drug's enzyme interactions. Must run inside a transaction. */
export async function replaceDrugEnzymeInteractions(
  db: Db,
  drugId: number,
  interactions: EnzymeInteractionInput[],
  userId: number,
): Promise<void> {
  await validateEnzymeInteractionsInput(db, drugId, interactions);

  await db
    .delete(drugEnzymeInteractions)
    .where(eq(drugEnzymeInteractions.drugId, drugId));

  if (interactions.length > 0) {
    await db.insert(drugEnzymeInteractions).values(
      interactions.map((i, sortOrder) => ({
        drugId,
        bioEntityId: i.bioEntityId,
        role: i.role,
        strength: i.strength ?? null,
        note: i.note?.trim() || null,
        referenceIds:
          i.referenceIds && i.referenceIds.length > 0 ? i.referenceIds : null,
        sortOrder,
        createdBy: userId,
        updatedBy: userId,
      })),
    );
  }

  await db.insert(drugInteractions).values({
    drugId,
    userId,
    eventType: 'edit',
  });
}
