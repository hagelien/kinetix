# §19 security and integrity — audit

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`.

§19 is four requirements about who is allowed to assert what. Three of them
were already satisfied by the way earlier phases were built; the fourth was not,
and closing it is a code change rather than a test.

Tests: `tests/governance/security/server-owned-facts.test.ts`.

---

## 19.1 Server-owned actor facts

> Never trust request body fields for: actor kind; user role; agent active
> status; self-review grant; verifier capability tier; human-expert
> designation. Resolve these server-side and snapshot the values that
> influenced a decision.

### The HTTP surface

`createAgentVerificationSchema` is `.strict()`, so a body carrying any of the
six is a 400 rather than a silently-ignored field. That distinction is worth
keeping: a caller that gets a 201 back has no way to know its claim was
dropped, and an ignored field is one refactor away from being read. The suite
sends eight such claims — `verifierTier`, `modelTier`, `actorKind`, `role`,
`agentId`, `selfReviewEnabled`, `assuranceCapabilities`, `clinicalExpert` — and
asserts a 400 with nothing written for each.

The field these sit next to is `model`, which *is* accepted. It is
self-reported audit metadata (§2.3) and no gate reads it; the tier that gates
is snapshotted server-side from `agents.model_tier` under a `FOR UPDATE` lock
inside the verdict write. A test posts a boastful `model` string from a
mid-tier agent and asserts the recorded `verifier_tier` is `mid`.

### The projection

`actorContextFrom` has no parameter for assurance standing. `kind` is `agent`
because an active `agents` row exists, and reverts to `human` when the row is
revoked — asserted in all three states. The self-review grant is recorded as
metadata rather than promoted to a capability, because it *enlarges the
reviewer pool* and so raises the quorum; calling it a capability would
misrepresent which direction it cuts.

### The gap that was open: the SDK

`assessments.submit` took a whole `ActorContext` from its caller and snapshotted
its `assuranceCapabilities` verbatim. Nothing in production routed HTTP through
it, so nothing was exploitable today — but §12 makes the SDK the *public
integration surface*, and its whole point is that someone outside this
repository will call it. An integrator could have handed it
`assuranceCapabilities: ['model_tier:flagship']` and cleared the high-risk gate
by assertion, or `['clinical_expert']` and cleared the clinical sign-off rule.

Fixed by making standing a host-resolved fact:

- `GovernanceClientOptions.resolveAssuranceCapabilities?: (actor) =>
  Promise<readonly string[]>`. The client never reads
  `actor.assuranceCapabilities`.
- Omitting the resolver is **safe, not permissive**: the assessment snapshots an
  empty assurance list and satisfies no capability requirement. Falling back to
  the caller's list when unconfigured would have made the secure path the one
  you opt into.
- Action `capabilities` still pass through from the caller. They are
  descriptive — they record what the actor could do — and no gate reads them.
  Only the half that gates is host-resolved.
- Kinetix's answer is `resolveAssuranceCapabilities(actorRef)` in
  `actor-context.ts`, which delegates to `resolveActorContext` rather than
  re-deriving the tier and clinical rules, so the two paths cannot drift.
  Anything that is not a `user:<id>` ref — `system:`, `service:`, whatever a
  second domain invents — and any ref naming a deleted account resolves to no
  standing at all.

The suite asserts the attack directly: a mid-tier agent submitting through a
Kinetix-bound client while claiming flagship and `clinical_expert` is
snapshotted as `model_tier:mid` and nothing else. It also asserts the resolver
returns real standing for a real flagship agent, so the guard is not passing by
being blanket-empty.

## 19.2 Assessment capability snapshot

Already satisfied, in both stores:

- `agent_verifications.verifier_tier` is stamped inside the verdict write
  (migration 0113), under a lock on the agents row, so a concurrent downgrade
  cannot leave a stale `flagship` behind.
- `kg_assessments.capability_snapshot` is written once and never read live.

The behavioural half — that a downgrade after the fact does not lower a
recorded verdict, and an upgrade does not manufacture a flagship one — is
asserted in `tests/governance/concurrency/races.test.ts` scenario 4 and in
`tests/governance/cutover/high-risk-replay.test.ts`, and is not duplicated here.

## 19.3 Prompt/content boundaries remain host responsibility

> The SDK must not encourage direct database access.

The `db` option exists so a test, and a transaction-bound caller, can supply a
handle. What matters is that the client never gives one *back*: an integrator
who can reach the connection can write around every gate in this plan, and
eventually would. Asserted two ways — the returned object exposes six
namespaces plus a `space` string and nothing with `db`, `execute`, `session` or
`query` on it, and the source contains no `sql\`` template and no exported `db`.

Prompt boundaries themselves stay where the plan puts them: in the Kinetix
agent instructions, outside this migration.

## 19.4 Audit cannot be silently rewritten

Enforcement is by **absence**: there is no guard to bypass because there is no
code path. `kg_assessments`, `kg_policy_decisions`, `kg_dispute_rulings`,
`kg_publication_events` and `kg_audit_events` are never the subject of an
`.update()` or `.delete()` anywhere in the store, and a correction supersedes —
`reviseAssessment` inserts a row naming the one it replaces, which is an insert.

Two deliberate exceptions, both pinned narrowly rather than waved through:

- **`kg_proposal_versions` carries one update**, `markSubmitted`, and the test
  parses the `.set({…})` that follows it and asserts the assigned key list is
  exactly `['submittedAt']`. A blanket "no update" assertion would have to be
  deleted the moment anyone read the code; a blanket allowance would let a
  payload rewrite in beside it.
- **`kg_proposals` is updated freely**, and that is asserted *positively* so the
  guards above are not passing because the store never writes at all. It holds
  a current-version projection rebuilt from the version history: updating a
  derived value rewrites no history.
