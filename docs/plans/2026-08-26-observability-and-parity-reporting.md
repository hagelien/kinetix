# §17 — Observability and parity reporting

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
§17, which is not a phase but a cross-cutting requirement the phases assume.

§17 opens with the reason it exists:

> A strangler migration is unsafe if divergences are visible only after a user
> complains.

---

## 1. The problem this solves

Phases 4–6 each grew their own divergence shape: the reconciliation scanner's
`Divergence`, the queue differ's `legacyOnly` / `genericOnly` /
`packetMismatches`, the policy comparator's `PolicyDivergence`. Each is right
for its own comparison, and none of them is comparable to the others.

So "is this target type safe to advance?" could not be answered without reading
three reports in three vocabularies and reconciling them by hand — which is
exactly the kind of manual step that gets skipped on the day someone is in a
hurry.

`divergence.ts` is §17.1's single record they all normalise into.
`report.ts` is §17.3's operational report.

---

## 2. The critical list is separate from severity, on purpose

Severity is a judgment about one observation. §17.2 is a list of six *specific
failures*, named, that block cutover no matter how they were scored, how few
there are, or how confident the reporter was:

| Condition | Meaning |
| --- | --- |
| `generic_would_apply_legacy_holds` | the engine would publish something legacy holds |
| `generic_loses_open_dispute` | an open dispute is visible to legacy and not to generic |
| `generic_miscounts_implicit_approval` | a self or implicit approval counts toward the independent quorum |
| `generic_treats_non_flagship_as_flagship` | a mid or unclassified verifier satisfies the flagship requirement |
| `generic_assessment_on_stale_version` | an assessment is counted against a payload it did not judge |
| `generic_omits_required_human_expert` | a target needing a qualified human is publishable without one |

Deriving these from a `severity` field would mean a mis-scored observation
quietly stops blocking. Matching them by name means the block survives someone
deciding a particular case "looks like a warning" — and `divergence()` forces
any record naming one of the six to be `critical`, whatever the caller passed.

`blocksCutover` has no threshold. §17.2 says "immediately block", so one is
enough.

---

## 3. The queue directions are not symmetric

Worth stating because it is the least obvious classification here.

The generic queue **withholding** work legacy served is conservative: a reviewer
sees less, nothing publishes wrongly. That is a warning.

The generic queue **serving** work legacy withheld is critical. The legacy queue
withholds a row for a reason — the caller authored it, has already judged it, or
may not see it at all — so offering one is a candidate independence failure
rather than merely a difference.

---

## 4. Three ways the report refuses to look healthy

**An empty denominator is not success.** A mirror success rate of 1 over zero
attempts reads as "everything worked" and means "nothing ran". `successRate` is
`null` when nothing has been attempted.

**An uninstrumented metric is not zero.** This started as a real gap: §17.3
asks for a fallback count, and both fallback paths were silent, so the first
version of the report returned `null` and rendered "not instrumented" rather
than a `0` that would have claimed the system never fell back.

Both paths are now instrumented — `kg_read_fallback_total` and
`kg_publication_fallback_total`, counted **by reason**. "It fell back 40 times"
is not actionable; "40 times because nothing was mirrored" points straight at
the mirror. The two are separate counters because they answer different
questions: a read falling back means a badge served a legacy number, while a
publication falling back means the legacy gate decided. The first is a
data-coverage signal, the second is about who is in charge.

The labels are a fixed vocabulary rather than the free-text reason string, so
the counter has bounded cardinality.

**There is no summary score.** Every attempt to reduce ten signals to one loses
the distinction that matters: a system with perfect queue parity and one
permissive policy divergence is not 90% healthy, it is blocked. A test asserts
the report has no `score` or `health` field, because this is the kind of thing
that gets added later as a convenience.

**Metric names come from the registry**, not from string literals in the
report — a report reading a metric nobody publishes reports a confident zero,
which is the same failure as the empty denominator.

---

## 5. §17.3's ten items

| Item | Source | Status |
| --- | --- | --- |
| migration mode by target type | `kg_migration_state` | reported |
| mirror success rate | Phase 4 metrics | reported, `null` when nothing attempted |
| unresolved reconciliation items | Phase 4 scanner | reported, by kind |
| queue parity | Phase 5 differ | **absent by design** — see below |
| policy parity | shadow decisions | reported |
| generic-vs-legacy latency | Phase 5 timings | **absent by design** |
| fallback count | `kg_read_fallback_total`, `kg_publication_fallback_total` | reported, split and by reason |
| generic errors by service | mirror failure metrics | reported |
| force-legacy status | the kill switch | reported first |
| high-risk holds by reason | shadow holds, grouped | reported |

**Why queue parity and latency are absent:** the Phase 5 differ compares against
what the *live route actually served*, so it needs a request to compare.
Synthesising a number in a report nobody made a request for would report a
comparison that never happened. An operator runs the differ against real traffic
and reads its output; the report does not pretend to have done it for them.

---

## 6. Exit gate

| §17 requirement | Evidence |
| --- | --- |
| a structured divergence record | §17.1's shape, with all seven categories and three severities |
| every comparison normalises into it | reconciliation, policy and queue normalisers, each tested |
| the six critical conditions block | named, and `criticalReason` forces `critical` |
| one is enough to block | no threshold; asserted |
| a report surfacing §17.3's items | eight of ten reported, two absent with the reason stated |
| structured logging | `logDivergence`, severity-routed |

`tests/governance/observability/divergence-report.test.ts`, 24 tests.

---

## 7. §18 — performance constraints

Recorded here rather than in its own document because it shares the same
question: what can this harness honestly assert?

**Round trips can be asserted.** §18's headline concern is that the generic
architecture "must not turn one simple Kinetix write into a chain of excessive
database round trips", and a query count is the same number in PGlite as in
production — it is a property of the code, not of the machine. So the mirror
paths carry a round-trip budget, and the most important of the four cases is the
cheapest: a target type nobody has advanced pays two or three queries for the
machinery existing, and nothing else.

The budgets are deliberately generous ceilings rather than snapshots of today's
count. The point is to catch an N+1 or a per-row lookup creeping in; a ceiling
that tracks the implementation exactly is one nobody can change anything under.

**Wall-clock cannot.** §18 asks for p50/p95 against the Phase 0 baseline, and
the Phase 0 baseline says in its own header that PGlite is "not representative
of production timing". Producing a latency comparison here would put a number in
a report that means nothing. A test asserts that disclaimer is still in the
baseline file, so the reason stays attached to the omission.

**The structural rules are asserted:** adapters cached in-process, policy
evaluation free of database access, no network call inside the publication
transaction, and evidence carried as ids rather than hydrated content.

### A counter has to be proved to count

The first version of the round-trip counter hooked `session.execute` and
measured zero — Drizzle's builders construct a prepared query and call
`.execute()` on *that*. Every budget assertion passed, because zero is less than
twenty.

The `expect(queries).toBeGreaterThan(0)` beside each ceiling is what caught it,
and is the reason it is there: an upper bound alone is satisfied by an
instrument that measures nothing.

`tests/governance/performance/round-trips.test.ts`, 9 tests.

---

## 8. Rollback

Delete `divergence.ts`, `report.ts` and their tests, and
`tests/governance/performance/`. Nothing imports them; they read and report, and
write nothing.

The fallback counters are a separate, smaller revert: two `incrementMetric`
calls in `assurance-service.ts`, five in `publication.ts`, and two entries in
`MIRROR_METRICS`. They are in-process counters that no decision reads.
