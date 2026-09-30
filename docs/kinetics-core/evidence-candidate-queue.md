# kinetics-core — E-track candidate-model queue

**Status:** standing workstream (E-1), started 2026-08-19
**Governs:** [`docs/plans/2026-08-18-kinetics-core-scientific-completion.md`](../plans/2026-08-18-kinetics-core-scientific-completion.md) §E-track, §9
**Feeds:** SC-1C / SC-2B (first covariate PopPK vertical), SC-3B (parent/metabolite), SC-4B (absorption), SC-5C (matrix)

## Why this file exists

The scientific-completion plan is explicit that **in-domain evidence, not engineering, is the
binding constraint** on the whole program (§E-track). Every S1–S5 vertical slice is gated on
finding a _reviewed published model_ carrying the data that slice needs — a random-effect
covariance matrix (S1), a validated covariate relationship (S2), characterised formation kinetics
(S3), a non-trivial absorption profile (S4), paired-matrix data (S5). For Kinetix's
illicit/forensic catalogue those are scarce and unevenly reported, so discovery is a **standing
workstream**, not a side effect of each phase.

This queue keeps a triaged candidate ahead of each active phase, and — per §E-track.4 — records
what the catalogue **cannot** currently support so that an honest _insufficient-evidence_ is a
first-class outcome rather than a silent gap.

### Evidence-quality discipline

Entries below now have the source-access and extraction audit dated 2026-08-26 recorded below.
That audit was performed by an AI research agent, **not by a credentialed pharmacometric or
clinical-pharmacology reviewer**. It therefore cannot satisfy the requested qualified-reviewer
gate or authorize registry work. Where full text was accessible, the audit transcribes the
reported model; where it was not, it deliberately records no reconstructed parameter set.

- **no candidate may be authored into the registry until a named, qualified reviewer attests the
  extraction against the full primary source**;
- an entry graduates from _candidate_ to _implementable_ only after a full-source evidence review
  fills the §9 checklist. That review is the first task of the relevant SC-slice, not of this
  queue.

Sources are PubMed; DOIs are linked per entry.
_Based on articles retrieved from PubMed._

## 2026-08-26 source-access audit and decisions

### Decision vocabulary and provenance

`Direct` means read in the primary article's full text (including its rendered equations and
tables). `Secondary` means stated by another publication. `Reconstructed` means inferred from
reported prose or a diagram. No secondary or reconstructed number below is eligible for registry
authoring. Because this audit has no qualified human reviewer attestation, **every candidate is
currently `insufficient evidence` for the SC gate**, even when the accessible paper contains a
technically promising model. A qualified reviewer must add their name, credentials, review date,
source copy/version, and accept/reject decision before changing that result.

### Lyauk et al. 2016 — d-methylphenidate (PMID 27754602)

- **Source/provenance:** full primary article read via PMC5351003; equations and estimates below
  are direct. The article's supplementary NONMEM control stream was not available in the reviewed
  source package.
- **Population/design:** 122 healthy adults pooled from two oral racemic-MPH studies; plasma
  d-MPH; formulation and dose schedules varied by contributing study. The modeled dose basis is
  administered MPH with parameters apparent after oral bioavailability (`/F`).
- **Structure and identities:** two compartments, three fixed transit compartments, an absorption
  compartment, and first-order central elimination. `ktr=(N+1)/MTT`, `N=3`; the paper reports
  `MTT=0.505 h`, `ka=0.418 h^-1`, `CL/F=233 L/h`, `Vc/F=97.6 L`, `Q/F=70.1 L/h`, and `Vp/F=252 L`.
  These are population typical values, not individual estimates.
- **Covariates/reference:** weight is normalized to 70 kg: `(WT/70)^0.75` on `CL/F` and `Q/F`,
  `(WT/70)^1` on both volumes. Indicator multipliers are `1+indicator*theta`: female on MTT
  (`theta8=0.925`); rs71647871 GA (`-0.587`), one CES1A2 (`-0.182`), two CES1A2 (`-0.410`), and
  rs115629050 TG (`-0.403`) on clearance. The reference is therefore a 70-kg male with reference
  genotypes/no CES1A2 indicator; separate missing-genotype effects were estimated. The printed
  CES1A2 equation is typographically ambiguous (nested one/two-copy factors), so its exact control
  stream expression still requires verification.
- **Variability/error:** lognormal IIV was estimated on MTT (62.1% CV), CL/F (21.6% CV), and Vc/F
  (90.1% CV) using a stated full variance-covariance matrix. The article does **not print the
  off-diagonal Omega elements**, so the requested covariance cannot be recovered exactly.
  Residual error is proportional, reported as 0.184 (dimensionless).
- **Inclusion/validation/limitations:** covariates entered by stepwise testing and permutation
  testing; 2,000 bootstrap samples supplied confidence intervals and standard diagnostics/VPCs
  assessed internal fit. No independent external population validation was reported. Healthy
  adults, racemic oral products, sparse variant carriers, substantial missing rs115629050 data,
  and apparent parameters limit transfer to patients, other routes, or formulations.
- **Decision: INSUFFICIENT EVIDENCE (SC-1C, SC-2B, SC-4B).** Strong structural/covariate lead,
  but exact Omega is absent, one printed genotype function needs control-stream confirmation, and
  qualified-reviewer attestation is missing. Do not author.

### Teuscher et al. 2018 — MPH XR-ODT (PMID 30119076)

- **Source/provenance:** primary full text was not openly accessible in this audit. Abstract-level
  statements only; no values were reconstructed from the 2015 model despite shared authorship.
- **Known scope:** oral extended-release orally disintegrating MPH in pediatric ADHD patients,
  with adult information supporting the analysis; plasma matrix; body-weight effects on clearance
  and volume are reported at abstract level.
- **Unavailable required fields:** exact state/input equations, formulation release function,
  dose basis, parameter vector/units, covariate equation and reference weight, Omega (including
  off-diagonals), residual model, detailed inclusion criteria, and external-validation design.
- **Decision: INSUFFICIENT EVIDENCE (SC-1C, SC-2B, SC-4B).** Full primary source and qualified
  review are required. Do not substitute the open 2015 MPH-MLR equations.

### Teuscher et al. 2015 — MPH-MLR (PMID 26060393)

- **Source/provenance:** full primary article read via PMC4454220; direct unless noted.
- **Population/design/matrix:** adult model: 1,124 plasma concentrations from 25 healthy adults
  receiving oral MPH-MLR 80 mg (fasted single dose; fed multiple-dose data used as a check).
  Pediatric PK: 154 plasma concentrations from 17 children aged 6–12 with ADHD after 10–40 mg
  MPH-MLR or IR comparator. Concentrations were ng/mL by validated LC methods.
- **Structure:** one central compartment with linear elimination and parallel IR/ER depots. IR
  input is first-order `Ka1` with fraction `F1`; ER input is first-order `Ka2`, fraction `1-F1`,
  after `tlag`. Parameters are `F1`, `Ka1` and `Ka2` (h^-1), `tlag` (h), `CL` (L/h), and apparent
  `V` (L). Individual parameters use `Pi=P*exp(etaPi)`, `eta~N(0,omega^2)`.
- **Covariate/reference:** pediatric clearance is printed as
  `CLi=CLTV*WT^theta*exp(etaCL)`. Because weight is not normalized in the printed equation, the
  typical-clearance reference is the equation's unit-weight intercept rather than a clinically
  meaningful reference subject. Weight, height, and BMI were tested on CL and V; only weight on CL
  remained. The table reports pediatric typical values: `F1=0.65`, `Ka1=0.25 h^-1`,
  `Ka2=0.16 h^-1`, `tlag=5.75 h`, `CL=1.3 L/h`, `V=64.7 L`, and weight exponent `1.53`.
- **Variability/error:** the prose says IIV was parameterized for Ka1, Ka2, CL, and V, but the
  final table prints only `omegaCL=0.057` and `omegaV=0.096` (18% and 29% shrinkage). No Omega
  off-diagonals are reported, so correlation is unknown, not zero. The selected observation
  equation is proportional, `Cij=Chatij*(1+epsilonij)`, with table value `epsilon=1.94` (6.2% CV).
- **Validation/limitations:** posterior predictive checks were internal. Adult single-dose model
  predictions were compared with observed fed multiple-dose profiles, but this is a related-study
  check, not an independent external population validation. Small PK samples, product-specific
  release, mixed fed/fasted contexts, plasma-only observations, and unnormalized weight covariate
  prevent general MPH or simple-`ka` use.
- **Decision: INSUFFICIENT EVIDENCE (SC-1C, SC-2B, SC-4B).** Exact correlated Omega is absent and
  qualified attestation is missing. It may be reconsidered specifically for a two-input absorption
  family after review; it is not compatible with the current single-input clv family.

### Hirt et al. 2009 — MDMA/metabolites in rats (PMID 20008456)

- **Source/provenance:** primary full text was not accessible in this audit. Abstract-level facts
  only; no parameter or covariance values were reconstructed.
- **Known scope:** 36 male and female rats plus a 30-rat ethanol-interaction study; IV MDMA;
  plasma MDMA, MDA, HMMA, and HMA; integrated six-compartment first-order formation network with
  interanimal variability and sex/body-weight evaluation.
- **Unavailable required fields:** exact mass-balance equations, dose basis, compartment volumes
  and formation/clearance units, covariate functions/reference animal, Omega, residual models,
  detailed inclusion/exclusion criteria, and external-validation method.
- **Decision: INSUFFICIENT EVIDENCE (SC-3B).** Full source is unavailable here and the rat-IV
  population is outside the intended human forensic applicability. At most this can later be a
  separately labelled engine test, never a human registry model.

### Fung et al. 2008 — 1,4-butanediol to GHB in rats (PMID 18446506)

- **Source/provenance:** the PMC record/publisher landing material was accessible, but a complete
  machine-readable primary article with legible tables/equations was not obtained; abstract-level
  facts are not promoted to numeric evidence.
- **Known scope:** male Sprague-Dawley rats, IV and oral 1,4-butanediol, plasma matrix; first-order
  oral absorption with lag, presystemic conversion to GHB, and Michaelis-Menten GHB elimination;
  ethanol interaction was also studied.
- **Unavailable required fields:** exact differential equations, doses and dose basis, all
  parameter identities/units, covariate/reference-animal functions, Omega, residual model,
  inclusion criteria, and independent external validation.
- **Decision: INSUFFICIENT EVIDENCE (SC-3B, SC-4B).** Rat species and non-catalog prodrug are
  outside registry scope; full-source extraction and qualified review would only support a clearly
  labelled structural test.

### De Hondt et al. 2024 — analytical review (PMID 39171321)

- **Source/provenance:** full primary review read via PMC11335559. Values it quotes from included
  studies are secondary. It is a review of analytical methods, not a PK model.
- **Population/route/formulation/dose basis:** heterogeneous across included publications and not
  pooled into a modeled population. Matrices include plasma, whole blood/DBS, urine, oral fluid,
  and breast milk. The review explicitly notes that blood/oral-fluid concentration correlation was
  not assessed for a cited multianalyte method.
- **Model fields:** no structural matrix-transfer equation, parameter identity/unit, covariate or
  reference subject, Omega, PK residual-error model, enrollment criteria, or external PK
  validation exists to extract. Analytical calibration, recovery, and matrix-effect validation
  are not substitutes for a paired-matrix PK observation model.
- **Decision: REJECT (SC-5C registry authoring).** Wrong evidence type: useful only as a discovery
  bibliography. Any paired-matrix candidate it cites must be reviewed as its own primary source.

### Gate outcome

No candidate is accepted. **SC-1C, SC-2B, SC-3B, SC-4B, and SC-5C remain blocked from registry
authoring by this queue.** A future decision must preserve direct/secondary/reconstructed labels
and may change a row to `accepted` only after the qualified-reviewer attestation described above.

---

## Targeted gap search — 2026-08-26

This search was commissioned specifically against the four gaps below, rather than as a broad
update of the candidate list. The searcher queried **Europe PMC** (which searches PubMed/MEDLINE
records and the Europe PMC full-text corpus) on 2026-08-26 and followed references from retrieved
full texts. Results were screened first by title/abstract and then, where an open full source was
available, against the §9 checklist. The search stopped after the exact queries below, review of
the first 30 relevance-ranked records per query, and backward citation chasing from the two
included full texts; this is a targeted search, **not a systematic-review claim of absence**.

### Preserved search strategies

| Gap | Exact Europe PMC query                                                                                                                                                                                                                                                                                                                             | Inclusion criteria                                                                                                                                                                                                  | Principal negative findings                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `(TITLE_ABS:(population pharmacokinetic) OR TITLE_ABS:PopPK) AND (methylphenidate OR amphetamine OR methamphetamine OR MDMA OR cocaine OR fentanyl OR ketamine) AND (covariance OR omega OR NONMEM)`                                                                                                                                               | Human, catalogue-relevant analyte; population model; an off-diagonal Ω correlation/covariance explicitly reported in a full source; applicable healthy/forensic population rather than a therapeutic disease cohort | Older methylphenidate candidates remained abstract-only or did not expose an off-diagonal Ω in the accessible record. Pediatric analgesia/anesthesia and disease-treatment models were excluded as non-forensic therapeutic populations, even when technically richer.                                                                        |
| S3  | `(TITLE_ABS:(parent metabolite) OR TITLE_ABS:(formation kinetics) OR TITLE_ABS:(joint pharmacokinetic)) AND (amphetamine OR methamphetamine OR MDMA OR cocaine OR methylphenidate OR ketamine) AND HUMAN:y`; then citation chasing from the included MDMA paper                                                                                    | Human parent and measured metabolite; explicit linkage of parent disposition to metabolite input; catalogue-relevant analytes; formation assumptions identifiable                                                   | The earlier MDMA network remained rat/IV. No human multi-step network with all formation fractions and rates estimated from the observations was found. The included human model fixes the MDMA→MDA fraction, so it is useful but does not identify that fraction.                                                                            |
| S4  | `(intranasal OR formulation OR extended-release OR absorption) AND (amphetamine OR methamphetamine OR methylphenidate OR cocaine OR ketamine) AND (pharmacokinetic model OR population pharmacokinetic) AND HUMAN:y`; plus the S1 result set                                                                                                       | Human, catalogue-relevant analyte; route, formulation, or fed-state specific; model has more than a single undifferentiated first-order `ka`                                                                        | Intranasal/oral comparison records usually reported noncompartmental Cmax/Tmax rather than an implementable absorption model. Rat prodrug studies and therapeutic pediatric formulation extrapolations were excluded.                                                                                                                         |
| S5  | `((whole blood AND plasma) OR (serum AND plasma)) AND (paired OR ratio OR partition) AND (amphetamine OR methamphetamine OR cocaine OR fentanyl OR ketamine OR methylphenidate) AND HUMAN:y`; `"blood-to-plasma ratio" AND (cocaine OR amphetamine OR ketamine OR fentanyl OR methadone)`; and backward citation chasing from Umebachi et al. 2022 | Same human draw represented in both matrices, catalogue-relevant analyte, sample size reported, and dispersion or regression uncertainty available                                                                  | Most hits were assay validations, separate cohorts/matrices, postmortem-only series, animal partitioning, or PBPK models using assumed ratios. An ex-vivo pooled-donor designer-benzodiazepine experiment reported mean ± dispersion, but was not an in-vivo paired observation and was therefore not substituted for the requested evidence. |

**Other databases and date limits.** No date restriction was applied. No Embase, Scopus, Web of
Science, or proprietary full-text database was available in this run. PubMed records were accessed
through Europe PMC, and DOI/publisher links were checked for included records. This limitation is
why the negative findings are phrased as “not found by this targeted search,” never “does not
exist.”

### Scientific adjudication

#### S1/S2 — MDMA PopPK with correlated variability: **adequate candidate**

Vizeli et al. 2025 (PMID 39592887; PMCID PMC11812931;
[DOI 10.1002/psp4.13282](https://doi.org/10.1002/psp4.13282)) was read in full from the
publisher-supplied PMC article (including its tables and equations; the separate supplementary
DOCX was not needed for the findings below).

- **Population / route / matrix:** two phase-I studies in healthy volunteers after oral MDMA HCl;
  the food-effect study had 14 fed and 15 fasted evaluable participants, and the second controlled
  NIDA study supplied complementary concentration-time data. Observations were plasma MDMA and MDA.
- **Model / parameterisation:** MDMA is a one-compartment model with linear apparent clearance and
  parallel first- and zero-order oral inputs; parameters reported are `CL/F`, `V2/F`, `ka`, lag
  time (`ALAG1`), zero-order duration (`D1`), and fixed `fmet = 0.1`. MDA is a sequentially fitted
  two-compartment model driven by individual post-hoc MDMA estimates, with `CLM`, `V3`, `QM`, and
  `V4`.
- **Covariates / coding:** body weight is a scaled continuous covariate on MDMA `CL/F` and `V2/F`
  and on MDA `CLM` and `QM`; categorical fed/fasted and study effects modify MDMA absorption and
  disposition; sex modifies MDA `V4`. The paper reports the reference categories and coefficient
  estimates in its final-parameter table.
- **Random effects:** exponential IIV. The full source explicitly reports Ω-block correlations of
  **0.67** (`CL/F`, `V2/F`) for MDMA and **0.82**, **0.86**, and **0.70** for the three MDA pairs
  (`CLM`, `QM`, `V4`). These are correlations, not covariances; implementation must combine them
  with the reported marginal variances and preserve the paper's parameter scale.
- **Residual error / uncertainty:** combined proportional-plus-additive error, with study-specific
  additive error for MDMA; parameter RSEs and a 1,000-resample nonparametric-bootstrap median and
  95% CI are reported. Prediction-corrected VPCs used 1,000 simulations.
- **Validation:** bootstrap and internal VPC only; no independent external population validation is
  reported. The empirical study effects and the 72.3% RSE on the fasted absorption effect limit
  transportability to forensic cases.
- **Decision:** this clears the _candidate evidence_ gate for S1/S2 and replaces the earlier
  abstract-level “no covariance found” outcome. It does **not** authorize a registry model without
  transcription verification, dimensional reconstruction of Ω, provenance pinning, and the
  planned independent implementation review.

#### S3 — human MDMA→MDA model: **qualified candidate, formation fraction unsupported**

The same Vizeli et al. full source provides a human parent-to-active-metabolite model: MDA input is
linked sequentially to each participant's MDMA disposition. It therefore clears the species and
population objections attached to the rat foundation. However, `fmet` is **fixed at 0.1**, not
estimated, and the sequential fit cannot supply uncertainty for that fraction. The supported
feature is a human linked parent/metabolite structure conditional on the source's fixed formation
assumption; a claim that Kinetix has learned or validated the MDMA→MDA formation fraction remains
unsupported. No human multi-step network with estimated formation fractions was found.

#### S4 — human food/formulation-specific absorption: **adequate candidate**

Vizeli et al. also clears the human non-trivial-absorption gap. Oral MDMA uses simultaneous
first-order and duration-limited zero-order input plus lag time, with categorical fed/fasted
effects on `ka`; observed median Tmax was 4.0 h fed versus 2.1 h fasted in the food-effect study.
This supports an oral fed-state/formulation absorption vertical slice, **not** an intranasal↔oral
route conversion. The latter remains unsupported because the targeted route-comparison results
did not provide an implementable population absorption model.

#### S5 — paired MDMA blood/serum: **evidence lead; implementation still unsupported**

Boy et al. 2009 (PMID 19671249;
[DOI 10.1093/jat/33.5.283](https://doi.org/10.1093/jat/33.5.283)) is a much stronger lead than the
analytical-methods review: its abstract reports 63 corresponding blood/serum specimens from 16
healthy volunteers in a controlled driving study, regression plus ANCOVA, and mean experimental
and authentic MDMA blood/serum slopes/ratios of 1.22 and 1.26. It explicitly says a serum estimate
for MDA could not be established because authentic concentrations were too low.

The publisher PDF was not retrievable in this run, and the abstract does not give confidence
intervals, residual dispersion, within-subject handling, exact sampling schedule, or the full
regression equations. Consequently it is **not yet implementable** as a matrix observation model:
the tempting reciprocal `0.80` mentioned in the abstract must not be installed as a universal
conversion factor. Full-source acquisition and extraction of subject-level dependence and
uncertainty are required. Umebachi et al. 2022 (PMID 36454409; PMCID PMC9715504;
[DOI 10.1007/s11419-022-00616-y](https://doi.org/10.1007/s11419-022-00616-y)) was also read in
full, but its mean±dispersion designer-benzodiazepine ratios came from fortified pooled donor blood
and plasma ex vivo; it is retained only as a method lead and deliberately not substituted for
paired in-vivo observations.

## S1 — population parameter semantics + correlated variability

The clv family shipped in SC-1A models **one-compartment, extravascular, apparent `CL/F`·`Vc/F`**.
The best in-domain human PopPK candidates are methylphenidate (an oral stimulant → the expected
apparent-extravascular identity), but the published structural models are richer than
one-compartment, so they also exercise later slices (structural 2-comp, transit absorption).

| Candidate                                 | Population / route                  | Structure                                                | Covariates                                                       | Covariance reported?                          | In-domain?          | PMID / DOI                                                                              |
| ----------------------------------------- | ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| Lyauk et al. 2016, _d_-MPH PopPK          | 122 healthy adults, oral            | 2-compartment + absorption transit compartments (NONMEM) | body weight; CES1 genotype (rs71647871, rs115629050, diplotypes) | full matrix stated; off-diagonals not printed | **Yes** (stimulant) | 27754602 / [10.1111/cts.12423](https://doi.org/10.1111/cts.12423)                       |
| Teuscher et al. 2018, MPH XR-ODT PopPK/PD | pediatric + adult, oral ER          | reports body-weight effects on **CL and V**              | body weight → CL, V                                              | unavailable (full text not accessed)          | **Yes**             | 30119076 / [10.1097/JCP.0000000000000944](https://doi.org/10.1097/JCP.0000000000000944) |
| Teuscher et al. 2015, MPH-MLR PopPK       | healthy adults → pediatric, oral ER | **two-input, one-compartment, first-order elimination**  | body weight → CL                                                 | no off-diagonals reported                     | **Yes**             | 26060393 / [10.2147/DDDT.S83234](https://doi.org/10.2147/DDDT.S83234)                   |

**Triage note (S1).** The MPH-MLR model (2015) is structurally _closest_ to the SC-1A clv family
(one-compartment, first-order elimination) but its **two-input extended-release absorption** is not
representable by a single `ka` — it needs S4 first. The 2016 model is the strongest S2 covariate
exemplar (a genuine genotype covariate on a stimulant) but is 2-compartment + transit, so it
depends on a structural two-compartment CL/V form (an S1 extension) and transit absorption (SC-4B).
**No accessible methylphenidate PopPK prints random-effect covariance (Ω off-diagonals)** — Lyauk
states that a full matrix was fitted but does not provide its elements, so locating the control
stream/supplement or confirming its absence remains open for those records. This is the
"assumed-diagonal, correlation unknown" common case the plan predicts for this catalogue. The
targeted 2026-08-26 search did, however, find Vizeli et al. 2025, a full-source, in-domain human
MDMA model with explicit Ω-block correlations; it is now the leading S1/S2 candidate, while the
methylphenidate records remain useful structural leads rather than covariance sources.

## S2 — model-specific covariate effects

Shares candidates with S1. Teuscher 2018's **weight → CL/V** relationship remains unavailable at
full-text level. Lyauk 2016's **CES1 genotype** and fixed allometric functions were extracted above,
but its typographically ambiguous CES1A2 expression still requires control-stream verification and
qualified review before SC-2B.

## S3 — parent/metabolite & active-moiety kinetics

| Candidate                      | Population / route     | Structure                                                                       | Variability / covariates                  | In-domain?                                 | PMID / DOI                                                                |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Hirt et al. 2009, MDMA network | **rats** (36 + 30), IV | integrated **6-compartment** MDMA → HMMA + MDA → HMA, all first-order formation | interanimal variability; sex, body weight | **Out-of-domain (rat), analyte in-domain** | 20008456 / [10.1093/toxsci/kfp300](https://doi.org/10.1093/toxsci/kfp300) |

**Triage note (S3).** The rat study is a genuine parent→metabolite→secondary-metabolite network with
estimated formation kinetics and IIV — an excellent _conceptual_ exemplar for the S3 model family,
and its analytes (MDMA, MDA, HMMA, HMA) are squarely in-domain. **But it is a rat, IV model**, so
it is flagged out-of-domain as a _foundation_ (a species standing in for human forensic PK) per
§E-track.2. It can validate the S3 engine's structure/mass-balance, not a human curve. A human
MDMA→MDA (or a simpler one-step parent→active-metabolite, e.g. lisdexamfetamine→amphetamine as the
plan suggests in §S3) candidate was the open S3 evidence task. Vizeli et al. 2025 now supplies a human MDMA→MDA linked
model, qualified by its fixed (rather than estimated) formation fraction as adjudicated above.

## S4 — richer administration / absorption

| Candidate                              | Population / route  | Absorption feature                                                                                                     | In-domain?                                             | PMID / DOI                                                                        |
| -------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Fung et al. 2008, 1,4-butanediol → GHB | **rats**, IV + oral | first-order oral absorption **with lag-time** + pre-systemic bioactivation (BD→GHB); MM nonlinear elimination (NONMEM) | **Out-of-domain (rat); prodrug not a catalog analyte** | 18446506 / [10.1208/s12248-007-9006-3](https://doi.org/10.1208/s12248-007-9006-3) |

**Triage note (S4).** A real `tlag` + pre-systemic-formation exemplar (relevant to both S4 lag and
S3 first-pass formation), but rat and a prodrug outside the catalogue, so out-of-domain as a
foundation. Useful to design/validate the `tlag` contract shape; not a shippable human model.
Vizeli et al. 2025 supersedes it as the human candidate for parallel first-/zero-order absorption,
lag, and fed-state effects, though it does not support an intranasal route model.

## S5 — observation / matrix model

| Lead                          | Type                                                                                                             | Relevance                                                             | In-domain?                          | PMID / DOI                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| De Hondt et al. 2024 (review) | analytical-methods review: MPH, amphetamine et al. quantified in **blood, urine, oral fluid, breast milk** by LC | a lead to paired-matrix datasets, **not** a matrix-transform PK model | **Yes** (analytes), but not a model | 39171321 / [10.3389/fpubh.2024.1437328](https://doi.org/10.3389/fpubh.2024.1437328) |

**Triage note (S5).** Boy et al. 2009 supplies an in-domain paired human blood/serum lead, but the
accessible abstract does not report sufficient uncertainty to implement it. S5 therefore remains
unsupported pending full-source review — an honest gap, not a license to install the abstract's
reciprocal point estimate.

## What the catalogue cannot currently support (honest gaps)

Per §E-track.4, recorded so these are first-class outcomes:

- **S1 covariance (resolved at candidate level):** the human MDMA model reports Ω correlations and
  marginal IIV. Registry transcription and independent review remain undone; models without such
  reporting must still use the explicit _assumed-diagonal, correlation-unknown_ fallback.
- **S3 human network (partially resolved):** a human MDMA→MDA linked model exists, but its formation
  fraction is fixed. Estimated formation-fraction uncertainty and a human multi-step network remain
  unsupported.
- **S4 absorption (partially resolved):** human parallel first-/zero-order oral absorption with lag
  and food effects exists. A human intranasal↔oral route-specific population model remains
  unsupported.
- **S5 matrix (open):** paired human MDMA blood/serum observations exist, but the accessible report
  does not expose enough uncertainty for implementation. Keep matrix conversion unsupported until
  the full source is reviewed; do not assume `blood = plasma`, invert `1.26`, or borrow ex-vivo or
  animal ratios.

## Maintenance

This queue is updated continuously (E-track), not per-phase. When a full-source evidence review is
completed for a candidate, replace its `unverified (abstract only)` markers with the §9 checklist
findings and cite whether it was read in full or reconstructed. A phase (SC-1C, SC-2B, SC-3B,
SC-4B, SC-5C) does not begin coding until it has a triaged candidate here with that review done —
or an explicit, recorded finding that the evidence does not exist.
