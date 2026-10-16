/**
 * The citation metadata audit trail, against real SQL.
 *
 * `PATCH /api/references` overwrites a citation's cached metadata with no
 * review, so each change is recorded in `citation_metadata_history` in the
 * same transaction as the write, with the value it replaced read from the
 * locked row. A citation merge carries the loser's history to the winner
 * rather than letting the delete cascade erase it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { asc, eq } from 'drizzle-orm';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { citationMetadataHistory, citations } from '../../db/schema.js';
import handler from '../../api/references.js';
import { mergeCitations } from '../../api/_lib/citation-merge.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
  userId = await seedUser(db, { role: 'contributor' });
  getUserFromRequestMock.mockResolvedValue({ userId, role: 'contributor' });
});

async function patchMetadata(id: number, metadata: Record<string, unknown>) {
  const raw = JSON.stringify({ metadata });
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = `/api/references?id=${id}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  let status = 0;
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      status = code;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  await handler(req, res);
  return status;
}

async function history(citationId: number) {
  return db
    .select({
      citationId: citationMetadataHistory.citationId,
      oldTitle: citationMetadataHistory.oldMetadata,
      newTitle: citationMetadataHistory.newMetadata,
      refreshed: citationMetadataHistory.refreshed,
      changedBy: citationMetadataHistory.changedBy,
    })
    .from(citationMetadataHistory)
    .where(eq(citationMetadataHistory.citationId, citationId))
    .orderBy(asc(citationMetadataHistory.id));
}

describe('citation metadata history', () => {
  it('records each direct change with who made it and what it replaced', async () => {
    const [row] = await db
      .insert(citations)
      .values({ type: 'url', identifier: 'https://example.org/label', metadata: { title: 'First' } })
      .returning({ id: citations.id });

    expect(await patchMetadata(row!.id, { title: 'Second' })).toBe(200);
    expect(await patchMetadata(row!.id, { title: 'Third' })).toBe(200);

    const rows = await history(row!.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      oldTitle: { title: 'First' },
      newTitle: expect.objectContaining({ title: 'Second' }),
      refreshed: false,
      changedBy: userId,
    });
    // The second change records what it actually overwrote: the first's value.
    expect(rows[1]!.oldTitle).toMatchObject({ title: 'Second' });
    expect(rows[1]!.newTitle).toMatchObject({ title: 'Third' });
  });

  it('carries a merged-away citation’s history to the surviving citation', async () => {
    const winnerId = await seedAdmissibleCitation(db, {
      type: 'pmid',
      identifier: '24500275',
      createdBy: userId,
    });
    const loserId = await seedAdmissibleCitation(db, {
      type: 'doi',
      identifier: '10.1093/jat/bkt016',
      createdBy: userId,
    });
    await db.insert(citationMetadataHistory).values({
      citationId: loserId,
      oldMetadata: { title: 'Before' },
      newMetadata: { title: 'After' },
      refreshed: false,
      changedBy: userId,
    });

    await mergeCitations(db, winnerId, loserId);

    const rows = await history(winnerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.oldTitle).toMatchObject({ title: 'Before' });
  });
});
