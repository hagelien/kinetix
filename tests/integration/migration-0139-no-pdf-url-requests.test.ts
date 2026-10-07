/**
 * Migration 0139 — cancel PDF requests for URL citations no PDF can satisfy:
 * public database records beyond PubChem, and a site's front page.
 *
 * The pattern itself is pinned against the TypeScript classifier in
 * tests/no-pdf-url.test.ts; these tests pin the statement's other edges under
 * PostgreSQL — only open requests, only those URL shapes, never a citation
 * whose full text is already stored. The harness truncates every table between
 * tests, so the real statement is re-run from the .sql file (as in 0137).
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
  '../../drizzle/0139_cancel_no_pdf_url_requests.sql',
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
  status: 'open' | 'fulfilled' = 'open',
): Promise<number> {
  const [citation] = await db
    .insert(citations)
    .values({ type: 'url', identifier })
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

describe('migration 0139', () => {
  it('cancels open requests for database records and front pages', async () => {
    const cancelled = [
      await seedRequest('https://go.drugbank.com/drugs/DB00820'),
      await seedRequest(
        'https://www.ebi.ac.uk/chembl/compound_report_card/CHEMBL160/',
      ),
      await seedRequest('https://www.chemspider.com/Chemical-Structure.26250.html'),
      await seedRequest(
        'https://www.guidetopharmacology.org/GRAC/LigandDisplayForward?ligandId=1627',
      ),
      await seedRequest(
        'https://www.lipidmaps.org/data/structure/LMSDRecord.php?LM_ID=LMGP02050001',
      ),
      await seedRequest(' https://www.noklus.no '),
      await seedRequest('https://www.ebi.ac.uk/chembl/'),
    ];

    await runMigration();

    for (const id of cancelled) expect(await statusOf(id)).toBe('cancelled');
  });

  it('leaves documents, settled requests and stored full text alone', async () => {
    const report = await seedRequest(
      'https://www.who.int/publications/m/item/protonitazene-critical-review-report',
    );
    const label = await seedRequest(
      'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=a00e5720',
    );
    const fulfilled = await seedRequest(
      'https://go.drugbank.com/drugs/DB00497',
      'fulfilled',
    );
    const stored = await seedRequest('https://www.noklus.no/');
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

    expect(await statusOf(report)).toBe('open');
    expect(await statusOf(label)).toBe('open');
    expect(await statusOf(fulfilled)).toBe('fulfilled');
    expect(await statusOf(stored)).toBe('open');
  });
});
