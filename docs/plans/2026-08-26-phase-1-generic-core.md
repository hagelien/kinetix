# Phase 1 — Pure generic governance types and policy primitives

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 1, "Introduce pure generic governance types and policy primitives") and
to the Phase 0 freeze in `docs/plans/2026-08-26-phase-0-baseline.md`.

Phase 1 separates *policy concepts* from Kinetix persistence. It introduces no
schema, no routes, and no new endpoint behaviour. Two legacy helpers are rewired
to delegate to the new core so it is exercised by production traffic rather than
sitting inert; their observable behaviour is unchanged and pinned exhaustively.

---

## 1. What was added

### 1.1 The pure core — `src/lib/knowledge-governance/`

Free of Drizzle, Neon, React, HTTP request objects, PubMed/citation logic and
the Kinetix drug modules, as the plan requires.

| File | Owns |
| --- | --- |
| `types.ts` | `SpaceId`, `TargetRef`, `ProposalVersionRef`, `Fingerprint`, and the id aliases (`RequirementId`, `PolicyRuleId`, `PolicyId`, `PolicyVersion`) |
| `actors.ts` | `ActorContext` / `ActorSnapshot`, the action-vs-assurance capability split, `modelTierCapability`, kind predicates |
| `risk.ts` | `RiskLevel`, `RiskProfile`, floor comparison (`atLeastRisk`), tag matching |
| `assurance.ts` | `Assessment`, `AssuranceProfile`, `tallyAssurance`, `ReviewerPoolState`, `effectiveIndependentQuorum`, `reviewerPoolState` |
| `requirements.ts` | The eight requirement primitives and their stable ids |
| `policy.ts` | `PolicyContext`, `RuleMatcher`, the `policy(...)` builder, and the evaluation-order contract |
| `decisions.ts` | `PolicyDecision`, `stableStringify`, `fingerprint`, `fingerprintPolicyContext` |
| `index.ts` | Core barrel. Deliberately does **not** re-export `kinetix/` |

### 1.2 The Kinetix host layer — `src/lib/knowledge-governance/kinetix/`

| File | Owns |
| --- | --- |
| `policy.ts` | The `kinetix-consensus@v1` policy set: four rules, stable ids |
| `projection.ts` | Legacy ⇄ generic compatibility: `assuranceFromLegacySummary`, `projectLegacyConsensusContext`, `governanceConsensusHoldReason`, `governanceEffectiveConsensusQuorum`, `projectKinetixVerificationLevel` |

Kept under `src/lib/` rather than `api/_lib/` because it is pure and because
`api/` may import from `src/` while the reverse is forbidden. It moves to
`api/_lib/knowledge-governance/adapters/kinetix/` when Phase 2 introduces that
directory.

### 1.3 The `kinetix-consensus@v1` rules

| Rule id | Condition | Requirements |
| --- | --- | --- |
| `base` | always | `noDisputingAssessments`, `independentApprovalsFromPool` |
| `human-authored` | `authorKind: 'human'` | `humanApproval` |
| `high-risk` | `risk: 'high'` (a floor) | `independentApprovals(2)`, `approvalWithCapability('model_tier:flagship')` |
| `clinical-case` | `riskTags: ['clinical_case']` | `humanApprovalWithCapability('clinical_expert')` |

Declaration order is load-bearing: `consensusHoldReasonFromDecision` maps the
*first* unmet requirement onto the legacy `ConsensusHoldReason`, and the legacy
function checked the base quorum before either high-risk clause.

`base` and `high-risk` are authoritative through delegation. `human-authored`
and `clinical-case` are declarations of invariants Kinetix enforces elsewhere in
the request path — nothing routes through this policy for them yet. They are
here so the generic layer models the whole gate rather than the convenient third
of it, and so later phases have something to cut over to rather than something
to invent.

---

## 2. What was rewired

`api/_lib/agent-verifications.ts`, two functions, bodies only:

| Function | Now |
| --- | --- |
| `consensusApprovalHoldReason` | `return governanceConsensusHoldReason(summary, quorum, opts)` |
| `effectiveConsensusQuorum` | `return governanceEffectiveConsensusQuorum(activeAgentCount, opts)` |

Signatures, exported names and return values are unchanged.
`ConsensusHoldReason` is now an alias of the core's `LegacyConsensusHoldReason`;
the three string values are identical. `meetsConsensusApprovalQuorum`,
`isConsensusQuorumDegraded`, `isHighRiskPendingEdit` and
`AGENT_CONSENSUS_APPROVE_QUORUM` are untouched.

This is the plan's own "example compatibility approach", and it is what makes
the stated rollback — *revert imports, no schema impact* — literally true.

---

## 3. Design decisions worth stating

**Matchers are declarative, not closures.** A closure can read anything, cannot
be serialised into a decision record, and cannot be explained back to a user.
All three are requirements, so `RuleMatcher` is a plain object and `describe()`
returns data.

**Risk matching is a floor, not equality.** A rule written for medium risk must
not silently stop applying to something riskier. An unknown level in a matcher
fails closed rather than matching everything.

**An empty matcher is normalised to `null` at build time.** `when: {}` and an
omitted `when` are documented as equivalent, and without normalising they were
not: the empty object counted as a matched *conditional* rule and so suppressed
every `.otherwise()` rule, dropping the fallback's requirements. Empty
`riskTags`/`flags` lists normalise the same way ("every tag in `[]`" is
vacuously true). An empty `authorKind`/`targetType` list deliberately does not:
"the kind is one of `[]`" can never hold, so that is a never-match rule, and
turning it into an always-match would inverse what its author wrote.

**A built policy is deep-frozen, matchers copied.** `PolicySet.rules` is the
same array `evaluate` captured, so leaving it mutable would let a consumer
splice rules into an already-versioned policy — changing what it requires while
persisted records still name the old version. `build()` freezes the array, each
rule, each requirement list, and a *copy* of each matcher (a caller that
loosened its own matcher object afterwards would otherwise loosen the policy).

**`humanApprovalWithCapability` is one primitive, not two.** `humanApproval()`
plus `approvalWithCapability(cap)` is satisfiable by an unqualified human and a
qualified agent between them, which is not what "a qualified person signed this
off" means. `AssuranceProfile.humanApprovalCapabilities` exists for exactly this.

**Every applicable requirement is evaluated, not just up to the first failure.**
A proposal held for three reasons should be able to say all three, so its author
fixes them in one pass instead of three round-trips.

**The fingerprint is not cryptographic and not `node:crypto`.** This module is
bundled into the browser build. Its only job is change detection and audit
correlation; nothing is authorised by matching one.

**Set-like arrays are canonicalised before fingerprinting.** Risk tags, approval
capabilities and actor capabilities are read by `.includes()`, so reordering one
cannot change a decision — and must not change its fingerprint either, or parity
tooling reports differing inputs for an identical decision. `tallyAssurance`
already sorts what it produces; the sort in `fingerprintPolicyContext` covers
profiles a host built by hand, which the legacy projection does.
`evidenceRequirementState` is deliberately excluded: its order is observable in
`evidenceRequirementsSatisfied`'s outcome detail, so it is a sequence the host
chose rather than a set.

**`poolStateFromEffectiveQuorum` leaves the pool size `null`.** Several pools
clamp to the same quorum, so any number back-derived from one would be a guess —
and this state is fingerprinted into decision records, where a guess is recorded
as fact.

**The legacy projection sets `disputesOpen: 0`.** The legacy
`consensusApprovalHoldReason` knows only about agent dispute *verdicts*; human
disputes live in a separate table and are checked by its caller
(`applyOnAgentConsensus`). Modelling them as zero is what keeps the projection
exactly equivalent — the human-dispute check has not moved.

**The legacy projection does not name an author to `tallyAssurance`.** Kinetix's
admission rules already do that job upstream: an author's own explicit verdict
can exist only under an admin's `agents.self_review_enabled` grant, and that
grant simultaneously enlarges the reviewer pool. Every explicit approve row that
reaches the gate is therefore one it is entitled to count.

---

## 4. Exit gate

| Plan requirement | Evidence |
| --- | --- |
| existing unit tests pass unchanged | `npm run test` → 5060 passed. The 12 failures in `EditFactPanel`, `drug-parameter-route`, `pending-edits-approval-token`, `paper-extractions-route` and `parameter-write-guards` reproduce identically on a clean `origin/main` checkout and are untouched by this change |
| | `npm run test:integration` → 63 files / 905 tests passed |
| generic pure functions have direct tests | `tests/governance/core/` — `actors-and-risk`, `assurance`, `requirements`, `policy`, `decisions` |
| legacy and generic policy outcomes match on an exhaustive fixture matrix | `tests/governance/policy/kinetix-consensus-parity.test.ts` — 1440-case cross-product for the hold reason, 16 cases for the quorum, both compared against a **frozen verbatim copy** of the pre-Phase-1 algorithm |
| no endpoint behaviour changed | No file under `api/*.ts`, `db/`, or `src/pages/` modified; only two function bodies in `api/_lib/agent-verifications.ts` |

### Why the parity test freezes a copy

Comparing the legacy helper against the generic implementation would be circular
once the helper delegates — both are the same code. So the reference side of
every comparison is a verbatim copy of the algorithm as it stood before the harmonization,
inlined into the test and deliberately not imported from anywhere. Its whole
value is that it cannot change when the production code changes. A future phase
that intends to change one of these decisions must update the frozen copy in the
same commit, stating the behaviour change — which is the friction it exists to
create.

The matrix also asserts that all four outcomes (`null` plus the three hold
reasons) are actually reached, so agreement across 1440 cases cannot pass
vacuously by every case falling down one branch.

---

## 5. Rollback

Revert the two function bodies in `api/_lib/agent-verifications.ts` to their
inline implementations. `src/lib/knowledge-governance/` then has no production
caller and can be left in place or deleted. No schema impact, no data migration,
no coordination with a deploy.
