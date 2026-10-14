/**
 * A resubmitted or revised edit is credited to the run that last moved its
 * submittedAt (#228). The column default only stamps the session on INSERT,
 * so without the re-stamp in the submitter-update path a revision made in a
 * later routine stays credited to the run that first filed it — and drops out
 * of the tier benchmark entirely once that run falls outside its window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/pending-edits.js';
import { agents, pendingEdits, wikiPages } from '../../db/schema.js';
import { setRunSessionId } from '../../db/run-session.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authMock.mockReset();
});

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
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

function createPatchRequest(id: number, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = `/api/pending-edits?id=${id}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

/**
 * PATCH as `userId`. Like the real agent-token branch of getUserFromRequest,
 * the mock records the declared run session (or none) on the request's cell.
 */
async function patchAs(userId: number, runSession: string | null, id: number, body: unknown) {
  authMock.mockImplementation(async () => {
    setRunSessionId(runSession);
    return { userId, role: 'contributor' };
  });
  const { res, state } = createResponse();
  await handler(createPatchRequest(id, body), res);
  return state;
}

async function seedAgent(): Promise<number> {
  const userId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'maintainer-agent',
    role: 'contributor',
  });
  await db
    .insert(agents)
    .values({ userId, name: 'Vedlikeholdsagent', slug: 'vedlikeholdsagent', status: 'active' });
  return userId;
}

/** A returned wiki_fact filed by `submittedBy` during run `run-a`. */
async function seedReturnedFact(submittedBy: number): Promise<{ id: number; citationId: number }> {
  const author = await seedUser(db, { email: 'author@example.com', username: 'author' });
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'a-page',
      title: 'A page',
      content: {},
      pageType: 'drug_monograph',
      status: 'published',
      createdBy: author,
      updatedBy: author,
    })
    .returning({ id: wikiPages.id });
  const citationId = await seedAdmissibleCitation(db, { createdBy: author });
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Opprinnelig påstand.',
      proposedValue: { type: 'fact', attrs: { factId: 'f1', referenceIds: [citationId] } },
      referenceIds: [citationId],
      status: 'returned',
      submittedBy,
      runSessionId: 'run-a',
    })
    .returning({ id: pendingEdits.id });
  return { id: row!.id, citationId };
}

async function stamp(id: number): Promise<string | null> {
  const [row] = await db
    .select({ runSessionId: pendingEdits.runSessionId })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id));
  return row!.runSessionId;
}

describe('PATCH /api/pending-edits — run session stamp', () => {
  it('re-stamps a resubmit with the run that made it', async () => {
    const agent = await seedAgent();
    const { id, citationId } = await seedReturnedFact(agent);

    const state = await patchAs(agent, 'run-b', id, {
      status: 'pending',
      proposedValue: { type: 'fact', attrs: { factId: 'f1', referenceIds: [citationId] } },
    });

    expect(state.statusCode).toBe(200);
    expect(await stamp(id)).toBe('run-b');
  });

  it('clears the stamp when the resubmitting request named no run', async () => {
    // Crediting run-a with a revision it did not make is the error; an
    // unstamped row falls back to the benchmark's time window instead.
    const agent = await seedAgent();
    const { id } = await seedReturnedFact(agent);

    const state = await patchAs(agent, null, id, { status: 'pending' });

    expect(state.statusCode).toBe(200);
    expect(await stamp(id)).toBeNull();
  });

  it('leaves the stamp alone on a withdrawal, which does not move submittedAt', async () => {
    const agent = await seedAgent();
    const { id } = await seedReturnedFact(agent);

    const state = await patchAs(agent, 'run-b', id, {
      status: 'rejected',
      rejectionReason: 'other',
      rejectionComment: 'Trukket.',
    });

    expect(state.statusCode).toBe(200);
    expect(await stamp(id)).toBe('run-a');
  });
});
