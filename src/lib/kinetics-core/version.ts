/**
 * kinetics-core version.
 *
 * This is the portable, dependency-free pharmacokinetic engine that Kinetix
 * OWNS and Redose CONSUMES (vendored, pinned, offline). Kinetix is the single
 * source of truth for the reviewed scientific models; Redose derives its model
 * behaviour from an exact, versioned release of this package.
 *
 * Bump `CORE_VERSION` on any change to the equations, solver, or scenario/result
 * contract. The registry (drug parameters) has its own independent version and
 * checksum in `registry.ts`, so a parameter-only change does not force a core
 * version bump.
 *
 * Semantic meaning:
 *   MAJOR — breaking change to the CanonicalScenario / CanonicalResult contract.
 *   MINOR — new model family, route, or capability (backward compatible).
 *   PATCH — numerical / bug fix that does not change the contract shape.
 */
/**
 * 1.0.0 — the multi-family release. This is a MAJOR bump because the
 * `CanonicalResult` route-summary shape changed in a non-backward-compatible way:
 * `ResolvedRouteSummary.family` is now always present, and `kaPerHour` /
 * `bioavailability` are `number | null` (null for families without an absorption
 * phase / fixed F, e.g. IV). A consumer that keyed off `CORE_VERSION` and read
 * those as plain numbers must adapt, so the version reflects the break rather than
 * advertising it as a compatible minor upgrade. Redose pins the exact release and
 * re-vendors, so there is no silent-acceptance path.
 *
 * 1.1.0 — adds the `michaelis-menten` model family (saturable elimination;
 * ethanol / GHB) on the shared RK4 solver, plus the `widmark` Vd-scaling mode and
 * two ADDITIVE optional `ResolvedRouteSummary` fields (`vmaxMgPerLPerHour`,
 * `kmMgPerL`). Backward compatible — existing curves and result shapes are
 * unchanged — so a MINOR bump.
 *
 * 1.2.0 — adds the additive optional `DrugModelDefinition.aliases` (a model
 * resolvable under alternate analyte ids, e.g. psilocybin ⇢ psilocin), tightens
 * Michaelis–Menten validation (Km must be > 0), and replaces the ODE families'
 * fixed pre-window lookback with a dose-dependent cluster horizon (a large/typo
 * dose is retained and priced, never silently dropped to zero). Existing curves and
 * result shapes are unchanged — a MINOR bump.
 *
 * 1.2.1 — PATCH: the reported `peak` for the linear (closed-form) families is now
 * refined OFF the output grid. Previously Cmax was the maximum over the caller's
 * output grid samples alone, which understated the true peak of a fast-absorption
 * route (e.g. smoked cocaine, absorption t½ ~1 min) whenever its peak fell between
 * coarse samples — a materially LOW safety peak. The peak is now the maximum of
 * the exact central curve on a bounded fine internal sub-grid; the time series and
 * result shape are unchanged, and the peak is never lower than before (a strict,
 * safety-upward numerical correction). ODE families are unaffected (grid-scan peak
 * retained; a grid-independent ODE peak is a tracked follow-up). Consumers that
 * pin an exact release should re-vendor to pick up the corrected peak.
 *
 * 1.2.2 — PATCH: correct the peak-refinement eval-budget accounting AND keep the
 * between-dose superposition peak adequately resolved when the dose count
 * throttles refinement. Two coupled fixes:
 *   (a) The per-refined-dose analytic-peak probe and `scanWindow`'s inclusive
 *       endpoints (`pts + 1`, not `pts`) were not reserved when sizing the
 *       schedule, so the true `curveAt` count could exceed `MAX_PEAK_REFINE_EVALS`
 *       by ~50% for a very-many-dose scenario the grid compute budget never
 *       charged for. The schedule now reserves those samples.
 *   (b) The final grid-argmax bracket — the only scanner covering a superposition
 *       peak among UNREFINED doses — was tied to the per-dose `ptsPer`, so
 *       maximizing `refinedDoses` collapsed it to 2 points and could UNDER-report
 *       that peak. The bracket now gets a dedicated share, and refinement spends
 *       ONE representative per co-located cluster (ranked by cluster contribution)
 *       so distinct superposition peaks are each covered instead of one cluster
 *       consuming every slot.
 * Guarantee: the refined peak is always >= the output-grid peak it is seeded from
 * (a strict, safety-upward correction over the un-refined Cmax). When the dose
 * count exceeds what the eval budget can refine, `refinedDoses < totalDoses` is
 * reported so the caller surfaces the limitation. Regenerating the goldens shifts
 * a couple of multi-dose scenarios' peaks by a negligible sub-grid amount (~1e-10
 * relative, either direction — a different fine-scan sample, still ≥ the grid
 * peak); no contract change — a PATCH.
 *
 * 1.3.0 — MINOR: adds the `one-compartment-clv` model family and the structural
 * parameter-identity contract (SC-1A, plan §4.1/§5.3). A reviewed model can now be
 * parameterised by CLEARANCE and central VOLUME instead of a terminal half-life:
 * `ke = CL/Vc` and the half-life is DERIVED. Each structural parameter carries an
 * `identifiabilityBasis` (`iv-anchored` / `absolute-f-supported` /
 * `apparent-extravascular` / `derived`), so `CL` and `CL/F` (and `Vc`/`Vc/F`) are
 * distinct identities and an apparent extravascular parameter is never surfaced as
 * an absolute one. Additive: existing half-life-parameterised families, their
 * curves and result shapes are unchanged; the new `ResolvedRouteSummary.structural`
 * field is optional and present only for the new family. No shipped registry model
 * uses it yet (evidence-gated per the E-track), so the registry checksum is
 * unchanged — this release adds a CAPABILITY, not a curve change.
 *
 * 1.4.0 — MINOR: adds the declarative covariate-function contract (SC-2A, plan
 * §4.2/§5.4). A `one-compartment-clv` model can now declare `covariateFunctions`
 * (allometric / linear / categorical) that individualise `CL`/`Vc`/`ka` to a
 * subject covariate — model-declared only, so the core still applies no universal
 * disease/size multipliers. Factors are deterministic and applied AFTER the seeded
 * draw, so the PRNG parity stream is untouched; a declared covariate the subject
 * does not provide is an explicit insufficient-input failure; applied effects are
 * reported and the `clv-reference-subject` warning is suppressed once the
 * disposition is individualised. Additive — no existing family or shipped model
 * uses it, so the registry checksum and every existing curve are unchanged.
 *
 * 1.5.0 — MINOR: adds an absorption lag time `tlag` (SC-4A, plan §5.1/§S4) to the
 * first-order absorption families (`one-compartment-first-order` and
 * `one-compartment-clv`). A route may declare `absorptionLagHours`: absorption then
 * begins `tlag` hours after the dose (`C(t)=0` for `t<tlag`, the ordinary profile in
 * `t−tlag`), and the reported peak — including the off-grid refinement — is offset by
 * it. The lag is drawn ONLY when declared, so a model without one keeps the identical
 * PRNG stream, and the optional `ResolvedRouteSummary.absorptionLagHours` is emitted
 * only for a lagged route. Additive — no existing family or shipped model declares a
 * lag, so the registry checksum and every existing curve are unchanged.
 *
 * 1.6.0 — MINOR: adds the `parent-metabolite-first-order` model family and the
 * multi-analyte result contract (SC-3A, plan §5.2/§S3). A reviewed model can now
 * declare a coupled parent→metabolite disposition: one gut→parent→metabolite RK4
 * integration emits BOTH curves, with molar↔mass stoichiometry across the formation
 * step (`fm·(mwM/mwP)`). The metabolite is a first-class measured analyte, surfaced
 * through the new ADDITIVE optional `CanonicalResultOk.additionalAnalytes`
 * (`AnalyteCurve[]` — each with its own analyte id, matrix, unit, time series and
 * peak); the parent stays the primary top-level analyte. A single-analyte consumer
 * ignores `additionalAnalytes` and reads the primary curve unchanged, so the result
 * shape is backward compatible. The family draws its own parameter block
 * (`ParentMetaboliteRouteParams`) and its `ResolvedRouteSummary.parentMetabolite`
 * carries the formation/stoichiometry; both are optional and present only for the new
 * family. No shipped registry model uses it yet (the first reviewed parent/metabolite
 * vertical is evidence-gated per SC-3B), so the registry checksum and every existing
 * curve are unchanged — this release adds a CAPABILITY, not a curve change.
 *
 * 1.7.0 — MINOR: adds the `one-compartment-zero-order` model family (SC-4A, plan
 * §5.1/§S4) — ZERO-ORDER (constant-rate) extravascular input over a finite duration
 * into a one-compartment linear disposition, for a sustained-/controlled-release
 * product, transdermal patch, or depot approximated as rate-controlled release. Unlike
 * the IV infusion family it carries a real bioavailability `F` (< 1) and an optional
 * absorption lag; the concentration is the constant-rate-input closed form (the
 * absorbed amount `F·Dose` delivered over the duration, peaking at the input endpoint),
 * so it reuses the validated infusion kernel and the infusion-endpoint peak refinement.
 * The zero-order duration draws first in the family's parity order; the reported
 * `ResolvedRouteSummary.infusionDurationHours` carries it (the generic constant-rate
 * input field) and `kaPerHour` is null (no first-order phase). Additive — no existing
 * family or shipped model uses it, so the registry checksum and every existing curve
 * are unchanged. Mixed parallel zero/first-order input is a tracked follow-up.
 *
 * 1.8.0 — MINOR: adds the `one-compartment-mixed-order` model family (SC-4A, plan
 * §5.1/§S4) — PARALLEL (mixed) input where a `firstOrderFraction` of the absorbed dose
 * enters first-order (`ka`) and the rest zero-order over a finite duration, into one
 * shared one-compartment disposition. The concentration is the LINEAR SUPERPOSITION of
 * the two single-pathway closed forms (Bateman + constant-rate input), so it runs on the
 * closed-form path and reuses the existing peak refinement: the per-dose window resolves
 * the sharp first-order peak and the grid-argmax bracket covers the zero-order corner.
 * The summary reports both `kaPerHour` and the zero-order `infusionDurationHours` plus
 * the new optional `firstOrderFraction`, so the mixed split is fully reconstructable.
 * At the fraction extremes it collapses to the pure first-order / zero-order families.
 * Additive — no existing family or shipped model uses it, so the registry checksum and
 * every existing curve are unchanged.
 *
 * 1.9.0 — MINOR: adds the latent→observed matrix-transform contract (SC-5A, plan
 * §5.6/§S5). The observation is not the latent state: a model computes a concentration
 * in its NATIVE matrix, and a scenario may ask for the curve in a different OBSERVED
 * matrix (e.g. whole blood vs plasma). A model now declares reviewed
 * `matrixTransforms` (`from`/`to`/`ratio`/`rationale`); a cross-matrix request is
 * honoured ONLY when a declared transform covers it — the curve (median, bands, peak,
 * and any additional analyte) is scaled by the deterministic `ratio`, the reported
 * `matrix` becomes the observed one, and the applied conversion is recorded in
 * `RunManifest.matrixTransform` with an info limitation — otherwise the request is
 * refused as before, so a latent prediction is never silently reported as an observed
 * measurement. Additive: no shipped model declares a transform (a reviewed conversion
 * is evidence-gated per analyte), the new manifest field and result-scaling are
 * inert without one, and every existing curve and the registry checksum are unchanged.
 * Transform-ratio UNCERTAINTY (broadening the bands) is a separate observation layer
 * (SC-5B); this contract carries the deterministic point conversion.
 *
 * 1.10.0 — MINOR: adds the observation residual-error layer (SC-5B, plan §5.6/§S5). The
 * reported concentration is a latent MODEL prediction; a MEASUREMENT of it also carries
 * error the kinetics do not — assay, preanalytical, biological, structural — kept as
 * DISTINCT named layers (§4.3). A model declares reviewed `observationError` layers, each
 * an optional proportional CV and/or additive SD (mg/L), analyte-specific; the engine
 * composes independent layers in variance and WIDENS the reported bands by the result
 * (deviation-scaling that preserves an MC band's shape, or a symmetric normal band for a
 * deterministic run), leaving the median — the deterministic central prediction —
 * unchanged and truncating at 0. The applied layers are recorded in
 * `RunManifest.observationError` with an info limitation. This is an OBSERVATION source,
 * distinct from the PARAMETER/individual variability that produces the underlying bands.
 * Additive: no shipped model declares one (a reviewed error model is evidence-gated per
 * analyte), so the new field is inert and every existing curve and the registry checksum
 * are unchanged. Correlated (non-i.i.d.) residual components remain a follow-up.
 */
export const CORE_VERSION = '1.10.0';

/**
 * The CanonicalScenario.schemaVersion the current core understands. A consumer
 * (Redose) pins this; the core rejects a scenario whose schemaVersion it does
 * not recognise with an `incompatible-release` failure rather than silently
 * mis-simulating it.
 */
export const SCENARIO_SCHEMA_VERSION = '1';
