# kinetics-core — catalog-driven model coverage (family at the data level)

**Status:** active — CV-1 → CV-4 primitives, the CV-2c route-key contract/schema/`ka` write-path, the CV-4c-1 definition assembler, the CV-2c-5 route-keyed read adapter, the CV-4c-2a canonical-value read, the CV-4c-2b-a per-drug definition read, the CV-4c-2b-b-1 catalog snapshot builder, CV-4c-2b-b-2 (generation script + committed checksummed artifact), CV-2c-6 (`ka` inferred from a route-scoped `tmax`), CV-2c-7 (the attributed oral route, which takes the derived tier from 2 models to 174) and CV-2c-8 (curating more never takes a curve away) landed; next is the CV-5 rollout (`VITE_DERIVED_REGISTRY_ENABLED`, which today leaves the whole derived tier unresolvable), then continued per-route `tmax`/`F` curation and the §5.2 decision for the derived tier
**Date:** 2026-08-21
**Builds on:** [`2026-08-18-kinetics-core-scientific-completion.md`](./2026-08-18-kinetics-core-scientific-completion.md) · roadmap [`../kinetics-core/roadmap.md`](../kinetics-core/roadmap.md) → *Registry evolution*

---

## 1. Problem

The engine can only simulate a curated set of drugs today. That is **not** a limit of the math —
it is a wiring choice: `forwardCoreAdapter.ts` reads parameters from the pinned registry keyed by
analyte (a scenario carries no half-life/Vd/F/ka), and `simulate.ts` fails any analyte not in the
hand-authored registry with `insufficient-model-data`.

Two facts change the calculus:

1. **The live DB already has the parameters.** The Neon parameter store tracks `ka`, `vd`,
   `clearance`, `eliminationRate`, `bioavailability`, `fraction`, `proteinBinding`, `tmax`, `cmax`
   — each `min`/`max`/`median` + unit + provenance/citations. (`data/components.ts` is now only an
   offline fallback.)
2. **Exactly one thing cannot be auto-derived from parameters: the model family.** A half-life
   implies first-order elimination — but ethanol is zero-order, GHB mixed-order, some drugs are
   two-compartment, others have an active metabolite. Picking wrong is *qualitatively* wrong.

**Approach:** make the **model family a first-class, cited property of the drug (and its routes)**,
then derive **graded, disclaimed** models for the whole catalog — while keeping the roadmap's rule
intact: *missing model science stays missing, never manufactured.*

## 2. Principles

- **Missing stays missing.** An unknown family or an unsupported axis combination surfaces as
  **not-modelable**, never a guessed curve. *Amended by the owner, 2026-09-29:* an input with a **cautious default** runs on it, labelled,
  instead of producing no curve. Only bioavailability has one — concentration is proportional to F
  at every time, so F = 1 bounds the curve from above everywhere. §5.1 already grades that case
  (completeness C for one conservative default). `ka`, a half-life and a volume stay missing:
  none bounds the curve from one side at every time (a faster `ka` raises the peak but lowers late
  concentrations). See CV-2c-9.
- **A default is a disclosed assumption.** Unstated ⇒ linear one-compartment, flagged and graded —
  never presented with the authority of a reviewed model. *(Founder decision, 2026-08-21.)*
- **kinetics-core stays the authority.** The DB holds the *declaration*; the engine validates which
  families exist, what each requires, and coherence.
- **Reproducibility survives.** The offline consumer pins a checksum, so a **versioned snapshot**
  remains the unit of reproducibility — now *derived* rather than hand-written.

## 3. Data model — family as orthogonal, cited axes

Store the family as three **orthogonal, individually-cited axes**, not the engine's flat 8-value
enum:

- **Drug-level:** `disposition` (one-/two-compartment); `elimination` (first-order / michaelis-menten
  / clv-structural); `structuralLinks` (e.g. a parent→metabolite relationship).
- **Drug × route-level:** `absorption` (bolus / iv-infusion / first-order / zero-order / mixed /
  transit). `bolus` and `iv-infusion` are the two IV inputs (instantaneous vs constant-rate into
  the central compartment, no F); `iv-infusion` additionally requires a duration. So the persisted
  categorical vocabulary must match `AbsorptionKind`, or an IV infusion would be forced to `bolus`
  and lose its duration requirement.

Each axis value carries the same envelope as a PK parameter (`status`: asserted-cited / defaulted /
unknown; provenance/citations). **Founder decision (2026-08-21):** these live as **categorical
parameter kinds in the parameter-entries store**, inheriting its ranged values, provenance and
review workflow.

Family → required-parameter coupling is validated against the **implemented** route-param
contracts, not an idealised one — e.g. the saturable (Michaelis–Menten) family needs Vmax/Km **and**
still carries a nominal `eliminationHalfLife` (display/horizon); the current two-compartment family
needs `k12`/`k21` and a **central V1** (distinct from a generic steady-state Vd) — the structural
`Vp`/`Q` form is not yet implemented (see roadmap). `kinetics-core` owns this validation
(`requiredParametersFor`), so a "complete" declaration is always one the engine can actually run.

## 4. Derivation — compose axes → engine family

`composeModelFamily(structure)` composes `(disposition × elimination × absorption)` into a
`ModelFamily`; combinations the engine does not implement resolve to **`unsupported`** with a reason
(surfaced, not forced). **(Landed in CV-1a.)**

### 4.1 Approved semantics for dose-dependent elimination (pharmacometrics review gate)

**Pharmacometrics decision (2026-08-26): dose dependence is not a selector heuristic.** A reviewer
must approve one of the following three representations for each analyte, route, population and
matrix. The choice, equations, parameter evidence and validation domain are part of the reviewed
model declaration, not facts inferred from a therapeutic/toxic dose band:

1. **One mechanistic mixed/saturable model (preferred when supported).** Use one continuous state
   model across the reviewed domain. The currently implemented elimination law is
   `dA/dt = input(t) - Vd * Vmax * C/(Km + C)`, with `C = A/Vd`, `Vmax` in
   concentration/time and `Km` in concentration. Equivalently, the amount elimination rate is
   `Vd * Vmax * C/(Km + C)`. It approaches first order (`Vmax/Km * C`) as `C → 0` and zero order
   (`Vmax`) as `C/Km → ∞`; there is no numerical family switch at `Km`. A different mechanistic
   law (capacity-limited metabolism with parallel renal clearance, auto-inhibition, target-mediated
   disposition, etc.) is a different reviewed family and MUST NOT be encoded by relabelling this
   equation.
2. **Separate dose-range-specific models.** This is allowed only when the publications fit and
   validate distinct models/parameter sets and do not support a shared mechanism. Each model owns a
   closed dose interval, concentration interval, route, formulation, population and matrix. Adjacent
   models may meet at a single boundary only if the reviewer records a continuity test showing that
   concentration and amount are continuous there and the two predictions agree within a declared
   tolerance over a predeclared overlap dataset. The engine MUST NOT interpolate parameters, blend
   curves or switch models during one simulated exposure. Overlapping intervals without a declared
   precedence rule, a gap, or a failed continuity test makes the transition explicitly unsupported.
3. **Explicitly unsupported transition.** Use this when nonlinearity is reported but its equation,
   parameters, transition domain or external validation is inadequate. Linear models may remain
   available wholly inside their own validated ranges; no curve crosses the unsupported interval and
   no lower- or higher-dose model is extrapolated through it.

The review record is indivisible and must contain all of the following before `model-structure.ts`,
assembly or the registry schema gains a representation:

- the structural and observation equations, initial conditions, covariates, residual-error model,
  numerical units, and whether `Vmax` is an amount/time or concentration/time quantity;
- parameter provenance at the **parameter level** (citation, table/figure/page or supplemental model
  file, estimate vs fixed/prior-derived value, population, matrix, route/formulation, uncertainty and
  covariance). A value inherited from Redose is a harmonisation baseline, not literature provenance;
- validated administered-dose and observed-concentration intervals. These are empirical-domain
  metadata, not therapeutic/toxic/lethal interpretation bands, and both limits are required because
  dose alone does not identify where a saturable process operated;
- internal qualification (estimation dataset, diagnostics and predictive checks) and an independent
  external validation dataset with subject/exposure counts, sampling design, endpoints, acceptance
  criteria and results. A dataset used to estimate `Vmax`/`Km` is not external validation;
- for range-specific models, the overlap/gap, boundary ownership, concentration-and-amount
  continuity result, tolerance and the dataset on which it was tested; and
- limitations shown to the user, including excluded populations/covariates, route/formulation and
  matrix restrictions, interaction or repeated-dose assumptions, extrapolation status, and whether
  a nominal half-life is display/horizon metadata rather than an elimination parameter.

**Selection contract.** Selection uses the complete planned regimen and its predicted concentration
envelope, not just the first dose. Exactly one reviewed declaration must contain both envelopes. A
mechanistic declaration remains the same family on either side of its transition but is modelable
only while both envelopes remain within its validation domain. A range-specific declaration is
selected only when the whole simulation stays inside its domain. At a shared closed boundary, the
recorded precedence rule is deterministic; within a validated overlap, the reviewer-declared
precedence applies and is disclosed. If the input or any uncertainty trajectory approaches the edge
(within the declaration's recorded guard band), the curve may render but carries a prominent
`near-validation-boundary` limitation. If it crosses an edge, spans two range models, falls in a gap,
or lies in an ambiguous overlap, the result is `not-modelable: unsupported-dose-dependent-transition`.
Clamping, nearest-model fallback and silent linear extrapolation are forbidden. After a simulation,
an out-of-domain trajectory invalidates the result rather than being trimmed.

The user sees the selected equation/family, validation dose and concentration ranges, provenance and
validation status. Near an edge the UI identifies the approached edge and guard band. Outside it the
UI shows no curve and states which regimen/trajectory range exceeded which reviewed range, that the
dose-dependent transition is unsupported, and that the absence is a model-evidence limitation rather
than evidence that the exposure is safe.

#### Representative-analyte disposition of the current evidence

| Analyte                  | Supporting equation and current parameter provenance                                                                                                                                                                                                                                                                                 | Applicable ranges and validation datasets                                                                                                                                                            | Approved catalogue semantics now                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ethanol                  | The override uses the single Michaelis–Menten equation above: `Vmax = 169.8 mg/L/h`, `Km = 80 mg/L`, Widmark volume, oral `F = 0.85`; these are unit-converted Redose legacy values attributed only at model level to Widmark/Holford (1987). The nominal 6 h half-life does not drive elimination.                                  | No review record currently pins dose limits, whole-blood concentration limits, an estimation dataset, an external validation dataset or a boundary guard band. Fed/fasted absorption is also absent. | Keep the reviewed override as a **harmonisation baseline**, not a catalog-derived validated transition. It must disclose unvalidated range and may not authorize extrapolation or seed general registry fields until the missing record is approved.                          |
| GHB                      | The override uses the same equation: `Vmax = 49.98 mg/L/h`, `Km = 40 mg/L`, `Vd = 0.4 L/kg` lean-body-mass-scaled, oral `F = 0.60`; values are unit-converted from Redose and attributed at model level to Brenneisen (2004). The nominal 1.2 h half-life is horizon/display only.                                                   | No approved human dose/concentration domain, parameter-level source locations, external dataset, repeated-dose qualification or transition guard band is recorded.                                   | Same disposition as ethanol: retain only as a disclosed, literature-derived override; do not treat `Km` as an automatic selection threshold. Outside a subsequently reviewed domain the transition is explicitly unsupported.                                                 |
| MDMA                     | The override approximates CYP2D6 auto-inhibition with the same static equation (`Vmax = 6.0 mg/L/h`, `Km = 0.25 mg/L`, `Vd = 6.5 L/kg`, oral `F = 0.70`), inherited from Redose and attributed at model level to de la Torre (2004). This is not a time-varying enzyme mechanism; the nominal 8 h half-life is display/horizon only. | No approved dose/concentration interval, genotype/interaction domain, parameter covariance, external validation dataset or guard band is recorded.                                                   | Mark the nonlinear transition **explicitly unsupported for catalog derivation**. The legacy override remains visible with the approximation limitation, but a reviewer must either validate this static surrogate or approve a new auto-inhibition family before broader use. |
| Phenytoin (control case) | Published nonlinear elimination is not enough by itself: this repository has no reviewed equation/parameter set or provenance record for a phenytoin model.                                                                                                                                                                          | No route/population-specific dose and concentration ranges, continuity evidence, or internal/external validation datasets are approved here.                                                         | `not-modelable: unsupported-dose-dependent-transition`; do not infer `Vmax`/`Km` from half-life or create separate low/high-dose models from reference ranges.                                                                                                                |

These rows intentionally record evidence gaps rather than fill them with plausible values. A future
review may promote an analyte only by replacing the gaps with cited, parameter-level evidence and a
signed review record. Reviewer identity, date, declaration revision and conflict-of-interest statement
must be retained in the audit trail. **Implementation is blocked until that review artifact exists;
this section approves the semantics and failure behaviour, not the current numerical overrides as
validated catalog data.**

## 5. Grading + disclaimer

Each derived model gets an **A–D grade** from family status, parameter completeness, source
quality/agreement, and validation status (SC-7A). The grade renders prominently and — because values
are ranged/multi-sourced — **widens the uncertainty bands** (SC-1B/5B), so honesty is in the curve.

### 5.1 Owner-approved evidence and rendering policy (2026-08-26)

This is the release contract agreed by the **scientific owner** (evidence validity), **product owner**
(user classes and interaction), and **risk owner** (failure direction and acknowledgement). It
supersedes the CV-3a rollout default that allowed every gradable model to render. **Its public
user-class floor is in turn amended by §5.2 (2026-08-26); read the two together.** Until the policy is
implemented, that difference is a known gap: do not interpret `MIN_RENDER_GRADE = 'D'` as approval to
ship D curves. The executable acceptance cases are in
`tests/model-grade-policy.acceptance.test.ts`; an implementation change to
`kinetics-core/model-grade.ts` or the modeling UI must make those cases exercise production code
without weakening their expected outcomes.

The overall grade is the **worst applicable dimension**. A stronger dimension never compensates for
a weaker one, and unknown evidence takes the conservative outcome shown below.

| Dimension                 | A                                                                                                                                                         | B                                                                                                                                | C                                                                                                                                                                               | D / hard stop                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completeness              | Every family-required and curve-shaping parameter is present; no default or imputation.                                                                   | Complete, but a declared and bounded transformation/secondary estimate is used for at most one non-structural input.             | Runnable only because one input uses an explicitly conservative default or a non-critical reporting field is absent.                                                            | Any required curve-shaping input is missing or an undocumented value is manufactured: D. Unsupported family/coherence failure: **ungraded, no curve**.                   |
| Primary-source review     | All decisive evidence is primary, read in full, and accepted by a qualified human reviewer.                                                               | All decisive evidence is reviewed; a corroborating item may be secondary, or a primary study may lack independent second review. | A decisive primary source is pending review, or the result relies materially on a reviewed secondary synthesis.                                                                 | Decisive evidence is unresolvable, rejected, retracted, or has not been read in full: D; known invalid evidence is a **hard stop**.                                      |
| Parameter provenance      | Every numeric input links to the exact source, extraction, units/conversion, route, matrix, and population; derivations are reproducible.                 | Links are reproducible, with one declared indirect derivation or aggregation whose inputs are fully traceable.                   | A value is traceable only to a study/table level, or aggregation lineage is incomplete but auditable.                                                                           | Any decisive numeric value has no source or irreproducible units/conversion: D. A value whose identity cannot be established is a **hard stop**.                         |
| Population applicability  | Validation and parameters directly cover the intended population, including material covariates.                                                          | Scientifically justified extrapolation to a nearby population, named in limitations.                                             | Material population mismatch (for example healthy adults to severe organ impairment or pediatric use), with direction unknown.                                                  | Evidence is contraindicated for or non-transferable to the selected population: **hard stop**.                                                                           |
| Matrix and route match    | Exact biological matrix, administration route, formulation/input shape, and analyte basis.                                                                | A validated conversion or accepted bridging study connects the evidence to the selected matrix/route.                            | Proxy matrix or formulation with a scientifically plausible but unvalidated bridge, disclosed prominently.                                                                      | Wrong route/input shape, incompatible matrix with no bridge, or parent/metabolite analyte mismatch: **hard stop**, not merely D.                                         |
| Validation status         | Externally validated against independent observations in the intended use domain with predefined performance criteria met.                                | Literature-derived and checked against an independent dataset or accepted benchmark, but not fully domain validated.             | Experimental/internal validation only, or external validation outside the intended domain.                                                                                      | Toy/unvalidated model, failed validation, or validation status unknown: D; a known material validation failure is a **hard stop** until resolved.                        |
| Uncertainty semantics     | Parameter, population, residual/measurement, and model-structural uncertainty are separated, quantified, and the interval/percentile meaning is explicit. | All material uncertainty is quantified; one component is conservatively pooled and disclosed.                                    | Bands exist but combine components or use bounds whose probability semantics are not established; they must be labelled “plausible range,” not confidence/prediction intervals. | Point estimate only, false precision, unknown band meaning, or lower grade represented only by cosmetic widening: D. Mislabelled interval semantics are a **hard stop**. |
| Unresolved contradictions | No unresolved material contradiction; discordance is reconciled with a documented rationale.                                                              | Minor non-material discordance remains and sensitivity analysis shows no decision-relevant effect.                               | Material discordance remains, all branches are shown, and no preferred branch is silently selected.                                                                             | A contradiction changes family, route, direction, or clinically/forensically relevant magnitude and is collapsed to one curve: **ungraded, no curve**.                   |

Grade meanings follow from the table:

- **A — validated/direct:** all dimensions A. It is not “high confidence” by vote; one B makes the
  model B.
- **B — supported with bounded limitations:** no dimension below B and no hard stop.
- **C — exploratory, reviewer-visible:** no dimension below C and no hard stop. It is not approved
  for ordinary end-user numeric display.
- **D — insufficient for ordinary numeric display:** at least one D and no hard stop. D preserves a
  reviewable derivation, not permission to show a user-facing curve.
- **Ungraded / hard stop:** no numeric curve for anyone. Show the reason and evidence record instead.

#### User-class rendering decision

“Render” means draw a numeric curve or expose curve coordinates. A grade badge, prose, or an empty
chart state is not rendering. Server/export paths must enforce the same rule as the React surface.

| User class        | Minimum grade | Lower-grade behavior                                                                                                                                                                                                                           |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous         | B → **C** (§5.2) | D hidden; show “insufficient reviewed evidence” and nonnumeric limitations. C renders only under §5.2’s four conditions.                                                                                                                       |
| Authenticated     | B             | Same as anonymous; login alone does not confer evidence-review competence.                                                                                                                                                                     |
| Contributor       | B             | Same as authenticated; submitting evidence is not reviewing it.                                                                                                                                                                                |
| Editor (reviewer) | C             | C may render with a persistent grade, prominent limitations, provenance link, and no acknowledgement bypass. D is hidden until a per-model, per-version acknowledgement is recorded, then renders only in a clearly labelled review workspace. |
| Admin             | C             | Same scientific gate as editor. Administrative privilege does not raise evidence quality; D requires the same acknowledgement and review-only presentation.                                                                                    |

For acknowledged D, the acknowledgement must state that the curve is exploratory, may be
qualitatively wrong, is not for clinical/forensic decisions, and records actor, model/snapshot version,
grade-policy version, and time. It expires when any of those versions or the model inputs change. It
must not suppress limitations, survive into exports/share links, or make D available to lower user
classes. C never uses acknowledgement to reach the public — *and, per §5.2, C does not reach the
public by acknowledgement at all: it reaches it by disclosure, under conditions §5.2 sets out. The
"reviewer-only" half of this sentence is superseded for the reviewed override tier; the
"never by acknowledgement" half stands.* Hard stops can never be bypassed by role or
acknowledgement.

### 5.2 Amendment 1 — the disclosed public tier (2026-08-26)

**Status:** owner decision, amending §5.1. **Scope:** the reviewed override tier
(the 12 hand-authored registry models). **Supersedes:** the public/authenticated/
contributor rows of the §5.1 user-class table, and nothing else.

#### Why this amendment exists

§5.1 sets the public floor at grade **B**. Applying its own table to the current
reviewed models puts every one of them at **C**, on four independent dimensions:

| Dimension | Current state | §5.1 outcome |
| --------- | ------------- | ------------ |
| Primary-source review | No named, credentialed reviewer has attested any model's evidence. The 2026-08-26 evidence audit records that it was performed by an AI research agent and "cannot satisfy the requested qualified-reviewer gate." | C |
| Validation status | One external-validation fixture exists (`cocaine-iv-jeffcoat-1989`). The other 11 models have none. | C |
| Uncertainty semantics | Bands combine parameter and model-structural components; the interval's probability semantics are not established, so they are a "plausible range." | C |
| Matrix and route match | Cross-matrix display uses the catalog blood:plasma ratio — a scientifically plausible but unvalidated bridge. | C when the displayed matrix differs from the model's native one |

So under §5.1 as written the module renders nothing for anyone below editor. That
is a true statement of the evidence, but it makes the tool unavailable rather than
honest, and it does not become less true by waiting: three of the four dimensions
are not blocked on reviewer availability at all.

The owner's decision is to make the exploratory tier **publicly visible with
mandatory, itemised disclosure**, rather than to weaken any dimension's definition
or to relabel C as B.

#### What the amendment permits

A grade **C** model MAY render a numeric curve to every user class, including
anonymous, if and only if all of the following hold:

1. **No hard stop applies.** Every hard stop in §5.1 remains absolute and is
   unaffected by this amendment: wrong route or input shape, incompatible matrix
   with no bridge, parent/metabolite analyte mismatch, contraindicated or
   non-transferable population, known-invalid or retracted evidence, a value whose
   identity cannot be established, a material validation failure, mislabelled
   interval semantics, or a collapsed material contradiction. A hard stop still
   means no curve for anyone, and cannot be reached by acknowledgement or role.
2. **Every sub-B dimension is disclosed, itemised, at the curve.** Not a single
   badge and not a generic caveat: each dimension scoring below B is named, with
   what it means for this model. A user must be able to read *why* it is C without
   leaving the result.
3. **The interval is labelled "plausible range."** While uncertainty semantics
   score C, the bands may not be called a confidence or prediction interval
   anywhere — chart, answer card, tooltip, or export. §5.1 makes a mislabelled
   interval a hard stop, and this amendment does not touch that.
4. **The disclosure travels with the number.** Exports, share links and any
   server-rendered surface carry the same grade and the same itemised
   limitations. A curve that can be detached from its disclosure is not covered
   by this amendment.

**Grade D is unchanged and stays reviewer-only**, behind the §5.1 per-model,
per-version acknowledgement. This amendment moves the public floor from B to C.
It does not move the D gate, and it does not create a tier below D.

#### What the amendment does NOT do

- It does not redefine any dimension, or let a stronger dimension compensate for
  a weaker one. The weakest-link rule stands.
- It does not promote a model to B. A C model is labelled C to every user.
- It does not authorize clinical or forensic reliance. The disclosure states that
  the curve is exploratory.
- It does not apply to derived catalog models (CV track). Those remain gated at
  §5.1's floor until this amendment is explicitly extended to them.

#### Exit condition

This amendment is a bridge, not a destination. Each dimension leaves C by its own
route, and the amendment stops applying to a model the moment it reaches B:

- **Primary-source review** — a named reviewer with affiliation and
  qualifications attests the evidence through `evaluateScientificRelease`.
- **Validation status** — a reviewed `ValidationFixture` with literature
  landmarks lands for the model (the `cocaine-iv-jeffcoat-1989` pattern).
- **Uncertainty semantics** — the layers are separated and sampled (roadmap §1),
  at which point the bands earn an interval name.
- **Matrix and route match** — a reviewed `matrixTransform` (SC-5A) replaces the
  catalog blood:plasma bridge for that analyte.

**Review:** this amendment is revisited when the first model reaches B, or in six
months (2027-02-26), whichever comes first. If neither has happened by then, the
absence of any reviewed model is itself the finding, and the public tier should be
reconsidered rather than renewed by default.

## 6. Reproducibility

The registry becomes a **derived, versioned, checksummed snapshot** of DB declarations + parameters.
The current hand-authored models become the **reviewed override tier** (the known nonlinear/complex
drugs). A DB edit changes the next snapshot, never a curve already pinned.

## 7. Slices (CV track)

- **CV-1a — kinetics-core foundation (LANDED):** `model-structure.ts` — the axis types,
  `composeModelFamily` → `ModelFamily`-or-`unsupported`, per-family `requiredParametersFor`, and
  `validateModelStructure`. Pure/additive; no DB, no engine change, no `CORE_VERSION` bump.
- **CV-1b — DB (param-entries store):** the three axes as categorical parameter kinds, validated on
  write against CV-1a.
- **CV-2 — derivation wiring:** build a scenario/registry entry from DB declarations + parameters;
  route unsupported combinations to not-modelable. **Also adds the per-route key for
  `absorptionModel`:** CV-1b stores absorption drug-level (disposition/elimination are genuinely
  drug-level; absorption is route-specific in `ModelStructure`), so a multi-route drug's input
  shapes are not yet disambiguated. CV-2 defines the route/formulation vocabulary and keys
  absorption declarations by it — the slice where the derivation actually selects a family per
  route. No migration is owed (no consumer or stored data before then).
  - **CV-2a (LANDED):** `kinetics-core/derive-model.ts` — pure `deriveModel(declaration, present,
    opts)`: the disclosed-default policy (unstated axis ⇒ linear one-compartment, recorded per-axis
    `asserted`/`defaulted`) and the runnability outcome (`modelable`/`not-modelable`, with
    forbidden params ⇒ not-modelable). Engine vocabulary only; no DB.
  - **CV-2b (LANDED):** `src/lib/modelDerivation.ts` (pure) + `api/_lib/model-derivation-store.ts`
    (read adapter). The catalog→engine bridge: `parameterRoleFor` maps `DrugParameterId` onto the
    engine's `RequiredParam` roles, and `resolveDrugModels` turns a drug's stored axis value SETS
    into one derivation per absorption input SHAPE. Three derivation decisions here:
    - **`ka` has no catalog source — it stays missing, never manufactured.** *(Amended by CV-2c-6,
      2026-08-26: the "two-root solve" below does not survive the algebra once `ke` is known, and a
      route-scoped `tmax` now solves `ka` for the extravascular routes. The rest of this decision —
      no manufactured value, a cited `ka` always wins, `tmax` alone is not a `ka` — stands.)* The engine's
      first-order absorption rate (`kaPerHour`) is route-specific with no catalog field and is
      reviewer-authored per route (`kinetics-core/provenance.ts`). `tmax` is NOT a substitute: the
      time of peak is a joint function of `ka` and `ke` (`tmax = ln(ka/ke)/(ka−ke)`), so recovering
      `ka` needs `ke` and an implicit two-root solve. `parameterRoleFor` therefore maps only the
      four quantities the catalog directly holds (`halfLife`→`eliminationHalfLife`,
      `volumeOfDistribution`→`vd`, `clearance`, `bioavailability`); `ka` — with `k12`/`k21`,
      `centralVolume`, `vmax`/`km`, input durations, parent/metabolite — surfaces as
      `missingParameters`, the honest "incomplete, grade it down" signal. (An IV bolus one-
      compartment drug needs only t½ + Vd, so it fully parameterises; an oral first-order drug is
      always ka-incomplete until a reviewer authors ka per route.)
    - **An absorption shape is not a `RouteId`.** The catalog stores absorption drug-level as a set
      of shapes (CV-1b) with no route/formulation key yet, so `resolveDrugModels` derives one model
      per distinct absorption KIND and two routes sharing a shape (e.g. oral + intranasal, both
      first-order but with different F/ka) collapse to one entry. Labelled honestly
      (`absorptionShape`, not `route`); faithful per-route registry entries await the CV-2 route-key
      step.
    - **A molecule-axis conflict is not-modelable.** Two *different* declared disposition (or
      elimination) values are a curation contradiction, surfaced as `not-modelable` on every shape
      rather than resolved by picking one. The CL/V identifiability basis is not yet a catalog
      input, so a `clv-structural` declaration derives `not-modelable` (basis error) until a later
      slice supplies it — correct "missing stays missing" for now.
  - **CV-2c — the route/formulation key (faithful per-route absorption).** **Founder decision
    (2026-08-24): take the most scientifically-correct long-term path — key absorption by
    administration route.** CV-2b derives one model per absorption SHAPE, which collapses two routes
    that share a shape (oral + intranasal, both first-order) and cannot carry route-specific `F`/`ka`
    — but absorption, `F`, and `ka` are genuinely per-route (cocaine's intranasal `F` 0.35 ≠ its oral
    `F`; `kaPerHour` is route-specific), and a `DrugModelDefinition.routes` map is keyed by `RouteId`.
    A lossy shape→route default (mislabels routes) and an IV-only stopgap (permanently under-models
    extravascular drugs) were both rejected in favour of storing the real key. Additive sub-slices,
    pure-first and migration-gated:
    - **CV-2c-1 (pure):** `resolveDrugModelsByRoute` in `modelDerivation.ts` — the route-keyed
      derivation contract: per-`RouteId` absorption shape + route-specific present parameters (merged
      over the drug-level pool), one `RouteModelDerivation` (`route: RouteId`) per declared route.
      Molecule axes (disposition/elimination) stay drug-level. Pure/additive; no DB, no migration; the
      existing shape-based `resolveDrugModels` is unchanged for back-compat.
    - **CV-2c-2 (schema + migration, LANDED-PENDING-APPROVAL):** a nullable `route` discriminator on
      `parameter_entries` (null = drug-level as today; a `RouteId` = route-specific) with a DB CHECK
      holding it to the kinetics-core `ROUTE_IDS` vocabulary (kept in step by
      `modelStructureVocabulary.test.ts`, as the axes are). `ROUTE_IDS` becomes the single runtime
      source of truth the `RouteId` type derives from. A single additive, backward-compatible
      migration (0111). The catalog `ka` parameter is deferred to CV-2c-3 (kept out of the migration
      so the irreversible slice stays minimal, and so `ka`'s per-route scoping/editor exposure is
      handled with the write-path). The migration reaches production during build, so it is merged
      only on founder approval.
    - **CV-2c-3 (write-path + `ka`):** add the route-scoped catalog `ka` parameter (reviewer-authored,
      per-hour) + `parameterRoleFor('ka') → 'ka'`, and validate + store route-keyed absorption / `F` /
      `ka` entries (route non-null ⇒ a route-specific parameter).
    - **CV-2c-4 — per-route authoring (absorption + `F`/`ka`).** Today the DB column, write schema and
      store already carry `route`, but `validateRouteForParameter` only allows it on the route-SCOPED
      `ka` (route required) and forbids it elsewhere, and no editor surfaces a route selector.
      - **CV-2c-4a (write-path, absorption — LANDED):** a `routeOptional` parameter flag +
        `parameterIsRouteOptional`, set on `absorptionModel`, and a relaxed `validateRouteForParameter`
        with a third case — route ALLOWED-not-required (a drug-level declaration stays valid, and a
        per-route one is now accepted, which the CV-2c-5 read adapter already consumes). Unlike
        `routeScoped`, a route-optional parameter keeps its drug-level surfaces. Pure validation; the
        column/schema/store were already route-ready.
      - **CV-2c-4b (write-path, `F` — LANDED):** `bioavailability` is now `routeOptional`, and — because
        F is `summarizable` — the drug-level aggregation (`loadEntryValuesForParameter`) EXCLUDES
        route-scoped entries, so a route-specific F never pools into the drug-level cache (the symmetric
        partner of the read adapter excluding drug-level F from a route's pool). The editor's route
        selector (CV-2c-4c) already covers F, since it gates on route-scoped/route-optional. A drug-level
        F still aggregates exactly as before.
      - **CV-2c-4c (UI — LANDED):** the drug-editor route selector. A `ROUTE_IDS` label map
        (`routeLabels.ts`) + en/nb translations, a `route` field on the `parameterEntriesApi` row/write
        types, and a route `<select>` in `ParameterEntryEditor` gated on route-scoped/route-optional
        (a "drug-level" no-route choice for the optional case, required for the scoped case), fed into
        both the categorical and numeric submit paths. So a curator can now author a per-route
        absorption declaration through the model-structure editor. Component-tested.
      - **CV-2c-4d (UI polish — route display LANDED):** each model-structure declaration chip in
        `ModelStructureSection` now shows its administration route (a per-route absorption declaration
        reads back as e.g. "first-order · oral"; a route-less one shows nothing). Still open: grouping
        the chips by route, and a dedicated route-scoped `ka` editor surface (`ka` appears on no
        drug-level surface, so it still lacks a mount — `F` and `absorption` are authorable now).
    - **CV-2c-6 — `ka` from a route-scoped `tmax` (LANDED, amends CV-2b).** CV-2b left `ka` with no
      catalog source and no editor mount, so every extravascular route — oral, intranasal,
      inhalation, the routes the catalog is actually about — was incomplete by construction, and
      would have stayed so behind ~3 hand-authored, individually-cited rate constants per drug. The
      substitute CV-2b rejected turns out to be available after all, for a reason that decision
      missed:
      - **The solve is unique, so there is no root to choose.** Writing `r = ka/ke`, the relation
        `tmax = ln(ka/ke)/(ka−ke)` becomes `tmax = h(r)/ke` with `h(r) = ln(r)/(r−1)`, and `h` is
        strictly decreasing on `(0, ∞)` — `+∞` at `r → 0⁺`, `h(1) = 1`, `0` at `r → ∞`. A strictly
        monotone function has at most one root, so a given `(tmax, ke)` determines exactly one `ka`.
        The "implicit two-root solve" CV-2b cited is the ambiguity of reading `tmax` WITHOUT `ke`;
        the catalog's elimination half-life supplies `ke`, and the ambiguity goes with it.
      - **The real hazard is flip-flop kinetics, and the stored values report it.** The solution has
        `ka > ke` if and only if `ke·tmax < 1`. At or beyond that boundary absorption is the slower
        process, the observed terminal slope is `ka` rather than `ke`, and the catalog's
        "elimination half-life" is an absorption half-life wearing an elimination label. Feeding it
        back in as `ke` would compound that misreading, so the inference REFUSES the regime outright
        rather than returning a number (`kinetics-core/ka-inference.ts`). Missing stays missing.
      - **`tmax` becomes `routeOptional`**, on the same terms as `absorptionModel` (CV-2c-4a) and
        `bioavailability` (CV-2c-4b): an oral time-to-peak is not an insufflated one. The drug
        editor's existing route selector covers it with no UI change, so per-route `tmax` is
        authorable today — and `tmax` is what the literature reports, whereas `ka` usually is not.
      - **A drug-level `tmax` is attributed to a route only when the drug declares exactly ONE
        route**, where there is no other route it could describe. A multi-route drug must state
        `tmax` per route; guessing between them would be the manufactured attribution the plan's
        "missing stays missing" rules out.
      - **An inferred value is never indistinguishable from a cited one.** A fifth grade factor,
        `parameterInference` (CV-3a), caps a model resting on one inference at **C** and two at
        **D**; the CV-3c disclosure gains an `inferred-parameters` caveat, rendered separately from
        `missing-parameters` because a missing parameter shows no number while an inferred one shows
        a number that reads like any other. A cited route-scoped `ka` still wins outright.
      Route-scoped `ka` remains authorable and remains the better evidence; this slice removes the
      requirement that it exist before any extravascular route can run at all. The dedicated
      route-scoped `ka` editor surface (CV-2c-4d) is still open.
    - **CV-2c-7 — the attributed oral route (LANDED).** CV-2c-5's rule — a route is DECLARED by a
      route-scoped row, and a drug with none derives nothing — is right for a drug whose curation
      names routes and wrong for one that names none. It left **694 of 697** catalog drugs reporting
      `no administration route was supplied`, most of them holding a drug-level `tmax` and
      `bioavailability`: quantities no molecule has and no IV dose produces. Their presence IS the
      catalog stating that an extravascular route was studied, with only the route's LABEL unstated —
      and an unstated axis takes a disclosed default (§2). So the label does too: `oral`, the generic
      catalog case.
      - **Scoped so it can never overwrite curation.** The attribution applies ONLY when the drug
        declares no route at all, so it cannot displace, redirect or contradict an authored route;
        it disappears the moment a curator keys one. A drug with no extravascular evidence still
        derives nothing — missing stays missing.
      - **The drug-level `F` follows the route it belongs to.** CV-2c's exclusion of a drug-level `F`
        from the shared route pool exists so an oral `F` is never applied to intranasal dosing. On an
        attributed route there is no other route it could be mis-applied to (the attribution requires
        that none is declared), so it is admitted there and nowhere else. A route-scoped `F` still
        wins. The drug-level `tmax` reaches the route through CV-2c-6's existing sole-route rule and
        solves the `ka`.
      - **Disclosed, and graded like the assumption it is.** The route carries `routeProvenance:
        'attributed'` from the declaration through the derivation into the committed
        `DerivedRouteGrade`, where §5.1's completeness dimension counts it exactly as it counts a
        defaulted axis. An attributed route must never read as a curated one.
      - **Effect:** 2 derived definitions → **174**; `no administration route was supplied` 694 → 466,
        with 51 drugs now reporting the actionable `no administration route could be assembled into a
        runnable model` (a named gap in `F`/`tmax`) instead of a blanket "no route".
    - **CV-2c-8 — curating more never takes a curve away (LANDED).** Two rules made a drug LOSE its
      derived curve when a curator added a correct, cited model-structure fact — diazepam and
      alprazolam dropped out of the tier the moment their "two-compartment" (and, for diazepam,
      "first-order · oral") facts were recorded. Capability must grow monotonically with the data, so
      both are closed:
      - **A declared disposition richer than the catalog can run is simplified, not dropped.** The
        two-compartment family needs `k12`, `k21` and a central volume, which the catalog does not
        store (and its assembly is not implemented), so an asserted two-compartment route could never
        assemble. `resolveDrugModelsByRoute` now offers a one-compartment `dispositionFallback`, and
        the read adapter uses it ONLY when the declared derivation does not assemble. The route
        records `simplifiedFrom: { disposition: 'two-compartment' }` into its `DerivedRouteGrade`
        and its coverage-report entry; §5.1 completeness counts a simplified axis exactly as a
        defaulted one, so declaring the richer model neither flatters nor sinks the grade. Once the
        declared family can run, it wins and the fallback is never used. Disposition only: a
        saturable (Michaelis–Menten) elimination run as first-order would be qualitatively wrong at
        exactly the doses that matter, so it stays not-modelable.
      - **Naming the oral route keeps the drug-level `F`.** Keying a drug's absorption shape to
        `oral` made the route asserted, and an asserted route never saw the drug-level `F` — so the
        curator's confirmation of the attribution withheld the `F` the attributed route was already
        running on. The drug-level `F` is read as the oral `F` (the reading the attribution itself
        makes), so it is now admitted to an asserted `oral` route with no route-scoped `F`, however
        many other routes the drug declares — otherwise authoring an IV route beside it would take
        the oral curve away. Every non-oral route still withholds it; a route-scoped `F` still wins.
      - **Visible to reviewers.** `scripts/derived-model-review-queue.ts` buckets a simplified curve
        as `simplified-family-curve` (right after a guessed family), shows the axis as "simplified
        from two-compartment", grades it as the derived tier does, and does not list the declared
        family's citations as support for the one drawn. `docs/simulator-mechanics.md` §5 states
        the simplification, pinned by its drift guard.
    - **CV-2c-9 — a cautious default for a missing bioavailability (LANDED).** Owner decision
      (2026-09-29): a drug's simulation capability should grow with its data rather than wait
      for every input, wherever an input has a cautious default. `applyCautiousDefaults`
      (`modelDerivation.ts`) fills a route's missing F with `CAUTIOUS_DEFAULT_BIOAVAILABILITY`
      (1): concentration is proportional to F at every time, so this bounds the curve from above.
      - **`ka` is deliberately NOT defaulted.** Faster absorption raises the early peak but, at
        the same exposure, lowers every late concentration (the Bateman curve scales with
        ka/(ka−ke) late on) — so no absorption rate is cautious at every time a user can ask
        about, and a back-calculated dose would err in whichever direction the time chose.
        A first draft defaulted a 15-minute Tmax; review showed exactly this and it was removed.
      - **Only where it has a referent and contradicts nothing:** a family that requires F, for
        an administered substance — the stored `substance_class` AND the canonical
        `data/substanceClasses.ts` list must both say so, the list only ever withholding — with
        no route-scoped F entry, even one that pools to nothing (a censored "< 0.5").
      - **Graded and disclosed:** `defaultedParameters` in the `DerivedRouteGrade` (and
        `defaulted` in the coverage report, since the value is still absent); completeness is
        the worse of the axis count and C per §5.1. `ModelGradeNotice` states it through
        `modelGrade.cautiousDefault.bioavailability` (en + nb); the review queue buckets such a
        curve as `default-parameter-curve`.
      - **Known gap:** `drugs.substance_class` is `drug` for all 693 catalog entries — the
        `backfill-substance-classes` script has not been run against production. The canonical
        list covers the known analytes in the meantime; running the backfill makes the stored
        column agree.
    - **CV-2c-5 (read adapter, LANDED):** rekey `model-derivation-store.ts` to feed route-keyed inputs
      into `resolveDrugModelsByRoute`. `readDrugModelInputsByRoute` reads the molecule axes drug-wide,
      the per-route absorption shapes and route-specific parameters from `route`-scoped
      `parameter_entries`, and the drug-level parameters from the `drug_parameters` cache; a route is
      DECLARED by any route-scoped row for it, and a drug with none derives nothing ("missing stays
      missing"). The pure resolver gained per-route absorption resolution: `RouteDeclaration.absorption`
      now takes the declared SET, corroborating rows dedup to one shape and two disagreeing shapes for
      ONE route surface as `not-modelable` for that route alone (a molecule-axis conflict still sinks
      every route). Lands ahead of the full write path exactly as CV-2c-1/-2 did: today only `ka` is
      route-scoped by `validateRouteForParameter`, so absorption/`F` route-keying — and the routes they
      would declare — arrive with CV-2c-4; the DB CHECK already admits a valid `RouteId` on any
      parameter, so the adapter reads the full model the schema supports.
- **CV-3 — grading + disclaimer:** grade computation, prominent disclaimer surface, band widening.
  - **CV-3a (LANDED; a fifth factor added by CV-2c-6):** `kinetics-core/model-grade.ts` — pure
    `gradeDerivedModel(derived, inputs)`.
    **Weakest-link A–D:** the overall grade is the WORST of five factor sub-grades — `structure`
    (how many axes were a disclosed default vs asserted), `completeness` (required parameters the
    catalog could not supply), `sourceQuality` (the parameter pool's quality/agreement, supplied by
    the Redose caller — this module stays portable), and `validation` (SC-7A status) — and the
    limiting factor is named. `A` is EARNED by validation: an unvalidated model defaults to
    `literature-derived` and caps at `B`. A `not-modelable` derivation is `ungraded` (no curve).
    Rollout decision (plan §8): **min render grade `D`** — everything modelable renders a curve,
    however heavily disclaimed; only `not-modelable` shows none (`rendersCurve` holds that gate if
    ever tightened). Thresholds are isolated as named tables so the scheme stays tunable. Pure/
    additive; no `CORE_VERSION` bump.
  - **CV-3b (LANDED):** `gradeBandWidening(graded)` in `model-grade.ts` — "honesty in the curve".
    A lower grade widens the reported uncertainty BANDS by a model-confidence proportional CV
    (`GRADE_BAND_WIDENING_CV`: A 0, B 0.15, C 0.30, D 0.50, tunable per §8). An inferred parameter
    (CV-2c-6) therefore widens the bands as any other C does. This is a
    MODEL-STRUCTURAL uncertainty, distinct from the SC-5B observation (measurement) error and the
    SC-1B parameter/individual variability, but composes in variance the same way (`√Σcv²`); the
    median is unchanged. `A`/`ungraded` widen nothing. Pure; the engine wiring that folds the CV
    into the band variance alongside observation error arrives with the render path (CV-4/CV-5).
  - **CV-3c (LANDED):** `describeDerivedModel(derived, gradeInputs)` in `src/lib/modelGradeDisclosure.ts`
    — the single, locale-agnostic DATA CONTRACT every disclaimer surface renders from (curve caption,
    tooltip, monograph), so they all disclose the same thing. Packages grade, limiting factor,
    band-widening CV, `rendersCurve`, and the structured CAVEATS as translatable CODES + values
    (`defaulted-axes`, `missing-parameters`, `weak-source-quality`, `not-validated`, `not-modelable`)
    — never prose, so the React layer owns the nb/en translation. Pure; a spotless validated A model
    discloses nothing, a not-modelable one is disclaimer-only (no curve, no grade).
  - **CV-3d (component LANDED):** `GradeDisclosure` (`src/components/wiki/GradeDisclosure.tsx`) — the
    React/i18n component that renders the CV-3c contract: a grade badge (A–D coloured, or a
    "not modelable" badge), the limiting factor, the band-widening, and one list item per translated
    caveat. Each caveat CODE maps to a `modelGrade.*` key (en/nb), with axis/parameter tokens falling
    back to their raw name; a spotless A model shows just its badge, a not-modelable one is
    disclaimer-only. Purely presentational and fixture-tested. MOUNTING it (placement/prominence, and
    computing a live disclosure per drug) awaits the CV-4/CV-5 render path and the founder's placement
    decision — the component is the reusable primitive that path will drop in.
- **CV-4 — derived snapshot:** regenerate the checksummed registry from the DB; keep the override
  tier; validate the offline pin path.
  - **CV-4a (LANDED):** `kinetics-core/registry-snapshot.ts` — the pure MERGE primitive
    `buildRegistrySnapshot(overrides, derived, version)`. Merges the reviewed override tier (today's
    hand-authored `registry.ts`) with DB-derived models into one versioned, checksummed
    `RegistrySnapshot`. **Override precedence: an override ALWAYS wins (founder decision,
    2026-08-24)** — a derived entry is kept only when no override claims its analyte or an alias, so a
    reviewed nonlinear model (cocaine, THC, GHB, …) is never silently replaced by a naive
    one-compartment DB derivation; shadowed derivations are reported in `supersededByOverride`. The
    checksum uses the same scheme as `registry.ts` (`hashValue({ version, definitions })`), so a
    snapshot built from the current definitions with NO derived entries reproduces `REGISTRY_CHECKSUM`
    bit-for-bit — the reproducibility guarantee (plan §6) that makes the derived path a drop-in for
    the hand-authored release. No DB read, no file emission, no engine change; pure/additive, no
    `CORE_VERSION` bump.
  - **CV-4b (LANDED):** `kinetics-core/assemble-model.ts` — the pure ASSEMBLY primitive
    `assembleRouteParams(derived, values, opts)`. Maps a `modelable` `DerivedModel` (CV-2) + its
    canonical-unit MEDIAN values into the engine's `RouteModelParams`. **Range→`ParamSpec` policy:
    `fixed(median)` (founder decision, 2026-08-24)** — a derived curve is the deterministic median
    prediction; the stored range is NOT yet turned into parameter variability (SC-1B), since CV-3b's
    grade-band widening already keeps a derived curve from reading as over-confident and the
    distribution-shape choice (`uniform`/`triangular`/`lognormal`) is deferred to its own later
    slice so no unvalidated distribution assumption is baked in. Completeness is gated against the
    same `requiredParametersFor` authority (an absent/non-finite required value ⇒ `incomplete`, not a
    guessed value — missing stays missing); a not-modelable derivation or a family whose inputs the
    catalog cannot yet supply (CL/V basis, two-compartment micro-constants, MM Vmax/Km,
    parent→metabolite) ⇒ `unsupported`. Scope today: the linear one-compartment families the catalog
    derivation actually produces (`iv-one-compartment`, `one-compartment-first-order`,
    `one-compartment-zero-order`, `one-compartment-mixed-order`). Consumes canonical units; the DB→
    canonical conversion and `vdScaling`-from-unit inference are the read adapter's concern (`opts`).
    Pure/additive; no `CORE_VERSION` bump.
  - **CV-4c-1 (LANDED):** `kinetics-core/assemble-definition.ts` — the pure DEFINITION assembler
    `assembleDrugDefinition(metadata, routes)`. Builds the whole `RouteId`-keyed
    `DrugModelDefinition` (routes map + catalog metadata: analyte, display name, matrix, validation
    status, dose bases, aliases) from a drug's per-route derivations (`resolveDrugModelsByRoute`,
    CV-2c) + their canonical-unit median values, assembling each route via CV-4b's
    `assembleRouteParams`. Missing stays missing per route: a route whose derivation is not-modelable
    or whose required params the catalog lacks is REPORTED (`routeOutcomes`) and left out of the
    routes map, never assembled from data it lacks; a drug modelable on IV but not oral yields a
    definition with just the runnable route, and only when NO route assembles is the drug
    `not-modelable`. Pure/additive; no DB, no file emission, no `CORE_VERSION` bump.
  - **CV-4c-2a (canonical-value read, LANDED):** the two conversions CV-4b/CV-4c-1 pinned to "the read
    adapter's concern". Pure helpers in `modelDerivation.ts` — `toAssemblyValues` (map a drug's stored
    catalog values onto the engine's canonical-unit `AssemblyValues` via `convertParameterValue`: the
    catalog's canonical units equal the engine's, so most are identity; `clearance` L/min→L/h actually
    rescales) and `inferVdScaling` (the stored Vd unit → a `VdScaling`; the catalog's only Vd unit
    `L/kg` is the `total-weight` default, left UNSET so an assembled model matches a hand-authored one
    and the CV-4a checksum stays bit-for-bit — `lean-body-mass`/`widmark` are reviewed clinical
    judgements in the override tier, never manufactured from a unit). Plus `readDrugRouteAssemblyInputs`
    in `model-derivation-store.ts` — the value-reading counterpart of `readDrugModelInputsByRoute`:
    drug-level roles from the `drug_parameters` cache (already canonical; F excluded as route-specific),
    route-scoped `ka`/`F` pooled to a canonical median with the shared `aggregateEntries` primitive,
    `vdScaling` from the Vd unit — one `RouteAssemblyInput` per DERIVED route (a not-modelable route is
    carried through so the assembler reports its outcome). Missing stays missing: a value the catalog
    cannot supply stays absent and grades the route down. Pure/additive; no `CORE_VERSION` bump.
  - **CV-4c-2b-a (per-drug definition read, LANDED):** the metadata half + the per-drug assemble.
    `derivedDefinitionMetadata` (pure, in `modelDerivation.ts`) maps a drug's identity (`analyte` from
    the slug, English-first `displayName`, a derived-tier `modelId` `<slug>-derived-v1`, and NO aliases —
    a drug's free-form catalog labels are not analyte ids, so a derived model resolves only under its
    unique slug; a reviewed analyte crosswalk is an override-tier concern) onto a `DrugDefinitionMetadata`,
    filling the three fields the catalog has no
    column for as DISCLOSED DEFAULTS: `matrix: 'plasma'` (the value every hand-authored entry uses),
    `validationStatus: 'literature-derived'` (CV-3a caps an unvalidated model at B), and
    `supportedBases: ['active-moiety', 'parent']` (exactly the two bases the engine consumes without a
    molar conversion; `salt`/`free-base` are omitted, not over-claimed). `readDrugModelDefinition` in
    `model-derivation-store.ts` reads the drug row, sources the metadata, gathers
    `readDrugRouteAssemblyInputs`, and calls `assembleDrugDefinition` — a drug with no runnable route is
    `not-modelable` (missing stays missing); a drug modelable on one route but not another yields a
    definition with just the runnable route. Pure/additive; no `CORE_VERSION` bump. The reviewed
    override tier (which always wins, CV-4a) carries the curated metadata for the drugs that matter.
  - **CV-4c-2b-b-1 (catalog snapshot builder, LANDED):** `readDerivedRegistrySnapshot` in
    `model-derivation-store.ts` — enumerate the catalog (drugs read in `slug` order for determinism),
    call `readDrugModelDefinition` per drug, collect the assembled definitions, and merge them (as
    `derived`) with the reviewed override tier (as `overrides`, reconstructed from the public surface in
    `registeredAnalytes()` order) through CV-4a's `buildRegistrySnapshot`, all inside one `REPEATABLE
    READ` transaction so the whole scan sees one consistent DB snapshot. Returns the checksummed
    `RegistrySnapshot` plus a build report (`notModelable` slugs). Determinism makes the checksum a pure
    function of DB contents + the reviewed tier, and a catalog that adds no derived model reproduces
    `REGISTRY_CHECKSUM` bit-for-bit (the offline pin guarantee, plan §6). Collision safety is structural:
    a derived `analyte` is a globally-unique slug and a derived model carries NO aliases, so no two
    derived entries can collide and the merge only ever resolves the legitimate analyte-vs-override
    supersession. Thin DB read + pure merge; no `CORE_VERSION` bump.
  - **CV-4c-2b-b-2 (generation script + artifact, next):** a script that runs
    `readDerivedRegistrySnapshot` against the DB and emits the committed checksummed artifact, plus the
    provenance gate + offline pin-path validation (`--check`) wiring — the emission step CV-4c-2b-b-1
    stops short of. Consumes only `snapshot` + `notModelable` (there is no alias report).
  - **CV-4c-2c (grade travels with the artifact, LANDED):** the CV-3 ↔ CV-4 join. CV-4 emitted the
    derived tier as assembled `DrugModelDefinition`s — everything the ENGINE needs and nothing about
    how far the curve should be trusted — while CV-3 grades a `DerivedModel` nobody kept. A consumer
    resolving a derived model from the committed artifact therefore had a curve it could not grade,
    which is the ungraded catalog curve §5.1 forbids and §8 lists as the "silent family wrongness"
    risk. `kinetics-core/derived-grade.ts` defines the per-route grade RECORD (structure, per-axis
    provenance, family, inferred roles) written beside each derived definition, plus
    `derivedModelFromGrade` to rebuild the `DerivedModel` it describes so the ordinary
    `gradeDerivedModel`/`describeDerivedModel` path runs at render time without re-reading the DB.
    Three decisions worth keeping: the record holds FACTS, never a computed grade (the CV-3a
    thresholds are tunable per §8, so a stored grade would pin the scheme as it stood at generation
    time while stored facts re-grade correctly); it carries no `missingParameters`, because a route
    is recorded only if it ASSEMBLED and `assembleRouteParams` assembles only when every required
    role has a value — carrying the derivation's own set would double-penalise an inferred `ka`,
    once on completeness for being absent and again on inference for being solved; and
    `derivedGrades` sits OUTSIDE `checksum` (which hashes `{version, definitions}`) so CV-4a's
    bit-for-bit `REGISTRY_CHECKSUM` reproduction still holds — the byte-comparing gate catches a
    stale grade instead.
- **CV-5 — rollout (render path LANDED):** enable behind a flag; batch-review families with
  citations; backfill the nonlinear/complex drugs into the override tier first.
  - **CV-5a — the derived render path (LANDED).** `loadOfflineRegistry()` finally has a runtime
    consumer, so `VITE_DERIVED_REGISTRY_ENABLED` controls something. Four parts:
    - **`kinetics-core/derived-model-grade.ts`** — `assessDerivedModel`, the derived tier's §5.1
      scorer and the counterpart to `assessReviewedModel`. Every dimension is read off a
      structural fact about how a derived model is built, in the reviewed scorer's own discipline
      (an unknown is never an A): defaulted axes count against COMPLETENESS (§5.1 counts an input
      "filled from a conservative default" there); an inferred `ka` counts against PARAMETER
      PROVENANCE, not completeness, because the value is present but traces to no source of its
      own; PRIMARY-SOURCE REVIEW is C by construction, since a derivation is automatic and the
      plan's route to a reviewed model is promotion into the override tier; POPULATION
      APPLICABILITY is C because the catalog records no source population for a pooled value;
      MATRIX/ROUTE MATCH is C because the derived tier's `plasma` is a disclosed default, not a
      recorded fact; VALIDATION is C (literature-derived, no fixture); UNCERTAINTY SEMANTICS is C
      (`fixed(median)` plus grade widening, pooled); UNRESOLVED CONTRADICTIONS is B, because the
      derivation surfaces a conflict as not-modelable rather than resolving it.
    - **The consequence, pinned in tests:** weakest-link lands every derived model at **D**, so
      a derived curve today renders to **nobody** — §5.1 admits a D only to a reviewer holding a
      recorded per-model acknowledgement (implemented in CV-5b). Two dimensions
      force that D, and both are about the CODE rather than the data or the policy:
      - **uncertainty-semantics** — a derived route is `fixed(median)` (CV-4b) and declares no
        observation-error layer, so `simulate.ts` takes its flat-band branch and emits
        `p05 = p25 = median = p75 = p95`. CV-3b's grade band widening exists but no simulation path
        applies it; it reaches the DISCLOSURE only. A bare point estimate is a D, and calling it a
        "plausible range" would be the mislabelled interval §5.1 makes a hard stop.
      - **parameter-provenance** — a derived route takes drug-level values from the
        `drug_parameters` aggregate cache, and a cache row need not come from a cited entry at all
        (seed/backfilled t½ and Vd are written directly, and the read adapter deliberately accepts
        a bounds-only cached range). `DerivedRouteGrade` carries no per-input citation fact, so
        claiming the values are cited would be manufactured evidence.
      Extending §5.2 does **not** rescue this: its public tier lowers the non-reviewer floor to C,
      which still does not admit a D. Composing the grade CV into the emitted bands, and carrying
      per-input provenance into the grade record, are what move it.
    - **Resolution** — `resolveModel`/`resolvableAnalyteIds` in `registry.ts` read the flag-selected
      release; `DEFINITIONS`/`findModel`/`registeredAnalytes`/`supportedAnalyteIds` stay REVIEWED-only,
      because the generation step reconstructs the override tier from them and widening them would
      feed derived models back into their own input. `forwardCoreAdapter` resolves through the new
      accessors.
    - **The hole that had to be closed with it:** the simulator gate reads a `null` grade as "not
      governed by this policy" and RENDERS it — correct for the legacy engines, catastrophic for a
      derived model. `gradeResult` therefore never returns `null` for a registry model it cannot
      grade; a derived model with no committed grade resolves to an explicit hard stop and is
      hidden.
  - **CV-5b — the gate's two missing halves (LANDED).** CV-5a built a correct gate that nothing
    could pass and whose refusals nobody could see. Both halves are closed here, and they are
    independent of each other:
    - **Every numeric surface now obeys the disposition, not just the chart.** `visibleDrugs`
      filtered `LazySimulatorGraph` alone; `AnswerCard`, `ResultsSummary`, `AssumptionPanel` and
      `exportSummaryText` all received the unfiltered result map, so a model the policy HID
      contributed no curve and printed its median, percentiles and PK parameters underneath it —
      and wrote them into the exported file. §5.1 governs "a numeric curve or curve coordinates"
      wherever they surface; a text export is such a surface. One predicate, `admitsFigures` in
      `reviewedModelGrade.ts`, is now the single definition of admitted, because the leak came
      precisely from each surface deciding for itself. A `null` grade stays ADMITTED: it means an
      engine this policy does not govern (ethanol/Widmark, KineLab, an older saved case), and
      withholding those would be the gate over-reaching. **This was live for hard-stopped REVIEWED
      models, independent of the derived tier.**
    - **The disclosure is keyed to what is on screen, not to what the gate admitted.** The policy's
      own words are that hidden "still shows the reason and the evidence record", but `gradedEntries`
      required membership in `visibleDrugs` — so a withheld model vanished without one, and the
      `hidden` and `acknowledge-in-review-workspace` branches of `ModelGradeNotice` were unreachable
      code. It now reads a separate `disclosedDrugs` set (on screen, has a result), and the two
      questions are asked separately.
    - **The reviewer acknowledgement exists.** `renderDisposition`'s reviewer path has always run
      through `options.acknowledged`; nothing recorded one, so no caller ever passed it and a
      reviewer got `acknowledge-in-review-workspace` — which the gate treats as not-renderable.
      `modelAcknowledgementStore` is the missing record, keyed per model, per EVIDENCE VERSION
      (`acknowledgementVersionFor`, a hash of the complete assessment set — a release checksum
      cannot see a `derivedGrades`-only regeneration, and the disclosed policy cannot see a
      completeness A→B move, so neither is a safe key)
      and per viewer (a shared browser profile must not pass one reviewer's decision to the next);
      it is cleared on sign-out. The review workspace itemises every failing dimension BEFORE
      offering the control — an acknowledgement of an unstated deficiency is not an informed one —
      and a curve rendering on one says so and offers the way back. Pinned in tests: an
      acknowledgement never elevates a non-reviewer and never reaches a hard stop.
    - **What this does and does not change.** A derived model still grades D; the two D dimensions
      below are untouched. What changed is that D is no longer a dead end: a reviewer can look at a
      derived curve by explicitly accepting its stated deficiencies, which is exactly the trial
      §5.1 designed the reviewer path for. Everyone else still sees nothing.
    - **Not claimed:** a browser-local record is not an audit trail. It does not survive a cleared
      profile, does not follow a reviewer to another machine, and no one else can read it. A
      durable record of who accepted what belongs server-side and is deliberately not built here.
  - **Still open, in the order that actually unblocks a visible derived curve:**
    1. **Turn the derived tier on** (`VITE_DERIVED_REGISTRY_ENABLED=true`). CV-2c-7 made the tier
       non-empty — 174 derived definitions where there were 2 — but `resolveModel` still serves the
       reviewed tier alone until the flag is set, so every catalog drug still fails a simulation
       with `is not in the kinetics-core registry`. This is now the only thing between an
       acknowledging reviewer and a derived curve. Continued per-route `tmax`/`F` curation remains
       the way to improve those 174 and to reach the 517 that still derive nothing — a route-scoped
       row is better evidence than an attributed route, and it is what the coverage report's 51
       `no administration route could be assembled` entries are asking for.
    2. ~~**Compose the grade CV into the emitted bands**~~ **(LANDED as a data-spread layer,
       2026-10-07).** Owner decision: the band comes from the published spread, not from widening by
       grade. Each input with a reported low and high becomes `triangular(low, median, high)`
       (extrema bounds), so the median curve is unchanged and a Monte-Carlo run draws across the
       values the sources report; an inferred `ka` takes the spread its Tmax range solves to, with
       the half-life held at its median. An input with no usable spread stays `fixed(median)`.
       Uncertainty-semantics is C ("plausible range") when every catalog input has a spread and D
       otherwise; a defaulted F is exempt. On the 2026-10-07 snapshot, 79 of 163 routes reach C here,
       and 8 models reach C overall (clonazepam, codeine, diazepam, fluoxetine, gabapentin,
       lorazepam, methadone, paracetamol — all oral).
    3. ~~**Carry per-input provenance**~~ **(LANDED, 2026-10-07).** Generation records each input's
       source in `DerivedRouteGrade.inputSources`: `cited` with its citation ids when every entry the
       value pools names a citation, otherwise `uncited` with why (a hand-entered value, an uncited
       or grandfathered entry, or a cache its entries no longer reproduce). An inferred `ka` carries
       its Tmax's source; a defaulted input has none and stays with completeness. A route whose every
       input is cited reaches C on parameter-provenance (study-level traceability, never B); any
       uncited input keeps it at D. On the 2026-10-07 snapshot, 94 of 163 derived routes reach C.
       This does not lift any model's overall grade on its own: uncertainty-semantics (item 2) is
       still D everywhere, and completeness is D for the 138 routes whose drug records no
       model-structure axis at all.
    4. Extending §5.2 to the derived track is now a live question: 2 and 3 are closed, and the
       models that reach C would be eligible under its four conditions. Until the owner extends it,
       a derived C renders to editors and admins only.

## 8. Risks & non-goals

- **Silent family wrongness** — mitigated by the explicit default flag, the prominent grade, the
  reviewed override tier, and SC-7A validation gating.
- **Non-goal:** auto-manufacturing science (unknown/unsupported ⇒ not-modelable).
- **Non-goal:** live-DB curves for the offline consumer (the checksummed snapshot stays the pinned unit).

## 9. Open decisions (remaining)

- **Model-structure review (decided):** there is no stored `asserted-cited`
  status. A disposition, elimination, or absorption axis is `asserted` when a
  cited categorical `parameter_entries` row is live. Agents may propose those
  rows, but `edit.modelStructure.decide` is floored at `editor` and the trusted
  agent self-review path cannot approve its own model-structure proposal. The
  existing pending-edit lifecycle, disputes, verification records, and audit
  trail remain authoritative; no parallel promotion state is introduced.
  Matrix transforms, observation-error layers, and covariance/random-effect
  declarations remain hand-authored registry content governed by git review,
  provenance validation, and the checksummed snapshot rather than runtime
  capabilities.
