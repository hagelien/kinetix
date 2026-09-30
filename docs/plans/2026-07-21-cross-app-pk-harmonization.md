# Cross-application pharmacokinetic architecture — master specification

**Status:** adopted architecture; implementation in progress  
**Original date:** 2026-07-21  
**Amended:** 2026-08-18  
**Primary repository / scientific governance:** `hagelien/kinetix`  
**Current implementation:** `src/lib/kinetics-core/`  
**Migration plan:** [`2026-07-23-harmonization-completion.md`](./2026-07-23-harmonization-completion.md)  
**Scientific completion plan:** [`2026-08-18-kinetics-core-scientific-completion.md`](./2026-08-18-kinetics-core-scientific-completion.md)

## 1. Decision

Kinetix is the governance home for pharmacokinetic and statistical science shared by Kinetix and
Redose.

The executable source of truth is a versioned, platform-neutral core owned by this repository,
not the Kinetix UI, a web worker, an API route, Redose hooks, or mutable drug-database rows. The
implementation currently lives under `src/lib/kinetics-core/`; whether it is later extracted to
a separately published workspace/package is a distribution decision, not a scientific one.

Both applications may have different workflows, warnings and presentation, but equivalent
scenarios using the same model version must execute the same scientific model.

KineLab/full-remote remains a distinct advanced inference engine where appropriate. That does
not reduce the scientific ambition of the portable forward core: `kinetics-core` must be able to
**execute** reviewed population-PK models, covariate functions, covariance structures,
parent/metabolite models and observation models even when estimation of those models happens in
NONMEM/Monolix/Pumas/Stan/KineLab or another external environment.

## 2. Two programs, one architecture

The work has two separate completion concepts.

### 2.1 Cross-app harmonization

The harmonization program consolidates the strongest reviewed Kinetix/Redose implementations,
locks them with parity fixtures and removes duplicate scientific paths. During that migration,
the governing rule is:

> Port reviewed behavior faithfully, or document an approved scientific change. Do not invent a
> new mechanistic model merely to make two repositories agree.

The July 23 plan owns this work.

### 2.2 Scientific completion

Harmonization is not the endpoint. The core is intended to implement the four-layer model
architecture defined in this specification:

1. administration/input;
2. disposition;
3. observation;
4. variability.

The August 18 scientific-completion plan turns those layers into concrete phases for
covariate-driven clearance, correlated population variability, parent/metabolite kinetics,
richer absorption and matrix-aware observation models.

The migration rule above must never be read as "kinetics-core may only contain models that were
already present in Redose." New reviewed science is expected after parity has been secured.

## 3. Required outcome

For any capability implemented by the portable shared core:

> Given the same canonical analyte(s), dose events, routes/formulations, subject covariates,
> observation model, model version, parameter-set version, solver configuration, time grid,
> variability configuration, random seed and draw count, Kinetix and Redose must return the same
> unrounded canonical result within the model's declared numerical tolerance.

This promise excludes:

- display rounding and unit formatting;
- chart styling and interaction;
- application-specific warnings/notifications that do not alter the scientific model;
- a deliberate comparison between different model or parameter-set versions;
- Kinetix runs explicitly performed by a separate advanced engine such as `full-remote`.

An application must not silently fall back to a different model when the requested model cannot
run.

## 4. Ownership boundaries

| Concern | Source of truth / owner |
|---|---|
| Deterministic PK equations | `kinetics-core` |
| Portable ODE solver and numerical policy | `kinetics-core` |
| Administration, disposition and observation transforms | `kinetics-core` |
| Parameter sampling / forward uncertainty propagation | `kinetics-core` |
| Population parameter sets, covariance and model-declared covariate functions | versioned Kinetix model registry executed by `kinetics-core` |
| Canonical units and scenario/result contracts | `kinetics-core` |
| Model cards, parameter provenance and validation claims | versioned Kinetix model registry |
| References, evidence review and scientific governance | Kinetix |
| Cross-runtime and biological validation evidence | Kinetix release process, with consumer CI participation |
| Kinetix modeling UI and forensic workflows | Kinetix application |
| Redose logging, local storage, graph UX, warnings and notifications | Redose application |
| Fitting hierarchical population models / HMC/NUTS / expensive model comparison | KineLab/full-remote or external modelling environment |
| Postmortem-specific inference not defensible as ordinary living PK | separate reviewed engine/model family, generally KineLab/full-remote |

A Kinetix drug-monograph row is not automatically a runnable model. General reference values,
route/formulation-specific model parameters, population definitions, covariance, observation
rules and validation evidence are different concepts and must remain distinguishable.

## 5. Target architecture

```text
                    Kinetix scientific governance
       evidence review · model review · validation · release approval
                                  |
                                  v
                  immutable model-registry release
                                  |
                                  v
                         kinetics-core
       contracts · units · administration · PK state models · ODE
       covariates · variability · observation · statistics · manifests
                      /                           \
                     v                             v
            Kinetix adapters                   Redose adapter
        UI / worker / Lite inference          local mobile workflow
                     |                             |
                     v                             v
         forensic/clinical presentation        live presentation

          KineLab / external PopPK estimation environments
                     |
       reviewed model + parameter/covariance output
                     |
                     v
              Kinetix registry governance
```

### 5.1 One deterministic forward kernel

Every supported model exposes one deterministic forward calculation conceptually equivalent to:

```ts
simulateDeterministic({
  model,
  parameterValues,
  doseEvents,
  subject,
  observation,
  timeGrid,
  numericalOptions,
}): DeterministicResult
```

This is the mathematical base for:

- Redose live concentration curves;
- Kinetix forward Monte Carlo;
- Kinetix Lite inverse inference likelihoods;
- posterior/predictive calculations when the selected engine uses this model;
- validation and parity fixtures.

No application worker, hook or UI component may contain a second implementation of the same
scientific equation. Anti-drift tests are transitional protection, not the desired final
architecture.

## 6. Model composition: four required layers

A runnable model explicitly composes four layers. This is a **completion requirement**, not an
aspirational list of optional future features.

### 6.1 Administration/input model

The layer identifies how each dose enters the system. The architecture must be able to express,
as reviewed models require them:

- IV bolus and infusion;
- first-order absorption;
- absorption lag;
- zero-order input over a duration;
- mixed/parallel zero- and first-order input;
- transit-compartment absorption;
- IM/SC depot models;
- inhaled/pulmonary or other route-specific input models;
- formulation and administration context such as fed/fasted state;
- route-specific bioavailability;
- salt/base/parent/active-moiety dose basis and conversion.

Each dose event has its own administration model. The first dose must never silently determine
the route/absorption model for later doses.

### 6.2 Disposition model

The layer identifies what happens after systemic input. Supported and planned families include:

- one-compartment linear;
- IV one-compartment;
- two-compartment linear;
- Michaelis–Menten / capacity-limited elimination;
- parent/metabolite and multi-metabolite networks;
- additional reviewed multicompartment/nonlinear state models;
- time-dependent clearance/enzyme models where the evidence requires them.

The core is not required to become a universal PBPK simulator. New structural families are added
for concrete reviewed use cases.

### 6.3 Observation model

The state being simulated and the specimen measured by a laboratory are not necessarily the same
quantity. The observation layer can describe:

- model/latent matrix and measured matrix;
- plasma/serum/whole-blood transformations with uncertainty;
- total versus unbound concentration;
- binding models where they materially matter;
- analytical measurement error;
- preanalytical/stability uncertainty;
- residual biological/structural error;
- event/sampling-time uncertainty;
- censoring (`<LOD`, `<LOQ`, etc.).

A matrix string without a transformation/error model is not sufficient when the model state and
measurement differ.

### 6.4 Variability model

The variability layer keeps scientifically different uncertainty sources distinct:

- population fixed-effect / parameter-estimate uncertainty;
- interindividual variability (IIV/BSV);
- interoccasion variability where available;
- correlated random effects / Ω covariance;
- residual biological/model variability;
- analytical uncertainty;
- **scenario/input uncertainty** — uncertain dose, purity/active-moiety amount, administration
  time/window, infusion or exposure duration, and adherence — as a first-class layer distinct
  from IIV and observation error.

Scenario/input uncertainty is not a subspecies of analytical or population variability: it is
uncertainty about what actually happened to the subject, and for forensic reconstruction and
harm-reduction use it routinely dominates assay and person-to-person variance. It is therefore
sampled and reported as its own layer, not folded into the observation model.

The user/application may request a combined predictive distribution, but the run manifest must
state which layers were active.

## 7. Parameterisation and derived PK quantities

Reviewed population models should preferentially carry their actual structural parameters, for
example:

- CL;
- Vc/V1;
- Vp/V2;
- Q or compartmental microconstants;
- ka/tlag/input parameters;
- F;
- Vmax/Km;
- metabolite formation/elimination parameters.

When those are known, quantities such as `ke`, AUC, terminal half-life, accumulation and
α/β macroconstants are derived outputs rather than independently sampled primitives.

Direct half-life parameterisation remains valid for evidence-limited or legacy models, but the
registry must identify it as such. The core must not combine an independently sampled half-life
and Vd and present the combination as a physiological CL/V population model.

**True versus apparent parameters are distinct identities, not just provenance.** For a model
fitted only to extravascular data, clearance and volume are estimable solely as the apparent
quantities `CL/F` and `V/F`; `CL` and `V` are not separable from bioavailability without an IV
reference or an independently supported `F`. The contract must therefore treat `CL` and `CL/F`
(and `V` and `V/F`, `Q` and `Q/F`) as **different parameter identities**, never as the same
parameter carrying a different note. A model must never silently promote apparent clearance to
physiological clearance: doing so manufactures false precision exactly where the trust-release
discipline forbids it. Each structural parameter carries an `identifiabilityBasis` — at least
`iv-anchored`, `absolute-f-supported`, `apparent-extravascular`, or `derived` — and the core
refuses to expose an absolute `CL`/`V` from a parameter whose basis is `apparent-extravascular`.
This matters acutely for Kinetix's catalogue, whose substances are predominantly extravascular
with no IV reference, so `CL/F` is the common case and absolute `CL` the exception.

## 8. Population variability and covariance

A population parameter set may include:

- population fixed effects;
- parameter-estimate uncertainty;
- parameter transforms and constraints;
- IIV random effects;
- Ω covariance/correlation matrices;
- model-declared covariate functions;
- residual-error model.

Where covariance is published, parameters are sampled jointly. Where it is unavailable,
independent exploratory sampling may be used only as an explicit assumption.

**"Covariance not reported" is not "covariance = 0."** When only marginal IIV is available, the
core may sample with a diagonal Ω, but that diagonal is a labelled assumption of convenience, not
a finding of independence, and the manifest records the correlation structure as *unknown* rather
than as *zero*. The absence of a reported covariance must never be presented as evidence that the
random effects are uncorrelated — an omitted off-diagonal and a measured-zero off-diagonal are
different scientific claims, and only a covariance actually reported by the source may be shown as
one. A reviewed model that asserts independence must cite it; every other diagonal Ω is provenance
`assumed-diagonal`.

A literature min/max is not automatically a probability distribution. The registry must record
whether bounds are observed extrema, confidence/credible intervals, quantiles, prediction
intervals or something else before those values are used stochastically in a reviewed model.

## 9. Subject covariates

Covariates change PK parameters only when the selected reviewed model declares the relationship.
No generic organ-failure or demographic multiplier is applied across drugs.

The covariate system must be able to represent common published PopPK forms such as:

- allometric body-size scaling;
- lean-body-mass/body-water scaling;
- continuous power/linear functions;
- categorical multipliers;
- renal-function effects on clearance;
- hepatic-function effects;
- age/maturation functions;
- genotype/phenotype effects;
- explicitly modelled drug-interaction effects.

The canonical subject schema evolves when real models require new fields. Numeric renal-function
measures, genotype/phenotype and pregnancy context should be added because a reviewed model
consumes them, not because they are theoretically interesting.

Unsupported covariates are reported as unused. Missing required covariates cause an explicit
insufficient-input/unsupported result unless the model declares a validated reference default.

## 10. Parent/metabolite and active-moiety models

Parent/metabolite kinetics are a first-class core capability, especially for Kinetix's forensic
use cases.

The architecture must support:

- separate parent and metabolite state parameters;
- formation rate/clearance/fraction/yield;
- branching pathways;
- molar/mass stoichiometry;
- first-pass formation where applicable;
- direct administration of a metabolite;
- multiple observed analytes from one scenario;
- metabolite-specific covariates;
- active-moiety aggregation as a derived output while retaining each analyte curve.

A prodrug represented by a single surrogate active-moiety curve may remain a valid reviewed
approximation, but it must be labelled as that approximation. It does not satisfy the general
parent/metabolite capability by itself.

The Case Pattern / metabolite-ratio tooling is complementary descriptive forensic evidence; it
is not a substitute for a mechanistic formation/elimination model.

## 11. Canonical scenario contract

The versioned scenario contract must be able to contain, as applicable:

- schema version;
- stable administered substance, analyte and active-moiety IDs;
- model ID/version and parameter-set ID/version;
- dose events with time, route, formulation/context, amount, dose unit, basis and purity;
- subject covariates consumed by the selected model;
- observation matrix/representation and concentration unit;
- requested analyte(s) and result quantities;
- time grid;
- solver method and numerical settings;
- enabled variability/error layers;
- random seed/draw count for stochastic execution.

Identifiers must be durable. Language-specific slugs may be aliases but not the sole model
identity.

## 12. Canonical result and run manifest

Every run returns a common result shape containing as applicable:

- deterministic and/or percentile concentration-time series;
- multiple analyte curves for network models;
- requested point estimates;
- peak, Tmax, AUC or other derived quantities calculated from the same model state;
- canonical/display units;
- attempted, accepted and rejected draws;
- robustness/ESS diagnostics where meaningful;
- structured warnings and structured non-result errors;
- assumptions and limitations;
- parameter/covariate/observation provenance;
- model validation status.

The manifest records at least:

- core version;
- model version;
- parameter-set version;
- registry release/checksum;
- solver and numerical settings;
- scenario input hash;
- random seed and draw count;
- enabled variability/error layers;
- matrix/observation transformations;
- generated timestamp;
- application/build version where supplied.

Historical cases remain tied to the versions that produced them.

## 13. Numerical failure policy

The core never converts a non-finite state, invalid covariance, solver failure or unsupported
scenario into a plausible concentration curve.

Return structured failure for, among other things:

- invalid/nonphysical parameters;
- non-positive-definite or malformed covariance;
- solver divergence;
- violated matrix/observation policy;
- unsupported administration/model family;
- missing molecular weight for required molar conversion;
- missing required covariate;
- unsupported dose basis/active-moiety conversion;
- invalid parent/metabolite mass balance;
- statistically non-robust inference when the selected inference engine requires a robustness
  threshold.

Applications may choose presentation, but may not silently substitute a different model.

## 14. Model registry

The model registry is distinct from the general drug catalog.

A runnable model definition records:

- stable model and parameter-set IDs;
- administered substance/analyte/active-moiety identities;
- model family and implementation version;
- administration/formulation/context definitions;
- supported matrices and observation transforms;
- population and applicability window;
- required/optional covariates;
- structural parameter definitions and units;
- distribution semantics and parameter-estimate uncertainty;
- IIV/IOV definitions and covariance where available;
- residual/error model;
- parent/metabolite network where applicable;
- solver requirements;
- references and evidence-quality notes per relevant component;
- literature/validation landmarks and datasets;
- assumptions, limitations and failure conditions;
- validation status.

Suggested validation states remain:

```text
experimental
literature-derived
internally-benchmarked
externally-validated
```

`externally-validated` must never be inferred merely from the presence of references or
cross-runtime parity. Population, route, matrix, exposure window, predictive error/calibration
and known failure modes must be documented.

Production applications consume immutable registry releases, not mutable live database values.

## 15. Independent versioning

Keep separate version axes:

1. **core version** — contracts, numerical implementation, generic model families and statistics;
2. **model version** — mathematical structure for an analyte/route/matrix/population;
3. **parameter-set version** — numeric population parameters, covariance, covariates and
   observation/error values;
4. **registry release** — immutable set of approved model/parameter versions.

Rules:

- contract-breaking API changes require a core major version;
- backward-compatible core capabilities require a core minor version;
- implementation fixes without intended scientific change require a core patch;
- equation/compartment/observation-structure changes require a model version change;
- reviewed parameter/covariate/covariance changes require a parameter-set version change;
- every intended result-changing change requires before/after benchmark output and release
  notes.

## 16. Validation gates

### 16.1 Equation and dimensional tests

- dimensional consistency;
- analytic reference cases where available;
- no concentration before administration;
- nonnegative physical states where applicable;
- linear dose proportionality/superposition where the model claims linearity;
- correct limiting behaviour;
- correct route/matrix/dose-basis rejection.

### 16.2 ODE and state-model validation

- step-size/tolerance convergence;
- event handling at exact dose/observation times;
- mass balance where meaningful;
- peak/Tmax/AUC convergence, not only sampled time points;
- structured failure on non-finite states;
- solver configuration in fixtures/manifests.

### 16.3 Statistical validation

- deterministic seed and draw ordering;
- covariance validation and correlated-sampling tests;
- attempted/accepted/rejected draw accounting;
- uncertainty layer names match their statistical meaning;
- parameter uncertainty, IIV and residual error can be tested separately;
- interval coverage/calibration where a model makes a probabilistic claim;
- inference SBC/coverage in KineLab/full-remote where applicable.

### 16.4 Biological/literature validation

Each production model should define applicable targets such as:

- Cmax/Tmax;
- early distribution slope;
- terminal phase;
- AUC/clearance;
- accumulation;
- dose nonlinearity;
- metabolite formation/ratio landmarks;
- concentration behaviour in its declared matrix/population.

Where possible, compare against published concentration-time data independent of the parameter
source and report bias/error/coverage. Landmark tests prevent absurd regressions but do not by
themselves constitute external validation.

### 16.5 Cross-runtime parity

The same canonical fixtures run in:

- Kinetix Node/V8 tests;
- Kinetix browser/worker integration;
- Redose's relevant JS/Hermes test target when the model is consumed there.

Parity proves the same implementation is running. It does not prove the model is biologically
correct.

## 17. Release and rollback

A result-changing release produces:

- version/checksum;
- immutable registry artifact;
- changelog;
- before/after benchmark report;
- validation/fixture results;
- migration notes where a consumer changes model version;
- known limitations.

Rollback must be possible by pinning the previous core/model/parameter/registry version. Saved
Kinetix cases and Redose sessions keep their original manifests.

## 18. Implementation programs

### 18.1 Harmonization milestones K0–K9

The original K0–K9 sequence established contracts/primitives, the shared registry, parity and the
model migration waves. Detailed current migration status now lives in the July 23 plan rather
than being duplicated here.

Its completion criterion is **no duplicate legacy science for equivalent migrated scenarios**.

### 18.2 Scientific completion S0–S9

The scientific continuation is defined in the August 18 plan:

- **S0:** Kinetix forward + Lite inference execute the shared core;
- **S1:** CL/V/Q-capable parameter semantics, separate variability layers and covariance;
- **S2:** model-specific covariate functions affecting CL/V/Q/ka/F/etc.;
- **S3:** parent/metabolite and active-moiety kinetics;
- **S4:** richer absorption/administration models;
- **S5:** matrix/observation/error models;
- **S6:** additional evidence-driven model families;
- **S7:** external validation/calibration platform;
- **S8:** registry/evidence schema v2;
- **S9:** production adoption and legacy/fallback retirement.

Running alongside them is a continuous **evidence-scouting track (E-track)**: candidate-model
discovery and triage feeding S1–S5, so each scientific layer is designed against a real published
model rather than an invented toy schema. The binding constraint on this program is in-domain
evidence, not engineering, and the E-track exists to keep that constraint from stalling a
foundation phase (see the August 18 plan).

These are not optional embellishments. They operationalise the architecture this document has
specified since July 21.

## 19. Definition of done

### 19.1 Harmonization complete

For equivalent migrated scenarios:

- [ ] one deterministic implementation is executed;
- [ ] no duplicate Redose equation/parameter set remains;
- [ ] model/parameter IDs and fixtures agree across consumers;
- [ ] numerical failures are structured non-results;
- [ ] historical versions remain reproducible.

### 19.2 kinetics-core scientifically complete

The intended master architecture is reached when:

- [ ] Kinetix forward simulation executes the shared core rather than a duplicate engine;
- [ ] Kinetix Lite inference uses the same deterministic core model for supported families;
- [ ] administration, disposition, observation and variability are explicit composable layers;
- [ ] reviewed models can use CL/V/Q-style structural parameterisation and derived half-life /
      α/β quantities;
- [ ] correlated IIV/Ω covariance is supported separately from fixed-effect uncertainty, and an
      absent covariance is carried as *unknown* (labelled `assumed-diagonal`), never as measured
      independence;
- [ ] structural parameters carry an `identifiabilityBasis`, and apparent `CL/F`/`V/F`/`Q/F` (every
      disposition parameter, not only clearance and volume) are never exposed as absolute
      `CL`/`V`/`Q` without an IV anchor or independently supported `F`;
- [ ] scenario/input uncertainty (dose, purity/active-moiety, time/window, duration, adherence)
      is a first-class variability layer, separately reportable from IIV and observation error;
- [ ] model-declared covariates can modify clearance/distribution/absorption parameters;
- [ ] at least one real covariate PopPK model is implemented and validated end-to-end;
- [ ] a general parent/metabolite model family exists and is validated on a real system;
- [ ] richer administration than first-order absorption/IV infusion is supported and used by at
      least one reviewed model;
- [ ] latent and measured concentration/matrix are distinct and observation uncertainty can be
      propagated;
- [ ] every production model declares population, route/formulation, matrix, parameter and
      variability provenance plus validation status;
- [ ] external validation evidence supports every model claiming more than
      `literature-derived` status;
- [ ] model/core/parameter/registry versions make historical runs reproducible.

## 20. Current next work

The original 2026-07-21 "first implementation PR" instructions are historical; those scaffold
milestones have already been overtaken by the current core.

The current sequence is:

1. finish or explicitly close the remaining July 23 migration items;
2. start **SC-0A**: wire Kinetix forward modeling onto `kinetics-core`;
3. start **SC-0B**: use the same deterministic kernel in Lite inference;
4. select a real published PopPK model to drive S1/S2 contract design;
5. select evidence-backed parent/metabolite and matrix-observation vertical slices;
6. implement the SC-* scientific-completion sequence rather than treating Redose legacy
   retirement as the end of kinetics-core development.
