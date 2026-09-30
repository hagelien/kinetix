# Assurance governance transition - current handoff

**Status:** active continuation plan; historical snapshot importer implemented, awaiting review and a fresh production preview

**Date:** 2026-09-05  
**Scope:** carry the reusable governance extraction forward from the state now on `main`, without repeating completed phases or weakening Kinetix safeguards

This document is the current status and sequencing authority for the governance extraction. The 2026-08-26 plans remain the design record for invariants, rationale, tests, migration semantics, and rollback rules. Where those documents describe repository/package status or immediate next actions in future tense, this handoff supersedes them.

**Immediate next work:** review the historical snapshot importer described in
Step B below, then run its preview against production before any apply. The
latest verified database state is `pending_edit = shadow`, with legacy still
deciding publication. The importer and the reconciliation exception exist in
code with their acceptance checks passing against the disposable harness; no
production import has been previewed or applied since, and no mode has been
advanced. `scripts/governance-import-history.ts` is the command — **not**
`governance-repair.ts --apply`, which remains a live-mirror rebuild rather than
a historical importer. Do not advance modes on the strength of a merged code
change.

In particular, do not act on stale statements that the reusable repository still needs to be created, that the package name is `@assurance/core`, that Kinetix still contains a duplicate pure core, or that Phase 0-7 need to be started. Those statements describe earlier points in the migration.

---

## 1. Current repository state

### Reusable core

`hagelien/assurance-core` is the canonical reusable repository.

The npm package is **`assurance-core`**, currently `0.3.0`. It is deliberately a zero-runtime-dependency package. It contains the domain-independent policy/assurance primitives plus review machinery that has proved reusable:

- actor, risk, assurance, requirement, policy and decision primitives;
- immutable proposal/version references;
- sealed review packets;
- generic review-queue selection;
- the `AssuranceStore` persistence port;
- `MemoryAssuranceStore`;
- executable store conformance tests;
- an ADR example and a complete second ADR host with a separately implemented store adapter.

Kinetix already consumes `assurance-core` from npm. The duplicate pure core that originally lived in Kinetix has been removed.

### Kinetix host layer

Kinetix still owns the things that should remain host-specific:

- Kinetix policy definitions and its assurance-to-verification-level projection;
- authentication, actor resolution and capability mapping;
- scientific evidence and citation rules;
- target adapters and domain validation;
- actual Kinetix apply/mutation logic;
- migration control state, compatibility projections, mirroring, reconciliation and cutover orchestration while the legacy path still exists.

Kinetix also implements `assurance-core`'s `AssuranceStore` over the `kg_*` tables, and runs the package conformance contract against real SQL.

### Authoritative cutover

The per-edit-type authoritative cutover mechanism exists. Code eligibility is still intentionally narrow: `wiki_fact` is the only edit type in `CUTOVER_ELIGIBLE_EDIT_TYPES` on this build.

The **runtime migration mode is database state**. Git history cannot tell whether production currently has `pending_edit:wiki_fact` at `legacy_only`, `generic_read`, `generic_authoritative`, or another mode. Never infer operational cutover status from the fact that the mechanism exists.

---

## 2. Repository and package boundary decision

Treat the following as settled unless a later ADR explicitly changes it.

### 2.1 Keep the root core package pure

The existing `assurance-core` npm package remains the dependency-free kernel. Do not add Drizzle, Neon, HTTP, React, filesystem access, environment reads, host authentication, or host mutation code to it.

Its small dependency surface is a feature, not an intermediate state.

### 2.2 The repository may host sibling packages later

If reuse justifies them, `hagelien/assurance-core` is also the natural home for sibling packages such as a Postgres implementation or SDK. A future layout may be a workspace/monorepo, but that is a repository organization decision, not permission to expand the dependency surface of the root core package.

Do not create packages merely to make the old Phase 14 sketch look complete. Extract a layer when a second consumer proves that the layer itself, not just its import graph, is generic.

### 2.3 Kinetix-specific code stays in Kinetix

A reusable package must not know:

- what a drug parameter means;
- how TipTap content is mutated;
- what Kinetix calls a role or permission;
- which scientific citation states satisfy Kinetix evidence policy;
- how a Kinetix legacy row encodes historical compatibility;
- how Kinetix projects assurance into its reader-facing verification level.

The core decides whether a version satisfies policy. Kinetix decides what the accepted change means and how it is applied.

---

## 3. Important correction: the current SQL adapter is not extraction-ready unchanged

`api/_lib/knowledge-governance/store/assurance-port.ts` has a clean import boundary, but import purity is not the same as semantic portability.

The adapter currently has to understand several Kinetix-era representations in the same `kg_*` tables, including capability snapshots written as:

- a port-native array;
- SDK `{ capabilities, assuranceCapabilities }` objects;
- mirror/backfill `{ modelTier, isImplicit }` objects.

It also contains fail-closed recovery whose safety argument depends on the current Kinetix policy shape. For example, salvaging readable risk tags from malformed stored data is safe because Kinetix uses those tags to **add** requirements, not relax them.

Those are valuable compatibility rules inside Kinetix. They are not generic Postgres semantics.

Therefore:

1. do **not** move the current `db/governance-schema.ts` + store directory wholesale into a `postgres` package;
2. first define one canonical storage representation for new generic writes;
3. move decoding of legacy Kinetix snapshot shapes to a Kinetix compatibility edge/backfill-normalization layer;
4. make the generic SQL store reject or conservatively surface non-canonical/corrupt records rather than infer Kinetix-specific meaning;
5. run `assurance-core` store conformance against the normalized Kinetix SQL implementation;
6. validate the same SQL package with a non-Kinetix Postgres host before calling it reusable.

Only then is a reusable Postgres package a straightforward extraction rather than exported Kinetix archaeology.

#### As implemented (2026-09-07)

Items 2-5 are done; 1 still stands and 6 is Step E's prerequisite, unchanged.

The canonical `capability_snapshot` splits by what a field *means*:
`assuranceCapabilities` is the only thing a gate reads, and `host` is
everything else — descriptive capabilities, an agent slug, import provenance —
carried and never interpreted. The implicit marker is not in the snapshot at
all: "this is the author's submit-time stake" is a fact about the assessment,
and `independence_group` already records it. Every writer produces this shape:
the port, the SDK client, the mirror, the backfill, the historical importer.
`capability-snapshot.ts` knows that shape and nothing else;
`kinetix-legacy-snapshots.ts` holds the three pre-canonical shapes and is
injected into the store, so what would travel to a Postgres package reads one
representation rather than three.

Two things worth carrying forward from doing it:

**It had already gone wrong, in the way §3 predicts.** The port read both the
column and the snapshot; `assurance-service.ts` read only
`capabilitySnapshot.isImplicit`, by truthiness. The port writes an implicit
approval as `independence_group = 'author'` with no snapshot field — so every
port-native implicit approval was invisible to the consensus reader and counted
toward a quorum meant to be independent of its author. One column, two readers,
disagreeing exactly where it decided a gate.

**Item 4 was a visibility fix, not a behaviour change.** An unrecognised
snapshot conferred no capabilities before and still does; what changed is that
it no longer does so by returning the same empty list as an assessor with
genuinely no standing. Those are different facts, and collapsing them meant a
corrupt row read as an ordinary unqualified approval that nobody investigated —
the quieter sibling of the unreadable-history hold, which at least announces
itself by the version not moving. Unrecognised rows are now counted as
`kg_non_canonical_capability_snapshot_total`.

Ordering note: this landed **before** the production backfill rather than after
it, which is the one detail that made it cheap. `kg_assessments` is empty in
production, so converging the writers first means the backfill writes canonical
rows and no stored data is ever migrated; in the sequence below it would have
meant normalising 477+ rows that need never have been written in the old shape.

---

## 4. Queue transition

`assurance-core` now owns the generic queue eligibility algorithm, but Kinetix's served agent queue still lives on the legacy data model. This is deliberate.

The shadow comparison must remain an **independent implementation** until parity has done its job. Reusing the package selector on both sides of the comparator would make equality nearly tautological and destroy the evidence the shadow queue exists to produce.

The next queue milestone is therefore a data-model/read cutover, not another queue algorithm rewrite:

1. establish complete generic proposal/version coverage for the target population;
2. keep comparing legacy selection/hydration against generic selection and sealed packets;
3. resolve every unexplained inclusion/exclusion or packet divergence;
4. only after the observation gate is clean, make the served low-risk queue consume the package selector over generic proposal versions;
5. retain a legacy fallback/rollback path until the observation window is complete.

Do this independently of changing Kinetix scientific policy or domain mutation code.

---

## 5. SDK and HTTP

The Phase 12 in-process client remains useful as a host-neutral integration surface, but it is still Kinetix-local. That is not a blocker.

Do not extract an SDK package simply because the 2026-08-26 package sketch listed one. Extract it when a second real consumer needs the client and has demonstrated which host bindings belong outside Kinetix.

Generic HTTP remains deferred. Kinetix must not acquire a runtime network dependency on a governance service as part of this transition.

React review components remain optional and later still.

---

## 6. Operational cutover sequence

### Step A - establish the live state

Before further authoritative work, run the migration/report tooling against the intended environment or a production-like copy:

- current migration modes;
- `assessReadiness('wiki_fact')` / dossier output;
- reconciliation completeness and divergences;
- queue parity;
- policy parity;
- fallback/error counters;
- the §26 definition-of-done report.

Do not use a dated plan document as a substitute for these runtime facts.

#### Step A tooling and the first live reading

Three operator commands exist so that Step A and Step B do not require
hand-written SQL. None of them runs on deploy or on a schedule.

- `npx tsx scripts/governance-status.ts [--survey] [--queue-agent=<id>|all] [--json]`
  — read-only. Composes the existing reports (`listMigrationState`,
  `resolveApplyAuthority`, `assessReadiness`/`describeDossier`,
  `parityReport`, `definitionOfDone`, and the legacy-vs-generic queue
  comparison per agent). It never creates the space row: on an environment
  where nothing has been mirrored it says so instead of writing. Exit code 0
  means the dossier says ready, 1 means not ready.
- `npx tsx scripts/governance-migration-state.ts --target=<key> --mode=<mode> --by=<admin users.id> --confirm`
  — the §11.4 admin lever. Refuses unless `--by` names a user with the
  `admin` role, goes through `setMigrationMode` (high-consequence guard and
  audit event), and prints what the request path resolves afterwards.
  Without `--confirm` it only prints the plan. Rollback is the same command
  with a safer mode.
- `npx tsx scripts/governance-repair.ts [--target-type=pending_edit] [--apply]`
  — Level 4 repair (`repairMirrors`), dry run by default. Re-mirrors
  `missing_proposal`/`missing_assessment` findings through the normal mirror
  path, which declines under `legacy_only`. **Its current apply path is not
  suitable for the initial historical import:** see the reproduced Step B
  blocker below. A preview calling a finding repairable does not establish
  that the resulting historical state will reconcile.

**Initial reading of 2026-09-05 (before the admin enabled shadow):** no `kg_spaces`
row, no `kg_migration_state` rows, no `kg_proposals`; every key resolves
`legacy_only` and `pending_edit:wiki_fact` authority is withheld by mode.
`pending_edits` holds 477 `wiki_fact` rows (390 approved, 87 rejected, none
pending), so the dossier reports mirror coverage 0/477 and zero open-row
policy observations. The §26 audit reports 0 failing, 3 not yet reachable,
4 awaiting attestation. The runtime migration has not been started; the code
path exists and nothing has exercised it in production.

The queue comparison, run for the three active agents against the served
batch, found a defect in the generic selector rather than in the adapters:
it read each type's oldest `limit` rows *before* applying the generic
eligibility rules, whereas the legacy queue applies author-exclusion and
already-judged inside its SQL ahead of the LIMIT. For an agent that had
judged the entire oldest window of a type the generic selector served
nothing. Fixed by growing the candidate window until `limit` eligible rows
are found or the type runs out (`queue/generic-queue.ts`, with a regression
case in `tests/governance/queue/generic-queue-parity.test.ts`). Re-run
after the fix, the production comparison reports the legacy and generic
batches identical for all three active agents at limit 100, with no packet
mismatches. The
package's `candidatesFromStore` had the same shape — it filters judged
versions after the store's `limit` — and that core follow-up is now done:
`selectReviewQueueFromStore` owns the read and the rules together and grows
the window until `limit` eligible rows are found, the space runs out, or a
cap is reached, with `truncated` separating "no more work for this reviewer"
from "the search stopped looking". Reading those two the same way is how the
defect stayed invisible. Step C's remaining half — actually serving the
queue from it — still waits on the parity evidence below.

### Step B - finish `wiki_fact` operationally if it is not already proven

If `wiki_fact` has not completed its authoritative observation window, finish that before widening the eligibility list. The code path being available is not the same as the migration being operationally complete.

Runtime advancement remains a deliberate admin action after the code/dossier PR is merged. Deployment must never auto-advance migration state.

#### Latest verified operational state (2026-09-05)

The admin has now advanced the correctly spelled `pending_edit` key to
`shadow`. A direct database read confirmed that stored key and its resolved
mode; `pending_edit:wiki_fact` still resolves to `legacy_only`, so legacy
continues deciding publication. The full status command subsequently completed
and all three active agents' 100-item queue comparisons were identical.
A preceding status run failed while reading wiki revision 23; the same adapter
read and the full report succeeded on retry. The original underlying failure
was not captured, so a transient failure is an inference, not an established
root cause. Backslashes visible throughout pasted identifiers were formatting
artifacts; the database key itself was verified.

The scoped historical repair preview used `repairMirrors` with
`targetType: 'pending_edit'`, `limit: 6000`, and `dryRun: true`. It reported:

- complete scan, 1,776 findings, zero writes;
- 975 missing proposals and 801 missing assessments;
- zero findings classified by that preview as unrepairable.

The status report showed `wiki_fact` coverage still 0/477, with no open-row
policy observations.

These are dated observations, not fixed future counts. The global report also
contained missing assessments for other target types still at `legacy_only`;
those are outside this pending-edit import. Report global and scoped totals
separately rather than silently expanding the import or claiming global parity.
No production backfill was applied in this investigation.

#### Reproduced blocker: live mirroring is not a historical importer (resolved in code)

`repairMirrors` in `api/_lib/knowledge-governance/repair.ts` delegates missing
proposals to `mirrorProposalVersion`. Its `ensureMirroredVersion` helper in
`mirror.ts` creates every new proposal with `state: 'pending'`, including an
already-approved or rejected legacy edit. Reconciliation correctly compares
that projection with the legacy outcome and also demands an applied publication
event for an approved edit. Repair explicitly refuses to fabricate such events.

This was reproduced against the disposable PGlite integration harness, using
the actual repair and reconciliation functions:

1. Seed a published wiki page and two historical `wiki_fact` edits, one
   `approved` and one `rejected`; enable shadow in the disposable database.
2. Preview reports two missing proposals.
3. Apply reports **2/2 repaired**, but both generic proposals remain `pending`
   with `closedAt: null`.
4. Reconciliation reports **two `state_mismatch` findings and one
   `missing_publication` finding**.

The current repair tests in `tests/governance/rollback/rehearsal.test.ts`
exercise missing pending proposals; that success does not cover historical
terminal states. Simply applying the production preview would turn missing
history into incorrectly projected history.

That reproduction is now a regression test
(`tests/governance/historical-import/importer.test.ts`), and it asserts the
fixed behaviour: repair rebuilds the two rows as `applied` and `rejected`, and
reconciliation reports nothing. Both entry points were fixed, not only the CLI —
see "As implemented" below.

#### Implementation assignment: explicit historical snapshots

Deliver one focused Kinetix implementation PR before the operational import.
Keep the reusable package boundary, scientific policy, publication authority,
and served-queue cutover out of this change.

1. **Add a historical snapshot import path.** Route the initial historical
   backfill through it instead of treating every source row as a new live
   proposal. Preserve source states: `approved → applied`, `rejected → rejected`,
   and the existing `draft`, `pending`, and `returned` mappings. Ensure terminal
   imports are closed and excluded from open-review queues. Do not reset an
   existing newer generic projection or overwrite immutable history. Examine
   first-contact live mirroring of an already-closed legacy row too; fixing only
   the CLI must not leave another entry point recreating the same bad state.
2. **Persist explicit, immutable import provenance.** Record
   `origin: 'legacy_snapshot'`, `historicalCompleteness: 'current_state_only'`,
   the source identity, captured source state/version evidence, and capture time
   on the imported version or a linked immutable import record. Keep provenance
   separate from domain payloads and policy risk tags. Preserve known historical
   timestamps; distinguish capture/closure-observation time from an unknown
   original event time. A projection rebuild must recover the imported outcome
   from that record instead of reopening the proposal. An import timestamp alone
   is not proof that a publication predates generic observation.
3. **Teach reconciliation the narrow historical exception.** An explicitly
   imported version captured as already applied may reconcile against its
   recorded legacy outcome without a fabricated generic publication event.
   Require matching, valid provenance and source evidence for that exact version.
   Missing or malformed provenance remains a finding. Keep `missing_publication`
   enforced for native records, subsequent versions, and proposals imported open
   that are later published. Do not silence the whole finding class or change
   `UNREPAIRABLE.missing_publication` into permission to invent events.
4. **Import assessments conservatively.** Preserve known original timestamps,
   server-owned capability snapshots, and explicit/implicit status; mark the
   history incomplete without inventing supersession chains. Only admit an
   imported approval to a version-specific gate when its exact reviewed version
   is established. Retain unbound or stale historical judgments as history and
   report their status; do not silently attach them to today's version. Historical
   imports must not inflate fresh shadow observations or independent-review
   evidence. `snapshotLegacyVerifications` in `backfill.ts` and `legacyProvenance`
   in `store/interface.ts` are starting points, not a complete solution: the
   former currently imports target-level judgments and does not itself establish
   version binding or preserve the original assessment time on insert.
5. **Make each proposal import atomic, concurrency-safe, and repeatable.** Commit
   the proposal/version, legacy links, imported state, provenance, and associated
   import audit records as one unit. Use the existing transaction conventions
   (`inTransaction`, joining an ambient transaction) and serialize competing
   import/live operations for the same identity. Re-read source state/version
   under the relevant concurrency guard; abort or retry a stale capture. Re-runs
   must not duplicate history, attach an old approval to a newer version, reopen
   closed work, or overwrite a concurrently advanced outcome. Avoid one giant
   transaction for the whole catalogue and do not delete history to repair it.
6. **Make the preview predict the resulting state.** Share planning logic with
   apply, report proposed state mappings, already-imported rows, ambiguous review
   bindings, and expected unresolved findings. Expose scan completeness and
   continuation information. The current CLI omits `scanComplete` from its
   rendered summary, and repair filters a bounded global scan afterward; the
   importer must reach the complete requested population without repeatedly
   examining only the first page. A partial scan must never report completion.

Likely implementation surfaces: `backfill.ts`, `repair.ts`, `mirror.ts`,
`reconciliation.ts`, the proposal/version/assessment stores and provenance types,
and `scripts/governance-repair.ts`. Add a schema migration only if the chosen
immutable provenance representation requires it; follow the migration rules.
Keep this plan current with the final representation and operator command.

#### As implemented (2026-09-05)

The final representation and operator command, so a later reader does not have
to reconstruct them from the diff.

**Module.** `api/_lib/knowledge-governance/historical-import.ts` owns the whole
operation: reading a legacy row's lifecycle, planning, importing, the provenance
record, and the narrow reconciliation exception. `mirror.ts` and
`reconciliation.ts` import from it; it imports from neither.

**Provenance.** A `kg_audit_events` row with
`event_type = 'historical_import'`, `subject_type = 'proposal_version'` and
`subject_id` = the imported version. No schema migration was needed: that table
is already append-only with no update or delete in the store, which is the
property the record requires, and it keeps provenance out of both the domain
payload and the policy risk tags. The payload is
`{ origin: 'legacy_snapshot', historicalCompleteness: 'current_state_only',
capturedAt, legacyType, legacyId, sourceState, sourceVersionToken,
sourceCreatedAt, sourceClosedAt, closureObservedAt, importedState, proposalId,
proposalVersionId }`. `sourceClosedAt` is the known moderation time and `null`
when legacy recorded none; `closureObservedAt` is only when the importer looked.
The proposal's `closed_at` projection falls back to the observation time when
the original is unknown, and the record is where that difference is preserved.
`rebuildImportedProjection` recovers the outcome from the record rather than
reopening the proposal.

**Reconciliation exception.** `importedAsAlreadyApplied` gates it. The record
must be well-formed, name this exact version and legacy row, match the version's
stored review token, describe an `applied` import of an `approved` source, and
still agree with what the source projects *now* — the stored token and the
current token are checked separately, so a since-revised row stops being
excused. Missing, malformed, stale or version-mismatched provenance leaves
`missing_publication` standing, and the finding's detail names which. Native
records, later versions of an imported proposal, and proposals imported open and
published afterwards are all still held to the ordinary rule.
`UNREPAIRABLE.missing_publication` is unchanged.

**Both entry points.** `ensureMirroredVersion` now asks
`readLegacySnapshot` on first contact and routes an already-closed row through
the importer, so the request path cannot recreate the state the CLI was fixed to
stop producing. An open row still mirrors as an ordinary live proposal. Both
writers create the proposal through `ensureProposalIdentity`, which holds a
transaction-scoped advisory lock on `kg-governance:<type>:<id>` across the
find-then-create; the unique index on `kg_legacy_links` remains the real guard,
and a loser is reported rather than retried into a duplicate. Proposals are now
created with the source's submission time rather than the mirror time, so the
open-proposals index is not renumbered to the day of the import.

**Exclusion reaches the legacy rows, not just the generic identity.** The
advisory lock above is cooperative and no legacy writer takes it, so on its own
it excludes other importers while leaving the race that matters — a legacy write
landing between a capture and its commit — untouched. Two additions close it,
and both are load-bearing for the binding rule stated below.

*The source row is held.* `SELECT … FOR UPDATE` on the legacy row, for the life
of the transaction, for **every** registered target type rather than
`pending_edit` alone. The lock is not only for `readLegacySnapshot`:
`mirrorAssessment` reads the target's payload, then reads the verdict, and
concludes about the pair, so without it those are two reads at two different
points in legacy time. `paper_review` is where that bites, being revised in
place — its `targetVersion` is the row's `updated_at` and a re-review moves it —
so a mirror could bind a verdict recast against the revision to the pre-revision
payload, invisibly, because the legacy link makes reconciliation report the row
clean. The immutable revision types cannot move that way and are locked anyway;
a rule that holds for two of six types is one the next adapter breaks. Order is
uniform throughout: source row first, verdicts second, never the reverse, which
would invert the importer's own order and deadlock rather than queue.

*The version a verdict validated survives to its write.* `agent_verifications`
has no version column — only `(agent_id, target_type, target_id)` — so the 409
in `POST /api/agent-verifications` is the only thing tying a verdict to a
revision, and it was a check-then-act: the author lookup, the self-review rules
and the citation resolution all sit between the check and `recordVerification`.
A revision landing in that window was admitted, and the verdict then read as a
judgment of a payload its author never saw, to every consumer that infers the
binding from the write time. `recordVerification` already closed exactly this
TOCTOU for the tier snapshot; the version now gets the same treatment — the
source row is held, the version re-read under that lock, and a target that moved
rejects the write with the 409 the pre-check raises. No schema change: the
source-table map and the lock live beside `verificationTargetVersion`, and the
importer calls them rather than keeping a second copy. This is what makes the
binding rule below sound rather than approximate.

**Assessments.** Imported at the time of the judgment the row still holds, the
server-owned `verifier_tier`, and `supersedesAssessmentId: null`. That time is
`agent_verifications.updated_at`, not `created_at`: `recordVerification` upserts
on `(agent_id, target_type, target_id)`, keeping `created_at` and moving
`updated_at`, so on a recast row `created_at` belongs to a verdict that no longer
exists and importing at it would date the surviving judgment to the one it
replaced. The first-judgment time is not discarded — it is carried in the
provenance as `sourceFirstJudgedAt` beside `sourceJudgedAt`, where the
difference between the two *is* the `current_state_only` incompleteness being
declared, and an audit consumer can tell one from the other. Binding is
*established* only when the source row is still open and the surviving judgment
is no older than its current submission time; otherwise the judgment is retained
against the target with `versionBinding: 'unestablished'` and a reason, and
never reaches a
version-specific gate. A legacy link is not that proof either way:
`snapshotLegacyVerifications` links a target-level record it cannot bind, so
where the source *does* prove the binding the importer writes the version-bound
assessment beside it — one legacy link, the history left standing, no
supersession claim. `snapshotLegacyVerifications` records the same surviving
judgment time on insert rather than the import time, carries both timestamps in
its provenance, and stamps the same unestablished marker.

**Authorship.** `authorKind` is resolved against the agents table by both
clauses the legacy gate applies — an `active` agent row and a contributor-or-
above backing user — because the kill switch demotes the user and leaves the
status alone. Everyone else, a revoked or demoted agent included, is `human`,
so the policy's `humanAuthored` requirement survives the import. The predicate
lives in `actor-context.ts` and `policy-shadow.ts` shares it. The importer does not
import `approvals` rows or disputes — neither is a reconciliation class, and
both remain live-mirror concerns. `buildDossier` already counts only open rows,
so imports do not inflate policy observations; there is a test pinning that.

**Operator command.**

```
npx tsx scripts/governance-import-history.ts \
  [--target-type=pending_edit] [--edit-type=wiki_fact] \
  [--limit=500] [--page-size=200] [--after=<id>] [--apply] [--json]
```

Preview by default, sharing its planning code with apply. It reports plan kind
per row, proposed state counts, assessment binding counts, the reconciliation
findings the plan expects to remain, the migration mode (and that apply would do
nothing under `legacy_only`), scan completeness, and the `--after` cursor to
resume from.

**Under `--apply`** it exits non-zero on any row the run does not settle: a
failure, a blocked apply, a stale capture, a binding found stale, any verdict
left unmirrored, and any row whose plan predicts `missing_proposal` or
`missing_assessment` — which covers an unmappable legacy status, a missing or
failing adapter, and a link with no version behind it. That list is keyed on
what a plan *predicts* rather than on its kind, because a cursor-driven batch
that walks past a divergence the run has just finished reporting is the exact
failure the exit code exists to stop. `state_mismatch` and `missing_publication`
on an already-mirrored row stay out: the importer does not repair those and
never claimed to, so there is nothing to come back for.

**A preview** exits non-zero only on a failed row, and deliberately. It writes
nothing and advances nothing, so there is no hole for a cursor to walk past —
and the divergences above are exactly what an operator runs a preview to *see*.
Production holds hundreds of them today, so a preview that exited non-zero over
a predicted finding would fail on every run and the signal would mean nothing. A
failure is different: there the preview could not do its own job on that row.

The consequence for automation is worth stating plainly, because it is the
mistake this paragraph exists to prevent: **a preview exiting 0 does not mean
the population is clean.** Read `revisit`, `predictedFindings` and `scanComplete`
from the report; only the apply run puts them behind an exit code. It is **not**
`governance-repair.ts --apply`; that command rebuilds mirrors the live path lost
and is not the historical backfill. `describeRepair` now prints `scanComplete`
too.

**Evidence.** `tests/governance/historical-import/importer.test.ts` (68 cases on
the PGlite harness), `tests/governance/historical-import/
real-postgres-concurrency.test.ts` (12 cases of real contention against a real
server, plus 3 wiring guards — see below), and the legacy-path contract in
`tests/governance/legacy-contract/agent-verification-target-version-stale.test.ts`.

The split matters when reading this as evidence. The 12 are gated on
`KINETIX_TEST_PG_URL` and skip without it, because one connection cannot prove a
lock excludes anything; **they are the only cases here that demonstrate
exclusion, and a run without that variable demonstrates none of it.** The other
3 always run and prove nothing about contention — they check that the gated
suite is actually wired into CI: named in a `migrations` step that supplies the
variable, and never sharing one invocation with the other destructive suite.
That guard exists because the suite once skipped inside a green job, and the job
then read as evidence for contention it had never run. The whole governance
suite passes: 56 files, 964 tests.

**First production preview (2026-09-07).** `governance-import-history.ts
--edit-type=wiki_fact --limit=500`, preview mode, nothing written:

```
historical import (PREVIEW) - 477 source row(s) examined
  migration mode:   shadow
  import: 477
  proposed states:  applied=390 withdrawn=33 rejected=54
  assessments:      417 total, 0 version-bound, 417 retained as unbound history
  expected findings: none
  scan complete:    yes - the requested population was fully examined
```

Three things this establishes that no test could. Every one of the 477 rows
plans as an `import` — none is `already_mirrored`, `unmappable_state` or
missing an adapter — so the population really is coverable and `expected
findings: none` is a claim about all of it, not about a page of it.

The 87 rows the earlier reading called "rejected" are **54 rejections and 33
withdrawals**. That is `isOwnCancel` in production: without the split, 33
submitters' own cancellations would have been recorded as rejections their work
never received. The distinction was argued from the code; this is the count.

And all 417 verdicts are retained as target-level history with none bound to a
version — which is what a population of entirely closed rows *must* produce,
since the source cannot prove which revision a verdict judged once the row is
closed. A version-bound count above zero here would have meant the binding rule
was inventing evidence.

The apply remains unrun and is the operator's: it writes 477 proposals and 417
assessments, and step 2 below is where it belongs.

#### Acceptance checks before any production apply

- Add an integration regression for the exact two-row reproduction above:
  approved/rejected imports retain their outcomes, remain closed, and reconcile
  cleanly within scope without synthetic publication events. Cover draft,
  pending, and returned imports as well.
- Re-run the same import and assert unchanged versions, assessments, links, and
  audit history; test interrupted/resumed batches and transaction rollback.
- Test competing imports and a legacy or generic state/version change during
  capture. Assert no duplicates, reopened terminal rows, or stale approvals.
  Where the PGlite harness cannot prove real pool-lock behavior, supplement it
  with transaction-context checks and an isolated real-Postgres test before
  production use.
- Test explicit historical provenance, missing/malformed provenance, and a
  projection rebuild. Prove a genuinely missing native publication still fails,
  including publication after an open import and publication of a later version.
- Test known original review timestamps/capabilities, unknown or stale version
  binding, and exclusion of historical imports from fresh shadow observations.
- Test preview/apply agreement, pagination through a population larger than the
  first scan page, and visible incomplete/blocked outcomes with no success claim.
- Run the affected governance integration suites and type checks. Validate a
  representative disposable database before a fresh production preview. The
  implementation PR must include the scoped reconciliation and queue evidence;
  do not certify completion from repaired-row counts alone.

#### Resume sequence after the fix is reviewed and available

1. Re-read migration state and confirm `pending_edit = shadow`, with legacy
   publication authority intact. Do not repeat the already-completed transition
   just because an earlier status command failed.
2. Run `scripts/governance-import-history.ts` in preview mode
   (`--edit-type=wiki_fact` first). Read the predicted-findings block, not only
   the row counts: rows already mirrored before this fix are reported
   `already_mirrored` with the `state_mismatch` / `missing_publication` they
   will still produce, and the importer will not rewrite them. Resolve those
   separately. Then have the operator apply bounded, resumable batches, walking
   the `--after` cursor until a run reports `scan complete: yes`, and verify
   complete current coverage (477/477 was only the initial `wiki_fact` count),
   zero unresolved in-scope reconciliation findings, and clean queue parity.
   Keep out-of-scope legacy-only gaps explicitly separate. Stop on unexpected
   errors or discrepancies; do not advance modes to hide them.
3. Leave it in shadow until ordinary open `wiki_fact` rows have accumulated policy
   observations with no severity-1 divergence; there were none open on
   2026-09-05, so this requires actual activity, not another import command or
   fabricated production edits.
4. `pending_edit` → `compare` → `generic_read`, each with a clean status.
5. Only with `assessReadiness('wiki_fact')` reporting ready:
   `pending_edit:wiki_fact` → `generic_authoritative`, observe, and retreat
   on any trigger in the rollback playbook.

### Step C - cut over the served queue for proven low-risk targets

Move the served review queue onto generic proposal versions and the package queue selector only after the independent parity evidence is clean.

### Step D - normalize persistence before extracting it

Separate canonical generic SQL semantics from Kinetix legacy decoding as described in §3. This should be behavior-preserving from Kinetix's perspective.

### Step E - optional Postgres package

Only after Step D and a non-Kinetix SQL host validation, extract the generic schema/store into a sibling package in `hagelien/assurance-core` and switch Kinetix to consume that version behind conformance and parity tests.

### Step F - next target type

After `wiki_fact` is operationally proven, the next intended low-risk proposal cutover is `wiki_section` or an equivalently reversible prose target.

For every target:

1. build the dossier;
2. fix every blocker;
3. add exactly that edit type to `CUTOVER_ELIGIBLE_EDIT_TYPES` in its own PR;
4. merge and deploy;
5. have an admin advance `pending_edit:<editType>` at runtime;
6. observe;
7. roll back immediately on a permissive divergence or other trigger.

Calculation-driving `parameter` / `param_entry` targets remain much later and keep their dedicated high-risk gates. `clinical_case` remains an explicit human-signoff case, not an ordinary consensus cutover.

---

## 7. Recommended PR train from this point

Keep these separable so a packaging decision cannot smuggle in an authority change.

1. **Documentation handoff** - this plan and status corrections only.
2. **Historical snapshot importer and reconciliation fix** - the Step B assignment and acceptance checks above; implemented, see "As implemented". Prerequisite to production historical backfill and subsequent cutover evidence, which remain unrun.
3. **Low-risk queue data-model cutover** - serve package queue selection over generic proposal versions after parity, with rollback retained. Its prerequisite is done: the package's `candidatesFromStore` window issue is fixed (`selectReviewQueueFromStore`). The cutover itself still waits on parity evidence, which waits on the production backfill.
4. **Persistence normalization** - canonicalize new generic SQL representation and isolate Kinetix legacy decoders; no package move required yet. Implemented, see §3 "As implemented"; done ahead of the backfill so no stored data needs migrating.
5. **Optional Postgres extraction** - only after a non-Kinetix SQL host passes the same conformance contract.
6. **Next target dossier/eligibility PR** - normally `wiki_section`, one type only.
7. **SDK extraction** - only when a real second consumer exists and needs the client.
8. **HTTP/UI packages** - only if multiple hosts demonstrate common need.

The historical import fix must precede its operational backfill. Later items
may be reordered where their prerequisites permit, but do not combine them into
one large PR or bundle runtime authority changes with code deployment.

---

## 8. Landing criteria for the reusable transition

The transition can be described as successfully reusable when all of the following are true:

- Kinetix consumes the versioned `assurance-core` package and carries no duplicate core implementation;
- the core package remains dependency-free and host-neutral;
- generic review packets and queue rules come from the package on served generic paths;
- Kinetix's SQL adapter passes the package store-conformance contract;
- any extracted Postgres package contains no Kinetix legacy decoder or policy-specific recovery semantics;
- at least one non-Kinetix host exercises the package, and any extracted storage package is likewise validated by a non-Kinetix host;
- per-target authoritative cutovers have clean reconciliation/parity evidence and exercised rollback;
- no high-risk publication rule is weaker than legacy;
- SDK and HTTP extraction are not prerequisites for Kinetix to finish its migration.

---

## 9. Source documents

Keep using these for detailed invariants and evidence:

- `2026-08-26-general-knowledge-governance-extraction.md` - original full design and migration invariants;
- `2026-08-26-phase-8-first-authoritative-cutover.md` - authority boundary and rollback semantics;
- `2026-08-26-phase-9-cutover-procedure.md` - per-target dossier procedure;
- `2026-08-26-phase-10-high-risk-gate.md` - high-risk requirements;
- `2026-08-26-phase-12-generic-sdk.md` - in-process client contract;
- `2026-08-26-phase-13-second-domain.md` - second-domain validation history;
- `2026-08-26-phase-14-packaging-readiness.md` - current package-boundary status;
- `2026-08-26-definition-of-done-audit.md` - how to interpret completion checks.

For **current status and next actions**, this 2026-09-05 handoff wins if an older document disagrees.
