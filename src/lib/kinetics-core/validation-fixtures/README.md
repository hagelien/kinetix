# Validation fixtures

Two kinds of fixture live here, distinguished by `sources[].evidenceKind`:

- **`internal-invariant`** (`*-sanity.json`) — checks that the engine's own output is
  dimensionally sane for this model (correct unit, monotonic time grid, ordered
  percentile bands). No literature is asserted. `ScientificCheckResult.externallyValidated`
  is always `false` for these, so a passing sanity fixture never claims the model
  agrees with a published study — it only proves nothing broke the math.
- **`external-literature`** / **`observed-dataset`** (e.g. `cocaine-iv-jeffcoat.json`) —
  checks the engine's output against a cited, reviewed literature or observed landmark
  (Cmax, Tmax, AUC, terminal half-life). These are the fixtures that actually validate
  the science (SC-7A) and are the ones that should replace a sanity fixture over time.

Every registered model needs at least one fixture, so a change to `simulate.ts`,
`solver.ts`, `equations.ts`, `version.ts`, or `types.ts` (or a registry change touching
an analyte's parameters) can be checked for that model. Today most models are covered
only by a sanity fixture — that keeps CI unblocked without pretending a model has been
validated against the literature it hasn't yet been checked against.
