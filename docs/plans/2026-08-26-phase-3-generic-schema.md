# Phase 3 — Append-only generic schema and store

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 3, "Add append-only generic schema"), following the Phase 0 freeze, the
Phase 1 pure core and the Phase 2 adapter boundary.

Phase 3's goal is **durable generic records that are not authoritative**. The
`kg_*` tables can hold the entire governance history of a knowledge space, and
nothing in Kinetix's request path reads or writes them. Kinetix behaves
identically whether they are empty or full — that inertness is the phase's
safety property, and the rollback is to leave the tables in place.

---

## 1. What was added

### 1.1 The migration — `drizzle/0114_knowledge_governance_schema.sql`

Thirteen tables from §5, plus their indexes. Additive only: every statement is a
`CREATE`, every created object is named `kg_*`, and every foreign key points at
another `kg_*` table. No trigger, no `ALTER`, nothing that changes an existing
column's meaning.

| Table | §  | Holds |
| --- | --- | --- |
| `kg_spaces` | 5.1 | one governed knowledge collection and its active policy version |
| `kg_targets` | 5.2 | a stable generic handle on a host-domain object |
| `kg_proposals` | 5.3 | the identity of a proposed mutation across revisions (a projection) |
| `kg_proposal_versions` | 5.4 | the immutable snapshot reviewers judge |
| `kg_evidence_items` | 5.5 | a reusable evidence object, independent of `citations` |
| `kg_evidence_links` | 5.6 | evidence attached to a version, assessment, dispute or decision |
| `kg_assessments` | 5.7 | immutable reviewer judgments |
| `kg_disputes` | 5.8 | dispute identity (a projection) |
| `kg_dispute_rulings` | 5.9 | append-only ruling history |
| `kg_policy_decisions` | 5.10 | why the engine held or allowed, and under which policy version |
| `kg_publication_events` | 5.11 | what ultimately happened to a version |
| `kg_audit_events` | 5.12 | append-only operational audit |
| `kg_legacy_links` | 5.13 | the explicit generic ⇄ Kinetix mapping |

### 1.2 The store — `api/_lib/knowledge-governance/store/`

| File | Owns |
| --- | --- |
| `interface.ts` | record types, `GovernanceDb`, and the `LegacyProvenance` stamp |
| `spaces.ts` | `kg_spaces` + `kg_targets` — idempotent identity |
| `proposals.ts` | `kg_proposals`, including the projection repair path |
| `versions.ts` | `kg_proposal_versions` — append only |
| `assessments.ts` | `kg_assessments`, supersession, and "current effective" |
| `disputes.ts` | `kg_disputes` + `kg_dispute_rulings` |
| `decisions.ts` | `kg_policy_decisions` + `kg_publication_events` |
| `evidence.ts` | `kg_evidence_items` + `kg_evidence_links` |
| `audit.ts` | `kg_audit_events` |
| `legacy-links.ts` | `kg_legacy_links` |
| `postgres.ts` | the composed `governanceStore` facade |

`evidence.ts` is not in the plan's Phase 3 file list, which names eight modules
and no evidence one — but §5.5 and §5.6 are two of the thirteen tables, and
leaving them without a store would mean the only way to write evidence is raw
SQL at a call site.

### 1.3 The backfill — `api/_lib/knowledge-governance/backfill.ts`

Three operations, and nothing that walks the database: `ensureKinetixSpace`,
`ensureKinetixTarget` (on demand, per row), and `snapshotLegacyVerifications`
(one target at a time).

---

## 2. Design decisions worth stating

**Actors are references, not foreign keys.** `actor_ref` is a string like
`user:42`, not `INTEGER REFERENCES users(id)`. Three reasons, each sufficient:
the core owns no authentication (§4.2); a governed space may be reviewed by
actors that are not Kinetix users at all; and an immutable judgment must survive
the deletion of the account that made it. A FK into `users` would let a Kinetix
cascade delete governance history.

**Append-only is enforced by absence.** There is no `updateAssessment`, no
`deleteVersion`, no `editRuling` anywhere in the store. A caller that wants to
rewrite a judgment has to reach past this layer to do it, which is visible in a
diff. The only writes to existing rows are the two documented projections
(`kg_proposals.state`/`current_version_id`, `kg_disputes.state`/`closed_at`) and
`kg_proposal_versions.submitted_at`, which records when a draft entered review
and is not part of what a reviewer judges.

**A change of mind is an insert.** `agent_verifications` upserts on
`(agent_id, target_type, target_id)`, so a reviewer that revises destroys the
judgment it previously published — and an audit cannot then answer "what did
this reviewer say before?". Here the new row's `supersedes_assessment_id` names
the old one, both survive, and the current effective judgment for an actor is
its newest unsuperseded row.

**Capabilities are snapshotted at write time.** `capability_snapshot` is
written from what the caller resolved and never read live afterwards — the same
reason `agent_verifications.verifier_tier` exists (migration 0113). Reading a
live capability at tally time would let an agent later re-tiered to flagship
retroactively turn all of its past mid-tier approvals into flagship ones.
`model_metadata` — the self-reported model string — is stored separately and is
never a policy input (§2.3).

**`evaluation_mode` defaults to `shadow`.** A caller that forgets to say records
a decision that governs nothing rather than one that governs everything (§1.6).
It is also what makes "what would the new engine have done?" and "what actually
governed this?" two questions with two answers, which during the migration they
are.

**`recordCoreDecision` maps a held decision to `hold`, never `reject`.** An
unmet requirement means *not yet*. A policy engine that turned a missing second
approval into a rejection would discard work the author could still finish; a
caller that genuinely means `return` or `reject` says so explicitly.

**A withdrawn dispute closes; a superseded one does not.** A withdrawn dispute
is finished, and leaving it open would keep blocking publication on a complaint
nobody is making. `superseded` means another dispute took its place, and the
replacement is what governs.

**`closed_at` is derived from the state, not passed in.** The open-proposals and
open-disputes indexes are partial on `closed_at IS NULL`, so a caller that set
the two inconsistently would leave a decided proposal in the queue — invisible
until something served it. Re-opening clears it again for the same reason.

**Ids are `SERIAL`, not UUID.** The plan says "UUID/serial"; every other table
in this database is `SERIAL`, and the generic core addresses rows by string and
stringifies on the way in, so the choice stays a host decision.

**Evidence deduplicates on an external reference, and only then.** Mirroring the
same citation from ten proposals produces one item with ten links. An item with
no `external_ref` is always inserted fresh: a free-text expert statement is not
the same statement just because it was filed twice.

**Legacy links refuse to re-point.** Linking is idempotent for an identical
link, so a backfill can be re-run — but relinking a generic record to a
different legacy row throws. The writer that tries it has a bug, and silently
rewriting the mapping is how that bug stays hidden.

---

## 3. The backfill tells the truth about what it imported

§6 forbids fabricating historical fidelity, and Kinetix genuinely cannot supply
it: `agent_verifications` upserts, so when an agent changed its verdict the
earlier judgment was overwritten and is gone. There is no sequence to import,
only a final state.

So every imported assessment carries

```json
{ "origin": "legacy_snapshot",
  "capturedAt": "…",
  "historicalCompleteness": "current_state_only",
  "legacyType": "agent_verification",
  "legacyId": 1234 }
```

and imported rows never claim a supersession chain. Inferring that "this
approval replaced an earlier dispute" from a row that no longer exists would be
inventing exactly the history the append-only model was built to stop guessing
at (§6.4). `created_at` *is* carried over — when a verdict was cast is a fact
Kinetix still has; what came before it is not.

Implicit rows are imported too, and marked `isImplicit` in the snapshot. They
are not peer review — the API writes one when an agent submits its own work —
but they exist in the legacy state, and dropping them would make the snapshot
disagree with what Kinetix's own tally sees.

---

## 4. Exit gate

| Plan requirement | Evidence |
| --- | --- |
| migration applies on a production-like database | the PGlite harness replays the whole committed chain per test file; every governance and integration suite now runs against it (68 → 72 files) |
| old Kinetix build works against the expanded schema | `backfill.test.ts` fetches the live verification queue with the `kg_*` tables empty, populates them, fetches again, and asserts the two responses are deep-equal |
| new tables can be empty without affecting Kinetix | same test — and no production file references the store |
| backfill is idempotent | `backfill.test.ts` runs it twice and compares row counts across all five tables it can touch, asserting `imported: 0` and no new audit row on the second run |
| migration tests verify no destructive statements | `migration-additive.test.ts` reads the SQL: no `DROP`/`TRUNCATE`/`DELETE`/`UPDATE`/`ALTER COLUMN`/`RENAME`/`CREATE TRIGGER`, every statement a `CREATE`, every object `kg_*`, every foreign key `kg_*` |

Plus one guard the plan does not ask for. The migration and `db/schema.ts` were
written by hand, twice, from the same spec — the situation where they drift
silently, typecheck perfectly, and fail on the first insert in production. So
`schema-drift.test.ts` compares every Drizzle `kg_*` definition against
`information_schema` in a real Postgres: same column names, same nullability.

---

## 5. Rollback

Old code ignores the tables, so leave them in place. If they must go, the
generic schema has no dependents: dropping the thirteen `kg_*` tables and
deleting `api/_lib/knowledge-governance/store/` and `backfill.ts` removes the
phase entirely. No Kinetix table changed, so there is nothing to restore.
