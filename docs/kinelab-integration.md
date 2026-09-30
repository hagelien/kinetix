# KineLab integration plan (adapted for Kinetix)

## Why this document exists

The original "KineLab Lite / Future Full Compute Architecture" spec describes a
greenfield Next.js app. Kinetix is **not** Next.js — it is a Vite + React 18
SPA with raw `node:http` Vercel serverless functions, Drizzle ORM on Neon
PostgreSQL, Zustand stores, Comlink web workers, and a bilingual i18n layer.
Kinetix also already has most of the building blocks the spec asks for:
a multi-drug PK simulator, a Monte Carlo web worker, a drug catalog with PK
parameters, multi-matrix reference concentrations, citation tracking, and a
moderator/review workflow.

Rather than build a parallel "KineLab Lite" app, we add KineLab as a **forensic
inverse-inference mode inside Kinetix** that reuses everything already in
place. This document is the source of truth for that integration; it
supersedes the standalone spec for any conflict.

## Engine coverage — how many components can KineLab actually run?

A recurring worry is that KineLab only supports a handful of analytes and is
therefore not worth maintaining. That worry is based on two small, misleading
numbers in the code:

- **`modelCards.ts`** ships **6** hand-written cards (ethanol, GHB, ketamine,
  diazepam, amphetamine, morphine). A missing card is **not** a gate — the
  engine falls back to generic one-compartment assumptions and still runs.
- **`KINELAB_CURATED_ANALYTE_SLUGS`** lists **4** slugs. This is referenced
  only by tests and a re-export; it gates **nothing** at runtime. It is the
  hand-validated tier, renamed from the old `KINELAB_SUPPORTED_ANALYTE_SLUGS`
  (kept as a deprecated alias) to stop it reading as "the components the engine
  can run".

**Neither number reflects the engine's real reach.** The `kinelab-bayes` engine
option is offered for every component, and `buildInferenceInput` builds priors
from any drug row via `buildPriorsFromDrug`. The true limit is whether a row
carries the priors the engine consumes; when it doesn't, priors are synthesized
from fallbacks and flagged in the priors summary.

Coverage over the seeded catalog (`data/components.ts`, pinned by
`engineCoverage.test.ts`):

| Tier                | Count | Meaning                                                          |
| ------------------- | ----: | --------------------------------------------------------------- |
| **First-order**     |  **72** | half-life + Vd + F present → clean run on any route             |
| IV-only             |    17 | half-life + Vd but no F → clean for IV; F falls back otherwise   |
| Zero-order (ethanol)|     1 | Widmark branch; literature-derived elimination-rate prior       |
| Fallback-only       |    80 | missing half-life or Vd → runs only on synthesized priors       |
| **Engine-ready**    |  **90** | first-order ∪ IV-only ∪ zero-order                              |
| Total               |   170 |                                                                 |

The 72 first-order components cover the clinically relevant bulk of the
catalog: all benzodiazepines, the opioids (morphine, fentanyl, oxycodone,
methadone, tramadol, codeine, buprenorphine), the antidepressants and
antipsychotics (amitriptyline, fluoxetine, sertraline, venlafaxine, olanzapine,
quetiapine, clozapine, haloperidol…), amphetamine, ketamine, cocaine and
paracetamol.

`hasEngineData` / `computeEngineCoverage` (`src/lib/compute/`) are the
data-driven source of truth for this; the counts above are derived from the
catalog rather than hardcoded, so the answer stays honest as PK parameters are
edited.

> **Slug alignment (fixed).** The curated list, the ketamine/amphetamine model
> cards' `analyteSlug`, and `DEFAULT_KINELAB_ANALYTE` previously used the
> Norwegian-ish `ketamin` / `amfetamin`. The seeder slugifies the English name
> (`Ketamine` → `ketamine`, `Amphetamine` → `amphetamine`) and the API resolves
> slugs by **exact match**, so the production API returns *"Drug not found"* for
> `?slug=ketamin`. The old slugs therefore silently broke two runtime paths: the
> default KineLab component never loaded (`fetchDrugComponentBySlug('ketamin')`)
> and `findModelCardByAnalyte('ketamine')` never matched the `ketamin`-keyed
> card, so ketamine/amphetamine runs fell back to generic assumptions. All
> occurrences are now aligned to the seeded English slugs.

## What changes vs. the original spec

| Original spec (Next.js greenfield)                                           | Kinetix-integrated equivalent                                                                                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process.env.NEXT_PUBLIC_KINELAB_COMPUTE_MODE`                               | `import.meta.env.VITE_KINELAB_COMPUTE_MODE` (browser)                                                                                                                        |
| `KINELAB_FULL_COMPUTE_ENABLED` (server)                                      | unchanged — read in `api/jobs/*.ts` via `process.env`                                                                                                                        |
| `KINELAB_FULL_COMPUTE_API_URL`                                               | unchanged — read server-side only                                                                                                                                            |
| `/src` greenfield tree                                                       | Live alongside existing `src/` tree                                                                                                                                          |
| `/src/domain/*-schema.ts`                                                    | `src/lib/compute/types.ts` + reuse of `src/types/index.ts`, `src/types/simulator.ts`                                                                                         |
| `/src/compute/*`                                                             | `src/lib/compute/*` (matches existing `src/lib/` convention)                                                                                                                 |
| `/src/compute-lite/*`                                                        | folded into `src/lib/compute/lite/` so the engine and its helpers are colocated                                                                                              |
| `/src/workers/inference.worker.ts` (new)                                     | extend existing `src/workers/montecarlo.worker.ts` (forward sim already done; add `infer()` step)                                                                            |
| `/app/api/jobs/...` (Next.js dynamic route)                                  | flat Vercel functions: `api/jobs/start.ts`, `api/jobs/status.ts`, `api/jobs/result.ts` (jobId via `?jobId=…` query, matching existing kinetix conventions)                   |
| Brand-new `Analyte` schema                                                   | reuse `drugs` table + `DrugComponent` type. KineLab `Analyte` = Kinetix drug.                                                                                                |
| Brand-new `Matrix` schema                                                    | reuse `reference_concentrations.matrix` enum (`whole_blood`, `serum`, `plasma`, `femoral_blood`, `cardiac_blood`, `urine`, `vitreous`, `other`) and `src/lib/conversions.ts` |
| Brand-new `Case`/`Observation` tables                                        | reuse `simulator_cases.case_data` JSONB; namespace KineLab-specific cases by `case_data.kind === 'kinelab-case'`                                                             |
| IndexedDB local storage                                                      | reuse the existing `localStorage` + `simulator_cases` API split                                                                                                              |
| Brand "KineLab" everywhere                                                   | new `/kinelab` route inside Kinetix when UI ships; the React SPA stays branded "Kinetix"                                                                                     |
| Initial analyte set: ethanol, GHB, ketamine, diazepam, amphetamine, morphine | unchanged — all six already exist in `data/components.ts`. Model cards reference them by `pubchem_cid` / `slug`.                                                             |

## Architectural principle (preserved verbatim from spec)

```
KineLab
  ├── LiteBrowserEngine (now)
  └── FullRemoteEngine  (later)
```

UI talks to a `ComputeEngine` interface. Engines return shared result schemas
defined with Zod. Adding the Full backend later requires no UI changes — only
flipping `VITE_KINELAB_COMPUTE_MODE=full` and configuring the server-side
backend URL.

## Scope by phase

### Phase 0 — Scaffolding (this PR)

What lands now:

1. `src/lib/compute/` directory with:
   - `types.ts` — `ComputeEngine` interface + Zod schemas for `SimulationInput`,
     `SimulationResult`, `InferenceInput`, `InferenceResult`,
     `ScenarioComparisonInput/Result`, `ReportInput/Result`, `Assumption`,
     `Limitation`, `DiagnosticSummary`, `ComputeCapability`. Reuses
     `DistributionSpec`, `RouteType`, `MatrixType`, `DrugComponent` from
     existing `src/types/`.
   - `capabilities.ts` — capability lists for Lite and Full engines.
   - `liteBrowserEngine.ts` — class implementing `ComputeEngine`. `simulate()`
     adapts the existing `useMonteCarloWorker`. Other methods return a
     not-yet-implemented diagnostic that surfaces the missing capability rather
     than throwing — keeps the UI layer simple.
   - `fullRemoteEngine.ts` — class that POSTs to `/api/jobs/start` and polls
     `/api/jobs/status`/`/api/jobs/result`. All methods short-circuit with
     `FULL_COMPUTE_DISABLED` until the backend env vars are wired.
   - `engineSelector.ts` — `getComputeEngine()` reads
     `import.meta.env.VITE_KINELAB_COMPUTE_MODE` (default `lite`).
   - `modelCards.ts` — initial six model cards (ethanol, GHB, ketamine,
     diazepam, amphetamine, morphine) keyed by drug slug. Each card carries
     `modelType`, `supportedMatrices`, `defaultPriors`, `assumptions`,
     `limitations`, `validationStatus: 'toy' | 'literature-derived'` for the
     first cut.
   - `index.ts` — barrel export.
2. `api/jobs/start.ts`, `api/jobs/status.ts`, `api/jobs/result.ts` — all
   reject with `501 FULL_COMPUTE_DISABLED` until enabled. Schemas added to
   `api/_lib/schemas.ts`. Uses `withErrorHandling`, `json`, `error` per
   `api/AGENTS.md`.
3. `api/_lib/full-compute.ts` — tiny helper: `isFullComputeEnabled()`,
   `fullComputeApiUrl()`, `respondFullComputeDisabled(res)`.
4. `.env.example` — three new variables documented.
5. `AGENTS.md` — pointer to `src/lib/compute/`.
6. Tests — `src/lib/compute/__tests__/engineSelector.test.ts`,
   `src/lib/compute/__tests__/types.test.ts`,
   `src/lib/compute/__tests__/liteBrowserEngine.test.ts`.
7. No new UI routes, no new pages, no `/kinelab` link in the header. No drugs
   or migrations are added. Lite is the default mode and the existing
   `/simulator` continues to work unchanged because none of its imports were
   touched.

What does **not** land in Phase 0:

- A `/kinelab` route or a forensic case-builder UI — separate PR.
- The inverse-inference math (`infer()`). The interface and result-shape are
  defined; the algorithm is a follow-up so reviewers can argue with the
  weighting/grid choices on their own merits.
- Schema migrations for new columns. The first KineLab UI will read/write
  `simulator_cases.case_data` JSONB with `kind: 'kinelab-case'` discriminator.
  We add a Drizzle migration only if/when UI requirements demand a dedicated
  column or table.

### Phase 1 — Inverse inference + first vertical slice

Phase 1 is being delivered in two PRs.

**Phase 1a (this PR — `LiteBrowserEngine.infer()` math).** Status: in flight.

- `src/lib/compute/inference.ts` — pure-function importance-sampling inference
  (`runInference`, `summarizePosterior`, `posteriorPredictive`).
  Lognormal observation model `log(y) ~ N(log(ŷ), √log(1+CV²))`.
  Same resample-once-then-skip validity guard as `simulate()`.
- `LiteBrowserEngine.infer()` wires the helpers and emits the existing
  `InferenceResult` schema. Diagnostics report effective sample size and
  warn when the ESS ratio drops below 5 %.
- `inferenceInputSchema` extended with required `route` and `priors`
  (dose / halfLife / vd / [f]) and an optional `defaultAssayCV`. The intake
  offset prior is auto-derived from `scenario.possibleIntakeWindow` (uniform
  over `[0, latest − earliest]`) so callers don't have to encode it twice.
- `posteriorPredictive` covers `[0, max(window end, last sample) + 6 h]` at
  60 steps. Concentrations carried in mg/L; molar units are rejected with a
  helpful error until MW plumbing lands.
- Method advertised in diagnostics as `'monte-carlo-importance-sampling'`.
  The `'grid-inference'` capability stays advertised — phase 2 may replace
  the inner MC over (dose, intakeOffset) with a true grid for tighter
  marginal estimates.

**Phase 1b (this PR — UI + persistence + i18n + worker).** Status: in flight.

- New `/kinelab` route (lazy-loaded) at `src/pages/KinelabPage.tsx`. First
  vertical slice is hardcoded to **ketamine** so the engine's first-order
  PK matches the analyte's `one_comp_first_order_absorption` model card.
  Ethanol (zero-order) and morphine (parent/metabolite) follow once the
  engine grows the matching model types.
- Form layout: case name, observation (concentration mg/L, sample time,
  assay CV), intake window (earliest/latest), priors (uniform dose range,
  fixed half-life / Vd / F), draw count.
- Output panels: posterior predictive envelope (lightweight inline SVG, no
  Plotly), posterior parameter intervals, assumptions list, limitations
  list (severity-coloured), diagnostics line with sample count + ESS.
- New worker `src/workers/inference.worker.ts` + Comlink hook
  `useInferenceWorker`. Inference runs off the main thread so the page
  stays responsive at default 4000 draws.
- Persistence reuses `simulator_cases.case_data` JSONB with
  `kind: 'kinelab-case'` and `schemaVersion: 1`, validated through
  `kinelabCaseDataSchema`. Helpers in `src/lib/kinelabCases.ts` filter
  the existing list endpoint to KineLab-tagged rows.
- Header nav link + bilingual `kinelab.*` strings in `src/locales/{en,nb}.json`.
- 14 new tests (schema validation, persistence helpers).

What does **not** land in this PR:

- Other analytes (ethanol/GHB/diazepam/amphetamine/morphine).
- Pulling priors from the live `drugs` row instead of from the form.
- Plotly-grade charts; the SVG envelope is intentionally minimal.
- Multi-matrix conversion (`reference_concentrations` ratios).
- Report generation (`generateReport()` is still a phase-2 stub).

### Phase 2 — Reports, scenario comparison, broader analyte coverage

Phase 2 is being split similarly to phase 1.

**Phase 2a (this PR — `compareScenarios()` + `generateReport()` math).**
Status: in flight.

- `LiteBrowserEngine.compareScenarios()` runs each scenario through the
  shared `infer()` path and aggregates per-scenario warnings (prefixed
  with the scenario label) so the existing matrix policy + likelihood
  validation are reused as-is.
- `LiteBrowserEngine.generateReport()` returns a plain-markdown body
  built by `src/lib/compute/report.ts`. The Lite limitation statement
  from the spec is included verbatim.
- `reportInputSchema` extended (additively) with optional
  `inferenceInput` and `scenarioComparison` so the report can render
  observation tables, priors, and side-by-side scenarios when the
  caller has them.
- Inference worker grew a `runScenarioComparison` method + matching
  `useInferenceWorker.runScenarioComparison` so 2b can offload work
  the same way `runInference` already does.
- 7 new vitest tests cover scenario tightness ordering, per-scenario
  warning labelling, schema rejection of single-scenario input, full
  report section coverage, the no-input fallback, scenario-comparison
  rendering inside reports, and diagnostics preservation.

**Phase 2b (this PR — report preview / download).** Status: in flight.

- New "Generate report" button on `/kinelab` that calls
  `LiteBrowserEngine.generateReport` with localized labels, renders
  the markdown body in a collapsible preview pane, and exposes a
  `.md` download via a `Blob` + `<a download>`.
- New `src/lib/compute/reportLabels.ts` helper: `buildReportLabelsFromT`
  resolves every key under `kinelab.report.*` from the active i18next
  translator, returning the flat `ReportLabels` shape the
  `renderReportMarkdown` function consumes. Keeps the page's React
  context out of the engine layer.
- New `kinelab.actions.{generateReport,generatingReport,downloadReport,
togglePreview,showPreview}` and `kinelab.reportPanel.*` entries in
  both `src/locales/en.json` and `src/locales/nb.json`. The locale
  parity test catches future drift.
- 3 new vitest tests cover the helper: resolves every key under the
  right namespace, the helper's key list exactly covers the
  `ReportLabels` shape, and successive calls return distinct objects
  so the page can `useMemo` them.

What is **not** in this PR (deferred to phase 2c+):

- A scenario-comparison panel that uses `runScenarioComparison` from
  the worker and renders the `ScenarioComparisonResult`.
- Other analytes (ethanol/zero-order, morphine/parent-metabolite, GHB)
  once the engine grows the matching model types.
- Pulling priors from the live `drugs` table instead of the form.
- Multi-matrix conversion factors with their own uncertainty (replaces
  the current "fail fast" policy).

**Phase 2c (this PR — scenario-comparison UI).** Status: in flight.

- New `ScenarioCompareCard` on `/kinelab` below the report preview.
  Scenario A is the snapshotted `lastRunInput`; the user adds N
  variants which inherit scenario A and apply only "what changed"
  (priors and assay CV). Observations, intake window, route, and
  analyte stay shared so the comparison answers "given THE SAME
  observed data, how do posteriors move under different prior
  assumptions?"
- Pure helper `mergeVariantIntoBaseline(baseline, overrides)` lives
  in `src/lib/compute/variantMerge.ts`. Empty fields inherit; the
  helper coerces strings, ignores degenerate uniform ranges
  (high ≤ low), rejects non-finite or non-positive overrides, and
  rewrites both `defaultAssayCV` and per-observation `uncertaintyCV`
  when the assay-CV override is supplied.
- The card calls `useInferenceWorker.runScenarioComparison` so the
  inference still runs off-thread. Results render as a posterior
  intervals table (median + 90 % CI + ESS per scenario) plus one
  predictive chart per scenario, each anchored to the same
  predictive range as scenario A.
- New `kinelab.compare.*` namespace in both `src/locales/{en,nb}.json`,
  guarded by the existing locale parity test (extended to require
  the new sub-namespace).
- 9 new vitest tests cover `mergeVariantIntoBaseline`: blank
  overrides preserve baseline, dose range overrides, single-bound
  fall-back, degenerate range ignored, fixed-prior overrides,
  non-finite/non-positive ignored, assay CV writes both layers,
  blank assay CV preserves observations identity, and shared fields
  remain intact.

What is **not** in this PR (deferred further):

- Other analytes (ethanol/zero-order, morphine/parent-metabolite, GHB).
- Pulling priors from the live `drugs` table.
- Multi-matrix conversion factors with their own uncertainty.
- Including the comparison in the generated report (the engine
  already supports `scenarioComparison` on `ReportInput`; wiring it
  through the page UI is a follow-up so a single PR doesn't grow
  unwieldy).

**Phase 2d (this PR — drug-DB-derived priors).** Status: in flight.

- New analyte picker on `/kinelab` exposing the three engine-supported
  analytes (`one_comp_first_order_absorption` model type): ketamine,
  diazepam, amphetamine. GHB / ethanol / morphine require new
  equations in `inference.ts` and stay deferred.
- New `src/lib/compute/drugPriors.ts` pure helper:
  `buildPriorsFromDrug(drug, isIv)` returns an `InferencePriors`
  (minus dose, which is the page's domain) plus a `PriorSummary` for
  the read-only panel. Builds on the existing
  `rangeToDistribution(...)` helper in `src/lib/rangeUtils.ts` so
  fixed / uniform / triangular cases all map naturally. Falls back
  to engine-side defaults (4 h half-life, 100 L Vd, F 0.5) when a
  drug row is missing fields, tagging the source so the panel can
  flag it.
- New `summarizePriors(priors, isIv)` companion: synthesizes a
  `PriorSummary` from an already-built `InferencePriors`. Used on
  saved-case load so the panel renders the saved snapshot without
  re-fetching the drug row.
- New `fetchDrugBySlug(slug)` client in `src/lib/drugApi.ts`. The
  API handler at `api/drugs.ts` already accepts `?slug=`.
- `KinelabPage.tsx` refactor:
  - `selectedAnalyte` state with a `<select>` of the three supported
    slugs; saved-case load round-trips through `caseData.input.analyte`.
  - On analyte change, `useEffect` fetches the drug row, builds priors,
    clears stale form overrides, clears the previous result, and bumps
    `baselineEpoch` so the scenario-comparison card resets.
  - A `suppressAnalyteFetchRef` ref lets `handleLoad` set the analyte
    without triggering the fetch effect, preserving the saved priors
    snapshot.
  - The half-life / Vd / F text inputs become per-baseline OVERRIDES;
    blank means "use drugs DB". `buildInferenceInput` validates
    overrides and falls through to `analytePriors.priors` when blank.
  - New `DrugPriorsPanel` subcomponent (in the same file, ~150 lines):
    read-only summary of the loaded priors with `drug-db` /
    `fallback` tags; an Edit toggle reveals the override fields and a
    "Reset to drugs DB" button that clears them.
- New `kinelab.priorsPanel.*` and `kinelab.form.analyte` /
  `analyteOption_*` strings in `src/locales/{en,nb}.json`. The locale
  parity test now covers the new sub-namespace.
- 10 new vitest tests in `drugPriors.test.ts` covering: supported-slug
  set, uniform/triangular/fallback shapes, IV route F behaviour, Zod
  round-trip through `inferenceInputSchema`, plus the
  `summarizePriors` IV branch.

**Phase 2e (this PR — scenario comparison in the generated report).**
Status: in flight.

- `src/lib/compute/scenarioComparisonResult.ts` (new): pure converter
  `workerOutputToScenarioComparisonResult(workerOutput, baseline)`
  that maps `WorkerScenarioComparisonOutput` to a
  `ScenarioComparisonResult` matching what
  `LiteBrowserEngine.compareScenarios()` itself produces. The engine
  layer doesn't import worker-thread types — the converter accepts a
  structurally typed `WorkerScenarioComparisonOutputLike`.
- `ScenarioCompareCard.tsx`: new optional `onResultChange` prop. The
  card still owns its UI state; the page lifts only the latest
  worker output for report generation.
- `KinelabPage.tsx`: holds `comparisonOutput`. Cleared alongside the
  other baseline-tied state on every event that bumps
  `baselineEpoch` (analyte change, fetch failure, primary run, case
  load) so the report flow can never splice in a comparison
  computed against a previous baseline.
- `handleGenerateReport` now passes `scenarioComparison` to
  `engine.generateReport(...)` whenever a comparison exists. The
  engine's existing comparison rendering (already covered by
  `scenarioComparisonAndReport.test.ts`) does the rest.
- 4 new tests in `scenarioComparisonResult.test.ts` covering: Zod
  round-trip through `scenarioComparisonResultSchema`, sample-count
  aggregation matching `compareScenarios()`, propagation of baseline
  metadata to every scenario, and an end-to-end check that the
  comparison block appears in the rendered markdown.
- No locale changes. The existing `kinelab.report.scenario*` keys
  (already shipped in Phase 2a) are reused — they were unused on the
  page side until this phase wired them up via the engine.

**Phase 2f-1 (PR 269 — zero-order ethanol math; engine layer only).**
Status: shipped.

- Foundation for ethanol support without touching the page UI. Ethanol
  is intentionally NOT yet added to `KINELAB_SUPPORTED_ANALYTE_SLUGS`;
  the picker still shows ketamine / diazepam / amphetamine. Phase
  2f-2 will follow up by making the form / panel / scenario card
  parameter-shape-aware and exposing ethanol on the picker.
- `inferencePriorsSchema`: makes `halfLife` and `f` optional, adds
  optional `eliminationRate` (mg/L per hour). Existing first-order
  callers are unchanged.
- `pkEquations.ts`: new `concentrationZeroOrder(dose, vd, beta, t)`
  implementing the Widmark-style linear curve with clipping at zero
  — same math used by the existing `/simulator/ethanol` forward engine.
- `inference.ts`: priors-shape dispatch via a new
  `deriveModelType(input)`. Presence of `eliminationRate` selects the
  zero-order path; everything else stays first-order. The four
  per-draw functions (`drawValidDraw`, `logLikelihood`,
  `summarizePosterior`, `posteriorPredictive`) all branch on the
  `modelType` carried on `InferenceComputation`. The first-order code
  path is byte-identical to before the dispatch was added.
- `summarizePosterior` emits `eliminationRate` (mg/L/h) for zero-order
  posteriors instead of `halfLife/f`. Posterior intervals are open-
  keyed in the schema so no schema change was needed.
- `drugPriors.ts`: `buildPriorsFromDrug(drug, isIv, modelType)` gains
  a third parameter (default `'first_order'`, so all existing
  callers compile without changes). The `'zero_order'` branch
  produces a uniform(100, 200) mg/L/h elimination-rate prior
  (literature default — the canonical Widmark range), reuses the
  drug row's Vd when present (else uniform(35, 70) L for a typical
  adult), and omits halfLife/f. `PriorSummary` gains an optional
  `eliminationRate` row so the phase 2f-2 panel can render it
  without a second shape change.
- `variantMerge.ts`: zero-order baselines pass `eliminationRate`
  through scenario comparisons unchanged. UI overrides land in
  phase 2f-2.
- 11 new tests:
  - `pkEquations.test.ts`: 4 tests covering the zero-order curve at
    t=0, linear decay, clip-at-zero, and pre-intake t < 0.
  - `inferenceZeroOrder.test.ts`: 3 tests proving end-to-end dose
    recovery from synthetic ethanol data (70 g, Vd 50 L,
    β = 150 mg/L/h, sample at 4 h), confirming the posterior emits
    `eliminationRate` and not `halfLife/f`, and asserting the
    predictive curve decreases monotonically.
  - `drugPriors.test.ts`: 4 ethanol-specific tests covering literature
    defaults, drug-row Vd preference, panel summary shape, and
    schema round-trip through `inferenceInputSchema`.
- 399→410 tests pass; first-order recovery + scenario-comparison
  tests untouched. tsc clean. KineLab page bundle unchanged (the
  PR doesn't touch UI).

**Modeling-page unification (through issue 508).** Status: shipped. The active modeling UX is one `/modeling` workspace; engine selection lives on each component, not in a global mode switcher.

- `/modeling` lazy-loads `SimulatorPage`, which dispatches each component through `src/lib/modelingRun.ts` (`pk-montecarlo`, `ethanol-widmark`, or `kinelab-bayes`).
- Legacy routes (`/simulator`, `/simulator/ethanol`, `/kinelab`) still redirect through `src/components/modeling/ModeRedirect.tsx`; `src/lib/modelingMigration.ts` consumes legacy `?mode=` and ethanol `#scenario=` payloads and creates unified components.
- Standalone `KinelabPage`, `EthanolSimulatorPage`, `kinelabStore`, and `ethanolSimulatorStore` have been retired. KineLab saved-case JSONB rows remain valid and are bridged into a `kinelab-bayes` component when loaded through `simulatorStore.loadCase`.
- Ethanol workbook back-calc/forward panels are now optional tools attached to an ethanol component in `DrugPanel`, alongside the Widmark component parameters.

**Phase 2f-2 (PR 346 — ethanol UI in KineLab).** Status: shipped.

- Originally surfaced the zero-order engine path from 2f-1 in the KineLab mode of `/modeling`. As of issue 508, forward Widmark and KineLab inverse inference are both component engines inside the unified simulator.
- `KINELAB_SUPPORTED_ANALYTE_SLUGS` gains `'ethanol'` (matches the slug that `seed-drugs.ts` writes for the row, since the seeder slugifies `nameEn || name` and the seeded ethanol row has `nameEn: 'Ethanol'`). New
  `analyteModelType(slug)` is the single source of truth that maps
  the picker selection to a `DrugPriorModelType` (`'zero_order'` for
  `etanol`, `'first_order'` otherwise). The priors-fetch effect, the
  inference-input builder, and the priors panel all dispatch on it.
- The retired `kinelabStore.ts` form carried `eliminationRateMgPerLPerHour`; saved KineLab case payloads now migrate into `DrugSimConfig.kinelab` via `src/lib/modelingMigration.ts`.
- KineLab form: when the analyte is zero-order, the priors panel
  renders an "Elimination rate" row instead of "Half-life" + "F";
  edit mode shows the elimination-rate / Vd inputs instead of
  half-life / Vd / F. The Vd input stays for both flavours.
- `summarizePriors`: dispatches on priors shape so a saved
  zero-order case loaded from JSONB renders the elimination-rate
  row (rather than the placeholder "0 h" half-life row that the
  pre-2f-2 first-order-only summarizer would have produced).
- `variantMerge.ts`: `VariantPriorOverrides` gains
  `eliminationRateMgPerLPerHour`. `mergeVariantIntoBaseline` applies
  it only when the baseline carries `priors.eliminationRate`, so
  first-order baselines are unaffected.
- `ScenarioCompareCard.tsx`: variant inputs swap half-life + F for a
  single elimination-rate field when the baseline is zero-order. Same
  card, baseline-shape-driven so variants always overlay the right
  parameter.
- Locales: new keys `kinelab.form.analyteOption_etanol`,
  `kinelab.form.eliminationRate`,
  `kinelab.priorsPanel.eliminationRate`,
  `kinelab.compare.eliminationRate`,
  `kinelab.parameters.eliminationRate`,
  `kinelab.errors.invalidEliminationRate` in both en + nb. Locale
  parity test stays green at 149 keys per locale.
- No schema bump on `kinelab-case` JSONB. The `inferencePriorsSchema`
  has accepted `eliminationRate` since 2f-1, so a zero-order case
  saves and round-trips at `schemaVersion: 1` symmetric with
  first-order cases.

**Phase 2g (this PR — subject panel + Vd correctness).** Status: in
flight.

- Adds a per-case Subject panel (body weight kg, biological sex,
  age years) to the KineLab form, persisted with the saved case
  via `inferenceInputSchema.subject` (which already existed; no
  case-data schema bump). Subject info is form-state (not analyte-
  scoped), so switching analyte preserves it; logout clears it.
- `buildPriorsFromDrug` accepts an optional `SubjectInfoForPriors`.
  Two correctness fixes on the Vd derivation depend on it:
  - Zero-order (ethanol) — when subject weight is supplied, Vd is
    computed via Widmark `r·weight` (sex-aware: r ≈ 0.68 male, 0.55
    female, sex-unknown spans both as a uniform). The drug-row Vd
    in litres still serves as a lower-priority fallback; the 35–70 L
    typical-adult uniform remains for cases where neither subject
    info nor a litre row is available.
  - First-order (ketamine, diazepam, amphetamine) — when the
    drug-row Vd carries `unit: 'L/kg'` AND subject weight is
    supplied, the range is multiplied by weight before being
    passed through `rangeToDistribution`. This is a real
    correctness fix: pre-2g the engine was silently treating the
    per-kilogram numbers as litres for these analytes too, so dose
    posteriors were off by a body-weight factor (smaller magnitude
    than the ethanol bug Codex caught in PR 346 round 1, but the
    same shape). Without subject weight the engine preserves the
    pre-2g approximation and tags the row `fallback` so the
    operator sees the synthesis warning.
- Updates the ethanol model card's `widmark-distribution`
  assumption to describe the new computation surface (drops the
  pre-2g "deferred to subject panel" caveat). Both the en + nb
  i18n keys are revised in lock-step. Locale parity stays green
  (164 keys/locale).
- Tests: drugPriors gets six new cases covering Widmark r·weight
  for male / female / sex-unknown, the Widmark-vs-row precedence,
  weight-without-sex routing, first-order L/kg scaling, and the
  pre-2g fallback path when no weight is supplied. Current bridge coverage lives in `src/lib/modelingMigration.test.ts`.

### Phase 3 — Full Mode

When the Python KineLab backend (the separate `hagelien/KineLab` repo) is
deployed and reachable:

1. Set `KINELAB_FULL_COMPUTE_ENABLED=true` and
   `KINELAB_FULL_COMPUTE_API_URL=https://…` in the deployment.
2. `FullRemoteEngine` is already wired to forward the same `InferenceInput`
   payload and validate the same `InferenceResult` shape.
3. UI starts advertising `ode-solver`, `hmc-nuts`, `hierarchical-pop-pk`,
   `postmortem-model`, `model-averaging` capabilities (read from the engine's
   `getCapabilities()`).

## Domain mapping (KineLab → Kinetix)

| KineLab spec name                    | Kinetix equivalent                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Case`                               | `simulator_cases` row, `case_data.kind === 'kinelab-case'`                                                                                                                          |
| `Sample`, `Observation`              | embedded inside `case_data.observations[]`; same shape as the spec, but `analyte` is a drug slug or PubChem CID rather than a free string                                           |
| `Analyte`                            | `drugs` row (look up via `slug` or `pubchem_cid`)                                                                                                                                   |
| `Matrix`                             | `MatrixType` enum aligned with `reference_concentrations.matrix` values                                                                                                             |
| `Assay`                              | already in `Observation.assay`; add `loq`/`lod`/`uncertaintyCV` to `case_data`                                                                                                      |
| `PKModelCard`                        | new in-code registry under `src/lib/compute/modelCards.ts` keyed by drug slug. PK parameter ranges are pulled from the live `drugs` row (so wiki edits flow through automatically). |
| `SimulationInput`/`SimulationResult` | new Zod schemas in `src/lib/compute/types.ts`, but `SimulationInput` reuses `DrugSimConfig` shape where possible and `SimulationResult.timeSeries` reuses `UncertaintyPoint[]`      |
| `InferenceInput`/`InferenceResult`   | new in `types.ts`, no overlap with existing simulator                                                                                                                               |
| `ScenarioComparisonInput`/`Result`   | new; downstream consumer is the existing `/diff/etoh` page extended for arbitrary analytes                                                                                          |
| `ReportInput`/`Result`               | new; downstream consumer is a new export panel reusing `simulatorExport.ts` patterns                                                                                                |
| `DiagnosticSummary`                  | new; aligns with existing `SimulationWarning` but adds `engine`, `method`, `sampleCount`                                                                                            |
| `Assumption`/`Limitation`            | new typed records that reference `citations` rows by id (so the existing reference flow doubles as KineLab citations)                                                               |

## Compute interface (final shape)

```ts
// src/lib/compute/types.ts (excerpt)

export type ComputeCapability =
  | 'analytic-pk'
  | 'grid-inference'
  | 'browser-monte-carlo'
  | 'basic-scenario-comparison'
  | 'ode-solver'
  | 'hmc-nuts'
  | 'hierarchical-pop-pk'
  | 'postmortem-model'
  | 'model-averaging';

export interface ComputeEngine {
  readonly id: 'lite-browser' | 'full-remote';
  simulate(input: SimulationInput): Promise<SimulationResult>;
  infer(input: InferenceInput): Promise<InferenceResult>;
  compareScenarios(
    input: ScenarioComparisonInput,
  ): Promise<ScenarioComparisonResult>;
  generateReport(input: ReportInput): Promise<ReportResult>;
  getCapabilities(): ComputeCapability[];
}
```

`SimulationResult.diagnostics.engine` echoes the `id` so reports can render
"computed by lite-browser" without the UI knowing which engine was selected.

## Env variables

```env
# Public (browser) — selects the active compute engine.
# Allowed: "lite" (default) | "full".
VITE_KINELAB_COMPUTE_MODE=lite

# Private (server) — guards api/jobs/*. Must be "true" for full-mode requests
# to be forwarded to the external backend.
KINELAB_FULL_COMPUTE_ENABLED=false

# Private (server) — base URL of the external Python KineLab backend.
# Required when KINELAB_FULL_COMPUTE_ENABLED=true.
KINELAB_FULL_COMPUTE_API_URL=
```

If the browser is on `full` but the server is unconfigured the UI shows:

> Full compute backend is not configured in this deployment.

## Capabilities by engine

```ts
// src/lib/compute/capabilities.ts

export const LITE_CAPABILITIES: ComputeCapability[] = [
  'analytic-pk',
  'grid-inference',
  'browser-monte-carlo',
  'basic-scenario-comparison',
];

export const FULL_CAPABILITIES: ComputeCapability[] = [
  ...LITE_CAPABILITIES,
  'ode-solver',
  'hmc-nuts',
  'hierarchical-pop-pk',
  'postmortem-model',
  'model-averaging',
];
```

UI components should call `engine.getCapabilities()` and hide methods that
aren't supported, never branch on the `id` directly.

## Unified simulator integration

Issue 507 adds KineLab Lite inference as a per-component simulator engine:
`DrugSimConfig.engine === 'kinelab-bayes'`. The unified event model remains
backward-compatible:

- `DoseEvent.amountRange` carries the dose prior in the dose event's unit.
- `DoseEvent.tRange` carries the possible intake window in simulator hours.
- `MeasurementEvent.assayCV` can override the component-level assay CV for one
  observation.
- `DrugSimConfig.kinelab` stores inference settings such as assay CV, draw
  count, optional subject data, and an optional prior snapshot for reproducible
  saved cases.

`buildInferenceInput()` in `src/lib/modelingRun.ts` maps those fields to the
existing `InferenceInput` shape, and `runComponent()` dispatches the component
through the inference worker. The resulting `DrugSimResult` keeps the posterior
summary under `result.kinelab` while the posterior predictive curve is rendered
through the shared simulator chart.

## API routes

Three flat handlers under `api/jobs/`, matching kinetix conventions:

| Route                | Method           | Purpose                 | Disabled response             |
| -------------------- | ---------------- | ----------------------- | ----------------------------- |
| `api/jobs/start.ts`  | POST             | Enqueue a Full-mode job | `501` `FULL_COMPUTE_DISABLED` |
| `api/jobs/status.ts` | GET (`?jobId=…`) | Poll job status         | same                          |
| `api/jobs/result.ts` | GET (`?jobId=…`) | Fetch the final result  | same                          |

All three:

- wrap with `withErrorHandling`
- read `KINELAB_FULL_COMPUTE_ENABLED` and `KINELAB_FULL_COMPUTE_API_URL`
- proxy to the external backend only when both are set; otherwise return a
  stable JSON error body the SPA can render through i18n keys

## Storage

Phase 0–1: cases live inside `simulator_cases.case_data` JSONB with a
discriminator. No DB migrations.

```ts
// example case_data shape
{
  kind: 'kinelab-case',
  schemaVersion: 1,
  observations: [...],
  scenario: {...},
  results: {...}, // last computed InferenceResult, optional
}
```

Phase 2+: if the volume of KineLab cases or the search/filter requirements
warrant it, we add either an `analysis_kind` column or a separate
`kinelab_cases` table. We do not add either preemptively.

## Acceptance criteria for this Phase 0 PR

1. `npm run typecheck` passes.
2. `npm run test` passes (existing tests untouched + new tests for the compute
   layer).
3. `npm run build` succeeds.
4. `getComputeEngine()` returns a `LiteBrowserEngine` by default and a
   `FullRemoteEngine` when `VITE_KINELAB_COMPUTE_MODE=full`.
5. `LiteBrowserEngine.getCapabilities()` returns exactly `LITE_CAPABILITIES`.
6. `LiteBrowserEngine.simulate()` returns a `SimulationResult` whose
   `diagnostics.engine === 'lite-browser'` for an end-to-end ethanol example.
7. `FullRemoteEngine.simulate/infer/...` reject with `FULL_COMPUTE_DISABLED`
   when the env vars are not set.
8. `POST /api/jobs/start` returns `501` + the `FULL_COMPUTE_DISABLED` body
   when `KINELAB_FULL_COMPUTE_ENABLED !== 'true'`.
9. Existing `/simulator` page is unaffected — none of its imports change.
10. No new user-facing strings, so no i18n updates required.

## Non-goals (unchanged from spec)

- External Python compute, Chi/Myokit execution, HMC/NUTS, full popPK, real
  forensic certification, postmortem-redistribution claims, sensitive case
  storage.
