# Phase 12 - The generic governance client

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 12, "Generic agent SDK and public integration surface").

**Post-phase status updated 2026-09-05.** The in-process client described here still exists in Kinetix. Since this phase landed, the pure governance core has been extracted and published as npm `assurance-core`, and the reusable repository has grown to include review packets, queue selection, the `AssuranceStore` port and store conformance. The Phase 12 client itself has **not** been published as a separate SDK package. That is now an intentional deferral, not unfinished core extraction.

For current sequencing, use `docs/plans/2026-09-05-assurance-transition-continuation.md`.

Everything through Phase 11 was Kinetix migrating onto generic internals. This phase added the first surface designed to be used by something that is *not* Kinetix: the API a second knowledge space, or a future SDK, would program against.

`api/_lib/knowledge-governance/sdk/client.ts`, and the namespaces are:

```ts
client.proposals.create / revise / submit / get
client.review.getBatch
client.assessments.submit / current
client.disputes.open / rule / listOpen / rulings
client.assurance.get
client.history.get / forLegacy
```

---

## 1. Actor-neutral is a testable claim, not a style preference

The plan requires the base API to use actor-neutral terminology, with agent-specific conveniences allowed on top. Nothing in this surface needs an LLM-specific identity: a reviewer is an `ActorContext`, and whether that actor is a model, a person or a scheduled service is the host's business.

This matters concretely. Kinetix's legacy queue selector takes Kinetix-specific actor binding information. A second domain adopting that signature directly would have to invent Kinetix concepts for its own reviewers, which is exactly the abstraction leak Phase 13 was meant to expose.

Host-shaped binding information therefore remains separate from the generic actor context. A second host supplies its own binding/resolution layer.

Tests walk the public method vocabulary and guard the actor-neutral surface because this property otherwise erodes one convenience method at a time.

## 2. The actor is per call, not per client

A queue fetch and an assessment can legitimately be for different actors within one request, for example a service fetching a batch on behalf of a reviewer. A client that held one implicit identity would either force multiple client instances or, worse, make the mix-up invisible.

The actor therefore stays explicit per call.

## 3. The review batch still withholds peer judgment

Blind review is a core invariant, not a Kinetix UI convention.

`getBatch` returns sealed `ReviewPacket`s. The reusable `sealReviewPacket` implementation now lives in `assurance-core` and refuses to seal a reviewer packet carrying another reviewer's verdict, the running tally, quorum, or equivalent derived peer-judgment state.

The SDK adds no route around that rule.

## 4. Revising is appending

`proposals.revise` appends a version; there is no convenience that edits a reviewed version in place.

That absence is structural enforcement. Assessments are version-bound, so changing payload means creating a new proposal version. Old assessments remain history and do not qualify the replacement version.

## 5. What this deliberately is not

### Not an HTTP surface

The original §10.3 decision still holds. A generic HTTP API should come only after the in-process contract has a real cross-project consumer and there is evidence that a common wire format is useful.

Kinetix must not gain a remote governance-service dependency merely to finish its migration.

### Not a published SDK package yet

Phase 14 published the **core** as `assurance-core`; it did not turn every generic-looking Kinetix module into a package.

The Phase 12 client remains under `api/_lib/knowledge-governance/sdk/`. Its no-vendor and actor-neutral boundaries are useful, but publishing it now would still produce a package whose only production host is Kinetix.

Current rule:

> Extract an SDK sibling from `hagelien/assurance-core` when a second real consumer needs this client and therefore tests which host bindings belong in the reusable surface.

Do not publish it simply to satisfy the directory sketch in the original Phase 14 plan.

### Not the persistence package

The SDK should consume a store/host integration boundary. It should not become the place that knows Drizzle, Neon, Kinetix legacy snapshots, or how a domain applies an accepted change.

### Not required for Kinetix cutover

Kinetix can finish low-risk and later high-risk governance cutovers through its existing route facade and the reusable core without first publishing a standalone SDK.

---

## 6. Phase 13 result

The original version of this document ended by asking whether the client/core concepts would survive a second domain. That test has now happened in two increasingly strong forms:

1. the Kinetix Phase 13 ADR fixture exercised an unrelated target/evidence/risk vocabulary without requiring Kinetix-shaped core changes;
2. `assurance-core` now carries a complete ADR host under `examples/adr-host/`, including its own storage adapter exercised through the package's executable conformance suite.

The result supports the core abstraction. It does **not** by itself prove that the whole Phase 12 client should be published unchanged. The second host is the reason to be more disciplined here, not less: reusable code should move because another host needs it, not because its file name says `sdk`.

---

## 7. Exit gate

| Requirement | Current evidence |
| --- | --- |
| generic namespaces exist | implemented and tested in Kinetix |
| base API uses actor-neutral terminology | guarded by tests |
| host-specific binding remains separate | implemented |
| review batch exposes no peer judgment | enforced by reusable `sealReviewPacket` plus SDK tests |
| revising creates a version rather than editing one | implemented/tested |
| assurance distinguishes missing records from an empty review state | implemented/tested |
| core concepts survive a second domain | strengthened by the standalone ADR host in `assurance-core` |
| SDK itself has a second real consumer | **not yet**; extraction remains deferred |

The final row is now the useful package-extraction trigger. It is not a blocker for Kinetix governance migration.

---

## 8. Next action for this layer

Leave the client in Kinetix while the queue/data-model and per-target cutovers continue.

When another project wants the client:

1. implement that consumer against the current in-process surface;
2. identify which bindings are genuinely host-specific;
3. move only the surviving generic client into a sibling package in `hagelien/assurance-core`;
4. keep authentication, actor resolution and domain apply logic injected by the host;
5. version and consume the package normally; do not fetch an unversioned branch.

Until then, changes here should optimize correctness and host neutrality, not packaging completeness.

---

## 9. Rollback/history note

This file records the Phase 12 contract and its later packaging decision. The old advice to delete `sdk/` as a simple rollback is historical: later governance code may now depend on surrounding shared contracts. Any actual removal should be based on current import/use analysis rather than this phase-era rollback note.
