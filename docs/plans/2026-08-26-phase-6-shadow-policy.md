# Phase 6 — Shadow generic policy decisions

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 6, "Shadow generic policy decisions"), following Phases 0–5.

Phase 6's goal is to **prove the new policy engine reaches the same publication
decision as the current code**. It decides nothing: decisions are evaluated in
`shadow` mode, persisted to `kg_policy_decisions`, and compared.
`applyOnAgentConsensus` remains the only thing that publishes.

---

## 1. Why this comparison is not circular

Phase 1 made `consensusApprovalHoldReason` delegate to the generic policy.
Comparing against *that* would compare the engine to itself.

So Phase 6 compares something wider and genuinely independent: the whole
`applyOnAgentConsensus` gate. Three of its five checks live outside the
delegated helper entirely —

| Check | Where legacy does it |
| --- | --- |
| clinical case | first three lines, before any counting |
| human author | an early `return false`, whatever the tally says |
| the tally | `consensusApprovalHoldReason` (the delegated part) |
| human dispute | a separate table the tally never reads |
| stale review token | inside `applyApprovedEdit` |

and the legacy side of the comparison is a **frozen pure reference** of that
gate, transcribed into the parity test and deliberately not imported.

---

## 2. What was added

| File | Owns |
| --- | --- |
| `src/lib/.../kinetix/policy.ts` | `kinetix-consensus-apply@v1` — the whole gate as a policy |
| `api/_lib/.../policy-shadow.ts` | fact collection, context projection, evaluation, divergence classification, persistence |

### 2.1 A second policy, not an edited one

`kinetix-consensus@v1` is untouched. Editing a versioned policy in place is
what its own note forbids — persisted records name the version — but the
substantive reason is that these are different questions.
`kinetix-consensus@v1` answers *"what is the hold reason for this tally?"* and
is authoritative through delegation. `kinetix-consensus-apply@v1` answers *"may
this publish?"*, and adds the one requirement the tally has no way to express:
`noOpenDisputes()`.

### 2.2 Two legacy special cases become policy facts

**Human author.** *(Superseded by `kinetix-consensus-apply@v3`, which retires
this rule: a person's proposal now publishes on agent consensus like an
agent's, and only an unattributed one needs a human approval.)* As first
built (v1/v2), legacy returned early when the submitter was not an active
agent; here `authorKind` was `agent` only under exactly that test, and the
retired `human-authored` rule demanded a human approval the agent tally could
not supply, turning that early return into a stated reason.

**Clinical case.** Legacy refuses it in its first three lines. Here the risk
profile carries a `clinical_case` tag, the rule matches on it, and the
requirement it imposes — a human approval from someone with clinical standing —
is one agent consensus has no way to satisfy. Same refusal, with the reason
attached.

### 2.3 One legacy case that disappears

**Stale version.** Legacy refuses inside `applyApprovedEdit` when the review
token no longer matches. In the generic model that case does not exist as a
rule: assessments are bound to the version they judged (§8.3), so an approval
cast against an older payload is simply not counted, and the proposal holds on
`quorum_unmet` instead. Same outcome, one fewer special case — which is what
version-bound assessment is *for*, and is called out in the matrix as the one
row where the two sides agree by different routes.

---

## 3. Divergence severity

Straight from the plan, and asymmetric on purpose:

| Direction | Severity | Why |
| --- | --- | --- |
| generic **applies**, legacy holds | `severity_1` | the migration would loosen a gate; blocks cutover (§1.7) |
| generic **holds**, legacy applies | `conservative` | nothing wrongly publishes, but it creates review backlog and must be explained |
| same outcome | `none` | — |

`classifyDivergence` returns the unmet requirement ids alongside the severity,
so "explained" is something a report can actually achieve rather than a note
somebody has to write by hand.

---

## 4. A transcription error the matrix caught

The first draft of the frozen reference transcribed the high-risk clause as a
check on the effective **quorum**:

```ts
if (quorum < AGENT_CONSENSUS_APPROVE_QUORUM) return 'high_risk_degraded_quorum';
```

The real rule keys on **`approveCount`**. "Degraded quorum" names the situation
the edit would have ridden — clearing a relaxed bar with fewer than the design
target's approvals — not the size of the pool.

With the wrong reference, the exhaustive matrix reported a false severity-1
divergence on every high-risk case with three approvals in a small pool. That is
the failure mode a hand-transcribed reference has, and it is the argument for
running the cross-product rather than only the thirteen named cases: the named
cases all passed. The corrected copy now matches the one
`kinetix-consensus-parity.test.ts` holds, and the reference carries a note
saying so.

---

## 5. Exit gate

| Requirement | Evidence |
| --- | --- |
| 100% explained parity on a deterministic fixture corpus | all thirteen required matrix cases, each asserting the outcome *and*, where a specific rule is doing the work, which requirement held it — plus a 1728-case cross-product over edit type × approvals × disputes × tier × pool × author kind × human dispute × self-review |
| zero cases where generic would publish something legacy would hold | asserted directly over the whole cross-product as its own test |
| no unexplained production shadow divergence during the observation window | an observation-period item; `recordShadowDecision` and `classifyDivergence` are what it will be measured with |

The matrix also asserts that both outcomes are actually reached, so agreement
cannot pass vacuously by every case falling down one branch. Alongside it, a
DB-backed suite proves the facts are gathered from the same sources the legacy
gate reads — a matrix that agrees on facts nobody collected correctly proves
nothing — and that a recorded decision names its version, its policy version and
its input fingerprint.

---

## 6. Rollback

Delete `api/_lib/knowledge-governance/policy-shadow.ts` and
`buildKinetixApplyPolicy`. `kinetix-consensus@v1` and every production path are
untouched by this phase, so there is nothing else to unwind.
