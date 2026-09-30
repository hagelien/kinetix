# Modelling feedback — evaluation & phased realisation plan

**Status:** proposal for review · **Date:** 2026-06-25
**Source feedback:** [`docs/feedback/modelling.md`](../feedback/modelling.md)
**Related:** [`docs/kinelab-integration.md`](../kinelab-integration.md)

This document evaluates the `modelling.md` feedback against the *current* code,
records which claims are real (with file:line evidence), judges what is worth
building versus deferring, and lays out a multi-phase plan to realise it.

---

## 0. Implementation progress

Tracked against the phases in §3. Each shipped item links to its merged PR.

### Shipped

**Phase 1 — trust release (complete)**
- issue 816 — Vd `L/kg` scaling guard (forward path), ethanol chronological state
  model (single-β decay), dose back-calc from measurement time, sensitivity
  relabelled "relative correlation score".
- issue 819 — stale-result detection: input hash on every result, dimmed curves +
  out-of-date badges when inputs change.
- issue 820 — three-state parameter provenance (verified / assumption / fallback)
  with an insufficient-data warning; engine-specific assumptions panel (no more
  placeholder half-life/Vd/F for ethanol & KineLab).
- issue 821 — strict routes (immediate-absorption warning for
  insufflation/inhalation/other); honest model-card naming ("instantaneous
  absorption (no ka)").

**Phase 2 — result semantics**
- issue 822 — task-specific answer card (inferred dose / predicted /
  back-extrapolated concentration / BAC) with correctly named intervals;
  KineLab now leads with the posterior dose, not the predicted peak.
- issue 823 — genuine small multiples grouped by unit (incompatible units never
  share a y-axis; units in axis titles).
- Model-specific assumptions + correct interval names landed in issue 820 / issue 822.

**Phase 3 — PK Lite v2**
- issue 824 — Bateman first-order absorption, IV infusion, and dose-superposition
  equations as pure tested functions.
- issue 852 — repeated dosing by superposition wired into the forward Monte Carlo
  worker (every dose contributes; single dose stays byte-identical).
- issue 853 — IV infusion as a distinct route (`DoseEvent.durationHours` + a
  DrugPanel input; `concInfusion` composes with superposition).
- issue 858 — Bateman first-order oral absorption in the live forward curve,
  activated by an explicit `overrides.ka` (default stays instantaneous, so
  existing oral outputs are unchanged); recorded in assumptions + manifest.

**Phase 4 — KineLab inference v2**
- issue 825 — ESS as a proportion of draws + prominent low-ESS warning.
- issue 826 — true posterior predictive with residual (observation) error, so the
  band is a predictive interval, not just a credible envelope.
- issue 829 — prior-vs-posterior intervals side by side (analytic prior 5/50/95
  beneath each posterior row) to expose weak identifiability.
- issue 855 — observation matrix as a case input (selector + per-observation matrix,
  a "no conversion applied" warning off whole blood, recorded in the manifest).
- issue 861 — censored `<LOQ`/`<LOD` observations (left-censored likelihood term via
  Φ; non-detects inform the posterior instead of being dropped).
- issue 862 — model-family validation guardrail (warns when the analyte and the
  priors-derived family disagree, e.g. ethanol run as first-order).

**Phase 5 — validation platform**
- issue 827 — per-result run manifest (engine, model, seed, draws, input hash, ESS,
  app version, timestamp) surfaced in the text export.
- issue 828 — this progress ledger.

**Coverage audit — engine reach**
- Data-driven engine-coverage classifier (`hasEngineData` /
  `computeEngineCoverage`), pinning that the engine runs on **90** catalog
  components (72 first-order + 17 IV-only + ethanol), not the 4-slug curated
  list it was mistaken for. Renamed `KINELAB_SUPPORTED_ANALYTE_SLUGS` →
  `KINELAB_CURATED_ANALYTE_SLUGS` (deprecated alias kept) and documented the
  finding in `docs/kinelab-integration.md`. Settles the "only 4 analytes — is
  the engine worth maintaining?" question: yes, the reach was just mislabelled.

### Remaining

- **Phase 3:** switchable variability layers (parameter / IIV / residual /
  analytical); explicit distribution semantics stored per parameter (family,
  extrema-vs-quantile bounds, population, references). Absorption (Bateman
  issue 858), repeated dosing (issue 852) and infusion (issue 853) are done.
- **Phase 4:** adaptive draw count to an ESS/MC-precision threshold (blocked by
  exact `sampleCount` test assertions that must be reworked); **matrix
  conversion** factors with their own uncertainty (matrix-as-input shipped in
  issue 855, but concentrations are still used as-is); residual error split into
  analytical/preanalytical/biological/structural layers (the issue 826 residual is
  the assay-CV layer only). Censored observations (issue 861) and model-family
  validation (issue 862) are done.
- **Phase 5:** versioned benchmark suite (dose recovery, SBC, interval
  coverage, cross-language parity, regression reports); full remote engine
  (ODE, HMC/NUTS, hierarchical popPK, postmortem, model averaging) in the
  separate `hagelien/KineLab` backend — out of scope for this repo, wired
  behind the existing `ComputeEngine` interface.

---

## 1. Verdict on the feedback

The feedback is high quality and almost entirely accurate. Every load-bearing
technical claim was checked against the code; the table below records the
result. The headline framing is correct: **Kinetix's gap is statistical
semantics and correctness, not missing features.** The right first release is a
"trust release," not a new engine.

### 1.1 Claims verified against code

| # | Claim | Verdict | Evidence |
| - | ----- | ------- | -------- |
| C1 | Vd multiplied by weight even when not `L/kg` | **TRUE** | `src/stores/simulatorStore.ts:394-415` sets `weightScaling: needsWeightScaling \|\| !!inputs.weight`; `src/workers/montecarlo.worker.ts:267-269` multiplies `sampledVd * weight` unconditionally |
| C2 | Multiple ethanol intakes each get their own β slope → ~2β decay | **TRUE** | `src/lib/modelingRun.ts:155-167` sums `initialRise − β·elapsed` per intake |
| C3 | Dose back-calc uses query time, not measurement time | **TRUE** | `src/lib/eventDerivation.ts:115-119` builds `timeSinceDose` from `lastQuery.t` while concentration is `lastMeasurement.value` |
| C4 | Oral/insufflation/inhalation/other share one equation; only IV differs | **TRUE** | `src/lib/compute/liteBrowserEngine.ts:65-97`, `src/lib/compute/inference.ts:421-430` branch only on `isIv` |
| C5 | Model cards claim first-order absorption; equation has no `ka` | **TRUE** | cards say `one_comp_first_order_absorption` (`src/lib/compute/modelCards.ts:88-92`); equation is `(F·D/V)·e^{-kt}` (`src/lib/pkEquations.ts:36-44`) |
| C6 | Generic forward defaults are synthesized silently | **TRUE** (numbers differ) | `src/lib/compute/drugPriors.ts:73-77` → half-life 4 h ✓, **Vd 100 L** (feedback said 50), **F 0.5** (feedback said 1). Pattern is real; the cited constants are slightly off |
| C7 | Sensitivity "percentages" are normalized absolute Pearson r, not variance shares | **TRUE** | `src/workers/montecarlo.worker.ts:497-521` (abs Pearson, normalized by sum); rendered `×100` as "%influence" in `src/components/simulator/ResultsSummary.tsx:119-124` |
| C8 | Results not invalidated when inputs change | **TRUE** | results set only in `handleRunAll` (`src/pages/SimulatorPage.tsx:443-454`); `DrugSimResult` has no input hash (`src/types/simulator.ts:200-231`) |
| C9 | `yAxisMode` defined but unused; incompatible units share one axis | **TRUE** | enum at `src/types/simulator.ts:247`, init `src/stores/simulatorStore.ts:101`; `ModelingChart.tsx` never reads it — all series go to one y-axis |
| C10 | KineLab primary answer is peak concentration, not inferred dose | **TRUE** | `src/lib/modelingRun.ts:543-556` reduces to peak `median`, tagged `questionMode:'dose-from-concentration'` |
| C11 | "Posterior predictive" envelope omits residual/observation error | **TRUE** | `src/lib/compute/inference.ts:218-257` quantiles deterministic curves over parameter draws only |
| C12 | Assay CV is the entire residual-error model | **TRUE** | `src/lib/compute/inference.ts:435-442` — single lognormal σ from CV |
| C13 | ESS shown as absolute count, no proportion / prominent warning | **TRUE** | `src/components/simulator/ResultsSummary.tsx:170-175` |
| C14 | Fixed draw count, no adaptive stopping | **TRUE** | `src/lib/modelingRun.ts:503-511` clamps a fixed count |
| C15 | Non-positive measurements excluded; no `<LOQ`/`<LOD` censoring | **TRUE** | `src/lib/modelingRun.ts:433-439` `positiveFinite` filter |
| C16 | Matrix hardcoded to whole blood | **TRUE** | `src/lib/modelingRun.ts:486` `matrix:'whole_blood'` |
| C17 | Assumptions panel shows half-life/Vd/F for every engine (placeholder 0/1) | **TRUE** | `src/components/simulator/AssumptionPanel.tsx:67-69`; ethanol/KineLab stub `{halfLife:0, vd:0, f:1}` at `modelingRun.ts:242-244, 562-564` |
| C18 | No run manifest (hash, versions, timestamp) | **TRUE** | `DrugSimResult` carries `seed`/`drawCount`/`diagnostics` only; no hash/version/timestamp (`src/types/simulator.ts:200-231`) |

### 1.2 Corrections / nuances to note before building

- **C1 is only half-fixed.** Phase 2g of the KineLab work already corrected
  `L/kg` scaling on the **inference** path (`src/lib/compute/drugPriors.ts`,
  see `docs/kinelab-integration.md` §"Phase 2g"). The bug the feedback
  describes still lives on the **forward Monte Carlo** path
  (`simulatorStore.ts` → `montecarlo.worker.ts`). Scope the fix there and reuse
  the unit-aware logic already written for the inference path.
- **C6 constants:** the real fallbacks are Vd **100 L** and F **0.5**, not 50 L
  and 1. The recommendation (three explicit states: *verified* / *assumption* /
  *insufficient*) stands regardless.
- **C9 wording:** there is no "separate" mode that changes heading/height in the
  current `ModelingChart`; the enum values are `'shared' | 'independent'` and
  neither is read. Net effect is exactly as described — one shared axis.
- **i18n is a hard gate.** Per `AGENTS.md`, every user-facing string added or
  changed in these phases needs matching `en.json` + `nb.json` keys. The label
  fixes (C7, C10, C13, C17) and all new UI copy must ship bilingual.

---

## 2. What to build, what to defer

Judgement on each feedback area, ranked by value-to-effort. "Build" = clear net
win we should schedule; "Defer" = right idea but blocked on data, scope, or the
planned backend.

### Build now — correctness & trust (highest value)
- **C1** forward-path Vd `L/kg` guard — a real off-by-bodyweight error.
- **C2** ethanol chronological state model (decay total once per interval).
- **C3** dose inference from measurement time.
- **C7** rename sensitivity to "relative correlation score" (trivial, high honesty payoff).
- **C8** input-hash + stale-result dimming.
- **C4/C5** strict routes + honest model-card naming ("instantaneous absorption").
- **C6** three-state parameter provenance (verified / assumption / insufficient).

### Build next — result semantics (medium effort, high clarity)
- **C10** task-specific primary answer card (dose ⇒ posterior dose median+CI).
- **C11** correct interval labels (credible vs predictive).
- **C17** model-specific assumptions panel.
- **C9** genuine small multiples grouped by compatible unit; units in every axis title.
- Visible validation status (toy / literature-derived / validated / experimental) on the component card.

### Build after — KineLab inference v2 (medium-high)
- **C13** ESS as a proportion + prominent low-ESS warning.
- **C14** adaptive draws to an ESS / MC-precision threshold.
- Prior-vs-posterior side-by-side intervals.
- **C15** censored `<LOQ` / `<LOD` observations.
- **C16** matrix as a case input (reuse `reference_concentrations.matrix` + `conversions.ts`).
- **C11/C12** true posterior predictive (sample residual error); separate the
  residual-error layers (analytical / preanalytical / biological / structural).
- Model-family validation (don't pick the family from the mere presence of an
  `eliminationRate` prior — cross-check card, analyte, route, matrix).

### Build later — PK Lite v2 (larger; needs equations + curated data)
- Bateman one-compartment **oral absorption with `ka`** (or a Tmax-derived prior).
- **Repeated dosing by superposition** (every dose event contributes).
- **IV infusion** as a distinct route with duration/rate.
- Explicit, switchable variability layers (parameter / IIV / residual / analytical).
- Joint parameter distributions **where covariance data exists** (otherwise keep independent and say so).
- Store distribution **semantics explicitly** (family, parameterisation, whether
  bounds are extrema or quantiles, population, route, matrix, n, refs, covariance group).

### Defer — validation platform & full backend (correctly the author's last priority)
- **C18** full run manifest (a thin version can land early; see Phase 1).
- Versioned benchmark suite (dimensional analysis, dose recovery, SBC, interval
  coverage, held-out data, cross-language parity, stress, regression reports).
- Full remote engine: ODE solving, HMC/NUTS, hierarchical population PK,
  postmortem models, model averaging. The author is right that this belongs in
  the separate `hagelien/KineLab` Python backend, behind the existing
  `ComputeEngine` interface — **no UI rework required** (`docs/kinelab-integration.md` §Phase 3).

### Points of mild disagreement / scoping caution
- **Joint covariance (PK Lite v2 #4)** is only meaningful once population
  covariance data is curated into the drug DB. Until then, sampling
  independently is acceptable *if labelled as such*. Don't block the trust
  release on it.
- **Adaptive SMC** for Lite is reasonable but should follow the cheaper
  adaptive-draw-count win (C14); a full SMC sampler is a larger lift than the
  rest of Phase 4 and can be its own slice.
- **Sobol / PRCC** sensitivity is the right end state, but the immediate,
  near-free fix is the **relabel** (C7). Treat PRCC as a Phase-4 follow-up.

---

## 3. Phased realisation plan

Phases are ordered so the highest-trust, lowest-risk fixes ship first. Each
phase is independently shippable and PR-sized. Every UI string ships `en`+`nb`.

### Phase 1 — Trust release: correctness & guardrails
**Goal:** no number is wrong or silently fabricated; stale output is obvious.

1. **Vd `L/kg` guard (forward path).** In `simulatorStore.ts`, scale by weight
   only when the stored unit is explicitly `L/kg`; treat missing units as
   unknown, never implicitly `L/kg`. Reuse the inference-path logic from
   `drugPriors.ts`. Tests for `L`, `L/kg`, missing unit, and explicit overrides.
   *Files:* `src/stores/simulatorStore.ts`, `src/workers/montecarlo.worker.ts`.
2. **Ethanol chronological state model.** Replace per-intake β subtraction with
   a single state that decays total BAC once between events, then adds each
   intake. *Files:* `src/lib/modelingRun.ts` (`bacAtHour`), tests for 1 vs 2
   overlapping intakes (assert single-β decay).
3. **Dose inference from measurement time.** Derive elapsed time dose→measurement
   from `lastMeasurement.t`; a query selects the requested quantity, it does not
   relocate the observation. *Files:* `src/lib/eventDerivation.ts`, tests.
4. **Strict routes.** For the Lite engine, hide routes it does not actually model
   (or gate them behind an acknowledgement) instead of silently treating them as
   oral. *Files:* `liteBrowserEngine.ts`, route UI in `DrugPanel`.
5. **Honest model-card naming.** Rename `one_comp_first_order_absorption` Lite
   cards to "instantaneous absorption" (or keep the type but fix the
   user-facing description). *Files:* `src/lib/compute/modelCards.ts`, locales.
6. **Sensitivity relabel.** "%influence" → "relative correlation score"
   (with a one-line tooltip). *Files:* `ResultsSummary.tsx`, locales.
7. **Stale-result detection.** Add an input/config hash to `DrugSimResult`;
   recompute on every relevant edit and dim the curve + show "out of date" until
   re-run. This is the thin first slice of the C18 manifest. *Files:*
   `src/types/simulator.ts`, `simulatorStore.ts`, `ModelingChart.tsx`,
   `SimulatorPage.tsx`.
8. **Parameter provenance (three states).** Tag each PK parameter as *verified*
   / *explicit assumption* / *insufficient data*; require acknowledgement before
   a generic fallback is used and render it unmistakably. *Files:*
   `drugPriors.ts`, `AssumptionPanel.tsx`, locales.

### Phase 2 — Result semantics & honest presentation
**Goal:** every number says exactly what statistical quantity it is.

1. **Task-specific answer card** below the chart: predicted concentration /
   back-extrapolated concentration / **inferred dose** (median + CI) / BAC at
   time — label driven by the query. Peak shown only when asked. *Files:*
   `modelingRun.ts` (carry the queried quantity, not the peak), new answer-card
   component, locales.
2. **Correct interval names** — "pointwise 90% model interval" / "90% credible
   interval" / "90% predictive interval" as appropriate. *Files:* chart + answer
   card, locales.
3. **Model-specific assumptions panel** — render only parameters the engine uses;
   drop the placeholder half-life/Vd/F=0/1 rows for ethanol & KineLab. *Files:*
   `AssumptionPanel.tsx`, `modelingRun.ts`.
4. **Genuine small multiples** grouped by compatible unit; wire up `yAxisMode`;
   units in every axis title; mixed-unit overlay only after explicit
   normalization. *Files:* `ModelingChart.tsx`, `simulatorStore.ts`.
5. **Visible validation status** (toy / literature-derived / validated /
   experimental) on the component summary card. *Files:* component rail card,
   `modelCards.ts`, locales.

*(The Build→Check→Run→Interpret rail redesign and translucent therapeutic bands
from the feedback's "interface" section fold in here opportunistically; they are
presentation, not correctness, so they ride along where cheap.)*

### Phase 3 — PK Lite v2 (forward model realism)
**Goal:** the forward model earns its absorption/repeat-dose claims.

1. **One-compartment oral absorption (Bateman)** with explicit `ka`, or a
   Tmax-derived constrained prior that preserves uncertainty.
2. **Repeated dosing by superposition** — every dose event contributes.
3. **IV bolus vs infusion** as distinct routes (infusion carries duration/rate).
4. **Explicit, switchable variability layers** (parameter / IIV / residual /
   analytical).
5. **Explicit distribution semantics** stored per parameter (family,
   parameterisation, extrema-vs-quantile bounds, population, route, matrix, n,
   refs, covariance group) — replaces the implicit min–max→uniform /
   min–median–max→triangular rule.
*Files:* `src/lib/pkEquations.ts`, `liteBrowserEngine.ts`, `inference.ts`,
`modelCards.ts`, the drug-parameter type, tests.

### Phase 4 — KineLab inference v2
**Goal:** defensible Bayesian outputs.

1. **ESS as a proportion** of attempted draws + prominent low-ESS warning
   surfaced through the unified result. *Files:* `inference.ts`, `modelingRun.ts`,
   `ResultsSummary.tsx`.
2. **Adaptive draws** until ESS / MC precision crosses a threshold (cap retained).
3. **Prior-vs-posterior** intervals side by side.
4. **Censored `<LOQ` / `<LOD`** observations instead of dropping non-positives.
5. **Matrix as a case input** (reuse `reference_concentrations.matrix` +
   `conversions.ts`) instead of hardcoded whole blood.
6. **True posterior predictive** — sample residual/observation error, and split
   residual error into analytical / preanalytical / biological / structural
   layers so a precise assay cannot fake a narrow dose interval.
7. **Model-family validation** — cross-check card, parameter shape, analyte,
   route, and matrix instead of inferring the family from one prior's presence.
*(Adaptive SMC is a stretch item within this phase or its own follow-up.)*

### Phase 5 — Validation platform & full backend separation
**Goal:** reproducibility and a path to serious posterior computation.

1. **Full run manifest** (extends Phase 1's hash): engine + model version,
   source commit, drug-revision IDs, references, unit + matrix, seed, attempted
   vs valid draws, diagnostics, timestamp. Enables automatic stale detection and
   exact report provenance.
2. **Versioned benchmark suite**: equation/dimensional-analysis tests, synthetic
   dose recovery, simulation-based calibration, interval-coverage, held-out
   error/bias, cross-language parity vs the reference Python implementation,
   stress tests, and regression reports committed with every model-version bump.
   A card may reach `validated` only once population/route/matrix/window/bias/
   coverage/failure-modes are documented.
3. **Full remote engine** behind the existing `ComputeEngine` interface (ODE,
   HMC/NUTS, hierarchical popPK, clearly-separated postmortem models, model
   averaging) — flip `VITE_KINELAB_COMPUTE_MODE=full`, no UI rework
   (`docs/kinelab-integration.md` §Phase 3).

---

## 4. Sequencing summary

```
Phase 1  Correctness & guardrails        ← ship first ("trust release")
Phase 2  Result semantics & presentation
Phase 3  PK Lite v2 (absorption, repeat dosing, infusion, residual layers)
Phase 4  KineLab inference v2 (adaptive, prior/posterior, matrix, censoring, true predictive)
Phase 5  Validation platform + full remote backend
```

This matches the feedback's own recommended order, with two refinements grounded
in the code: (a) the Vd fix is scoped to the *forward* path because the
inference path was already corrected in KineLab Phase 2g, and (b) the run
manifest is split — a thin input-hash lands in Phase 1 for stale detection, the
full manifest in Phase 5.

The single most valuable deliverable remains the **trust release (Phase 1)**:
fix the wrong calculations, make stale and assumption-driven outputs obvious,
and ensure every number states what kind of statistical quantity it is.
