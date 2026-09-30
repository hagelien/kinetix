/**
 * Wiki search — drug monographs must be findable by the linked drug's search
 * key (Norwegian name / English name / alias), not just their (often stale or
 * English-only) title. This mirrors the agent-focus page picker bug: searching
 * "kokain" surfaced the drug in the Ctrl+K general search (which matches
 * `drugs.search_key`) but not in `/api/wiki/search`, which only did English FTS
 * over the monograph title + content.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { wikiPages } from '../../db/schema.js';
import searchHandler from '../../api/wiki/search.ts';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

async function search(q: string): Promise<Array<{ title: string; slug: string; pageType: string }>> {
  const { res, state } = createResponse();
  await searchHandler(createRequest(`/api/wiki/search?q=${encodeURIComponent(q)}&limit=8`), res);
  expect(state.statusCode).toBe(200);
  return JSON.parse(state.body).results;
}

describe('wiki search — drug monographs are findable by search key', () => {
  it('finds a monograph by the drug\'s Norwegian name even when the title is English', async () => {
    const userId = await seedUser(db);
    // A legacy monograph whose title never got re-synced from "Cocaine" to the
    // Norwegian primary name — the exact shape that broke the agent-focus picker.
    const drugId = await seedDrug(db, {
      slug: 'cocaine',
      names: { nb: 'Kokain', en: 'Cocaine' },
      aliases: ['coke', 'snow'],
      searchKey: 'kokain\tcocaine\tcoke\tsnow',
    });
    await db.insert(wikiPages).values({
      slug: 'cocaine-monograph',
      title: 'Cocaine',
      contentPlaintext: '',
      pageType: 'drug_monograph',
      drugCid: drugId,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });

    const results = await search('kokain');
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain('cocaine-monograph');
  });

  it('finds a monograph by a drug alias / street name', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, {
      slug: 'cocaine',
      names: { nb: 'Kokain', en: 'Cocaine' },
      aliases: ['coke', 'snow'],
      searchKey: 'kokain\tcocaine\tcoke\tsnow',
    });
    await db.insert(wikiPages).values({
      slug: 'cocaine-monograph',
      title: 'Cocaine',
      contentPlaintext: '',
      pageType: 'drug_monograph',
      drugCid: drugId,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });

    const results = await search('coke');
    expect(results.map((r) => r.slug)).toContain('cocaine-monograph');
  });

  it('ranks the name-matched monograph ahead of a mere content mention', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, {
      slug: 'cocaine',
      names: { nb: 'Kokain', en: 'Cocaine' },
      searchKey: 'kokain\tcocaine',
    });
    await db.insert(wikiPages).values([
      {
        slug: 'cocaine-monograph',
        title: 'Cocaine',
        contentPlaintext: '',
        pageType: 'drug_monograph',
        drugCid: drugId,
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      },
      {
        // A topic page that merely mentions kokain in its body would win on
        // FTS rank alone; the name-match boost must float the monograph above it.
        slug: 'some-topic',
        title: 'Rusmidler',
        contentPlaintext: 'kokain kokain kokain er et sentralstimulerende middel',
        pageType: 'topic',
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      },
    ]);

    const results = await search('kokain');
    expect(results[0]?.slug).toBe('cocaine-monograph');
  });

  it('does not surface unrelated drug monographs', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, {
      slug: 'paracetamol',
      names: { nb: 'Paracetamol', en: 'Acetaminophen' },
      searchKey: 'paracetamol\tacetaminophen',
    });
    await db.insert(wikiPages).values({
      slug: 'paracetamol-monograph',
      title: 'Paracetamol',
      contentPlaintext: '',
      pageType: 'drug_monograph',
      drugCid: drugId,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });

    const results = await search('kokain');
    expect(results.map((r) => r.slug)).not.toContain('paracetamol-monograph');
  });
});
