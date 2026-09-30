/**
 * Minimal row factories for the integration tests. Each inserts one row with
 * sensible defaults (overridable) and returns its generated id, so tests can
 * wire up FK relationships without repeating column boilerplate.
 */
import {
  users,
  drugs,
  bioEntities,
  bioEntityFunctions,
  citations,
  paperReviews,
} from '../../../db/schema.js';
import type { IntegrationDb } from './harness.js';

export async function seedUser(
  db: IntegrationDb,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: over.email ?? 'tester@example.com',
      username: over.username ?? 'tester',
      ...over,
    })
    .returning({ id: users.id });
  return row!.id;
}

export async function seedDrug(
  db: IntegrationDb,
  over: Partial<typeof drugs.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(drugs)
    .values({
      slug: over.slug ?? 'test-drug',
      names: over.names ?? { nb: 'Testmiddel', en: 'Test drug' },
      ...over,
    })
    .returning({ id: drugs.id });
  return row!.id;
}

/** A unified bio_entity, optionally with the roles it plays. */
export async function seedBioEntity(
  db: IntegrationDb,
  over: Partial<typeof bioEntities.$inferInsert> = {},
  functions: string[] = [],
): Promise<number> {
  const [row] = await db
    .insert(bioEntities)
    .values({
      slug: over.slug ?? 'cyp3a4',
      symbol: over.symbol ?? 'CYP3A4',
      name: over.name ?? 'Cytokrom P450 3A4',
      nameEn: over.nameEn ?? 'Cytochrome P450 3A4',
      entityClass: over.entityClass ?? 'CYP',
      ...over,
    })
    .returning({ id: bioEntities.id });
  const entityId = row!.id;
  if (functions.length > 0) {
    await db
      .insert(bioEntityFunctions)
      .values(functions.map((fn) => ({ entityId, function: fn })));
  }
  return entityId;
}

/**
 * A citation a reference cohort may actually be admitted under (§13.3, §34.4).
 *
 * Migration 0108 refuses a cohort whose citation is not a currently resolved,
 * admissible publication carrying a read-in-full review, so every atlas fixture
 * needs one — and building it here rather than in each test keeps the gate's
 * shape in one place: a resolved `journal_article` whose examined handle set
 * covers the row's own handle, plus the review §34.4 requires.
 */
export async function seedAdmissibleCitation(
  db: IntegrationDb,
  over: { type?: string; identifier?: string; createdBy?: number } = {},
): Promise<number> {
  const type = over.type ?? 'pmid';
  const identifier = over.identifier ?? '24500275';
  const handle = `${type}:${identifier}`;
  const [citation] = await db
    .insert(citations)
    .values({
      type,
      identifier,
      workKind: 'journal_article',
      workKindStatus: 'resolved',
      workKindHandles: [handle],
      workKindVerdicts: [{ handle, kind: 'journal_article' }],
      workKindResolvedAt: new Date(),
    })
    .returning({ id: citations.id });
  await db.insert(paperReviews).values({
    citationId: citation!.id,
    reviewMarkdown: 'Lest i sin helhet for referansekohorten.',
    readInFull: true,
    createdBy: over.createdBy ?? null,
  });
  return citation!.id;
}
