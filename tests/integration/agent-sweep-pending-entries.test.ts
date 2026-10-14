/**
 * The `param_entry` duplicate-detection lane of
 * `GET /api/agent-sweep?mode=pending_parameters` over real SQL (issue #126).
 *
 * An extractor checks `pendingParameterEntries` before filing a source value so
 * a requeued paper does not file the same reading twice. A create a reviewer
 * returned, or that was pulled back into draft, is still live — PATCH
 * /api/pending-edits resubmits both — so the lane has to list it, or the
 * extractor files an identical second create that sits beside the original
 * once that is resubmitted. It must do so only for the caller's own rows:
 * another author's draft or returned proposal is theirs to revise and is not
 * readable through GET /api/pending-edits, so the sweep must not expose it.
 *
 * Driven through the route handler, so the query under test is the route's own
 * text running against the migrated schema through the `getNeonClient()` shim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import handler from '../../api/agent-sweep.js';
import { agents, pendingEdits } from '../../db/schema.js';
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
  authMock.mockReset();
});

async function seedAgentUser(username: string): Promise<number> {
  const userId = await seedUser(db, {
    email: `${username}@example.com`,
    username,
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId,
    name: username,
    slug: username,
    status: 'active',
  });
  return userId;
}

async function seedEntryCreate(
  drugId: number,
  submittedBy: number,
  status: 'pending' | 'draft' | 'returned' | 'rejected',
): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: 'halfLife',
      proposedValue: {
        op: 'create',
        input: { low: 7.3, unit: 'h' },
      } as never,
      status,
      submittedBy,
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

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

async function sweepEntries(
  drugId: number,
  userId: number,
): Promise<Array<{ id: number; status: string; submitted_by: number }>> {
  authMock.mockResolvedValue({ userId, role: 'contributor' });
  const req = {
    method: 'GET',
    url: `/api/agent-sweep?mode=pending_parameters&targetId=${drugId}&parameter=halfLife`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  expect(state.statusCode).toBe(200);
  return JSON.parse(state.body).pendingParameterEntries;
}

describe('pending_parameters entry lane', () => {
  it("lists the caller's own draft and returned creates with their status", async () => {
    const drugId = await seedDrug(db);
    const me = await seedAgentUser('extractor');
    const returnedId = await seedEntryCreate(drugId, me, 'returned');
    const draftId = await seedEntryCreate(drugId, me, 'draft');
    const pendingId = await seedEntryCreate(drugId, me, 'pending');

    const rows = await sweepEntries(drugId, me);
    const byId = new Map(rows.map((r) => [Number(r.id), r.status]));
    expect(byId.get(returnedId)).toBe('returned');
    expect(byId.get(draftId)).toBe('draft');
    expect(byId.get(pendingId)).toBe('pending');
  });

  it("does not expose another author's draft or returned creates", async () => {
    const drugId = await seedDrug(db);
    const me = await seedAgentUser('extractor');
    const other = await seedAgentUser('sibling');
    const theirDraft = await seedEntryCreate(drugId, other, 'draft');
    const theirReturned = await seedEntryCreate(drugId, other, 'returned');
    const theirPending = await seedEntryCreate(drugId, other, 'pending');

    const ids = (await sweepEntries(drugId, me)).map((r) => Number(r.id));
    // A pending proposal is cross-contributor by design; private states are not.
    expect(ids).toContain(theirPending);
    expect(ids).not.toContain(theirDraft);
    expect(ids).not.toContain(theirReturned);
  });

  it('still omits closed proposals, even the caller\'s own', async () => {
    const drugId = await seedDrug(db);
    const me = await seedAgentUser('extractor');
    const rejectedId = await seedEntryCreate(drugId, me, 'rejected');

    const ids = (await sweepEntries(drugId, me)).map((r) => Number(r.id));
    expect(ids).not.toContain(rejectedId);
  });
});
