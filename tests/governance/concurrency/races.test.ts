/**
 * §16.6 — the eight named concurrency scenarios.
 *
 * ## What this harness can and cannot prove
 *
 * PGlite is one in-process connection. Two `await`s issued without an
 * intervening `await` do not execute in parallel against separate backends;
 * they interleave at the JavaScript layer and serialise at the database. So
 * these tests prove **interleaving safety** — that a second actor arriving
 * between any two steps of the first cannot produce a state the invariants
 * forbid — and they do NOT prove lock behaviour, deadlock freedom, or that a
 * `SELECT … FOR UPDATE` blocks a competing writer.
 *
 * Saying that out loud is the point. §16.6's own note is explicit that a green
 * test under PGlite is weak evidence for the production failure mode, and the
 * property that actually discriminates — client identity across a joined
 * transaction — lives in `../transaction/connection-identity.test.ts` and is
 * asserted there rather than re-implied here. The one item on §16.6's list this
 * repository cannot discharge at all is the real-Postgres advisory-lock
 * deadlock shape; it is recorded as outstanding in
 * `docs/plans/2026-08-26-test-strategy-audit.md` rather than papered over with
 * a PGlite test that would pass either way.
 *
 * What each scenario therefore asserts is an *end-state invariant* — "exactly
 * one application", "never both rejected and live", "the snapshot that was
 * taken is the snapshot that was used" — because those hold regardless of who
 * won the race, which is the only kind of assertion a serialising harness can
 * make honestly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  disputes,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from '../../../db/schema.js';
import agentVerificationsHandler from '../../../api/agent-verifications.js';
import pendingEditsHandler from '../../../api/pending-edits.js';
import disputesHandler from '../../../api/disputes.js';
import { verificationTargetVersion } from '../../../api/_lib/agent-verifications.js';
import {
  applyOnAgentConsensus,
  sweepAgentConsensus,
} from '../../../api/agent-verifications.js';
import { pendingEditReviewToken } from '../../../api/_lib/pending-edit-review-token.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { mirrorProposalVersion } from '../../../api/_lib/knowledge-governance/mirror.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import {
  getKnowledgeTargetAdapter,
  resetKnowledgeTargetAdaptersForTests,
} from '../../../api/_lib/knowledge-governance/registry.js';
import { userActorRef } from '../../../api/_lib/knowledge-governance/actor-context.js';
import {
  findByLegacy,
  latestVersion,
  listPublicationEvents,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  createResponse,
  jsonRequest,
  type Handler,
  type ResponseState,
} from '../support/http.js';
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
  delete process.env[FORCE_LEGACY_ENV];
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
  invalidateMigrationStateCache();
  delete process.env[FORCE_LEGACY_ENV];
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
});

/**
 * Run a handler as one caller.
 *
 * The auth mock is a single shared function, so a genuinely parallel
 * `Promise.all` of two `call`s would have the second caller's identity
 * overwrite the first's before the first handler read it. Every concurrent
 * scenario below therefore states the two operations' *order of arrival*
 * explicitly and interleaves around a resolved identity — which is what the
 * harness can model anyway, and is honest about the fact that "parallel" here
 * means "interleaved".
 */
async function call(
  handler: Handler,
  args: {
    as: { userId: number; role: string };
    method: string;
    url: string;
    body: unknown;
  },
): Promise<ResponseState> {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.as.userId,
    role: args.as.role,
  });
  const { res, state } = createResponse();
  await handler(jsonRequest(args.method, args.url, args.body), res);
  return state;
}

interface Reviewer {
  userId: number;
  agentId: number;
}

interface World {
  authorUserId: number;
  moderatorUserId: number;
  reviewers: Reviewer[];
  pageId: number;
  editId: number;
}

const FACT_ID = 'fact-halflife-1';
const STATEMENT = 'Halveringstiden er 30 timer.';

function factNode(text = STATEMENT) {
  return {
    type: 'fact',
    attrs: { factId: FACT_ID, referenceIds: [] },
    content: [{ type: 'text', text }],
  };
}

/**
 * A topic page carrying one sectioned heading and no facts. Topic pages keep
 * the flat v1 doc shape, so a section exists only as a heading node — which
 * is why deleting one is detectable there and not on a monograph.
 */
function topicDoc(sectionId = 'pharmacology') {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2, sectionId },
        content: [{ type: 'text', text: 'Pharmacology' }],
      },
    ],
  };
}

interface SeedOptions {
  /** Defaults to a `drug_monograph` page with an empty `pk` section. */
  pageType?: string;
  content?: unknown;
  /** The pending edit's target section. Defaults to `pk`. */
  sectionId?: string;
}

/** An agent-authored wiki_fact awaiting review, with `tiers.length` reviewers. */
async function seedWorld(
  tiers: Array<string | null>,
  options: SeedOptions = {},
): Promise<World> {
  const authorUserId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId: authorUserId,
    name: 'author-agent',
    slug: 'author-agent',
    status: 'active',
  });
  const moderatorUserId = await seedUser(db, {
    email: 'moderator@example.com',
    username: 'moderator',
    role: 'admin',
  });

  const reviewers: Reviewer[] = [];
  for (const [i, tier] of tiers.entries()) {
    const userId = await seedUser(db, {
      email: `reviewer${i}@example.com`,
      username: `reviewer-${i}`,
      role: 'editor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId,
        name: `reviewer-${i}`,
        slug: `reviewer-${i}`,
        status: 'active',
        modelTier: tier,
      })
      .returning({ id: agents.id });
    reviewers.push({ userId, agentId: agent!.id });
  }

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      pageType: options.pageType ?? 'drug_monograph',
      content: (options.content ?? {
        version: 2,
        sections: { pk: { body: { type: 'doc', content: [] } } },
      }) as never,
      status: 'published',
      createdBy: authorUserId,
      updatedBy: authorUserId,
    })
    .returning({ id: wikiPages.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: options.sectionId ?? 'pk',
      factOperation: 'add',
      factStatement: STATEMENT,
      proposedValue: factNode(),
      submittedBy: authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  return {
    authorUserId,
    moderatorUserId,
    reviewers,
    pageId: page!.id,
    editId: edit!.id,
  };
}

async function targetVersion(editId: number): Promise<string> {
  const version = await verificationTargetVersion({
    targetType: 'pending_edit',
    targetId: editId,
  });
  expect(version).not.toBeNull();
  return version!;
}

async function reviewToken(editId: number): Promise<string> {
  const [row] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  return pendingEditReviewToken(row!);
}

async function postVerdict(args: {
  editId: number;
  reviewer: Reviewer;
  verdict?: 'approve' | 'dispute' | 'abstain';
  /** Override the freshness token, to model a caller holding a stale snapshot. */
  version?: string;
}): Promise<ResponseState> {
  const verdict = args.verdict ?? 'approve';
  return call(agentVerificationsHandler as Handler, {
    as: { userId: args.reviewer.userId, role: 'editor' },
    method: 'POST',
    url: '/api/agent-verifications',
    body: {
      targetType: 'pending_edit',
      targetId: args.editId,
      targetVersion: args.version ?? (await targetVersion(args.editId)),
      verdict,
      rationaleMd: verdict === 'approve' ? '' : 'Kilden dekker ikke påstanden.',
    },
  });
}

async function statusOf(editId: number): Promise<string> {
  const [row] = await db
    .select({ status: pendingEdits.status })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  return row!.status;
}

/** How many times the proposed fact appears in the live page. */
async function factOccurrences(pageId: number): Promise<number> {
  const [row] = await db
    .select({ content: wikiPages.content })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId));
  return JSON.stringify(row!.content).split(`"${FACT_ID}"`).length - 1;
}

/**
 * The text of the single fact node carrying `FACT_ID`, wherever it sits in the
 * doc. Lets an upsert assertion say *which* version survived, not just how
 * many copies there are.
 */
async function factText(pageId: number): Promise<string | null> {
  const [row] = await db
    .select({ content: wikiPages.content })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId));
  let found: string | null = null;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type?: unknown;
      attrs?: { factId?: unknown } | null;
      content?: unknown;
      text?: unknown;
    };
    if (n.type === 'fact' && n.attrs?.factId === FACT_ID) {
      const first = Array.isArray(n.content) ? n.content[0] : null;
      const text = (first as { text?: unknown } | null)?.text;
      if (typeof text === 'string') found = text;
      return;
    }
    Object.values(n).forEach(walk);
  };
  walk(row!.content);
  return found;
}

async function revisionCount(pageId: number): Promise<number> {
  const rows = await db
    .select({ id: wikiRevisions.id })
    .from(wikiRevisions)
    .where(eq(wikiRevisions.pageId, pageId));
  return rows.length;
}

async function cutOver(editId: number): Promise<void> {
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  await setMigrationMode({
    targetType: applyAuthorityKey('wiki_fact'),
    mode: 'generic_authoritative',
    updatedBy: 1,
  });
  invalidateMigrationStateCache();
  const mirrored = await mirrorProposalVersion({
    targetType: 'pending_edit',
    targetId: editId,
    legacyPendingEditId: editId,
  });
  expect(mirrored.mirrored).toBe(true);
}

// ──────────────────────────────────────────────────────────────────────────

describe('1. author revises while a reviewer submits its assessment', () => {
  it('refuses the verdict that was composed against the pre-revision payload', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    // The reviewer reads the queue and starts composing.
    const snapshot = await targetVersion(world.editId);

    // The author revises before that verdict arrives.
    const revised = await call(pendingEditsHandler as Handler, {
      as: { userId: world.authorUserId, role: 'contributor' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${world.editId}`,
      body: {
        proposedMeta: { editSummary: 'Presiserer intervallet.' },
        reviewToken: await reviewToken(world.editId),
      },
    });
    expect(revised.statusCode).toBeLessThan(300);

    const late = await postVerdict({
      editId: world.editId,
      reviewer: world.reviewers[0]!,
      version: snapshot,
    });
    expect(late.statusCode).toBe(409);
    // Nothing was recorded, so the revision cannot inherit a judgment of the
    // payload it replaced.
    expect(await explicitVerdictCount(world.editId)).toBe(0);
  });

  it('drops a verdict that landed just before the revision', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    const accepted = await postVerdict({
      editId: world.editId,
      reviewer: world.reviewers[0]!,
    });
    expect(accepted.statusCode).toBeLessThan(300);
    expect(await explicitVerdictCount(world.editId)).toBe(1);

    await call(pendingEditsHandler as Handler, {
      as: { userId: world.authorUserId, role: 'contributor' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${world.editId}`,
      body: {
        proposedMeta: { editSummary: 'Presiserer intervallet.' },
        reviewToken: await reviewToken(world.editId),
      },
    });

    // The other direction of the same race, and the one a freshness token
    // cannot handle: the verdict was valid when cast. `clearVerificationsForTarget`
    // is what closes it.
    expect(await explicitVerdictCount(world.editId)).toBe(0);
    expect(await statusOf(world.editId)).toBe('pending');
  });
});

describe('2. two reviewers approve concurrently', () => {
  it('applies exactly once when both tipping approvals are in flight', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    // Both compose against the same snapshot — neither has seen the other.
    const shared = await targetVersion(world.editId);

    const first = await postVerdict({
      editId: world.editId,
      reviewer: world.reviewers[0]!,
      version: shared,
    });
    const second = await postVerdict({
      editId: world.editId,
      reviewer: world.reviewers[1]!,
      version: shared,
    });
    expect(first.statusCode).toBeLessThan(300);
    expect(second.statusCode).toBeLessThan(300);

    expect(await statusOf(world.editId)).toBe('approved');
    // The invariant that survives either ordering: the fact is spliced in once
    // and one revision records it. A second application would duplicate the
    // node in the page body.
    expect(await factOccurrences(world.pageId)).toBe(1);
    expect(await revisionCount(world.pageId)).toBe(1);
    // Exactly one of the two POSTs owns the application.
    const applied = [first, second].filter(
      (r) => JSON.parse(r.body).autoApplied === true,
    );
    expect(applied).toHaveLength(1);
  });
});

describe('3. a dispute arrives as the quorum is reached', () => {
  it('holds when the dispute commits before the tipping approval', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    const opened = await call(disputesHandler as Handler, {
      as: { userId: world.moderatorUserId, role: 'admin' },
      method: 'POST',
      url: '/api/disputes',
      body: {
        targetType: 'pending_edit',
        targetId: world.editId,
        targetVersion: await targetVersion(world.editId),
        reasonMd: 'Kilden oppgir 20–50 timer.',
      },
    });
    expect(opened.statusCode).toBeLessThan(300);

    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });
    expect(await statusOf(world.editId)).toBe('pending');
    expect(await factOccurrences(world.pageId)).toBe(0);
  });

  it('does not un-apply when the dispute arrives after the approval committed', async () => {
    // The other ordering, and the one worth stating explicitly: publication is
    // a commit, not a lease. A dispute opened afterwards is an objection to
    // live content and is handled by the ordinary retraction path, not by the
    // consensus gate reaching backwards.
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });
    expect(await statusOf(world.editId)).toBe('approved');

    const opened = await call(disputesHandler as Handler, {
      as: { userId: world.moderatorUserId, role: 'admin' },
      method: 'POST',
      url: '/api/disputes',
      body: {
        targetType: 'pending_edit',
        targetId: world.editId,
        targetVersion: await targetVersion(world.editId),
        reasonMd: 'Kilden oppgir 20–50 timer.',
      },
    });
    expect(opened.statusCode).toBeLessThan(300);
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);
  });
});

describe('4. an admin changes a verifier tier while a verdict is recorded', () => {
  it('uses the tier snapshotted onto the verdict, not the tier now on the agent', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    const [before] = await db
      .select({ tier: agentVerifications.verifierTier })
      .from(agentVerifications)
      .where(
        and(
          eq(agentVerifications.targetId, world.editId),
          eq(agentVerifications.agentId, world.reviewers[0]!.agentId),
        ),
      );
    expect(before!.tier).toBe('flagship');

    // The downgrade lands immediately after the verdict.
    await db
      .update(agents)
      .set({ modelTier: 'mid' })
      .where(eq(agents.id, world.reviewers[0]!.agentId));

    const [after] = await db
      .select({ tier: agentVerifications.verifierTier })
      .from(agentVerifications)
      .where(
        and(
          eq(agentVerifications.targetId, world.editId),
          eq(agentVerifications.agentId, world.reviewers[0]!.agentId),
        ),
      );
    // The snapshot is the record of what was true when the judgment was made.
    // Re-reading the agent would rewrite history in whichever direction the
    // admin happened to move the tier.
    expect(after!.tier).toBe('flagship');
  });

  it('does not let an upgrade after the fact manufacture a flagship approval', async () => {
    const world = await seedWorld(['mid', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });
    await db
      .update(agents)
      .set({ modelTier: 'flagship' })
      .where(eq(agents.id, world.reviewers[0]!.agentId));

    const [row] = await db
      .select({ tier: agentVerifications.verifierTier })
      .from(agentVerifications)
      .where(
        and(
          eq(agentVerifications.targetId, world.editId),
          eq(agentVerifications.agentId, world.reviewers[0]!.agentId),
        ),
      );
    expect(row!.tier).toBe('mid');
  });
});

describe('5. a moderator acts while the consensus gate attempts to apply', () => {
  it('never leaves the edit both rejected and live', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });
    // The second reviewer has already taken its snapshot; its verdict is in
    // flight when the moderator acts.
    const queued = await targetVersion(world.editId);

    // The moderator rejects while the second approval is being processed. The
    // rejection commits first; the verdict that follows must not resurrect it.
    const rejected = await call(pendingEditsHandler as Handler, {
      as: { userId: world.moderatorUserId, role: 'admin' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${world.editId}`,
      body: {
        status: 'rejected',
        rejectionReason: 'factually_incorrect',
        rejectionComment: 'Kilden støtter ikke tallet.',
        reviewToken: await reviewToken(world.editId),
      },
    });
    expect(rejected.statusCode).toBeLessThan(300);

    const late = await postVerdict({
      editId: world.editId,
      reviewer: world.reviewers[1]!,
      version: queued,
    });
    // The status flip invalidates the freshness token, so the late verdict is
    // refused before it can reach the gate at all.
    expect(late.statusCode).toBe(409);
    expect(await statusOf(world.editId)).toBe('rejected');
    expect(await factOccurrences(world.pageId)).toBe(0);
  });
});

describe('6. two application instances process the same tipping approval', () => {
  it('applies once and reports false to the loser', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });
    // Record the tipping verdict WITHOUT going through the route, so the gate
    // has not yet run: this models two serverless instances both reacting to
    // the same recorded approval.
    await db.insert(agentVerifications).values({
      agentId: world.reviewers[1]!.agentId,
      targetType: 'pending_edit',
      targetId: world.editId,
      verdict: 'approve',
      verifierTier: 'mid',
    });

    const outcomes = await Promise.all([
      applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.reviewers[0]!.userId,
      }),
      applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.reviewers[1]!.userId,
      }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);
    expect(await revisionCount(world.pageId)).toBe(1);
  });
});

describe('7. the force-legacy switch is thrown during active requests', () => {
  it('publishes exactly once whichever engine wins the flip', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await cutOver(world.editId);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    // Thrown between the first and second approvals: the generic engine was in
    // charge when the edit entered review and legacy is in charge when it
    // publishes.
    process.env[FORCE_LEGACY_ENV] = '1';
    invalidateMigrationStateCache();

    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);

    // Legacy published it, so the generic side recorded no publication event.
    // Both engines recording one would mean the edit was applied twice.
    const link = await findByLegacy(db, 'pending_edit', world.editId);
    const version = await latestVersion(db, link!.genericId);
    expect(await listPublicationEvents(db, version!.id)).toHaveLength(0);
  });

  it('restores generic authority when the switch is cleared', async () => {
    // The switch has to be a lever, not a latch: an operator who throws it
    // during an incident must be able to put it back without a deploy.
    const world = await seedWorld(['flagship', 'mid']);
    await cutOver(world.editId);
    process.env[FORCE_LEGACY_ENV] = '1';
    invalidateMigrationStateCache();
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    delete process.env[FORCE_LEGACY_ENV];
    invalidateMigrationStateCache();
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });

    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);
    const link = await findByLegacy(db, 'pending_edit', world.editId);
    const version = await latestVersion(db, link!.genericId);
    expect(
      (await listPublicationEvents(db, version!.id)).length,
    ).toBeGreaterThan(0);
  });
});

describe('8. a pending edit conflicts with a direct mutation of its target', () => {
  /**
   * §16.6 asks what happens when a queued edit collides with a direct mutation
   * of the same target. This build used to answer "the approval wins,
   * unconditionally, and appends", pinned here as characterization while the
   * behaviour was undecided — see §3.2 of
   * `docs/plans/2026-08-26-test-strategy-audit.md`.
   *
   * `add` now upserts on factId rather than splicing blind, so the first test
   * asserts the decided behaviour: the approval still wins, but it updates the
   * fact in place instead of leaving the page carrying it twice.
   *
   * The second test stays **characterization**. On a monograph a section is a
   * schema entry, not an authored node, and `normalizeMonographContentV2`
   * prunes any section with no content — so "the admin deleted it" and "it is
   * empty" are the same stored state, and refusing the approval would reject
   * every first fact into a fresh section. The topic-page equivalent, where a
   * section really is a node an admin can delete, is guarded in scenario 9.
   */
  it('updates, rather than duplicates, a fact an admin already added by hand', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    // An admin edits the page directly, adding the very fact the pending edit
    // proposes — same `factId`, same statement.
    await db
      .update(wikiPages)
      .set({
        content: {
          version: 2,
          sections: {
            pk: { body: { type: 'doc', content: [factNode()] } },
          },
        },
        updatedBy: world.moderatorUserId,
      })
      .where(eq(wikiPages.id, world.pageId));
    expect(await factOccurrences(world.pageId)).toBe(1);

    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });

    // The collision is still not *detected* — the review token did not change
    // and the apply does not re-check the target. It is resolved instead: the
    // approved node replaces the hand-written one at its existing location, so
    // the page carries exactly one copy and the revision history records which
    // version won.
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);
    expect(await factText(world.pageId)).toBe(STATEMENT);
  });

  it('publishes into a monograph section the admin emptied', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    // The admin removes the section the fact was queued against.
    await db
      .update(wikiPages)
      .set({
        content: { version: 2, sections: {} },
        updatedBy: world.moderatorUserId,
      })
      .where(eq(wikiPages.id, world.pageId));

    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });

    // The apply materializes `pk` and publishes into it. That is the same code
    // path as a first fact into any fresh section, because an emptied
    // monograph section and an untouched one are stored identically — see the
    // block comment above. Pinned so a future attempt to refuse the missing
    // anchor here has to confront that it cannot tell the two apart.
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);
  });

  it('is the same under the generic engine, so cutover changes nothing here', async () => {
    // The one thing that would be worse than the behaviour above is the two
    // engines disagreeing about it: a cutover that silently changed how a
    // collision resolves would move a data-loss risk without anyone deciding
    // to. The adapter delegates to the same helper, and this pins that — it
    // moved from 2 occurrences to 1 in lockstep with the legacy engine.
    const world = await seedWorld(['flagship', 'mid']);
    await cutOver(world.editId);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });
    await db
      .update(wikiPages)
      .set({
        content: {
          version: 2,
          sections: {
            pk: { body: { type: 'doc', content: [factNode()] } },
          },
        },
        updatedBy: world.moderatorUserId,
      })
      .where(eq(wikiPages.id, world.pageId));

    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);

    const link = await findByLegacy(db, 'pending_edit', world.editId);
    const version = await latestVersion(db, link!.genericId);
    expect(
      (await listPublicationEvents(db, version!.id)).length,
    ).toBeGreaterThan(0);
  });
});

describe('7. author revises while the consensus sweep runs', () => {
  it('never publishes the revision on approvals of the previous payload', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    // Quorum already on record for the ORIGINAL payload, the gate not yet run.
    for (const [i, reviewer] of world.reviewers.entries()) {
      await db.insert(agentVerifications).values({
        agentId: reviewer.agentId,
        targetType: 'pending_edit',
        targetId: world.editId,
        verdict: 'approve',
        verifierTier: i === 0 ? 'flagship' : 'mid',
      });
    }
    const REVISED = 'Halveringstiden er 99 timer.';
    const token = await reviewToken(world.editId);

    // The author's revision and a sweep (which the author may call itself)
    // arrive together. The revision must not publish on the old approvals.
    const [revised] = await Promise.all([
      call(pendingEditsHandler as Handler, {
        as: { userId: world.authorUserId, role: 'contributor' },
        method: 'PATCH',
        url: `/api/pending-edits?id=${world.editId}`,
        body: {
          proposedValue: factNode(REVISED),
          factStatement: REVISED,
          reviewToken: token,
        },
      }),
      sweepAgentConsensus(),
    ]);

    const published = await factText(world.pageId);
    expect(published ?? '').not.toContain('99');
    // Either the original published first (and the revision was refused), or
    // the revision won and its approvals were wiped with it.
    if ((await statusOf(world.editId)) === 'pending') {
      expect(revised.statusCode).toBeLessThan(300);
      expect(await explicitVerdictCount(world.editId)).toBe(0);
    }
  });
});

describe('8. the generic apply re-decides under the row lock', () => {
  it('refuses to publish when consensus no longer holds at write time', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    // Two approvals were on record when the publication decided; both
    // approvers have since been suspended, so under the lock no eligible
    // approval remains.
    for (const [i, reviewer] of world.reviewers.entries()) {
      await db.insert(agentVerifications).values({
        agentId: reviewer.agentId,
        targetType: 'pending_edit',
        targetId: world.editId,
        verdict: 'approve',
        verifierTier: i === 0 ? 'flagship' : 'mid',
      });
    }
    for (const reviewer of world.reviewers) {
      await db
        .update(agents)
        .set({ status: 'suspended' })
        .where(eq(agents.id, reviewer.agentId));
    }

    const adapter = getKnowledgeTargetAdapter('kinetix', 'pending_edit');
    await expect(
      adapter.apply!({
        version: {
          ref: { proposalId: '0', versionId: '0' },
          target: { space: 'kinetix', type: 'pending_edit', id: String(world.editId) },
          payload: null,
          targetVersion: '',
          createdAt: new Date().toISOString(),
          authorRef: userActorRef(world.authorUserId),
        },
        decision: { allowed: true, policyId: 'p', policyVersion: '1', holdReason: null },
        actor: {
          actorRef: userActorRef(world.reviewers[0]!.userId),
          kind: 'agent',
          capabilities: [],
          assuranceCapabilities: [],
          metadata: {},
        },
        tx: null,
      } as never),
    ).rejects.toThrow('no longer holds under the apply lock');
    expect(await statusOf(world.editId)).toBe('pending');
    expect(await factOccurrences(world.pageId)).toBe(0);
  });
});

/** Explicit (non-implicit) verdicts standing on one pending edit. */
async function explicitVerdictCount(editId: number): Promise<number> {
  const rows = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, 'pending_edit'),
        eq(agentVerifications.targetId, editId),
        eq(agentVerifications.isImplicit, false),
      ),
    );
  return rows.length;
}

/** Guard against the disputes table drifting out of these scenarios. */
describe('the scenarios above touch the tables they claim to', () => {
  it('opens dispute rows through the real route', async () => {
    const world = await seedWorld(['flagship']);
    await call(disputesHandler as Handler, {
      as: { userId: world.moderatorUserId, role: 'admin' },
      method: 'POST',
      url: '/api/disputes',
      body: {
        targetType: 'pending_edit',
        targetId: world.editId,
        targetVersion: await targetVersion(world.editId),
        reasonMd: 'Kilden oppgir 20–50 timer.',
      },
    });
    const rows = await db
      .select({ id: disputes.id, status: disputes.status })
      .from(disputes)
      .where(eq(disputes.targetId, world.editId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
  });
});

describe('9. the same collisions on a topic page, where a section is a node', () => {
  /**
   * Topic pages keep the flat v1 doc, so a section is a heading node an admin
   * can genuinely delete — unlike a monograph section, which is a schema entry
   * that is simply absent when empty. That makes the deletion case decidable
   * here, and `applyApprovedWikiFact` already decides it: the apply refuses
   * rather than rebuilding the heading.
   *
   * Nothing pinned that before. It is the half of §3.2 that was already fixed,
   * and an unguarded refusal is one careless edit away from becoming an
   * unnoticed rebuild — the same absence-reads-as-a-pass shape this file keeps
   * running into.
   */
  const topicWorld = (tiers: Array<string | null>) =>
    seedWorld(tiers, {
      pageType: 'topic',
      content: topicDoc(),
      sectionId: 'pharmacology',
    });

  it('refuses an approval whose section the admin deleted', async () => {
    const world = await topicWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    // The admin removes the sectioned heading the fact was queued against.
    await db
      .update(wikiPages)
      .set({
        content: { type: 'doc', content: [] },
        updatedBy: world.moderatorUserId,
      })
      .where(eq(wikiPages.id, world.pageId));

    const res = await postVerdict({
      editId: world.editId,
      reviewer: world.reviewers[1]!,
    });

    // The verdict itself is still recorded — casting it was valid, and the
    // reviewer should not lose it because the target moved underneath. What
    // the refusal blocks is the publication: the edit stays unapplied and the
    // admin's deletion stands.
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).autoApplied).not.toBe(true);
    expect(await statusOf(world.editId)).not.toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(0);
  });

  it('updates, rather than duplicates, a fact an admin already added by hand', async () => {
    const world = await topicWorld(['flagship', 'mid']);
    await postVerdict({ editId: world.editId, reviewer: world.reviewers[0]! });

    // Same factId published by hand into the section the edit targets.
    await db
      .update(wikiPages)
      .set({
        content: {
          type: 'doc',
          content: [...topicDoc().content, factNode('Håndskrevet versjon.')],
        },
        updatedBy: world.moderatorUserId,
      })
      .where(eq(wikiPages.id, world.pageId));
    expect(await factOccurrences(world.pageId)).toBe(1);

    await postVerdict({ editId: world.editId, reviewer: world.reviewers[1]! });

    // The topic engine upserts on factId exactly as the monograph engine does,
    // so the two page types resolve an occupied anchor the same way.
    expect(await statusOf(world.editId)).toBe('approved');
    expect(await factOccurrences(world.pageId)).toBe(1);
    expect(await factText(world.pageId)).toBe(STATEMENT);
  });
});

describe('9. a reviewer return that rewrites the payload', () => {
  it('never commits the rewrite without wiping the old approvals', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    for (const [i, reviewer] of world.reviewers.entries()) {
      await db.insert(agentVerifications).values({
        agentId: reviewer.agentId,
        targetType: 'pending_edit',
        targetId: world.editId,
        verdict: 'approve',
        verifierTier: i === 0 ? 'flagship' : 'mid',
      });
    }
    // Make the verdict wipe fail after the return's row update has run: the
    // request dying between the two is exactly what must not leave approvals
    // on the rewritten payload for a bare resubmit and a sweep to publish.
    await db.execute(sql`
      CREATE FUNCTION fail_verdict_wipe() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'verdict wipe failed'; END $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER fail_verdict_wipe BEFORE DELETE ON agent_verifications
      FOR EACH ROW EXECUTE FUNCTION fail_verdict_wipe()
    `);
    const REWRITTEN = 'Presisert av redaktør: halveringstid 99 timer.';
    try {
      const returned = await call(pendingEditsHandler as Handler, {
        as: { userId: world.moderatorUserId, role: 'admin' },
        method: 'PATCH',
        url: `/api/pending-edits?id=${world.editId}`,
        body: {
          status: 'returned',
          returnComment: 'Rettet halveringstiden.',
          proposedMeta: { editSummary: REWRITTEN },
          reviewToken: await reviewToken(world.editId),
        },
      });
      expect(returned.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql`DROP TRIGGER fail_verdict_wipe ON agent_verifications`);
      await db.execute(sql`DROP FUNCTION fail_verdict_wipe()`);
    }

    const [row] = await db
      .select({ status: pendingEdits.status, proposedMeta: pendingEdits.proposedMeta })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, world.editId));
    expect(row!.status).toBe('pending');
    expect(JSON.stringify(row!.proposedMeta ?? null)).not.toContain('99');
    expect(await explicitVerdictCount(world.editId)).toBe(2);
  });
});

describe('10. a comment-only return, then an unchanged resubmit', () => {
  it('holds agent consensus until the author revises', async () => {
    const world = await seedWorld(['flagship', 'mid']);
    for (const [i, reviewer] of world.reviewers.entries()) {
      await db.insert(agentVerifications).values({
        agentId: reviewer.agentId,
        targetType: 'pending_edit',
        targetId: world.editId,
        verdict: 'approve',
        verifierTier: i === 0 ? 'flagship' : 'mid',
      });
    }
    // A human reviewer sends it back with a note only; the approvals stay.
    const returned = await call(pendingEditsHandler as Handler, {
      as: { userId: world.moderatorUserId, role: 'admin' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${world.editId}`,
      body: {
        status: 'returned',
        returnComment: 'Kilden sier 20–50 timer; kontroller verdien.',
        reviewToken: await reviewToken(world.editId),
      },
    });
    expect(returned.statusCode).toBeLessThan(300);
    expect(await explicitVerdictCount(world.editId)).toBe(2);

    // The author ignores the note and resubmits unchanged: a bare resubmit
    // keeps every verdict.
    const resubmitted = await call(pendingEditsHandler as Handler, {
      as: { userId: world.authorUserId, role: 'contributor' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${world.editId}`,
      body: { status: 'pending' },
    });
    expect(resubmitted.statusCode).toBeLessThan(300);
    expect(await statusOf(world.editId)).toBe('pending');
    expect(await explicitVerdictCount(world.editId)).toBe(2);

    const results = await sweepAgentConsensus();
    expect(results).toEqual([
      expect.objectContaining({
        pendingEditId: world.editId,
        outcome: 'held',
        reason: 'returned_unrevised',
      }),
    ]);
    expect(await statusOf(world.editId)).toBe('pending');
    expect(await factText(world.pageId)).toBeNull();
  });
});

