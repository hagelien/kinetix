/**
 * Phase 10: replay and property coverage for calculation-driving targets.
 *
 * §10 puts ten prerequisites in front of `parameter` and `param_entry`, and a
 * quantified evidence gate: 1,000 shadow decision opportunities or 30 days of
 * production comparison, whichever is longer, with zero unexplained permissive
 * divergences. This repository has neither yet — and the plan says exactly what
 * to do about that:
 *
 *   > If volume is low, supplement with replay/property testing across
 *   > historical and synthetic edge cases. Do not weaken the correctness
 *   > criterion merely to reach a date.
 *
 * This is that supplement. It discharges prerequisites 3, 4 and 5 against real
 * SQL, and asserts the one-directional invariant §1.7 actually cares about.
 *
 * ## The property is an inequality, not an equality
 *
 * Phase 6's matrix asks whether the two engines agree. That is the right
 * question for a low-risk cutover and the wrong one here, because agreement is
 * symmetric and the risk is not: the generic engine being *more conservative*
 * than legacy costs review backlog, while being *more permissive* publishes a
 * calculation-driving value nobody approved. So the property asserted over
 * every synthetic case is one-directional — **generic never publishes what
 * legacy holds** — which is strictly stronger in the direction that matters and
 * deliberately silent in the direction that does not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentVerifications, agents, disputes, drugs, pendingEdits } from '../../../db/schema.js';
import {
  collectConsensusFacts,
  evaluateShadowPolicy,
  type ConsensusFacts,
} from '../../../api/_lib/knowledge-governance/policy-shadow.js';
import {
  HIGH_RISK_EDIT_TYPES,
  MIN_OBSERVATION_DAYS,
  MIN_SHADOW_OPPORTUNITIES,
  PROPERTY_COVERAGE,
  assessHighRiskReadiness,
  collectShadowEvidence,
  describeHighRiskVerdict,
  isHighRiskEditType,
} from '../../../api/_lib/knowledge-governance/high-risk-gate.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

// ──────────────────────────────────────────────────────────────────────────
// FROZEN REFERENCE — the legacy gate's decision, transcribed from
// `applyOnAgentConsensus` and deliberately not imported. Its only value is
// that it cannot move when the production code moves.
// ──────────────────────────────────────────────────────────────────────────

function frozenLegacyOutcome(facts: ConsensusFacts): 'apply' | 'hold' {
  if (facts.editType === 'clinical_case') return 'hold';
  if (!facts.submitterIsAgent) return 'hold';
  // The payload precondition: a calculation-driving value with no verbatim
  // source quote does not publish unattended, whatever the tally says.
  // Transcribed here because this reference is the whole gate — a precondition
  // it omits is one the property below would compare the engine against an
  // outdated Kinetix for, and it would pass by measuring the wrong thing.
  if (facts.lacksSourceQuote) return 'hold';
  if (facts.summary.disputeCount > 0) return 'hold';
  if (facts.summary.approveCount < facts.quorum) return 'hold';
  if (facts.highRisk) {
    if (facts.summary.approveCount < 2) return 'hold';
    if ((facts.summary.approveTier2Count ?? 0) < 1) return 'hold';
  }
  if (facts.hasOpenHumanDispute) return 'hold';
  return 'apply';
}

// ──────────────────────────────────────────────────────────────────────────

interface Pool {
  authorId: number;
  drugId: number;
  agentIds: number[];
  agentUserIds: number[];
}

/** `n` active verifier agents plus an agent author, with the given tiers. */
async function seedPool(tiers: Array<string | null>): Promise<Pool> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId: authorId,
    name: 'author-agent',
    slug: 'author-agent',
    status: 'active',
  });
  const drugId = await seedDrug(db, { slug: 'diazepam' });

  const agentIds: number[] = [];
  const agentUserIds: number[] = [];
  for (const [i, tier] of tiers.entries()) {
    const userId = await seedUser(db, {
      email: `v${i}@example.com`,
      username: `verifier-${i}`,
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId,
        name: `verifier-${i}`,
        slug: `verifier-${i}`,
        status: 'active',
        modelTier: tier,
      })
      .returning({ id: agents.id });
    agentIds.push(agent!.id);
    agentUserIds.push(userId);
  }
  return { authorId, drugId, agentIds, agentUserIds };
}

async function seedHighRiskEdit(
  pool: Pool,
  opts: { editType?: string; parameter?: string; quote?: string | null } = {},
): Promise<number> {
  // A real high-risk proposal carries a source quote, and one without it is
  // held by the payload precondition before any of the tier/quorum logic these
  // prerequisites exercise is reached. So the fixture carries one by default
  // and takes `quote: null` for the cases that want it absent.
  const quote =
    opts.quote === null
      ? null
      : (opts.quote ?? 'Terminal half-life averaged 33 h in healthy adults.');
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: opts.editType ?? 'parameter',
      targetId: pool.drugId,
      parameter: opts.parameter ?? 'halfLife',
      proposedValue: { value: 33 },
      proposedMeta: quote === null ? null : { sourceQuote: quote },
      submittedBy: pool.authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

async function approve(
  editId: number,
  agentId: number,
  verifierTier: string | null,
  verdict: 'approve' | 'dispute' | 'abstain' = 'approve',
): Promise<void> {
  await db.insert(agentVerifications).values({
    agentId,
    targetType: 'pending_edit',
    targetId: editId,
    verdict,
    verifierTier,
    rationaleMd: verdict === 'approve' ? '' : 'Begrunnelse for denne vurderingen.',
  });
}

describe('the gate identifies its own scope', () => {
  it('covers exactly the calculation-driving edit types', () => {
    expect([...HIGH_RISK_EDIT_TYPES]).toEqual(['parameter', 'param_entry']);
    expect(isHighRiskEditType('parameter')).toBe(true);
    expect(isHighRiskEditType('wiki_fact')).toBe(false);
  });

  it('names the test discharging each mechanical prerequisite', () => {
    // Kept in code rather than in a document so a prerequisite whose test is
    // deleted stops being listed as covered.
    for (const [prerequisite, file] of Object.entries(PROPERTY_COVERAGE)) {
      expect(file, prerequisite).toMatch(/^tests\/governance\//);
    }
    expect(Object.keys(PROPERTY_COVERAGE).length).toBeGreaterThanOrEqual(7);
  });
});

describe('prerequisite 3 — the flagship snapshot survives tier changes', () => {
  it('keeps a verdict flagship after the agent is downgraded', async () => {
    // `agent_verifications.verifier_tier` is stamped at verdict time (migration
    // 0113). Re-reading the live agent row would let a downgrade retroactively
    // strip a valid flagship approval.
    const pool = await seedPool(['flagship', 'mid']);
    const editId = await seedHighRiskEdit(pool);
    await approve(editId, pool.agentIds[0]!, 'flagship');
    await approve(editId, pool.agentIds[1]!, 'mid');

    const before = await collectConsensusFacts(editId);
    expect(before!.summary.approveTier2Count).toBe(1);

    await db.update(agents).set({ modelTier: 'light' }).where(eq(agents.id, pool.agentIds[0]!));
    const after = await collectConsensusFacts(editId);
    expect(after!.summary.approveTier2Count).toBe(1);
    expect(evaluateShadowPolicy(after!).outcome).toBe(
      evaluateShadowPolicy(before!).outcome,
    );
  });

  it('does not let a later upgrade manufacture a flagship approval', async () => {
    // The other direction, and the one that would actually publish something:
    // two mid-tier approvals must not become sufficient because an agent was
    // promoted afterwards.
    const pool = await seedPool(['mid', 'mid']);
    const editId = await seedHighRiskEdit(pool);
    await approve(editId, pool.agentIds[0]!, 'mid');
    await approve(editId, pool.agentIds[1]!, 'mid');
    expect(evaluateShadowPolicy((await collectConsensusFacts(editId))!).outcome).toBe('hold');

    await db.update(agents).set({ modelTier: 'flagship' }).where(eq(agents.id, pool.agentIds[0]!));
    const after = await collectConsensusFacts(editId);
    expect(after!.summary.approveTier2Count).toBe(0);
    expect(evaluateShadowPolicy(after!).outcome).toBe('hold');
  });

  it('holds when a flagship verifier is revoked from the pool entirely', async () => {
    // Revocation shrinks the pool, which changes the quorum. The snapshot keeps
    // the verdict's tier; it does not keep the agent eligible.
    const pool = await seedPool(['flagship', 'mid', 'mid']);
    const editId = await seedHighRiskEdit(pool);
    await approve(editId, pool.agentIds[0]!, 'flagship');
    await approve(editId, pool.agentIds[1]!, 'mid');
    expect(evaluateShadowPolicy((await collectConsensusFacts(editId))!).outcome).toBe('apply');

    await db
      .update(agents)
      .set({ status: 'deactivated' })
      .where(eq(agents.id, pool.agentIds[0]!));
    const after = await collectConsensusFacts(editId);
    // The verdict row and its tier snapshot survive as testimony, but a
    // revoked agent no longer has standing, so consensus stops counting it
    // (issue #1357: a retry after the revocation must not publish on it).
    // Without its flagship approval the high-risk edit holds.
    expect(after!.summary.approveCount).toBe(1);
    expect(after!.summary.approveTier2Count).toBe(0);
    expect(after!.activeAgents).toBe(3);
    expect(evaluateShadowPolicy(after!).outcome).toBe('hold');
  });
});

describe('prerequisite 4 — full vs degraded quorum', () => {
  it.each([
    // [pool tiers, approvals (tier), expected outcome]
    [['flagship', 'mid'], [['flagship'], ['mid']], 'apply'],
    [['flagship', 'mid'], [['flagship']], 'hold'],
    [['flagship'], [['flagship']], 'hold'],
    [['mid', 'mid'], [['mid'], ['mid']], 'hold'],
  ])(
    'pool %j with approvals %j resolves to %s',
    async (tiers, approvals, expected) => {
      const pool = await seedPool(tiers as string[]);
      const editId = await seedHighRiskEdit(pool);
      for (const [i, [tier]] of (approvals as string[][]).entries()) {
        await approve(editId, pool.agentIds[i]!, tier!);
      }
      const facts = await collectConsensusFacts(editId);
      expect(evaluateShadowPolicy(facts!).outcome).toBe(expected);
      // And the frozen legacy reference agrees, on real collected facts.
      expect(frozenLegacyOutcome(facts!)).toBe(expected);
    },
  );

  it('never lets a degraded pool carry a high-risk edit on one approval', async () => {
    // The whole point of the high-risk clause: a lone verifier in a shrunken
    // pool can clear the base quorum, and must still not publish a value that
    // feeds every calculation.
    const pool = await seedPool(['flagship']);
    const editId = await seedHighRiskEdit(pool);
    await approve(editId, pool.agentIds[0]!, 'flagship');
    const facts = await collectConsensusFacts(editId);
    expect(facts!.quorum).toBe(1);
    expect(facts!.summary.approveCount).toBe(1);
    expect(evaluateShadowPolicy(facts!).outcome).toBe('hold');
  });
});

describe('prerequisite 5 — open-dispute blocking', () => {
  it('holds on an agent dispute verdict', async () => {
    const pool = await seedPool(['flagship', 'mid', 'mid']);
    const editId = await seedHighRiskEdit(pool);
    await approve(editId, pool.agentIds[0]!, 'flagship');
    await approve(editId, pool.agentIds[1]!, 'mid');
    await approve(editId, pool.agentIds[2]!, 'mid', 'dispute');
    const facts = await collectConsensusFacts(editId);
    expect(evaluateShadowPolicy(facts!).outcome).toBe('hold');
    expect(frozenLegacyOutcome(facts!)).toBe('hold');
  });

  it('holds on a human dispute that no agent verdict reflects', async () => {
    // Human disputes live in their own table and never appear in the agent
    // summary, so this is the check that would be silently lost if the generic
    // engine only read verdicts.
    const pool = await seedPool(['flagship', 'mid']);
    const editId = await seedHighRiskEdit(pool);
    await approve(editId, pool.agentIds[0]!, 'flagship');
    await approve(editId, pool.agentIds[1]!, 'mid');
    expect(evaluateShadowPolicy((await collectConsensusFacts(editId))!).outcome).toBe('apply');

    const humanId = await seedUser(db, {
      email: 'moderator@example.com',
      username: 'moderator',
      role: 'editor',
    });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: editId,
      status: 'open',
      source: 'human',
      reasonMd: 'Verdien stemmer ikke med referansen som er oppgitt.',
      createdBy: humanId,
    });

    const facts = await collectConsensusFacts(editId);
    expect(facts!.hasOpenHumanDispute).toBe(true);
    expect(evaluateShadowPolicy(facts!).outcome).toBe('hold');
    expect(frozenLegacyOutcome(facts!)).toBe('hold');
  });
});

describe('the property: generic never publishes what legacy holds', () => {
  /**
   * A synthetic cross-product over the dimensions the high-risk gate reads.
   * Small enough to run against real SQL, wide enough that the interesting
   * combinations — degraded pool, tier-less approvals, disputes alongside a
   * clearing tally — all occur.
   */
  const POOLS: Array<Array<string | null>> = [
    ['flagship'],
    ['flagship', 'mid'],
    ['flagship', 'mid', 'mid'],
    ['mid', 'mid'],
    [null, 'flagship'],
  ];
  const APPROVAL_COUNTS = [0, 1, 2];
  const DISPUTE = [false, true];

  it('holds across every synthetic high-risk combination', async () => {
    let permissiveDivergences = 0;
    let applied = 0;
    let held = 0;

    for (const tiers of POOLS) {
      for (const approvals of APPROVAL_COUNTS) {
        if (approvals > tiers.length) continue;
        for (const dispute of DISPUTE) {
          await resetIntegrationDb(db);
          const pool = await seedPool(tiers);
          const editId = await seedHighRiskEdit(pool);
          for (let i = 0; i < approvals; i += 1) {
            await approve(editId, pool.agentIds[i]!, tiers[i] ?? null);
          }
          if (dispute && approvals < tiers.length) {
            await approve(editId, pool.agentIds[approvals]!, tiers[approvals] ?? null, 'dispute');
          }

          const facts = await collectConsensusFacts(editId);
          const generic = evaluateShadowPolicy(facts!).outcome;
          const legacy = frozenLegacyOutcome(facts!);
          if (generic === 'apply' && legacy === 'hold') permissiveDivergences += 1;
          if (generic === 'apply') applied += 1;
          else held += 1;
        }
      }
    }

    // The property.
    expect(permissiveDivergences).toBe(0);
    // Guard the property: a run where nothing ever published would satisfy the
    // inequality vacuously and prove nothing about the permissive direction.
    expect(applied).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  });
});

describe('the evidence gate refuses on volume', () => {
  it('reports zero opportunities on a fresh database', async () => {
    const evidence = await collectShadowEvidence(db);
    expect(evidence).toEqual({ opportunities: 0, permissive: 0, observationDays: 0 });
  });

  it('blocks a high-risk type on both volume and window', async () => {
    const verdict = await assessHighRiskReadiness('parameter', { db });
    expect(verdict.machineChecksPassed).toBe(false);
    const text = verdict.blockers.join(' ');
    expect(text).toContain(`§10 requires ${MIN_SHADOW_OPPORTUNITIES}`);
    expect(text).toContain(`${MIN_OBSERVATION_DAYS}`);
  });

  it('refuses a low-risk type, pointing at the Phase 9 gate', async () => {
    const verdict = await assessHighRiskReadiness('wiki_fact', { db });
    expect(verdict.blockers.join(' ')).toContain('assessReadiness (Phase 9)');
  });

  it('never reports the operational prerequisites as met', async () => {
    // A gate that counted an unverifiable prerequisite as satisfied because it
    // had no way to check it would produce a green verdict that reads as
    // evidence.
    const verdict = await assessHighRiskReadiness('parameter', { db });
    expect(verdict.unverifiable.length).toBe(2);
    expect(describeHighRiskVerdict(verdict)).toContain('requires human attestation');
  });

  it('inherits every Phase 9 blocker rather than replacing them', async () => {
    const verdict = await assessHighRiskReadiness('parameter', { db });
    for (const blocker of verdict.dossier.blockers) {
      expect(verdict.blockers).toContain(blocker);
    }
  });
});
