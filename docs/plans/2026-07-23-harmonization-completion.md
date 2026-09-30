# Cross-app PK harmonization — migration completion plan

**Status:** migration/parity plan in progress  
**Date:** 2026-07-23  
**Scope clarified:** 2026-08-18  
**Governance home:** `hagelien/kinetix`  
**Master architecture:** [`2026-07-21-cross-app-pk-harmonization.md`](./2026-07-21-cross-app-pk-harmonization.md)  
**Scientific continuation:** [`2026-08-18-kinetics-core-scientific-completion.md`](./2026-08-18-kinetics-core-scientific-completion.md)  
**Companion roadmaps:** `docs/kinetics-core/roadmap.md` (Kinetix), Redose `docs/kinetics/roadmap.md`

This plan sequences the remaining work to complete the **cross-app harmonization/migration
program**: one implementation of the migrated deterministic models, both apps resolving the same
model/parameter IDs, Redose carrying no duplicate equations or PK parameter sets, and numerical
failures represented as structured non-results.

It no longer claims to sequence all work required to finish `kinetics-core` scientifically. The
July 21 architecture deliberately specified administration, disposition, observation and
variability as separate model layers. The post-harmonization implementation of covariate-driven
PK, correlated population variability, parent/metabolite models, richer absorption and
matrix-aware observation models is owned by the August 18 scientific-completion plan.

## Scope boundary

The historical rule in this document — **port reviewed models, do not invent new science merely
to achieve parity** — is a migration rule. It protects the harmonization program from silently
changing model behavior while consolidating repositories. It is not a permanent prohibition on
new `kinetics-core` science.

A new model family after harmonization is permitted when it has:

- a concrete reviewed use case;
- explicit evidence/provenance;
- versioned model and parameter semantics;
- numerical and scientific validation appropriate to its claim;
- a before/after benchmark when it changes an existing production model.

Therefore:

- **this plan is complete when the duplicate legacy paths are harmonized/retired**;
- **`kinetics-core` is complete only when the scientific-completion definition is met**.

## Where we are

Shipped: portable engine + contract + registry release + cross-app parity gate;
registry↔catalog provenance gate; lean-body-mass Vd scaling; four core model families
(`one-compartment-first-order`, `iv-one-compartment`, `two-compartment-first-order`,
`michaelis-menten`). **10 of 13 substances are switched in Redose production**
(amphetamine, methylphenidate, LSD, 2C-B, THC, GHB, MDMA, ketamine, psilocybin,
lisdexamfetamine — see Redose's `MIGRATED_ANALYTES`).

Remaining to switch: **cocaine** (this plan's registry release), **ethanol** (needs the
structured fed/fasted admin context, D4), and **N₂O** (exposure capability, E). After those,
Redose's legacy engine can be deleted (Phase F). Most of the "new families" in this migration
were **ports** of Redose's existing, already-reviewed pure-TS models (`lib/pk/models/*`,
`lib/pk/solver.ts`) into the core, locked with parity tests — the master plan's "consolidate both
repositories' strongest scientific work" (§4), not new science.

Note: the `(not switched)` / `Not switched` annotations on the Phase A–B items below record each
model's status *at the time it landed in the Kinetix registry*. The Redose production switches
for THC/GHB/MDMA/ketamine/psilocybin/lisdexamfetamine subsequently completed in Redose issue 45 (core
1.2.0). Registry publication (Kinetix) and consumer switch (Redose) are distinct milestones —
see `docs/kinetics-core/roadmap.md`.

## Guiding rules for the migration track

- One reviewed model/family per PR; scientific deltas reviewable without UI noise.
- Every migration is numerically traceable: mirror the legacy curve (identical) or document an
  approved change. Healthy reference subject is the parity anchor.
- Never convert a solver failure into a plausible zero curve — structured non-result.
- ODE models: convergence + mass-balance + event-timing tests, solver settings in the manifest,
  model-specific tolerances (not the analytic 1e-9).
- Kinetix owns the release; Redose consumes a re-vendored, checksummed copy and only switches
  production after the shared fixtures pass in both repos.

## Phases

### Phase A — Core model families (Kinetix; unblocks migration)

No production switches; each family lands with fixtures + parity tests against the Redose
original it ports.

- [x] **A0. Multi-family engine.** `simulateScenario` dispatches on the route's `family`
  (kernel superposition for linear families; a whole-scenario ODE path for ODE families),
  sharing validation / uncertainty / manifest / peak plumbing. Core 0.3.0.
- [x] **A1. IV bolus / infusion family** (`iv-one-compartment`). Bolus `dose/Vd` +
  first-order decay, or constant-rate infusion. Cocaine `iv` route registered (not switched).
- [x] **A2. Two-compartment first-order absorption** (`two-compartment-first-order`).
  Ported from `lib/pk/models/two-compartment.ts` via the shared RK4 solver, per-dose gut
  compartments (mixed-route fix). THC registered (not switched). Validated vs Redose's RK4 to
  1.5e-8 at matched steps.
- [x] **A3. Michaelis–Menten family** (`michaelis-menten`). Ported from
  `lib/pk/models/michaelis-menten.ts` on the shared RK4 solver, in canonical mg/L (unit
  conversion baked into the registry). Adds the `widmark` Vd-scaling mode (Watson TBW) for
  ethanol. GHB + ethanol registered (not switched). ODE path generalised to dispatch
  two-compartment / MM through one shared runner.
- [x] **A4. Nonlinear-clearance (MDMA auto-inhibition).** The reviewed
  `mdma-nonlinear.ts` implements CYP2D6 auto-inhibition as plain Michaelis–Menten saturable
  clearance (identical math to ethanol/GHB), so MDMA registers on the A3
  `michaelis-menten` family with `total-weight` scaling — **no separate migration family**.
  MDMA registered (not switched).
- [x] **A5. Prodrug (lisdexamfetamine → amphetamine migration approximation).** The reviewed
  Redose model does not implement an explicit parent→metabolite hydrolysis ODE: near-complete
  RBC hydrolysis is modelled as the released d-amphetamine one-compartment curve (slow
  absorption t½ 75 min = rate-limited conversion; F 0.30 folds the ~0.295 mass conversion).
  For migration parity, lisdexamfetamine therefore registers on the existing
  `one-compartment-first-order` family.

  **Clarification added 2026-08-18:** this decision means "do not invent an unreviewed
  hydrolysis model inside the parity migration." It does **not** remove parent/metabolite models
  from the master architecture. A general reviewed parent/metabolite family is scheduled in the
  scientific-completion plan.

**Exit:** each migrated family reproduces its Redose counterpart within a declared, tested
tolerance; `npm run test -- src/lib/kinetics-core` green; goldens regenerated.

### Phase B — Linear-wave remainder (needs A1)

- [x] **B1. cocaine** — ADJUDICATED: ship the **reviewed literature** values (not a legacy
  mirror). Registry `0.9.0` (checksum `adcc1cec`, modelId `cocaine-one-comp-v2`) models all
  four routes — intranasal (F 0.80), inhalation/smoked (F 0.57 — Jeffcoat's observed smoked
  bioavailability, reduced by pyrolytic degradation), oral (F 0.33), and IV bolus — with
  per-route reviewed-override provenance + literature citations. A deliberate, documented
  curve change from Redose's legacy (Vd 2.0→2.7, lean-body-mass→total-weight, t½ 1.0→1.5 h,
  intranasal F 0.30→0.80); before/after benchmark in
  `docs/kinetics-core/cocaine-migration-report.md`. Redose's `smoked` route normalises to
  `inhalation`.
- [x] **B2. ketamine** — registered on `one-compartment-first-order`, mirrored from Redose
  (Vd 3.0 → total-weight; intranasal/IM/oral). The half-life discrepancy is resolved as a
  documented reviewed-override: terminal t½ 2.5 h vs the catalog's α-phase 0.17–0.25 h.
  Switched in Redose issue 45 (core 1.2.0).
- [x] **B3. psilocybin** — registered on `one-compartment-first-order`, mirrored from Redose
  (Vd 1.0 → lean-body-mass). Analyte identity documented: the psilocybin→psilocin prodrug is
  modelled as the psilocin-equivalent curve. Switched in Redose issue 45 (core 1.2.0).

### Phase C — Prodrug migration parity (needs A5)

- **C1. lisdexamfetamine → amphetamine** — replace the fixed-factor
  `moietyEquivalentFactor` + post-hoc summation with the A5 migration model; verify the combined
  amphetamine-moiety curve matches the legacy `combine` path.

This phase proves cross-app equivalence only. Mechanistic parent/metabolite science belongs to
scientific-completion S3.

### Phase D — Nonlinear / multicompartment migration (needs A2/A3/A4)

One model per PR, each with ODE-convergence + redose event-timing + long-horizon stress fixtures
shared with Kinetix, and low-end performance sanity:

- **D1. THC** (two-compartment, A2) — central vs apparent Vd, matrix, terminal phase.
- **D2. GHB** (Michaelis–Menten, A3) — high-dose nonlinearity, solver validation.
- **D3. MDMA** (nonlinear clearance, A4) — auto-inhibition parameter evidence.
- **D4. ethanol** (Michaelis–Menten, A3) — select the reviewed model; move fed/fasted from the
  `notes === "fed"` hook hack to structured administration context (a DB migration adding
  `administration_context_json` or explicit columns).

Richer administration models beyond the requirements of these migrated models are scientific
continuation work (S4), not blockers for migration parity.

### Phase E — N₂O

- **E1.** Publish N₂O as a session/exposure capability (not a concentration curve); Redose
  consumes it and drops the local `n2o-session` path. If out of scope for the shared contract,
  keep N₂O as an explicitly documented Redose-only exposure view.

### Phase F — Remove the Redose legacy engine + migration governance

Only after every supported migrated model has passed both repos' gates:

- delete `lib/pk/models/*`, the local RK4 solver (unless an N₂O-only exposure path needs it),
  runnable PK parameter objects in `lib/substances/*`, `lib/kinetics/legacy-comparison.ts`, and
  the migration feature switches; keep only the thin adapter + view types;
- finish the build-time registry generator where the catalog can safely supply values;
- preserve versioned fixtures and rollback capability.

The old open **impaired-profile scaling** choice is no longer "drop scaling vs maybe add
covariates." The scientific direction is now explicit: **do not apply generic disease scaling;
add model-declared covariate relationships in scientific-completion S1/S2 where evidence
supports them.** Until then, unsupported profile effects remain explicit limitations.

### Phase G — Handoff to scientific completion

Harmonization does not terminate development of the core. After or in parallel with the final
migration cleanup, continue under
[`2026-08-18-kinetics-core-scientific-completion.md`](./2026-08-18-kinetics-core-scientific-completion.md):

1. wire the Kinetix forward UI and Lite inference onto the shared core;
2. implement CL/V/Q-oriented parameter semantics and correlated IIV;
3. implement model-specific covariate effects;
4. add a general parent/metabolite family;
5. add richer administration/absorption families;
6. add explicit observation/matrix/error models;
7. validate each production model beyond implementation parity.

## Coordination / PR sequence

Each numbered migration item is a Kinetix PR (family or registry release) paired, where it
changes production, with a Redose re-vendor + switch PR. `CORE_VERSION` bumps on core contract or
engine changes; `REGISTRY_VERSION` + checksum bump on registry releases; Redose `EXPECTED_*`
bumps in lockstep.

Scientific-completion PRs follow their own SC-* sequence and may continue after Redose no longer
has a legacy engine. Redose only needs to adopt advanced model versions when its product claims
the corresponding capability.

## Definition of done — harmonization only

The cross-app migration program is complete when:

- [ ] Every supported legacy Redose substance/capability has either migrated through the shared
      core or been explicitly classified as a separate non-PK capability.
- [ ] Redose contains no duplicate equation or runnable PK parameter set for migrated models.
- [ ] Both apps resolve the same model/parameter-set IDs for equivalent scenarios.
- [ ] The same fixtures pass in both runtimes within declared tolerances.
- [ ] ODE models have convergence/mass-balance/event tests and solver settings in manifests.
- [ ] Numerical failures are structured non-results, never plausible zero curves.
- [ ] The Redose legacy engine is deleted; only a thin adapter remains.

**This checklist does not mean `kinetics-core` is scientifically finished.** The normative
scientific-completion checklist is in the August 18 plan and includes the four-layer model
composition, population covariance, model-declared covariates, parent/metabolite kinetics,
richer absorption and observation/matrix models.
