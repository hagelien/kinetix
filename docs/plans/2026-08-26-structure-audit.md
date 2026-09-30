# §15 concrete file-level plan — structure audit

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`.

§15 opens with its own caveat:

> Names are proposals and may be adjusted, but responsibilities should remain
> separated.

So this is not a rename exercise. Renaming files to match a proposed list, when
the plan explicitly says the list is a proposal, would be churn that makes the
tree look conformant while telling a reader nothing. What is worth doing is the
opposite: state where each §15 responsibility actually lives, and say why it
lives there when that is not where the plan guessed.

One thing that audit turned up is not documentation at all — a hole in the
append-only guarantee, closed below.

---

## The separation rule that actually holds

§15's substantive requirement is a boundary, and the boundary in this codebase
is not the one the file list implies. Drizzle is used freely across the
governance server layer — `mirror.ts`, `reconciliation.ts`, `high-risk-gate.ts`
and the six adapters all query directly — because most of them are reading
*Kinetix* tables, which is their job.

The rule that holds, and now the one that is enforced:

> Every `kg_*` table is **written** only through `store/`. The one exception is
> `kg_migration_state`, the mutable control plane, owned by
> `migration-state.ts`.

Reads outside the store are fine and several exist (`high-risk-gate.ts`
aggregates shadow decisions, `reconciliation.ts` scans legacy links,
`report.ts` counts by mode). A read cannot rewrite history.

### Why this needed a test, not a paragraph

`tests/governance/security/server-owned-facts.test.ts` already asserted, for
§19.4, that the store never updates or deletes an audit table. That assertion
is scoped to `store/` — which makes it locally true and, on its own, close to
worthless: a service that inserted into `kgAssessments` directly could update
the same row three lines later and nothing in that file would have seen it.
Enforcement by absence only enforces anything if the absence is total.

So the guard now scans every `.ts` file under
`api/_lib/knowledge-governance/` recursively and asserts no `.insert(`,
`.update(` or `.delete(` names a `kg*` table outside `store/`, with the
control-plane exception spelled out rather than pattern-matched loosely. Two
supporting assertions keep it honest: the scan must find more than twenty
files, and `migration-state.ts` must still contain the one legitimate write —
which proves the regex matches the shape it is hunting, so an empty offender
list is an empty result and not an empty scan.

Nothing outside `api/_lib/knowledge-governance/` names a `kg*` table at all.

---

## §15.1 Pure core — `src/lib/knowledge-governance/`

Present: `index.ts`, `types.ts`, `actors.ts`, `risk.ts`, `assurance.ts`,
`requirements.ts`, `policy.ts`, `decisions.ts`, plus `kinetix/` (the host layer:
`policy.ts`, `projection.ts`).

Six proposed modules do not exist as files. Each responsibility does:

| Proposed | Where it lives | Why |
|---|---|---|
| `targets.ts` | `api/_lib/…/target-adapter.ts` | A target is a thing an adapter *loads*. The core's whole knowledge of one is `targetType: string` on a `PolicyContext`; a pure module would have nothing in it. |
| `proposals.ts` | `store/proposals.ts`, `store/versions.ts` | Proposals are persistence. The core reasons about a `proposalVersionId` and never about the row. |
| `assessments.ts` | `assurance.ts` | `Assessment`, `AssessmentVerdict` and `tallyAssurance` are the same subject as the profile they reduce to. Splitting them would put a function and its only input in different files. |
| `disputes.ts` | `assurance.ts` (`DisputeState`) + `requirements.ts` (`noOpenDisputes`) | Same reason. A dispute is one more thing the tally counts. |
| `evidence.ts` | `assurance.ts` (`EvidenceRequirementState`) + `requirements.ts` + `target-adapter.ts` (`EvidenceRequirement`) | The *state* is tallied; the *declaration* is a host adapter's, because only the host knows what a citation is. |
| `migration-mode.ts` | `api/_lib/…/migration-state.ts` | **Deliberate.** The mode is read from `kg_migration_state`. Putting it in the pure core would hand the core a control plane it has no way to read, and the core imports nothing that can reach a database — asserted in `packaging/boundaries.test.ts`. The type itself is `KgMigrationMode` in `db/governance-schema.ts`. |

## §15.2 Server orchestration — `api/_lib/knowledge-governance/`

Present as proposed: `actor-context.ts`, `registry.ts`, `target-adapter.ts`,
`assurance-service.ts`, `reconciliation.ts`, `migration-state.ts`.

Renamed: `policy-service.ts` → `policy-shadow.ts` (it evaluates in shadow mode
and records divergence; the narrower name says what it does),
`publication-service.ts` → `publication.ts`.

Four proposed services do not exist, and one consolidation is why:
`proposal-service`, `review-service`, `assessment-service` and
`dispute-service` are the four namespaces of `sdk/client.ts` —
`proposals`, `review`, `assessments`, `disputes`, plus `assurance` and
`history`. Four modules each wrapping the same store with a pass-through, and
then a client wrapping the four, is a layer that exists to satisfy a file list.
Phase 12 wanted one actor-neutral surface; that surface is where those
responsibilities went.

`compatibility.ts` is split by what it makes compatible: read-side legacy
fallback is `assurance-service.ts`, and write-side authority resolution is
`cutover.ts`.

Beyond the proposal, and all from later phases: `mirror.ts`, `backfill.ts`,
`shadow-queue.ts`, `queue/`, `cutover.ts`, `dossier.ts`, `high-risk-gate.ts`,
`divergence.ts`, `report.ts`, `metrics.ts`, `moderator-view.ts`,
`review-packet.ts`, `definition-of-done.ts`, `repair.ts`.

## §15.3 Kinetix adapters

The plan lists thirteen adapters; there are six, plus `support.ts` and
`index.ts`. This is an axis difference rather than missing work.

An adapter is keyed on **verification target type** — the six things an agent
verdict may name: `pending_edit`, `wiki_revision`, `drug_parameter_revision`,
`drug_discussion`, `paper_review`, `learning_unit_revision`. §15.3's list is a
list of **edit types**, which is a different axis: `parameter`,
`parameter-entry`, `wiki-fact`, `wiki-section`, `clinical-case` and the rest are
all values of `pending_edits.edit_type`, and all thirteen are served by
`pending-edit.ts`, which dispatches internally. Keying adapters on edit type
would give thirteen adapters that share one review packet, one risk
classification and one apply path.

Coverage that the edit-type axis is fully served is asserted in
`adapters/kinetix-adapters.test.ts` ("covers every target type an agent verdict
may name", "covers every approval target type too") and in
`legacy-contract/edit-type-inventory.test.ts`.

`evidence.ts` and `risk.ts` are `support.ts`. `policy.ts` is
`src/lib/knowledge-governance/kinetix/policy.ts` — it is pure, so it belongs on
the core side of the boundary, not in `api/`.

## §15.4 Store

Every proposed module exists, with the `-store` suffix dropped because the
directory already says it: `interface.ts`, `postgres.ts`, `proposals.ts`,
`assessments.ts`, `disputes.ts`, `decisions.ts`, `audit.ts`,
`legacy-links.ts`. Three more the §5 schema requires and the file list omitted:
`spaces.ts`, `versions.ts`, `evidence.ts`.

## §15.5 Generic routes — not started, deliberately

None of `api/governance-*.ts` exists. The plan puts them under "later" and adds
that they "should not replace current Kinetix routes during initial migration",
and nothing so far has needed an HTTP surface: the read cutover happens behind
the existing endpoints, and Phase 12's integration surface is the SDK.

Adding them now would mean shipping six routes with no caller, each needing its
own auth, validation and rate limiting — and §19.1's guarantees would have to be
re-established on each. When they do arrive, `resolveAssuranceCapabilities` is
the resolver they must bind (see the §19 audit).

## §15.6 Existing files converted into facades

The plan asks for gradual reduction and warns against one PR that rewrites all
of them. Current state, by whether the governance layer has reached the file:

| File | Governance imports | Lines |
|---|---|---|
| `api/agent-verifications.ts` | 5 | 698 |
| `api/_lib/agent-verifications.ts` | 4 | 1112 |
| `api/pending-edits.ts` | 2 | 3209 |
| `api/_lib/verification-levels.ts` | 1 | 249 |
| `api/agent-verifications-queue.ts` | 0 | 997 |
| `api/_lib/pending-edits-helpers.ts` | 0 | 2475 |
| `src/lib/verificationLevel.ts` | 0 | 103 |
| `src/lib/pendingEditsApi.ts` | 0 | 272 |
| `src/pages/ReviewPage.tsx` | 0 | 245 |

The seams are in the four files where a decision is made, and none of the nine
has shrunk. That is the expected shape at this point and not a failure: every
phase so far has been additive by §1.3, and a facade cannot be thinned until
the thing behind it is authoritative. `wiki_fact` is the only edit type cut
over, so `pending-edits-helpers.ts` still owns twelve apply paths.

The three front-end files are untouched by design — see §20, which asks for no
early React rewrite.

## §15.7 Database

`db/schema.ts` as proposed, plus `db/governance-schema.ts`: the thirteen `kg_*`
tables were split into their own module so the `postgres` package can be
extracted without dragging the Kinetix schema with it. Clean because no `kg_*`
table references a Kinetix table — asserted in `packaging/boundaries.test.ts`.
`db/schema.ts` re-exports it, so every existing importer still works.

One migration: `drizzle/0114_knowledge_governance_schema.sql`, additive.

## §15.8 Tests

Proposed directories all exist except two, whose contents are placed next to
what they test rather than by kind:

- **`parity/`** — the parity matrices live beside their subjects:
  `policy/apply-gate-parity.test.ts`, `policy/kinetix-consensus-parity.test.ts`,
  `queue/generic-queue-parity.test.ts`,
  `adapters/queue-hydration-parity.test.ts`.
- **`migration/`** — `store/migration-additive.test.ts`,
  `store/schema-drift.test.ts`, `mirror/migration-state.test.ts`.

Beyond the proposal: `mirror/`, `queue/`, `assurance/`, `cutover/`,
`observability/`, `packaging/`, `performance/`, `rollback/`, `sdk/`,
`second-domain/`, `transaction/`, `support/`, and — from the §16 audit —
`properties/`, `security/`.
