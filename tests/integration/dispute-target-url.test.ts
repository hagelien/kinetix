import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  drugParameterDiscussions,
  drugParameterRevisions,
  paperReviews,
  wikiPages,
  wikiRevisions,
} from '../../db/schema.js';
import { disputeTargetUrl } from '../../api/_lib/agent-verifications.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let authorId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authorId = await seedUser(db, { email: 'author@example.com', username: 'author' });
});

describe('disputeTargetUrl over real SQL', () => {
  it('links a pending_edit dispute straight to the review queue by id', async () => {
    expect(
      await disputeTargetUrl({ targetType: 'pending_edit', targetId: 42 }),
    ).toBe('/review?id=42');
  });

  it('links a wiki_revision dispute to the page history, slug URL-encoded', async () => {
    const [page] = await db
      .insert(wikiPages)
      .values({ slug: 'my topic', title: 'My Topic', createdBy: authorId, updatedBy: authorId })
      .returning({ id: wikiPages.id });
    const [rev] = await db
      .insert(wikiRevisions)
      .values({ pageId: page!.id, content: {}, createdBy: authorId })
      .returning({ id: wikiRevisions.id });
    expect(
      await disputeTargetUrl({ targetType: 'wiki_revision', targetId: rev!.id }),
    ).toBe('/wiki/my%20topic/history');
  });

  it('links a drug_parameter_revision dispute to that revision in the parameter’s log', async () => {
    const drugId = await seedDrug(db);
    const [rev] = await db
      .insert(drugParameterRevisions)
      .values({ drugId, parameter: 'halfLife', createdBy: authorId })
      .returning({ id: drugParameterRevisions.id });
    expect(
      await disputeTargetUrl({
        targetType: 'drug_parameter_revision',
        targetId: rev!.id,
      }),
    ).toBe(`/wiki/drug/${drugId}?param=halfLife&view=history&revision=${rev!.id}`);
  });

  it('links a parameter comment to that comment in the parameter’s discussion', async () => {
    const drugId = await seedDrug(db);
    const [row] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId, parameter: 'halfLife', body: 'Source?', createdBy: authorId })
      .returning({ id: drugParameterDiscussions.id });
    expect(
      await disputeTargetUrl({ targetType: 'drug_discussion', targetId: row!.id }),
    ).toBe(`/wiki/drug/${drugId}?param=halfLife&view=discussion&comment=${row!.id}`);
  });

  it('routes a monograph-wide drug discussion to the drug monograph', async () => {
    const drugId = await seedDrug(db);
    const [row] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId, body: 'contested claim', createdBy: authorId })
      .returning({ id: drugParameterDiscussions.id });
    expect(
      await disputeTargetUrl({ targetType: 'drug_discussion', targetId: row!.id }),
    ).toBe(`/wiki/drug/${drugId}`);
  });

  it('routes a topic-page discussion to the wiki page', async () => {
    const [page] = await db
      .insert(wikiPages)
      .values({ slug: 'topic-x', title: 'Topic X', createdBy: authorId, updatedBy: authorId })
      .returning({ id: wikiPages.id });
    const [row] = await db
      .insert(drugParameterDiscussions)
      .values({ wikiPageId: page!.id, body: 'contested claim', createdBy: authorId })
      .returning({ id: drugParameterDiscussions.id });
    expect(
      await disputeTargetUrl({ targetType: 'drug_discussion', targetId: row!.id }),
    ).toBe('/wiki/topic-x');
  });

  it('links a paper_review dispute to the reference page by citation id', async () => {
    const citationId = await seedAdmissibleCitation(db);
    const [review] = await db
      .select({ id: paperReviews.id })
      .from(paperReviews)
      .where(eq(paperReviews.citationId, citationId))
      .limit(1);
    expect(
      await disputeTargetUrl({ targetType: 'paper_review', targetId: review!.id }),
    ).toBe(`/references/${citationId}`);
  });

  it('falls back to /review when the target row is missing', async () => {
    expect(
      await disputeTargetUrl({ targetType: 'wiki_revision', targetId: 999_999 }),
    ).toBe('/review');
  });
});
