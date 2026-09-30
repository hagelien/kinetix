# kinetics-core — roadmap

`kinetics-core` is the portable PK execution layer governed by Kinetix and shared with
Redose. The roadmap has two distinct programs that must not be conflated:

1. **cross-app harmonization** — consolidate duplicate Kinetix/Redose scientific paths and
   migrate the reviewed legacy models;
2. **scientific completion** — finish the more ambitious four-layer PK architecture defined in
   the July 21 master specification.

The harmonization work created the foundation. It is **not** the endpoint.

## Authoritative documents

- **Master architecture:**
  [`docs/plans/2026-07-21-cross-app-pk-harmonization.md`](../plans/2026-07-21-cross-app-pk-harmonization.md)
- **Migration/parity completion:**
  [`docs/plans/2026-07-23-harmonization-completion.md`](../plans/2026-07-23-harmonization-completion.md)
- **Scientific completion plan:**
  [`docs/plans/2026-08-18-kinetics-core-scientific-completion.md`](../plans/2026-08-18-kinetics-core-scientific-completion.md)
- **Package:** `src/lib/kinetics-core/`
- **Consumer roadmap:** Redose `docs/kinetics/roadmap.md`

When these documents appear to disagree about the endpoint, the distinction above resolves it:
the July 23 document governs **migration**, while the August 18 document governs the continued
scientific implementation.

## What is already in the core

### Portable execution and trust infrastructure

- [x] canonical scenario/result contract;
- [x] deterministic forward execution plus seeded Monte Carlo bands;
- [x] deterministic PRNG and cross-runtime parity fixtures;
- [x] structured non-result/failure policy;
- [x] immutable reviewed registry with version/checksum/provenance;
- [x] per-dose routes and repeated-dose handling;
- [x] run/solver provenance needed for reproducibility.

### Structural model families

- [x] one-compartment first-order absorption;
- [x] IV one-compartment bolus/infusion;
- [x] two-compartment first-order model;
- [x] Michaelis–Menten saturable elimination;
- [x] total-weight, lean-body-mass and Widmark Vd scaling.

These capabilities are substantial, but they mostly reproduce or consolidate models that already
existed in Kinetix/Redose. They do not yet implement the full statistical and physiological model
composition described by the master architecture.

## Harmonization track

The July 23 migration plan remains active until the legacy scientific paths are either migrated
or explicitly retired. Its scope is intentionally narrow:

- publish reviewed models into the shared registry;
- switch equivalent Redose models to the core;
- preserve numerical traceability or document approved scientific changes;
- remove duplicate Redose equations/parameter sets;
- finish the remaining ethanol/N₂O/legacy-engine decisions;
- preserve cross-app parity gates.

See the dedicated migration plan for detailed status. Completion of this track means
**harmonization complete**, not `kinetics-core` scientifically complete.

## Scientific-completion track

The four-layer architecture from the July 21 specification is the target:

1. **administration/input**;
2. **disposition**;
3. **observation**;
4. **variability**.

The highest-value remaining work is:

### 0. Kinetix must execute the shared core

- [ ] Kinetix forward modeling calls `simulateScenario()` rather than its duplicate legacy PK
      worker/equation path.
- [ ] Lite inference uses the same deterministic core kernel for every model family it claims to
      support.
- [ ] duplicated scientific equations/PRNG/parameter logic are retired after regression parity.

This is first because scientific improvements made only in `kinetics-core` otherwise do not
necessarily improve the Kinetix modeling tool.

### 1. Population parameter semantics and correlated variability

**SC-1A landed** (core 1.3.0): the `one-compartment-clv` family + the structural
parameter-identity contract (`src/lib/kinetics-core/structural.ts`). A model can now be
parameterised by clearance and central volume (`ke = CL/Vc`, half-life derived), and every
structural parameter carries an `identifiabilityBasis`. Additive — no shipped registry model
uses it yet (evidence-gated per the E-track), so no curve changed. Covariance (SC-1C),
uncertainty-layer separation (SC-1B/D) and the multi-compartment `Vp/Q` structural forms remain
open below.

- [~] explicit structural parameters such as CL/Vc/Vp/Q/ka/F — `CL`, `Vc`, `ka`, `F` live in the
      one-compartment-clv family (SC-1A); `Vp`/`Q` land with a structural two-compartment form;
- [x] **parameter identifiability metadata** — `CL` vs `CL/F` (and `V`/`V/F`, `Q`/`Q/F`) as
      distinct identities, each carrying an `identifiabilityBasis` (`iv-anchored` /
      `absolute-f-supported` / `apparent-extravascular` / `derived`); an apparent extravascular
      parameter is never exposed as absolute. This is the common case for the extravascular
      catalogue. **(SC-1A: `structuralIdentity` / `absoluteValueOrNull`.)**
- [~] derived half-life and α/β phase quantities when the structural model permits it — terminal
      half-life is derived from `CL/Vc` (SC-1A); α/β macroconstants land with the structural
      two-compartment form;
- [ ] separate population fixed-effect uncertainty from IIV/BSV;
- [ ] Ω/covariance matrices and correlated random-effect sampling;
- [ ] **no-covariance fallback** — an absent covariance is an `assumed-diagonal` Ω recorded as
      *unknown* correlation, never as measured independence ("not reported" ≠ "= 0");
- [ ] **scenario/input uncertainty** (dose, purity/active-moiety, time/window, duration,
      adherence) as a first-class layer distinct from IIV and observation error (shared with §4);
- [ ] separate residual biological and analytical uncertainty;
- [ ] explicit distribution semantics rather than automatic min/max → uniform assumptions.

### 2. Model-specific covariate effects

**SC-2A landed** (core 1.4.0): the declarative covariate-function contract
(`src/lib/kinetics-core/covariates.ts`). A `one-compartment-clv` model may declare
`covariateFunctions` (allometric / linear / categorical) that individualise `CL`/`Vc`/`ka` to a
subject covariate — model-declared only, evaluated by the core (no app callbacks), factors applied
after the seeded draw so parity is untouched. A required covariate the subject omits is an explicit
insufficient-input failure; applied effects are reported; the `clv-reference-subject` warning is
suppressed once a function individualises the disposition. The first *reviewed* covariate PopPK
model (SC-2B) is still evidence-gated (E-track).

- [x] portable declarative covariate functions **(SC-2A)**;
- [~] effects on CL/V/Q/ka/F or other parameters only when declared by the reviewed model —
      `CL`/`Vc`/`ka` on the clv family (SC-2A); `Q`/`F` and other families follow their structural
      forms;
- [ ] numeric renal-function support when required by the first validated renal model;
- [ ] age/maturation, hepatic, genotype/phenotype and DDI effects where evidence supports them —
      the contract already expresses these over existing subject fields; new subject fields (eGFR,
      genotype) are added when a reviewed model consumes them (SC-2B);
- [x] traceable reporting of which covariates changed which parameters **(SC-2A: `covariate-applied`
      limitations)**.

No universal disease multipliers belong in the core.

### 3. Parent/metabolite and active-moiety kinetics

**SC-3A landed** (core 1.6.0): the coupled parent→metabolite family
(`parent-metabolite-first-order`) is now a first-class model family. Part 1 landed the dark ODE
model (`src/lib/kinetics-core/models/parent-metabolite.ts`) — a parent absorbed/eliminated
compartment feeding a metabolite compartment, with molar↔mass stoichiometry (`fm·(mwM/mwP)`),
emitting BOTH concentration curves, validated against exact closed forms (parent Bateman,
metabolite triple-exponential) and mass-balance/stoichiometry AUC. **Part 2** wired it into
`simulateScenario` behind the additive multi-analyte result contract: one coupled RK4 run
produces the parent (the scenario's PRIMARY analyte, unchanged top-level curve) plus the
metabolite, surfaced through the new optional `CanonicalResultOk.additionalAnalytes`
(`AnalyteCurve[]` — each with its own analyte id, matrix, unit, time series and peak). The family
draws its own `ParentMetaboliteRouteParams` block and its `ResolvedRouteSummary.parentMetabolite`
carries the formation/stoichiometry. Additive: a single-analyte consumer ignores
`additionalAnalytes` and reads the primary curve unchanged, and no registry model uses the family
yet (the first reviewed vertical is evidence-gated, SC-3B), so every existing curve and the
registry checksum are unchanged. The cross-app boundary change held for its own focused review.

- [x] general coupled parent→metabolite model — linear one-step ODE + mass balance **(SC-3A part
      1)**, wired into the engine + multi-analyte result **(SC-3A part 2)**;
- [~] metabolite-specific CL/V and formation parameters — the model carries separate parent/
      metabolite Vd + elimination and a molar formation fraction; registry authoring is SC-3B;
- [ ] branching transformations and direct metabolite administration (SC-3C);
- [x] molar/mass stoichiometry and mass-balance validation **(SC-3A part 1)**;
- [x] multiple analyte curves from one scenario — surfaced through the additive
      `additionalAnalytes` result contract **(SC-3A part 2)**;
- [ ] active-moiety aggregation as a derived result rather than a replacement for analyte curves.

This is a mechanistic PK capability and is separate from the descriptive metabolite-ratio / Case
Pattern Explorer work.

### 4. Richer administration/absorption

**SC-4A (lag) landed** (core 1.5.0): the first-order absorption families
(`one-compartment-first-order`, `one-compartment-clv`) accept an optional
`absorptionLagHours` (`tlag`) — absorption begins `tlag` hours after the dose, and the reported
peak (including off-grid refinement) is offset by it. Additive: the lag is drawn only when
declared, so an unlagged model keeps the identical PRNG stream and every existing curve is
unchanged.

**SC-4A part 2 (zero-order input) landed** (core 1.7.0): the `one-compartment-zero-order` family
models ZERO-ORDER (constant-rate) extravascular input over a finite duration into a
one-compartment linear disposition — a sustained-/controlled-release product, transdermal patch,
or depot approximated as rate-controlled release. Unlike the IV infusion family it carries a real
bioavailability `F` (< 1) and an optional lag; the concentration is the constant-rate-input closed
form on the absorbed amount `F·Dose` over the duration (peak at the input endpoint), so it reuses
the validated infusion kernel and the infusion-endpoint peak refinement. Additive — no shipped
model uses it, so the registry checksum and every existing curve are unchanged.

**SC-4A part 3 (mixed parallel input) landed** (core 1.8.0): the `one-compartment-mixed-order`
family models PARALLEL input — a `firstOrderFraction` of the absorbed dose enters first-order
(`ka`) and the rest zero-order over a finite duration, into one shared one-compartment
disposition. The concentration is the linear superposition of the two single-pathway closed forms
(a rapid first-order rise onto a slower rate-controlled component), so it stays on the closed-form
path and reuses the existing peak refinement — the per-dose window resolves the sharp first-order
peak and the grid-argmax bracket covers the zero-order corner. The summary reports both `ka` and
the zero-order duration plus the split, and the extremes collapse to the pure families. Additive —
no shipped model uses it, so the registry checksum and every existing curve are unchanged.

- [x] first-order absorption with lag **(SC-4A)**;
- [x] zero-order and mixed zero/first-order input — pure zero-order **(SC-4A part 2)** and mixed
      parallel zero/first-order **(SC-4A part 3)** input families;
- [ ] transit/depot models where required;
- [ ] structured formulation and fed/fasted context;
- [ ] route/formulation-specific F and absorption distributions;
- [ ] dose/purity/time/duration/adherence as structured inputs that can carry uncertainty, feeding
      the §1 scenario/input layer rather than being fixed point values;
- [ ] Cmax/Tmax and early-phase validation.

### 5. Observation and matrix model

**SC-5A (latent→observed matrix transform) landed** (core 1.9.0): the observation is now
explicitly separated from the latent state. A model computes a concentration in its NATIVE matrix;
a scenario may request a different OBSERVED matrix, and the engine honours it ONLY via a reviewed,
model-declared `matrixTransform` (`from`/`to`/`ratio`/`rationale`). When one covers the request the
curve (median, bands, peak, and any additional analyte) is scaled by the deterministic ratio, the
reported `matrix` becomes the observed one, and `RunManifest.matrixTransform` records the applied
conversion with an info limitation; without a declared transform the cross-matrix request is
refused rather than silently mislabelled. Additive — no shipped model declares a transform (a
reviewed conversion is evidence-gated per analyte), so the registry checksum and every existing
curve are unchanged.

**SC-5B (observation residual-error layer) landed** (core 1.10.0): a model may declare reviewed
`observationError` layers — named sources (analytical / preanalytical / biological / structural),
each an optional proportional CV and/or additive SD (mg/L), analyte-specific — kept DISTINCT rather
than folded into one number (§4.3). The engine composes independent layers in variance and WIDENS
the reported bands by the measurement error (deviation-scaling that preserves an MC band's shape, or
a symmetric normal band on a deterministic run), leaving the median — the deterministic central
prediction — unchanged and truncating at 0. The applied layers are recorded in
`RunManifest.observationError` with an info limitation. Additive — no shipped model declares one (a
reviewed error model is evidence-gated per analyte), so every existing curve and the registry
checksum are unchanged. Correlated (non-i.i.d.) residual components remain a follow-up.

- [x] explicit latent-state → observed-concentration layer **(SC-5A)**;
- [~] blood/plasma/serum transforms with uncertainty where validated — the deterministic transform
      contract landed **(SC-5A)**; ratio uncertainty and the first reviewed conversion remain;
- [x] analytical, preanalytical, biological and structural error as separate layers **(SC-5B)**;
- [ ] sampling-time/event-time uncertainty;
- [ ] total/unbound concentration where scientifically relevant;
- [ ] protein-binding/saturable-binding models only for concrete use cases where they materially
      affect interpretation or disposition.

Forensic priority is matrix/observation correctness before generic free-concentration reporting.

### 6. Further evidence-driven model families

- [ ] mechanism-based/time-dependent enzyme effects when a reviewed model requires them;
- [ ] additional multicompartment/nonlinear families tied to concrete analyte use cases;
- [ ] no model family added solely because it is mathematically interesting.

## Validation track

Validation is not a final phase bolted onto the engine. Every scientific slice carries its own
validation burden.

**SC-7A (external-validation fixture/report format) landed**: `src/lib/kinetics-core/validation.ts`
adds a `ValidationFixture` (a canonical scenario + the EXPECTED literature landmarks with
tolerances from a named source) and `validateFixture`, which runs the engine and compares each
landmark to its expectation. Landmarks are non-compartmental — computed from the reported curve
only (Cmax/Tmax from the peak; AUC by trapezoid; terminal half-life from the log-linear terminal
slope) — so they validate the engine's OUTPUT rather than re-deriving its internals. A Markdown
`renderValidationReport` makes a run a committable, CI-gateable artifact. Pure tooling on top of
results: no equation/solver/contract change, so no `CORE_VERSION` bump and the golden parity
fixture is untouched; reviewed fixtures with real expected values are evidence-authored (like a
registry model). The terminal-half-life estimator uses the standard NCA "best fit" λz selection
(objective adjusted-R² terminal-window choice with an absolute log-linearity floor), confined to
a single uninterrupted decline and bounded after the last input's end (dose time + resolved
infusion/zero-order duration), so a curved, multi-dose or still-absorbing profile yields no
half-life rather than a biased one.

At increasing model maturity, require:

- equation/dimensional tests;
- ODE convergence and event timing;
- mass balance where relevant;
- deterministic and seeded cross-runtime parity;
- literature landmarks (Cmax, Tmax, AUC, CL, terminal phase, accumulation);
- comparison against published concentration-time data;
- interval coverage/calibration for stochastic results;
- matrix-transform validation against paired-matrix data;
- before/after benchmark reports for every result-changing release.

`externally-validated` means biological/predictive validation, not merely implementation parity.

## Registry evolution

The current registry is deliberately more specific than the general Kinetix drug catalog. The
next registry generation must additionally carry:

- structural parameter IDs and units;
- population/applicability scope;
- covariance/random-effect definitions;
- model-specific covariate functions;
- administration/formulation model definitions;
- parent/metabolite networks;
- observation/matrix models;
- separate parameter uncertainty, IIV and residual-error semantics;
- validation fixtures/status and component-level evidence provenance.

The catalog may feed registry generation where its semantics are sufficient. Missing model
science must remain missing rather than being manufactured from generic catalog ranges.

The **catalog-coverage (CV) track** designs exactly this feed — the model family as orthogonal,
cited data axes (disposition / elimination / per-route absorption) in the parameter store, derived
into an engine family with graded disclaimers, so the whole catalog becomes modelable without
manufacturing missing science. See
[`../plans/2026-08-21-catalog-driven-model-coverage.md`](../plans/2026-08-21-catalog-driven-model-coverage.md).
**CV-1a landed**: `model-structure.ts` — the axis types, `composeModelFamily`
(→ engine `ModelFamily` or an explicit `unsupported`), per-family `requiredParametersFor`, and
`validateModelStructure`. Pure/additive; no engine change, no `CORE_VERSION` bump.

## Immediate implementation order

1. **SC-0A:** Kinetix forward adapter → `kinetics-core`.
2. **SC-0B:** Lite inference → same deterministic kernel.
3. **SC-1:** structural parameter + variability/covariance foundation.
4. **SC-2:** first real covariate PopPK vertical slice.
5. **SC-3:** first parent/metabolite vertical slice.
6. **SC-4:** richer absorption families.
7. **SC-5:** observation/matrix transforms and error decomposition.

A continuous **evidence-scouting E-track** runs in parallel with SC-0 and paces SC-1–SC-5: it
keeps a triaged candidate-model queue per layer so the new contracts are designed against actual
published models rather than toy examples, and flags when the only available foundation model is
out-of-domain (a therapeutic drug standing in for the forensic catalogue) instead of quietly
proceeding. The standing queue lives in
[`evidence-candidate-queue.md`](./evidence-candidate-queue.md) (E-1). Two SC-1 semantics are prerequisites for every later layer and must land with the
first parameter contract, not after it: **parameter identifiability** (`CL` vs `CL/F`) and the
**no-covariance fallback** (`assumed-diagonal` unknown Ω).

## Definition of finished

The shared engine is not finished when every legacy Redose model has been ported. It reaches the
intended scientific architecture when it can execute and validate reviewed models that use:

- all four model layers;
- CL/V/Q-style structural parameterisation where appropriate, with true-vs-apparent
  (`CL`/`CL/F`) identifiability semantics;
- correlated IIV, with absent covariance carried as an `assumed-diagonal` unknown rather than
  measured independence;
- scenario/input uncertainty (dose/purity/time/duration/adherence) as a distinct, reportable layer;
- model-declared subject covariates;
- parent/metabolite kinetics;
- richer absorption than a universal `ka`;
- matrix-aware observation and uncertainty;
- separate, correctly named uncertainty layers;
- reproducible model/parameter/registry versions and external validation evidence.

See the scientific completion plan for the normative checklist and PR-sized implementation
slices.

## Release checklist

For every model/core/registry change:

1. keep supported routes, matrices, covariates and dose bases honest;
2. attach reviewed parameter/model provenance;
3. regenerate and review deterministic/stochastic fixtures;
4. run `npm run test -- src/lib/kinetics-core` and the relevant integration/validation suites;
5. bump the correct core/model/parameter/registry version axis;
6. produce a before/after benchmark for intended scientific changes;
7. re-vendor/pin in Redose where that consumer uses the changed model;
8. preserve historical reproducibility.
