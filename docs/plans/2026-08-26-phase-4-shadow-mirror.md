# Phase 4 — Shadow mirroring, the control plane, and reconciliation

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 4, "Shadow mirror proposals and assessments"), following the Phase 0
freeze, the Phase 1 core, the Phase 2 adapters and the Phase 3 schema.

Phase 4's goal is to **begin accumulating correct append-only generic history
while Kinetix remains fully legacy-authoritative**. It is the first phase whose
code runs inside a live Kinetix request — strictly after the legacy write,
strictly observational, and inert until a target type is explicitly advanced.

---

## 1. The rule that outranks everything else

> §12.1.4 / §12.4 — **Mirror failures do not reject successful Kinetix actions
> during this phase.**

Every exported mirror entry point is wrapped in `attemptMirror`, which cannot
throw and cannot reject. A generic-schema bug in this phase must not be able to
take down contribution or moderation; that is the property that makes it safe
to run new persistence code against live traffic at all.

A failed mirror is not swallowed silently. It becomes a structured repair item
in `kg_audit_events`, a log line if even that write fails, and a counter — and
the reconciliation scanner finds it later from legacy state.

---

## 2. What was added

| File | Owns |
| --- | --- |
| `drizzle/0115_…_migration_state.sql` | `kg_migration_state` (§11.1) |
| `migration-state.ts` | the six modes, per-target resolution, the kill switch, audited transitions |
| `mirror.ts` | the shadow mirror service (work items 1–6) |
| `metrics.ts` | the six counters from Phase 4's observability list |
| `reconciliation.ts` | the scanner and all six §12.2 divergence classes |

### 2.1 Hooks at the legacy seams

Three, each `fireAndForgetMirror(...)` after the legacy write has completed:

| Seam | Mirrors |
| --- | --- |
| `api/pending-edits.ts`, after the insert and the implicit-approve row | proposal + version |
| `api/agent-verifications.ts`, after `recordVerification` | a version-bound assessment |
| `api/agent-verifications.ts`, after a successful `applyOnAgentConsensus` | the publication outcome |

None is awaited, so none adds latency to a response. All three return
immediately unless the target type has been advanced past `legacy_only`, and
nothing ships advanced — so **on a fresh deploy these hooks do nothing at all**.

---

## 3. Design decisions worth stating

**A missing `kg_migration_state` row means `legacy_only`.** So does an
unreadable one. If the lookup throws — the table is not migrated in this
environment, the connection is down — the answer is the conservative mode, not
an error and not a permissive default. A governance layer that participated
*because* it could not read its own configuration would be the exact inversion
of §1.6.

**The kill switch is never cached, and anything but an explicit off value
counts as on.** `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY` is read from the
environment on every call: an emergency lever must not be up to ten seconds
late. And during an incident, `=yes` must not be silently ignored because it
was not spelled `1`. A typo that fails toward legacy costs nothing.

**The mode itself is cached for ten seconds.** It is consulted on every
mirrored write, and a round trip per write would put the generic path in the
latency budget of a request it is not allowed to affect. Ten seconds is short
enough that an operator rolling a target back sees it take effect while they
are still watching.

**A high-consequence target cannot jump from `legacy_only` to
`generic_authoritative`.** Every intermediate mode exists to produce the parity
evidence that justifies the next one; skipping them means advancing on none
(§11.4). Moving *backward* is always allowed from any mode to any safer one — a
rollback that had to satisfy a gate would not be a rollback.

**Assessments are bound to the proposal version, never to the target.** That is
§8.3: an assessment names the payload it judged, so a later revision cannot
inherit it. There is deliberately no fallback to the target when no version
could be mirrored — the fallback would quietly reproduce the version-blind
model the generic schema exists to replace. No version, no assessment, and the
scanner reports the gap.

**The tier is read off the verdict row, not from the caller.**
`recordVerification` stamps `verifier_tier` inside the write, under a
`FOR UPDATE` lock on the agents row, precisely so a concurrent downgrade cannot
leave a stale `flagship`. A tier the hook resolved separately would be that same
stale read, reintroduced one layer up.

**Mirroring is idempotent, and a new version is appended only when the
fingerprint actually changed.** This is what makes the hooks safe to call on
every write — including `recordVerification`'s upsert path, where "was this an
insert?" is only best-effort knowable — and what lets the scanner re-run a
mirror as a repair.

**Registration stays an explicit call.** Phase 2's rule was that importing an
adapter for its type must not mutate the registry, so `mirror.ts` and
`reconciliation.ts` call `registerKinetixAdapters()` themselves rather than
relying on an import side effect or a start-up hook the serverless model does
not really have.

**Counters are the weak record; the audit row is the durable one.** Kinetix runs
on serverless functions with no metrics agent and no long-lived process to
scrape, so a counter survives only as long as one warm instance. The exit gate
is therefore evaluated from the *database* — what the scanner finds — and the
counters are for the log line that tells an operator whether mirroring is
running right now.

**A publication outcome moves the projection as well as recording the event.**
Recording the event alone would leave every applied edit permanently reported
as a `state_mismatch` — the projection saying `pending` forever while legacy
said `approved` — and the exit gate could then never be met.

---

## 4. A modelling question this phase had to settle

Kinetix's pending-edit payload **includes the row's moderation status**, and the
legacy stale-verdict token folds it in (`${submittedAt}|${status}`) precisely so
that any status transition invalidates a verdict an agent queued earlier. That
is correct and this phase preserves it.

The consequence is that approving an edit necessarily changes its payload
fingerprint. Taken naively, the scanner's `fingerprint_mismatch` class would
then mark **every applied edit permanently divergent**, and
"unexplained mirror loss = 0 after reconciliation" would be unreachable.

The resolution is not to loosen the fingerprint. It is that the class only
applies to proposals that are still **open**. It exists to catch a silently lost
mirror of something *still under review* — the row is linked, the projection
looks fine, but what a reviewer would be handed today is not what the newest
mirrored version says. Once a proposal is closed, the mirrored version is a
historical record of what was reviewed, not a stale copy of a live row, and
comparing the two is a category error. Both halves are pinned by tests (`4.` and
`4b.` in `reconciliation.test.ts`).

---

## 5. Exit gate

The plan's gate is an *observation-period* gate — "at least 7 days and at least
500 relevant events if volume permits" — so it cannot be closed by a commit. It
is closed by running with a target type in `shadow` and reading the scanner.
What this phase delivers is the machinery to evaluate it, and the guarantees
that make turning it on safe:

| Gate item | How it will be measured | Proven here |
| --- | --- | --- |
| unexplained mirror loss = 0 after reconciliation | `reconcile()` over production read-only data | all six divergence classes produced deliberately and detected; re-mirroring converges (`reconciliation.test.ts`) |
| payload fingerprint parity effectively 100% | the `fingerprint_mismatch` count | class implemented, scoped to open proposals, and its scoping justified |
| no Kinetix endpoint error-rate increase attributable to shadow code | production error rate | a mirror against a missing table still returns 201 with the verdict recorded (`shadow-mirror.test.ts`) |
| no measurable publication behaviour change | production behaviour | `legacy_only` writes no generic row and does not even count an attempt |

**Nothing is turned on by this commit.** `kg_migration_state` ships empty, no
migration writes to it, and §11.4 forbids automated deployment from advancing
it. Advancing a target is a deliberate, audited administrator action.

---

## 6. Rollback

Three levels, cheapest first:

1. **`KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1`** and redeploy. Every target reverts
   to `legacy_only` immediately, with no schema change and no code change.
2. **Roll the target back** in `kg_migration_state` to `legacy_only`. Runtime,
   audited, no deploy.
3. **Revert the commit.** The three hook call sites are the only production
   lines added; removing them leaves the rest unreferenced. The `kg_*` tables
   stay — old code ignores them.
