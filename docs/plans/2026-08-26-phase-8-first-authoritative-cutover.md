# Phase 8 — The first authoritative cutover

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 8, "First authoritative cutover: low-risk proposal type"), following the
Phase 8 prerequisite in `2026-08-26-phase-8-prerequisite-ambient-transaction.md`.

Phases 4–7 let the generic engine watch: it mirrored, it evaluated, it served a
read. This phase lets it **decide** — for one edit type, and only where somebody
has deliberately advanced it. Kinetix still performs the mutation, so what moves
is the authority, not the machinery.

---

## 1. What was added

| File | Owns |
| --- | --- |
| `cutover.ts` | per-edit-type authority resolution and the eligibility list |
| `publication.ts` | `publishOnAgentConsensus` — decide, apply, record, or fall back |
| `adapters/kinetix/pending-edit.ts` | `apply()`, delegating to `applyApprovedEdit` |
| `api/agent-verifications.ts` | one substitution block at the top of `applyOnAgentConsensus` |

The request path the plan draws is now real, and every arrow but the last two is
code that already existed:

```text
POST /api/agent-verifications
  -> Kinetix auth                          (unchanged)
  -> resolve ActorContext                  (Phase 2)
  -> mirrored proposal + version           (Phase 4)
  -> generic policy engine                 (Phase 6, now `authoritative`)
  -> adapter apply()                       (this phase)
  -> applyApprovedEdit / applyApprovedWikiFact   (unchanged)
  -> legacy pending_edits row + revision   (unchanged)
  -> generic publication event             (this phase)
```

---

## 2. Authority is keyed per edit type, and never inherited

Phases 4–7 key migration state on the *verification target type*
(`pending_edit`, `wiki_revision`, …). That is right for mirroring and reads and
wrong for a cutover: one `pending_edit` row can be a wiki fact, a drug
parameter, a metabolism profile or a clinical case. §1.4's own example tracks
state per knowledge-object type — `wiki_fact -> generic_read` beside
`parameter -> legacy_only`.

So authority is keyed on `pending_edit:<editType>`, and `resolveApplyAuthority`
reads that key **and only that key**. It does not fall back to `pending_edit`,
and the absence of a fallback is the point: advancing the coarse key would
otherwise carry all thirteen edit types with it, `clinical_case` included —
which Kinetix refuses to auto-publish at all. A missing row is `legacy_only`.

Mirroring and reads still read the coarse key. Nothing about Phases 4–7 changes.

### Two independent locks

A stored mode is not sufficient. The edit type must also appear in
`CUTOVER_ELIGIBLE_EDIT_TYPES`, which in this build is `['wiki_fact']`. §11.4
says automated deployment must not advance migration state; this is the
converse — a hand-edited or mistaken row cannot advance a type whose phase has
not been reached and whose parity evidence does not exist. Widening the list is
a reviewed code change.

It restricts only *advancing*. Retreating stays a runtime operation, which is
what makes the rollback exercise in §5 possible without a deploy.

### Why `wiki_fact`

The plan suggests it, and it is the most reversible thing Kinetix publishes:
one statement inside one section, with a revision behind it. A mistake is
visible and undoable without touching a computed value or a whole page.
Deliberately not eligible: `parameter` and `param_entry` (they drive
calculations — Tier D in §13), `clinical_case` (safety-critical, never
auto-published), `wiki_new` (creates a drug row and a page at once).

---

## 3. The commit is the line

The plan draws a hard boundary at the commit, and `publishOnAgentConsensus` is
built around it.

**Before it** — resolving authority, gathering facts, finding the mirrored
version, evaluating policy — every failure returns `fell_back`, and the caller
runs the legacy gate as if this module did not exist. Nothing has happened yet,
so the safe thing is to let the proven code decide.

**After the transaction opens**, the outcome is `applied`, `held`,
`already_applied` or `failed`. `failed` is *not* a fallback: a fault inside the
unit of work cannot be distinguished from a partial one by anything this layer
can see, and replaying the mutation through legacy is exactly the double-apply
the plan forbids. The edit is left pending, an audit event is written, and the
next verdict or a moderator retries.

**A hold is a decision, not an abstention.** If a generic hold fell through to
legacy, the legacy gate could publish what the generic engine just refused —
§1.7 permits this migration to tighten Kinetix and never to relax it. So a
failure to *record* the hold does not become a fallback either; it logs and the
hold stands.

### Idempotency

The publication event is the record of record. `alreadyPublished` is checked
before the transaction and again inside it, so a retried request, a duplicated
verdict, or a legacy path that ran anyway cannot apply the same version twice.
The event, the decision and the mutation share one transaction — which is what
the Phase 8 prerequisite bought: `applyApprovedEdit` uses `inTransaction()`, so
it joins the ambient unit of work instead of opening a second connection.

`already_applied` returns `false` to the caller. `autoApplied` answers "did this
verdict publish it", and a second caller did not.

---

## 4. Compatibility is free, because Kinetix still does the writing

`apply()` delegates to `applyApprovedEdit` rather than reimplementing a line of
the apply path. The thirteen-edit-type dispatch, the applicability re-checks,
the revision inserts, the conflict marking and the status stamp are the proven
implementation, and Phase 8's goal is explicitly that existing Kinetix apply
code remains the mutation mechanism.

That satisfies the compatibility requirement without a second mechanism: the
`pending_edits` row is still stamped `approved` with its `reviewed_by`, by the
same code as before. The moderator UI, the admin tooling and an older instance
mid-rolling-deploy read exactly what they read today, and a force-legacy
rollback lands on a row they recognise.

One thing `apply()` refuses: a non-user actor. Every apply is attributed to a
Kinetix user in `pending_edits.reviewed_by`, and a system or service actor has
no user id — inventing one would put a fabricated reviewer in the audit trail.

---

## 5. Exit gate

The exit gate is largely operational — an observation window, no
rollback-triggering incidents, clean reconciliation, acceptable queue parity —
and those are outcomes of running it, not of merging it. What can be
demonstrated now is that the mechanism does what the window would be observing:

| Plan requirement | Evidence |
| --- | --- |
| inert until deliberately advanced | a fresh database falls back for every edit type, publishes through the legacy gate exactly as before, and records no publication event |
| per-target cutover, not a global switch | advancing the coarse `pending_edit` key grants no authority; four ineligible edit types are refused even with their own row set to `generic_authoritative` |
| existing Kinetix apply code remains the mutation mechanism | the `pending_edits` row is stamped `approved` with `reviewed_by` by `applyApprovedEdit`, asserted directly |
| no duplicate application | a second publish returns `already_applied` and the version still has exactly one publication event |
| pre-commit failure falls back | an advanced-but-unmirrored target falls back, and the legacy gate then publishes it unchanged |
| post-commit failure does not replay | a fault inside the apply transaction leaves the edit `pending` with no publication event, and reports `failed` rather than falling back |
| force-legacy rollback exercise succeeds | both levers tested at runtime: retreating the row, and the kill switch — and after retreating, ordinary consensus publishes through legacy again |

`tests/governance/cutover/authoritative-publication.test.ts`, 20 tests.

**Not yet demonstrable, and deliberately left to the window:** production
observation, reconciliation cleanliness over time, and moderator queue parity
under real traffic. Those need the target advanced in a live environment, which
§11.4 says no deployment may do automatically — so shipping this leaves
`wiki_fact` at whatever mode it already has, which on a fresh database is
`legacy_only`.

---

## 6. Rollback

Cheapest first, none of them requiring a deploy:

1. `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1` — every target, immediately.
2. Retreat `pending_edit:wiki_fact` to any safer mode. §11.4 allows moving
   backward from any mode at any time.
3. Revert the commit. `cutover.ts` and `publication.ts` have no other caller,
   and the substitution block in `applyOnAgentConsensus` is contiguous.

Anything already published stays published, which is correct: it was applied by
the same Kinetix code the legacy path uses, and the `pending_edits` row records
it identically either way.
