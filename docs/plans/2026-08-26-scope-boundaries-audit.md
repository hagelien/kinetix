# §23, §25, §28 scope boundaries — audit

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`.

Three sections of the plan describe the extraction's edges rather than its
work: what must not be built (§23), what must eventually exist (§25), and how
to tell the boundary has slipped (§28). None is a phase, so nothing in the plan
forces anyone to check them — which is exactly why a "do not build this"
decision expires quietly and a capability gets lost to a refactor.

Tests: `tests/governance/packaging/deferred-and-reusable.test.ts` and the §28
group in `tests/governance/packaging/boundaries.test.ts`.

---

## §23 — the deferred decisions stayed deferred

Eight things the plan says not to build. Each is a reasonable-sounding feature
that would be easy to add in passing, and each would change what the engine is.
Six leave a trace in code and are asserted; two are covered elsewhere.

| § | Deferred | How it is held |
|---|---|---|
| 23.1 | Hosted governance service | The §28 network guard: no import of an HTTP client, no `fetch(`, no URL anywhere in the governance layer. |
| 23.2 | Universal numeric trust score | No `trustScore`/`reputation`/`confidenceScore` export, **and** `AssuranceProfile` still carries its eight named dimensions. |
| 23.3 | Dynamic admin-editable policy language | No `kg_policies` table and no policy-store import; the host policy is not even on the core barrel. |
| 23.4 | Reputation scoring for actors | No `actorScore`/`reputationOf`/`scoreActor`. |
| 23.5 | Cryptographic signing of assessments | No `signature` field, no `createSign(`. |
| 23.6 | Generic UI framework | No React/TipTap import and no JSX in the layer. |
| 23.7 | Full event sourcing of host knowledge | No host-table event stream beside `kg_audit_events`. |
| 23.8 | Automatic policy learning from outcomes | No `updatePolicy`/`setPolicyRules`/`learnPolicy`, and no policy assigned from an awaited value. |

Two of these are worth more than a grep, and the tests say why:

**23.2 is not vacuously satisfied by the absence of a word.** One number is
easier to sort a review queue by, and that is the whole temptation — but "two
agents agreed and no human looked" and "one flagship model approved" cannot both
survive being collapsed onto a scale, and a gate reading the collapsed number
can no longer tell them apart. So the test asserts the plural thing still
exists: `EMPTY_ASSURANCE_PROFILE` carries `explicitApprovals`,
`independentApprovers`, `humanApprovals`, `agentApprovals`,
`approvalCapabilities`, `humanApprovalCapabilities`, `disputingAssessors` and
`disputesOpen` as separate fields.

Kinetix's own 0–3 `VerificationLevel` is not a counter-example. It is a host
*projection* of the profile, produced in `kinetix/projection.ts`, and the core
neither produces nor reads it.

**23.5 is a ban on a speculative field, not on cryptography.** A `signature`
column that nothing verifies is worse than no signature, because it looks like
a guarantee.

**23.8 is the sharpest of the eight.** An agent that can move the bar it is
judged against is not being governed.

Every "does not contain" assertion runs against comment-stripped source, and the
suite first asserts that the stripper keeps code — a stripper that emptied every
file would make all eight pass.

## §25 — every reusable capability is present

The plan lists fifteen things the reusable artifact must ultimately provide.
Asserted as a table binding each bullet to the export that provides it, so a
capability cannot be lost to a rename without a test naming it:

actor-neutral contracts (`snapshotActor`), target adapter registry
(`registerKnowledgeTargetAdapter`), immutable proposal versioning
(`appendVersion`), evidence attachment (`linkEvidence`), independent review
packets (`sealReviewPacket`), immutable assessments and supersession
(`reviseAssessment`), assurance profiles (`tallyAssurance`), dispute lifecycle
(`openDispute`), deterministic versioned policy evaluation (`policy`),
capability-aware requirements (`approvalWithCapability`), audit history
(`recordAuditEvent`), migration/reconciliation primitives (`findByLegacy`),
optional Postgres persistence (`ensureSpace`), optional agent SDK
(`governanceClient`).

**Fourteen of fifteen.** The missing one is the optional HTTP API, and its
absence is the plan being followed: §15.5 puts `api/governance-*.ts` under
"later" and adds that generic routes "should not replace current Kinetix routes
during initial migration". But an inventory that quietly omitted its one
missing item would be an inventory nobody could trust, so it has a test of its
own asserting no `api/governance-*.ts` exists. That test fails the day somebody
adds one, and the fix is to move the bullet into the table.

## §28 — the boundary has not slipped

§28 states the core boundary in one sentence and then gives three ways to know
it has been crossed. Two are statements about the import graph and are now
tested; the third is a property of the migration and lives elsewhere.

> If new core code starts importing pharmacology definitions, TipTap fact
> helpers, Kinetix citation tables, or Kinetix role names, the boundary has
> slipped in the wrong direction.

The imports half was already covered (`core` imports nothing outside itself).
The **role names** half was not, and needed care: the core's prose explains
Kinetix's rules and correctly says "admin" and "authenticated" in several
comments — a comment describing why the core does *not* read a role is the
opposite of a slip. So the test strips comments first and then looks for the
role as a string literal in code. A companion check does the same for
pharmacology vocabulary (`halfLife`, `drugId`, `wikiPage`, `pendingEdit`,
`citation`).

> If Kinetix begins requiring a remote governance service to stay online, the
> extraction has become operationally riskier than the system it replaced.

Asserted over the server layer as well as the core, since the core already
imports nothing at all and the layer that *can* reach out is the one this is
about: no HTTP-client import, no `fetch(` call, no URL, across all four
sub-packages.

> If a migration phase requires turning off the old path before the new path
> has been measured against it, the migration is moving too quickly.

A property of the migration rather than the import graph. It lives in the
fallback and rollback suites: `assurance/read-cutover.test.ts`,
`cutover/authoritative-publication.test.ts`, `rollback/rehearsal.test.ts`.

Both new guards were verified by injecting a violation — a `'editor'` literal
and a URL into a core module — and confirming each failed and named the file.
