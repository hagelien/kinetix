/**
 * Admin → Merge → Merge citations (`/api/citation-merge`).
 *
 * The case this exists for: one paper filed as several free-text rows whose
 * spellings drift too far apart for the automatic same-work match, each row
 * carrying its own PDF upload request. An admin finds them by search, picks
 * the row to keep, and the rest fold into it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, inArray } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import handler from '../../api/citation-merge.js';
import { resolveCitation } from '../../api/_lib/citation-store.js';
import {
  agents,
  citationIdentifierAliases,
  citations,
  paperExtractionJobs,
  pdfRequests,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;
let adminId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authMock.mockReset();
  adminId = await seedUser(db, { email: 'admin@example.com', username: 'admin', role: 'admin' });
});

function createResponse() {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  auth: { userId: number; role: string } = { userId: adminId, role: 'admin' },
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    ...(raw
      ? {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
        }
      : {}),
  };
  authMock.mockResolvedValue(auth);
  const { res, state } = createResponse();
  await handler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : {} };
}

async function seedCitation(type: string, identifier: string, title: string): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({
      type,
      identifier,
      metadata: { title, authors: ['Schulz M'], year: 2020 },
      createdBy: adminId,
    })
    .returning({ id: citations.id });
  return row!.id;
}

async function seedSchulzSpellings(): Promise<[number, number, number]> {
  const a = await seedCitation(
    'freetext',
    'Schulz M et al. Therapeutic and toxic blood concentrations of more than 800 drugs and other xenobiotics. Crit Care 2012',
    'Therapeutic and toxic blood concentrations of more than 800 drugs and other xenobiotics',
  );
  const b = await seedCitation(
    'freetext',
    'Schulz, M., Iwersen-Bergmann, S., Andresen, H., Schmoldt, A. (2012). Therapeutic and toxic blood concentrations of nearly 1,000 drugs',
    'Therapeutic and toxic blood concentrations of nearly 1,000 drugs and other xenobiotics',
  );
  const c = await seedCitation(
    'freetext',
    'Schulz et al., Crit Care 16:R136',
    'Therapeutic & toxic blood concentrations of >800 drugs and xenobiotics',
  );
  await db.insert(pdfRequests).values([
    { citationId: a, requestedBy: adminId },
    { citationId: b, requestedBy: adminId },
    { citationId: c, requestedBy: adminId },
  ]);
  return [a, b, c];
}

describe('GET /api/citation-merge', () => {
  it('lists every spelling with what hangs off it', async () => {
    const [a, b, c] = await seedSchulzSpellings();
    const res = await call('GET', '/api/citation-merge?q=Schulz', undefined);
    expect(res.status).toBe(200);
    const ids = res.body.candidates.map((row: { id: number }) => row.id);
    expect(ids).toEqual(expect.arrayContaining([a, b, c]));
    const first = res.body.candidates.find((row: { id: number }) => row.id === a);
    expect(first).toMatchObject({ type: 'freetext', pdfRequestStatus: 'open', hasPdf: false });
  });

  it('refuses a caller without the capability', async () => {
    const userId = await seedUser(db, { email: 'c@example.com', username: 'c', role: 'contributor' });
    const res = await call('GET', '/api/citation-merge?q=Schulz', undefined, {
      userId,
      role: 'contributor',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/citation-merge', () => {
  it('folds the duplicates into the kept row, leaving one PDF request', async () => {
    const [a, b, c] = await seedSchulzSpellings();
    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [b, c] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, survivorId: a, deferred: [] });
    expect(res.body.merged.sort()).toEqual([b, c].sort());

    const left = await db
      .select({ id: citations.id })
      .from(citations)
      .where(inArray(citations.id, [a, b, c]));
    expect(left.map((row) => row.id)).toEqual([a]);
    const requests = await db.select().from(pdfRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.citationId).toBe(a);
  });

  it('resolves a merged-away spelling to the kept row instead of recreating it (Codex P1, review comment 4215789765)', async () => {
    const [a, b, c] = await seedSchulzSpellings();
    const [bRow] = await db.select().from(citations).where(eq(citations.id, b));
    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [b, c] });
    expect(res.status).toBe(200);

    const again = await resolveCitation(
      db,
      { type: 'freetext', identifier: bRow!.identifier },
      adminId,
    );
    expect(again).toMatchObject({ id: a, created: false });
    const rows = await db.select({ id: citations.id }).from(citations);
    expect(rows.map((row) => row.id)).toEqual([a]);
  });

  it('carries a loser’s own aliases over when it is folded again', async () => {
    const [a, b, c] = await seedSchulzSpellings();
    const [bRow] = await db.select().from(citations).where(eq(citations.id, b));
    await call('POST', '/api/citation-merge', { survivorId: b, mergeIds: [c] });
    const pmid = await seedCitation('pmid', '22835221', 'Therapeutic and toxic blood concentrations');
    const res = await call('POST', '/api/citation-merge', { survivorId: pmid, mergeIds: [a, b] });
    expect(res.status).toBe(200);

    const aliases = await db.select().from(citationIdentifierAliases);
    expect(aliases.map((alias) => alias.citationId)).toEqual([pmid, pmid, pmid]);
    expect(aliases.map((alias) => alias.identifier)).toContain(bRow!.identifier);
  });

  it('keeps every merged-away URL resolvable, not just the one altIds has room for (Codex P1, review comment 4216786856)', async () => {
    const pmid = await seedCitation('pmid', '22835221', 'Therapeutic and toxic blood concentrations');
    const urls = [
      'https://ccforum.biomedcentral.com/articles/10.1186/cc11441',
      'https://pubmed.ncbi.nlm.nih.gov/22835221/',
      'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3580721/',
    ];
    const urlIds: number[] = [];
    for (const url of urls) urlIds.push(await seedCitation('url', url, 'Therapeutic and toxic'));
    const res = await call('POST', '/api/citation-merge', { survivorId: pmid, mergeIds: urlIds });
    expect(res.status).toBe(200);

    for (const url of urls) {
      const again = await resolveCitation(db, { type: 'url', identifier: url }, adminId);
      expect(again).toMatchObject({ id: pmid, created: false });
    }
    const rows = await db.select({ id: citations.id }).from(citations);
    expect(rows.map((row) => row.id)).toEqual([pmid]);
  });

  it('keeps a loser’s alt ids resolvable when the survivor already holds that type', async () => {
    const pmid = await seedCitation('pmid', '22835221', 'Therapeutic and toxic blood concentrations');
    await db
      .update(citations)
      .set({ metadata: { title: 'Therapeutic', altIds: { doi: '10.1186/cc11441' } } })
      .where(eq(citations.id, pmid));
    const [loser] = await db
      .insert(citations)
      .values({
        type: 'url',
        identifier: 'https://example.org/schulz-2012',
        metadata: { title: 'Therapeutic', altIds: { doi: '10.1186/CC11441-ERRATUM' } },
        createdBy: adminId,
      })
      .returning({ id: citations.id });
    const res = await call('POST', '/api/citation-merge', { survivorId: pmid, mergeIds: [loser!.id] });
    expect(res.status).toBe(200);

    // Case-insensitive, as DOIs are everywhere else in the resolver.
    const again = await resolveCitation(
      db,
      { type: 'doi', identifier: '10.1186/cc11441-erratum' },
      adminId,
    );
    expect(again).toMatchObject({ id: pmid, created: false });
  });

  it('moves the losers’ extraction jobs to the kept row (Codex P1, review comment 4216786848)', async () => {
    const [a, b, c] = await seedSchulzSpellings();
    const [queued] = await db
      .insert(paperExtractionJobs)
      .values({ citationId: b, status: 'queued', requestedBy: adminId })
      .returning({ id: paperExtractionJobs.id });
    const [done] = await db
      .insert(paperExtractionJobs)
      .values({ citationId: c, status: 'completed', requestedBy: adminId, resultSummary: 'Ferdig.' })
      .returning({ id: paperExtractionJobs.id });

    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [b, c] });
    expect(res.status).toBe(200);
    const jobs = await db
      .select({ id: paperExtractionJobs.id, citationId: paperExtractionJobs.citationId, status: paperExtractionJobs.status })
      .from(paperExtractionJobs);
    expect(jobs.sort((x, y) => x.id - y.id)).toEqual([
      { id: queued!.id, citationId: a, status: 'queued' },
      { id: done!.id, citationId: a, status: 'completed' },
    ]);
  });

  it('cancels a loser’s open job when the kept row already has one, rather than deleting it', async () => {
    const [a, b] = await seedSchulzSpellings();
    const [keep] = await db
      .insert(paperExtractionJobs)
      .values({ citationId: a, status: 'queued', requestedBy: adminId })
      .returning({ id: paperExtractionJobs.id });
    const [dup] = await db
      .insert(paperExtractionJobs)
      .values({ citationId: b, status: 'queued', requestedBy: adminId })
      .returning({ id: paperExtractionJobs.id });

    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [b] });
    expect(res.status).toBe(200);
    const [kept] = await db.select().from(paperExtractionJobs).where(eq(paperExtractionJobs.id, keep!.id));
    const [cancelled] = await db.select().from(paperExtractionJobs).where(eq(paperExtractionJobs.id, dup!.id));
    expect(kept).toMatchObject({ citationId: a, status: 'queued' });
    expect(cancelled).toMatchObject({ citationId: a, status: 'cancelled' });
    expect(cancelled!.lastError).toContain('citation_merged');
  });

  it('refuses while a run is extracting a citation that would be folded away', async () => {
    const [a, b] = await seedSchulzSpellings();
    await db.insert(paperExtractionJobs).values({
      citationId: b,
      status: 'claimed',
      requestedBy: adminId,
      claimedBy: adminId,
      claimedAt: new Date(),
      claimToken: 'tok',
      attempts: 1,
    });
    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [b] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('extraction_in_flight');
    const left = await db.select().from(citations).where(eq(citations.id, b));
    expect(left).toHaveLength(1);
  });

  it('keeps the PMID row rather than a free-text one', async () => {
    const [a] = await seedSchulzSpellings();
    const pmid = await seedCitation('pmid', '22835221', 'Therapeutic and toxic blood concentrations');
    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [pmid] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('weaker_survivor');
    const [still] = await db.select().from(citations).where(eq(citations.id, pmid));
    expect(still).toBeDefined();

    const ok = await call('POST', '/api/citation-merge', { survivorId: pmid, mergeIds: [a] });
    expect(ok.status).toBe(200);
    const moved = await db
      .select({ citationId: pdfRequests.citationId })
      .from(pdfRequests)
      .where(inArray(pdfRequests.citationId, [a, pmid]));
    expect(moved).toEqual([{ citationId: pmid }]);
  });

  it('reports rows that are already gone without merging anything', async () => {
    const [a, b] = await seedSchulzSpellings();
    const res = await call('POST', '/api/citation-merge', { survivorId: a, mergeIds: [b, 999999] });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found', missing: [999999] });
    const left = await db.select().from(citations).where(eq(citations.id, b));
    expect(left).toHaveLength(1);
  });

  it('refuses an agent identity even with the admin role', async () => {
    const [a, b] = await seedSchulzSpellings();
    const agentUserId = await seedUser(db, { email: 'agent@example.com', username: 'agent', role: 'admin' });
    await db.insert(agents).values({ userId: agentUserId, name: 'Agent', slug: 'agent', status: 'active' });
    const res = await call(
      'POST',
      '/api/citation-merge',
      { survivorId: a, mergeIds: [b] },
      { userId: agentUserId, role: 'admin' },
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_refused');
  });
});
