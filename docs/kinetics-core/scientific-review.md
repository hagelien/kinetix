# Scientific production review gate

Every new or changed calculation-driving artifact—model, parameter set, covariate function, matrix
transform, observation/error model, or validation dataset—must pass
`evaluateScientificRelease` before it is labelled or exposed as production. A code review, complete
packet, prior approval of another version, or team/anonymous sign-off is not a scientific approval.

The packet is immutable evidence and must document primary-source extraction, applicability
boundaries, parameter/unit checks, deterministic and seeded-stochastic fixture diffs,
literature-landmark results, observed-data comparison (or explicit unavailability), before/after
curves, limitations, and a proposed validation grade. Every covered artifact has its own type, id,
version, checksum, and new/changed designation.

Approval is a separate attestation by a named person with affiliation and scientific
qualifications. It binds the packet checksum and the exact model, parameter, registry, and core
versions. Any content or version change therefore requires another approval and leaves the changed
release outside production in the meantime.

The gate fails closed. Missing, failed, unavailable, incomplete, anonymous, unsupported-grade, or
stale review returns `production: false`; the recorded failure disposition limits the artifact to
`experimental`, `reviewer-only`, or `unsupported`. Production callers must permit only the explicit
`{ production: true, access: "production" }` result. Persist the approval and release tuple with
run records so a historical run can resolve the exact scientific decision as well as the existing
core/registry manifest.
