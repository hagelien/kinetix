# KineLab modeling feedback (2026-07-07) — evaluation & implementation plan

**Status:** proposal for review · **Date:** 2026-07-07
**Source feedback:** [`docs/feedback/modeling-07-07-26.md`](../feedback/modeling-07-07-26.md)
**Related:** [`docs/plans/modelling-trust-release.md`](./modelling-trust-release.md) ·
[`docs/kinelab-integration.md`](../kinelab-integration.md)

This is the second review round on the KineLab inverse-inference work. The first
round (`modelling.md` → the trust-release plan) has largely shipped (Phases 1–5,
PRs 816–issue 862). This round is sharper and more surgical: it audits the seams that
appeared *after* KineLab was integrated into the `/modeling` workspace. This doc
verifies each claim against the current code, judges what is worth building, and
lays out a phased plan.

---

## 1. Verdict on the feedback

**High quality and accurate.** Every load-bearing claim checks out against the
code (table below). It is honest about scope — it repeatedly frames KineLab as
"scenario exploration, not a forensic conclusion," which matches the model
cards' own disclaimer.

**The unifying insight the feedback circles but doesn't name:** almost every
issue is a *seam between two code paths* — the fully-guarded
`LiteBrowserEngine.infer()` and the thinner integrated worker path
(`inference.worker.ts` → `runInference`) that the `/modeling` UI actually runs.
`infer()` validates schema, looks up the model card, and enforces matrix policy;
the worker path does none of that. Once you see that, three separate findings
(worker bypasses validation, ESS thresholds diverge, matrix only warns) collapse
into one root cause, and the top recommendation (unify the boundary) becomes the
keystone that resolves them together.

### 1.1 Claims verified against code

| # | Claim | Verdict | Evidence |
| - | ----- | ------- | -------- |
| K1 | Integrated `/modeling` flow does **not** apply `LiteBrowserEngine.infer()`'s validation; the worker calls raw `runInference()` | **TRUE** | `runComponentEngine` → `deps.runInference` (`src/lib/modelingRun.ts:804-811`) → `runOne()` (`src/workers/inference.worker.ts:55-81`) calls `runInference` directly. No `infer()`, no `inferenceInputSchema.parse`, no card lookup, no matrix gate |
| K2 | `infer()` rejects unsupported matrices / multi-matrix; the worker/adapter only **warns** | **TRUE** | gate: `liteBrowserEngine.ts:172-185` (throws on >1 matrix and on `!card.supportedMatrices.includes`). Adapter: `modelingRun.ts:656-664` pushes a `matrixNoConversion` warning but never blocks and never checks `supportedMatrices` |
| K3 | Morphine model card slug won't match; `parent_metabolite_simple` isn't implemented | **TRUE** | card is `analyteSlug:'morfin'`, `modelType:'parent_metabolite_simple'` (`modelCards.ts:154-156`); `analyteId` derives `'morphine'` from `names.en` (`modelingRun.ts:364-369`; `data/components.ts:781-782`). Engine dispatch only knows `first_order`/`zero_order` (`inference.ts:64-76`) — a matched card would silently run as generic first-order |
| K4 | Oral PK is instantaneous; the Bateman fn exists but inference doesn't use it | **TRUE** | inference uses `concentrationFromDoseOral` (`inference.ts:265-269, 499-505`); `concentrationOralFirstOrder` (Bateman) exists (`pkEquations.ts:84`) and is wired into the **forward** MC path only (issue 858), never the inference likelihood |
| K5 | Adapter uses only the **first** dose event | **TRUE** | `config.events.find(dose)` (`modelingRun.ts:453-456`); `superposeDoses` exists (`pkEquations.ts:144`) and feeds the forward path (issue 852) but not inference |
| K6 | ESS thresholds diverge between engine and adapter | **TRUE** | engine warns at `essRatio < 0.05` (`liteBrowserEngine.ts:227`); adapter uses `LOW_ESS_RATIO = 0.1` / `CRITICAL_ESS_RATIO = 0.02` (`modelingRun.ts:579-580`). Because the UI never calls `infer()`, the 5% threshold is dead in the integrated path |
| K7 | Low ESS still yields a presented result | **TRUE** | `kinelabOutputToDrugSimResult` attaches a warning but returns the full median/interval regardless (`modelingRun.ts:641-711`) |
| K8 | Vd in `L/kg` without subject weight silently used as litres | **TRUE** | `resolveFirstOrderVd` fallback treats the per-kg number as litres, tagged `fallback` (`drugPriors.ts:342-349`) |
| K9 | Worker/inference errors surface only via `console.error`, not the UI | **TRUE** | `handleRunAll` catches and logs (`SimulatorPage.tsx:464-465`); `useInferenceWorker` throws a bare string (`useInferenceWorker.ts:31`). No structured error reaches the result panel |

### 1.2 Nuances / refinements to note before building

- **K2 — the exact gap is narrower than "matrix policy."** In the integrated
  flow every observation shares one `config.kinelab.matrix` (`modelingRun.ts:511`),
  so the *multi-matrix* branch of `infer()` is moot. The genuinely-bypassed check
  is the **`supportedMatrices` gate** (e.g. ketamine + `urine` is rejected by
  `infer()` but only warned in the UI) plus **schema validation**
  (`inferenceInputSchema.parse` never runs on the worker path).
- **K3 — morphine is a double bug, and a live one.** It carries first-order data
  (half-life 2–3 h, Vd **4 L/kg**, F 0.24 — `data/components.ts:785-787`), so it
  is *engine-runnable* via the data-driven `hasEngineData` even though it is not
  in `KINELAB_CURATED_ANALYTE_SLUGS`. Run it without a subject weight and K8
  fires: `4 L/kg` is used as `4 L` — ~70× below the true ~280 L. So morphine
  simultaneously (a) never matches its card, (b) would run as parent-only
  first-order if it did, and (c) is the worst-case instance of the Vd bug.
- **K4 / K5 are inference-path-only.** issue 858 (Bateman) and issue 852 (superposition)
  already landed on the forward Monte Carlo path. The remaining work is to extend
  that same, already-tested machinery to the inference likelihood + predictive —
  a narrower lift than "introduce absorption / repeat dosing."
- **i18n is a hard gate.** Per `AGENTS.md`, every new/changed user-facing string
  needs matching `en.json` + `nb.json`. Reusable keys already exist:
  `simulator.warnings.lowEss` / `matrixNoConversion` / `ethanolNotZeroOrder` /
  `nonethanolZeroOrder` (`src/locales/nb.json:1138-1141`).

---

## 2. What to build, what to defer

Ranked by value-to-effort. The two items the feedback flags as "serious
production risks" (K1/K2 worker bypass, K3 morphine) are both in "build now."

### Build now — the seam & the two production risks
- **Rec 1 — Unify the inference boundary.** Extract one shared
  `runLiteInference(input)` that does `parse → card lookup → matrix policy →
  family check → runInference → posterior → predictive → diagnostics`, and call
  it from **both** `LiteBrowserEngine.infer()` and `inference.worker.ts`. This is
  the keystone: it closes K1, K2, and K6 in one move and gives K3/K7 a single
  place to hook.
- **Rec 2 (partial) — Fix card lookup + morphine.** Change the card to
  `analyteSlug:'morphine'`; add a guard so a card whose `modelType` the engine
  can't honour (`parent_metabolite_simple`) either is hidden/marked non-runnable
  or runs with an explicit "approximated as parent-only first-order" warning —
  never silently.
- **Vd (K8) — make the L/kg-without-weight case honest.** Use an explicit
  default weight (e.g. 70 kg) with a visible assumption, or block, instead of the
  silent 70×-wrong fallback. Bundle with morphine — same code path
  (`resolveFirstOrderVd`).
- **Rec 3 (partial) — consistent matrix policy.** Enforce the same
  `supportedMatrices` gate everywhere via the unified boundary (throw, not warn),
  surfaced as a clean UI error (see below).
- **UI error surfacing (K9).** Turn swallowed `console.error`s into structured
  status cards: invalid matrix, empty posterior, worker failure, missing MW, low
  ESS. Required to make the new gates usable — otherwise a thrown gate reads as
  "nothing happened."
- **Rec 5 (partial) — statistical quality as a gate.** Harmonise the ESS
  thresholds (one source), surface attempted draws + accepted fraction + ESS
  ratio (all already computed — `WorkerInferenceOutput.diagnostics`), and
  escalate a low-ESS / empty posterior to a **blocking "not robust"** state
  instead of a median presented as normal.

### Build next — the deeper inference-path modeling
- **Rec 4 — Bateman absorption in inference.** Extend issue 858's `ka`/Tmax prior to
  the inference likelihood + predictive; when no `ka`/Tmax is available, keep the
  post-absorption approximation with a hard "not valid near Tmax" warning.
- **Rec 6 — multiple dose events in inference.** Superpose first-order
  single-dose curves (`superposeDoses` already exists) in the likelihood +
  predictive; ethanol multi-intake stays on its own zero-order/Widmark structure.

### Defer — needs data or is a larger model
- **Full parent/metabolite compartment model** (rest of Rec 2) — real modeling
  work, low near-term ROI. Near-term fix is slug + honest guard, not the model.
- **Matrix-to-matrix conversion with uncertainty** (rest of Rec 3) — needs
  curated blood/plasma ratios with uncertainty. Matrix-as-input already shipped
  (issue 855); the near-term move is the hard gate, not the conversion.
- **Posterior-mass-at-prior-boundary + Monte-Carlo standard error** (rest of
  Rec 5) — a worthwhile small follow-up after the cheap ESS/accepted-fraction
  gate lands.

### Tests (Rec 7) — accompany every phase, not a phase of their own
Worker-path matrix rejection **parity** with `infer()`; morphine card actually
matches; `parent_metabolite_simple` never runs as silent first-order; L/kg
without weight hard-stops or uses an explicit default; UI shows a visible error
when the worker throws. `npm run typecheck && npm run test && npm run build`
gate every PR.

---

## 3. Phased implementation plan

Each phase is independently shippable and PR-sized; every UI string ships
`en`+`nb`.

### Phase A — Unify the inference boundary *(keystone; closes K1, K2, K6)*
**Goal:** one validation path, whether called direct or via the worker.

1. Add `runLiteInference(input, opts)` (in `src/lib/compute/inference.ts` or a
   new `liteInference.ts`) that runs: `inferenceInputSchema.parse` → card lookup
   (`findModelCardById`/`ByAnalyte`) → matrix policy (multi-matrix +
   `supportedMatrices`) → model-family check → `runInference` →
   `summarizePosterior` → `posteriorPredictive` → diagnostics (including the
   harmonised ESS thresholds). Pure, worker-safe (imports only plain data).
2. `LiteBrowserEngine.infer()` becomes a thin wrapper over it (behaviour
   unchanged; its current inline logic moves into the shared fn).
3. `inference.worker.ts` `runOne()` calls the shared fn so the integrated path
   inherits every guard. Cross-matrix/unsupported-matrix cases now **throw**
   instead of running as-is.
*Files:* `inference.ts` (+ maybe `liteInference.ts`), `liteBrowserEngine.ts`,
`inference.worker.ts`, `modelingRun.ts` (map thrown errors → result), tests
asserting **parity** between the two entry points.

### Phase B — Model-card integrity & Vd honesty *(closes K3, K8)*
**Goal:** no card claims a capability the engine doesn't have; no Vd is 70× off.

1. Morphine card `analyteSlug:'morfin'` → `'morphine'`
   (`modelCards.ts:155`). Optionally add a stable `pubchemCid` to cards and match
   on CID as well as slug, to end the NB/EN slug drift for good.
2. Guard `modelType`: if a matched card's family isn't dispatchable
   (`parent_metabolite_simple`), either exclude it from the runnable set or emit
   an explicit "approximated as parent-only first-order" warning through the
   unified diagnostics — never silent.
3. `resolveFirstOrderVd` (`drugPriors.ts:321-355`): when Vd is `L/kg` and no
   weight is supplied, apply an **explicit default weight** (visible assumption,
   surfaced in the prior summary), or block — not the silent unscaled fallback.
*Files:* `modelCards.ts`, `inference.ts`/`liteInference.ts`, `drugPriors.ts`,
locales, tests (morphine matches; parent_metabolite guarded; L/kg-no-weight
behaviour pinned).

### Phase C — Statistical gate & visible errors *(closes K7, K9; Rec 5)*
**Goal:** weak or failed runs are unmistakable; nothing fails silently.

1. Single ESS-threshold source consumed by both entry points; report attempted
   draws, accepted fraction, and ESS ratio in the result/diagnostics.
2. Promote low-ESS / empty-posterior from warning to a **blocking "not robust"**
   result state — the answer card shows the block, not a normal median/CI.
3. Structured UI error states in `SimulatorPage`/results panel: invalid matrix,
   empty posterior, worker not initialised, missing MW for molar units, low ESS.
   Reuse existing warning keys; add new keys bilingually.
*Files:* `modelingRun.ts`, `SimulatorPage.tsx`, results/answer-card components,
`useInferenceWorker.ts`, locales, tests.

### Phase D — Bateman absorption in the inference path *(Rec 4)*
**Goal:** samples near Tmax stop being a large silent model error.
Add a `ka`/Tmax prior to `InferencePriors`; thread it through `drawValidDraw`,
`logLikelihood`, and `posteriorPredictive` using `concentrationOralFirstOrder`
when route ≠ IV and the prior exists; otherwise post-absorption mode with a hard
Tmax warning. Reuse issue 858's forward-path shape.
*Files:* `types.ts`, `inference.ts`, `drugPriors.ts` (Tmax→ka prior),
`modelCards.ts`, tests (dose recovery with absorption; Tmax-region warning).

### Phase E — Multiple dose events in inference *(Rec 6)*
**Goal:** repeated/compound intakes are modelled, not truncated to the first.
Superpose first-order single-dose curves (`superposeDoses`) in the likelihood +
predictive; extend `buildInferenceInput` beyond the single `events.find(dose)`.
Ethanol multi-intake keeps its zero-order/Widmark structure.
*Files:* `modelingRun.ts`, `inference.ts`, tests (two-dose recovery; single-dose
stays byte-identical).

---

## 4. Sequencing summary

```
Phase A  Unify the inference boundary      ← ship first (keystone: K1/K2/K6)
Phase B  Card integrity & Vd honesty       ← the morphine production risk (K3/K8)
Phase C  Statistical gate & visible errors ← make failure unmissable (K7/K9)
Phase D  Bateman absorption (inference)    ← deeper realism
Phase E  Multi-dose (inference)            ← deeper realism
```

A–C are the "trust" slice of this round (the two production risks + the safety
gate) and should ship together or back-to-back; D–E are model-realism follow-ups
that mirror work already done on the forward path. The single most valuable
deliverable is **Phase A**: one validated inference boundary removes the class of
bug where the engine and the UI disagree about whether a case is even runnable.
