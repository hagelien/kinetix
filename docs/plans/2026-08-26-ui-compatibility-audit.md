# §20 UI compatibility — audit

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`.

§20 is three stages, and only the first is a requirement on the work done so
far:

> **Stage 1.** Current UI reads current endpoint shapes. Backend may derive them
> from legacy or generic state.

Stages 2 and 3 are offers — enrich the review UI *if useful*, extract generic
React components *only after the backend is stable*. Neither has been taken up,
and this documents why that is the right state rather than a gap.

Tests: `tests/governance/ui-compat/endpoint-shape.test.ts`.

---

## Stage 1 — asserted at the endpoint, not the service

`tests/governance/assurance/read-cutover.test.ts` already proved the assurance
*service* returns `{ level, disputed }` from either source. That is one layer
below the promise §20 makes, which is about what comes out of the HTTP response
the React app parses — and the two can diverge without anyone noticing: a key
ordering change, a number arriving as a string, one added field.

So the new suite drives `api/verification-levels.ts` end to end and compares the
**serialised body** under `legacy_only` and under `generic_read`, for both of
its modes (`?drugId=` and `?wikiPageId=`), with and without a dispute.

Byte comparison rather than `toEqual`, deliberately. `toEqual` passes on
reordered keys, and reordered keys are exactly what a rewritten derivation
produces. The React client does not care about key order — but a snapshot test,
a cached response or an ETag does, and "identical" should mean identical.

Three further assertions, each closing a way the comparison could pass while
proving nothing:

- **The generic path was actually taken.** Every equality case asserts
  `kg_read_fallback_total` stayed at zero. Without it, an unmirrored target
  falls back to the legacy calculation and produces a byte-identical body for
  the least interesting reason available.
- **The counter can move.** The unmirrored case asserts the body still matches
  *and* that the fallback counter is above zero — the inverse of every other
  case, which is what shows the zero-checks are load-bearing.
- **The body is not empty.** The first version of the `?wikiPageId=` test
  compared two empty level maps and called them identical: the fixture wrote a
  `wiki_revisions` row with a `factId` column set, but the endpoint resolves a
  factId by joining through the `pending_edits` row that produced the revision,
  so the query saw nothing. Every case now asserts the level map contains the
  entry it is about, with a level above zero.

One more case: the response is unchanged by
`KNOWLEDGE_GOVERNANCE_FORCE_LEGACY`. The lever exists for an incident, and a
reader refreshing a monograph mid-incident must not watch the badge change.

## The contract is closed, which is what makes stage 2 a decision

A test asserts the response has exactly one key, `levels`, and that each entry
has exactly `disputed` and `level`.

That is stage 1 stated as a guard rather than a hope. §20 stage 2 offers to
enrich the review UI with policy hold reasons, independent reviewer counts,
capability coverage and evidence status — all of which the generic layer can
already produce. The point of pinning the shape is that none of it arrives
until somebody decides to send it: an extra key added here reaches every
monograph sidebar in production the moment it deploys, and "we added a field,
the client ignores it" is how a read cutover stops being invisible.

## Stages 2 and 3 — not started

No front-end file imports anything from the governance layer, and none should
yet. §15.6 lists `src/lib/verificationLevel.ts`,
`src/lib/pendingEditsApi.ts` and `src/pages/ReviewPage.tsx` among the files the
migration will eventually reduce; all three are untouched, which §20 asks for
explicitly ("Do not require an early React rewrite").

Stage 3's condition — "only after the backend is stable" — is not met on the
plan's own terms: one edit type of thirteen is cut over, and §10's high-risk
gate has not been discharged.

---

## The harness fix this needed

The endpoint could not be driven at all before this pass, and the reason was a
blind spot worth naming.

`api/_lib/verification-levels.ts` reaches for `getNeonClient()` — the raw neon
tagged template — rather than the query builder, because its factId resolution
is a `DISTINCT ON` over a subquery that drizzle cannot express. Under the
integration harness `getDb()` returns the injected PGlite database and never
initialises `_sql`, so `getNeonClient()` returned null and the route died with
`sql is not a function`.

That silently excluded a specific and badly chosen set of routes from
end-to-end testing: the ones using raw SQL *because the query is doing
something the builder cannot do*, which is precisely where a test is worth
most. `api/agent-sweep.ts` and `api/admin.ts` are in the same set.

`getNeonClient()` now returns a shim when a test database is injected, active
only then and leaving the production path byte-identical. It hands the template
strings and values to drizzle's own `sql`, so parameter binding is drizzle's
rather than a hand-rolled `$1` counter that could bind the wrong argument and
pass a test against wrong SQL — `tests/integration/neon-client-shim.test.ts`
asserts a hostile string round-trips as a value and leaves `users` standing.

`.query()`, `.transaction()` and `.unsafe()` are **not** implemented. All three
exist on the real client and the first two are used in production routes, so the
shim carries them as functions that throw a message naming the limitation. An
absent method fails as `undefined is not a function` from three frames inside a
route, which is the same cryptic failure this shim exists to remove; a test that
reaches one now gets told what it hit.
