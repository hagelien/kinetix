/**
 * Phase 6: gathering the gate's facts from live state, and persisting the
 * shadow decision.
 *
 * The parity matrix next door proves the *reasoning* matches. This proves the
 * inputs are gathered from the same places the legacy gate reads them from —
 * a matrix that agrees on facts nobody collected correctly proves nothing — and
 * that the decision lands in `kg_policy_decisions` naming the version it was
 * made about.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  disputes,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import {
  collectConsensusFacts,
  evaluateShadowPolicy,
  recordShadowDecision,
} from '../../../api/_lib/knowledge-governance/policy-shadow.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { mirrorProposalVersion } from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  latestDecisionForVersion,
  latestVersion,
  findByLegacy,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
});

interface World {
  editId: number;
  authorId: number;
  authorAgentId: number;
  verifierAgentId: number;
  verifierUserId: number;
}

async function seedWorld(
  opts: { editType?: string; parameter?: string | null; humanAuthor?: boolean } = {},
): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  const verifierUserId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier-agent',
    role: 'contributor',
  });
  const [authorAgent] = opts.humanAuthor
    ? [{ id: 0 }]
    : await db
        .insert(agents)
        .values({
          userId: authorId,
          name: 'author-agent',
          slug: 'author-agent',
          status: 'active',
        })
        .returning({ id: agents.id });
  const [verifierAgent] = await db
    .insert(agents)
    .values({
      userId: verifierUserId,
      name: 'verifier-agent',
      slug: 'verifier-agent',
      status: 'active',
      modelTier: 'flagship',
    })
    .returning({ id: agents.id });

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      content: { type: 'doc', content: [] },
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: opts.editType ?? 'wiki_fact',
      targetId: page!.id,
      parameter: opts.parameter ?? null,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 30 timer.',
      proposedValue: { factStatement: 'Halveringstiden er 30 timer.' },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  return {
    editId: edit!.id,
    authorId,
    authorAgentId: authorAgent!.id,
    verifierAgentId: verifierAgent!.id,
    verifierUserId,
  };
}

describe('collectConsensusFacts', () => {
  it('reads the tally, the pool and the risk classification', async () => {
    const world = await seedWorld({ editType: 'parameter', parameter: 'halfLife' });
    await db.insert(agentVerifications).values({
      agentId: world.verifierAgentId,
      targetType: 'pending_edit',
      targetId: world.editId,
      verdict: 'approve',
      verifierTier: 'flagship',
    });

    const facts = await collectConsensusFacts(world.editId);
    expect(facts).not.toBeNull();
    expect(facts!.summary.approveCount).toBe(1);
    expect(facts!.summary.approveTier2Count).toBe(1);
    expect(facts!.activeAgents).toBe(2);
    // Two active agents, no self-review grant: one eligible verifier, so the
    // pool-adapted quorum is 1.
    expect(facts!.quorum).toBe(1);
    expect(facts!.highRisk).toBe(true);
    expect(facts!.submitterIsAgent).toBe(true);
  });

  it('sees an open human dispute the agent tally cannot', async () => {
    const world = await seedWorld();
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: world.editId,
      createdBy: world.verifierUserId,
      source: 'human',
      reasonMd: 'Kilden støtter ikke påstanden slik den er formulert.',
      status: 'open',
    });
    const facts = await collectConsensusFacts(world.editId);
    expect(facts!.hasOpenHumanDispute).toBe(true);
    expect(facts!.summary.disputeCount).toBe(0);
    // And the gate holds on it, which is the whole reason it is collected.
    expect(evaluateShadowPolicy(facts!).reasons).toContain('disputes.none');
  });

  it('marks a human submitter as not an agent, held on the tally alone', async () => {
    // A person's proposal publishes on agent consensus under the same bar as
    // an agent's (kinetix-consensus-apply@v4): it waits on approvals, not on
    // a human approval.
    const world = await seedWorld({ humanAuthor: true });
    const facts = await collectConsensusFacts(world.editId);
    expect(facts!.submitterIsAgent).toBe(false);
    const reasons = evaluateShadowPolicy(facts!).reasons;
    expect(reasons).not.toContain('assurance.humanApproval');
    expect(reasons).toContain('assurance.independentApprovals.pool');
  });

  it('returns null for an edit that does not exist', async () => {
    expect(await collectConsensusFacts(999_999)).toBeNull();
  });

  it('holds a clinical case at full quorum with no dispute', async () => {
    // Safety-critical, and the case worth proving end-to-end rather than only
    // in the matrix: the facts have to carry the edit type for the rule to fire.
    const world = await seedWorld({ editType: 'clinical_case' });
    await db.insert(agentVerifications).values({
      agentId: world.verifierAgentId,
      targetType: 'pending_edit',
      targetId: world.editId,
      verdict: 'approve',
      verifierTier: 'flagship',
    });
    const facts = await collectConsensusFacts(world.editId);
    const evaluation = evaluateShadowPolicy(facts!);
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.humanApprovalWithCapability');
  });
});

describe('recordShadowDecision', () => {
  beforeEach(async () => {
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
  });

  it('records the decision against the mirrored version, in shadow mode', async () => {
    const world = await seedWorld();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyPendingEditId: world.editId,
    });

    const result = await recordShadowDecision(db, world.editId);
    expect(result?.recorded).toBe(true);

    const link = await findByLegacy(db, 'pending_edit', world.editId);
    const version = await latestVersion(db, link!.genericId);
    const decision = await latestDecisionForVersion(db, version!.id);
    expect(decision).not.toBeNull();
    // Shadow, always: this function has no parameter for anything else.
    expect(decision!.evaluationMode).toBe('shadow');
    expect(decision!.decision).toBe('hold');
    expect(decision!.policyId).toBe('kinetix-consensus-apply');
    // Hardcoded rather than read from the constant on purpose: this test
    // exists to prove a decision names the version it was made under, and
    // comparing the constant against itself would prove nothing. It moves when
    // the apply policy's rules move — v2 added `unquoted-calculation-driving`,
    // v3 retired `human-authored` and added `unattributed`, v4 stopped counting
    // an answered dispute as disputing.
    expect(decision!.policyVersion).toBe('v4');
  });

  it('records the decision that would apply once the quorum is met', async () => {
    const world = await seedWorld();
    await db.insert(agentVerifications).values({
      agentId: world.verifierAgentId,
      targetType: 'pending_edit',
      targetId: world.editId,
      verdict: 'approve',
    });
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyPendingEditId: world.editId,
    });

    const result = await recordShadowDecision(db, world.editId);
    expect(result?.evaluation.outcome).toBe('apply');
    const link = await findByLegacy(db, 'pending_edit', world.editId);
    const version = await latestVersion(db, link!.genericId);
    expect((await latestDecisionForVersion(db, version!.id))!.decision).toBe(
      'apply',
    );
  });

  it('evaluates but writes nothing when no version has been mirrored', async () => {
    // A decision record pointing at no version explains nothing, and inventing
    // a version to hang it on would be worse than not recording it.
    const world = await seedWorld();
    const result = await recordShadowDecision(db, world.editId);
    expect(result?.recorded).toBe(false);
    expect(result?.evaluation.outcome).toBe('hold');
  });

  it('records the policy version, so a later rule change cannot rewrite history', async () => {
    const world = await seedWorld();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyPendingEditId: world.editId,
    });
    await recordShadowDecision(db, world.editId);
    const link = await findByLegacy(db, 'pending_edit', world.editId);
    const version = await latestVersion(db, link!.genericId);
    const decision = await latestDecisionForVersion(db, version!.id);
    expect(decision!.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('leaves the legacy gate entirely alone', async () => {
    // Phase 6 decides nothing. The pending edit is untouched by evaluation.
    const world = await seedWorld();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyPendingEditId: world.editId,
    });
    await recordShadowDecision(db, world.editId);
    const [row] = await db
      .select({ status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, world.editId));
    expect(row!.status).toBe('pending');
  });
});
