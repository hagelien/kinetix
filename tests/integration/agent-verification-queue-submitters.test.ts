/**
 * Who a pending edit came from must not decide whether agents can see it.
 *
 * The queue used to require an active-agent submitter, so a human
 * contributor's proposal was invisible to every agent: nothing corroborated
 * it, nothing disputed it, and it sat in the moderator queue until a human
 * happened to look — two wiki_fact proposals waited a week that way. The SQL
 * that enforced it lived in a raw `exists (...)` fragment the mocked unit
 * suite never executes, which is why this guard runs against real SQL.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import {
  agentVerifications,
  agents,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import handler from '../../api/agent-verifications-queue.js';
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

async function seedAgent(
  userId: number,
  slug: string,
  status = 'active',
  selfReviewEnabled = false,
): Promise<number> {
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status, selfReviewEnabled })
    .returning({ id: agents.id });
  return row!.id;
}

async function seedWikiFactEdit(
  submittedBy: number,
  pageId: number,
  statement: string,
): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: pageId,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: statement,
      proposedValue: { factStatement: statement },
      submittedBy,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

async function queuedPendingEditIds(callerUserId: number): Promise<number[]> {
  getUserFromRequestMock.mockResolvedValue({
    userId: callerUserId,
    role: 'contributor',
  });
  const req = {
    method: 'GET',
    url: '/api/agent-verifications-queue?targetType=pending_edit&minAgeMinutes=0',
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  expect(state.statusCode).toBe(200);
  return (
    JSON.parse(state.body).items as Array<{ targetId: number }>
  ).map((i) => i.targetId);
}

describe('agent verification queue — pending_edit submitters', () => {
  it('queues human- and agent-submitted edits alike, minus the caller’s own', async () => {
    const humanId = await seedUser(db, {
      email: 'human@example.com',
      username: 'human',
      role: 'contributor',
    });
    const verifierId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier-agent',
      role: 'contributor',
    });
    const peerId = await seedUser(db, {
      email: 'peer@example.com',
      username: 'peer-agent',
      role: 'contributor',
    });
    await seedAgent(verifierId, 'verifier-agent');
    await seedAgent(peerId, 'peer-agent');

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'oxazepam',
        title: 'Oxazepam',
        status: 'published',
        createdBy: humanId,
        updatedBy: humanId,
      })
      .returning({ id: wikiPages.id });

    const humanEdit = await seedWikiFactEdit(
      humanId,
      page!.id,
      'Menneskeinnsendt faktum om oksazepam.',
    );
    const peerEdit = await seedWikiFactEdit(
      peerId,
      page!.id,
      'Agentinnsendt faktum om oksazepam.',
    );
    const ownEdit = await seedWikiFactEdit(
      verifierId,
      page!.id,
      'Eget faktum — skal aldri komme i egen kø.',
    );

    const queued = await queuedPendingEditIds(verifierId);

    expect(queued).toContain(humanEdit);
    expect(queued).toContain(peerEdit);
    expect(queued).not.toContain(ownEdit);
  });

  it('still queues a human edit when no other agent is active', async () => {
    const humanId = await seedUser(db, {
      email: 'human@example.com',
      username: 'human',
      role: 'contributor',
    });
    const verifierId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier-agent',
      role: 'contributor',
    });
    await seedAgent(verifierId, 'verifier-agent');

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'amfetamin',
        title: 'Amfetamin',
        status: 'published',
        createdBy: humanId,
        updatedBy: humanId,
      })
      .returning({ id: wikiPages.id });

    const humanEdit = await seedWikiFactEdit(
      humanId,
      page!.id,
      'Menneskeinnsendt faktum om amfetamin.',
    );

    expect(await queuedPendingEditIds(verifierId)).toEqual([humanEdit]);
  });

  it('keeps drafts against unpublished pages out, whoever submitted them', async () => {
    const humanId = await seedUser(db, {
      email: 'human@example.com',
      username: 'human',
      role: 'contributor',
    });
    const verifierId = await seedUser(db, {
      email: 'verifier@example.com',
      username: 'verifier-agent',
      role: 'contributor',
    });
    await seedAgent(verifierId, 'verifier-agent');

    const [draftPage] = await db
      .insert(wikiPages)
      .values({
        slug: 'utkast',
        title: 'Utkast',
        status: 'draft',
        createdBy: humanId,
        updatedBy: humanId,
      })
      .returning({ id: wikiPages.id });

    await seedWikiFactEdit(
      humanId,
      draftPage!.id,
      'Faktum mot upublisert side.',
    );

    expect(await queuedPendingEditIds(verifierId)).toEqual([]);
  });

  // agents.self_review_enabled — the admin-panel switch. Two SQL fragments
  // have to give way together for it to mean anything, and both live in raw
  // `not exists (...)`/predicate builders the mocked unit suite never
  // executes: the author-exclusion filter AND the already-verified NOT EXISTS,
  // which the submitter's implicit-approve row would otherwise trip on every
  // row the agent wrote. Fixing only the first leaves the feature silently
  // inert, which is exactly the failure this runs against real SQL to catch.
  it('queues the agent’s own edits once self-review is enabled', async () => {
    const soloId = await seedUser(db, {
      email: 'solo@example.com',
      username: 'solo-agent',
      role: 'contributor',
    });
    const agentId = await seedAgent(soloId, 'solo-agent', 'active', true);

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        status: 'published',
        createdBy: soloId,
        updatedBy: soloId,
      })
      .returning({ id: wikiPages.id });

    const ownEdit = await seedWikiFactEdit(
      soloId,
      page!.id,
      'Eget faktum om diazepam.',
    );
    // The stake the API stamps on every agent submission.
    await db.insert(agentVerifications).values({
      agentId,
      targetType: 'pending_edit',
      targetId: ownEdit,
      verdict: 'approve',
      rationaleMd: '',
      evidenceRefs: [],
      isImplicit: true,
    });

    expect(await queuedPendingEditIds(soloId)).toEqual([ownEdit]);
  });

  // …and an explicit verdict retires the row from the queue, exactly as a
  // verdict on a peer's work does. Without this the agent would re-review the
  // same edit every cycle.
  it('drops a self-reviewed edit once the agent has actually judged it', async () => {
    const soloId = await seedUser(db, {
      email: 'solo@example.com',
      username: 'solo-agent',
      role: 'contributor',
    });
    const agentId = await seedAgent(soloId, 'solo-agent', 'active', true);

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'kodein',
        title: 'Kodein',
        status: 'published',
        createdBy: soloId,
        updatedBy: soloId,
      })
      .returning({ id: wikiPages.id });

    const ownEdit = await seedWikiFactEdit(
      soloId,
      page!.id,
      'Eget faktum om kodein.',
    );
    await db.insert(agentVerifications).values({
      agentId,
      targetType: 'pending_edit',
      targetId: ownEdit,
      verdict: 'approve',
      rationaleMd: 'Kontrollert mot primærkilden.',
      evidenceRefs: [],
      isImplicit: false,
    });

    expect(await queuedPendingEditIds(soloId)).toEqual([]);
  });

  // The flag is per agent, not per pool: turning it on for one agent must not
  // put another agent's own work back in that other agent's queue.
  it('keeps the default agent’s own work out of its queue', async () => {
    const soloId = await seedUser(db, {
      email: 'solo@example.com',
      username: 'solo-agent',
      role: 'contributor',
    });
    const plainId = await seedUser(db, {
      email: 'plain@example.com',
      username: 'plain-agent',
      role: 'contributor',
    });
    await seedAgent(soloId, 'solo-agent', 'active', true);
    await seedAgent(plainId, 'plain-agent');

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'morfin',
        title: 'Morfin',
        status: 'published',
        createdBy: soloId,
        updatedBy: soloId,
      })
      .returning({ id: wikiPages.id });

    const soloEdit = await seedWikiFactEdit(
      soloId,
      page!.id,
      'Faktum fra selvvurderende agent.',
    );
    const plainEdit = await seedWikiFactEdit(
      plainId,
      page!.id,
      'Faktum fra vanlig agent.',
    );

    const plainQueue = await queuedPendingEditIds(plainId);
    expect(plainQueue).toContain(soloEdit);
    expect(plainQueue).not.toContain(plainEdit);
  });
});
