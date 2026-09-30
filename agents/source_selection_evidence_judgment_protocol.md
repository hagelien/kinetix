# Kinetix Source Selection and Evidence-Judgment Protocol

Version: 2026-09-17

Purpose: choose evidence sources according to the scientific question, preserve the independence and context of the evidence, and stop searching when the question has been answered as well as the available literature allows.

This protocol is for drug, toxicology, pharmacology, forensic, analytical, and related evidence work. It is not a requirement to search every database for every task.

---

## 0. Core principle: route by question, not by database prestige

Different sources answer different questions. A regulatory label may be the best source for an approved formulation, a controlled PK study for a half-life, a forensic series for postmortem concentrations, and an analytical validation paper for an assay limit.

For every research task:

1. **Define the exact claim or quantity you need.**
2. **Establish substance identity and relevant synonyms.**
3. **Choose source categories that can answer that question.**
4. **Prefer direct, primary, and context-matched evidence where available.**
5. **Look for independent corroboration and important contradictory evidence when the claim will become reusable Kinetix data.**
6. **Preserve context and uncertainty instead of forcing incompatible studies into one answer.**
7. **Record what was searched, unavailable, and not found.**
8. **Stop when additional searching is unlikely to change the answer or the uncertainty statement.**

Do not treat a long source list as evidence of rigor. Coverage should be proportionate to the question.

---

## 1. First establish the identity layer

Before narrow searching, resolve what substance the question actually concerns:

- parent drug versus metabolite;
- salt/free base;
- stereoisomer/racemate;
- prodrug/active metabolite;
- older names, brand names, spelling variants, abbreviations;
- identifiers such as PMID/DOI/CAS/PubChem CID when available;
- forensic/NPS aliases where relevant.

Useful identity resources include PubChem, DrugBank, ChEMBL, RxNorm, WHO ATC/DDD, IUPHAR/BPS Guide to Pharmacology, SWGDRUG, EUDA, UNODC, NPS Discovery, CAS SciFinder, and Reaxys as available.

Do not broaden a finding from one chemical form or analyte to another unless the transfer is scientifically justified and stated.

---

## 2. Question router

Use this table as the default starting point. The right column is a **minimum useful route**, not a universal checklist.

| Research task | Start with | Add when needed |
|---|---|---|
| Review one supplied scientific paper | Full paper + supplements/protocol/registry needed to judge it | Targeted external search for correction/retraction, methods context, or material contradiction |
| PK parameter (Cmax, Tmax, t½, Vd, CL, F, B/P etc.) | Direct primary human PK studies | Regulatory clinical-pharmacology material, additional independent PK studies, special-population studies |
| Therapeutic use/formulation/dosing as approved | Current official product information / regulatory assessment | Primary trials or PK studies for details not resolved by the label |
| Acute poisoning/management | Current specialist toxicology guidance | Primary clinical evidence, poison-centre series, systematic reviews |
| Drug interaction | Controlled human DDI studies | Label/regulatory material, specialist interaction resources, case reports for rare severe events, mechanistic evidence |
| Postmortem concentrations / redistribution | Primary forensic/postmortem studies with appropriate specimen context | Additional forensic series, paired AM/PM studies, methodological papers |
| Recreational/NPS/emerging drug | Recent primary case/series + EUDA/UNODC/NPS surveillance | Poison-centre networks, analytical papers, mechanistic/preclinical evidence |
| Analytical identification/quantification | Matrix-relevant validation/method paper | Spectral libraries, reference standards, interlaboratory/confirmation guidance |
| Adverse-event signal | Primary clinical evidence + regulatory/pharmacovigilance context | FAERS/EudraVigilance/VigiBase as signal sources, targeted case reports |
| Organ-specific toxicity / pregnancy / lactation | Appropriate specialist curated source | Primary human literature and regulatory material |
| Systematic evidence question | PubMed/MEDLINE + appropriate complementary bibliographic database(s) | Citation chasing, registries, grey literature according to the review question |

The task determines the source hierarchy. There is no single universal hierarchy that fits intervention efficacy, postmortem toxicology, analytical validation, and NPS surveillance equally well.

---

## 3. Searching the biomedical literature

### Core discovery tools

Use PubMed/MEDLINE as the default biomedical starting point. Add databases when they can materially improve recall for the question:

- **Embase:** drugs, pharmacology, adverse effects, European literature, conference abstracts;
- **Web of Science / Scopus:** forward/backward citation mapping and broad multidisciplinary coverage;
- **Europe PMC / PubMed Central:** full-text discovery;
- **Google Scholar:** obscure/non-indexed material, used cautiously;
- **Semantic Scholar / OpenAlex:** broad discovery and citation-network exploration;
- **PsycINFO:** psychoactive effects, cognition, dependence, behavioral outcomes;
- **Global Health:** poisoning epidemiology/public health and LMIC contexts;
- **CINAHL:** implementation, emergency/nursing/allied-health questions.

Search results and ranking are discovery aids, not evidence-quality rankings.

### Search construction

Use the identity layer plus the quantity/context being sought. For reusable Kinetix values, search for likely terminology variants, for example:

- substance + `pharmacokinetics`, `Cmax`, `Tmax`, `half-life`, `clearance`;
- substance + `postmortem`, `femoral`, `redistribution`, `antemortem`;
- substance + matrix + `LC-MS/MS`, `validation`, `stability`;
- substance + `poisoning`, `overdose`, `intoxication`, `case series`.

Do not infer absence from one narrow query.

---

## 4. Independence: count studies, not citations

Repeated citation is not independent corroboration.

Before calling evidence independently replicated, ask whether apparently separate sources share:

- the same participants or cases;
- overlapping recruitment periods/institutions;
- the same clinical trial or registry number;
- the same dataset/biobank/poison-centre cohort;
- a primary study and a later secondary source merely restating it;
- companion papers reporting different outcomes from one study.

For an important reusable Kinetix parameter, make a targeted attempt to find **at least one independent source** when such evidence plausibly exists. If only one independent study exists, record that honestly. Do not add weaker restatements merely to increase a source count.

---

## 5. Evidence matching: directness before hierarchy

For every candidate source ask:

1. Is it primary, secondary, regulatory, surveillance-based, or computational?
2. Is the evidence human, animal, in vitro, or theoretical?
3. Is it the exact substance/form/metabolite of interest?
4. Does it answer the same scientific quantity?
5. Is the population relevant?
6. Is the dose, route, formulation, timing, and scenario compatible?
7. Is the specimen/matrix compatible?
8. Is the result antemortem or postmortem?
9. Is the number directly measured, model-derived, reviewer-calculated, or inferred?
10. Are co-exposures, tolerance, organ failure, and other major modifiers addressed where relevant?

A source higher on a generic evidence hierarchy can be less useful than a lower-level source that directly measures the quantity in the correct setting.

Examples:

- For a rare fatal NPS exposure, a forensic case series may be the strongest available direct evidence.
- For acute poisoning management, current specialist toxicology guidance may be more useful than an old isolated trial.
- For a specific analytical limit, the laboratory's validated method is more relevant than a general drug monograph.
- For a human PK parameter, an animal study does not become direct evidence merely because it is experimentally controlled.

---

## 6. Source-specific judgment rules

### Regulatory and official medicine sources

Useful sources: DailyMed, Drugs@FDA, FDA reviews, EMA EPAR/SmPC, national medicines agencies, official product information.

Use them for approved indications, formulations, warnings, contraindications, and official clinical-pharmacology information. They can be incomplete for recreational use, rare toxicity, overdose, postmortem interpretation, and unusual co-ingestion scenarios.

Prefer the current label for current practice, but consult historical versions when investigating a historical warning or older study context.

### Specialist clinical toxicology

Useful sources: POISINDEX/Micromedex Toxicology, TOXBASE, national poison-centre guidance, toxicovigilance networks.

These are high-value synthesis/guidance sources for acute management. When a precise factual claim will be stored in Kinetix, trace important claims to primary evidence where feasible.

### Pharmacovigilance

Useful sources: FAERS, EudraVigilance, VigiBase/VigiAccess and national systems.

Use for signal detection. Do **not** treat report counts as incidence or causality. Consider underreporting, duplicates, stimulated reporting, missing denominators, and confounding.

### Poison-centre and toxicovigilance datasets

Useful for exposure patterns, severity trends, co-ingestion patterns, and emerging signals. They are usually weaker for precise dose-response or PK inference unless the dataset was designed for that purpose.

### Drug references and interaction compendia

Examples: Martindale, AHFS, Lexidrug/Lexicomp, Clinical Pharmacology, BNF, Stockley's.

Use for triangulation and practical context. Do not make a rare-toxicity, fatality, forensic, or mechanistic claim depend solely on a general compendium when primary evidence is available.

### Mechanistic/target databases

Examples: PubChem, DrugBank, ChEMBL, IUPHAR/BPS, BindingDB, HMDB.

Useful for identity, targets, metabolites, binding data, and mechanistic plausibility. In-vitro target affinity does not by itself establish a human clinical effect.

### Organ-specific and special populations

Examples: LiverTox, LactMed, REPROTOX, TERIS, DILIrank, CPIC, PharmGKB.

Use the specialist resource appropriate to the question and preserve its evidence level. Do not convert animal reproductive data or genotype association into stronger human clinical claims than the source supports.

---

## 7. Forensic toxicology and NPS rules

Relevant sources include EUDA, UNODC Early Warning Advisory/Tox-Portal, NPS Discovery, SWGDRUG, forensic journals, poison-centre networks, and primary case/series literature.

Always distinguish:

- antemortem versus postmortem;
- peripheral/femoral versus central blood where known;
- whole blood versus plasma/serum;
- parent drug versus metabolite;
- single-drug versus multi-drug exposure;
- measured concentration versus interpretive attribution;
- case observation versus population distribution;
- postmortem distribution versus lethal/toxic threshold.

Do not infer fatal causality from detection alone. Do not merge postmortem concentrations with therapeutic antemortem concentrations as though the matrix and physiology were equivalent.

For emerging drugs, recent early-warning/forensic evidence may be more informative than an older general review.

---

## 8. Pharmacokinetic parameter sourcing

When sourcing a structured PK value, preserve the conditions that define the observation.

At minimum capture when available:

- study population;
- `n` for the parameter;
- administered substance/form;
- dose and regimen;
- route/formulation;
- matrix;
- sampling schedule;
- reported statistic and variability;
- whether observed or model-derived.

### Dose normalization

Store the source-reported value and dose separately whenever possible. Dose-normalized representations are derived views, not replacements for the source observation.

Do not assume linear dose proportionality. A Cmax/dose view can be useful for comparison, but only where dose normalization is scientifically defensible for that drug, formulation, dose range, and population.

### Conflicting PK values

Do not collapse disagreement prematurely. First check whether the difference is explained by:

- dose/formulation/route;
- single dose versus steady state;
- population or organ function;
- analyte/metabolite definition;
- matrix;
- sampling window;
- model or parameter definition;
- fast/slow metabolizer phenotype or other known covariates.

Only pool values that represent the same scientific quantity closely enough for the intended summary.

---

## 9. Analytical evidence

Useful sources include validated LC-MS/MS, GC-MS, HRMS, immunoassay, or other method papers, plus NIST/SWGDRUG/MassBank/MoNA/mzCloud spectral resources as appropriate.

A spectral-library match is supporting identification evidence; it is not a substitute for method validation.

For reusable analytical claims preserve:

- laboratory/method context where relevant;
- matrix;
- analyte/isomer/metabolite distinction;
- calibration range;
- limit definitions used by the source;
- selectivity/interference findings;
- precision/bias and stability where relevant.

Do not generalize one laboratory's LOD/LOQ/reporting limit into an intrinsic property of the drug.

---

## 10. Contradictions and source conflicts

When sources disagree:

1. Verify that they truly measure the same quantity.
2. Check identity, units, matrix, route, dose, timing, population, and statistic type.
3. Check whether one is secondary and derived from the other.
4. Compare methods and risk of bias.
5. Check chronological issues such as corrected methods or newer analytical specificity.
6. Preserve unresolved disagreement explicitly.

Do not create a synthetic average merely because two numbers exist. Aggregation requires scientific compatibility, not just convertible units.

---

## 11. Negative searches and unavailable sources

Keep these states distinct:

- **searched, no relevant result found**;
- **source/database unavailable**;
- **not searched because not relevant to the question**;
- **potentially relevant source identified but full text unavailable**.

Do not say a database contains no evidence when you could not access it. Use the closest appropriate accessible source category and record the limitation.

If full text is required to support a Kinetix claim and cannot be obtained legitimately, use the PDF-request workflow rather than treating the abstract as sufficient evidence.

---

## 12. Search stopping rule

A research task is sufficiently searched when all of these are true:

1. The relevant source category/categories for the question have been searched.
2. The best direct evidence located has been read at the depth required for the claim.
3. For an important reusable parameter, an attempt has been made to identify independent corroborating or contradictory evidence where such evidence plausibly exists.
4. Major obvious disagreements have been investigated rather than hidden.
5. Remaining uncertainty is explicit.
6. Another broad search is unlikely to materially change the answer or the uncertainty statement.

Do not continue searching merely to satisfy a numeric source count.

---

## 13. Compact research-note output

When this protocol supports Kinetix content, leave an auditable note. Put the conclusion first.

```markdown
## Takeaway
[What the evidence supports, with the main uncertainty.]

## Best evidence
- [Source / study]: [direct finding + context]
- [Independent source, if available]: [corroboration or conflict]

## Applicability
[Population, matrix, dose/route/timing, postmortem/antemortem, or other boundary that matters.]

## Search trail
- Identity terms: [...]
- Source categories searched: [...]
- Unavailable / no-result categories: [...]
- Search date: [required for time-sensitive questions]

## Conflict / uncertainty
[Only if material.]
```

Requirements:

- cite primary or official sources for high-impact claims whenever possible;
- preserve units, matrices, species, dose/route, sampling time, and formulation when they affect interpretation;
- label secondary summaries, surveillance signals, postmortem observations, animal/in-vitro data, and computational predictions appropriately;
- flag source conflicts rather than merging them into an unsupported range;
- record the search date for regulatory status, warnings, drug alerts, emerging NPS information, or other time-sensitive claims.

---

## 14. Source catalogue by function

This is a menu, not a mandatory checklist.

### Biomedical literature
PubMed/MEDLINE; Embase; Web of Science; Scopus; Europe PMC; PubMed Central; Google Scholar; Semantic Scholar; OpenAlex.

### Toxicology / poisoning
POISINDEX/Micromedex Toxicology; TOXBASE; national poison centres; Clinical Toxicology; toxicovigilance networks.

### Regulatory / official medicines
DailyMed; Drugs@FDA; FDA assessment material; EMA EPAR/SmPC; national medicine agencies; official product information.

### Pharmacovigilance / surveillance
FAERS; EudraVigilance; VigiBase/VigiAccess; NPDS; Euro-DEN Plus; national/regional systems.

### Trials / evidence synthesis
Cochrane Library; CENTRAL; ClinicalTrials.gov; WHO ICTRP; CTIS and other relevant trial registries.

### Drug references / interactions
Martindale; AHFS; Lexidrug/Lexicomp; Clinical Pharmacology; BNF; Stockley's; Liverpool interaction resources; FDA CYP/transporter resources; ICH M12; PharmGKB; CPIC.

### Chemical / mechanism
PubChem; DrugBank; ChEMBL; IUPHAR/BPS; BindingDB; HMDB; CAS SciFinder; Reaxys; ChemSpider.

### Special populations / organ toxicity
LiverTox; LactMed; REPROTOX; TERIS; DILIrank; specialist pediatric/geriatric resources.

### Forensic / NPS
EUDA; UNODC EWA/Tox-Portal; NPS Discovery; SWGDRUG; Journal of Analytical Toxicology; Forensic Science International; Forensic Toxicology; Drug Testing and Analysis; Clinical Toxicology; national early-warning systems.

### Analytical / spectral
NIST; SWGDRUG spectral libraries; MassBank; MoNA; mzCloud; HMDB spectra; validated published methods.

### Computational / hazard
EPA CompTox; ToxCast; Tox21; ECHA CHEM; OECD eChemPortal.

### Specialty bibliographic sources
PsycINFO; Global Health; CINAHL.

TOXNET is retired. If historical TOXNET-derived content is encountered, use the current hosting source where possible.

---

## 15. Final self-check

Before turning research into a Kinetix claim or parameter source, confirm:

1. I searched for the right **question**, not merely the drug name.
2. I resolved substance/analyte identity before comparing values.
3. The source directly supports the intended claim or I clearly labeled the inference.
4. I did not count repeated reporting of one dataset as independent replication.
5. The population, matrix, dose/route, timing, and scenario travel with the finding when they matter.
6. I distinguished antemortem from postmortem evidence.
7. I did not treat surveillance counts as incidence or mechanism as clinical proof.
8. I investigated material disagreement instead of averaging it away.
9. I recorded unavailable sources and negative searches honestly.
10. I know why the search can stop.
