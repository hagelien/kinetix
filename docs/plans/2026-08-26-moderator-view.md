# §8.2 — The moderator/auditor read model

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
§8.2, which requires **two** read models. Only one has existed until now.

The reviewer's is `ReviewPacket`, sealed so it cannot carry a peer's judgment.
This is the other one, and its defining property is the exact inverse: a
moderator is supposed to see everything.

It also happens to contain exactly what §20 Stage 2 would surface in the review
UI — policy hold reasons, independent reviewer count, capability coverage,
evidence requirement status — which is why building it is the honest way to make
that enhancement possible without choosing, on someone's behalf, what the UI
should show.

---

## 1. §8.2's five sections

| §8.2 | Where it comes from |
| --- | --- |
| all assessments | every assessment on every version, superseded ones included |
| dispute rationales | each open dispute with its full ruling history |
| assurance summary | `genericAssuranceProfile`, reused rather than recomputed |
| policy requirement state | the recorded decision's stored breakdown |
| complete history | every version, and every publication event |

---

## 2. Why it is a separate module, not a flag

An `includePeerVerdicts: true` parameter on `buildReviewPacket` would put one
boolean between a reviewer and every other reviewer's verdict. The whole
anti-echo-chamber guarantee would then rest on every call site passing the right
value, forever, including call sites nobody has written yet.

Two functions in two modules cannot be confused by a default argument. The
reviewer path physically cannot produce this shape, and this path physically
cannot be reached from the queue.

---

## 3. The leak guard is deliberately not applied

`sealReviewPacket` refuses to seal a packet containing a verdict, a tally or a
quorum. That guard is **not** used here, and a test asserts both halves: the
moderator view contains a verdict and its rationale, and the same content is
refused on the reviewer path.

A moderator view that scrubbed verdicts would be useless for the job it exists
for — deciding whether the reviewers were right. Applying the mechanism past the
reason for it would be cargo-culting it.

The audience separation is therefore the caller's responsibility, and is stated
rather than assumed: this must only be served to an actor who may moderate.
Kinetix enforces that with `review.edit.decide` on the routes that would call
it.

---

## 4. Two decisions worth recording

**Superseded assessments are included, and are most of the value.** "This
reviewer disputed it in March and approved it in May" is a fact about the
review, and it is exactly what `agent_verifications` destroys by upserting.
`effectiveAssessments` is offered alongside for the "what counts now" question,
so a caller never has to filter the history itself and get it subtly wrong.

**Requirement state is read back, never re-evaluated.** Re-evaluating would show
a moderator what the policy says *now* against a decision made under what it
said *then* — and §7.4 exists precisely so those two cannot be confused. The
breakdown lives in JSONB columns kept off `PolicyDecisionRecord` deliberately:
every list read returns that record, and a queue rendering fifty decisions does
not want fifty breakdowns. The moderator view asks for one at a time.

**An unreviewed proposal returns empty sections, not `null`.** "No reviews yet"
is information a moderator wants; an absent view is not. `null` means only that
the proposal does not exist.

---

## 5. Exit gate

| §8.2 requirement | Evidence |
| --- | --- |
| a second, separate read model | its own module; the reviewer path cannot produce this shape |
| all assessments | superseded ones asserted present, with their rationales |
| dispute rationales | disputes returned with their ruling history |
| assurance summary | reused from the Phase 7 service, not recomputed |
| policy requirement state | unmet ids and the full breakdown, from the record |
| complete history | every version and publication event, across revisions |

`tests/governance/observability/moderator-view.test.ts`, 12 tests.

**What this does not do:** change any endpoint or any UI. §20 Stage 1 is the
requirement — the current UI reads current endpoint shapes — and Stage 2 is
qualified with "if useful". This makes Stage 2 possible; whether and how to
surface it is a product decision.

---

## 6. Rollback

Delete `moderator-view.ts` and its test, and `decisionRequirements` from the
decisions store. Nothing else imports them, and no route calls them.
