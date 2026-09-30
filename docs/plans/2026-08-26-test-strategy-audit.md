# §16 test strategy — audit

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`.

§16 is the one section of the plan that is not a phase. It is a standing
specification of what the migration's tests must cover, written before any of
them existed, and it is the section most likely to be quietly half-satisfied:
every phase's own tests naturally cover the parts of §16 that phase happened to
touch, and nothing forces anyone to look at the list as a whole.

This document is that look. It maps §16.1–16.8 onto what the repository
actually contains, records what this pass added to close the gaps, names three
findings the new tests turned up, and states plainly the one requirement this
repository cannot discharge.

---

## 1. Coverage, subsection by subsection

| § | Requirement | Where it lives | State |
|---|---|---|---|
| 16.1 | Legacy contract tests freezing current externally visible semantics | `tests/governance/legacy-contract/` — edit-type inventory, return/revise/resubmit lifecycle, target-version staleness, dispute-withdrawal unblocking, review-queue performance baseline | Covered |
| 16.2 | Table-driven policy tests over every combination | `tests/governance/policy/apply-gate-parity.test.ts` (13-case named matrix + exhaustive outcome parity), `policy/kinetix-policy.test.ts`, `core/policy.test.ts` | Covered, with one dimension noted below |
| 16.3 | Eight property invariants | **`tests/governance/properties/invariants.test.ts`** | Added this pass |
| 16.4 | Adapter parity across seven dimensions | `tests/governance/adapters/` — `kinetix-adapters.test.ts` (risk classification, evidence requirements, fingerprints), `review-packet.test.ts`, `queue-hydration-parity.test.ts` | Covered |
| 16.5 | Six persistence properties | `tests/governance/store/generic-store.test.ts` (immutability, supersession, unique current-version projection, idempotent legacy links, decision→version reference) plus the apply-once guard in `cutover/authoritative-publication.test.ts` | Covered |
| 16.6 | Nine concurrency scenarios, plus connection identity | `tests/governance/transaction/connection-identity.test.ts` (identity, static nesting guard, atomicity) and **`tests/governance/concurrency/races.test.ts`** | Added this pass; one item outstanding (§4). Scenario 8's duplicate resolved and scenario 9 added — see §3.2 |
| 16.7 | Migration tests | `tests/governance/store/migration-additive.test.ts`, `store/schema-drift.test.ts` | Covered |
| 16.8 | Eight named end-to-end scenarios | **`tests/governance/e2e/scenarios.test.ts`** | Added this pass |

### The one §16.2 dimension that is not exercised

§16.2 lists **evidence state** among the combinations to sweep. It is absent
from the apply-gate matrix, and deliberately: the Kinetix apply policy declares
no `evidence.allSatisfied` requirement. Citation enforcement lives at the submit
endpoint, before governance sees the proposal, which is why
`citationEvidenceRequirement` is built with `blocking: false` (see
`adapters/kinetix/support.ts`). The requirement primitive exists and is unit
tested in `core/requirements.test.ts`; sweeping it through the Kinetix matrix
would sweep a dimension the policy does not read, which produces columns that
are identical by construction and reads as coverage.

---

## 2. What this pass added

### §16.3 — `tests/governance/properties/invariants.test.ts`

The eight invariants as generated properties over `fast-check`, 500 cases each.
Contexts are built by **tallying generated assessments** rather than by
generating each `AssuranceProfile` field independently: independent field
generation produces states no tally can reach — six human approvals out of two
explicit approvals — and an invariant that only holds on unreachable inputs
proves nothing about production.

Three of the invariants are implications ("allowed after implies allowed
before"). An implication over a space where nothing is ever allowed is
vacuously true, so the suite opens by sampling its own generator and asserting
it reaches both outcomes, and that high-risk contexts exist which a flagship
approval genuinely unblocks.

Two invariants are only half-provable as pure properties, and say so where they
appear:

- **"Adding an approval must never reduce assurance"** holds for a *new*
  approver and deliberately does not hold for a reviewer revising its own
  verdict — supersession is not addition, and a flagship reviewer that revises
  down to an abstention must stop clearing the tier gate. Both directions are
  pinned.
- **"Changing the payload must invalidate old-version eligibility"** rests here
  on a fingerprint property (different payloads, and different baselines under
  an unchanged proposal, produce different fingerprints) plus the end-to-end
  scenario in §16.8.7 below.

Invariant 8 (determinism) is asserted three ways: re-evaluation, a structurally
equal but distinct object, and evaluation with `Math.random` and `Date.now`
stubbed to values a policy reading them would have to notice.

### §16.8 — `tests/governance/e2e/scenarios.test.ts`

All eight named scenarios, driven through the real HTTP handlers: a verdict is
a POST to `/api/agent-verifications`, a moderator decision a PATCH to
`/api/pending-edits`, a dispute a POST and then a PATCH to `/api/disputes`.
Nothing calls the consensus gate directly, because half of these scenarios are
about *who* is allowed to close a proposal.

The three `wiki_fact` scenarios run **twice** — under legacy authority and under
`generic_authoritative` — and assert the same end state. A strangler
migration's claim is not "the new engine works" but "the outcome is the same
whichever engine is in charge", and a scenario that only ever ran under one of
them would pass straight through the cutover without noticing it happened.

That doubling is only meaningful if the cutover variant really did run
generically. Every fallback path in `publishOnAgentConsensus` ends by handing
the decision back to legacy and producing an identical end state, so each
cutover variant additionally asserts an `authoritative` decision row for the
right version, and — on an apply — a publication event beside it. The first
version of this suite did **not** assert that, and was quietly falling back
(the decision row is written with `evaluationMode: 'authoritative'`, not
`'generic_authoritative'`, which is what the assertion was originally looking
for). Scenario 8, the kill switch, asserts the inverse: cut over, switch thrown,
legacy publishes, and the generic side records nothing authoritative.

### §16.6 — `tests/governance/concurrency/races.test.ts`

All eight scenarios, plus a ninth added when §3.2 was resolved — scenario 8's
collisions replayed on a topic page, where a section is a heading node an admin
can genuinely delete rather than a schema entry that is simply absent when
empty. With an explicit statement of what the harness can prove.
PGlite is one in-process connection: two operations issued without an
intervening `await` interleave at the JavaScript layer and serialise at the
database. So these tests prove **interleaving safety** — that a second actor
arriving between any two steps of the first cannot produce a forbidden state —
and they do not prove lock behaviour or deadlock freedom.

Each scenario therefore asserts an *end-state invariant* rather than an
ordering: "exactly one application", "never both rejected and live", "the
snapshot that was taken is the snapshot that was used". Those hold regardless of
who won the race, which is the only kind of assertion a serialising harness can
make honestly. The property that genuinely discriminates the production failure
mode — client identity across a joined transaction — is asserted in
`tests/governance/transaction/connection-identity.test.ts` and is not
re-implied here.

---

## 3. Findings

### 3.1 A high-risk `parameter` edit can never publish

`isHighRiskPendingEdit` returns true exactly when
`parameterIsEntryBacked(parameter)`. `applyApprovedEdit` refuses an authored
value for exactly those parameters, with `parameter_entry_backed`. The two
predicates are complements over the same set, so `editType: 'parameter'` is
high-risk precisely when its apply path will refuse it.

This matters for testing more than for production, where the submit endpoint
already routes those parameters to `/api/parameter-entries`. The refusal is a
`ParameterApplyError`, which `applyOnAgentConsensus` swallows into a silent
`false` — so a high-risk scenario written against `editType: 'parameter'`
passes its "held" assertions for a reason that has nothing to do with the gate.
§16.8's scenarios 4 and 5 use `param_entry`, the calculation-driving type that
actually reaches a write, and the overlap itself is pinned as a test over every
`DRUG_PARAMETER_ID` so that a change to either predicate surfaces it.

### 3.2 A queued approval is applied against a target it was never re-checked against

Originally recorded as two findings in §16.6 scenario 8, both green on
behaviour that was not obviously right. The underlying shape is one thing: the
pending edit's freshness token protects the *proposal* from changing under a
reviewer, and nothing protects the *target* from changing under the proposal.

**The duplicate is fixed.** An admin who added the same fact by hand while an
edit was queued used to end up with **two copies** — `applyApprovedWikiFact`
spliced without deduplicating on `factId`, and nothing detected the collision.
Both fact engines now upsert: `add` resolves the anchor the same way `replace`
does on that engine (page-wide on a monograph, section-scoped on a topic page)
and updates the node in place when it is already occupied. The approval still
wins, but it wins by replacing rather than by appending, so the page carries
one copy and the revision history records which version survived.

The existing node is updated where it sits rather than relocated into the
proposal's target section. An admin who filed the fact elsewhere made an
editorial decision the proposal never saw, and moving content is what `reorder`
is for.

**The second finding did not survive investigation.** It was recorded as "an
admin who deletes the section the fact was queued against does not block the
approval: the apply rebuilds the section". That is true of the characterization
test, but the test runs against a **drug monograph**, where a section is not a
node an admin can delete. Monograph sections are a fixed schema
(`MONOGRAPH_SECTIONS`), the content envelope stores only the ones that have
content, and `normalizeMonographContentV2` prunes any section left empty — so
"the admin deleted it" and "it has no content yet" are the same stored state.
Refusing a missing section there would reject every first fact into a fresh
section, which `src/lib/__tests__/monographFacts.test.ts` pins as correct.

On **topic pages**, where a section really is a heading node that can be
deleted, `applyApprovedWikiFact` already refuses: it checks
`listTopicSectionIds` against the edit's `sectionId` and throws a 404 before
splicing. That behaviour was unguarded — nothing failed if it were removed —
which is the same absence-reads-as-a-pass shape as §3.3. Scenario 9 now pins
it, along with the topic-page upsert, so the two page types are covered
symmetrically.

The generic-engine parity test moved from 2 occurrences to 1 in lockstep with
the legacy engine. That test exists because the one outcome worse than either
behaviour would be the two engines resolving a collision differently after
cutover.

**What remains open** is the general case, and it is deliberately not fixed
here: the apply still does not re-check the target it was assessed against. The
upsert resolves the collision that actually happens rather than detecting that
one occurred, and no signal reaches the moderator when the published version
overwrites a hand-written one. Closing that properly means giving the pending
edit a baseline of the target state at queue time and refusing (or re-opening
review) when it no longer matches — a schema change plus a governance-behaviour
change whose cost is edits bouncing back to moderators. That is a decision, and
a larger one than this pass.

### 3.3 Two defects found in review, and fixed

Both were raised by an automated review of this branch, and both are the same
shape as the findings above: something that reported success because it could
not see the case it was missing.

**A changed verdict was never mirrored.** `recordVerification` upserts on
`(agent_id, target_type, target_id)`, so a reviewer that revises its judgment
rewrites the same row and keeps the same legacy id. `mirrorAssessment` treated
the presence of a legacy link as proof the current verdict had been mirrored,
so corrections never reached the generic side — and because
`linkageIsComplete` compared row counts, one stale generic assessment still
matched one legacy verdict, so the linkage looked complete and no fallback
fired. Under `generic_read` an approve-to-dispute correction went on being
served from the withdrawn approval.

Fixed by comparing the whole judgment — verdict, rationale, and the tier
snapshot the flagship gate reads — and recording a change by **superseding**
rather than assuming. `linkageIsComplete` now counts *current* assessments;
counting every row ever written would see two generic rows behind one legacy
verdict and fall back to legacy forever after any reviewer changed its mind.
Regression coverage in `tests/governance/mirror/changed-verdict.test.ts`, whose
four substantive cases were confirmed to fail against the old code.

**The reconciliation scanner never advanced past its first page.** Every scan
ordered by id and took the first `limit` rows, so it always read the oldest
window. Past that limit, missing mirrors among newer rows were permanently
invisible while the scan went on reporting zero divergences — truthfully, for
the window it read. The Phase 4 exit gate is "unexplained mirror loss = 0 after
reconciliation", a claim about a table that the scanner could only ever support
about its first page, and a clean truncated scan was indistinguishable from a
clean complete one.

Fixed with a cursor: `reconcile` takes `after` and reports `truncated` and
`nextCursor`; `reconcileAll` walks to the end and reports `complete`, bounded
by `maxPages` so a scanner cannot become an outage. Everything that gates on
"no divergences" — `definitionOfDone` and the cutover dossier — uses the
complete walk and treats an unfinished scan as **not proven** rather than
clean. `repairMirrors` stays bounded, because repair acts, and reports
`scanComplete` so an operator knows which statement they are holding.
Regression coverage in
`tests/governance/mirror/reconciliation-paging.test.ts`; nine of its ten cases
fail against the old code.

### 3.4 A revision deletes prior verdicts, rather than merely invalidating them

§16.8.7 asks for "payload revision after approvals → requires new-version
reviews". Kinetix satisfies it more strongly than the freshness token suggests:
a submitter revision calls `clearVerificationsForTarget`, which **deletes** the
standing verdicts and re-stamps the author's implicit approve. So the revised
payload starts from nothing, and a reviewer whose verdict was wiped may vote
again.

That is version-bound review expressed against a table with no version column,
and it is lossy: the judgment of the old payload is gone. The generic schema
keyed by version needs no deletion — the assessments stay attached to the
version they judged, and the revision's version simply carries none. Both are
asserted side by side in scenario 7, in both directions, because "the new
version has no assessments" is vacuous unless the old one has some.

---

### 3.5 The default test suite had no CI gate

Found while confirming §3.2's PR was green: it was, on three checks, none of
which had run the tests for the code it changed.

Every workflow in `.github/workflows/` was filtered to one subsystem —
`kinetics-core` to the PK engine, `parity` to the ethanol path, `migrations`
to the governance and schema surface, `server-shared-esm` to the ESM specifier
guards. Nothing ran the default vitest project, which is 409 files and 5143
tests covering `src/**` and `tests/**`. A change anywhere outside those four
filters merged with its own tests unexecuted.

The consequence was already in the tree. `ParameterEntryList`'s "authored
figures in the tooltip" assertion broke when issue 1188 laid the tooltip out as a
decimal-alignment grid, splitting `10–30` and ` mg/L` into separate cells; a
`getByText('10–30 mg/L')` could no longer match. It went red on `main` and
stayed there, because no PR check and no `main` check ever ran it. Fixed by
asserting on the tooltip's text content rather than a single text node —
verified non-vacuous by checking that a wrong expected value still fails.

`unit-tests.yml` now runs the suite on every PR and every push to `main`, and
is deliberately **unfiltered**. A path list is what produced the gap: it has to
be widened by hand whenever a tree grows, and the failure when someone forgets
is a green check that ran nothing — the same absence-reads-as-a-pass shape as
§3.3's truncated scan and §3.2's unguarded topic-page refusal. This one is
worth stating plainly because it sat one level above the others: the audit was
reasoning about which tests exist, while the thing deciding whether they ran
was never examined.

### 3.6 The extraction, and the one part of it that is not ready

The governance core left this repository and is now `assurance-core` on npm.
Three things followed, and one deliberately did not.

**The core.** Kinetix held a byte-identical copy of the seven pure modules —
identical once comments are stripped, with the same 38 runtime exports. Both
were live and nothing detected divergence. The copy is deleted; the package is
a dependency. What stayed is `src/lib/assurance/`, the Kinetix policy and the
projection onto a 0–3 verification level, which is host-specific by nature.

**The store port.** `api/_lib/knowledge-governance/store/assurance-port.ts`
implements the package's `AssuranceStore` over the `kg_*` tables, and
`tests/governance/store/port-conformance.test.ts` runs the package's
conformance suite against real SQL. That is the part worth having: a
TypeScript interface states shapes and cannot say that `currentAssessments`
returns one row per assessor, or that a revision must not inherit the previous
version's approvals. An adapter that compiles can be wrong in every such
clause, and the failure surfaces as a review that quietly counts a reviewer
twice.

Writing it forced three things into the open that were previously implicit,
and review corrected two of them.

- The stored `risk_profile` is untyped JSON, and a malformed one is worse than
  a crash. `atLeastRisk` on a profile with no level answers false, so every
  high-risk rule silently stops matching and the proposal publishes under the
  low-risk bar. The first fix validated the shape and fell back to `LOW_RISK`,
  on the reasoning that a stated guess beats an implicit one — and that was
  wrong in the only direction that matters: it reproduced the exact silent
  bypass, now with a reassuring comment above it. A publication gate fails
  closed by demanding *more* review. A malformed profile reads as high-risk
  and carries `risk_profile_unreadable`, so the proposal is held and the
  reason travels in the policy context rather than needing a separate call.
  `null` is still low: a version nothing has classified yet is not corrupt,
  and holding every unclassified row would be failing closed on the wrong
  thing.
- The decision vocabularies do not line up. The stored outcome has five values
  because it also records what a human should do next; the port has a boolean
  because a core deciding publication asks one question. Only `apply` reads
  back as allowed, which is right — none of the others publish.
- The dispute vocabularies did not line up either, and here the port was
  wrong rather than merely narrower. `superseded` means a replacement dispute
  governs, so `recordRuling` deliberately leaves the original **open**. Mapping
  it to `withdrawn` reported a closed ruling on an open dispute — "withdrawn
  but open", which tells a caller nothing and cannot be told apart from a
  complaint the opener dropped. The port carries the word now
  (`assurance-core@0.3.0`), `rulingClosesDispute` states the rule in one place,
  and a conformance clause covers it. That is the intended way for the
  interface to grow: a word earns a place when a real store loses meaning
  without it.

Review caught four more, all in the adapter, and three of them are the same
mistake in different fields: **treating stored data as trustworthy because it
parsed.**

- `listOpenProposals` filtered `targetType` and `excludeAuthorRef` in
  JavaScript over a bounded over-fetch, so a page came back short — or empty —
  whenever more older proposals failed the predicate than the window held. The
  caller most likely to hit it is the self-review filter on a prolific author's
  own space, which is precisely the case an over-fetch loses. Both predicates
  run in SQL now, before `LIMIT`, with the target type reached through a join.
- The fail-closed reading of `risk_profile` validated only the *level*. Tags
  are equally load-bearing — the Kinetix policy requires a human clinical
  expert on anything tagged `clinical_case` — so a corrupted tag list was
  silently filtered and that rule stopped matching. Same bypass, one field
  over. A malformed tag list now yields the unreadable profile too; an absent
  one still does not, because plenty of changes legitimately carry no tag.
- `actor_kind` is a text column, and an unrecognised value fell through to
  `human` — the one kind that *confers* something, since `humanApproval` is
  satisfied by kind alone. A corrupt row could stand in for the person a rule
  exists to require. Unknown now reads as `service`: still on the record, but
  unable to satisfy a human requirement.
- Only `getVersion` checked that a `ProposalVersionRef` named a real pairing.
  Every other read trusted the version id alone, so combining proposal A's id
  with proposal B's version id returned B's governance state labelled as A's —
  approvals from one change contaminating another's assurance context, with
  nothing malformed anywhere to notice. A single guard now validates both
  halves for every read, and the writes refuse outright rather than appending
  under whichever proposal owns that version id.

Separately: the port's event timestamps were accepted and discarded, the column
default winning instead. That is harmless while every write is live and wrong
the moment history is imported or replayed, which is the case the timestamps
exist for. The three append helpers take an explicit time now.

Review found three more of the same shape afterwards — an unconstrained
`evaluation_mode` promoted to `authoritative` (wrong on `advisory` too, not
only on corrupt rows), an unconstrained `ruling` treated as closing, and the
author half of `actor_kind` — plus one bug the timestamp fix itself created,
where a replayed ruling rewrote the dispute projection from the row just
inserted rather than from the ordered history.

The pattern is worth stating because it recurred five times across four
tables: this adapter reads JSON and text columns that other code wrote, and
every one of them was a place where "parsed successfully" was quietly taken to
mean "safe to act on".

Two refinements are worth keeping in mind for the next reader.

**Failing closed is directional, and the direction depends on the role.** For
an *assessor*, `human` satisfies a requirement, so an unreadable kind must not
be human. For an *author*, `human` attracts one — `when: { authorKind: 'human' }`
requires a human approval — so an unreadable kind must be human, or the rule
simply stops matching. Same column, opposite fallback, which is why
`actorKindOf` and `authorKindOf` are two functions rather than one.

**Repairing a projection on write does not cover reading it.** The dispute
`closedAt` fix went in on the write path first, which only helps disputes whose
rulings all arrived through it; a ruling imported directly or corrupted in place
leaves a stale projection nothing re-derives. Openness is now derived from the
ruling history on read, which is what the port already said it should be —
where a projection and the history disagree, the history wins.

**And a distinct problem the same review surfaced: an adapter must read what
the table actually holds, not what the newest writer puts there.**
`kg_assessments` has three generations of writer and they do not agree on
shape. The capability snapshot is a bare array from this port, a
`{ capabilities, assuranceCapabilities }` object from the SDK, and a
`{ modelTier, isImplicit }` object from the mirror and the backfill. Reading
only the first stripped server-owned standing off every row the other two
wrote, so a qualifying approval quietly stopped satisfying the clinical-case
and high-risk capability gates. The implicit marker splits the same way —
`independence_group = 'author'` here, `capability_snapshot.isImplicit` there —
and reading only one reported an author's own submission stake as an
independent review.

Both fail in the direction that *looks* safe, which is why they are easy to
miss: one loses approvals, the other adds a hold. Neither is safe, because
both make the port misreport data that is perfectly well-formed. This is the
distinction worth keeping: the untrusted-column cases above are about data
that is *wrong*, and this one is about data that is *right* and was simply not
understood.

**The review packet.** Deleted here and imported from the package. The
anti-echo-chamber guard belongs below the adapter boundary: it is worth
exactly as much as the least careful adapter anyone writes, and a host cannot
enforce a rule on adapters it has not seen yet.

**The queue, which did not move, and should not have.** The package now has
the same three eligibility rules. Adopting them here would mean two changes
this repository is not ready for:

1. Kinetix's queue selects over *legacy* rows — `agent_verifications` targets
   keyed by `(targetType, targetId)` — while the package's selects over
   proposal versions. Rewiring one onto the other is the queue's data-model
   cutover, which the migration plan stages after parity has been proven, not
   before.
2. The shadow generic queue exists to be an *independent* implementation, so
   that comparing it against the legacy one can fail. Importing the package's
   selector would make that comparison trivially true — the same reason
   `selectGenericBatch` re-derives the reserve logic rather than importing
   `selectQueueBatch`, already recorded in that file.

So the queue's move waits on the cutover it belongs to. What is *not* waiting
is the duplication risk that motivated the rest of this: the package's queue
has no consumer here, so there is nothing to drift.

### 3.7 What fifteen rounds of review actually found

The port adapter drew thirty-one review findings across fifteen rounds, all
accepted. Recording the count would be less useful than recording the shape,
because the shape is the transferable part.

**Rounds one to five: untrusted columns.** Six columns — `risk_profile.level`,
`risk_profile.tags`, `actor_kind` (twice, in opposite directions),
`evaluation_mode`, `ruling`, `verdict` — each read as though its declared type
were enforced by something. None of them are: they are `varchar` and untyped
JSON, and the types are claims about what writers *should* put there. The
`verdict` case was the worst, because `tallyAssurance` treats anything that is
not `dispute` or `abstain` as an approval, so an unreadable value became an
explicit approval able to satisfy a quorum outright.

**Round six: shapes, not values.** `kg_assessments` has three generations of
writer and they disagree on structure. The capability snapshot is a bare array
here, `{ capabilities, assuranceCapabilities }` from the SDK, and
`{ modelTier, isImplicit }` from the mirror and backfill. Reading one lost
server-owned standing off every row the others wrote. This is a different
failure from the first five: the data was *correct* and the reader did not
understand it, which no amount of validation would have caught.

**Rounds seven and eight: the fixes themselves.** Three consecutive rounds
found that the previous round's fix had left something behind — a superseded
dispute erased, then a verdict carried without its metadata, then a chain
walked by the wrong key. The through-line is not the individual misses. It is
that each fix repaired *the instance in front of it*: one column, then one
field, then one lookup, where the actual problem each time was the shape of
what was being reconstructed. Falling back to an entire assessment record,
rather than to a value grafted onto the current row's metadata, is the version
with no next field to forget.

**Rounds nine to eleven: one region, five ways of being wrong.** Everything
after round eight concerns a single mechanism — reconstructing an assessor's
position from a supersession chain containing rows nobody can read — and it
was wrong in five distinguishable ways: the fallback's scope, the metadata it
carried, the key it walked the chain by, its handling of a cycle, and its
tie-breaking. Each fix was correct; each left the next case.

The code was correct after each of those, and every branch of it was tested in
both directions. But eleven rounds of eventual green should not be read as
evidence that the design was right. **The mechanism carried more inference
than a publication gate should**, and the alternative was recorded here at the
time rather than taken: refuse to resolve a corrupt chain at all, and surface
the version for human attention instead of computing a best-guess position
from rows nobody can read.

**Round fifteen took it.** The sixth distinguishable failure in that one
mechanism was its *direction*: the fallback restored a superseded `approve` as
readily as a superseded hold, so an unreadable row resurrected the approval it
replaced and the core counted it toward quorum. At that point the pattern is
the finding. Every individual fix had been correct; the premise — that a
corrupt record can be reasoned back to what it probably meant — is what kept
producing them, and a gate that guesses will eventually guess in the direction
that publishes.

So the chain walk is gone. Corruption is now *detected* — an unreadable
verdict, a supersession link that dangles, crosses actors, or closes a cycle —
and a version whose history is corrupt yields **no approvals at all**. That is
a guaranteed hold rather than a penalty: `effectiveIndependentQuorum` is
`min(target, max(1, eligible))` and so never zero, which means zero approvals
cannot satisfy `independentApprovalsFromPool()` however small the reviewer pool
is. A readable dispute still stands, because it is a real objection and
dropping it would fail open; everything else reports `abstain`, carrying no
capability and no implicit marker. The store reports the fact through a
callback and the host counts it, so the hold is visible rather than silent.

Two things worth recording about *how* that landed, because both corrected a
claim made while proposing it:

- **It deleted less than predicted.** The proposal said the tie-collapse would
  go with the chain walk. It could not: `backfill.ts` writes every legacy
  `agent_verification` with `supersedesAssessmentId: null` deliberately (§6.4
  forbids inferring that a later approval replaced an earlier dispute when that
  history no longer exists), so one agent legitimately holds several unlinked
  standing rows, and `tallyAssurance` keeps only the last. Collapsing them
  fail-closed is a permanent requirement of this host's data, not a tolerance
  for corrupt data, and treating the two as one mechanism was the error in the
  proposal. Only the reconstruction went.
- **The boundary test caught the surfacing.** The first version incremented a
  counter from inside the store, and `boundaries.test.ts` failed it: that
  module is held to drizzle, the core, the governance schema and the db handle
  precisely so it can move to another host. The store now states the fact
  through an observer and the host wires the counter — the same inversion
  `AssuranceStore` itself is built on, arrived at because a guard refused the
  shortcut.

**Rounds twelve and thirteen: still the same region.** Two more ways for a
snapshot to be unreadable — a tag field holding a bare string rather than a
list, and an object whose shape had to be decided by which field was present
rather than by trying each in turn. Both are round six's failure, not round
one's: the data was well-formed for its writer and the reader did not know that
writer's shape.

**Round fourteen: two fields that were each read correctly.** An assessment
carrying `verdict: 'dispute'` *and* an implicit marker. `tallyAssurance` counts
an implicit assessment and moves on before it ever inspects the verdict, so the
objection reached no reader: it tallied as an implicit approval,
`disputingAssessors` stayed at zero, and publication proceeded over a recorded
objection.

This is a third failure class, and the most interesting of the three. Nothing
was unreadable and no writer's shape was misunderstood. Each field was read
exactly right; they simply contradicted each other, and the reader had no
opinion about the contradiction because it read them independently. The fix is
structural rather than defensive: `verdict` and `implicit` now come out of one
function, so the pair has nowhere to disagree — only an approval can be
implicit, and a `dispute`, an `abstain` or an unreadable verdict drops the
marker. Normalised on write too, since the raw column has other readers.

**What to take from it.** Four habits, in the order they would have helped:

1. When a column's declared type is not enforced by the schema, decide what an
   unreadable value means *before* writing the read — and decide it per
   consumer, because fail-closed is directional. `human` satisfies a
   requirement for an assessor and attracts one for an author.
2. Before reading a column, find every writer of it. Testing your own writer
   against your own reader proves nothing about the rows already in the table.
3. When a fix draws a follow-up finding twice, stop fixing the field and look
   at the shape. The third round is too late to notice.
4. Two fields that constrain each other should be read by one function. Every
   validation habit above concerns whether a single value can be trusted; none
   of them would have caught a pair that was individually valid and jointly
   contradictory.
5. Count the rounds a single mechanism draws, and decide in advance what number
   means the mechanism is wrong rather than incomplete. Each of those six fixes
   was defensible on its own; only the sequence showed the premise was. Naming
   the threshold *before* reaching it is what made stopping a decision rather
   than a mood.

An audit of every `kg_*` column this adapter reads against every writer of it
came back clean otherwise: the multi-writer divergence is confined to
`kg_assessments`, and `risk_profile` in particular does not trip the strict
validation — which matters, because if the mirror had stored a different shape
there, that validation would have marked every mirrored proposal high-risk and
held the lot.

## 4. The real-Postgres requirement, now discharged

§16.6 asked for one thing this repository could not do:

> exercise the real deadlock shape at least once against a real Postgres (not
> PGlite): governance transaction holds the drug advisory lock, legacy helper
> requests it, and the test must complete rather than time out. Assert
> `pg_backend_pid()` equality here.

It was recorded as outstanding because the integration project boots PGlite per
file, and under PGlite a nested `runInPoolTransaction` degrades to a savepoint
on the one connection: both `pg_backend_pid()` and `txid_current()` match on
either side of the nesting, so the assertion would have passed on precisely the
code that opens a second Pool in production.

That was a statement about the harness, not about the requirement. It is now
covered by `tests/governance/transaction/real-postgres-deadlock.test.ts`,
running against a real server.

### What makes the target faithful

`tests/integration/setup/real-postgres.ts` attaches a real `pg` pool through the
same `setDbForTesting` seam the PGlite harness uses. The property that matters
is that `db.transaction()` on a real pool **checks out a connection**, so a
nested call takes a second one — the production shape exactly. That is verified
rather than assumed: the suite opens with a block asserting the target hands out
different backend pids for nested transactions, because every assertion after it
is worthless if the target has quietly collapsed to one connection.

The migration chain is replayed through `tests/integration/setup/migration-chain.ts`,
extracted from the PGlite harness so both targets replay the same statements the
same way. Two rules production depends on — one command per prepared send,
`CONCURRENTLY` stripped — now have one implementation rather than two.

### What it proves

- **The shape §16.6 names.** Governance holds the drug's advisory lock, the
  legacy helper asks for the same lock through `withDrugApplicabilityLock`, and
  because that helper goes through `inTransaction` it joins: one backend,
  re-entrant lock, completes. The `pg_backend_pid()` equality is load-bearing
  here in a way it could never be under PGlite, because a second backend was the
  reachable alternative.
- **The negative control PGlite could not run at all.** The pre-conversion
  nesting is executed, not described. The inner call takes a second connection
  and blocks on a lock the outer connection holds while the outer awaits the
  inner. `lock_timeout` on the harness pool turns that hang into SQLSTATE 55P03,
  so the suite asserts on it instead of stalling the job — and asserts that it
  *waited* for the timeout rather than failing fast, which is the difference
  between contention and an unrelated error.
- **The independent commit.** `connection-identity.test.ts` recorded this as
  unprovable under PGlite: a nested call that degrades to a savepoint rolls back
  with its parent anyway. On a real pool the inner unit commits on its own
  connection, so an outer failure leaves the inner write standing. The suite
  asserts the torn unit of work directly, next to the joined path that rolls
  back cleanly.

### The gap it exposed

Reverting `withDrugApplicabilityLock` to `runInPoolTransaction` — the exact
pre-conversion shape — was used to confirm the suite is not vacuous. It fails
the new suite, deadlocking for the full lock timeout.

**The entire PGlite governance suite stayed green on that same revert**, 10 of
10. Not because the client-identity assertion is weak, but because
`api/_lib/parameterApplicabilityStore.ts` was in neither the `CONVERTED` list
nor the `knowledge-governance` sweep, so nothing looked at it. It is now in the
`CONVERTED` list, where the check costs no Postgres and runs under PGlite.

### A second, larger gap behind it

Adding that line was not enough, and the first draft of this section claimed
more than was true — that the static check "runs on every PR". It did not.
`migrations` is the only workflow that runs the governance suite, and its path
filter listed neither `tests/governance/**` nor any `api/` path. So a PR that
reintroduced the nesting started `scripts-typecheck` and `server-shared-esm` —
both of which cover `api/**`, neither of which runs these tests — and every
guard discussed above sat out the one PR it existed to catch. The same held for
pushes to `main`, so the regression could land unobserved.

The filter now lists the paths those guards actually assert about:
`tests/governance/**`, `api/_lib/db.ts`, the four files in `CONVERTED`, and
`api/_lib/knowledge-governance/**`. Deliberately not `api/**`: this is the most
expensive job in the repo, and widening it to every server change would undo the
cost work in issue 1178.

That coupling is itself asserted rather than left to a comment. Two tests in
`connection-identity.test.ts` read the workflow and fail if a `CONVERTED` entry
is missing from the filter, or if `tests/governance/**` is absent from either
the `pull_request` or the `push` list — a guard that runs on PRs but not on
merges still lets the regression land. Adding a file to `CONVERTED` without
adding its path now fails loudly instead of quietly removing the coverage.

### Running it

`KINETIX_TEST_PG_URL` selects the target. The `migrations` workflow supplies it
from a `postgres:16` service container. Locally:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=kinetix_test --name kinetix-pg postgres:16
KINETIX_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/kinetix_test \
  npx vitest run --config vitest.integration.config.ts \
  tests/governance/transaction/real-postgres-deadlock.test.ts
```

Without the variable the suite **skips** and says so on stderr; it never falls
back to PGlite, where its central assertion would pass for the wrong reason. A
skipped suite still looks like a passing one in a CI summary, so two guards
inside it always run and fail if the workflow's service container or its
`KINETIX_TEST_PG_URL` wiring is ever removed — losing this coverage is a red
build, not a quieter one.
