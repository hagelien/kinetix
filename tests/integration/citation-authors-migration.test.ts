/**
 * Migration 0087 — legacy string `metadata.authors` on citations.
 *
 * `createReferenceSchema` rejects a comma-separated authors string, so nothing
 * writes one today; rows predating that contract can still carry it, and the
 * read side (`normalizeReferenceMetadata`) drops a non-array value outright.
 * The visible cost is the reference index's author axis: a paper with a known
 * first author files under "Uten forfatter" instead of its surname bucket.
 *
 * The harness truncates every table between tests, so the migration's own pass
 * (which ran against an empty DB) leaves nothing to observe — the real
 * statements are pulled out of the .sql file and re-run against seeded rows,
 * the same approach as the 0078 test, so this cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { citations } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';
import { normalizeReferenceMetadata } from '../../api/_lib/reference-metadata.js';
import {
  authorBucketKey,
  type IndexCitation,
} from '../../api/_lib/reference-index.js';

let db: IntegrationDb;
let userId: number;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0087_citation_authors_array.sql',
);

/** Every statement of the real migration, in order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

/**
 * Insert a citation whose stored `authors` is raw jsonb — the typed Drizzle
 * insert would not let this shape through, which is the whole point: only a
 * row written before the contract existed looks like this.
 */
async function seedRawAuthors(
  identifier: string,
  authorsJson: string,
): Promise<number> {
  const inserted = await db.execute<{ id: number }>(sql`
    INSERT INTO citations (type, identifier, metadata, created_by)
    VALUES (
      'doi',
      ${identifier},
      jsonb_build_object('title', 'A paper', 'authors', ${authorsJson}::jsonb),
      ${userId}
    )
    RETURNING id
  `);
  return inserted.rows[0]!.id;
}

async function metadataOf(id: number): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: citations.metadata })
    .from(citations)
    .where(eq(citations.id, id));
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
});

describe('migration 0087 — citation authors array', () => {
  it('splits a legacy comma-separated list, preserving author order', async () => {
    const id = await seedRawAuthors(
      '10.1000/legacy',
      '"Huertas T, Aasen B, Schmoldt-Andresen S"',
    );

    await runMigration();

    expect((await metadataOf(id)).authors).toEqual([
      'Huertas T',
      'Aasen B',
      'Schmoldt-Andresen S',
    ]);
  });

  it('recovers the author axis bucket the string cost the paper', async () => {
    // The end-to-end point of the migration: before it, the row reaches the
    // index with no authors at all and files under the catch-all bucket.
    const id = await seedRawAuthors('10.1000/bucket', '"Huertas T, Aasen B"');
    const asIndexRow = async (): Promise<IndexCitation> =>
      ({
        id,
        drugId: null,
        type: 'doi',
        identifier: '10.1000/bucket',
        metadata: normalizeReferenceMetadata(await metadataOf(id)),
        createdAt: null,
      }) as IndexCitation;

    expect(authorBucketKey(await asIndexRow())).toBe('unknown');

    await runMigration();

    expect(authorBucketKey(await asIndexRow())).toBe('H');
  });

  it('trims surrounding whitespace and drops empty entries', async () => {
    const id = await seedRawAuthors(
      '10.1000/messy',
      '"  Huertas T ,, Aasen B ,  "',
    );

    await runMigration();

    expect((await metadataOf(id)).authors).toEqual(['Huertas T', 'Aasen B']);
  });

  it('removes an authors key that held no name rather than storing []', async () => {
    const blank = await seedRawAuthors('10.1000/blank', '"  "');
    const commas = await seedRawAuthors('10.1000/commas', '" , , "');

    await runMigration();

    expect(await metadataOf(blank)).not.toHaveProperty('authors');
    expect(await metadataOf(commas)).not.toHaveProperty('authors');
  });

  it('leaves a well-formed array untouched and is idempotent', async () => {
    const modern = await seedRawAuthors(
      '10.1000/modern',
      '["Huertas T", "Aasen B"]',
    );
    const legacy = await seedRawAuthors('10.1000/twice', '"Huertas T, Aasen B"');

    await runMigration();
    const afterFirst = await metadataOf(legacy);
    await runMigration();

    expect((await metadataOf(modern)).authors).toEqual([
      'Huertas T',
      'Aasen B',
    ]);
    expect(await metadataOf(legacy)).toEqual(afterFirst);
  });

  it('leaves the rest of the metadata object alone', async () => {
    const id = await seedRawAuthors('10.1000/rest', '"Huertas T"');

    await runMigration();

    expect((await metadataOf(id)).title).toBe('A paper');
  });

  it('no longer leaves any string authors behind', async () => {
    await seedRawAuthors('10.1000/a', '"Huertas T, Aasen B"');
    await seedRawAuthors('10.1000/b', '" , "');
    await seedRawAuthors('10.1000/c', '["Aasen B"]');

    await runMigration();

    const remaining = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM citations
      WHERE jsonb_typeof(metadata->'authors') = 'string'
    `);
    expect(remaining.rows[0]!.count).toBe(0);
  });
});
