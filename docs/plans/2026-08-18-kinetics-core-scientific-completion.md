# kinetics-core — scientific completion plan

**Status:** active planning baseline  
**Date:** 2026-08-18  
**Governance home:** `hagelien/kinetix`  
**Normative architecture:** [`2026-07-21-cross-app-pk-harmonization.md`](./2026-07-21-cross-app-pk-harmonization.md)  
**Migration-only completion plan:** [`2026-07-23-harmonization-completion.md`](./2026-07-23-harmonization-completion.md)  
**Status roadmap:** [`../kinetics-core/roadmap.md`](../kinetics-core/roadmap.md)

## 1. Decision

The cross-app harmonization program is a foundation, not the scientific endpoint of
`kinetics-core`.

The July 21 architecture defined a model as the composition of four scientifically distinct
layers:

1. administration/input;
2. disposition;
3. observation;
4. variability.

That architecture remains the target. The July 23 completion plan deliberately narrowed the
immediate work to porting and consolidating already-reviewed Redose models. That was the right
migration strategy, but it must not become the permanent definition of a finished PK engine.

`kinetics-core` is considered scientifically complete only when it can express reviewed models
that materially depend on all four layers, including model-specific subject covariates,
correlated population variability, parent/metabolite formation, richer absorption, and
matrix-aware observation error. A particular drug model does **not** need to use every
capability. The core must make the capability available, and each registry model must declare
exactly which subset it uses and has evidence to support.

The rule used during harmonization — **port reviewed models; do not invent new science merely
to achieve parity** — remains valid for migration work. It does **not** prohibit subsequent new
model families. New science enters the core through evidence review, explicit model scope,
versioning, benchmark data and validation rather than by being silently improvised in an app
adapter.

## 2. Boundary with KineLab / full-remote

The portable core and the advanced inference backend have different jobs.

`kinetics-core` owns:

- deterministic forward models;
- ODE state equations and numerical policy for portable models;
- administration, disposition and observation transforms;
- reviewed population parameter sets and covariate functions;
- seeded sampling from parameter uncertainty and interindividual-variability models;
- correlated random effects where a covariance structure is supplied;
- forward uncertainty propagation and statistical summaries;
- model/parameter provenance, limitations and validation fixtures.

KineLab/full-remote may own:

- fitting new population models to raw datasets;
- hierarchical Bayesian estimation;
- HMC/NUTS/SMC and expensive posterior computation;
- model averaging and comparison that is impractical in-browser;
- postmortem-specific inference engines where living PK is not a defensible structural model.

The distinction is **estimation versus execution**, not simple versus sophisticated science.
A published population-PK model with CL/V/Q covariates and an Ω covariance matrix should be
runnable by `kinetics-core` without requiring the core to fit that model itself. A model fitted
or adjudicated in KineLab can become a versioned core registry release after review.

## 3. Current baseline

The portable core already provides a strong computational base:

- one-compartment first-order absorption;
- IV one-compartment bolus and constant-rate infusion;
- two-compartment first-order disposition;
- Michaelis–Menten saturable elimination;
- per-dose routes, repeated dosing and ODE event handling;
- total-weight, lean-body-mass and Widmark Vd scaling;
- deterministic median curves plus seeded Monte Carlo bands;
- immutable reviewed model registry, provenance and checksums;
- structured failures rather than plausible-zero fallbacks;
- cross-runtime/cross-app parity fixtures.

The remaining scientific limitations are structural rather than cosmetic:

- the Kinetix forward UI still has a duplicate legacy PK path instead of executing
  `kinetics-core` directly;
- many models are parameterised around an elimination half-life rather than a physiological
  CL/V parameterisation;
- scalar parameter distributions are sampled independently and do not represent a population
  random-effects model;
- parameter uncertainty, interindividual variability, residual biological variability and
  analytical error are not first-class separable layers in the core;
- subject covariates exist in the contract but generally affect distribution-volume scaling,
  not model-specific clearance or other PK parameters;
- there is no general parent→metabolite / metabolic-network model family;
- administration is mostly first-order absorption plus IV infusion, without a general lag,
  zero-order, transit or parallel-input model;
- matrix is represented, but a latent PK state and the laboratory observation are not yet
  separated by an explicit observation model;
- protein binding/free concentration is not represented except indirectly in source data;
- a literature min/max range can still be treated as if it were a probability distribution
  without the semantics needed to justify that interpretation.

## 4. Scientific design principles

### 4.1 Model the underlying parameters when they are known

For reviewed population models, prefer parameterisations such as **CL, Vc, Vp, Q, ka and F**
over treating terminal half-life as an independent primitive. Half-life, α/β phase constants,
AUC, accumulation and related quantities should be derived from the structural parameters when
the model makes that possible.

A direct half-life parameter remains supported for legacy or evidence-limited models, but its
provenance must say that it is the model's primary elimination parameter rather than a value
derived from CL and V.

**True and apparent parameters are different identities.** A model fitted only to extravascular
data identifies `CL/F` and `V/F`, not `CL` and `V` — absolute clearance and volume cannot be
separated from bioavailability without an IV reference or an independently supported `F`. The
contract must model `CL` versus `CL/F` (and `V` versus `V/F`, `Q` versus `Q/F`) as distinct
parameter identities, not one parameter with a different note, and must never silently promote an
apparent parameter to a physiological one. Every structural parameter therefore carries an
`identifiabilityBasis` — at least `iv-anchored`, `absolute-f-supported`, `apparent-extravascular`,
or `derived` — and a run refuses to report an absolute `CL`/`V` for a parameter whose basis is
`apparent-extravascular`. Because Kinetix's catalogue is overwhelmingly extravascular with no IV
reference, `CL/F` is the expected identity and absolute `CL` the exception that must earn its
basis.

### 4.2 No generic patient-adjustment folklore

Renal impairment, hepatic impairment, age, body size, genotype, inhibitors/inducers, pregnancy
and other covariates may materially change PK, but the core must not apply universal multipliers
such as "renal failure halves clearance" or a generic Child-Pugh correction.

A covariate changes a parameter only when the selected reviewed model declares the relationship.
Unsupported covariates are surfaced as not used. Missing required covariates cause an explicit
unsupported/insufficient-input result rather than a hidden default unless the model itself
specifies a validated reference default.

### 4.3 Keep uncertainty sources distinct

The following are not interchangeable and must not be collapsed into one Monte Carlo band:

- uncertainty in the population fixed effects / literature estimate;
- interindividual variability (IIV/BSV);
- interoccasion variability when the model includes it;
- residual biological/model variability;
- analytical measurement uncertainty;
- uncertainty in event time, dose, purity or matrix conversion.

A result may combine them for a requested predictive interval, but the manifest must say which
layers were enabled and the engine must be able to report them separately.

### 4.4 Correlation is part of the model

Where a population model reports covariance, correlated random effects are part of the reviewed
model and must be sampled jointly. The engine must not manufacture impossible parameter
combinations by drawing CL, V, Q, ka and F independently merely because each marginal range is
known.

Where covariance is unavailable, independent sampling may remain available as an explicit
assumption, never as an unstated population-PK claim.

**"Covariance not reported" is not "covariance = 0."** A source that reports only marginal IIV
tells the engine nothing about the off-diagonals. The core may then sample with a diagonal Ω, but
it must carry that Ω as an *assumed-diagonal* convenience whose true correlation structure is
**unknown**, and the manifest must say so — not record independence as if it had been measured. An
omitted correlation and a measured-zero correlation are different scientific claims; only a
correlation the source actually reports (including a reported zero) may be presented as evidence.
This is the common case for Kinetix's substances, so the *unknown-correlation* label is the
default state of an S1 model, not an edge case.

### 4.5 The observation is not the latent state

A model may carry a latent plasma/central-compartment concentration while the laboratory reports
whole blood, serum, an unbound fraction, or another matrix. Matrix conversion, binding and assay
error belong in an explicit observation layer. A matrix label alone is not sufficient.

### 4.6 Mechanistic complexity is evidence-gated

The engine should be capable of parent/metabolite networks, nonlinear elimination, dynamic
enzyme effects and richer absorption. A registry model uses them only when its evidence and
validation justify them. Complexity is never selected merely because the engine can run it.

## 5. Target model contract v2

The v2 model definition should compose these objects explicitly rather than encoding all science
inside one route-parameter object.

### 5.1 Administration model

At minimum the type system should be able to represent:

- IV bolus;
- constant-rate IV infusion;
- first-order absorption;
- first-order absorption with lag (`tlag`);
- zero-order input over a finite duration;
- parallel/mixed zero- and first-order input;
- transit-compartment absorption;
- depot absorption where required by IM/SC formulations;
- formulation or administration context (including fed/fasted) when it belongs to the reviewed
  model;
- route-specific F and dose-basis/active-moiety conversion.

Not every administration family needs to ship in the first PR. The contract must stop assuming
that one `ka` is the universal shape of non-IV absorption.

### 5.2 Disposition model

The existing families remain and the interface must permit additional reviewed state models:

- one-compartment linear;
- two-compartment linear;
- IV one-compartment;
- Michaelis–Menten / capacity-limited elimination;
- parent/metabolite and multi-metabolite networks;
- time-varying or mechanism-based clearance where evidence requires it;
- additional multicompartment models when a concrete analyte needs them.

A generic PBPK platform is **not** a prerequisite for completion. The goal is an auditable
portable model-family system, not maximum theoretical complexity.

### 5.3 Population parameter and variability model

The current scalar `ParamSpec` should evolve into a model capable of representing:

- named structural parameters (`CL`, `Vc`, `Vp`, `Q`, `ka`, `F`, `Vmax`, `Km`, formation
  fractions/rates, etc.);
- an `identifiabilityBasis` per structural parameter (`iv-anchored`, `absolute-f-supported`,
  `apparent-extravascular`, `derived`) so `CL` and `CL/F` are distinct identities and an apparent
  parameter is never surfaced as an absolute one;
- population fixed effects;
- parameter uncertainty with explicit semantics;
- random-effect transforms, normally positive/log-normal where appropriate;
- an Ω covariance/correlation matrix for IIV, with an absent covariance carried as an
  `assumed-diagonal` Ω whose correlation is *unknown*, never as measured independence;
- optional interoccasion variability;
- a **scenario/input uncertainty** layer — uncertain dose, purity/active-moiety amount,
  administration time/window, duration and adherence — kept distinct from IIV and residual error;
- parameter-specific and model-specific covariate functions;
- derived parameters such as `ke`, terminal half-life and α/β macroconstants;
- validity constraints and covariance-matrix validation.

A reported min/max must not automatically become a uniform distribution and a reported median
must not automatically become the mode of a triangular distribution in a reviewed model. Those
remain fallback exploratory representations only when clearly labelled as assumptions.

### 5.4 Covariate model

Use a portable declarative representation rather than arbitrary application callbacks. It must
be expressive enough for common published PopPK relationships such as:

- allometric weight scaling;
- lean/body-water scaling;
- continuous power or linear covariates;
- categorical multipliers;
- renal-function contributions to clearance;
- hepatic-function covariates;
- maturation functions;
- genotype/phenotype effects;
- explicitly modelled drug-interaction effects.

The canonical subject contract should be extended as real reviewed models require it. Likely
future fields include numeric renal-function measures (eGFR/CrCl rather than only a severity
label), relevant genotype/phenotype categories and pregnancy/gestational context. New fields are
added because a reviewed model consumes them, not speculatively.

### 5.5 Parent/metabolite network

A first-class network model must support:

- parent elimination and metabolite formation as separate processes;
- one-to-one and branching transformations;
- formation fractions/yields and rate constants or clearances;
- molecular-weight-aware molar↔mass stoichiometry;
- first-pass formation where the reviewed model includes it;
- direct administration of a metabolite as well as formation from a parent;
- different V/CL parameters for parent and metabolite;
- multiple measured analytes emitted from one scenario;
- optional active-moiety aggregation without losing the individual analyte curves.

The descriptive metabolite-ratio / Case Pattern Explorer work does **not** substitute for this.
Ratio-pattern evidence and mechanistic PK are complementary layers with different validation
claims.

### 5.6 Observation model

The observation layer should support, where evidence exists:

- latent model matrix versus measured matrix;
- whole-blood/plasma or serum/plasma conversion with uncertainty;
- total versus unbound concentration;
- linear protein binding and, only where necessary, saturable binding;
- assay error;
- preanalytical uncertainty/stability;
- residual biological/structural error;
- sampling-time uncertainty;
- left/right censoring such as `<LOD` and `<LOQ`.

Protein binding is therefore not a universal disposition feature. For many drugs total
concentration remains the appropriate model output. Binding becomes an observation or structural
feature only for models where it materially changes interpretation or kinetics.

## 6. Implementation sequence

The phases are dependency-ordered. Validation work accompanies every phase rather than being
saved until the end.

### S0 — Kinetix executes the shared core

**Priority: immediate.**

The Kinetix modeling workspace must stop using a second forward implementation.

Work:

1. make the Kinetix forward simulator a thin adapter over `simulateScenario()`;
2. make Lite inverse inference use the same core deterministic kernel for every model family it
   claims to support;
3. remove duplicated equations/PRNG/model parameter logic from the legacy worker after parity
   tests pass;
4. preserve saved-case compatibility through explicit migration/adapters rather than duplicate
   science;
5. keep engine IDs explicit when KineLab/full-remote is selected instead.

**Exit:** a canonical scenario produces the same scientific curve in Kinetix and Redose because
both literally execute `kinetics-core`, not because duplicated equations happen to pass an
anti-drift test.

### S1 — Parameter semantics + correlated population variability

**Priority: highest scientific foundation.**

Work:

1. introduce named structural parameters and a CL/V/Q-capable model contract;
2. give every structural parameter an `identifiabilityBasis`, model `CL` vs `CL/F` (and `V` vs
   `V/F`, `Q` vs `Q/F`) as distinct identities, and refuse to expose an absolute parameter whose
   basis is `apparent-extravascular`;
3. retain legacy half-life parameterisation as an explicit compatibility mode;
4. separate population fixed-effect uncertainty from IIV and residual error;
5. add multivariate random-effect sampling and validated Ω/correlation matrices;
6. when covariance is unavailable, sample an `assumed-diagonal` Ω whose correlation is recorded as
   *unknown* — never as measured independence;
7. add a distinct **scenario/input uncertainty** layer (dose, purity/active-moiety, time/window,
   duration, adherence), sampled and reportable separately from IIV and observation error (shared
   with S4, which owns the administration-side shapes it draws over);
8. define transforms/constraints for positive and bounded parameters;
9. make uncertainty layers independently switchable;
10. record enabled variability layers, each parameter's `identifiabilityBasis`, and covariance
    provenance (including `assumed-diagonal`) in the manifest;
11. stop treating catalog min/max ranges as probability distributions unless their semantics say
    they are.

**First vertical slice:** choose a simple published PopPK model with an accessible covariance
matrix and enough concentration-time data to validate the implementation. Do not retrofit a
covariance matrix onto a model merely to exercise the feature.

**Exit:** a model can represent a real population parameter vector and its reported covariance,
and the output can distinguish parameter uncertainty from person-to-person variability.

### S2 — Model-specific covariate effects on clearance and distribution

**Priority: highest clinical/forensic realism after S1.**

Work:

1. add the declarative covariate-function representation;
2. apply covariates to CL/V/Q/ka/F or other parameters exactly as specified by the model;
3. add numeric renal-function inputs when the first validated renal model requires them;
4. add age/maturation or hepatic covariates only with a concrete model;
5. allow genotype/phenotype and interacting-drug covariates when explicitly part of a reviewed
   model;
6. expose which covariates materially changed which parameter in the run manifest/report;
7. reject missing required covariates or use a model-declared reference subject with an explicit
   assumption.

**Exit:** two subjects with different renal/hepatic/age/body-composition profiles produce
different curves **only when the reviewed model says they should**, and the parameter change is
traceable.

### S3 — Parent/metabolite and active-moiety kinetics

**Priority: high for forensic use.**

Work:

1. add a coupled linear parent→metabolite family with mass-balance tests;
2. support direct metabolite administration and parent formation in the same scenario;
3. add branching/multiple-metabolite support without hard-coding drug names;
4. expose multiple analyte curves from one model result;
5. integrate active-moiety aggregation as a derived result, never as a replacement for individual
   analytes;
6. support metabolite-specific covariates where a reviewed model requires them.

**Candidate validation sequence:** a simple one-step transformation first (for example a reviewed
lisdexamfetamine→amphetamine or another well-characterised parent→active-metabolite model), then
a clinically/forensically important parent/metabolite pair, then a branching network. The
specific substances must be selected on evidence quality, not on implementation convenience.

**Exit:** a measured metabolite can be a first-class modeled output rather than a surrogate
single curve with F/ka folded to mimic formation.

### S4 — Richer administration and absorption

Work:

1. add `tlag` to first-order absorption;
2. add zero-order and mixed zero/first-order administration;
3. add transit-compartment absorption;
4. support formulation/depot models where a reviewed product requires them;
5. move fed/fasted and similar context from notes/hooks into structured model input;
6. allow route-specific distributions/covariates for F and absorption parameters;
7. represent dose amount, purity/active-moiety, administration time/window, duration and adherence
   as structured inputs that can carry uncertainty, feeding the S1 scenario/input layer rather
   than being fixed point values;
8. validate Cmax/Tmax and early time-course landmarks, not only terminal decay.

`Tmax` may constrain or help derive an absorption prior only when the structural model permits a
valid relationship. It must not be converted mechanically to `ka` across arbitrary compartment
models.

**Exit:** the model registry can represent a reviewed absorption profile without pretending that
all oral/intranasal/inhaled/IM input is the same first-order process.

### S5 — Observation model and matrix-aware uncertainty

Work:

1. explicitly separate latent concentration from observed laboratory concentration;
2. add versioned matrix-transform definitions with direction and uncertainty;
3. implement total/unbound observation variants where relevant;
4. keep analytical, preanalytical, biological and structural residual-error layers distinct;
5. support sampling-time/event-time uncertainty in forward prediction;
6. preserve censored observations through the same observation contract used by inference;
7. ensure reports state the model matrix, measured matrix and every transformation applied.

**Forensic priority:** whole-blood/plasma/serum handling and observation uncertainty should ship
before a broad free-concentration feature. Protein binding is added first for concrete drugs
where it materially changes the interpretation.

**Exit:** the engine never silently treats a plasma-state prediction as a whole-blood laboratory
measurement merely because both are called "concentration".

### S6 — Additional evidence-driven model families

After S1–S5 provide the general architecture, add new structural families only when a concrete
reviewed model needs them. Candidates include:

- mechanism-based/time-dependent enzyme inhibition or induction beyond a static
  Michaelis–Menten approximation;
- more complex multicompartment models;
- capacity-limited or concentration-dependent binding where it changes PK;
- enterohepatic recirculation or other repeated-input state models;
- specialised elimination models not representable by the existing families.

Each family needs a named analyte use case and validation dataset before implementation starts.

### S7 — Validation and calibration platform

This runs in parallel with S0–S6 and becomes increasingly strict as model claims become stronger.

Per model/version, require as applicable:

- dimensional and analytic tests;
- ODE convergence and event-timing tests;
- mass balance for parent/metabolite models;
- deterministic cross-runtime parity;
- seeded uncertainty parity;
- literature landmarks for Cmax, Tmax, AUC, clearance and phase slopes;
- external concentration-time profile comparisons from published studies;
- bias/error metrics against held-out or otherwise independent data when available;
- interval-coverage/calibration tests for stochastic outputs;
- sensitivity/identifiability checks for parameters that dominate predictions;
- matrix-transform validation against paired-matrix data;
- regression reports for every result-changing release.

`externally-validated` remains a high bar. A successful parity test proves implementation
identity, not biological validity.

### E-track — Continuous evidence scouting and candidate-model triage

**Priority: runs continuously alongside S1–S6; starts immediately.**

The binding constraint on this whole program is in-domain evidence, not engineering. Every S1–S5
vertical slice is gated on finding a *reviewed published model* with the data that slice needs —
a covariance matrix (S1), a validated covariate relationship (S2), characterised formation
kinetics (S3), a non-trivial absorption profile (S4), paired-matrix data (S5). For Kinetix's
illicit/forensic catalogue those are scarce and unevenly reported, so discovery cannot be a
side effect of each phase; it must be a standing workstream that keeps a triaged candidate queue
ahead of implementation.

Work:

1. maintain a candidate-model queue per layer (S1–S5), each entry recording population, route,
   matrix, covariates, reported random-effect covariance (or its absence), residual-error model,
   and whether it was read from the full source or reconstructed from secondary reporting
   (mirrors §9's evidence-review checklist);
2. triage candidates by evidence quality and in-domain relevance, not by implementation
   convenience, and explicitly flag when the best available foundation model is out-of-domain
   (a therapeutic drug standing in for the forensic catalogue) so that risk is visible;
3. keep at least one validated candidate staged ahead of each active S-phase so a foundation
   phase never stalls waiting for evidence;
4. record, for each layer, what the catalogue *cannot* currently support, so an honest
   "insufficient evidence" is a first-class outcome rather than a silent gap.

**Exit (continuous):** no S-phase begins coding against an invented toy schema; each begins
against a real, triaged, evidence-reviewed model, and the absence of one is reported rather than
worked around.

### S8 — Registry and evidence pipeline v2

The registry must be able to author the science introduced above. Extend it to carry:

- structural parameter IDs and units;
- population and applicability window;
- parameter-distribution semantics;
- Ω/correlation matrices and covariance provenance;
- covariate functions and required subject fields;
- administration/formulation models;
- parent/metabolite network definitions;
- observation/matrix models;
- separate parameter uncertainty, IIV and residual-error definitions;
- references and evidence-quality notes per parameter/model component;
- validation datasets/landmarks and validation status.

The general Kinetix drug catalog remains a reference database, not a runnable model registry.
Where catalog data can safely author registry fields, generate them; where it cannot, require a
reviewed model-specific entry rather than synthesising one.

### S9 — Production adoption and legacy retirement

Once the scientific layers are available:

- migrate Kinetix saved scenarios/model cards to the new registry versions;
- re-vendor/pin compatible releases in Redose where the mobile product actually needs the model;
- benchmark ODE/stochastic performance on low-end devices;
- preserve old model/parameter versions for historical reproducibility;
- remove exploratory generic-fallback models from production paths where they can be replaced by
  reviewed models;
- keep explicit limitations when an analyte has insufficient data for an ambitious model.

Redose does not need to expose every Kinetix capability in its UI for `kinetics-core` to be
complete. It must, however, execute the same model version when it claims to show an equivalent
scenario.

## 7. Priority order

For allocation of scientific implementation effort after the remaining harmonization cleanup:

1. **S0: Kinetix-on-core** — eliminate the duplicate scientific path.
2. **S1: population parameter semantics + covariance** — prerequisite for realistic uncertainty.
3. **S2: covariate-driven CL/V/etc.** — largest patient-specific PK gap.
4. **S3: parent/metabolite kinetics** — unusually important for Kinetix's forensic use cases.
5. **S4: richer absorption** — important around Cmax/Tmax and route/formulation comparisons.
6. **S5: observation/matrix model** — required for defensible laboratory/forensic prediction.
7. **S6: further model families** — evidence-driven rather than speculative.
8. **S7/S8: validation + registry evolution** — continuous work, with release gates tightening as
   each layer lands.
9. **E-track: evidence scouting** — continuous, starts immediately, and paces S1–S5; a phase does
   not begin until the E-track has a triaged in-domain (or knowingly out-of-domain) candidate for
   it.

This ordering is a dependency plan, not a claim that covariance is biologically more important
than clearance. S1 must exist before covariate effects and population variability can be
represented coherently. Within S1, two semantics are prerequisites for every later layer and must
land with the first parameter contract, not after it: **parameter identifiability** (true vs
apparent `CL`/`CL/F`) and the **no-covariance fallback** (`assumed-diagonal` Ω as an explicit
unknown). Both prevent the new machinery from manufacturing precision it has not earned.

## 8. Concrete PR-sized slices

The phases above should land as reviewable scientific deltas rather than one rewrite.

| Slice | Scope | Dependency |
|---|---|---|
| SC-0A | Kinetix forward adapter uses `simulateScenario` for supported core models | current core |
| SC-0B | Lite inference calls the same deterministic core kernel | SC-0A |
| SC-0C | delete/retire duplicate forward equations after regression parity | SC-0A/B |
| SC-1A | structural parameter IDs + CL/V/Q-capable parameter contract, **with `identifiabilityBasis` and CL-vs-CL/F identity** | SC-0 |
| SC-1B | separate parameter uncertainty vs IIV schemas | SC-1A |
| SC-1C | Ω/correlation validation + seeded multivariate sampling; **`assumed-diagonal` no-covariance fallback carried as unknown** | SC-1B |
| SC-1D | uncertainty-layer toggles + manifest/result decomposition | SC-1C |
| SC-1E | scenario/input uncertainty layer (dose/purity/time/duration/adherence) | SC-1B, SC-4A |
| SC-2A | declarative covariate-function contract | SC-1A |
| SC-2B | first reviewed covariate PopPK vertical slice | SC-2A + evidence |
| SC-3A | linear parent→metabolite ODE family + mass balance | SC-1A |
| SC-3B | first reviewed parent/metabolite vertical slice | SC-3A + evidence |
| SC-3C | branching/direct-metabolite extensions | SC-3B |
| SC-4A | lag + zero-order/mixed input families | SC-0 |
| SC-4B | transit/depot/formulation context | SC-4A + evidence |
| SC-5A | latent→observed matrix-transform contract | SC-1 |
| SC-5B | residual-error layer decomposition | SC-5A |
| SC-5C | total/unbound + binding model for a concrete use case | SC-5A + evidence |
| SC-7A | external validation fixture/report format | may begin immediately |
| SC-8A | registry v2 schema for covariance/covariates/layers **+ identifiability basis + input-uncertainty semantics** | SC-1A/2A |
| E-1 | standing candidate-model queue + triage record per S1–S5 layer | may begin immediately |

### 7.1 Evidence and contract gate for the remaining families

The remaining family extensions are deliberately **not implementation-ready** merely because a
milestone name exists. They may move from unsupported to supported only in a change that includes
the reviewed vertical slice and its executable contract artifacts. In particular:

| Extension | Required before implementation |
| --- | --- |
| two-compartment `CL/Vc/Vp/Q` | An explicit absolute/apparent identifiability contract for all four structural parameters and reviewed dimensional, mass-balance, and reference-output fixtures |
| branching/direct-dose parent–metabolite and active-moiety aggregation | Stable analyte/node, transformation-stoichiometry, direct-input, and separately reported aggregation contracts, plus a reviewed real-system fixture |
| transit/depot and formulation context | Stable administration/formulation/context schema (including route-specific `F`, absorption distributions, and fed/fasted applicability) plus a reviewed route/formulation fixture |
| uncertainty-bearing observation and event timing | Stable matrix-transform, residual/input-uncertainty, sampling-window, and event-time contracts plus reviewed observation fixtures |

Until those artifacts are committed, the current structured `unsupported`/`insufficient-input`
behavior is the contract. Do not add placeholder parameter roles, infer distributions, promote a
toy model to registry provenance, or bump a version axis for an unexecutable family. The enabling
change must update composition, assembly, simulation, validation, dimensional and mass-balance
tests, registry provenance, failure behavior, and the appropriate independent version axes in one
reviewable vertical slice.

Every result-changing slice must bump the appropriate core/model/parameter version and carry a
before/after benchmark.

## 9. First scientific vertical slices

Do not choose implementation examples solely because their equations are easy. Select vertical
slices that prove the new architecture and have adequate evidence.

The first set should collectively include:

1. **a published PopPK model with covariance and at least one clinically meaningful covariate** —
   proves S1/S2;
2. **a parent→active-metabolite system with interpretable formation kinetics** — proves S3;
3. **a route/formulation with a demonstrable non-trivial absorption profile** — proves S4;
4. **an analyte with paired blood/plasma or serum/plasma data** — proves S5.

For each candidate, evidence review precedes implementation and records:

- model equations and parameterisation;
- population and sample size;
- route/formulation;
- matrix;
- covariates and coding;
- random-effect covariance;
- residual-error model;
- external validation, if any;
- whether the model was read from the full source or reconstructed from secondary reporting.

## 10. Scientific completion definition

`kinetics-core` is **not** scientifically complete merely because all Redose legacy models have
been migrated.

The core reaches the intended architecture when all of the following are true:

- [ ] Kinetix forward simulation executes the shared core rather than a duplicate PK engine.
- [ ] Kinetix Lite inference uses the same deterministic model implementation for supported
      model families.
- [ ] The model contract explicitly composes administration, disposition, observation and
      variability layers.
- [ ] Reviewed models can be parameterised by CL/V/Q and derive half-life/phase quantities where
      appropriate.
- [ ] Correlated IIV with an Ω/covariance matrix is supported and distinct from parameter
      uncertainty, and an absent covariance is carried as an `assumed-diagonal` unknown rather
      than as measured independence.
- [ ] Structural parameters carry an `identifiabilityBasis`; `CL/F`/`V/F` are modelled as
      identities distinct from `CL`/`V` and are never exposed as absolute without an IV anchor or
      independently supported `F`.
- [ ] Scenario/input uncertainty (dose, purity/active-moiety, time/window, duration, adherence)
      is a first-class variability layer, separately reportable from IIV and observation error.
- [ ] Model-declared covariate effects can alter CL/V/Q/ka/F or other parameters.
- [ ] At least one externally reviewed covariate PopPK model is implemented end-to-end.
- [ ] A general parent/metabolite model family is implemented and validated on at least one
      real system.
- [ ] The administration layer supports more than first-order absorption/IV infusion, with at
      least one evidence-backed richer absorption model in production.
- [ ] The observation layer can distinguish latent and measured matrix and propagate conversion
      / analytical uncertainty where data exist.
- [ ] Parameter uncertainty, IIV, residual biological variability and analytical uncertainty are
      separately representable and reported.
- [ ] Every production model declares population, route, matrix, parameter/covariate provenance,
      variability semantics and validation status.
- [ ] External validation/benchmark evidence exists for every model claiming more than
      `literature-derived` status.
- [ ] Historical runs remain reproducible by core/model/parameter/registry version.

## 11. Explicit non-goals

The following are **not** required to call the portable core scientifically mature:

- fitting arbitrary NLME models in the browser;
- replacing NONMEM/Monolix/Pumas/Stan as a population-model estimation environment;
- a generic whole-body PBPK platform;
- automatically inferring causal genotype/DDI/organ-failure effects from a concentration;
- applying one postmortem redistribution multiplier to living PK and calling it a postmortem
  model;
- implementing every possible absorption or binding equation before a reviewed drug requires it.

Ambition here means representing the major sources of PK structure and variability correctly,
not maximizing equation count.

## 12. Relationship to existing plans

- The **July 21 master architecture remains normative**. This document operationalises the
  scientific layers that were defined there but not scheduled after migration.
- The **July 23 completion plan remains the migration/parity plan**. Its definition of done is
  renamed conceptually to *harmonization complete*, not *kinetics-core scientifically complete*.
- `docs/plans/modelling-trust-release.md` remains the history of the Kinetix modeling trust work.
  Its unfinished items on variability semantics and matrix/residual-error decomposition now feed
  S1 and S5 here rather than floating as unowned follow-ups.
- The Case Pattern / metabolite-ratio work is complementary forensic interpretation tooling. It
  must not be mistaken for the mechanistic parent/metabolite PK family planned in S3.

## 13. Immediate next work

1. Land the documentation/roadmap realignment.
2. Complete or explicitly close the remaining July 23 harmonization migration items.
3. Start **SC-0A**: wire the Kinetix forward modeling path onto `kinetics-core`.
4. Stand up the **E-track** candidate queue (E-1) so evidence selection is continuous rather than
   per-phase, and can flag when the only available foundation model is out-of-domain.
5. In parallel, perform evidence selection for the first **S1/S2 PopPK vertical slice** so the
   parameter/covariate contract is designed against a real published model rather than an
   invented toy schema. Design **SC-1A** so that parameter identifiability (`CL` vs `CL/F` +
   `identifiabilityBasis`) and the **no-covariance fallback** (`assumed-diagonal` unknown Ω) are
   in the contract from the first commit, not retrofitted, and scope **SC-1E** (scenario/input
   uncertainty) alongside it.
6. Do the same evidence selection for the first **S3 parent/metabolite** and **S5 matrix**
   vertical slices before those families are coded.
