/**
 * Phase 0 gap 3 (docs/plans/2026-08-26-general-knowledge-governance-
 * extraction.md): individual guards on the pending-edit review cycle are well
 * covered (tests/api/pending-edits-review-status.test.ts,
 * tests/api/pending-edits-conflict-preservation.test.ts), but no test walks
 * the full arc — submit -> return -> submitter revises -> resubmit -> fresh
 * review token -> reviewer approves — in one flow against the real route and
 * real SQL.
 *
 * Fixture: wiki_fact on a topic page, matching the fixture the mocked
 * review-status tests already use as their go-to edit type. The "revision"
 * step changes `referenceIds` rather than the fact's text: for `wiki_fact`
 * add/replace, `factStatement` is a submit-time-fixed column
 * (materializePatchedWikiFactProposedValue re-derives proposedValue from the
 * stored factStatement on every submitter PATCH — see api/pending-edits.ts),
 * so the only PATCH-able payload change available to a submitter is its
 * references. That is still a genuine content change: it moves the payload
 * fingerprint, which is exactly what stamps `proposedMeta.revisedAt` and
 * mints a fresh review token — the two things this test is proving.
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
import { eq } from 'drizzle-orm';
import { citations, pendingEdits, wikiPages } from '../../../db/schema.js';
import pendingEditsHandler from '../../../api/pending-edits.js';
import { pendingEditReviewToken } from '../../../api/_lib/pending-edit-review-token.js';
import { createFactNode } from '../../../src/lib/monographContent.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
});

function createResponse() {
  const state = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

function jsonRequest(method: string, url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

async function readEdit(id: number) {
  const [row] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id));
  return row!;
}

async function patchAs(
  userId: number,
  role: string,
  editId: number,
  body: unknown,
) {
  getUserFromRequestMock.mockResolvedValue({ userId, role });
  const { res, state } = createResponse();
  await pendingEditsHandler(
    jsonRequest('PATCH', `/api/pending-edits?id=${editId}`, body),
    res,
  );
  return state;
}

describe('pending edit return -> revise -> resubmit -> re-review lifecycle', () => {
  it('carries a wiki_fact through the full arc and refuses the stale token at resubmit', async () => {
    const factStatement = 'Distribusjonsvolumet er ca. 1 L/kg.';
    const submitterId = await seedUser(db, {
      email: 'submitter@example.com',
      username: 'submitter',
      role: 'contributor',
    });
    const reviewerId = await seedUser(db, {
      email: 'reviewer@example.com',
      username: 'reviewer',
      role: 'editor',
    });
    const [citationA] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/lifecycle-a', metadata: {} })
      .returning({ id: citations.id });
    const [citationB] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/lifecycle-b', metadata: {} })
      .returning({ id: citations.id });

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'midazolam',
        title: 'Midazolam',
        pageType: 'topic',
        status: 'published',
        content: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2, sectionId: 'pk' },
              content: [{ type: 'text', text: 'Farmakokinetikk' }],
            },
          ],
        },
        createdBy: submitterId,
        updatedBy: submitterId,
      })
      .returning({ id: wikiPages.id });

    const [inserted] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: page!.id,
        sectionId: 'pk',
        factOperation: 'add',
        factStatement,
        proposedValue: createFactNode({
          factId: 'fact-midazolam-vd',
          statement: factStatement,
          referenceIds: [citationA!.id],
        }) as never,
        referenceId: citationA!.id,
        referenceIds: [citationA!.id],
        submittedBy: submitterId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    const editId = inserted!.id;

    // 1. Reviewer returns it.
    const submitted = await readEdit(editId);
    const returned = await patchAs(reviewerId, 'editor', editId, {
      status: 'returned',
      returnComment: 'Oppgi en andre kilde for volumestimatet.',
      reviewToken: pendingEditReviewToken(submitted),
    });
    expect(returned.statusCode).toBeLessThan(300);
    const afterReturn = await readEdit(editId);
    expect(afterReturn.status).toBe('returned');
    const staleReviewToken = pendingEditReviewToken(afterReturn);

    // 2. The original submitter revises (swaps the reference) and resubmits.
    const resubmitted = await patchAs(submitterId, 'contributor', editId, {
      referenceIds: [citationB!.id],
      status: 'pending',
    });
    expect(resubmitted.statusCode).toBeLessThan(300);
    const afterResubmit = await readEdit(editId);
    expect(afterResubmit.status).toBe('pending');
    expect(afterResubmit.referenceIds).toEqual([citationB!.id]);
    // The revision marker moved — proof this PATCH counted as a real
    // revision, not just a status bounce.
    const meta = afterResubmit.proposedMeta as { revisedAt?: string } | null;
    expect(typeof meta?.revisedAt).toBe('string');
    // The resubmit re-stamped submittedAt, so the review token a reviewer
    // captured before it (the return-time snapshot) is now a different string.
    const freshReviewToken = pendingEditReviewToken(afterResubmit);
    expect(freshReviewToken).not.toBe(staleReviewToken);

    // 3. Approving with the OLD (pre-revision) token is refused...
    const staleApprove = await patchAs(reviewerId, 'editor', editId, {
      status: 'approved',
      reviewToken: staleReviewToken,
    });
    expect(staleApprove.statusCode).toBe(409);
    expect(JSON.parse(staleApprove.body)).toMatchObject({
      code: 'pending_edit_review_token_mismatch',
    });
    expect((await readEdit(editId)).status).toBe('pending');

    // 4. ...but with the fresh token, review succeeds and the edit publishes.
    const approved = await patchAs(reviewerId, 'editor', editId, {
      status: 'approved',
      reviewToken: freshReviewToken,
    });
    expect(approved.statusCode).toBeLessThan(300);
    const final = await readEdit(editId);
    expect(final.status).toBe('approved');

    const [publishedPage] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages)
      .where(eq(wikiPages.id, page!.id));
    const plaintext = JSON.stringify(publishedPage!.content);
    expect(plaintext).toContain('Distribusjonsvolumet');
  });
});
