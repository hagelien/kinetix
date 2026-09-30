# Phase 7 — First read cutover: assurance for low-risk targets

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 7, "First read cutover: assurance/history for low-risk targets"),
following Phases 0–6.

Phase 7 lets Kinetix **consume** generic-derived read state before the generic
engine controls publication. Nothing about what publishes changes; what changes
is where the number on a monograph badge came from.

---

## 1. The served shape does not change

§7.3 is explicit that Kinetix's 0–3 verification level must not become the
canonical generic state. The core owns an `AssuranceProfile` — counts,
capabilities, dispute state — and Kinetix *projects* it into the existing
`VerificationLevelInfo` through `projectKinetixVerificationLevel`, which Phase 1
already built. The UI receives the same `{ level, disputed }` it always has, and
no component changes. A test pins the key set, so widening it later has to be a
deliberate act.

---

## 2. Falling back is the normal case, not the error case

A generic read is served only when three things hold:

1. the target type is at `generic_read` or beyond,
2. the generic records exist, and
3. they are **complete** — every legacy judgment has a mirrored assessment.

Anything else serves the legacy calculation. Completeness is checked rather than
assumed because shadow mirroring is *allowed* to fail (§12.1), and a partially
mirrored target projects a **lower** level than the truth. A badge that
under-reports review tells a reader a verified value is unverified, which is
worse than no badge at all. Falling back is the same fail-safe direction as
§1.6, pointed at a read.

`ResolvedAssurance.source` distinguishes the four outcomes — `legacy`,
`generic`, `legacy_fallback_incomplete`, `legacy_fallback_error` — so the
rollout can tell "we are not reading generically yet" from "we tried and could
not".

---

## 3. A gap this phase closed in Phase 4

The first version of the completeness check counted only agent verdicts. That
let a human-approved revision be served from a generic profile that could not
see the stamp: `approvals` rows are the human half of Kinetix's assurance, they
live in their own table, and nothing in the mirror had ever looked at them.

Two changes, together:

- `mirrorHumanApproval` mirrors an `approvals` row as an assessment with
  `actorKind: 'human'` — which is exactly what `projectKinetixVerificationLevel`
  reads to decide `hasHumanApprover`. This was Phase 4's work item 4, and it had
  been skipped.
- `linkageIsComplete` counts both halves, so a target with an unmirrored stamp
  falls back rather than serving a level lower than the truth.

Both directions are tested: a mirrored stamp produces a level equal to legacy's,
and an unmirrored one falls back.

---

## 4. Zero added cost in the mode everything ships in

`genericLevelsForTargets` short-circuits to `null` unless the target type has
been advanced, so the seam in `levelsByRevisionId` adds **no query** under
`legacy_only`. The batched legacy calculation runs exactly as it does today and
its map is returned unchanged.

When a type *is* advanced, only rows the generic path could answer completely
are substituted; everything else keeps its legacy value. A partial mirror is
therefore a non-event rather than a page of zeroes.

---

## 5. Exit gate

| Requirement | Evidence |
| --- | --- |
| verification-level parity | the generic projection equals the legacy calculation at 0, 1 and 2 mirrored approvals, on the disputed flag, and with a mirrored human approval stamp |
| no increase in page/API errors | every generic failure path returns the legacy answer: nothing mirrored, partially mirrored, human stamp unmirrored, and the table itself missing — each asserted to serve `resolved.legacy` |
| rollback tested by migration-state toggle and force-legacy flag | both levers tested directly: advancing then rolling the target back returns `source: 'legacy'`, and `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1` does the same with no cache flush |

The fallback tests deliberately assert the served level is **greater than
zero** where legacy says so. "Falls back" is only reassuring if what it falls
back to is the real answer rather than an empty one.

---

## 6. Rollback

Three levers, cheapest first, and all three are tested:

1. `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1` and redeploy.
2. Roll the target type back to `legacy_only` — runtime, audited, no deploy.
3. Revert the commit. The only production line added is the substitution block
   at the end of `levelsByRevisionId`; removing it leaves the service unused.
