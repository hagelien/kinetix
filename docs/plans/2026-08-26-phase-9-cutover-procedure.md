# Phase 9 — The per-target cutover procedure

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 9, "Expand low/medium-risk target cutovers"), following Phase 8's first
cutover in `2026-08-26-phase-8-first-authoritative-cutover.md`.

Phase 9 is "repeat Phase 8 one target at a time", and it says two things
plainly: each target type needs a migration dossier, and **unrelated cutovers
must not be bundled into one PR**.

So this phase ships no cutover. It ships the thing each cutover PR runs to
produce its evidence — and, more to the point, the thing that says *no*.

---

## 1. Why the dossier is code and not a checklist

The plan lists eight dossier items. Four are documents a human writes (known
edge cases, the rollback procedure, the approval itself, and the pointer to the
legacy contract tests). Four are facts about live state:

| Dossier item | Where it comes from |
| --- | --- |
| mirror/reconciliation report | `reconcile()` (Phase 4), scoped to the target |
| policy parity report | `classifyDivergence` over the target's open rows (Phase 6) |
| queue parity report | `compareQueues` (Phase 5) |
| adapter tests | `tests/governance/adapters/` (Phase 2) |

A checklist a human fills in by hand is a checklist that gets filled in by hand
on the day someone is in a hurry. `assessReadiness` computes the four
machine-checkable ones and returns a verdict with every blocker attached.

It is advisory by construction: it reads and reports, and advancing the state
stays a deliberate admin action (§11.4). What it removes is the possibility of
making that decision without having looked.

---

## 2. What it refuses on

**A severity-1 policy divergence.** The generic engine would publish something
the legacy gate holds. §1.7 permits this migration to tighten Kinetix and never
to relax it, so one of these is disqualifying on its own, no matter how many
clean rows sit beside it.

**Any reconciliation divergence.** The mirror and the legacy tables disagree, so
the evidence the rest of the dossier rests on is not trustworthy. This one is
deliberately absolute rather than thresholded: a dossier that tolerated "a few"
divergences would be asserting that it knows which few are harmless.

**Incomplete mirror coverage.** A target type where some rows were never
mirrored cannot be judged from the rows that were. That is survivorship bias
with a publication decision on the end of it.

**No observations at all.** This is the subtle one, and the reason `observed` is
reported separately from the divergence counts. A target type nothing has
exercised produces zero divergences — which reads exactly like a clean sweep.
Zero out of zero and zero out of four hundred are the same number and not the
same evidence.

**Ineligibility.** The type is not in `CUTOVER_ELIGIBLE_EDIT_TYPES`, so
advancing it needs a reviewed code change regardless of what its state row says
(Phase 8, lock 2).

Blockers are returned as a list rather than the first one hit, so one pass fixes
all of them.

---

## 3. What agreement means here

`assessReadiness` measures *agreement*, not publication. A target type where
every open row is legitimately held is exactly as ready as one where every row
publishes — both mean the two engines reason identically about the rows that
exist. A test pins that case specifically, because a readiness check that
quietly required publications would push whoever runs it toward manufacturing
approvals.

The legacy outcome is re-derived from `ConsensusFacts` rather than obtained by
calling `applyOnAgentConsensus`. That function *applies*; a dossier that
published rows in order to report on them would be worse than no dossier.

Only rows still `pending` are compared. A decided edit's legacy outcome is
history, and re-deriving it from today's tally would compare the engine against
a gate that already ran under different facts.

---

## 4. The procedure for one target type

1. Run `assessReadiness(editType)` against a production-like copy. Attach
   `describeDossier(...)` output to the PR.
2. Fix whatever it blocks on. Every blocker is a real gap: an unmirrored row is
   a mirror bug, a severity-1 divergence is a policy bug, a reconciliation
   finding is one or the other.
3. Add the target to `CUTOVER_ELIGIBLE_EDIT_TYPES` — one type, one PR, per the
   plan's instruction not to bundle.
4. Write the human half of the dossier: known edge cases for this type, and its
   rollback procedure.
5. After merge, an admin advances `pending_edit:<editType>` to
   `generic_authoritative`. No deployment does this (§11.4).
6. Observe. Roll back at runtime on anything unexpected — the state row or the
   kill switch, neither needing a deploy.

---

## 5. Order

§13's tiers, narrowed to what `pending_edits` carries. Nothing here is a
commitment to cut any of it over; it is the order in which to try.

| Tier | Types | Why |
| --- | --- | --- |
| A | `wiki_fact` *(done — Phase 8)* | one statement, one section, trivially reversible |
| B | `wiki_section`, `discussion`-adjacent content | prose, no computed consequence |
| C | `bio_entity`, `metabolism`, `receptor_targets`, `enzyme_interaction` | structured domain writes, wider blast radius |
| D | `parameter`, `param_entry` | calculation-driving; a wrong value is a wrong dose |
| — | `clinical_case` | never auto-published at all; out of scope for cutover |

`wiki_new` sits outside the tiers: it creates a drug row and a page together, so
it is less a content edit than a provisioning operation.

---

## 6. Exit gate

Phase 9's own exit gate is per-target and operational — it is met one type at a
time, by the observation windows those PRs run. What this phase can show is that
the gate exists and bites:

| Requirement | Evidence |
| --- | --- |
| a dossier exists per target type | `buildDossier(editType)` — coverage, policy observations, reconciliation, current mode |
| it blocks on unsafe evidence | four refusal tests: severity-1 policy divergence, reconciliation divergence, incomplete coverage, zero observations |
| it does not merely always refuse | two positive controls: a fully mirrored agreeing target, and one where both sides hold |
| unrelated cutovers are not bundled | this phase advances nothing; `CUTOVER_ELIGIBLE_EDIT_TYPES` is unchanged at `['wiki_fact']` |

`tests/governance/cutover/migration-dossier.test.ts`, 12 tests.

---

## 7. Rollback

Delete `dossier.ts` and its test. Nothing else imports it, it writes nothing,
and no request path calls it.
