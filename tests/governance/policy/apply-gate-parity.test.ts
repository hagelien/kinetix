/**
 * Phase 6: does the generic policy engine reach the same publication decision
 * as `applyOnAgentConsensus`?
 *
 * ## Why the reference is frozen and inlined
 *
 * Phase 1 made `consensusApprovalHoldReason` delegate to the generic policy, so
 * comparing against it would compare the engine to itself. The legacy side here
 * is therefore a **verbatim frozen copy** of the whole gate's decision logic as
 * it stands in `api/agent-verifications.ts`, transcribed as a pure function and
 * deliberately not imported. Its entire value is that it cannot change when the
 * production code changes: a later phase that intends to change one of these
 * decisions must edit this copy in the same commit and say so.
 *
 * The gate is wider than the delegated helper — three of its five checks
 * (clinical case, human author, human dispute) live outside it entirely — so
 * this is a genuinely independent comparison, not a restatement of Phase 1's.
 *
 * ## What "the same decision" means
 *
 * Outcome, not reason. The plan's divergence rule is asymmetric: generic more
 * permissive than legacy is severity 1 and blocks cutover; generic more
 * conservative is survivable but must be explained. Reasons are recorded and
 * asserted where they are interesting, but a matching outcome reached for a
 * differently-phrased reason is the expected result in at least one case, and
 * that case is called out.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyDivergence,
  evaluateShadowPolicy,
  projectConsensusContext,
  type ConsensusFacts,
  type ShadowOutcome,
} from '../../../api/_lib/knowledge-governance/policy-shadow.js';
import type { VerificationSummary } from '../../../api/_lib/agent-verifications.js';
import { genericConsensusHoldReason } from '../../../src/lib/assurance/projection.js';

// ──────────────────────────────────────────────────────────────────────────
// FROZEN REFERENCE — the legacy gate as of api/agent-verifications.ts
// `applyOnAgentConsensus`. Transcribed, not imported. Do not "tidy" it and do
// not make it call production code: both would destroy the only property it
// has.
// ──────────────────────────────────────────────────────────────────────────

const AGENT_CONSENSUS_APPROVE_QUORUM = 2;

/** Frozen copy of `effectiveConsensusQuorum`. */
function frozenEffectiveQuorum(
  activeAgentCount: number,
  opts: { authorSelfReviews?: boolean } = {},
): number {
  const eligible = opts.authorSelfReviews
    ? activeAgentCount
    : activeAgentCount - 1;
  return Math.min(AGENT_CONSENSUS_APPROVE_QUORUM, Math.max(1, eligible));
}

/**
 * Frozen copy of `consensusApprovalHoldReason` as it stood before Phase 1 made
 * it delegate — the same copy `kinetix-consensus-parity.test.ts` holds.
 *
 * Note what the high-risk clause keys on: `approveCount`, **not** the effective
 * quorum. "Degraded quorum" names the situation the edit would have ridden — it
 * cleared a relaxed bar with fewer than the design target's approvals — and not
 * the size of the pool. An earlier draft of this file transcribed it as a check
 * on `quorum`, which made the whole matrix report a false severity-1
 * divergence. That is the failure mode a hand-transcribed reference has, and
 * the reason it is checked against the other frozen copy rather than written
 * from memory.
 */
function frozenHoldReason(
  summary: VerificationSummary,
  quorum: number,
  opts: { highRisk: boolean },
): string | null {
  if (!(summary.disputeCount === 0 && summary.approveCount >= quorum)) {
    return 'quorum_unmet';
  }
  if (opts.highRisk) {
    if (summary.approveCount < AGENT_CONSENSUS_APPROVE_QUORUM) {
      return 'high_risk_degraded_quorum';
    }
    if ((summary.approveTier2Count ?? 0) < 1) {
      return 'high_risk_missing_flagship';
    }
  }
  return null;
}

/**
 * Frozen copy of `applyOnAgentConsensus`'s decision, in its actual order:
 * clinical case, then an unattributed author, then the tally, then human
 * disputes, then the apply itself (which can still refuse on a stale review
 * token).
 *
 * Re-transcribed when a person's proposal began publishing on agent consensus:
 * the early return used to refuse every non-agent author, and now refuses only
 * a proposal with no recorded author. A person's proposal is tallied with every
 * active agent eligible (`frozenEffectiveQuorum`'s self-review arithmetic).
 */
function frozenLegacyGate(facts: {
  editType: string;
  submittedBy: number | null;
  submitterIsAgent: boolean;
  summary: VerificationSummary;
  quorum: number;
  highRisk: boolean;
  hasOpenHumanDispute: boolean;
  staleReviewToken?: boolean;
}): ShadowOutcome {
  if (facts.editType === 'clinical_case') return 'hold';
  if (facts.submittedBy === null) return 'hold';
  if (frozenHoldReason(facts.summary, facts.quorum, { highRisk: facts.highRisk })) {
    return 'hold';
  }
  if (facts.hasOpenHumanDispute) return 'hold';
  if (facts.staleReviewToken) return 'hold';
  return 'apply';
}

// ──────────────────────────────────────────────────────────────────────────

function summary(over: Partial<VerificationSummary> = {}): VerificationSummary {
  return {
    approveCount: 0,
    disputeCount: 0,
    abstainCount: 0,
    implicitApproveCount: 0,
    approveTier2Count: 0,
    ...over,
  };
}

/** Every active agent may verify a person's proposal; an agent author's own seat counts only under self-review. */
function frozenQuorum(activeAgents: number, authorSelfReviews: boolean, submitterIsAgent: boolean) {
  return frozenEffectiveQuorum(activeAgents, {
    authorSelfReviews: authorSelfReviews || !submitterIsAgent,
  });
}

function facts(over: Partial<ConsensusFacts> = {}): ConsensusFacts {
  const activeAgents = over.activeAgents ?? 3;
  const authorSelfReviews = over.authorSelfReviews ?? false;
  const submitterIsAgent = over.submitterIsAgent ?? true;
  return {
    pendingEditId: 1,
    editType: 'wiki_fact',
    parameter: null,
    submittedBy: 7,
    submitterIsAgent: true,
    summary: summary(),
    activeAgents,
    authorSelfReviews,
    quorum: frozenQuorum(activeAgents, authorSelfReviews, submitterIsAgent),
    highRisk: false,
    hasOpenHumanDispute: false,
    ...over,
  };
}

/** Run both sides and classify. */
function compare(f: ConsensusFacts, opts: { staleReviewToken?: boolean } = {}) {
  const legacyOutcome = frozenLegacyGate({ ...f, ...opts });
  const evaluation = evaluateShadowPolicy(f);
  return {
    legacyOutcome,
    evaluation,
    divergence: classifyDivergence({ legacyOutcome, evaluation }),
  };
}

/**
 * The plan's required parity matrix, case for case.
 *
 * Every row asserts the two sides reach the same outcome, and the ones where a
 * particular rule is doing the work also assert *which* requirement the generic
 * engine held on — otherwise a case could agree for the wrong reason.
 */
describe('required parity matrix', () => {
  it('1. human author with the full quorum — applied', () => {
    // A person's proposal publishes on agent consensus under the same bar as
    // an agent's; people are needed only where the agents cannot settle it.
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        submitterIsAgent: false,
        summary: summary({ approveCount: 2 }),
      }),
    );
    expect(legacyOutcome).toBe('apply');
    expect(evaluation.outcome).toBe('apply');
    expect(divergence.severity).toBe('none');
  });

  it('1b. human author short of the quorum — held on quorum', () => {
    // Every active agent may verify a person's proposal, so with three active
    // agents one approval is short of the two the pool can supply.
    const { legacyOutcome, evaluation } = compare(
      facts({
        submitterIsAgent: false,
        summary: summary({ approveCount: 1 }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.independentApprovals.pool');
    expect(evaluation.reasons).not.toContain('assurance.humanApproval');
    expect(genericConsensusHoldReason(evaluation.decision)).toBe('quorum_unmet');
  });

  it('1c. proposal with no recorded author — held for a person whatever the tally', () => {
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        submittedBy: null,
        submitterIsAgent: false,
        summary: summary({ approveCount: 5, approveTier2Count: 3 }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.humanApproval');
    expect(genericConsensusHoldReason(evaluation.decision)).toBe('human_submitted');
    expect(divergence.severity).toBe('none');
  });

  it('2. agent author with no approvals — held', () => {
    const { legacyOutcome, evaluation, divergence } = compare(facts());
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.independentApprovals.pool');
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'quorum_unmet',
    );
    expect(divergence.severity).toBe('none');
  });

  it('3. agent author with one peer approval in a small pool — applied', () => {
    // Two active agents: the author plus one verifier, so the pool-adapted
    // quorum is 1 and that single independent approval clears it.
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({ activeAgents: 2, summary: summary({ approveCount: 1 }) }),
    );
    expect(legacyOutcome).toBe('apply');
    expect(evaluation.outcome).toBe('apply');
    expect(divergence.severity).toBe('none');
  });

  it('4. ordinary agent edit with full quorum — applied', () => {
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({ summary: summary({ approveCount: 2 }) }),
    );
    expect(legacyOutcome).toBe('apply');
    expect(evaluation.outcome).toBe('apply');
    expect(divergence.severity).toBe('none');
  });

  it('5. open dispute — held', () => {
    // A human dispute, which the agent tally never reads. The legacy gate
    // checks it separately; the generic context carries it as a fact.
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        summary: summary({ approveCount: 2 }),
        hasOpenHumanDispute: true,
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('disputes.none');
    // Issue #1375: a standing human dispute must read as `open_dispute`, not
    // the ordinary "waiting for more reviews" `quorum_unmet`.
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'open_dispute',
    );
    expect(divergence.severity).toBe('none');
  });

  it('5c. non-dispute holds keep their own reason (issue 1404)', () => {
    // An upheld ruling, an unrevised return and an unpublished page all fold
    // into `hasOpenHumanDispute` for the decision, but an operator needs the
    // remedy each one names, not "resolve the dispute".
    for (const cause of [
      'open_dispute',
      'upheld_dispute',
      'returned_unrevised',
      'target_unpublished',
    ] as const) {
      const { evaluation } = compare(
        facts({
          summary: summary({ approveCount: 2 }),
          hasOpenHumanDispute: true,
          disputeHoldCause: cause,
        }),
      );
      expect(evaluation.outcome).toBe('hold');
      expect(
        genericConsensusHoldReason(evaluation.decision, cause),
      ).toBe(cause);
    }
  });

  it('5d. unpublished target outranks a short tally (issue 1404)', () => {
    // The legacy gate checks the page before it computes the tally.
    const { evaluation } = compare(
      facts({
        summary: summary({ approveCount: 0 }),
        hasOpenHumanDispute: true,
        disputeHoldCause: 'target_unpublished',
      }),
    );
    expect(evaluation.outcome).toBe('hold');
    expect(
      genericConsensusHoldReason(evaluation.decision, 'target_unpublished'),
    ).toBe('target_unpublished');
    // The other causes still wait behind the tally.
    expect(
      genericConsensusHoldReason(evaluation.decision, 'upheld_dispute'),
    ).toBe('quorum_unmet');
  });

  it('5b. open dispute alongside a high-risk hold — held on the high-risk reason', () => {
    // Issue #1408 (filed from #1403's own review): the base rule's
    // `noOpenDisputes` and the high-risk rule can both be unmet at once (base
    // quorum met, no flagship approver, and a standing human dispute). The
    // real gate's `consensusApprovalHoldReason` — which covers the high-risk
    // sub-reasons — is checked and returned before `hasOpenDispute` ever runs,
    // so the high-risk reason must win even though `base` is declared before
    // `highRisk` in `kinetix-consensus-apply`.
    const { legacyOutcome, evaluation } = compare(
      facts({
        highRisk: true,
        parameter: 'halfLife',
        editType: 'parameter',
        summary: summary({ approveCount: 2, approveTier2Count: 0 }),
        hasOpenHumanDispute: true,
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('disputes.none');
    expect(evaluation.reasons).toContain('assurance.approvalWithCapability');
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'high_risk_missing_flagship',
    );
  });

  it('6. upheld dispute — held while it remains open', () => {
    // Phase 0 doc §5.5: an upheld dispute is cleared by an actual revision,
    // never by a re-stamp. So "upheld" is still an open dispute here.
    const { legacyOutcome, evaluation } = compare(
      facts({
        summary: summary({ approveCount: 3, approveTier2Count: 2 }),
        hasOpenHumanDispute: true,
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
  });

  it('7a. self-review: the grant raises the quorum rather than lowering it', () => {
    // Two active agents and the author self-reviews: the pool is 2, so the
    // quorum goes UP to 2 — the author's own verdict plus one independent one.
    const withGrant = facts({
      activeAgents: 2,
      authorSelfReviews: true,
      summary: summary({ approveCount: 1 }),
    });
    expect(withGrant.quorum).toBe(2);
    const { legacyOutcome, evaluation, divergence } = compare(withGrant);
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(divergence.severity).toBe('none');
  });

  it('7b. self-review: a lone agent can carry its own edit', () => {
    // One active agent with the grant: the deployment the flag exists for.
    const lone = facts({
      activeAgents: 1,
      authorSelfReviews: true,
      summary: summary({ approveCount: 1 }),
    });
    expect(lone.quorum).toBe(1);
    const { legacyOutcome, evaluation, divergence } = compare(lone);
    expect(legacyOutcome).toBe('apply');
    expect(evaluation.outcome).toBe('apply');
    expect(divergence.severity).toBe('none');
  });

  it('7c. high-risk edit short of the base quorum — held on the ordinary reason', () => {
    // Issue #1409 (filed from #1403's own review): the frozen `frozenHoldReason`
    // checks the pool-adjusted base quorum FIRST — `disputeCount === 0 &&
    // approveCount >= quorum` — and only inspects the high-risk-specific
    // requirements once that base condition already holds. Zero approvals on a
    // high-risk edit never cleared any bar, relaxed or not, so this must read
    // as the ordinary `quorum_unmet`, not `high_risk_degraded_quorum` — that
    // reason describes an edit that rode a *relaxed* bar with too few
    // approvals, which this one never did.
    const { legacyOutcome, evaluation } = compare(
      facts({
        highRisk: true,
        parameter: 'halfLife',
        editType: 'parameter',
        summary: summary({ approveCount: 0 }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.independentApprovals.pool');
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'quorum_unmet',
    );
  });

  it('8. high risk with two mid-tier approvals — held', () => {
    // Two mid-tier agents sharing a blind spot must not publish a value that
    // feeds every calculation in the app.
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        highRisk: true,
        parameter: 'halfLife',
        editType: 'parameter',
        summary: summary({ approveCount: 2, approveTier2Count: 0 }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.approvalWithCapability');
    // Issue #1375: a maintainer reading the sweep needs to know a flagship
    // approval is what this edit is waiting on, not just "unmet quorum".
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'high_risk_missing_flagship',
    );
    expect(divergence.severity).toBe('none');
  });

  it('9. high risk with a flagship plus a mid-tier approval — applied', () => {
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        highRisk: true,
        parameter: 'halfLife',
        editType: 'parameter',
        summary: summary({ approveCount: 2, approveTier2Count: 1 }),
      }),
    );
    expect(legacyOutcome).toBe('apply');
    expect(evaluation.outcome).toBe('apply');
    expect(divergence.severity).toBe('none');
  });

  it('10. high risk in a degraded pool — held', () => {
    // A high-risk edit never rides the relaxed single-approval path, even when
    // the pool cannot supply two independent verifiers.
    const degraded = facts({
      activeAgents: 2,
      highRisk: true,
      parameter: 'halfLife',
      editType: 'parameter',
      summary: summary({ approveCount: 1, approveTier2Count: 1 }),
    });
    expect(degraded.quorum).toBe(1);
    const { legacyOutcome, evaluation, divergence } = compare(degraded);
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.independentApprovals');
    // Issue #1375: a degraded high-risk quorum is a different problem from a
    // missing flagship approval, and the sweep response must say which.
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'high_risk_degraded_quorum',
    );
    expect(divergence.severity).toBe('none');
  });

  it('11. clinical case — held even at full quorum with no dispute', () => {
    // Safety-critical: a clinical case is never published on agent consensus
    // alone. Legacy refuses it before any counting; the generic engine states
    // the reason — a human with clinical standing has not signed it off.
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        editType: 'clinical_case',
        summary: summary({ approveCount: 5, approveTier2Count: 3 }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain(
      'assurance.humanApprovalWithCapability',
    );
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'clinical_case',
    );
    expect(divergence.severity).toBe('none');
  });

  it('11b. human-submitted clinical case — held on clinical standing', () => {
    // A person's proposal publishes on agent consensus, but a clinical case
    // never does, whoever wrote it: it needs a human with clinical standing.
    const { legacyOutcome, evaluation } = compare(
      facts({
        editType: 'clinical_case',
        submitterIsAgent: false,
        summary: summary({ approveCount: 5, approveTier2Count: 3 }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain(
      'assurance.humanApprovalWithCapability',
    );
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'clinical_case',
    );
  });

  it('12. stale version — held, and the reason differs on purpose', () => {
    // The one case where the two sides agree on the outcome by different
    // routes. Legacy refuses inside applyApprovedEdit on a review-token
    // mismatch. In the generic model that case does not exist as a rule:
    // assessments are bound to the version they judged (§8.3), so an approval
    // cast against an older payload is simply not counted and the proposal
    // holds on quorum instead. Same answer, one fewer special case.
    const stale = facts({ summary: summary({ approveCount: 0 }) });
    const { legacyOutcome, evaluation, divergence } = compare(stale, {
      staleReviewToken: true,
    });
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.independentApprovals.pool');
    expect(divergence.severity).toBe('none');
  });

  it('13. unknown/null verifier tier never satisfies the flagship gate', () => {
    // An unclassified tier is the absence of a claim, and fails safe.
    const { legacyOutcome, evaluation, divergence } = compare(
      facts({
        highRisk: true,
        parameter: 'halfLife',
        editType: 'parameter',
        summary: summary({ approveCount: 2, approveTier2Count: undefined }),
      }),
    );
    expect(legacyOutcome).toBe('hold');
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.approvalWithCapability');
    expect(divergence.severity).toBe('none');
  });
});

/**
 * The `unquoted-calculation-driving` rule (v2, issue #1358) postdates the
 * frozen legacy reference above and is checked directly rather than through
 * `compare()`, which would otherwise report a spurious divergence for a rule
 * the frozen copy was never meant to model. Exists to pin issue #1375's
 * mapping for the one `AgentConsensusHold` value the matrix above does not
 * reach.
 */
describe('generic hold reason mapping — issue #1375', () => {
  it('missing source quote outranks an also-unmet high-risk rule', () => {
    // Issue #1407 (filed from #1403's own review): in production,
    // `lacksSourceQuote` is only ever true for a high-risk edit
    // (`highRiskProposalWouldPublishUnquoted` requires
    // `highRiskEditNeedsSourceQuote` first) — `highRisk: false` here would be
    // a combination the live gate can never produce. With `highRisk: true`
    // and only a mid-tier approval, BOTH `unquoted` and `highRisk` are unmet
    // at once; `runAgentConsensus` checks the quote before the generic engine
    // is even consulted, so `source_quote_missing` must win regardless of
    // `kinetix-consensus-apply`'s own rule-declaration order.
    const evaluation = evaluateShadowPolicy(
      facts({
        lacksSourceQuote: true,
        highRisk: true,
        parameter: 'halfLife',
        editType: 'parameter',
        summary: summary({ approveCount: 2, approveTier2Count: 0 }),
      }),
    );
    expect(evaluation.outcome).toBe('hold');
    expect(evaluation.reasons).toContain('assurance.humanApproval');
    expect(evaluation.reasons).toContain('assurance.approvalWithCapability');
    expect(genericConsensusHoldReason(evaluation.decision)).toBe(
      'source_quote_missing',
    );
  });
});

/**
 * A cross-product on top of the named cases, so parity is not just thirteen
 * hand-picked points. Every combination is checked for outcome equality and,
 * more importantly, for the one thing that blocks cutover: the generic engine
 * must never publish what the legacy gate holds.
 */
describe('exhaustive outcome parity', () => {
  const EDIT_TYPES = ['wiki_fact', 'parameter', 'clinical_case'] as const;
  const APPROVES = [0, 1, 2, 3] as const;
  const DISPUTES = [0, 1] as const;
  const TIER2 = [undefined, 0, 1] as const;
  const POOLS = [1, 2, 3] as const;

  const rows: ConsensusFacts[] = [];
  for (const editType of EDIT_TYPES) {
    for (const approveCount of APPROVES) {
      for (const disputeCount of DISPUTES) {
        for (const approveTier2Count of TIER2) {
          for (const activeAgents of POOLS) {
            for (const submitterIsAgent of [true, false]) {
              for (const hasOpenHumanDispute of [false, true]) {
                for (const authorSelfReviews of [false, true]) {
                  rows.push(
                    facts({
                      editType,
                      parameter: editType === 'parameter' ? 'halfLife' : null,
                      highRisk: editType === 'parameter',
                      submitterIsAgent,
                      hasOpenHumanDispute,
                      activeAgents,
                      authorSelfReviews,
                      quorum: frozenQuorum(
                        activeAgents,
                        authorSelfReviews,
                        submitterIsAgent,
                      ),
                      summary: summary({
                        approveCount,
                        disputeCount,
                        approveTier2Count,
                      }),
                    }),
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  it('covers a matrix big enough to be worth running', () => {
    expect(rows.length).toBe(
      EDIT_TYPES.length * APPROVES.length * DISPUTES.length * TIER2.length *
        POOLS.length * 2 * 2 * 2,
    );
  });

  it('never publishes something the legacy gate holds', () => {
    // Severity 1 in the plan's terms, and the assertion that actually blocks a
    // cutover. Checked across the whole matrix rather than per case.
    const severityOne = rows
      .map((f) => compare(f))
      .filter((r) => r.divergence.severity === 'severity_1');
    expect(severityOne).toEqual([]);
  });

  it('reaches the same outcome in every case', () => {
    const mismatches = rows
      .map((f) => ({ f, ...compare(f) }))
      .filter((r) => r.legacyOutcome !== r.evaluation.outcome)
      .map((r) => ({
        editType: r.f.editType,
        approve: r.f.summary.approveCount,
        legacy: r.legacyOutcome,
        generic: r.evaluation.outcome,
        reasons: r.evaluation.reasons,
      }));
    expect(mismatches).toEqual([]);
  });

  it('reaches every outcome, so agreement is not vacuous', () => {
    const outcomes = new Set(rows.map((f) => compare(f).legacyOutcome));
    expect([...outcomes].sort()).toEqual(['apply', 'hold']);
  });
});

describe('divergence classification', () => {
  it('calls a more permissive generic decision severity 1', () => {
    const evaluation = evaluateShadowPolicy(
      facts({ summary: summary({ approveCount: 2 }) }),
    );
    expect(evaluation.outcome).toBe('apply');
    const divergence = classifyDivergence({
      legacyOutcome: 'hold',
      evaluation,
    });
    expect(divergence.severity).toBe('severity_1');
    expect(divergence.explanation).toContain('blocks cutover');
  });

  it('calls a more conservative generic decision explainable, not fatal', () => {
    const evaluation = evaluateShadowPolicy(facts());
    expect(evaluation.outcome).toBe('hold');
    const divergence = classifyDivergence({
      legacyOutcome: 'apply',
      evaluation,
    });
    expect(divergence.severity).toBe('conservative');
    expect(divergence.explanation).toContain('review backlog');
    // And it says which requirement held it, so "explained" is achievable.
    expect(divergence.reasons.length).toBeGreaterThan(0);
  });
});

describe('context projection', () => {
  it('marks a non-agent submitter as a human author', () => {
    const context = projectConsensusContext(facts({ submitterIsAgent: false }));
    expect(context.author.kind).toBe('human');
  });

  it('tags a clinical case on the risk profile rather than special-casing it', () => {
    const context = projectConsensusContext(facts({ editType: 'clinical_case' }));
    expect(context.risk.tags).toContain('clinical_case');
  });

  it('carries the human dispute the agent tally cannot see', () => {
    // Phase 1's narrower projection hardcodes 0 here because the function it
    // fed had never heard of human disputes. The whole gate has.
    const context = projectConsensusContext(
      facts({ hasOpenHumanDispute: true }),
    );
    expect(context.assurance.disputesOpen).toBe(1);
  });

  it('leaves the pool size unknown rather than guessing it from the quorum', () => {
    // Several pools clamp to the same quorum, and this state is fingerprinted
    // into decision records, where a guess would be recorded as fact.
    const context = projectConsensusContext(facts({ activeAgents: 3 }));
    expect(context.pool.size).toBeNull();
  });
});
