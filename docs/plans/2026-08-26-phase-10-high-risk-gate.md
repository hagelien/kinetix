# Phase 10 — The high-risk evidence gate

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 10, "High-risk Kinetix cutover"), following Phase 9's per-target
procedure in `2026-08-26-phase-9-cutover-procedure.md`.

Phase 10 governs `parameter` and `param_entry` — the calculation-driving types,
where a wrong value is a wrong dose. It puts ten prerequisites and a quantified
evidence gate in front of them.

**This phase advances nothing.** `CUTOVER_ELIGIBLE_EDIT_TYPES` is unchanged at
`['wiki_fact']`. What it ships is the gate, and the replay coverage the plan
itself prescribes for a repository that does not yet have production volume.

---

## 1. What can be built now, and what cannot

Of the ten prerequisites, seven are statements about the code and three are
statements about operating the system.

| # | Prerequisite | Status |
| --- | --- | --- |
| 1 | append-only history running reliably in production | **operational** — reported as unverifiable |
| 2 | zero unexplained permissive divergences | gate refuses on any permissive shadow decision; production half is operational |
| 3 | flagship snapshot tested against downgrade/revocation races | covered, this phase |
| 4 | full vs degraded quorum matches Kinetix | covered, this phase |
| 5 | open-dispute blocking matches Kinetix | covered, this phase |
| 6 | reference/evidence gate parity | covered by the Phase 6 matrix |
| 7 | param-entry conflict and applicability locks adapter-covered | covered by the Phase 8 prerequisite's transaction tests |
| 8 | recomputation side effects transactionally safe | same |
| 9 | parameter summary/revision writes identical | covered by the Phase 0 legacy contract tests |
| 10 | a high-risk rollback drill has been performed | **operational** — reported as unverifiable |

`PROPERTY_COVERAGE` holds that mapping in code rather than in this document, so
a prerequisite whose test is deleted stops being listed as covered.

### Unverifiable is not met

`assessHighRiskReadiness` reports the operational prerequisites in a separate
`unverifiable` field and never folds them into the verdict. The field it does
return is called `machineChecksPassed`, not `ready`, and that naming is the
point: a gate that produced a green `ready` while two prerequisites were
unexaminable would be producing a verdict that reads as evidence.

---

## 2. The evidence gate

§10 asks for the **longer of** 1,000 shadow decision opportunities or 30 days of
production comparison. Both are enforced, not either: a thousand decisions in a
single afternoon has not observed a month of the system's behaviour, and a month
with four decisions in it has not observed the policy.

Opportunities are counted as *shadow decisions*, not as pending edits. The gate
is about how many times the two engines have been compared — one long-lived edit
re-evaluated fifty times is fifty comparisons, and fifty edits nobody ever
evaluated is none.

The permissive-divergence rule is stricter here than at Tier A. Phase 9 refuses
on a severity-1 divergence among the rows open *today*; this refuses on any
shadow decision in the whole recorded history that concluded `apply`, until each
one has been shown by hand to match what legacy did. A permissive decision is
not automatically wrong — legacy may have published too — but at this tier the
count cannot be called zero without someone having looked.

---

## 3. Replay and property coverage

The plan says what to do when volume is low, and it is not "wait":

> If volume is low, supplement with replay/property testing across historical
> and synthetic edge cases. Do not weaken the correctness criterion merely to
> reach a date.

`tests/governance/cutover/high-risk-replay.test.ts` is that supplement, driven
against real SQL rather than against pure functions, because prerequisites 3–5
are about what the fact-collection layer reads and not only about what the
policy concludes.

### The property is an inequality

Phase 6's matrix asks whether the two engines *agree*. That is the right
question for a low-risk cutover and the wrong one here, because agreement is
symmetric and the risk is not: the generic engine being more conservative costs
review backlog, while being more permissive publishes a calculation-driving
value nobody approved.

So the property asserted over the synthetic cross-product is one-directional —
**generic never publishes what legacy holds** — which is strictly stronger in
the direction that matters and deliberately silent in the direction that does
not. It is guarded against passing vacuously: the run asserts that at least one
case published and at least one was held, because an inequality over a set where
nothing ever publishes is satisfied by any engine at all.

### The three races

**Downgrade.** A verdict stays flagship after its agent is re-tiered down —
`verifier_tier` is stamped at verdict time (migration 0113), and re-reading the
live row would let a downgrade strip a valid approval retroactively.

**Upgrade.** The direction that would actually publish something: two mid-tier
approvals must not become sufficient because an agent was promoted afterwards.

**Revocation.** Deactivating a verifier keeps its verdict and its tier — what
changes is the pool the quorum is sized against, not the history.

---

## 4. Exit gate

Phase 10's real exit gate is a production observation window, and this phase
cannot close it. What it establishes:

| Requirement | Evidence |
| --- | --- |
| the quantified gate exists and enforces both limbs | volume and window blockers asserted separately |
| permissive divergences block | any `apply` shadow decision is a blocker until accounted for |
| operational prerequisites are never auto-satisfied | reported in `unverifiable`; `machineChecksPassed` is deliberately not `ready` |
| the Phase 9 dossier still applies | every Phase 9 blocker is inherited, asserted directly |
| prerequisites 3, 4 and 5 are discharged | 10 tests against real SQL |
| low volume is supplemented, not waived | the synthetic cross-product, with its vacuity guard |

`tests/governance/cutover/high-risk-replay.test.ts`, 18 tests.

**What remains, and cannot be shortened:** prerequisites 1 and 10, the
production half of 2, and the observation window itself. Those need the system
running with `parameter` in a comparison mode, which no deployment may arrange
on its own (§11.4).

---

## 5. Rollback

Delete `high-risk-gate.ts` and its test. Nothing imports it, it writes nothing,
and no request path calls it. The gate is advisory; removing it removes a check,
not a behaviour.
