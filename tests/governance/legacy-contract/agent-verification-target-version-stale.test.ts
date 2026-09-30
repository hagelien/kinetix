/**
 * Phase 0 gap 1 (docs/plans/2026-08-26-general-knowledge-governance-
 * extraction.md): `verificationTargetVersion` for `targetType: 'pending_edit'`
 * folds `status` into the token (`${submittedAt}|${status}`), so ANY status
 * transition invalidates a verdict token an agent fetched earlier — not just a
 * payload revision. Only the token's shape was under test before
 * (tests/api/agent-verifications-schema.test.ts); this drives an actual
 * mismatch through the real POST /api/agent-verifications route against real
 * SQL and confirms the stale verdict is refused and never recorded, with a
 * positive control proving the same flow succeeds on a freshly-refetched
 * token.
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
import {
  agentVerifications,
  agents,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import agentVerificationsHandler from '../../../api/agent-verifications.js';
import {
  StaleVerificationTargetError,
  recordVerification,
  verificationTargetVersion,
} from '../../../api/_lib/agent-verifications.js';
import pendingEditsHandler from '../../../api/pending-edits.js';
import { pendingEditReviewToken } from '../../../api/_lib/pending-edit-review-token.js';
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

/**
 * A human-submitted wiki_fact pending edit plus an editor-backed active agent
 * that will verify it. The verifier's backing role is 'editor' (not
 * 'contributor') deliberately: `review.queue.readAll` is what keeps the row
 * VISIBLE to the caller once its status leaves 'pending' (the visibility
 * check runs before the version check in the POST handler), so the stale
 * request reaches the version comparison instead of dying earlier as a 404.
 */
async function seedTargetAndVerifier(): Promise<{
  submitterId: number;
  verifierUserId: number;
  editId: number;
}> {
  const submitterId = await seedUser(db, {
    email: 'submitter@example.com',
    username: 'submitter',
    role: 'contributor',
  });
  const verifierUserId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier',
    role: 'editor',
  });
  await db.insert(agents).values({
    userId: verifierUserId,
    name: 'verifier-agent',
    slug: 'verifier-agent',
    status: 'active',
    selfReviewEnabled: false,
  });

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'lorazepam',
      title: 'Lorazepam',
      pageType: 'topic',
      status: 'published',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2, sectionId: 'overview' },
            content: [{ type: 'text', text: 'Overview' }],
          },
        ],
      },
      createdBy: submitterId,
      updatedBy: submitterId,
    })
    .returning({ id: wikiPages.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'overview',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 10–20 timer.',
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'fact-lorazepam-1', referenceIds: [] },
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Halveringstiden er 10–20 timer.' }],
          },
        ],
      },
      submittedBy: submitterId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  return { submitterId, verifierUserId, editId: edit!.id };
}

async function postVerdict(args: {
  callerUserId: number;
  editId: number;
  targetVersion: string;
}) {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.callerUserId,
    role: 'editor',
  });
  const { res, state } = createResponse();
  await agentVerificationsHandler(
    jsonRequest('POST', '/api/agent-verifications', {
      targetType: 'pending_edit',
      targetId: args.editId,
      targetVersion: args.targetVersion,
      verdict: 'approve',
      rationaleMd: '',
    }),
    res,
  );
  return state;
}

/** Reviewer PATCH that flips the row pending -> returned, via the real route. */
async function returnEditAsReviewer(editId: number): Promise<void> {
  const [edit] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  const reviewerId = await seedUser(db, {
    email: 'reviewer@example.com',
    username: 'reviewer',
    role: 'editor',
  });
  getUserFromRequestMock.mockResolvedValue({ userId: reviewerId, role: 'editor' });
  const { res, state } = createResponse();
  await pendingEditsHandler(
    jsonRequest('PATCH', `/api/pending-edits?id=${editId}`, {
      status: 'returned',
      returnComment: 'Trenger en sekundær kilde.',
      reviewToken: pendingEditReviewToken(edit!),
    }),
    res,
  );
  expect(state.statusCode).toBeLessThan(300);
}

describe('agent-verifications target-version staleness (pending_edit)', () => {
  it('rejects a verdict posted against a token invalidated by a status change', async () => {
    const seeded = await seedTargetAndVerifier();
    const [initialEdit] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, seeded.editId));
    const staleToken = `${initialEdit!.submittedAt.toISOString()}|pending`;

    // The realistic trigger: a reviewer returns the edit, which flips
    // status pending -> returned and so changes the folded version token —
    // no payload revision required.
    await returnEditAsReviewer(seeded.editId);

    const state = await postVerdict({
      callerUserId: seeded.verifierUserId,
      editId: seeded.editId,
      targetVersion: staleToken,
    });

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_verification_target_version_stale',
    });
    const rows = await db.select().from(agentVerifications);
    expect(rows).toHaveLength(0);
  });

  // Positive control: the identical flow with the freshly-refetched token
  // succeeds, so the assertion above isn't vacuously passing (e.g. from a
  // caller-visibility 404 masquerading as "rejected").
  it('accepts the same verdict once the caller refetches the current token', async () => {
    const seeded = await seedTargetAndVerifier();
    await returnEditAsReviewer(seeded.editId);

    const [current] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, seeded.editId));
    const freshToken = `${current!.submittedAt.toISOString()}|${current!.status}`;

    const state = await postVerdict({
      callerUserId: seeded.verifierUserId,
      editId: seeded.editId,
      targetVersion: freshToken,
    });

    expect(state.statusCode).toBeLessThan(300);
    const rows = await db.select().from(agentVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('approve');
    expect(rows[0]!.isImplicit).toBe(false);
  });
});

describe('the version check and the verdict write are one act', () => {
  // The route's 409 above is a check-then-act: it reads
  // `verificationTargetVersion`, then does the author lookup, the self-review
  // rules and the citation resolution before writing. A revision landing in
  // that window used to be admitted, and nothing on the row records which
  // revision was validated — `agent_verifications` has no version column — so
  // the verdict read as a judgment of a payload its author never saw, to every
  // consumer that infers the binding from the write time. The governance
  // mirror is one of those; it is not the only one.
  //
  // The window itself is between two statements of the same request, so what
  // is asserted here is the re-check that closes it: the version the caller
  // validated is confirmed under the source row's lock, inside the write.
  it('refuses a verdict whose target moved after the caller checked it', async () => {
    const seeded = await seedTargetAndVerifier();
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, 'verifier-agent'));
    const queued = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: seeded.editId,
    });
    expect(queued).not.toBeNull();

    // The revision the route's pre-check cannot see, because it already ran.
    await returnEditAsReviewer(seeded.editId);

    await expect(
      recordVerification({
        agentId: agent!.id,
        targetType: 'pending_edit',
        targetId: seeded.editId,
        verdict: 'approve',
        rationaleMd: '',
        evidenceRefs: [],
        expectTargetVersion: queued!,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationTargetError);

    // And nothing was written: a rejected verdict must not leave a row for the
    // mirror to bind, which is the whole point of rejecting it.
    expect(
      await db
        .select({ id: agentVerifications.id })
        .from(agentVerifications)
        .where(eq(agentVerifications.targetId, seeded.editId)),
    ).toEqual([]);
  });

  it('records the verdict when the target has not moved', async () => {
    // The positive control: the re-check must not reject the ordinary case,
    // where nothing happened between the caller's read and the write.
    const seeded = await seedTargetAndVerifier();
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, 'verifier-agent'));
    const queued = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: seeded.editId,
    });

    const { id } = await recordVerification({
      agentId: agent!.id,
      targetType: 'pending_edit',
      targetId: seeded.editId,
      verdict: 'approve',
      rationaleMd: '',
      evidenceRefs: [],
      expectTargetVersion: queued!,
    });
    expect(id).toBeGreaterThan(0);
  });
});
