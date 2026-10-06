/**
 * Kinetix's publication policy, expressed in the generic core's primitives.
 *
 * This is the host layer, not the core: it names Kinetix's capabilities and
 * risk tags. It still imports nothing from Drizzle, Neon, React or HTTP — the
 * facts it reasons about arrive as a `PolicyContext` that somebody else built.
 *
 * ## What this policy is, and is not, today
 *
 * It is a faithful statement of the gate Kinetix already enforces. The
 * consensus part of it is authoritative *through delegation*:
 * `consensusApprovalHoldReason` in `api/_lib/agent-verifications.ts` is now a
 * thin projection onto this policy (see `./projection.ts`), and the equivalence
 * is pinned exhaustively by
 * `tests/governance/policy/kinetix-consensus-parity.test.ts`.
 *
 * The `unattributed` and `clinical-case` rules are *declarations* of
 * invariants Kinetix enforces elsewhere in the request path — a proposal with
 * no recorded author never publishes on agent consensus, a clinical case needs
 * a human with clinical standing. (A person's proposal does publish on agent
 * consensus since v2; `human-authored`, which forbade it, is retired.) Nothing routes through this policy for them yet;
 * they are here so the generic layer models the whole gate rather than the
 * convenient third of it, and so later phases have something to cut over to
 * rather than something to invent.
 */

import {
  approvalWithCapability,
  humanApproval,
  humanApprovalWithCapability,
  independentApprovals,
  independentApprovalsFromPool,
  modelTierCapability,
  noDisputingAssessments,
  noOpenDisputes,
  policy,
} from 'assurance-core';
import type { PolicySet } from 'assurance-core';

export const KINETIX_POLICY_ID = 'kinetix-consensus';

/**
 * Bump on any change to the rules below, and never edit a rule in place
 * without bumping: persisted decision records name this version, and a
 * silently-changed `v1` would claim old content was published under new rules.
 *
 * v2 retires `human-authored` and adds `unattributed` (see the rule).
 */
export const KINETIX_POLICY_VERSION = 'v2';

/**
 * Two independent approvals. The same design target the legacy
 * `AGENT_CONSENSUS_APPROVE_QUORUM` names; restated here because a policy's
 * integrity target is a property of the policy, not of the helper module that
 * happened to hold the constant first.
 */
export const KINETIX_DESIGN_TARGET_QUORUM = 2;

/** The server-owned tier that satisfies the high-risk capability gate. */
export const KINETIX_FLAGSHIP_CAPABILITY = modelTierCapability('flagship');

/** Assurance capability standing for "this person is a clinical expert". */
export const KINETIX_CLINICAL_EXPERT_CAPABILITY = 'clinical_expert';

/** Risk tag the host attaches to clinical-case content. */
export const KINETIX_CLINICAL_CASE_TAG = 'clinical_case';

/**
 * Risk tag for a calculation-driving proposal that records no verbatim source
 * quote — the payload precondition `highRiskEditLacksSourceQuote` applies.
 *
 * A tag rather than a rule condition of its own because the host is what knows
 * how to read a payload; the policy's job is to say what an unquoted one needs.
 */
export const KINETIX_UNQUOTED_TAG = 'unquoted_calculation_driving';

/** Stable rule ids. These reach persisted decision records — do not renumber. */
export const KINETIX_RULE_IDS = {
  base: 'base',
  /** Retired in `kinetix-consensus@v2` / `kinetix-consensus-apply@v3`; kept because persisted v1/v2 records name it. */
  humanAuthored: 'human-authored',
  unattributed: 'unattributed',
  highRisk: 'high-risk',
  clinicalCase: 'clinical-case',
  unquoted: 'unquoted-calculation-driving',
} as const;

/**
 * Build the policy set. A factory rather than a module-level constant so tests
 * can hold an isolated instance, and so the rule objects are never shared
 * mutable state across callers.
 *
 * Declaration order is load-bearing: `./projection.ts` maps the *first* unmet
 * requirement onto the legacy `ConsensusHoldReason`, and the legacy function
 * checks the base quorum before either high-risk clause. See `evaluatePolicy`
 * in `../policy.ts` for the exact ordering contract.
 */
export function buildKinetixPolicy(): PolicySet {
  return policy(KINETIX_POLICY_ID, KINETIX_POLICY_VERSION)
    .rule({
      id: KINETIX_RULE_IDS.base,
      require: [
        // A dispute holds the proposal however many approvals it carries:
        // approvals and disputes are not netted off against one another.
        noDisputingAssessments(),
        // Pool-adapted rather than fixed, so a small deployment does not
        // accumulate unreviewable proposals behind an unreachable bar.
        independentApprovalsFromPool(),
      ],
    })
    // v2 retires `human-authored`: a person's proposal publishes on agent
    // consensus under the same bar as an agent's. What still needs a person is
    // a proposal nobody can be named as the author of (`unattributed`), a
    // clinical case, and anything a dispute holds.
    .rule({
      id: KINETIX_RULE_IDS.unattributed,
      when: { authorKind: 'system' },
      require: [humanApproval()],
    })
    .rule({
      id: KINETIX_RULE_IDS.highRisk,
      when: { risk: 'high' },
      require: [
        // Never rides the degraded single-approval path: a value that feeds
        // every calculation in the app waits for the full design target rather
        // than publishing under a relaxed quorum.
        independentApprovals(KINETIX_DESIGN_TARGET_QUORUM),
        // …and at least one approver must have been flagship-tier at verdict
        // time, so two mid-tier reviewers sharing a blind spot cannot
        // auto-publish it between them.
        approvalWithCapability(KINETIX_FLAGSHIP_CAPABILITY),
      ],
    })
    .rule({
      id: KINETIX_RULE_IDS.clinicalCase,
      when: { riskTags: [KINETIX_CLINICAL_CASE_TAG] },
      // One actor must be both human and clinically qualified; see
      // `humanApprovalWithCapability` for why this is not two requirements.
      require: [humanApprovalWithCapability(KINETIX_CLINICAL_EXPERT_CAPABILITY)],
    })
    .build();
}

/** Shared instance for production callers; the rules are frozen and stateless. */
export const KINETIX_POLICY: PolicySet = buildKinetixPolicy();

export const KINETIX_APPLY_POLICY_ID = 'kinetix-consensus-apply';
/**
 * v2 adds `unquoted-calculation-driving`. Bumped rather than edited in place
 * per the note on `KINETIX_POLICY_VERSION`: persisted decision records name the
 * version, and a silently-extended `v1` would claim decisions made under the
 * old rule set had been made under the new one. Cheap here because this policy
 * is still shadow-only — no published decision was ever taken under it.
 *
 * v3 retires `human-authored` (a person's proposal publishes on agent
 * consensus like an agent's) and adds `unattributed` for a proposal with no
 * recorded author, which still needs a person.
 */
export const KINETIX_APPLY_POLICY_VERSION = 'v3';

/**
 * The whole agent-consensus auto-apply gate (Phase 6).
 *
 * A *second* policy rather than a rule added to `kinetix-consensus@v1`, for two
 * reasons. The narrow one is that editing a versioned policy in place is what
 * the note above forbids: persisted records name the version. The substantive
 * one is that these are genuinely different questions.
 * `kinetix-consensus@v1` answers "what is the hold reason for this tally?" and
 * is authoritative through delegation. This one answers "may
 * `applyOnAgentConsensus` publish this?", which the legacy path decides with
 * checks that live outside the tally entirely — a clinical case is refused
 * before any counting happens, an unattributed proposal is refused whatever
 * the count, and a human dispute lives in a table the tally never reads.
 *
 * Nothing routes through this yet. It is evaluated in `shadow` mode and
 * compared against the legacy outcome.
 *
 * Two things the legacy gate does that deliberately do **not** appear here:
 *
 *  - **Stale version.** Legacy refuses inside `applyApprovedEdit` when the
 *    review token no longer matches. In the generic model that case does not
 *    exist as a rule: assessments are bound to the version they judged (§8.3),
 *    so an approval cast against an older payload simply is not counted and the
 *    proposal holds on `quorum_unmet` instead. Same outcome, and one fewer
 *    special case — which is the point of version-bound assessment.
 *  - **Apply-time faults** (a parameter collision, a moved wiki-fact anchor).
 *    Those are the host adapter's business, not the policy's: the policy
 *    decides eligibility, and the host decides whether the write can land.
 */
export function buildKinetixApplyPolicy(): PolicySet {
  return policy(KINETIX_APPLY_POLICY_ID, KINETIX_APPLY_POLICY_VERSION)
    .rule({
      id: KINETIX_RULE_IDS.base,
      require: [
        noDisputingAssessments(),
        independentApprovalsFromPool(),
        // The addition that makes this the whole gate. Legacy checks human
        // disputes separately from the tally because they live in a different
        // table; here they are one more requirement on the same context.
        noOpenDisputes(),
      ],
    })
    .rule({
      id: KINETIX_RULE_IDS.unattributed,
      when: { authorKind: 'system' },
      require: [humanApproval()],
    })
    .rule({
      id: KINETIX_RULE_IDS.highRisk,
      when: { risk: 'high' },
      require: [
        independentApprovals(KINETIX_DESIGN_TARGET_QUORUM),
        approvalWithCapability(KINETIX_FLAGSHIP_CAPABILITY),
      ],
    })
    .rule({
      id: KINETIX_RULE_IDS.unquoted,
      when: { riskTags: [KINETIX_UNQUOTED_TAG] },
      // A human approval, which agent consensus cannot supply — which is
      // exactly what the legacy gate does: it withholds UNATTENDED publication
      // of a calculation-driving value nobody quoted, while leaving a human
      // moderator free to approve it. Stating it as a requirement rather than
      // an early refusal is what lets the migration dossier see it: the legacy
      // outcome is re-derived from the same facts, so a precondition missing
      // here would make the two sides agree precisely where the generic engine
      // is looser than Kinetix — a severity-1 divergence reported as none.
      require: [humanApproval()],
    })
    .rule({
      id: KINETIX_RULE_IDS.clinicalCase,
      when: { riskTags: [KINETIX_CLINICAL_CASE_TAG] },
      require: [humanApprovalWithCapability(KINETIX_CLINICAL_EXPERT_CAPABILITY)],
    })
    .build();
}

/** Shared instance. Shadow-only; nothing in Kinetix routes through it yet. */
export const KINETIX_APPLY_POLICY: PolicySet = buildKinetixApplyPolicy();
