/**
 * An agent moderator cannot decide a proposal held for T3 adjudication, even
 * when the hold appears between its early check and its write (issue 17,
 * PR #291 review). Each decision write re-reads the hold under the
 * pending-edit row lock — the lock an adjudication request takes — so a
 * request that commits in between is seen. The interleaving is forced
 * deterministically: the request is recorded right after the route's first
 * (unlocked) read of the hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';

const { authMock, afterHoldRead } = vi.hoisted(() => ({
  authMock: vi.fn(),
  // Runs once, right after the route's first read of the T3 hold returns.
  afterHoldRead: { hook: null as null | (() => Promise<void>) },
}));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));
vi.mock('../../api/_lib/agent-verifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_lib/agent-verifications.js')>();
  return {
    ...actual,
    pendingEditAwaitsAdjudication: async (id: number) => {
      const held = await actual.pendingEditAwaitsAdjudication(id);
      const hook = afterHoldRead.hook;
      afterHoldRead.hook = null;
      await hook?.();
      return held;
    },
  };
});

import handler from '../../api/pending-edits.js';
import { adjudicationRequests, agents, pendingEdits, wikiPages } from '../../db/schema.js';
import { pendingEditReviewToken } from '../../api/_lib/pending-edit-review-token.js';
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
  afterHoldRead.hook = null;
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

async function patchAs(userId: number, id: number, body: unknown) {
  authMock.mockResolvedValue({ userId, role: 'editor' });
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = `/api/pending-edits?id=${id}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  const { res, state } = createResponse();
  await handler(req, res);
  return state;
}

async function seedAgent(slug: string) {
  const userId = await seedUser(db, { email: `${slug}@example.com`, username: slug, role: 'editor' });
  await db.insert(agents).values({ userId, name: slug, slug, status: 'active' });
  return userId;
}

/** A pending fact an agent proposed, and an editor-role agent to moderate it. */
async function seedHeldCandidate() {
  const author = await seedAgent('author-agent');
  const moderator = await seedAgent('moderator-agent');
  const person = await seedUser(db, { email: 'ed@example.com', username: 'ed', role: 'editor' });
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      content: { version: 2, sections: { pk: { body: { type: 'doc', content: [] } } } },
      pageType: 'drug_monograph',
      status: 'published',
      createdBy: person,
      updatedBy: person,
    })
    .returning({ id: wikiPages.id });
  const citationId = await seedAdmissibleCitation(db, { createdBy: person });
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 20–100 timer.',
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f1', referenceIds: [citationId] },
        content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }],
      },
      referenceIds: [citationId],
      status: 'pending',
      submittedBy: author,
    })
    .returning();
  // A person's request for an adjudication commits in the window between the
  // route's early read of the hold and its write.
  afterHoldRead.hook = async () => {
    await db.insert(adjudicationRequests).values({
      targetType: 'pending_edit',
      targetId: edit!.id,
      targetVersion: `${edit!.submittedAt.toISOString()}|pending`,
      requestedBy: person,
      reasonMd: 'Ønsker en T3-vurdering før dette avgjøres.',
    });
  };
  return { edit: edit!, moderator };
}

describe('agent moderation of a proposal held for T3 adjudication', () => {
  it.each([
    ['approved', {}],
    ['rejected', { rejectionReason: 'low_quality' }],
    ['returned', { returnComment: 'Trenger en kilde til.' }],
  ] as const)(
    'refuses an agent’s %s when a request lands after its first check',
    async (status, extra) => {
      const { edit, moderator } = await seedHeldCandidate();
      const state = await patchAs(moderator, edit.id, {
        status,
        ...extra,
        reviewToken: pendingEditReviewToken(edit as never),
      });
      expect(state.statusCode).toBe(409);
      expect(JSON.parse(state.body)).toMatchObject({
        code: 'agent_moderation_held_for_adjudication',
      });
      const [row] = await db.select().from(pendingEdits).where(eq(pendingEdits.id, edit.id));
      expect(row!.status).toBe('pending');
    },
  );
});
