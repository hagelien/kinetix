## Overall assessment

Kinetix has a strong architecture: one event-based workspace, per-component engine dispatch, web-worker computation, shared Plotly visualisation, reproducible seeds, model cards, saved cases, and a drug database with revisions and citations. The previous layout and timeline requests are already substantially implemented.

The main limitation is now **statistical semantics and correctness**, not lack of features. Several results currently appear more authoritative than their underlying models justify.

## Correctness issues to address first

| Priority | Issue                                                                                                                                                                                                                                                                        | Recommended change                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Critical | **Vd can be multiplied by body weight when it is already expressed in litres.** `weightScaling` becomes true whenever a weight is entered, even if Vd is not L/kg. The worker then multiplies sampled Vd by weight.                                                          | Scale only when the stored unit is explicitly `L/kg`. Treat missing units as unknown, not implicitly L/kg. Add tests for `L`, `L/kg`, missing unit, and overrides. |
| Critical | **Multiple ethanol intakes receive multiple elimination slopes.** Each intake is independently reduced by β×time and then summed; with two active intakes, total BAC can decline at approximately 2β.                                                                        | Use a chronological state model: decay the total BAC once between events, then add each intake. Add optional absorption duration later.                            |
| High     | **Dose back-calculation can use the query time rather than the measurement time.** The concentration belongs to `lastMeasurement.t`, but `timeSinceDose` is derived from `lastQuery.t`.                                                                                      | For dose inference, calculate elapsed time from dose to measurement. A query should specify the requested quantity, not relocate the observation.                  |
| High     | **Routes imply distinctions the model does not implement.** Oral, insufflation, inhalation, and “other” all use the same immediate-absorption equation; only IV differs.                                                                                                     | Hide unsupported routes for that engine or implement route-specific bioavailability and absorption-rate distributions.                                             |
| High     | **Model cards claim first-order absorption, but the equation has no absorption term or `ka`.** The oral equation is simply (FD/V,e^{-kt}).                                                                                                                                   | Either rename the current model “instantaneous absorption” or implement the Bateman equation with `ka`.                                                            |
| High     | **Sensitivity percentages are mathematically mislabeled.** They are normalized absolute Pearson correlations, not percentages of output variance.                                                                                                                            | Immediately rename them “relative correlation scores.” Preferably replace them with rank-based PRCC or Sobol total-effect indices.                                 |
| High     | **Results are not invalidated after inputs change.** Moving an event or editing a parameter can leave the previous curve displayed against the new inputs.                                                                                                                   | Store an input hash with every result. Mark it “out of date” immediately after any relevant edit and visually dim the curve until rerun.                           |
| High     | **Incompatible units can share one y-axis.** A graph can overlay mg/L, g/dL, and molar results under a generic “concentration” label. The current “separate” mode changes the heading and height but still sends all series to one chart; `yAxisMode` is defined but unused. | Group series into genuine small multiples by compatible unit. Permit mixed-unit overlays only after explicit normalization.                                        |

The generic PK defaults also deserve stronger handling. Missing data silently become half-life 4 hours, Vd 50 L, and F 1 in the forward simulator; the inference path has similar synthesized defaults.   For forensic work, I would use three states: **verified parameter**, **explicit user assumption**, and **insufficient data**. Generic fallbacks should require acknowledgement and be unmistakable in the result.

## KineLab statistical improvements

The current KineLab implementation is importance sampling from independent priors with a lognormal likelihood. It is a reasonable browser-based prototype, but several labels and outputs should change.

First, the main result should be the quantity being inferred. For a dose-from-concentration analysis, the prominent answer should be the **posterior dose median and credible interval**. At present the unified result fields contain the peak of the modelled concentration curve, while the inferred dose is placed further down in a parameter table.

Second, the plotted “posterior predictive” envelope currently propagates posterior parameter uncertainty through the latent concentration curve but does not sample residual or observation error. It is therefore more accurately a **posterior credible envelope for expected concentration**, not a posterior predictive interval for a future measurement.

Third, assay CV is currently effectively the entire residual-error model. Analytical uncertainty, preanalytical uncertainty, biological variability, matrix conversion, and structural-model error should be represented separately. Otherwise a precise assay can produce unjustifiably narrow dose intervals even when the PK model is poor.

Other important changes:

* Show **ESS as a proportion of attempted draws**, not just an absolute number, and make low ESS a prominent warning. The worker already calculates the necessary values, but the unified result supplies no KineLab warnings.
* Increase draws adaptively until ESS or Monte Carlo precision reaches a threshold, rather than always stopping at a fixed count.
* Show prior and posterior intervals side by side. This immediately reveals weak identifiability or a result driven almost entirely by its prior.
* Add censored observations for `<LOQ` and `<LOD`, rather than excluding non-positive measurements.
* Make matrix a case input. The unified bridge currently hardcodes every observation to whole blood despite model cards listing other matrices.
* Do not select the mathematical family solely from the presence of an `eliminationRate` prior. Validate that the selected model card, parameter shape, analyte, route, and matrix agree.
* Move beyond basic importance sampling for informative or multidimensional cases. Adaptive sequential Monte Carlo would still be feasible in-browser; HMC/NUTS and hierarchical population models belong in the planned remote engine.

The repository already anticipates a full backend supporting ODE solving, HMC/NUTS, hierarchical population PK, postmortem models, and model averaging. That is the right separation: retain a transparent Lite engine for rapid exploration and use the remote engine for analyses requiring population covariance and serious posterior computation.

## More realistic forward PK

The next Lite PK model should support:

1. **One-compartment oral absorption**

   [
   C(t)=\frac{F D k_a}{V(k_a-k_e)}
   \left(e^{-k_e t}-e^{-k_a t}\right)
   ]

   Store `ka` explicitly, or derive a constrained prior from Tmax while preserving the uncertainty and assumptions.

2. **Repeated dosing by superposition**

   Every dose event should contribute to the curve. Currently only the latest known dose is used, although the UI allows several dose events.

3. **IV bolus and infusion as distinct routes**

   Infusion needs duration or rate; it should not be represented as an IV bolus.

4. **Joint parameter distributions**

   Half-life, Vd, clearance, F, and absorption rate should not automatically be sampled independently. Where population-model covariance is available, sample from that joint distribution.

5. **Explicit residual variability**

   Keep parameter uncertainty, interindividual variability, residual/model error, and analytical error as separate layers that can be switched on or off.

6. **Model-family selection**

   One-compartment first-order should remain the lightweight default. Add analyte-specific two-compartment, saturable, and parent–metabolite models only where supported by curated evidence. The existing model-card registry is a good foundation for this.

The current conversion of a literature min–max range into a uniform distribution, or min–median–max into a triangular distribution with the median used as the mode, is convenient but not statistically defensible as a general rule.  Store probability semantics explicitly: distribution family, parameterisation, whether bounds are observed extrema or quantiles, study population, route, matrix, sample size, references, and covariance group.

## A more appealing modelling interface

I would reorganize the workspace into four visible stages: **Build → Check → Run → Interpret**.

### Component rail

Keep the 2/3 chart and 1/3 component layout, but make each component a compact summary card:

* drug and model name;
* readiness badge;
* number of doses, samples, and queries;
* route, matrix, and subject summary;
* data-quality or validation badge;
* primary warning.

Only one card should normally be expanded. The current `DrugPanel` contains engine selection, subject data, events, literature values, workbook tools, and advanced settings in one long card.

Replace the plain engine dropdown with model cards such as:

> **One-compartment, instantaneous absorption**
> Fast browser model · oral approximation · literature-derived parameters
> Not suitable around Tmax

The existing validation statuses—toy, literature-derived, validated, experimental—should be visible, not confined to the model registry.

### Readiness and validation

Before running, show an explicit checklist:

* observation matrix selected;
* all units valid;
* event chronology valid;
* required weight supplied for L/kg Vd;
* model supports selected route;
* parameter sources available;
* inference expected to be identifiable.

Disable the run button only for impossible configurations. For questionable configurations, allow the run after presenting an acknowledgement.

### Results

Place an “answer card” immediately below the chart:

> Predicted concentration at 08:30
> **0.42 mg/L**
> Modelled 90% uncertainty interval: **0.18–0.91 mg/L**
> Result current · 9,842 valid draws · model v1.2

The label should change with the task: predicted concentration, back-extrapolated concentration, inferred dose, or BAC at the specified time. Peak values should appear only when the user asks about a peak.

Below that, separate:

* clinical/forensic interpretation overlays;
* parameter uncertainty;
* diagnostics;
* assumptions and limitations;
* evidence and provenance.

The assumptions panel currently renders half-life, Vd, and F for every engine, even though ethanol and KineLab results populate these with placeholder zeros and ones.   Make assumptions model-specific instead.

### Chart and timeline

* Use genuine small multiples for incompatible units and model families.
* Display units in every axis title.
* Render therapeutic/toxic regions as translucent bands rather than only boundary lines.
* Put measured concentrations, their analytical uncertainty, doses, and query points directly into the Plotly coordinate system.
* Label uncertainty as “pointwise 90% model interval,” “90% credible interval,” or “90% predictive interval” as appropriate.
* Keep the external timeline for editing if desired, but align it to Plotly’s actual x-axis domain. It currently spans the entire card while the graph has independent left and right margins, so marker positions are not precisely aligned with the plotted curve.

## Reproducibility and validation

Every result should carry a run manifest containing:

* input/configuration hash;
* engine and model version;
* source-code commit;
* drug-parameter revision IDs;
* parameter references and provenance;
* unit and matrix;
* seed, attempted draws, valid draws, and diagnostics;
* execution timestamp.

That permits a report to state exactly which model and data generated the result and enables automatic stale-result detection.

For model validation, add a versioned benchmark suite with:

* equation and dimensional-analysis tests;
* synthetic parameter and dose recovery;
* simulation-based calibration for Bayesian inference;
* interval-coverage tests;
* bias and error against held-out concentration–time data;
* cross-language parity against a reference Python implementation;
* stress tests for extreme times, weights, concentrations, and priors;
* regression reports committed alongside every model-version change.

A model card should reach `validated` only after its intended population, route, matrix, time window, bias, interval coverage, and failure conditions have been documented.

## Recommended implementation order

1. **Correctness and guardrails:** Vd scaling, ethanol multi-intake elimination, dose timing, strict units/routes, sensitivity relabelling, and stale-result detection.
2. **Result semantics:** task-specific primary answers, correct interval names, real small multiples, model-specific assumptions, and visible validation status.
3. **PK Lite v2:** absorption, repeated dosing, infusion, structured residual error, and explicit parameter distributions.
4. **KineLab inference v2:** adaptive sampling, prior-versus-posterior display, matrix support, censored measurements, and genuine posterior predictive simulation.
5. **Validation platform and full backend:** population covariance, ODE models, HMC/NUTS, model averaging, and clearly separate postmortem models.

The highest-value first release is not a new advanced engine. It is a “trust release” that fixes the critical calculations, makes stale or assumption-driven outputs obvious, and ensures every number says exactly what kind of statistical quantity it represents.
