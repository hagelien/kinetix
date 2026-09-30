# Phase 5 — The shadow generic review queue

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 5, "Shadow generic review queue"), following Phases 0–4.

Phase 5's goal is to **prove the adapter-based generic queue selects and
hydrates the same work without agents depending on it**.

`api/agent-verifications-queue.ts` remains the served endpoint. Nothing in a
request path calls any of this.

---

## 1. Why this phase builds what Phase 2 refused to

Phase 2 explicitly declined to write a second queue, and said why: eligibility
would need its own copy of the candidate SQL, and two copies of an eligibility
rule is how one audience starts seeing rows the other thinks are hidden. It
built a reconciler instead, comparing hydration only.

Phase 5 is where the second selector is built **on purpose** — because the
comparison is the deliverable. An independent implementation that reaches the
same inclusion/exclusion decisions is evidence; one that shares the first
implementation's code is not.

---

## 2. The structural difference

The legacy queue answers *"who may review this?"* inside each per-type branch.
The author-exclusion predicate, the already-verified `NOT EXISTS`, and the age
cutoff are therefore written out five times. They agree today because somebody
keeps them in step by hand.

The generic queue inverts that. A target type supplies, through the new
`listQueueCandidates`, only what is genuinely domain knowledge:

- which rows of this type exist,
- when (its own ordering key — `updated_at` for `paper_review`, because that row
  is upserted in place on re-review),
- whose they are,
- and its own **visibility** rule, which the generic layer cannot derive: an
  unpublished wiki page, a moderated pending edit, a topic-page comment with no
  drug for the evaluator to hydrate.

Every rule that is the *same* for every type — author exclusion, self-review,
already-judged, minimum age — is applied once, in `filterEligible`. That is what
this phase is actually testing: not a faster query, but the same decisions
reached from one statement of the rules instead of five.

Adapters are explicitly forbidden from filtering on the caller, on age, or on
what has already been reviewed. An adapter that did would be the fifth copy of a
rule this phase exists to remove.

---

## 3. What was added

| File | Owns |
| --- | --- |
| `target-adapter.ts` | `QueueCandidate` and the optional `listQueueCandidates` |
| `adapters/kinetix/*` | one candidate query per served type, visibility rule included |
| `queue/generic-queue.ts` | `filterEligible`, `selectGenericBatch`, `selectGenericQueue` |
| `queue/compare.ts` | the differ and the five Phase 5 metrics |

`learning_unit_revision` has an adapter but no `listQueueCandidates`: it is
half-wired on purpose (Phase 0 doc §5.2), and a generic queue that served it
would diverge from the legacy one by *including* something.

---

## 4. Design decisions worth stating

**The reserves are re-derived, not imported.** `selectGenericBatch` is
structurally identical to the legacy `selectQueueBatch`, which is exported and
pure and could simply have been called. It is written out again because
importing it would make the ordering comparison trivially true, and a comparison
that cannot fail proves nothing. Ordering is explicitly *not* what the exit gate
is about — the plan allows a different prioritisation model later — but a
reserve implemented differently changes *which* rows are served at a small
limit, and that is an inclusion difference wearing an ordering disguise.

**Already-judged ignores implicit rows only under self-review.** A
self-reviewing agent has an implicit-approve row on everything it submitted,
written at submit time, so asking "has this agent a row for this target?" hides
exactly the work the grant exists to surface — the author filter comes off and
the row still never appears. The question the queue means is "has this agent
formed a *judgment* yet?". For an agent that does not self-review the two
readings coincide, since implicit rows are only ever written for the submitter
and the submitter is excluded by authorship anyway.

**Exclusion reasons are reported, and the first applicable one wins.** A
divergence report saying "the two disagreed" is not actionable; one saying "the
generic selector dropped this as `authored_by_caller`" is. Reporting the first
reason rather than all of them keeps the report saying *why* a candidate was
dropped rather than listing everything that would also have dropped it.

**A per-type failure drops that type, not the batch.** Same reason the legacy
queue is resilient: one unmigrated table must not be able to starve every other
type, most importantly `pending_edit` — the only one whose verification can
publish content.

**Packet comparison compares what each side would hand a reviewer.** The legacy
side is the payload the route actually served; the generic side is the adapter's
packet projected back into that shape. Re-reading the row for both sides would
compare the generic path to itself. Both are JSON round-tripped first, because
the legacy queue leaves `undefined` holes for inapplicable fields and `json()`
drops them — comparing before that normalisation would report a difference no
agent could observe.

**Nothing can leak at the selection stage.** A `QueueCandidate` has no payload
at all — identity, age, authorship, visibility. Hydration is a separate step and
goes through `sealReviewPacket`, which refuses to build a packet carrying a peer
signal. The shape is pinned by a test so a later field addition has to be a
deliberate act.

---

## 5. Exit gate

| Requirement | Evidence |
| --- | --- |
| no unexplained candidate eligibility divergences | both selectors run against the same database and the same actor, agreeing across all five served types — and **each preserved rule is checked on its own**: author exclusion, already-judged, the self-review grant, the implicit-vs-explicit subtlety inside it, minimum age, unpublished-page visibility, moderated-edit visibility, the drug-less comment, and the null-authored paper review |
| no reviewer-data leakage | a candidate's serialised form contains no verdict, dispute, rationale or approval, and its key set is asserted exactly |
| latency within acceptable budget | `kg_queue_latency_ms` recorded per comparison |
| existing agent queue remains the served endpoint | no route file modified by this phase |

The differ carries its own negative controls. One test records a verdict between
the legacy fetch and the generic selection and asserts the divergence is
reported with the reason `already_judged`; another moves a payload between the
two reads and asserts a packet mismatch. A comparison that cannot report a
divergence proves nothing when it reports none. The set comparison also asserts
five candidates were actually served before comparing, so agreement on an empty
batch cannot pass for agreement.

---

## 6. Rollback

Delete `api/_lib/knowledge-governance/queue/` and the `listQueueCandidates`
implementations. `QueueCandidate` and the optional interface method can stay
harmlessly or go with them. No route, no schema, no data is involved.
