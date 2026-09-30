/**
 * `agents.self_review_enabled` — the Admin → Agents switch that lets one
 * named agent review its own work in the review queue.
 *
 * This runs against real SQL because the feature is a chain of gates in three
 * different files, and any one of them left in place makes the switch inert
 * while still looking enabled in the admin panel. In order, a self-verdict has
 * to pass: `visibleVerificationTargetIds` (which hides an agent's own pending
 * edits from it), the `agent_verification_self_not_allowed` block in the POST
 * handler, and the `(agent, target)` upsert that has to land on top of the
 * implicit-approve row rather than beside it. Mocked unit tests stub the first
 * of those, so they cannot see it swallow the request.
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

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import handler from '../../api/agent-verifications.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

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

/** One agent, one published page, one pending edit that agent submitted. */
async function seedSelfSubmittedEdit(selfReviewEnabled: boolean): Promise<{
  agentUserId: number;
  agentId: number;
  editId: number;
  submittedAt: Date;
}> {
  const agentUserId = await seedUser(db, {
    email: 'solo@example.com',
    username: 'solo-agent',
    role: 'contributor',
  });
  const [agentRow] = await db
    .insert(agents)
    .values({
      userId: agentUserId,
      name: 'solo-agent',
      slug: 'solo-agent',
      status: 'active',
      selfReviewEnabled,
    })
    .returning({ id: agents.id });

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      status: 'published',
      createdBy: agentUserId,
      updatedBy: agentUserId,
    })
    .returning({ id: wikiPages.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 20–100 timer.',
      proposedValue: { factStatement: 'Halveringstiden er 20–100 timer.' },
      submittedBy: agentUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id, submittedAt: pendingEdits.submittedAt });

  // The stake the submit path stamps on every agent submission. Its presence
  // is what makes the (agent, target) slot already occupied.
  await db.insert(agentVerifications).values({
    agentId: agentRow!.id,
    targetType: 'pending_edit',
    targetId: edit!.id,
    verdict: 'approve',
    rationaleMd: '',
    evidenceRefs: [],
    isImplicit: true,
  });

  return {
    agentUserId,
    agentId: agentRow!.id,
    editId: edit!.id,
    submittedAt: edit!.submittedAt,
  };
}

async function postVerdict(args: {
  callerUserId: number;
  targetId: number;
  targetVersion: string;
  verdict: 'approve' | 'dispute' | 'abstain';
  rationaleMd: string;
  disputedClaim?: string;
}) {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.callerUserId,
    role: 'contributor',
  });
  const body = JSON.stringify({
    targetType: 'pending_edit',
    targetId: args.targetId,
    targetVersion: args.targetVersion,
    verdict: args.verdict,
    rationaleMd: args.rationaleMd,
    ...(args.disputedClaim !== undefined
      ? { disputedClaim: args.disputedClaim }
      : {}),
  });
  const req = Readable.from([body]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/agent-verifications';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  const { res, state } = createResponse();
  await handler(req, res);
  return state;
}

describe('agent self-review (agents.self_review_enabled)', () => {
  it('refuses a verdict on the agent’s own edit by default', async () => {
    const seeded = await seedSelfSubmittedEdit(false);

    const state = await postVerdict({
      callerUserId: seeded.agentUserId,
      targetId: seeded.editId,
      targetVersion: `${seeded.submittedAt.toISOString()}|pending`,
      verdict: 'approve',
      rationaleMd: 'Kontrollert mot primærkilden.',
    });

    // Refused, and no explicit verdict recorded. The status is whichever gate
    // fires first — today the visibility filter (404), not the POST handler's
    // 403 — so assert the refusal and the absence of a verdict rather than
    // pinning which layer caught it.
    expect(state.statusCode).toBeGreaterThanOrEqual(400);
    const rows = await db.select().from(agentVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isImplicit).toBe(true);
  });

  it('accepts a verdict on its own edit once self-review is enabled', async () => {
    const seeded = await seedSelfSubmittedEdit(true);

    const state = await postVerdict({
      callerUserId: seeded.agentUserId,
      targetId: seeded.editId,
      targetVersion: `${seeded.submittedAt.toISOString()}|pending`,
      verdict: 'approve',
      rationaleMd: 'Kontrollert mot primærkilden på nytt.',
    });

    expect(state.statusCode).toBeLessThan(400);
    // Upserted onto the implicit row's slot, not added beside it: the agent
    // holds one verdict per target, so its stake is never counted twice.
    const rows = await db.select().from(agentVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isImplicit).toBe(false);
    expect(rows[0]!.rationaleMd).toContain('primærkilden');

    // Whether that approval then publishes is the consensus path's decision,
    // covered in tests/api/agent-consensus-autoapply-gates.test.ts — this
    // fixture's wiki_fact has no real anchor on the page, so the apply is
    // declined and the row stays queued. What matters here is that the verdict
    // was accepted and counted at all.
  });

  // Everything the grant buys — carrying consensus alone, and the level-2
  // evidence bonus — rests on the verdict being a SECOND act: a reasoned
  // re-check, not the submit-time stake wearing heavier clothes. An empty
  // approve is exactly that stake again, and the schema lets it through
  // because it only demands a rationale for dispute/abstain.
  it('refuses a self-approval with no rationale', async () => {
    const seeded = await seedSelfSubmittedEdit(true);

    const state = await postVerdict({
      callerUserId: seeded.agentUserId,
      targetId: seeded.editId,
      targetVersion: `${seeded.submittedAt.toISOString()}|pending`,
      verdict: 'approve',
      rationaleMd: '',
    });

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_verification_self_approval_needs_rationale',
    });
    // The stake is untouched — nothing was promoted to an explicit verdict.
    const rows = await db.select().from(agentVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isImplicit).toBe(true);
  });

  it('refuses a self-approval whose rationale is only whitespace', async () => {
    const seeded = await seedSelfSubmittedEdit(true);

    const state = await postVerdict({
      callerUserId: seeded.agentUserId,
      targetId: seeded.editId,
      targetVersion: `${seeded.submittedAt.toISOString()}|pending`,
      verdict: 'approve',
      rationaleMd: '                         ',
    });

    expect(state.statusCode).toBe(400);
  });

  it('records a dispute against its own edit — the useful half of the grant', async () => {
    const seeded = await seedSelfSubmittedEdit(true);

    const state = await postVerdict({
      callerUserId: seeded.agentUserId,
      targetId: seeded.editId,
      targetVersion: `${seeded.submittedAt.toISOString()}|pending`,
      verdict: 'dispute',
      rationaleMd: 'Kilden oppgir 20–50 timer, ikke 20–100.',
      disputedClaim: 'Halveringstiden er 20–100 timer',
    });

    expect(state.statusCode).toBeLessThan(400);
    const rows = await db.select().from(agentVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('dispute');
    // The quoted claim leads the stored rationale for the moderator.
    expect(rows[0]!.rationaleMd).toContain('> Halveringstiden er 20–100 timer');
    expect(rows[0]!.rationaleMd).toContain('Kilden oppgir 20–50 timer');
    // A dispute holds the edit for a human; it must not have been applied.
    const [edit] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, seeded.editId));
    expect(edit!.status).toBe('pending');
  });

  it('refuses a dispute whose quoted claim is not in the target (#1357)', async () => {
    const seeded = await seedSelfSubmittedEdit(true);

    const state = await postVerdict({
      callerUserId: seeded.agentUserId,
      targetId: seeded.editId,
      targetVersion: `${seeded.submittedAt.toISOString()}|pending`,
      verdict: 'dispute',
      rationaleMd: 'Forslaget later som 8,17 er stoffets eneste pKa.',
      disputedClaim: '8,17 er stoffets eneste pKa',
    });

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_verification_disputed_claim_not_found',
    });
    const rows = await db.select().from(agentVerifications);
    expect(rows.some((r) => r.verdict === 'dispute')).toBe(false);
  });
});
