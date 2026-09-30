# Phase 2 — Target adapter interfaces and the Kinetix registry

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 2, "Add target adapter interfaces and Kinetix registry"), following the
Phase 0 freeze (`docs/plans/2026-08-26-phase-0-baseline.md`) and the Phase 1
pure core (`docs/plans/2026-08-26-phase-1-generic-core.md`).

Phase 2's goal is to get the domain-specific `switch (targetType)` logic behind
one interface **before** any storage changes. It introduces no schema, no
routes, and no endpoint behaviour: unlike Phase 1, which rewired two legacy
helpers to delegate, **Phase 2 modifies no production file at all**. Everything
it adds is new, and the only thing that exercises it is a shadow reconciler run
from tests.

---

## 1. What was added

### 1.1 The adapter boundary — `api/_lib/knowledge-governance/`

| File | Owns |
| --- | --- |
| `target-adapter.ts` | `KnowledgeTargetAdapter`, `ProposalVersion`, `ValidationResult`, `EvidenceRequirement`, `PublicationDecision`, `AppliedRevisionRef`, `GovernanceTransaction` |
| `registry.ts` | `registerKnowledgeTargetAdapter` / `getKnowledgeTargetAdapter` / `findKnowledgeTargetAdapter` / `registeredTargetTypes`, keyed by `(space, type)` |
| `review-packet.ts` | `ReviewPacket` (§8.1) and `sealReviewPacket`, which refuses to build a packet carrying a peer signal |
| `actor-context.ts` | Kinetix → `ActorContext` (§4.2): server-derived `kind`, permission-matrix capabilities, model-tier assurance capability |
| `shadow-queue.ts` | The Phase 2 reconciler: adapter hydration compared against what the live queue served |
| `index.ts` | Barrel for the server layer |

This layer *is* allowed to import Drizzle and Kinetix's tables — that is what
distinguishes it from `src/lib/knowledge-governance/`, which must stay pure.
What it is not allowed to do is decide policy; that stays in the core.

### 1.2 The Kinetix adapters — `adapters/kinetix/`

| Adapter | Verification target type | Unit of review | Baseline a reviewer gets |
| --- | --- | --- | --- |
| `drug-parameter-revision.ts` | `drug_parameter_revision` | one `drug_parameter_revisions` row | the row's `old_value` + its drug |
| `wiki-revision.ts` | `wiki_revision` | one `wiki_revisions` row | the previous revision of the same page |
| `paper-review.ts` | `paper_review` | one `paper_reviews` row | the citation, plus full-text evidence |
| `drug-discussion.ts` | `drug_discussion` | one `drug_parameter_discussions` row | the drug + parameter thread it sits on |
| `pending-edit.ts` | `pending_edit` | one `pending_edits` row (13 live `edit_type`s) | per edit type: drug name + current value, page title + content, or citation |
| `learning-unit-revision.ts` | `learning_unit_revision` | one `learning_unit_revisions` row | the unit it revises |
| `support.ts` | — | shared addressing, evidence and fingerprint conventions | — |
| `index.ts` | — | `registerKinetixAdapters()` | — |

The plan's §15.3 sketch names adapter files after *edit types*
(`wiki-fact.ts`, `parameter-entry.ts`, …). They are named after **verification
target types** instead, because that is the taxonomy the system actually routes
on: `agent_verifications.target_type` is what a verdict names, what the queue
interleaves and what `verificationTargetVersion` switches on. All thirteen edit
types are covered — they are `pending_edit` payloads, and the differences
between them are differences in which baseline to hydrate, not in how the row
is governed.

Adapters delegate rather than reimplement, as the plan asks: `pending-edit.ts`
calls `pendingEditPageHydrationFor`, `isHighRiskPendingEdit`,
`getDrugParametersByDrugIds`, `readParameterValue` and `resolveDrugName`;
`paper-review.ts` calls `isReadInFullUnverified`; `actor-context.ts` decides who
is an agent by calling `resolveActiveAgent`, the same helper the verification
routes run on.

---

## 2. What was *not* changed

No file under `api/*.ts`, `api/_lib/*.ts`, `db/`, or `src/` was modified.
`api/agent-verifications-queue.ts` still serves every production request, still
owns candidate eligibility, and is imported by the new layer only for its
already-exported `pendingEditPageHydrationFor` helper.

---

## 3. Design decisions worth stating

**The registry is keyed by `(space, type)`, not by type.** A second knowledge
space is the entire reason §4.3 exists, and two spaces will legitimately both
govern something they call `wiki_fact`. A type-only key would let one space's
adapter answer for the other's rows.

**Re-registration throws; it does not overwrite.** A registry that accepts the
last writer is a registry where a stray import can quietly replace the adapter
that decides how a drug parameter gets written. `registerKinetixAdapters()` is
idempotent by *checking*, not by overwriting, so a second call is a no-op while
a genuinely conflicting adapter is still an error.

**`getKnowledgeTargetAdapter` throws for an unknown type.** Returning `null`
and letting a caller skip the check is the fail-open direction, which §1.6
forbids. A non-throwing `findKnowledgeTargetAdapter` exists for callers that
are genuinely probing.

**The anti-echo-chamber rule is enforced at runtime, not by convention.** The
legacy queue keeps reviewer packets free of peer verdicts by never selecting
those columns — true, and invisible to whoever writes the seventh adapter. So
`sealReviewPacket` walks the host-shaped sections and refuses to seal a packet
containing a verdict, tally, quorum, hold reason or peer rationale, naming the
path it found it at. The exception list is small and specific:
`paper_review`'s own payload legitimately carries `reviewMarkdown`,
`reviewConfidence` and `readInFull`, because the object under review *is* a
review.

**`apply()` is optional; `loadVersion()` is not.** Publication still runs
entirely through legacy route logic, so an `apply` stub would be a claim this
layer can write, which it cannot yet. `loadVersion` is required and is the one
addition to the plan's §4.4 sketch: that sketch assumes `kg_proposal_versions`
exists and the version is handed in, and until Phase 3 adds it, only the
adapter knows which legacy table is the unit of review for its type.

**Action capabilities and assurance capabilities stay separate.**
`capabilities` gates what an actor may *do* and comes from the permission
matrix; `assuranceCapabilities` gates what their approval is *worth* and holds
exactly one thing today — the server-owned `agents.model_tier` behind the
flagship gate. A self-reported model string reaches neither (§2.3). A NULL tier
produces an empty list rather than `model_tier:unknown`: absence of a claim is
not a claim.

**Self-review is recorded as metadata, never as a capability.** It does not
lower a bar — it enlarges the reviewer pool, which raises the quorum (Phase 0
doc §5.1). A capability would read as a grant.

**Risk classification mirrors the live gate rather than improving on it.**
`pending-edit.ts` calls `isHighRiskPendingEdit` itself instead of re-deriving
"calculation-driving", so the two cannot drift. §1.7 forbids a *weaker* policy
during migration; a stricter one this layer states but no live path enforces is
its own kind of lie about the system, so the other adapters classify
conservatively and add no gate.

**The shadow queue is a reconciler, not a second queue.** A real second queue
would need its own copy of the candidate SQL — age cutoff, author exclusion, the
not-yet-verified `NOT EXISTS`, the wiki visibility filter, the reserved-share
interleave — and two copies of an eligibility rule is how one audience starts
seeing rows the other thinks are hidden. Eligibility stays where it is proven;
the shadow re-hydrates the rows the live queue actually served and reports
differences.

**Parity is checked by round-tripping, not by spot-checking.** Each packet is
projected *back* into the legacy payload shape and compared key by key,
including keys present on only one side. A dropped, renamed or reshaped field
shows up as a divergence — and so does an added one, because the queue's
audience is blind peer reviewers and anything extra is something they were not
previously trusted with.

---

## 4. A legacy divergence this phase found

`pendingEditPageHydrationFor` states the intended per-edit-type rule: a
`wiki_page` edit gets the page's rendered HTML, a `wiki_fact`/`wiki_section`
edit gets only the structured content. The queue then batches its page reads and
drops any page already in the full-hydration set from the content-only set:

```ts
for (const id of fullPageIds) contentPageIds.delete(id);
```

So when one batch carries both kinds of edit against the **same page**, the fact
edit is served the HTML after all. What a reviewer receives for a given row
depends on which other rows happened to share its batch.

It is benign — the page is published, so the HTML is public either way — and it
is not the adapter's to fix: Phase 2 changes no production path (§1.3). The
adapter implements the stated per-row rule, the reconciler reports the
difference, and both sides are pinned by
`tests/governance/adapters/queue-hydration-parity.test.ts` so the divergence is
a recorded finding rather than a surprise when the queue is cut over. Whoever
does that cutover has to decide deliberately which of the two behaviours is the
rule.

---

## 5. Exit gate

| Plan requirement | Evidence |
| --- | --- |
| every currently supported verification target can be represented by an adapter | `kinetix-adapters.test.ts` asserts coverage against `AGENT_VERIFICATION_TARGET_TYPES` and `APPROVAL_TARGET_TYPES` + `learning_unit_revision` — the enums themselves, not a hand-kept list, so a seventh target type fails until it has an adapter |
| adapter review packets preserve all information an agent currently receives | `queue-hydration-parity.test.ts` — the live route against real SQL, every served item round-tripped back to the legacy payload shape and compared key by key, across all five interleaved target types and all four `pending_edit` baseline branches |
| no extra verdict/approval information leaks into reviewer packets | `review-packet.test.ts` (the guard, both directions) plus a whole-batch serialised-packet scan in the parity test |
| Kinetix production paths still use legacy route logic | no production file modified — `git diff --stat` touches only new files under `api/_lib/knowledge-governance/`, `tests/governance/adapters/` and `docs/plans/` |

The parity suite carries its own negative controls: it asserts all five target
types were actually served before comparing (so parity cannot pass on an empty
batch), and it mutates a row out from under a served payload to prove the
reconciler reports a divergence rather than agreeing with everything.

---

## 6. Rollback

Delete `api/_lib/knowledge-governance/` and `tests/governance/adapters/`.
Nothing else references either. No schema impact, no data migration, no deploy
coordination — the layer has no production caller to unwire.
