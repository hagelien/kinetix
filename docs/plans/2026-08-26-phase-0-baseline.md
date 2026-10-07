# Phase 0 Baseline — Knowledge Governance Extraction

**Status:** Phase 0 deliverable
**Date:** 2026-08-26
**Parent plan:** [`2026-08-26-general-knowledge-governance-extraction.md`](./2026-08-26-general-knowledge-governance-extraction.md), Phase 0 ("Freeze behaviour and establish a baseline")

This document is the "testable specification of what must not regress" that Phase 0 asks for. It does three things:

1. inventories every current edit type / target type / governance enum / capability the migration must preserve (§1–§3);
2. maps each Phase-0 publication invariant to the test(s) that currently freeze it, and records what `tests/governance/legacy-contract/` adds (§4);
3. writes down current behaviour that is intentionally odd but relied upon, so a later phase does not "fix" it by accident (§5).

No production code changes in this phase. No generic-governance code is authoritative. Nothing here changes Kinetix's runtime behaviour — see the parent plan's §1.1–§1.7 invariants.

---

## 1. `pending_edits.edit_type` inventory

`pending_edits.editType` is a `varchar(20)`, not a native Postgres enum (repo convention: varchar + Zod at the API edge, `db/schema.ts:1861`). Thirteen values are live; one is legacy-only.

| edit_type | Target/domain object | Capability (`capabilityForEditType`, `src/lib/permissions.ts:757-783`) | Apply path (`api/_lib/pending-edits-helpers.ts`) |
|---|---|---|---|
| `parameter` | `drugs` column value for one `DrugParameterId` | `edit.parameter.submit` | Inline (`applyApprovedEditEffects`, ~L1319-1468): re-checks applicability, updates `drugs`, inserts `drug_parameter_revisions`, recomputes normalization-dependent summaries |
| `param_entry` | One row in `parameter_entries` | `edit.parameterEntry.submit` | `applyApprovedParameterEntry()` (~L990) |
| `metabolism` | `drug_metabolism_profiles` / `drug_elimination_routes` / `drug_metabolites` | `edit.metabolism.submit` | Inline (~L1529-1551): `replaceDrugMetabolism()` |
| `receptor_targets` | `drug_receptor_targets` | `edit.receptorTarget.submit` | Inline (~L1552-1572): `replaceDrugReceptorTargets()` |
| `enzyme_interaction` | `drug_enzyme_interactions` | `edit.enzymeInteraction.submit` | Inline (~L1573-1590): `replaceDrugEnzymeInteractions()` |
| `bio_entity` | `bio_entities` (create/patch) | `edit.bioEntity.submit` | Inline (~L1591-1620): `createBioEntity()` / `updateBioEntity()` |
| `wiki_page` | `wiki_pages` content (existing page) | `wiki.page.submit` | Inline (~L1469-1528): updates `wiki_pages`, inserts `wiki_revisions` |
| `wiki_new` | New `wiki_pages` + `drugs` row (new monograph) | `wiki.page.submit` | Inline (~L1633+): mints slug, inserts drug + page |
| `wiki_fact` | Atomic fact inside a wiki section | `edit.wikiFact.submit` | `applyApprovedWikiFact()` (~L1928) |
| `wiki_section` | Whole wiki section content | `edit.wikiFact.submit` (falls through the default case, ~L779-782) | `applyApprovedWikiSection()` (~L2274) |
| `learning_unit` | `learning_units` (`kind='unit'`) | `edit.learning.submit` | `applyApprovedLearningUnit()` (~L710) |
| `clinical_case` | `learning_units` (`kind='clinical_case'`, same table) | `edit.learning.submit` | `applyApprovedClinicalCase()` (~L795) |
| `paper_review` | `paper_reviews` row | `paperReview.submit` | `applyApprovedPaperReview()` (~L1836) — **legacy only**: no current write path creates a `pending_edits` row of this type; paper reviews now write directly via `api/_lib/paper-review-store.ts`. Kept alive by a unique partial index (`db/schema.ts:1763-1765`) and by `api/pending-edits.ts` still branching on it. Do not remove until the legacy-retirement stage confirms no historical/in-flight row depends on it. |

`tests/governance/legacy-contract/edit-type-inventory.test.ts` turns this table into an executable guard: it fails if a 14th `edit_type` is ever added without a capability mapping and an apply dispatch.

## 2. Governed target types beyond `pending_edits`

| Target type | Backing table(s) | Verification/approval taxonomy |
|---|---|---|
| Drug parameter value | `drugs`, `drug_parameters`, `drug_parameter_revisions` | `approvals`/`agent_verifications` `targetType='drug_parameter_revision'` |
| Wiki page/fact/section | `wiki_pages`, `wiki_revisions` | `targetType='wiki_revision'` |
| Citation / paper review | `citations`, `paper_reviews`, `paper_review_revisions` | `targetType='paper_review'` (direct-write, not via `pending_edits`) |
| Drug discussion | `drug_parameter_discussions` | `targetType='drug_discussion'` |
| Learning unit / clinical case | `learning_units`, `learning_unit_revisions` | `targetType='learning_unit_revision'` in `ApprovalTargetType`, but **excluded** from the agent-verification queue's served set (§5.2) |
| Pending edit itself | `pending_edits` | `targetType='pending_edit'` — only in `AgentVerificationTargetType`, not in `ApprovalTargetType` |
| Simulator case | `simulator_cases` | Not routed through `pending_edits`/`agent_verifications` at all — ungoverned, direct-write. Out of scope for this migration unless a later phase decides otherwise. |

## 3. Governance enums (all `varchar` + TS union, no native PG enums — `db/schema.ts:1861`)

- `AgentVerificationVerdict` (`db/schema.ts:2434`): `approve | dispute | abstain`
- `AgentVerificationTargetType` (`db/schema.ts:2431`): `ApprovalTargetType | 'pending_edit'`
- `ApprovalTargetType` (`db/schema.ts:2416-2421`): `wiki_revision | drug_parameter_revision | drug_discussion | paper_review | learning_unit_revision`
- Queue-served subset (`api/agent-verifications-queue.ts:67-73`): `drug_parameter_revision | wiki_revision | paper_review | drug_discussion | pending_edit` — **excludes `learning_unit_revision`** (see §5.2)
- `agents.model_tier` (`db/schema.ts:913`): `flagship | mid | light | NULL`. `NULL` never satisfies the flagship gate. `FLAGSHIP_TIER` constant lives in `src/lib/modelTiers.ts:23`.
- `disputes.status` (`db/schema.ts:2085`): `open | resolved`
- `disputes.resolution` (`db/schema.ts:2087`): `upheld | rejected | withdrawn`
- `disputes.source` (`db/schema.ts:2076`): `human | agent`
- `verification_log.targetType` (`db/schema.ts:2001`): `parameter | monograph_fact | discussion_sweep | rejection_review | paper_review | paper_extraction`
- `verification_log.concordance` (`db/schema.ts:2013`): `strong | moderate | weak | absent`
- `agents.status` (`db/schema.ts:866`): `active | suspended | deactivated` (state machine in `src/lib/agentStatus.ts`, documented in `AGENTS.md`)
- `pending_edits.status`: `draft | pending | approved | rejected | returned` (not a typed literal union in `schema.ts`, but enforced by status-transition code in `api/pending-edits.ts`)

**No `clinical_case_expert` or `moderator` role/capability exists.** Clinical cases are governed purely through `edit.learning.submit` (same capability as any other `learning_unit`); `editor`/`admin` are the only reviewer-capable tiers. The parent plan's Phase 11 proposes introducing a distinct capability for this — today it is implicit in `applyOnAgentConsensus` refusing to auto-publish a `clinical_case` at all (§5.1 below), not a named capability.

## 4. Invariant → coverage matrix

Every row already had at minimum partial coverage before this phase; **bold** rows are where this phase adds a new test under `tests/governance/legacy-contract/` to close a gap the audit found.

| # | Invariant | Coverage | Verdict |
|---|---|---|---|
| 1 | Role/capability admission | `src/lib/roles.test.ts`, `src/lib/permissions.test.ts`, `tests/api/wiki-new-drug-capability.test.ts` | Solid |
| 2 | Human vs agent submitter behaviour | `tests/api/agent-consensus-autoapply-gates.test.ts`, `tests/integration/agent-verification-queue-submitters.test.ts`, `tests/api/pending-edits-review-status.test.ts` | Solid |
| 3 | Self-review disabled/enabled | `tests/integration/agent-self-review.test.ts`, `tests/api/pending-edits-review-status.test.ts` | Solid |
| 4 | Implicit approval semantics | `tests/api/agent-verifications-helpers.test.ts` | Solid |
| 5 | No self-verification by default | `tests/api/agent-verifications-helpers.test.ts`, `tests/api/pending-edits-review-status.test.ts` | Solid |
| 6 | Independent queue contents | `tests/api/agent-verifications-queue.test.ts`, `tests/integration/agent-verification-queue-submitters.test.ts`, `tests/api/agent-verifications-helpers.test.ts` | Solid |
| 7 | **Target version stale rejection** | Was schema-shape only (`tests/api/agent-verifications-schema.test.ts`) — no test drove an actual mismatch through the route. **Added:** `tests/governance/legacy-contract/agent-verification-target-version-stale.test.ts` | Solid |
| 8 | **Dispute open/withdraw/ruling** | Open + upheld ruling solid (`tests/api/disputes-route.test.ts`, `tests/api/disputes-upheld-ruling.test.ts`); withdraw's *unblocking effect* was untested. **Added:** `tests/governance/legacy-contract/dispute-withdrawal-unblocks.test.ts` | Solid |
| 9 | Human-authored edit never agent-auto-applied *(retired by `kinetix-consensus@v2`: a person's proposal publishes on agent consensus like an agent's)* | `tests/api/agent-consensus-autoapply-gates.test.ts` | Solid |
| 10 | Clinical-case human requirement | `tests/api/agent-consensus-autoapply-gates.test.ts`, `tests/api/pending-edits-clinical-case.test.ts`, `tests/api/pending-edits-review-status.test.ts` | Solid |
| 11 | Normal quorum | `tests/api/agent-verifications-helpers.test.ts` | Solid |
| 12 | Degraded quorum | `tests/api/agent-verifications-helpers.test.ts` | Solid |
| 13 | High-risk no-degraded-quorum rule | `tests/api/agent-verifications-helpers.test.ts`, `tests/api/agent-consensus-autoapply-gates.test.ts` | Solid |
| 14 | Flagship approval requirement | `tests/api/agent-verifications-helpers.test.ts`, `tests/api/agent-consensus-autoapply-gates.test.ts` | Solid |
| 15 | Server-owned tier snapshot | `tests/api/agent-verifications-helpers.test.ts`, `tests/integration/agent-helpers-model-tier.test.ts` | Solid |
| 16 | Reference gate | `tests/api/reference-gate.test.ts`, `tests/api/pending-edits-clinical-case-reference-gate.test.ts` | Solid |
| 17 | Review token race protection | `tests/api/pending-edits-approval-token.test.ts`, `tests/integration/pending-edit-reviewer-lock.test.ts`, `tests/api/pending-edits-review-status.test.ts` | Solid |
| 18 | **Returned/revised edit behaviour** | Individual guards covered (`tests/api/pending-edits-review-status.test.ts`, `tests/api/pending-edits-conflict-preservation.test.ts`); no single test walked the full return→revise→resubmit→re-review arc. **Added:** `tests/governance/legacy-contract/pending-edit-return-revise-lifecycle.test.ts` | Solid |
| 19 | Upheld-dispute behaviour | `tests/api/disputes-upheld-ruling.test.ts`, `tests/api/pending-edits-review-status.test.ts` | Solid |
| 20 | Conflict markers | `tests/api/pending-edits-conflict-preservation.test.ts` | Solid |
| 21 | Kinetix 0-3 verification-level projection | `tests/api/verification-levels.test.ts`, `tests/integration/verification-level-self-review.test.ts` | Solid |
| 22 | **Edit-type inventory does not silently drift** | Did not exist as an enforced invariant. **Added:** `tests/governance/legacy-contract/edit-type-inventory.test.ts` | Solid |
| 23 | **Baseline endpoint performance** | Did not exist. **Added:** `tests/governance/legacy-contract/review-queue-baseline.perf.test.ts` — logs `[phase0-baseline]` timings for the queue-selection and decision paths under the PGlite harness, for later phases to diff against (parent plan §16, "Performance acceptance should compare p50/p95 endpoint latency to Phase 0 baseline"). Not a strict perf gate — PGlite timing isn't representative of production — just a documented methodology and a regression tripwire. | Established |

## 5. Odd-but-relied-upon behaviour (do not "fix" during migration)

These are documented in `AGENTS.md` (source of truth — kept in sync there) and repeated here because Phase 0's job is specifically to flag them before a later phase mistakes them for bugs.

### 5.1 Self-review is a one-agent escape hatch, not a lower bar

`agents.self_review_enabled` (admin-granted, per agent) lets a specialised single-agent deployment review its own submissions without waiting on a human. It does **not** let an agent moderate a human's edit (`agent_moderation_of_human_edit_not_allowed`, unconditional), and it explicitly still refuses to self-approve a `clinical_case` (spec's human-expert requirement holds even under self-review). Consensus sizing changes shape under the grant: `effectiveConsensusQuorum(n, { authorSelfReviews: true })` sizes the pool at `n` instead of `n - 1`, so quorum *rises* (2 active agents → quorum 2, not 1) — only a lone active agent can carry its own edit alone, and that still logs as degraded. See `AGENTS.md` §"Self-review" for the full chain (queue exclusion, verdict endpoint, moderation endpoint, evidence-level bonus each have their own separate gate — leaving any one of the four in place makes the flag inert while looking enabled in the admin panel).

### 5.2 `learning_unit_revision` is a half-migrated target type

It exists in `ApprovalTargetType` and the DB schema, but is deliberately excluded from the agent-verification queue's served type set (`api/agent-verifications-queue.ts:67-78`) due to verdict-schema/table-availability gaps. A future phase's adapter for `learning_unit`/`clinical_case` must either close this gap or explicitly carry the exclusion forward — do not assume queue parity work "just works" for this type because it appears in the enum.

### 5.3 `paper_review` is a dead `edit_type` kept alive by a unique index

No current write path creates a `pending_edits` row with `editType='paper_review'`; paper reviews write directly via `api/_lib/paper-review-store.ts`. The dispatch code and the partial unique index remain for historical/back-compat reasons. Do not assume it needs an adapter with an active write path — but do not delete the dispatch branch either until legacy-retirement confirms no historical row references it.

### 5.4 `review.edit.decideOwn` and a PATCH's dual meaning

Sending `{status:'approved'|'returned', ...payloadChange}` in one PATCH is refused (`pending_edit_decision_with_payload_change`, 400) — a revision and a decision are always separate calls, each needing its own reviewToken. `rejected` is overloaded: with no payload change it's the submitter's withdrawal (`isOwnCancel`, needs no review capability); with a payload change it's the submitter's own revision-as-rejection. This dual meaning is intentional, not a bug to "clean up" into two endpoints — see `AGENTS.md` §"Deciding on your own proposal".

### 5.5 Upheld dispute is cleared by an actual revision, never by a re-stamp

The signal that a submitter addressed an upheld dispute is `proposed_meta.revisedAt`, a server-managed marker stamped only when a PATCH *changes the payload* — not `submitted_at`, which a bare `{status:'pending'}` re-stamps without changing a byte (issue 592). Treating `submitted_at` as "has this been revised" would let an author clear a ruling by resubmitting byte-identical content. Same principle underlies the conflict-marker logic (§4 item 20): an edit must not become approvable without an actual revision.

### 5.6 `approvals.targetType`'s schema comment is stale

`db/schema.ts:1828`'s inline comment lists `wiki_revision | drug_parameter_revision | drug_discussion` for `approvals.targetType`, omitting `paper_review` and `learning_unit_revision` that the wider `ApprovalTargetType` type (and live code) actually use. Trust the TS type over the comment; fix the comment in a later, purely-documentation change — not as part of a behavioural migration PR, to keep migration diffs reviewable.

### 5.7 Failure direction is asymmetric by design, and inconsistently so on purpose

Two runtime policy switches in the codebase (`referenceGate.blockUnreviewedCitations` in `site_settings`, and the parameter-applicability substance-class defaulting) fail in opposite directions deliberately: a site-setting read failure falls back to the *stricter* shipped default (never silently weaken a gate), while an unrecognised `substance_class` fails toward showing *more* gaps rather than hiding real ones. Both are "fail toward the conservative/visible side," but which side that is depends on what the switch protects. The generic policy engine (parent plan §7, §1.6) must preserve this per-policy asymmetry rather than assuming one universal fail-safe direction — "hold for human review" is the universal direction for *publication* decisions, but not every runtime switch is a publication decision.

---

## 6. Phase 0 exit gate — status

Per the parent plan:

- [x] Every current publication invariant has an automated regression test (§4 above; three genuine gaps closed, one inventory guard and one perf baseline added).
- [x] No generic code is authoritative — this phase adds tests only, no `src/lib/knowledge-governance/` or `api/_lib/knowledge-governance/` code yet (that's Phase 1/2).
- [x] Production behaviour unchanged — no `api/`, `src/`, or `db/` files were modified except (if needed) widening `vitest.integration.config.ts`'s test-file include glob to pick up `tests/governance/**`, which affects test execution only.

Rollback: none needed — test-only phase, per the parent plan.
