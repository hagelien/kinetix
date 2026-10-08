# How the Kinetix simulator works

**Audience:** pharmacologists and toxicologists reviewing whether a Kinetix curve may be
relied on. No programming knowledge is assumed. Nothing below describes code structure;
everything below describes what is assumed about the drug, the subject and the
measurement.

**This page is the simulator's own account of itself.** The prose here lives in
`docs/simulator-mechanics.md` and is published at `/modeling/how-it-works`; every table of
analytes, families, limits and versions on that page is generated from the running engine
at page load, and the statements in this prose are pinned by an automated check
(`src/lib/__tests__/simulatorMechanics.test.ts`) that fails the build when the document and
the engine disagree. If you find a discrepancy between this page and a curve you ran, that
is a defect — please report it rather than reconciling it yourself.

{{live:versions}}

---

## 1. What the simulator is, and what it is not

Kinetix's modelling module answers three different questions with three different engines.
They share a chart, a case file and an event timeline; they do **not** share mathematics.

| Engine | Question it answers | Direction |
| --- | --- | --- |
| `pk-montecarlo` | Given a dose history, what concentration–time curve follows? | Forward |
| `ethanol-widmark` | Given a drinking history, what blood-alcohol curve follows? | Forward |
| `kinelab-bayes` | Given a measured concentration, what dose and timing could have produced it? | Inverse |

Everything in sections 2–9 concerns the **forward PK engine** (`pk-montecarlo`), which is
what "the simulator" normally means. Section 10 covers ethanol, section 11 the inverse
(back-calculation) engine, and section 12 the metabolite-pattern module.

**The simulator is a population-typical predictor with a pinned parameter set** — reviewed
where a reviewer authored it, catalogue-derived and graded where the derived tier is switched
on for the build (§2). It is not a patient-specific model, not a fitted model, and it does not
learn from the case in front of it. It takes no measured concentration as input and cannot be conditioned on one.
If you have a measurement and want to reason backwards from it, you want the inverse
engine (§11), not this one.

---

## 2. The premise that governs everything else: parameters are pinned, not looked up

A forward run does **not** read the drug catalogue. It resolves the analyte against a
**pinned, checksummed registry** of model definitions, and runs whatever that registry holds.

This is a deliberate trade, and it is the single most important thing to understand about
the simulator:

- **What it buys.** A curve is reproducible. The same scenario, on any machine, in any
  release pinned to the same registry checksum, produces the same curve. An enrichment
  pass, a corrected half-life, or an agent's edit to the drug catalogue cannot silently
  move a curve someone has already relied on in a case.
- **What it costs.** A drug that is in the Kinetix catalogue but not in the release this build
  resolves **cannot be simulated at all**. There is no reading of catalogue half-life and Vd at
  run time. The run stops with an explicit "no model for this analyte" rather than producing a
  plausible-looking curve from numbers nobody pinned.

**Two tiers, and the registry knows which is which.** The release always carries the **reviewed**
tier: hand-authored, cited, cross-checked. Where the derived tier is switched on for the build
(`VITE_DERIVED_REGISTRY_ENABLED` — the release block above reports whether it is), the release
*also* carries **catalogue-derived** definitions: composed automatically from the stored
declarations, then pinned into a committed, checksummed artifact like everything else, so
reproducibility is unchanged. What is different is that nobody reviewed them. They are never
merged into one undifferentiated set:

- each row below carries its validation status, and `literature-derived` marks a derived model;
- a derived model discloses which of its inputs — structural axes, and possibly the
  administration route itself — were defaults rather than readings (§5, §6.3);
- it is graded like any model (§5): most grade **D**, and their curve is withheld unless a
  reviewer records an acknowledgement; one that reaches **C** renders to editors and admins
  with its limitations, and to nobody else.

Read the table as "what this build can resolve", not "what has been reviewed".

The reviewed tier is therefore small on purpose. The set of analytes this build resolves, and each
one's routes, native matrix and validation status, are listed below — read straight from the
release the app resolves through, so this table is the honest answer to "what can this
thing actually simulate?".

{{live:models}}

**Reviewed-tier** parameters are cross-checked against the drug catalogue by a separate
provenance gate: every catalogue-checkable parameter is recorded either as `catalog` (and held
within tolerance of `data/components.ts`) or as `reviewed-override` with a written rationale. A
silent divergence between the reviewed registry and the catalogue is a test failure, not a
judgement call. That gate does not extend to the derived tier, which is *generated from* the
catalogue rather than checked against it — what stands behind a derived model instead is its
grade and the coverage report that names every gap and every assumed route.

---

## 3. Step by step: how one curve is produced

### Step 1 — Resolve the model

The analyte id is looked up in the registry. Failure here is terminal for the run. If the
model exists, the scenario's route must be one the model declares — a model reviewed only
for sublingual dosing refuses an oral scenario rather than reusing the sublingual
parameters. The dose basis (parent drug, active moiety, salt, free base) must likewise be
one the model declares; an unsupported basis is refused rather than silently mis-scaled.

### Step 2 — Scale the volume of distribution to the subject

Each route declares how its Vd scales:

- **total body weight** — `Vd = Vd/kg × weight`. The default, used for lipophilic drugs.
- **lean body mass** — `Vd = Vd/kg × 70 × (LBM / 56)`, LBM from the Boer (1984) equation.
  For drugs distributing into lean/water mass rather than fat. **Requires height and sex.**
- **Widmark** — `Vd = weight × r`, where `r` is total body water (Watson 1980) divided by
  `weight × 0.806`, clamped to 0.4–0.9. The ethanol distribution volume. **Requires age,
  height and sex.**

A model needing a covariate the scenario does not carry is refused. It is never
substituted with weight scaling, because that would change the curve without saying so.

### Step 3 — Apply declared covariate effects, and only those

The engine applies a covariate effect **only where a reviewed model declares a covariate
function for it**. There is no generic renal or hepatic dose adjustment, no universal age
or sex multiplier, and no automatic impairment scaling. A subject covariate that is
recorded but not declared by the model is surfaced as an explicit limitation on the result
("recorded but this model does not use it; it did not affect the curve") rather than
quietly ignored.

### Step 4 — Evaluate the central (median) curve

The reported median is always the **deterministic curve computed from the central
parameter values** — never a percentile of the simulated sample. This keeps the median
independent of seed and draw count, and identical between a deterministic run and an
uncertainty run.

How the curve is evaluated depends on the model family:

- **Closed-form families** (the one-compartment set) evaluate an analytic solution — an
  IV-bolus exponential, a Bateman first-order-absorption curve, a zero-order input, or a
  mixed-order combination — at each output time, and superpose doses linearly. Because
  they are linear, multiple doses simply add.
- **ODE families** (two-compartment, Michaelis–Menten, parent→metabolite) are integrated
  numerically over the whole scenario at once with a fixed-step fourth-order Runge–Kutta
  scheme. Doses cannot be superposed for these: Michaelis–Menten elimination and
  metabolite formation are not linear in dose, so the whole history is integrated
  together.

Mixing an ODE family with a differently-modelled route in one run is refused rather than
approximated. The implemented families, and which analytes use each, are:

{{live:families}}

### Step 5 — Sample the uncertainty bands

When an uncertainty run is requested (the default in the UI), each parameter carrying a
distribution is drawn repeatedly from a **seeded** pseudo-random generator, the curve is
recomputed per draw, and the 5th/25th/75th/95th percentiles across draws form the reported
bands. Draws producing non-physical parameters (a non-positive volume, a bioavailability
outside 0–1, and so on) are resampled once, then discarded.

**Read this together with §8.5.** A parameter authored as a point value has nothing to
draw: every draw reproduces the same curve, and the reported percentiles land exactly on
the median. The model table above states, per model, whether its bands can widen at all.
Requesting more draws does not change that — it repeats the same arithmetic.

Two disclosures follow from this, and both are reported on the result:

- if some draws were discarded, how many actually contributed to the bands;
- if fewer than the stated fraction of draws survived, the run is downgraded to
  **not-robust** and the bands are declared unreliable.

Because the median is the deterministic central curve rather than the sampled p50, a band
can sit slightly off-centre around the median. That is expected, not an error.

### Step 6 — Refine the peak off the grid

Cmax and Tmax are not read off the output grid alone. For closed-form families the engine
re-scans the exact analytic curve in fine windows around each dose, so a fast-absorption
route whose true peak falls between output samples is not understated. The reported time
series still uses the requested grid; only the peak is refined. **ODE families do not get
this refinement** — their Cmax is the best grid sample, and a coarse grid can understate
it.

The refinement is itself budgeted, and both ends of that budget are visible to you. Its
finest resolution is fixed (see the table in §8), so a peak narrower than that is still
approximated. When a case carries more doses than the budget can refine individually, the
largest-contribution doses are refined first and the result carries an explicit
`peak-under-refined` note saying how many clusters were covered — a narrow peak at a
smaller dose may then be understated, and a finer output grid recovers it. A case with so
many doses that not even a minimal scan fits is **refused** rather than scanned
unbounded.

### Step 7 — Convert to the observed matrix, if asked

Everything above is a **latent prediction in the model's native matrix** (usually plasma).
Reporting it in another matrix (e.g. whole blood) happens only through a
**model-declared, reviewed conversion ratio**. There is no generic blood:plasma factor. A
cross-matrix request the model does not cover is refused rather than relabelled. When a
conversion is applied it is recorded on the result with its ratio and rationale.

A conversion is a deterministic point ratio: every percentile and the peak are scaled by
the same factor. **The uncertainty in the ratio itself is not propagated** — a converted
band is no wider than the native band, which understates the true uncertainty of a
converted value.

*(The chart's display-matrix control is a separate, cruder mechanism — see §8.)*

### Step 8 — Widen for observation error, where a model declares it

The bands so far describe **parameter and between-individual variability of the latent
kinetics**. A real measurement also carries error the kinetics do not: assay imprecision,
preanalytical handling and stability, unmodelled biological variation, structural residual
error. Where a model declares reviewed layers for these, they are composed in variance and
convolved into the bands; the median is unchanged, because the error is zero-mean. Models
declaring no such layer report parameter variability only — meaning their bands are
**narrower than a measurement's true spread**.

---

## 4. What each part of a result means

| Reported quantity | What it is | What it is not |
| --- | --- | --- |
| Median curve | The deterministic prediction at central parameter values | Not the mean of the simulated sample, not a p50 |
| p05–p95 band | Pointwise 90% interval from parameter variability (plus declared observation error) | Not a prediction interval for one named individual; not a confidence interval on a fitted parameter. Where the model carries only point parameters this band sits **on** the median and says nothing at all — see §8.5 |
| Cmax / Tmax | Peak of the median curve (grid-refined for closed-form families) | Not a percentile of peak values across draws |
| `not-robust` status | Too few draws survived the physicality filter | Not a statement about the drug |
| Limitations list | Everything the run had to assume, ignore or convert | Not exhaustive of scientific limitations — see §9 |

A pointwise band is not a simultaneous band. The p95 curve traced across time is **not**
the trajectory of a 95th-percentile individual; it is the locus of pointwise 95th
percentiles, and no single simulated subject follows it.

---

## 5. Where the numbers come from, and how honest the label is

Every parameter shown in the **Assumptions** panel beside a curve carries a provenance
tag:

- **literature** — a literature-backed catalogue value; where references are attached, the
  panel replaces the tag with a hoverable list of them;
- **your assumption** — a value you entered or overrode;
- **no data — default** — a generic default was used. A result using any of these carries
  an explicit warning that it is illustrative only, not an evidence-based estimate.

Separately, every model reaching the chart is scored by an **evidence grade policy** over
eight dimensions — completeness, primary-source review, parameter provenance, population
applicability, matrix/route match, validation status, uncertainty semantics, and
unresolved contradictions. The overall grade is the **weakest link**, not an average, and
some findings are hard stops that no acknowledgement can bypass (the curve is withheld and
the reason shown instead). Grades below the threshold for your role are withheld unless
you record an explicit acknowledgement, and that acknowledgement does not travel into
exports or share links.

The two tiers are treated differently, and deliberately so:

- **Reviewed models** — hand-authored, cited, cross-checked against the catalogue.
- **Catalogue-derived models** — composed automatically from stored declarations, with any
  unstated structural axis defaulting to linear one-compartment kinetics and that default
  disclosed as an assumption. **The administration route can be a default too.** Where the
  catalogue names no route for a drug but holds a Tmax or a bioavailability — quantities
  that describe an absorption phase, not a molecule — the route is taken to be **oral** and
  the model records that the route was *attributed* rather than read. That assumption is
  counted against the model's completeness exactly as a defaulted structural axis is, and it
  is stated on the curve. Read it for what it is: the catalogue evidenced *some*
  extravascular route and did not say which. **A declared structure can also be simplified.**
  Where the catalogue cites a *two-compartment* disposition but holds none of the
  parameters that form needs (the inter-compartment rate constants and the central
  volume), the curve is drawn with the **one-compartment** form instead of not being drawn
  at all, and the model records the simplification. It counts against completeness exactly
  as a defaulted axis does, because the curve is not the model the evidence describes: it
  has no distribution phase, so concentrations shortly after a dose are the ones to
  distrust. Only disposition is ever simplified this way — a drug whose elimination is
  cited as saturable (Michaelis–Menten) is never drawn with first-order elimination.
  **A saturable elimination is built from its own two numbers.** Where a drug's elimination
  is cited as saturable and the catalogue holds its maximum elimination rate (Vmax) and its
  Michaelis constant (Km), the curve runs the saturable form, so concentrations climb faster
  than dose at high doses and fall at a near-constant rate until the level drops below Km.
  Until both are stored, the drug gets no curve. Its absorption rate must be stored too:
  under saturable elimination the time to peak depends on the dose, so a recorded Tmax is
  never solved for an absorption rate. The half-life such a model carries is a label only;
  it does not move the curve.
  **A missing bioavailability takes a cautious default.** Where the catalogue holds no
  bioavailability for a dosed substance's route, the curve assumes the whole dose is
  absorbed (F = 100 %). Concentration is proportional to F at every time, so this pushes
  the whole curve toward *higher* concentrations — and a dose worked back from a
  concentration toward a *lower* one — and it is named at the curve and grades completeness
  C. Nothing else is defaulted. An absorption rate has no cautious value: faster absorption
  raises the early peak but lowers every later concentration, so any default would be wrong
  in one direction or the other depending on the time asked about. A half-life or a volume of
  distribution has no cautious direction either. A drug missing any of these gets no curve.
  **Each input is drawn across its published spread.** Where the catalogue holds the lowest and
  highest value an input's sources report, the model draws that input across them on a
  triangular distribution peaked at the pooled median, so the median curve is the one the
  median values give and a Monte Carlo run produces a band. An absorption rate solved from a
  time to peak takes the range the reported Tmax range solves to, with the half-life held at its
  median. Inputs are drawn independently and the extremes are treated as bounds, so the band is
  a **plausible range** — the curves the reported values allow — and never a confidence or
  prediction interval. An input with only one reported value stays fixed at it.
  Most derived models grade **D**: a model-structure axis is a default, an input has no reported
  spread, or a value traces to no cited source. Those reach a reviewer only through a recorded
  acknowledgement. A model clear of all three can reach **C**. Either way, only when the derived
  tier is switched on at all.

---

## 6. Structural assumptions you are accepting when you read a curve

1. **Linear, time-invariant kinetics unless the model says otherwise.** Clearance and
   volume do not change with dose, time, or accumulated exposure, except in the
   Michaelis–Menten and mixed-order families.
2. **Instantaneous, complete distribution within a compartment.** A one-compartment model
   has no distribution phase; an early-time concentration after IV dosing is therefore
   systematically misstated by one-compartment models.
3. **Bioavailability and absorption rate are route properties, not occasion properties.**
   Food, formulation, gastric emptying, nasal mucosal state, and inhalation technique are
   not modelled. Between-occasion variability is not represented at all. It follows that on
   a catalogue-derived model whose route was *attributed* (§5), the F and Tmax behind the
   curve are route-specific values whose route the catalogue never recorded: they may have
   been measured after a sublingual, buccal, intranasal or intravenous dose and are being
   read here as oral. A drug whose real route is not oral is therefore misparameterised, not
   merely mislabelled — sublingual buprenorphine and intravenous thiopental are the shape of
   that error. Keying the route on the stored value (the drug editor's route selector) is
   what removes the assumption; until then, check the route before trusting the magnitude.
4. **Doses add.** For the closed-form families, multiple doses superpose linearly. Any
   auto-induction, saturation, or depletion across a dosing history is absent unless the
   model is Michaelis–Menten.
5. **The subject is a healthy adult of the stated weight.** Pregnancy, extremes of age,
   organ impairment, dialysis, critical illness and drug–drug interactions are not
   modelled — see §7 and §8.
6. **The concentration is a systemic, unbound-plus-bound total in the stated matrix.**
   Protein binding is not modelled; there is no free-fraction calculation, and no
   correction for altered binding in disease.
7. **Death is not modelled.** Postmortem redistribution, agonal changes and site-of-draw
   effects are outside every forward model here. Postmortem reference bands shown on the
   chart are observational overlays, not model output, and must not be read as predictions
   the model makes.

---

## 7. Interactions, metabolism and the parts that are deliberately absent

The forward simulator has **no drug–drug interaction model**. Simulating two drugs in one
case runs two independent models on one chart; neither knows the other exists. Enzyme
inhibition or induction, competition for a shared pathway, and pharmacodynamic interaction
are all absent. Kinetix holds a rich enzyme/metabolism knowledge base, but it informs the
wiki and the metabolite-pattern module (§12) — **it does not feed the forward curve.**

Metabolites appear on a forward curve only where a model is explicitly a
parent→metabolite family, which couples formation and elimination with declared formation
fraction and molar masses. For every other model, a metabolite is either its own registry
entry simulated independently, or absent.

Genotype is not a covariate. Phenotype (poor/ultra-rapid metaboliser) is not a covariate.
Neither can be entered, and neither affects a curve.

---

## 8. Constraints in the current build that will surprise you

These are properties of what is running today, not of pharmacokinetics. They are the
things a reviewer most often assumes work and finds do not.

1. **The forward simulator supplies only body weight.** Height, sex, age and organ
   function are not passed from the modelling UI to the forward engine. A model whose Vd
   scales by lean body mass or the Widmark factor therefore **cannot run at all** from the
   simulator UI — it fails with an explicit "requires the subject height/age" rather than
   silently substituting weight scaling. The model table in §2 marks exactly which models
   this affects. This is a real gap in the wiring, disclosed rather than papered over.
2. **Infusions are not modelled from the UI.** A per-dose infusion duration cannot be
   honoured — infusion duration is a registry route property, not a scenario input — so a
   dose entered with a duration is refused rather than simulated as a bolus.
3. **Between-individual variability with a declared covariance structure is refused, not
   approximated.** A model declaring correlated random effects fails the run rather than
   producing bands that omit the declared layer. The same holds for declared dose, purity,
   timing and adherence uncertainty. A band that would understate its own model is treated
   as worse than no band.
4. **The chart's display-matrix control is not the reviewed matrix transform of §3.7.** It
   applies a pooled catalogue blood:plasma ratio to the displayed curve, discloses the
   factor beside the assumptions, and **does not propagate that ratio's own spread**. Read
   a converted curve as an approximation, and prefer the native matrix for anything
   quantitative.
5. **A band that sits on the median means "not characterised", not "precise".** Reviewed
   registry parameters are authored as single point values wherever the review did not
   establish a defensible spread, and a catalogue-derived input with only one reported
   value stays fixed at it (§5). For a model with no spread at all the Monte Carlo run
   produces the identical curve on every draw and the reported percentiles collapse onto
   the median — the run is deterministic however many draws are requested. The model
   table in §2 marks exactly which models are in that state today, and it is the state to
   check before reading a tight band as evidence of a well-characterised drug. This is
   the simulator's most consequential current weakness: the curve is a defensible central
   prediction, but it carries no honest interval around itself.
6. **A catalogue-derived route may be an assumption rather than a reading.** The stored
   parameters carry an optional administration route, and most of the catalogue leaves it
   empty. A drug with route-less absorption evidence derives an **oral** model (§5, §6.3),
   flagged as attributed and graded down for it — the alternative, deriving nothing, left
   694 of 697 catalogue drugs with no model at all. The coverage report names every route it
   attributed, so the assumption is auditable and each entry is a curation task rather than
   a permanent claim.
7. **Cmax on ODE families is grid-limited** (§3.6).
8. **The seed and draw count are fixed defaults** unless overridden per component; both
   are stated below. Two runs of the same case are identical by construction, which means
   agreement between runs is *not* evidence of numerical stability.
   A per-component draw-count override is normalised before the run rather than
   rejected: a fractional value is truncated, a value above the engine cap
   (`maxDraws`, below) is clamped to it, and a non-finite or non-positive value reverts
   to the default. If the engine still refuses the run for exceeding a compute budget
   (grid points × doses × draws × emitted analyte series — two for a parent→metabolite
   model — or ODE integration work, which depend on the model family, the time window
   and the number of doses), the run is retried with fewer draws
   until it is admitted. The count stored on the component can therefore differ from the
   count the engine ran; the run manifest states the count actually used.

Every number that configures or bounds a run:

{{live:limits}}

---

## 9. Strengths and weaknesses, stated plainly

**Strengths**

- Reproducible by construction: pinned registry, seeded sampling, deterministic median,
  and a run manifest carrying engine version, registry version and checksum, seed, draw
  count and accepted draws.
- Refusal over silent approximation. Nearly every gap in this document ends in an explicit
  failure or a recorded limitation rather than a default. Where a default IS used — the
  one-compartment structure, a cautious bioavailability — it is named at the curve and graded
  down; an input with no cautious direction stays missing.
- Provenance to the primary source for catalogue-backed parameters, with references
  reachable from the curve.
- An evidence grade that gates rendering by role, with hard stops that cannot be
  acknowledged away.
- Cross-runtime numerical identity: the engine is shared with a second application and
  pinned by parity tests, so a curve is not an artefact of one platform's arithmetic.

**Weaknesses**

- Very narrow analyte coverage relative to the drug catalogue (§2), and no fallback.
- Structurally simple models — mostly one-compartment — for drugs with known distribution
  phases.
- No interaction, no metabolism-driven kinetics, no phenotype, no impairment (§7).
- Population-typical only: no individualisation, no fitting to an observed concentration,
  no Bayesian forecasting from a measured level.
- **Uncertainty is largely absent rather than merely incomplete** (§8.5): where a model's
  parameters are point values, the bands collapse onto the median and the run is
  deterministic. On top of that, and biasing every band that does exist **narrow**: no
  between-occasion variability, no correlated random effects, no input uncertainty, no
  matrix-ratio uncertainty, and observation error only where a model declares it.
- Forward covariate wiring is incomplete (§8.1), so several reviewed models are currently
  unreachable from the UI.
- Validation coverage is uneven. A model's `validationStatus` is stated per model on the
  published page; `toy` and `literature-derived` are not `validated`.

**The honest summary:** the simulator is a defensible tool for *what-if* reasoning about a
small set of substances in a healthy adult, with unusually strong reproducibility and
disclosure. It is not a forensic back-calculation instrument, and its bands are at best a
lower bound on the true uncertainty — and, for a model carrying only point parameters, no
statement about uncertainty at all.

---

## 10. The ethanol engine

Ethanol on the forward path uses a **Widmark zero-order model**, not the PK engine:

- Volume of distribution is `weight × r`, with `r` defaulting to 0.68 (male) or 0.55
  (female), overridable per case.
- Elimination is a single zero-order slope β applied to the **whole body pool**, defaulting
  to 0.015 g/dL/h. Multiple drinks decay the pool once across each interval rather than
  decaying independently — two overlapping drinks do not clear at twice β.
- Each intake raises BAC instantaneously: **no absorption phase, no lag, no food effect.**
- The result is a **deterministic point estimate with no uncertainty band.** Widmark's own
  parameter spread (r, β, absorption completeness) is not propagated. Treat a single BAC
  number as a point on an undrawn distribution.
- The registry also holds a Michaelis–Menten ethanol model, which is what a truly saturable
  low-BAC tail requires; the Widmark path does not use it.

For forensic back-calculation of ethanol, the workbook flows — with their own parity
suite — are the intended surface, not this curve.

---

## 11. The inverse engine (KineLab back-calculation)

Given a measured concentration at a known time, the inverse engine infers the dose and
intake timing that could have produced it. It is Bayesian, and its mechanics differ from
the forward engine at every step:

- **Priors** are built from the drug's stored half-life, volume of distribution and
  bioavailability ranges — the live catalogue, not the pinned registry. A curated subset of
  analytes additionally carries a hand-validated model card; anything else with the
  required fields runs on catalogue priors alone.
- **Inference is importance sampling**: parameters are drawn from the priors, each draw is
  weighted by the likelihood of the observed concentration under an assay-error model, and
  the weighted sample forms the posterior. Draws that are non-physical, or that imply a
  sample taken before intake, are rejected.
- **The reported interval is a 90% posterior credible interval**, which is a different
  object from the forward engine's parameter-variability band. The UI labels the two
  differently on purpose.
- **Effective sample size is the diagnostic that matters.** Importance sampling degrades
  when the prior is a poor match for the observation; the run reports ESS and flags it as
  low or critical against published thresholds. **A critical ESS means the posterior is
  dominated by a handful of draws and must not be quoted.**
- **Structural approximation is disclosed.** A parent/metabolite model card runs as a
  parent-only first-order approximation, because the sampler does not implement the
  coupled mechanism — the result says so rather than implying the richer model.
- The same absent physiology as the forward engine applies: no interaction, no phenotype,
  no impairment, no postmortem redistribution.

An inverse result is only as good as its prior. Where the prior is a wide catalogue range,
a wide posterior is the correct answer, not a failure of the method.

---

## 12. The metabolite-pattern module

The pattern module reasons about **ratios between measured analytes** (parent/metabolite,
and matrix-normalised concentrations) against reference distributions and rule-based
signals. It is an interpretive aid over observed data — it does not simulate a
concentration–time curve, and it shares no mathematics with the engines above. Its signals
carry their own evidence and artefact rules and should be read on their own terms.

---

## 13. How to check the simulator against your own expectation

1. Run the drug at a dose and route you know well; compare Cmax and Tmax against the
   literature you trust.
2. Open the **Assumptions** panel and read the parameter values, their provenance tags and
   their distributions — that is what actually produced the curve, and it may not be what
   the drug's monograph says (§2). A parameter shown as `(fixed)` contributes no width to
   the band.
3. Read the **limitations** on the result. Every conversion, ignored covariate, discarded
   draw and applied approximation is listed there.
4. Check the **evidence grade** and its limiting dimension.
5. Confirm the model's **native matrix** matches the matrix you are reasoning in, and that
   any conversion applied is a reviewed one rather than the display control (§8.4).
6. If anything is inconsistent with this document, that is a defect worth reporting.

---

## 14. Keeping this document true

This document is a maintained artefact, not a snapshot:

- The published page renders its analyte, family, route, limit and version tables **from
  the running engine**, so those cannot go stale.
- `src/lib/__tests__/simulatorMechanics.test.ts` asserts that the claims in this prose
  still hold against the code — the engine list, the family and route vocabularies, the
  registry contents, the guardrail values, and the specific limitations named in §8. A
  change to the simulator that this document does not reflect fails that test.
- The `simulator-mechanics` CI workflow runs that check on every change to the engine, the
  registry, the modelling wiring, or this file.

If you change the simulator, change this document in the same commit. The test is there to
make that unavoidable, not to be worked around.
