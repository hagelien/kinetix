# Phase 13 - Validating the abstraction against a second domain

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 13, "Validate with a second non-pharmacology domain"), which the plan calls **mandatory before declaring the abstraction reusable**.

**Post-phase status updated 2026-09-05.** This document describes the original Kinetix-side abstraction probe. Since then, the core has been extracted to `hagelien/assurance-core`, and that repository now contains a stronger second-host test under `examples/adr-host/`: a complete ADR application with its own data model and a separately implemented store adapter run through `runStoreConformance`.

The original conclusions below remain useful as design evidence, but statements about what has or has not been extracted should be read historically. For current transition sequencing, use `docs/plans/2026-09-05-assurance-transition-continuation.md`.

The constraint is the whole test:

> The second domain should implement adapters and policy definitions rather than teaching the core its domain vocabulary. If a new domain needs a core switch case for its content type, the abstraction is still host-shaped.

---

## 1. The original domain probe

**Architecture Decision Records**, from the plan's own list of examples. It differs from pharmacology along every axis Phase 13 wanted to stress:

| Requirement | ADR shape |
| --- | --- |
| different target schema | a decision, context and consequences; no values, units or drugs |
| different evidence types | passing tests, benchmark runs, incident reports, superseded ADRs rather than citations |
| different risk rules | blast radius and reversibility rather than calculation consequence |
| human + agent contributions | both, with different standing |
| mixed publication bars | reversible/narrow decisions may pass with a lower bar; irreversible decisions need stronger human standing |

The original Kinetix probe lived under `tests/governance/second-domain/`. It was deliberately test code rather than a second product.

---

## 2. Original result: no domain-vocabulary core change was needed

The ADR domain could express its needs using the generic concepts already present:

- its own risk tags such as `irreversible` and `wide_blast_radius`;
- evidence kinds that were not scientific citations;
- capability-qualified human review rather than Kinetix's model-tier use case;
- a lower publication threshold for low-consequence decisions;
- sealed review packets and immutable proposal versions.

It also worked without a database, which was useful evidence that storage did not leak into the conceptual core.

The important result was not that ADRs fit perfectly. It was that the domain did not require `if (domain === 'adr')` inside the governance engine.

---

## 3. The four abstraction questions

### Does both Kinetix and domain 2 need the concept?

The shared concepts that survived were target references, proposal versions, assessments, assurance profiles, risk profiles, requirement primitives, policy evaluation and blind review packets.

Kinetix-specific projections stayed outside the core.

### If not, can it move back into the host?

Yes. Host binding, authentication, capability resolution, domain validation, evidence interpretation and mutation/application are host responsibilities.

### Does the generic name still make sense without pharmacology?

Names such as `AssuranceProfile`, `RiskProfile`, `ReviewPacket`, `PolicyDecision`, `independentApprovals` and `noOpenDisputes` remain natural in the ADR domain.

### Does the second domain require an extension point rather than a switch case?

The registry/policy model supported a different target vocabulary without adding domain-specific branches to the reusable core.

---

## 4. What the original exercise exposed

Two findings were especially useful.

### Hidden/history visibility is a real cross-domain seam

The ADR probe independently needed the same distinction Kinetix had reached for unrelated reasons: superseded or draft-like objects may need to stay out of an active review queue while remaining readable as history.

Two domains reaching the same seam is better evidence than naming the seam "generic" in advance.

### API ergonomics should be tested by outsiders, not inferred from names

The exercise found small contract friction simply by using the surface from another domain. That is the reason package extraction should follow actual consumption. A reusable API becomes credible when another host has to live with it.

---

## 5. Stronger evidence now present in `assurance-core`

The original Kinetix fixture was a useful probe, but it had two weaknesses:

1. it was written in the same repository as the system being extracted;
2. it did not independently implement the persistence port that later became part of the reusable package.

`assurance-core/examples/adr-host/` improves on both dimensions of the abstraction test:

- it has its own host model and identifiers;
- it implements `AssuranceStore` separately from `MemoryAssuranceStore`;
- the generic conformance suite is run against that adapter;
- differences the host cannot demonstrate are reported as skipped rather than silently passed;
- building the host has already forced changes to the reusable contract where the original assumptions did not fit.

That is exactly how a reusable boundary should evolve: a concept changes when a real second host loses meaning without the change.

This is still not broad ecosystem validation. One additional domain remains one data point.

---

## 6. What Phase 13 does and does not authorize

Phase 13 is evidence that the **core abstraction** is reusable enough to be maintained outside Kinetix. That extraction has happened.

It does **not** automatically prove that every generic-looking Kinetix layer should be moved too.

In particular:

- the Phase 12 SDK still needs a real second consumer before packaging adds value;
- Kinetix's current SQL adapter still contains legacy-shape and policy-specific compatibility semantics, so it must be normalized before becoming a generic Postgres package;
- Kinetix adapters, scientific evidence rules, actor/capability mapping and domain apply logic remain host code;
- HTTP and React packages remain optional/deferred.

A second-domain test is a filter on abstractions, not a license to export directories wholesale.

---

## 7. Current exit gate

| Phase 13 requirement | Evidence now |
| --- | --- |
| genuinely different second domain | ADR domain with different schema, evidence and risk vocabulary |
| no pharmacology vocabulary required in core | enforced by `assurance-core` purity tests |
| no domain switch case required | policy/registry abstractions survived |
| second host can use a different store | **now demonstrated** by `examples/adr-host/` |
| store semantics tested independently | **now demonstrated** by `runStoreConformance` against the ADR adapter |
| independent external-team adoption | **not established** |

The honest conclusion is therefore stronger than the original fixture but still bounded: the core has survived two host shapes and one independently implemented store adapter; expect the API to continue evolving before `1.0`.

---

## 8. Historical rollback note

The original Phase 13 fixture could be deleted without affecting production. That remains true of the historical Kinetix probe itself, but the reusable core now has its own second-host evidence in another repository. Removing the Kinetix fixture would no longer remove all second-domain coverage from the project as a whole.
