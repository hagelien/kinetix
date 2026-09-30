# Phase 14 - Packaging status and remaining extraction boundary

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 14, "Extract to a separate reusable repository").

**Status updated 2026-09-05.** The original version of this note was a pre-extraction readiness audit. The repository and core package now exist, Kinetix consumes the package, and several additional reusable review primitives have moved there. This document records the current boundary rather than the historical preconditions.

For current sequencing after Phase 14, use `docs/plans/2026-09-05-assurance-transition-continuation.md`.

---

## 1. What is already extracted

### `assurance-core` - done and consumed

The canonical reusable repository is:

```text
hagelien/assurance-core
```

The npm package is:

```text
assurance-core
```

Current package version at this update: `0.3.0`.

Kinetix already declares and installs the package. The duplicate pure-core implementation that originally remained in Kinetix after the repository was first created has been removed.

The reusable surface is now larger than the seven Phase-1 modules described by the original readiness audit. It includes:

- actor, risk, assurance, requirement, policy and decision primitives;
- immutable proposal/version references;
- the sealed review-packet contract;
- generic review-queue selection;
- the `AssuranceStore` persistence port;
- `MemoryAssuranceStore`;
- the executable store-conformance suite.

The package still has zero runtime dependencies and no database/framework dependency. Kinetix's packaging tests check the artifact it actually installs, while `assurance-core`'s own purity suite checks its source.

### Second-host evidence - stronger than the original Phase 13 fixture

`assurance-core` now contains a complete ADR host under `examples/adr-host/`, with its own data model and a separately implemented store adapter. That adapter is exercised through the package conformance suite.

This remains one additional domain, not proof of universal generality, but it is stronger evidence than the original Kinetix test fixture because the host supplies its own storage implementation rather than only adapters and policy definitions around Kinetix's infrastructure.

---

## 2. What remains in Kinetix, and why

### Kinetix host policy and projection - stays

`src/lib/assurance/` contains Kinetix policy and the projection from a generic `AssuranceProfile` to Kinetix's reader-facing verification representation. That is intentionally host-specific.

### Kinetix target adapters and apply logic - stays

The adapter layer may use Drizzle, Kinetix tables, scientific validation, and Kinetix mutation helpers. That is the point of the host boundary. A reusable package must not learn how to update a drug parameter, mutate TipTap content, or decide whether a scientific reference satisfies Kinetix policy.

### Migration/cutover compatibility machinery - stays while legacy exists

Mirroring, legacy links, reconciliation, migration state, force-legacy behavior, per-target cutover, and compatibility projections are still part of safely strangling the Kinetix legacy path. They are not automatically reusable just because the records they operate on are generic.

---

## 3. `postgres` - import-clean, but normalization is required before extraction

The original Phase 14 audit found one structural blocker: the governance store imported table definitions from Kinetix's monolithic `db/schema.ts`. That blocker is gone. `kg_*` definitions live in `db/governance-schema.ts`, no `kg_*` foreign key points at a Kinetix table, and the store import graph is clean.

That establishes **extractability of dependencies**, not yet **portability of semantics**.

Kinetix's current `AssuranceStore` implementation also decodes historical/compatibility shapes that exist because several Kinetix writers have touched the same `kg_*` columns. Examples include capability snapshots represented as:

```text
string[]
{ capabilities, assuranceCapabilities }
{ modelTier, isImplicit }
```

It also contains corruption recovery whose safety argument depends on Kinetix policy behavior. For example, preserving readable risk tags from a malformed profile is conservative because Kinetix uses those tags to add requirements rather than waive them.

Those rules are correct host-compatibility behavior and should not silently become the contract of a generic Postgres package.

### Required normalization before a Postgres package moves

1. Define one canonical representation for all new generic SQL writes.
2. Keep Kinetix legacy/backfill decoding at a host compatibility boundary.
3. Make the generic store consume canonical records and fail closed on records it cannot interpret without host knowledge.
4. Run the `assurance-core` conformance suite against that normalized SQL implementation.
5. Validate the same SQL implementation from a non-Kinetix Postgres host.
6. Only then move it to a sibling package in `hagelien/assurance-core`.

Until those steps are complete, status is **boundary-clean, semantically host-coupled** rather than "ready to copy".

---

## 4. `agent-sdk` - deliberately Kinetix-local for now

The Phase 12 client remains under `api/_lib/knowledge-governance/sdk/`. Its public method vocabulary is actor-neutral and it has no model-vendor dependency.

The earlier package sketch said this could become an `agent-sdk` package. That is an option, not a completion criterion. There is no value in publishing a package whose only consumer is still Kinetix simply to mirror an old directory diagram.

Extract it when a second real consumer needs the client and therefore tests whether the host bindings are actually generic.

Status: **API shape exists; package extraction deferred by design.**

---

## 5. `http` and `react-review` - still deferred

A generic HTTP API remains intentionally later than the in-process contract. Kinetix must not acquire a runtime dependency on a remote governance service as part of this migration.

Generic React review components remain optional and should be considered only after multiple hosts demonstrate a common presentation need.

Neither is a blocker for finishing Kinetix's governance migration.

---

## 6. Repository shape going forward

The repository decision is now settled: `hagelien/assurance-core` is the reusable governance home.

The **root `assurance-core` package remains dependency-free**. If storage or SDK reuse is later proved, additional packages may live beside it, for example:

```text
assurance-core repository
  packages/                 # only if/when multiple packages justify a workspace
    postgres/
    sdk/
    http/                    # optional, later
  src/                       # current dependency-free core, or moved mechanically if workspace migration is chosen
  examples/
```

The exact workspace layout is not an architectural requirement. The boundary is:

- do not add DB/HTTP/framework dependencies to the core package;
- do not move Kinetix-specific compatibility semantics into reusable packages;
- do not require Kinetix to call a remote governance service.

---

## 7. Current exit gate

| Phase 14 concern | Current status |
| --- | --- |
| reusable repository exists | **done** - `hagelien/assurance-core` |
| core package published | **done** - npm `assurance-core` |
| Kinetix consumes package | **done** |
| duplicate Kinetix core removed | **done** |
| core has zero runtime dependencies | **holds**, checked in both repositories |
| core exports no Kinetix/drug/pharma vocabulary | **holds**, checked |
| review packet / queue primitives reusable | **moved to core** |
| persistence port and conformance contract reusable | **moved to core** |
| non-Kinetix host exercises core | **done** - ADR host, with caveat that this is still one extra domain |
| generic Postgres implementation | **not yet extracted** - normalize host compatibility semantics first |
| generic SDK package | **deferred until a real second consumer** |
| generic HTTP package | **deferred** |
| generic React review package | **optional, deferred** |

---

## 8. What should happen next

Phase 14 is no longer blocked on repository creation, package naming, npm publication, or switching Kinetix onto the core. Those tasks are complete.

The useful remaining work is:

1. establish live migration/cutover status from the database and dossier tooling;
2. finish the low-risk served-queue/data-model transition after independent parity evidence;
3. normalize the SQL persistence boundary before considering a Postgres package extraction;
4. continue one-target-at-a-time authoritative cutovers;
5. extract SDK/storage siblings only when another host demonstrates real reuse.

See `2026-09-05-assurance-transition-continuation.md` for the operational sequence.

---

## 9. Historical note

The original readiness audit correctly identified the dependency boundaries before extraction. Its stale statements about repository creation, package naming, publication, and the still-local pure core have been replaced here rather than preserved as current instructions.

The architectural rule it was protecting remains unchanged:

> The reusable core owns domain-independent governance semantics. The host owns authentication, domain meaning, policy inputs, compatibility with its legacy data, and application of accepted changes.
