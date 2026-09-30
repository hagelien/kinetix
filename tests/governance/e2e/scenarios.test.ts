/**
 * §16.8 — the eight named end-to-end scenarios.
 *
 * These are the plan's acceptance cases, driven through the real HTTP handlers
 * against real SQL: a verdict is a POST to `/api/agent-verifications`, a
 * moderator decision is a PATCH to `/api/pending-edits`, a dispute is a POST
 * and then a PATCH to `/api/disputes`. Nothing here calls the consensus gate
 * directly, because the thing under test is the arc a proposal actually takes
 * and half of these scenarios are about *who* is allowed to close it.
 *
 * ## Why several run twice
 *
 * A strangler migration's real claim is not "the new engine works" but "the
 * observable outcome is the same whichever engine is in charge". For the one
 * edit type that has been cut over (`wiki_fact`), the scenarios that exercise
 * it run under both authorities — legacy, and `generic_authoritative` — and
 * assert the same end state. A scenario that only ever ran under one of them
 * would pass right through the cutover without noticing it happened.
 *
 * The high-risk and clinical scenarios run under legacy only, deliberately:
 * `parameter`, `param_entry` and `clinical_case` are not cutover-eligible in
 * this build (§10, §11), and a test that advanced them would be asserting
 * against a configuration the gate is designed to refuse.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  citations,
  disputes,
  drugParameterRevisions,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import agentVerificationsHandler from '../../../api/agent-verifications.js';
import pendingEditsHandler from '../../../api/pending-edits.js';
import disputesHandler from '../../../api/disputes.js';
import { pendingEditReviewToken } from '../../../api/_lib/pending-edit-review-token.js';
import {
  isHighRiskPendingEdit,
  verificationTargetVersion,
} from '../../../api/_lib/agent-verifications.js';
import { DRUG_PARAMETER_IDS, parameterAcceptsAuthoredValue } from '../../../src/lib/drugParameters.js';
import {
  applyAuthorityKey,
  CUTOVER_ELIGIBLE_EDIT_TYPES,
} from '../../../api/_lib/knowledge-governance/cutover.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  currentAssessments,
  findByLegacy,
  latestDecisionForVersion,
  latestVersion,
  listPublicationEvents,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

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

// ── HTTP plumbing ─────────────────────────────────────────────────────────

import {
  createResponse,
  jsonRequest,
  type Handler,
  type ResponseState,
} from '../support/http.js';

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

// ── World ─────────────────────────────────────────────────────────────────

interface Reviewer {
  userId: number;
  agentId: number;
}

interface World {
  authorUserId: number;
  /** The author's agent row, or null when the author is a person. */
  authorAgentId: number | null;
  moderatorUserId: number;
  reviewers: Reviewer[];
  pageId: number;
  drugId: number;
}

/**
 * A world with `tiers.length` active verifier agents plus a moderator.
 *
 * The pool size is load-bearing in almost every scenario — Kinetix's quorum is
 * pool-adapted — so every caller states it explicitly rather than inheriting a
 * default that would quietly turn a full-quorum test into a degraded-pool one.
 */
async function seedWorld(opts: {
  tiers: Array<string | null>;
  authorIsAgent: boolean;
}): Promise<World> {
  const authorUserId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  let authorAgentId: number | null = null;
  if (opts.authorIsAgent) {
    const [agent] = await db
      .insert(agents)
      .values({
        userId: authorUserId,
        name: 'author-agent',
        slug: 'author-agent',
        status: 'active',
      })
      .returning({ id: agents.id });
    authorAgentId = agent!.id;
  }

  const moderatorUserId = await seedUser(db, {
    email: 'moderator@example.com',
    username: 'moderator',
    role: 'admin',
  });

  const reviewers: Reviewer[] = [];
  for (const [i, tier] of opts.tiers.entries()) {
    const userId = await seedUser(db, {
      email: `reviewer${i}@example.com`,
      username: `reviewer-${i}`,
      // 'editor' so the row stays visible to the caller after its status
      // changes; `review.queue.readAll` gates that, and a contributor-backed
      // agent would start 404ing mid-scenario for reasons unrelated to the
      // governance question under test.
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
      pageType: 'drug_monograph',
      content: { version: 2, sections: { pk: { body: { type: 'doc', content: [] } } } },
      status: 'published',
      createdBy: authorUserId,
      updatedBy: authorUserId,
    })
    .returning({ id: wikiPages.id });

  const drugId = await seedDrug(db, { slug: 'diazepam' });

  return {
    authorUserId,
    authorAgentId,
    moderatorUserId,
    reviewers,
    pageId: page!.id,
    drugId,
  };
}

function factNode(factId: string, text: string) {
  return {
    type: 'fact',
    attrs: { factId, referenceIds: [] },
    content: [{ type: 'text', text }],
  };
}

async function submitWikiFact(
  world: World,
  opts: { factId?: string; statement?: string } = {},
): Promise<number> {
  const statement = opts.statement ?? 'Halveringstiden er 30 timer.';
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: world.pageId,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: statement,
      proposedValue: factNode(opts.factId ?? 'fact-halflife-1', statement),
      submittedBy: world.authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

/**
 * A high-risk parameter proposal, as `param_entry`.
 *
 * The edit type matters and took a wrong turn to find. `isHighRiskPendingEdit`
 * returns true exactly when `parameterIsEntryBacked(parameter)` — and
 * `applyApprovedEdit` refuses an authored value for exactly those parameters
 * (`parameter_entry_backed`). So a **high-risk `parameter` edit can never
 * publish in this build**: the two predicates are complements over the same
 * set, and the refusal is a `ParameterApplyError`, which
 * `applyOnAgentConsensus` swallows into a silent `false`. A scenario written
 * that way passes its "held" assertions for a reason that has nothing to do
 * with the gate. `param_entry` is the calculation-driving type that actually
 * reaches a write, so that is what these scenarios exercise; the overlap itself
 * is pinned as its own test below.
 */
/**
 * A verbatim source quote, as a real proposal carries. Every high-risk fixture
 * gets one by default, because a calculation-driving parameter without one is
 * held by the evidence-completeness guard before the tier and quorum gates
 * these scenarios exercise are ever reached. Scenario 5b passes `quote: null`
 * to exercise that guard itself.
 */
const HIGH_RISK_QUOTE =
  'Therapeutic whole-blood concentrations ranged from 10 to 30 mg/L.';

async function submitHighRiskEdit(
  world: World,
  opts: { parameter?: string; high?: number; quote?: string | null } = {},
): Promise<number> {
  const parameter = opts.parameter ?? 'therapeuticConcentration';
  const citationId = await seedCitation();
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: world.drugId,
      parameter,
      referenceIds: [citationId],
      proposedValue: {
        op: 'create',
        input: {
          drugId: world.drugId,
          parameter,
          low: 10,
          high: opts.high ?? 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          ...(opts.quote === null ? {} : { quote: opts.quote ?? HIGH_RISK_QUOTE }),
          citationId,
        },
      },
      submittedBy: world.authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

async function submitClinicalCase(world: World): Promise<number> {
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'clinical_case',
      targetId: world.drugId,
      proposedValue: {
        title: 'Blandingsforgiftning med diazepam',
        body: 'Pasienten fikk 40 mg diazepam og 2 g paracetamol.',
      },
      submittedBy: world.authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

/**
 * The version string the *verification* route compares against.
 *
 * Deliberately not `pendingEditReviewToken`: the two freshness tokens in this
 * codebase are different values with different jobs. The moderator PATCH hashes
 * the whole payload; the verdict route folds `submitted_at` and `status` into a
 * string, because what invalidates a queued verdict is the row moving, and a
 * revision re-stamps `submitted_at`. A test that used the wrong one would 409
 * on its first call — which is exactly what this one did before this comment.
 */
async function targetVersion(editId: number): Promise<string> {
  const version = await verificationTargetVersion({
    targetType: 'pending_edit',
    targetId: editId,
  });
  expect(version).not.toBeNull();
  return version!;
}

async function currentToken(editId: number): Promise<string> {
  const [row] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  return pendingEditReviewToken(row!);
}

/** Post one agent verdict through the real route, as that agent's backing user. */
async function verdict(args: {
  editId: number;
  reviewer: Reviewer;
  verdict: 'approve' | 'dispute' | 'abstain';
}): Promise<ResponseState> {
  return call(agentVerificationsHandler as Handler, {
    as: { userId: args.reviewer.userId, role: 'editor' },
    method: 'POST',
    url: '/api/agent-verifications',
    body: {
      targetType: 'pending_edit',
      targetId: args.editId,
      targetVersion: await targetVersion(args.editId),
      verdict: args.verdict,
      rationaleMd:
        args.verdict === 'approve' ? '' : 'Kilden dekker ikke denne påstanden.',
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

let citationSeq = 0;
async function seedCitation(): Promise<number> {
  citationSeq += 1;
  const [row] = await db
    .insert(citations)
    .values({
      type: 'doi',
      identifier: `10.1/kinetix-e2e-${citationSeq}`,
      metadata: {},
    })
    .returning({ id: citations.id });
  return row!.id;
}

/** Explicit (non-implicit) verdicts standing on one pending edit. */
async function explicitApprovalCount(editId: number): Promise<number> {
  const rows = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, 'pending_edit'),
        eq(agentVerifications.targetId, editId),
        eq(agentVerifications.verdict, 'approve'),
        eq(agentVerifications.isImplicit, false),
      ),
    );
  return rows.length;
}

async function parameterRevisionCount(drugId: number): Promise<number> {
  const rows = await db
    .select({ id: drugParameterRevisions.id })
    .from(drugParameterRevisions)
    .where(eq(drugParameterRevisions.drugId, drugId));
  return rows.length;
}

async function pageContainsFact(pageId: number, factId: string): Promise<boolean> {
  const [row] = await db
    .select({ content: wikiPages.content })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId));
  return JSON.stringify(row!.content).includes(factId);
}

/**
 * Put `wiki_fact` under the generic engine and mirror one edit into it.
 *
 * Both halves are required and neither is implied by the other: advancing the
 * authority key without a mirrored version makes the service fall back
 * (`no_mirrored_proposal`), which would silently turn a "generic decided this"
 * assertion into a legacy one.
 */
async function cutOverWikiFact(editId: number): Promise<void> {
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

/**
 * Assert the generic engine, not the legacy gate, decided this edit.
 *
 * Without this the "runs under both authorities" claim is unfalsifiable: every
 * fallback path in `publishOnAgentConsensus` ends by handing the decision back
 * to legacy, so a cutover variant that silently fell back would produce the
 * same observable end state and pass. An authoritative decision row is the only
 * thing that distinguishes them.
 */
async function expectDecidedGenerically(
  editId: number,
  outcome: 'apply' | 'hold',
): Promise<void> {
  const link = await findByLegacy(db, 'pending_edit', editId);
  expect(link).not.toBeNull();
  const version = await latestVersion(db, link!.genericId);
  expect(version).not.toBeNull();
  const decision = await latestDecisionForVersion(db, version!.id, 'authoritative');
  expect(decision).not.toBeNull();
  expect(decision!.decision).toBe(outcome);
  // On an `apply`, the publication event is the other half: a decision with no
  // event would mean the engine judged and then nothing happened. A `hold`
  // correctly writes no event — nothing was published — so asserting one there
  // would be asserting the opposite of the behaviour under test.
  const events = await listPublicationEvents(db, version!.id);
  if (outcome === 'apply') expect(events.length).toBeGreaterThan(0);
  else expect(events).toHaveLength(0);
}

/** The two authorities every cutover-eligible scenario is asserted under. */
const AUTHORITIES = [
  { name: 'legacy', cutOver: false },
  { name: 'generic_authoritative', cutOver: true },
] as const;

// ── The scenarios ─────────────────────────────────────────────────────────

describe('1. human wiki fact → agent reviews → human approves → live', () => {
  for (const authority of AUTHORITIES) {
    it(`carries the arc under ${authority.name}`, async () => {
      const world = await seedWorld({
        tiers: ['flagship', 'mid'],
        authorIsAgent: false,
      });
      const editId = await submitWikiFact(world);
      if (authority.cutOver) await cutOverWikiFact(editId);

      // Agents review a person's proposal — that is not the disputed part.
      for (const reviewer of world.reviewers) {
        const posted = await verdict({ editId, reviewer, verdict: 'approve' });
        expect(posted.statusCode).toBeLessThan(300);
      }

      // …and consensus still does not close it. This is the invariant the
      // scenario exists for: agent approvals never stand in for a moderator on
      // a human's work, whichever engine is holding the gate.
      expect(await statusOf(editId)).toBe('pending');
      expect(await pageContainsFact(world.pageId, 'fact-halflife-1')).toBe(false);
      // Under cutover, the refusal is the generic engine's, recorded as such —
      // otherwise "the outcome is the same either way" would be a claim about
      // one engine that never ran.
      if (authority.cutOver) await expectDecidedGenerically(editId, 'hold');

      const approved = await call(pendingEditsHandler as Handler, {
        as: { userId: world.moderatorUserId, role: 'admin' },
        method: 'PATCH',
        url: `/api/pending-edits?id=${editId}`,
        body: { status: 'approved', reviewToken: await currentToken(editId) },
      });
      expect(approved.statusCode).toBeLessThan(300);

      expect(await statusOf(editId)).toBe('approved');
      expect(await pageContainsFact(world.pageId, 'fact-halflife-1')).toBe(true);
    });
  }
});

describe('2. agent wiki fact → independent quorum → auto-apply', () => {
  for (const authority of AUTHORITIES) {
    it(`publishes on the second independent approval under ${authority.name}`, async () => {
      // Three active agents (author + two reviewers) means the pool-adapted
      // quorum is the full design target of 2, so the first approval must not
      // be enough. A two-agent world would relax to 1 and prove less.
      const world = await seedWorld({
        tiers: ['flagship', 'mid'],
        authorIsAgent: true,
      });
      const editId = await submitWikiFact(world);
      if (authority.cutOver) await cutOverWikiFact(editId);

      await verdict({ editId, reviewer: world.reviewers[0]!, verdict: 'approve' });
      expect(await statusOf(editId)).toBe('pending');

      await verdict({ editId, reviewer: world.reviewers[1]!, verdict: 'approve' });
      expect(await statusOf(editId)).toBe('approved');
      expect(await pageContainsFact(world.pageId, 'fact-halflife-1')).toBe(true);
      if (authority.cutOver) await expectDecidedGenerically(editId, 'apply');
    });
  }
});

describe('3. agent wiki fact → dispute → held → human ruling', () => {
  for (const authority of AUTHORITIES) {
    it(`holds until the dispute is closed under ${authority.name}`, async () => {
      // Three reviewers, not two: an agent may not record a second verdict on
      // the same target, so the approval that re-runs the gate after the ruling
      // has to come from someone who has not voted yet.
      const world = await seedWorld({
        tiers: ['flagship', 'mid', 'mid'],
        authorIsAgent: true,
      });
      const editId = await submitWikiFact(world);
      if (authority.cutOver) await cutOverWikiFact(editId);

      // A human's objection, in the unified disputes table the agent tally
      // never reads. Opened *before* the quorum lands, so the edit reaches the
      // gate already blocked rather than being unpublished afterwards.
      const opened = await call(disputesHandler as Handler, {
        as: { userId: world.moderatorUserId, role: 'admin' },
        method: 'POST',
        url: '/api/disputes',
        body: {
          targetType: 'pending_edit',
          targetId: editId,
          targetVersion: await targetVersion(editId),
          reasonMd: 'Kilden oppgir 20–50 timer, ikke 30.',
        },
      });
      expect(opened.statusCode).toBeLessThan(300);

      for (const reviewer of world.reviewers.slice(0, 2)) {
        await verdict({ editId, reviewer, verdict: 'approve' });
      }
      expect(await statusOf(editId)).toBe('pending');
      expect(await pageContainsFact(world.pageId, 'fact-halflife-1')).toBe(false);
      if (authority.cutOver) await expectDecidedGenerically(editId, 'hold');

      const [dispute] = await db
        .select({ id: disputes.id })
        .from(disputes)
        .where(
          and(
            eq(disputes.targetType, 'pending_edit'),
            eq(disputes.targetId, editId),
          ),
        );
      const ruled = await call(disputesHandler as Handler, {
        as: { userId: world.moderatorUserId, role: 'admin' },
        method: 'PATCH',
        url: `/api/disputes?id=${dispute!.id}`,
        body: { resolution: 'rejected' },
      });
      expect(ruled.statusCode).toBeLessThan(300);

      // Closing a dispute does not itself publish anything; the next verdict is
      // what re-runs the gate. Deliberately asserted rather than assumed —
      // "held then ruled" is only half the scenario if nothing ever unblocks.
      expect(await statusOf(editId)).toBe('pending');
      await verdict({ editId, reviewer: world.reviewers[2]!, verdict: 'approve' });
      expect(await statusOf(editId)).toBe('approved');
      if (authority.cutOver) await expectDecidedGenerically(editId, 'apply');
    });
  }
});

describe('4. high-risk parameter → two mid approvals → held', () => {
  it('refuses to publish without a flagship approver', async () => {
    const world = await seedWorld({ tiers: ['mid', 'mid'], authorIsAgent: true });
    const editId = await submitHighRiskEdit(world);

    for (const reviewer of world.reviewers) {
      await verdict({ editId, reviewer, verdict: 'approve' });
    }

    expect(await statusOf(editId)).toBe('pending');
    // …and nothing was published. `drug_parameter_revisions` is what the apply
    // path writes for this edit type, so an empty table is the domain-side
    // statement of "held".
    expect(await parameterRevisionCount(world.drugId)).toBe(0);
  });

  it('is not cutover-eligible, so no configuration moves this', () => {
    expect(CUTOVER_ELIGIBLE_EDIT_TYPES).not.toContain('param_entry');
    expect(CUTOVER_ELIGIBLE_EDIT_TYPES).not.toContain('parameter');
  });

  it('records why these scenarios use param_entry rather than parameter', () => {
    // The two predicates are complements over the same set, so `editType:
    // 'parameter'` is high-risk exactly when its apply path refuses it. Pinned
    // because it is the kind of thing that reads as a coincidence until it
    // silently changes: if `parameterIsEntryBacked` ever stops driving both,
    // a high-risk authored-value edit becomes publishable and the scenarios
    // above stop covering the case they were written for.
    for (const parameter of DRUG_PARAMETER_IDS) {
      expect(
        isHighRiskPendingEdit({ editType: 'parameter', parameter }),
      ).toBe(!parameterAcceptsAuthoredValue(parameter));
    }
  });
});

describe('5. high-risk parameter → flagship + peer → applies at full quorum', () => {
  it('holds on the flagship approval alone and applies on the second', async () => {
    const world = await seedWorld({
      tiers: ['flagship', 'mid'],
      authorIsAgent: true,
    });
    const editId = await submitHighRiskEdit(world);

    await verdict({ editId, reviewer: world.reviewers[0]!, verdict: 'approve' });
    // One flagship approval clears the tier gate and not the count gate. The
    // high-risk rule requires the full design target regardless of what the
    // pool could relax to, and this is where that separation is visible.
    expect(await statusOf(editId)).toBe('pending');

    await verdict({ editId, reviewer: world.reviewers[1]!, verdict: 'approve' });
    expect(await statusOf(editId)).toBe('approved');
    // The value actually reached the drug, rather than the gate opening onto a
    // write that failed and was swallowed.
    expect(await parameterRevisionCount(world.drugId)).toBe(1);
  });
});

// The gate that closes the #1201 failure: a proposal citing the right document
// with the number read out of the wrong sentence. Everything the earlier
// scenarios gate on is satisfied here — agent author, full quorum, a flagship
// approver, no dispute — and the only thing missing is the sentence itself.
describe('5b. high-risk parameter → no source quote → held whatever the tally', () => {
  it('refuses to publish a calculation-driving value nobody quoted', async () => {
    const world = await seedWorld({
      tiers: ['flagship', 'flagship'],
      authorIsAgent: true,
    });
    const editId = await submitHighRiskEdit(world, { quote: null });

    for (const reviewer of world.reviewers) {
      await verdict({ editId, reviewer, verdict: 'approve' });
    }

    expect(await statusOf(editId)).toBe('pending');
    // Held, not published: nothing reached the drug. This is the same
    // domain-side statement of "held" scenario 4 makes, for a different reason
    // — there the reviewers were too weak, here the evidence is incomplete.
    expect(await parameterRevisionCount(world.drugId)).toBe(0);
  });

  it('publishes the identical proposal once it carries the quote', async () => {
    const world = await seedWorld({
      tiers: ['flagship', 'flagship'],
      authorIsAgent: true,
    });
    const editId = await submitHighRiskEdit(world);

    for (const reviewer of world.reviewers) {
      await verdict({ editId, reviewer, verdict: 'approve' });
    }

    // Same world, same tiers, same verdicts — so the quote is the only
    // variable, and the hold above is attributable to it and nothing else.
    expect(await statusOf(editId)).toBe('approved');
    expect(await parameterRevisionCount(world.drugId)).toBe(1);
  });
});

describe('6. clinical case → agent approvals → still held for a human expert', () => {
  it('is refused however many agents approve', async () => {
    const world = await seedWorld({
      tiers: ['flagship', 'flagship', 'flagship'],
      authorIsAgent: true,
    });
    const editId = await submitClinicalCase(world);

    for (const reviewer of world.reviewers) {
      await verdict({ editId, reviewer, verdict: 'approve' });
    }

    expect(await statusOf(editId)).toBe('pending');
  });

  it('is not cutover-eligible either', () => {
    expect(CUTOVER_ELIGIBLE_EDIT_TYPES).not.toContain('clinical_case');
  });
});

describe('7. payload revision after approvals → requires new-version reviews', () => {
  it('invalidates every verdict queued against the payload that was revised away', async () => {
    const world = await seedWorld({
      tiers: ['flagship', 'mid'],
      authorIsAgent: true,
    });
    const editId = await submitWikiFact(world);

    // One approval lands against the payload as first submitted, and a second
    // reviewer takes its snapshot of the version string before anything moves.
    await verdict({ editId, reviewer: world.reviewers[0]!, verdict: 'approve' });
    expect(await statusOf(editId)).toBe('pending');
    const queuedVersion = await targetVersion(editId);

    // The author revises through the real submitter route. That path re-stamps
    // `submitted_at`, which is half of the version string the verdict route
    // compares — this is the mechanism, and going around it with a direct
    // UPDATE would make the 409 below fire for the wrong reason.
    const revised = await call(pendingEditsHandler as Handler, {
      as: { userId: world.authorUserId, role: 'contributor' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${editId}`,
      body: {
        // Revised through `proposedMeta` rather than the fact text, because
        // `factStatement` is not a PATCHable field: the route refuses a
        // `proposedValue` whose content drifts from the statement the reviewers
        // were shown. Meta is a real revision by the codebase's own definition
        // — `pendingEditPayloadFingerprint` folds it in, and a change to it is
        // what stamps `revisedAt` and clears an upheld objection — so it is the
        // narrowest edit that trips the machinery under test rather than a
        // neighbouring one.
        proposedMeta: { editSummary: 'Presiserer at intervallet gjelder voksne.' },
        reviewToken: await currentToken(editId),
      },
    });
    expect(revised.statusCode).toBeLessThan(300);

    const revisedVersion = await targetVersion(editId);
    expect(revisedVersion).not.toBe(queuedVersion);

    // The second reviewer, still holding the pre-revision version, is refused.
    const stale = await call(agentVerificationsHandler as Handler, {
      as: { userId: world.reviewers[1]!.userId, role: 'editor' },
      method: 'POST',
      url: '/api/agent-verifications',
      body: {
        targetType: 'pending_edit',
        targetId: editId,
        targetVersion: queuedVersion,
        verdict: 'approve',
        rationaleMd: '',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe(
      'agent_verification_target_version_stale',
    );
    expect(await statusOf(editId)).toBe('pending');

    // …and the approval already recorded against the old payload is gone, not
    // merely uncounted. `clearVerificationsForTarget` wipes the row's verdicts
    // on a revision and re-stamps the author's implicit approve, so the revised
    // payload starts from nothing: this is Kinetix's version-bound review,
    // expressed against a table that has no version column.
    expect(await explicitApprovalCount(editId)).toBe(0);

    // One fresh approval is therefore not enough — the quorum is 2 and the
    // pre-revision one no longer exists.
    await verdict({ editId, reviewer: world.reviewers[1]!, verdict: 'approve' });
    expect(await statusOf(editId)).toBe('pending');
    expect(await explicitApprovalCount(editId)).toBe(1);

    // The reviewer whose verdict was wiped can vote again, and that is what
    // publishes it: every approval standing at apply time was cast against the
    // payload being applied.
    await verdict({ editId, reviewer: world.reviewers[0]!, verdict: 'approve' });
    expect(await statusOf(editId)).toBe('approved');
  });

  it('is what the generic model expresses as version-bound assessment', async () => {
    // The legacy mechanism above is a wipe: `clearVerificationsForTarget`
    // deletes the verdicts because `agent_verifications` is keyed by target id
    // and has nowhere to record *which payload* was reviewed. The generic
    // schema is keyed by version (§8.3), so the same history needs no deletion
    // — the assessments stay attached to the version they judged, and the
    // revision's version simply carries none. Asserted in both directions,
    // because "the new version has no assessments" is vacuous unless the old
    // one has some.
    const world = await seedWorld({
      tiers: ['flagship', 'mid'],
      authorIsAgent: true,
    });
    const editId = await submitWikiFact(world);

    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    const link = await findByLegacy(db, 'pending_edit', editId);
    const firstVersion = await latestVersion(db, link!.genericId);

    // The verdict is written and mirrored directly rather than posted through
    // the route. The route's mirror seam is deliberately fire-and-forget
    // (§12.4: mirroring must never fail a verdict), so a test that posted and
    // then counted rows would be racing it — and the sub-test above already
    // covers the route. What is under test here is the shape of the record.
    const [recorded] = await db
      .insert(agentVerifications)
      .values({
        agentId: world.reviewers[0]!.agentId,
        targetType: 'pending_edit',
        targetId: editId,
        verdict: 'approve',
        verifierTier: 'flagship',
      })
      .returning({ id: agentVerifications.id });
    const mirroredAssessment = await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: recorded!.id,
      actorRef: `user:${world.reviewers[0]!.userId}`,
      verdict: 'approve',
    });
    expect(mirroredAssessment.mirrored).toBe(true);
    expect(
      await currentAssessments(db, {
        subjectType: 'proposal_version',
        subjectId: firstVersion!.id,
      }),
    ).toHaveLength(1);

    const revised = await call(pendingEditsHandler as Handler, {
      as: { userId: world.authorUserId, role: 'contributor' },
      method: 'PATCH',
      url: `/api/pending-edits?id=${editId}`,
      body: {
        proposedMeta: { editSummary: 'Presiserer at intervallet gjelder voksne.' },
        reviewToken: await currentToken(editId),
      },
    });
    expect(revised.statusCode).toBeLessThan(300);

    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: editId,
      legacyPendingEditId: editId,
    });
    const secondVersion = await latestVersion(db, link!.genericId);
    expect(secondVersion!.id).not.toBe(firstVersion!.id);
    expect(secondVersion!.versionNo).toBe(firstVersion!.versionNo + 1);
    expect(secondVersion!.payloadFingerprint).not.toBe(
      firstVersion!.payloadFingerprint,
    );

    // The revision needs its own reviews…
    expect(
      await currentAssessments(db, {
        subjectType: 'proposal_version',
        subjectId: secondVersion!.id,
      }),
    ).toHaveLength(0);
    // …and the judgment of the old payload is still on the record, rather than
    // deleted to keep a version-blind table honest.
    expect(
      await currentAssessments(db, {
        subjectType: 'proposal_version',
        subjectId: firstVersion!.id,
      }),
    ).toHaveLength(1);
  });
});

describe('8. generic service disabled → the legacy path still completes', () => {
  it('publishes through the legacy gate with the kill switch set', async () => {
    const world = await seedWorld({
      tiers: ['flagship', 'mid'],
      authorIsAgent: true,
    });
    const editId = await submitWikiFact(world);
    // Fully cut over first, so the switch has something real to override. A
    // kill-switch test on an unadvanced database asserts nothing.
    await cutOverWikiFact(editId);
    process.env[FORCE_LEGACY_ENV] = '1';
    invalidateMigrationStateCache();

    for (const reviewer of world.reviewers) {
      await verdict({ editId, reviewer, verdict: 'approve' });
    }

    expect(await statusOf(editId)).toBe('approved');
    expect(await pageContainsFact(world.pageId, 'fact-halflife-1')).toBe(true);

    // …and the generic engine recorded nothing authoritative, which is the
    // difference between "the switch worked" and "the switch was ignored and
    // both engines happened to agree".
    const link = await findByLegacy(db, 'pending_edit', editId);
    const version = await latestVersion(db, link!.genericId);
    expect(
      await latestDecisionForVersion(db, version!.id, 'authoritative'),
    ).toBeNull();
  });
});
