# T3 adjudication backend — build plan

**Status:** steps 1–6 implemented (records, detector, seats, case feed,
opinions, convergence, T4 handoff); automatic closure and step 7 next. See
*Implementation status* below.
**Date:** 2026-09-18
**Design authority:** `agents/drug-db-adjudication.md` (the T3 contract),
`docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md` §B2–B4,
`agents/remote-routine-setup.md` §7 ("Backend prerequisites", items 4–8)

## Problem

T3 — the rare, non-blind, two-model appellate panel that resolves a
disagreement surviving T2 — is fully designed in three documents and
implemented nowhere. `agents/drug-db-adjudication.md` is a complete 220-line
agent contract carrying an explicit "do not schedule this prompt" banner,
because nothing in the backend can hand a panelist a case, keep two panelists
from reading each other, or package an unresolved case for a human.

The consequence is not that the workflow is broken — it is that **the T3 slice
of it is served by humans**. A dispute that survives blind T2 re-verification
currently has no next level below a person. That is safe, and for a small
dispute volume it may stay the right answer; it is also the one part of the
four-level design with no build path, no tracking issue, and therefore the part
most likely to rot while the rest of the workflow moves.

This document turns §7's numbered prerequisite list into an implementable plan.
It does not schedule the work, and it does not argue that the work should start
now (see §2).

## Implementation status

The owner chose to build the whole tier, including the narrowly scoped
automatic closure of a converged **agent-originated** dispute that the
non-goals below defer (human-originated disputes still close only by a
person). The work lands in three pull requests:

1. **Steps 1–3** (done): migration `0138_t3_adjudication.sql` (the plan's
   `0120` was taken), `agents.adjudicator` / `agents.model_family` with the
   admin provisioning path, `api/_lib/adjudication/detector.ts` and
   `cases.ts`, and the seat claim. Where it differs from the text below:
   - the verdict-time check runs right after the verdict commits, in its own
     transaction under the same source-row lock, rather than inside the
     verdict's transaction — a detector fault then never rejects a recorded
     verdict, and the sweep (`POST /api/agent-consensus-sweep`) is the
     backstop either way;
   - `repeated_correction_loop` counts disputes decided upheld or rejected on
     the target (withdrawn ones excluded), with a disagreement still live, and
     records the count as a lower bound;
   - `competing_scope` and `human_request` are typed but never produced: they
     still have no persisted input (issue 1280);
   - no agent with a part in the case takes a seat: neither one whose verdict
     it rests on, nor the identity behind a dispute it rests on (a dispute
     can be raised without a verdict), nor the target's author;
   - a case binds only the disputes raised against its own version (a legacy
     dispute with no recorded version is kept), and a person's dispute that
     appears after a case opened makes it theirs: the origin is recomputed
     over every dispute the case has seen and never narrows back to `agent`;
   - an `open` case whose disagreement goes away on the same version (a
     control-phase withdrawal) retires as `disagreement_withdrawn`; if the
     disagreement returns before any opinion was written, the same case
     reopens on a fresh cut — this is the one exception to "never reopen",
     because nothing about that version was ever decided;
   - the sweep rotates: live cases least recently checked first, and
     candidate targets only when their verdict/dispute activity is newer than
     the last check (`adjudication_detector_checks`);
   - opinions are append-only at the database: a trigger refuses every UPDATE
     and DELETE on `adjudication_opinions`.
2. **Steps 4–6** (done): migration `0141_t3_adjudication_outcomes.sql`,
   `api/agent-adjudication-queue.ts` (case list, case file, claim),
   `api/agent-adjudication-opinions.ts`, and `api/_lib/adjudication/`
   `opinions.ts`, `convergence.ts`, `caseFile.ts`, `target.ts`. Where it
   differs from the text below:
   - opinions are stored as submitted and converted to the canonical unit at
     comparison, so a unit in another family is recorded as a disagreement
     (`unit_family_differs`) rather than refused at write; a pair that cannot
     be converted (e.g. mass↔molar with no molecular weight) is
     `unit_not_convertible` and goes to T4;
   - only range parameters endorse a value; on every other target an
     endorsing opinion states its resolution in `proposition` and `scopeKey`;
   - a converged case where a panelist asked for a person is recorded as
     `diverged` (it needs a person) with the comparison kept, and a converged
     case resting on a person's dispute stays `converged` with its
     recommendation but `t4_required`;
   - two agreed abstentions resolve nothing, so they recommend nothing and go
     to T4 (`panel_abstained`): the version cannot open another case;
   - the seal re-reads the version's open disputes under the source-row lock,
     so a person's dispute that landed after the detector last refreshed the
     case still makes the closing act theirs; a seat claim re-reads them the
     same way, so an agent that disputed the target since cannot take a seat;
   - the first seat claim binds the panel (`adjudicated_target`): the hydrated
     target with its baselines and source row, the lower-tier record (copied
     verdicts and open disputes on the version), the decided disputes, and the
     canonical unit and molecular weight the opinions are compared with. Both
     seats are served that binding (a person reads the case record as it
     stands, with any dispute merged at sealing); later claims and writes
     check the live target against it and close the case on drift
     (`target_drifted`);
   - a seat is refused to any agent with a verdict on the target now, not only
     those the case copied;
   - a case about unpublished wiki content is served only to readers cleared
     for drafts, panelists (by their backing user's role) and people alike;
   - an endorsed value follows the parameter's contract — a range where
     `requiresMinMax`, within the registry bounds in the canonical unit;
   - a dimensionless range parameter (pKa, logP, logD; canonical unit `''`)
     carries a value like any other;
   - the open-case feed serves identifiers only: triggers and dispute origin
     are served after a claim, so nobody picks cases by provenance;
   - an opinion write re-checks that the target can still be served to the
     panel; one that cannot (a wiki page unpublished under an unchanged
     version) closes the case as `target_unavailable`;
   - blindness is keyed on the seal itself, not the state, so a case closed
     mid-panel never unblinds;
   - the handoff notification reuses the dispute fan-out with no dispute id
     (`notifications.type = 'adjudication_handoff'`), linking to the target,
     with no body: its title is localised by type, and the handoff list
     serves typed `reasons` rather than the English summary; the full package
     is served to reviewers by the case feed.
3. **Automatic closure and step 7**: a converged agent-originated case closes
   its agent disputes; then the "do not schedule" banner lifts.

## Goals

1. Make a T3 case a **durable, version-pinned record** that cannot change
   underneath the panel adjudicating it.
2. Open a case only through a **deterministic detector** over signals the schema
   records — never on an agent's assertion that a case is hard.
3. Serve the **complete lower-tier appeal** to T3 while continuing to serve T2
   identifiers only, from the same data, in the same deployment.
4. Enforce **panel-to-panel blindness** in the backend: neither adjudicator can
   read the other's opinion before both are final.
5. Decide **convergence in code**, on material resolution *and* scope, never by
   asking a model whether it agrees with the other model.
6. Produce a **complete T4 handoff** so a human never reconstructs an appeal
   from logs.
7. Keep adjudication authority **separate from model capability**: no identity
   gains `dispute.resolve` by being flagship, and T3 records a recommendation
   only.

## Non-goals for this plan

- automatic resolution or closure of any dispute, agent-originated or not
  (spec rollout step 7; a separate governance decision, explicitly downstream of
  prospective validation);
- any authority over a **human-originated** dispute, flag, return or rejection;
- the shadow-audit sampler (issue
  issue 1232) — a sibling
  prerequisite on the cost axis, unrelated to this integrity axis;
- extending the T2 escalation feed's trigger coverage;
- choosing the second flagship model family — a provisioning decision at
  deployment time, deliberately not encoded in the schema.

---

## 1. What already exists

The prerequisite list in `agents/remote-routine-setup.md` §7 predates several
things now on `main`. An honest inventory changes the size of the work
considerably:

| Needed for T3 | State today |
| --- | --- |
| Identifier-only T2 feed (so T3's richer feed is not the only one) | **done** — `api/agent-escalation-queue.ts` |
| Server-owned capability tier, snapshotted per verdict | **done** — `agents.model_tier` (0112), `agent_verifications.verifier_tier` (0113) |
| Version-pinned verdict writes | **done** — `expectTargetVersion` + `lockVerificationSourceRow` in `api/_lib/agent-verifications.ts`; a target that moved rejects the write |
| A canonical "what version is this target at" function | **done** — `verificationTargetVersion` |
| Immutable, append-only decision history | **partly, elsewhere** — the governance engine's `kg_proposal_versions` / `kg_assessments` / `kg_disputes` + rulings are exactly this shape, but production is at `pending_edit = shadow` with legacy still deciding (`docs/plans/2026-09-05-assurance-transition-continuation.md`) |
| Dispute provenance (`agent` vs `human`) | **done** — `disputes.source` |
| Case feed, panel write path, sealing, convergence, T4 package | **missing** — this plan |

So the work is materially smaller than "five or six new subsystems": three of
the hard invariants (tier snapshotting, version pinning, provenance) are already
solved and can be reused rather than re-derived.

## 2. The one architectural decision

**Build T3's records as Kinetix-owned tables now, shaped deliberately like the
governance engine's, rather than waiting for the governance migration to reach
these target types.**

The alternative — express a T3 case as governance proposals, assessments and
rulings — is the better end state and should be the eventual home. It is not
available: the generic path is authoritative for nothing today, and
calculation-driving types sit behind Phase 10's ten-prerequisite evidence gate.
Coupling a rare-but-high-integrity path to a multi-phase migration with no date
means T3 is gated on the slowest thing in the repository.

The cost of building locally is a later port. That cost is bounded if the local
tables copy the governance store's three enforced properties — append-only, a
pinned immutable version reference, a capability snapshot written at decision
time — which this plan requires anyway. A later port is then a data migration,
not a redesign.

> **Decision for the reviewer:** if this is judged wrong, the correct
> alternative is to defer T3 entirely until `parameter`/`param_entry` reach
> `generic_authoritative`, and say so explicitly in the spec rather than leaving
> T3 as an undated prerequisite list.

---

## 3. Core design

### 3.1 Case lifecycle

```
eligible(detector) → open → seats claimed → opinions collecting → sealed(both final)
                                                → converged   → recommendation recorded
                                                → diverged    → T4 handoff
   any new target version at any point          → invalidated (terminal)
```

A case is never edited to a new version. A target that moves invalidates its
open case and re-enters detection from scratch — the same rule
`expectTargetVersion` already applies to verdicts, for the same reason.

### 3.2 Tables (migration `0120_t3_adjudication.sql`)

**`adjudication_cases`** — one row per (target, version), for all time.

| Column | Notes |
| --- | --- |
| `id` | serial |
| `target_type`, `target_id` | the shared `AgentVerificationTargetType` taxonomy |
| `target_version` | **required**; the exact `verificationTargetVersion` the case adjudicates |
| `triggers` | the §2 codes that opened or joined this case: `t1_t2_disagreement`, `competing_scope`, `flagship_disagreement`, `repeated_correction_loop`, `human_request`. A later trigger on a live case appends here; on a terminal case it does nothing (see below) |
| `dispute_origin` | `agent` \| `human` \| `mixed` — decides what T3 may recommend |
| `t2_verification_id` | traceability FK only — **not** the record of what T2 said (see below) |
| `t2_snapshot` | the complete T2 verdict copied at case-open time: `verdict`, `rationaleMd`, `evidenceRefs`, `verifierTier`, `model`, `recordedAt` |
| `t1_snapshot` | the same copy for every lower-tier verdict and open dispute the case rests on |
| `state` | `open` \| `sealed` \| `converged` \| `diverged` \| `invalidated` |
| `panel_family_diversity` | `distinct` \| `same` \| `unknown` — recorded, never blocking (§3.6) |
| `opened_at`, `sealed_at`, `closed_at`, `invalidated_reason` | |

**Unique index on `(target_type, target_id, target_version)`, with no partial
predicate** — the key is permanent, not "while live". A predicate over
non-terminal states stops protecting the target the moment a case closes, and
the sweep re-evaluates standing signals (`repeated_correction_loop`,
`human_request`) from rows that do not change when a case is decided. The same
unchanged target version would then open a fresh case on every later sweep,
each producing its own panel, handoff and notifications. A permanent key makes
re-opening impossible at the database level rather than by detector etiquette.

So a target version is adjudicated at most once. New evidence arrives as a new
version, which is a different key and a new case; a trigger that fires against
an already-terminal case is recorded as consumed and ignored. That is also the
correct scientific reading: the panel adjudicated *that* payload, and nothing
about the payload has changed.

**The snapshots are load-bearing, not denormalisation.** `recordVerification`
upserts on `(agent_id, target_type, target_id)` — a verifier that re-verdicts
keeps the same row id while its verdict, rationale, evidence and tier are
replaced, and that can happen on an unchanged target version. A case holding
only an FK would therefore show T3 and T4 an appeal record that a later
re-verdict silently rewrote, which is precisely the mutation this tier exists to
be immune from. Copy the verdicts into the case under the same lock
`lockVerificationSourceRow` already takes, and treat the copy as authoritative
for the case. (When governance history covers these targets, the snapshot
columns become a reference to the append-only assessment instead — one of the
two porting questions in §6.)

**`adjudication_case_seats`** — who is seated, recorded *before* anyone reads a
case file.

| Column | Notes |
| --- | --- |
| `case_id`, `seat` (`a` \| `b`), `agent_id` | unique on `(case_id, seat)` and on `(case_id, agent_id)` — one identity per seat, and no identity on both seats |
| `claimed_at`, `sealed_at` | |

This table exists because the read gate needs a durable fact that predates the
opinion. Seating cannot be inferred from `adjudication_opinions`: no opinion row
exists when a panelist first requests the case file, and pre-creating one as a
placeholder would require updating it at finalisation — the update the
append-only rule forbids. A seat is claimed through
`POST /api/agent-adjudication-queue?action=claim`, the atomic-claim shape
`api/paper-extractions.ts` already uses, and the unique indexes are what make
the claim atomic under two adjudicators racing.

**`adjudication_opinions`** — strictly append-only, one row per panelist
revision.

| Column | Notes |
| --- | --- |
| `case_id`, `seat` | FK to the seat row above, which is what proves the writer may write |
| `revision_no` | derived server-side; unique on `(case_id, seat, revision_no)` |
| `supersedes_opinion_id` | forward pointer on the **new** row to the one it replaces, exactly as `kg_assessments` does |
| `adjudicator_tier` | snapshot of `agents.model_tier` at write time, exactly as `verifier_tier` does |
| `model` | self-reported, audit only, never a policy input |
| `resolution` | `approve` \| `dispute` \| `return` \| `split_scope` \| `abstain` \| `human` |
| `proposition` | what was adjudicated, one statement |
| `scope_key` | **the structured scope the resolution applies to** (population, route, matrix, analyte, time window) — this is what makes convergence comparable in code (§3.5) |
| `resolved_value`, `resolved_low`, `resolved_high`, `resolved_unit` | the canonical value this opinion **endorses**, normalised through `convertParameterValue` (`src/lib/parameterUnits.ts`) before storage. Required only for a value-endorsing resolution — see below |
| `reasoning_md`, `evidence_refs`, `confidence`, `human_required`, `human_reason` | per contract §6 |
| `finalized_at` | non-null = final and immutable |

**No update, no delete, and only one direction of supersession.** The pointer
lives on the newly appended row and points backwards; nothing ever writes to a
finalized row, not even to mark it superseded. A back-pointer on the old row
would have been an update, which contradicts both the invariant and its own
test — a draft of this plan carried both and could not have implemented either.

Uniqueness therefore cannot key on "the current opinion": it keys on
`(case_id, seat, revision_no)`, with `revision_no` derived server-side, which is
how `kg_proposal_versions` makes concurrent appends safe (the loser of the race
hits the constraint and retries rather than silently reusing a number). The
current opinion for a seat is its highest revision — equivalently, the one no
other row supersedes. "One identity per seat" is enforced by
`adjudication_case_seats` above, not here, which is why the opinions table needs
no partial index at all.

**A value is required only where one is endorsed.** `approve` and `split_scope`
endorse a value and must carry canonical fields; `dispute`, `return`, `abstain`
and `human` do not, and must be accepted without them. Requiring a number from
every numeric-target opinion would make `abstain` unreachable in exactly the
situation the T3 contract reserves it for — decisive evidence missing, where the
contract's instruction is to acquire the source and abstain rather than
manufacture a figure — and would push a case that belongs at T4 into a fabricated
value instead.

Two shapes are valid for an endorsing resolution and are validated separately: a
scalar (`resolved_value` + `resolved_unit`) or a range (`resolved_low` +
`resolved_high` + `resolved_unit`, low ≤ high). A mixed or empty shape is
rejected; `requiresMinMax` parameters follow the existing rule for their
parameter.

### 3.3 Opening a case (the detector)

A pure classifier over stored rows, called from two places so neither a missed
webhook nor a quiet cycle can strand a case:

1. **at T2 verdict-write time**, inside the existing transaction in
   `recordVerification` — the moment a blind flagship verdict becomes final is
   exactly when triggers 1–3 become knowable;
2. **a sweep** (`GET`-triggered, same shape as the escalation feed) that
   re-evaluates triggers 4–5 and backfills anything the write path missed.

Triggers 2 (`competing_scope`) and 5 (`human_request`) have **no persisted input
today** — the T2 verdict is `approve | dispute | abstain` plus prose, and nothing
records an editor asking for an adjudication. Both need a structured signal and
its write path before they can fire; tracked in
issue 1280, to land with steps 1–2.

Trigger 4 (`repeated_correction_loop`) needs history the legacy tables do not
retain. Until governance history covers these targets, implement it from
`drug_parameter_revisions` + `pending_edits` status transitions and **label the
count a lower bound** on the case, exactly as `benchmark-agent-tiers` labels its
rates. Do not let an unmeasurable trigger silently never fire.

### 3.4 The endpoints

**`GET /api/agent-adjudication-queue`** — the case file of contract §3.
Everything the T2 feed withholds, T3 gets: rationales, both sides, revision
history, dispute provenance, citation state. Three rules make this safe to add
next to the identifier-only feed:

- it is gated on the per-agent adjudicator grant **and** seat assignment (§3.6),
  neither of which a T2 identity has, so the rich feed is unreachable from the
  blind seat;
- it serves only cases in state `open` or later — a case cannot exist before its
  T2 verdict is final, so reading the feed can never contaminate a pending blind
  verdict;
- it **excludes the other seat's opinion** until the case is sealed.

**`POST /api/agent-adjudication-queue?action=claim`** — atomically takes a free
seat on a case the caller is eligible for, before any case content is served.
Rejects a caller already seated on the case's other seat, and a case whose seats
are both taken.

**`POST /api/agent-adjudication-opinions`** — one final opinion for the caller's
seat, echoing `caseId` + `targetVersion`. Rejects on: a version that moved
(invalidate the case), a seat already final, a caller whose `model_tier` is not
`flagship` at write time, a caller without the adjudicator grant or without a
claimed seat on the case, a value-endorsing resolution whose canonical fields are
missing or mixed in shape, and a `human` resolution without `humanReason`.

### 3.5 Convergence, decided in code

The backend compares the two sealed opinions on **typed fields only**.
Converged requires all of: equal `resolution`, equal normalised `scope_key`,
and — where both opinions endorse a value — equality of the canonical fields
after converting both to the parameter's canonical unit.

Convert with `convertParameterValue` (`src/lib/parameterUnits.ts`), passing the
target parameter and the drug's molecular weight, **not** `unitConversion.ts`
directly: that module covers concentrations and dose masses only, so a clearance
pair such as `60 L/h` and `1 L/min` — the same value — would fail to convert
and be read as divergence. Two units in different families
(`src/lib/unitFamilies.ts`) are not a conversion failure but a genuine
disagreement about what was measured, and are recorded as divergence with that
reason rather than as an error.

Where neither opinion endorses a value (both `abstain`, both `human`), the
comparison is resolution plus scope alone, and any `human` sends the case to T4
regardless.

Never compare `proposition` or `reasoning_md`. They are prose, so two opinions
endorsing different numbers can share a resolution label and a scope, and two
endorsing the same number can state it in different units; a comparison over
free text would call the first convergence and the second divergence. That is a
unit/conversion correctness question on calculation-driving data, which the
review policy's escalation rule puts at P1 by itself.

Label agreement across different `scope_key`s is **divergence**, which is the
case the contract calls out explicitly (two `approve`s about different
populations).

Anything else, plus any `human_required = true`, plus any case whose
`dispute_origin` is `human` or `mixed`, routes to T4.

### 3.6 Authority, separate from capability

**The adjudication grant cannot be a capability-matrix entry.** The matrix in
`src/lib/permissions.ts` stores one minimum *tier* per capability and is
deliberately monotone — granting a capability to contributors grants it to
editors and admins too, and there is no per-identity grant anywhere in it. Both
settings are therefore wrong: at `admin` the T3 identity's backing user would
have to be an admin, inheriting `dispute.resolve` and the whole admin surface,
which is exactly the authority separation the contract forbids collapsing; at
`contributor` every contributor — the blind T2 identity included — could read
the rich case file, destroying T2's blindness. This was a real defect in the
first draft of this plan, not a wording problem.

The grant is instead a **server-owned per-agent property**, the shape this
repository already uses for a privilege the role ladder cannot express:
`agents.self_review_enabled`. Add `agents.adjudicator` (boolean, default false,
set only through the admin agents endpoint, never by the agent itself), and
enforce at both endpoints: caller is an active agent **and** `adjudicator` is
true **and** `model_tier` is `flagship` **and** the agent holds a seat on the
case it is reading or writing. Seat assignment is the finest-grained check of
the four and does most of the work — an adjudicator identity cannot read a case
it was not seated on.

Being flagship grants nothing on its own. `dispute.resolve` is untouched by this
plan, and no capability in the matrix changes.

Panel family diversity is **recorded, not enforced**: add a server-owned
`agents.model_family` (nullable, same provisioning path as `model_tier`), derive
`panel_family_diversity` at seal time, and surface it on the case. Two panelists
from one family is a weaker panel and the audit should be able to see it;
blocking on it would strand cases whenever one family's identity is paused.

### 3.7 The T4 handoff

A case reaching `diverged` produces one moderator-facing record — target and
version, both T3 opinions in full, all lower-tier verdicts and rationales,
decisive sources, and a one-paragraph statement of what remains disputed — plus
a `notifications` row to reviewers/editors, reusing the dispute fan-out. This is
the deliverable of the whole tier: **if the handoff is poor, T3 has moved work
rather than resolved it.**

---

## 4. Work breakdown

| # | Step | Depends on | Rough size |
| --- | --- | --- | --- |
| 1 | Migration + schema + append-only stores | — | S |
| 2 | Detector (verdict-time + sweep) with lower-bound labelling | 1 | M |
| 3 | `agents.adjudicator` + `model_family` provisioning path, seats table and atomic claim | 1 | S–M |
| 4 | Case feed endpoint | 1–3 | M |
| 5 | Opinion write path, sealing, version invalidation | 1–4 | M |
| 6 | Convergence comparison + T4 handoff + notification | 5 | M |
| 7 | Lift the "do not schedule" banner; update §7 prerequisites, `drug-db-escalation.md` "Not yet available", and `adding-a-new-agent.md` | 6 | S |

Steps 1–3 are independently useful: the detector alone tells you **how many T3
cases actually exist**, which is the number that decides whether steps 4–7 are
worth building at all. Recommended sequencing is to ship 1–3, read the case
count for a few weeks of live T1/T2 operation, then commit to the rest.

## 5. Tests

- **Detector**: each of the five triggers fires on its own fixture and on
  nothing else; no case opens before the T2 verdict is final; a moved version
  invalidates rather than migrates.
- **Blindness**: an identity without the adjudicator grant gets 403 on the case feed;
  seat A cannot read seat B's opinion before seal, asserted directly against the
  serialized response body rather than the store.
- **Append-only**: no code path updates or deletes an opinion — including to
  record supersession; a changed mind appends a row carrying
  `supersedes_opinion_id`, and that insert **succeeds** (mirror the governance
  store's conformance tests). Two concurrent appends on one seat cannot share a
  `revision_no`.
- **Seating**: the case file is refused before a seat is claimed; a claim is
  atomic under two adjudicators racing; one identity cannot hold both seats.
- **No re-opening**: a terminal case's target version never opens a second case,
  however many times the sweep re-evaluates its standing triggers.
- **Snapshot immutability**: a T2 verifier that re-verdicts the same target after
  a case opened does not change what the case, the feed or the handoff shows.
- **Numeric convergence**: two opinions endorsing the same value in different
  units of the same family converge (including `L/h` vs `L/min`, which
  `unitConversion.ts` alone cannot do); two sharing a resolution and scope while
  endorsing different values diverge; two units from different families record
  divergence with that reason rather than erroring.
- **Valueless outcomes**: `abstain` and `human` are accepted on a numeric target
  with no canonical fields and reach T4; a value-endorsing resolution with a
  mixed scalar/range shape is rejected.
- **Tier snapshot**: re-tiering an agent after its opinion does not reclassify
  it — the same regression `verifier_tier` already has.
- **Convergence**: two `approve`s with different `scope_key` diverge; identical
  resolutions converge; any `human_required` routes to T4.
- **Authority**: an agent without `adjudicator`, without a flagship tier, or
  without a seat on the case gets 403 on both endpoints; no path in this feature
  calls `dispute.resolve`; no capability in `src/lib/permissions.ts` changes; a
  case with `dispute_origin = 'human'` always routes to T4.
- **Untrusted content**: a case file carrying instruction-shaped text in a
  rationale is served as data (integration fixture, mirroring the existing
  untrusted-content tests).

## 6. Open questions

1. Is two correction/return/dispute cycles the right threshold for trigger 4,
   given the count is a lower bound until durable history exists? (Spec open
   question, unchanged.)
2. Should `panel_family_diversity = 'same'` downgrade a converged case to a
   recommendation-with-caveat rather than a plain recommendation?
3. Does the T4 handoff belong in the existing moderator view
   (`docs/plans/2026-08-26-moderator-view.md`) or as its own surface?
4. When governance reaches `generic_authoritative` for these target types, is
   the port a data migration of these three tables, or do cases become first-class
   governance objects with their own kg tables?
5. Which second flagship family, at deployment time — and is one family with two
   distinct identities an acceptable interim panel?
