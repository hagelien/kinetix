import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  citations,
  drugParameterRevisions,
  paperReviews,
  parameterEntries,
} from '../../db/schema.js';
import { UNREVIEWED_REFERENCES_SQL } from '../../api/agent-sweep.js';
import { findCitationsNeedingFullReview } from '../../api/_lib/reference-review-status.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

/**
 * The agent's follow-up queue (`GET /api/agent-sweep?mode=unreviewed_references`)
 * over real SQL.
 *
 * This executes the **exported** query text rather than a copy, so a change to
 * the query that breaks against the migrated schema fails here instead of first
 * appearing in a scheduled agent run. `listUnreviewedReferences` reaches the
 * database through `getNeonClient()`, which the harness does not seam, so the
 * query is run through the harness's own connection — the SQL under test is
 * identical, only the client differs.
 */

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

async function seedCitation(identifier: string, type = 'doi'): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type, identifier })
    .returning({ id: citations.id });
  return row!.id;
}

async function seedEntry(
  drugId: number,
  parameter: string,
  citationId: number | null,
  unit = 'h',
): Promise<void> {
  // `unit` is NOT NULL at the DB level (the value-shape rules live in Zod).
  await db.insert(parameterEntries).values({
    drugId,
    parameter,
    low: '0.5',
    unit,
    citationId,
  });
}

async function seedRevision(
  drugId: number,
  parameter: string,
  citationId: number,
): Promise<void> {
  // `created_by` is NOT NULL — every revision has an author.
  const userId = await seedUser(db, { email: 'rev@example.com', username: 'rev' });
  await db.insert(drugParameterRevisions).values({
    drugId,
    parameter,
    newValue: { median: 4 } as never,
    referenceIds: [citationId],
    createdBy: userId,
  });
}

async function queueCitationIds(): Promise<number[]> {
  const result = await db.execute<{ citation_id: number }>(
    sql.raw(UNREVIEWED_REFERENCES_SQL),
  );
  const rows = (result as unknown as { rows?: Array<{ citation_id: number }> })
    .rows ?? (result as unknown as Array<{ citation_id: number }>);
  return rows.map((r) => Number(r.citation_id));
}

describe('unreviewed-references queue', () => {
  it('surfaces a citation used only by a parameter entry', async () => {
    // The gap this covers: a non-summarizable parameter (analyteStability)
    // writes NO drug_parameter_revisions row, so before parameter_entries joined the
    // `used` CTE this source was invisible to the agent that is supposed to
    // review it — exactly the follow-up the admin switch's docs promise.
    const drugId = await seedDrug(db);
    const citationId = await seedCitation('10.1000/unreviewed-stability');
    await seedEntry(drugId, 'analyteStability', citationId);

    expect(await queueCitationIds()).toContain(citationId);
  });

  it('drops it again once a read-in-full review lands', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedCitation('10.1000/reviewed-stability');
    await seedEntry(drugId, 'analyteStability', citationId);
    await db.insert(paperReviews).values({
      citationId,
      reviewMarkdown: 'Lest i sin helhet.',
      readInFull: true,
      createdBy: userId,
    });

    expect(await queueCitationIds()).not.toContain(citationId);
  });

  it('still surfaces a citation used only by a parameter revision', async () => {
    // The pre-existing arm must keep working — the new one is additive.
    const drugId = await seedDrug(db);
    const citationId = await seedCitation('10.1000/unreviewed-revision');
    await seedRevision(drugId, 'halfLife', citationId);

    expect(await queueCitationIds()).toContain(citationId);
  });

  it("keeps a reviewed front-page citation in the lane, and its claim flagged", async () => {
    // A front page names no specific source, so a review of it backs nothing:
    // the claim resting on it needs re-citing, and nothing else surfaces it.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const frontPage = await seedCitation('https://www.noklus.no', 'url');
    const specific = await seedCitation('https://www.noklus.no/peth/', 'url');
    for (const citationId of [frontPage, specific]) {
      await seedEntry(drugId, 'analyteStability', citationId);
      await db.insert(paperReviews).values({
        citationId,
        reviewMarkdown: '## Vurdering',
        readInFull: true,
        createdBy: userId,
      });
    }

    const queued = await queueCitationIds();
    expect(queued).toContain(frontPage);
    expect(queued).not.toContain(specific);
    expect(
      await findCitationsNeedingFullReview([frontPage, specific]),
    ).toEqual(new Set([frontPage]));
  });

  it('never surfaces a freetext source — it cannot be reviewed', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedCitation('Personal communication', 'freetext');
    await seedEntry(drugId, 'analyteStability', citationId);

    expect(await queueCitationIds()).not.toContain(citationId);
  });

  it('tolerates an entry authored without a source', async () => {
    // `citation_id` is nullable; the NOT NULL filter must keep those rows from
    // reaching the join as a bogus id.
    const drugId = await seedDrug(db);
    await seedEntry(drugId, 'analyteStability', null);

    expect(await queueCitationIds()).toEqual([]);
  });

  it('lists a citation once even when several claims cite it', async () => {
    // The `used` CTE is SELECT DISTINCT precisely so the new arm cannot
    // double-list a summarizable entry that also appears on a revision.
    const drugId = await seedDrug(db);
    const citationId = await seedCitation('10.1000/cited-twice');
    await seedEntry(drugId, 'therapeuticConcentration', citationId, 'ng/mL');
    await seedRevision(drugId, 'therapeuticConcentration', citationId);

    const ids = await queueCitationIds();
    expect(ids.filter((id) => id === citationId)).toHaveLength(1);
  });
});
