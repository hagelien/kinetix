# §26 - The definition of done, as an audit

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md` §26, which lists the criteria for calling the migration complete.

**Status guidance updated 2026-09-05.** The original version of this note included a static count of criteria and said that nothing had been advanced. That was a snapshot of one development database at one point in the migration. It is not a safe source for current operational state, because migration modes, reconciliation coverage and authoritative cutovers live in the database.

Use the executable report for current status. Use this document to understand how to interpret it.

For current sequencing, see `docs/plans/2026-09-05-assurance-transition-continuation.md`.

---

## 1. Four statuses

| Status | Meaning |
| --- | --- |
| `holds` | checked, and true |
| `fails` | checked, and false |
| `not_yet` | legitimately unreachable at the state being inspected |
| `attestation_required` | true or false as a fact about the deployed product/world, not something this code can establish |

### `attestation_required`

Some claims cannot be promoted to truth by a green test suite. For example, "Kinetix public and authenticated functionality works as before" is a product fact, not merely a unit-test fact.

Those criteria must remain explicit human attestations. An audit that marks them `holds` because nothing contradicted them would be manufacturing assurance.

### `not_yet`

`not_yet` is a statement about the inspected migration state, not a permanent failure.

A criterion such as an exercised per-target rollback cannot hold in an environment where no target has yet reached the relevant stage. In another environment, or later in the same one, the same criterion may hold.

This is exactly why a dated prose count must not replace the executable report.

---

## 2. Repository facts versus runtime facts

The definition of done mixes two different kinds of evidence.

### Repository/package facts

These can be checked from the code and package graph, for example:

- Kinetix consumes the reusable `assurance-core` package;
- the duplicate pure core has been removed;
- the package has no runtime dependency tree;
- the core contains no pharmacology/Kinetix vocabulary;
- blind review packet construction is enforced in the reusable package;
- store conformance exists;
- a second ADR host exercises the core and a separate store adapter.

These claims can be stable across environments.

### Runtime/migration facts

These must be read from the target database/observability state, for example:

- which target types are in `generic_read` or `generic_authoritative`;
- whether `pending_edit:wiki_fact` has actually been advanced;
- how many rows reconciliation examined;
- whether the scan completed;
- whether any divergences remain;
- whether a rollback drill occurred in the intended environment;
- whether the observation window was clean.

GitHub cannot establish these merely by seeing the cutover code on `main`.

---

## 3. What the audit must refuse

### An empty scan is not a clean scan

Zero divergences over zero examined rows and zero divergences over five hundred examined rows are numerically similar and evidentially different.

A clean-state criterion must therefore include both:

- divergence count/state; and
- evidence that the relevant population was actually examined and the scan completed.

### An incomplete scan is not a clean scan

A paginated reconciliation that stopped early may have no findings in the pages it saw. That is not evidence about the pages it did not see.

Completion must be explicit.

### Attestation cannot override a checked failure

Human attestation is only for criteria whose truth is outside the audit's reach. It must not be an escape hatch for a criterion the audit checked and found false.

### `isComplete` means all criteria

No majority vote, no weighted score, no "important ones are green" shortcut. If the definition says all criteria, completion requires all criteria.

### A non-holding criterion needs actionable evidence

A `fails` or `not_yet` result without saying what would establish the condition is operationally useless. Every outstanding item should point to the missing observation, divergence, migration state, test, or attestation.

---

## 4. How to determine current status now

Do not copy counts from this file. Run the current report against the environment whose readiness matters.

At minimum inspect:

1. migration mode for every relevant target/edit type;
2. whether anything is actually `generic_authoritative`;
3. reconciliation examined counts and completion;
4. unresolved reconciliation divergences;
5. policy parity and any severity-1/permissive divergence;
6. queue parity for the targets whose served queue is moving;
7. fallback/error counters;
8. the attestation-required criteria for deployed product behavior;
9. rollback evidence for targets that have been advanced.

For the first low-risk target, combine the §26 report with the Phase 9 dossier/readiness output. A code-level eligibility entry for `wiki_fact` is necessary for authority but does not itself prove that the runtime mode was advanced or that the observation window completed.

---

## 5. Reusability evidence has strengthened since the original audit

The original definition-of-done note relied on the Kinetix Phase 13 ADR fixture for the reusability group.

The evidence is now stronger:

- the pure core is published and consumed by Kinetix as `assurance-core`;
- review packets and generic queue selection have moved into the package;
- `AssuranceStore` and its executable conformance contract live in the package;
- `assurance-core/examples/adr-host/` implements a separate store and exercises that contract.

That supports the **core** reusability criteria.

It does not automatically prove that Kinetix's current SQL adapter is a generic Postgres package. The adapter still understands Kinetix legacy snapshot shapes and contains some recovery logic justified by Kinetix policy semantics. The continuation plan therefore requires normalization and a non-Kinetix SQL host before calling a Postgres implementation reusable.

---

## 6. Current exit-gate interpretation

| Requirement | How to establish it now |
| --- | --- |
| every §26 criterion represented | repository test/audit |
| unverifiable criteria never auto-pass | repository test |
| empty or truncated reconciliation is not clean | repository test + runtime report fields |
| attestation cannot override a check | repository test |
| `isComplete` means all criteria | repository test |
| package/core reuse criteria | package graph, purity/conformance tests, ADR host |
| per-target operational completion | runtime migration state + dossier + observation evidence |
| clean migration state | complete reconciliation/parity report in the intended environment |
| product continuity | explicit human/product attestation where required |

The output should be treated as an environment-specific readiness report layered on top of repository-level invariants.

---

## 7. What not to write back into this document

Do not update this file after every migration-state change with prose such as:

```text
18 criteria hold today
wiki_fact is currently generic_authoritative
```

Those facts will become stale as soon as another environment or target changes. Keep volatile state in the database/reporting layer and keep this file about interpretation and requirements.

If a completion criterion itself changes, update §26 and the executable audit together in a reviewed change.

---

## 8. Historical rollback note

The original audit module was designed as read-only observability. Removing it would remove a check, not roll back governance behavior. That remains conceptually true, but any actual deletion must use current import/use analysis rather than the phase-era statement that nothing imports it.
