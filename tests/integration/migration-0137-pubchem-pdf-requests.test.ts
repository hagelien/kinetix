/**
 * Migration 0137 — cancel PDF requests filed against PubChem record URLs.
 *
 * A PubChem record is a public database entry the agents read through its open
 * data service, so an open request for one asks a contributor for a PDF that
 * does not exist. The tests pin the WHERE clause's edges: only open requests,
 * only PubChem URLs, and never a citation whose full text is already stored.
 * The harness truncates every table between tests, so the real statement is
 * re-run from the .sql file against seeded rows (as in the 0117 test).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { citationPdfs, citations, pdfRequests } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0137_cancel_pubchem_pdf_requests.sql',
);

async function runMigration(): Promise<void> {
  for (const statement of readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }
}

async function seedRequest(
  identifier: string,
  type: 'url' | 'doi' = 'url',
  status: 'open' | 'fulfilled' = 'open',
): Promise<number> {
  const [citation] = await db
    .insert(citations)
    .values({ type, identifier })
    .returning({ id: citations.id });
  await db
    .insert(pdfRequests)
    .values({ citationId: citation!.id, status, requestedBy: userId });
  return citation!.id;
}

async function statusOf(citationId: number): Promise<string | undefined> {
  const [row] = await db
    .select({ status: pdfRequests.status })
    .from(pdfRequests)
    .where(eq(pdfRequests.citationId, citationId));
  return row?.status;
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

describe('migration 0137', () => {
  it('cancels open requests for PubChem record URLs', async () => {
    const compound = await seedRequest(
      'https://pubchem.ncbi.nlm.nih.gov/compound/115237',
    );
    const named = await seedRequest(
      ' HTTPS://pubchem.ncbi.nlm.nih.gov/compound/paliperidone ',
    );

    await runMigration();

    expect(await statusOf(compound)).toBe('cancelled');
    expect(await statusOf(named)).toBe('cancelled');
  });

  it('leaves other citations, settled requests and stored full text alone', async () => {
    const paper = await seedRequest('https://example.org/paper.pdf');
    const doi = await seedRequest('10.1111/bph.12295', 'doi');
    const fulfilled = await seedRequest(
      'https://pubchem.ncbi.nlm.nih.gov/compound/1',
      'url',
      'fulfilled',
    );
    const stored = await seedRequest(
      'https://pubchem.ncbi.nlm.nih.gov/compound/2',
    );
    await db.insert(citationPdfs).values({
      citationId: stored,
      blobPathname: `citations/${stored}.pdf`,
      blobUrl: `https://blob.example/${stored}.pdf`,
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
      uploadedBy: userId,
    });

    await runMigration();

    expect(await statusOf(paper)).toBe('open');
    expect(await statusOf(doi)).toBe('open');
    expect(await statusOf(fulfilled)).toBe('fulfilled');
    expect(await statusOf(stored)).toBe('open');
  });
});
