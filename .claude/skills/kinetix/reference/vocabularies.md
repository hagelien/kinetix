# Kinetix closed vocabularies

**Generated file — do not edit by hand.** Regenerate with `npm run skill:reference`;
`npm run skill:reference:check` fails when it has drifted from the code.

Every identifier below is closed: a value outside these lists is rejected by
`parseConversationIngestion`. If the thing you need is not here, it is not a
missing entry to invent — it is a `blockedCandidate`.

## Parameter ids

The only parameters that accept a per-source observation. Metadata (names,
aliases, molecular weight, PubChem CID) and analyte stability are
deliberately absent — they are not poolable across sources. LOQ and LOD are
absent for a different reason: they are not parameters at all. An analytical
limit belongs to a validated method in a laboratory, not to the substance,
and Kinetix records it per analyte per analytical method.

| id | unit | range | matrix | scenario | low & high |
| --- | --- | --- | --- | --- | --- |
| `halfLife` | `h` | 0–10000 h | forbidden | forbidden | **both required** |
| `volumeOfDistribution` | `L/kg` | 0.01–1000 L/kg | forbidden | forbidden | **both required** |
| `bioavailability` | `fraction` | 0–1 fraction | forbidden | forbidden | **both required** |
| `proteinBinding` | `fraction` | 0–1 fraction | forbidden | forbidden | **both required** |
| `bloodPlasmaRatio` | `ratio` | 0–100 ratio | forbidden | forbidden | optional |
| `tmax` | `h` | 0–240 h | forbidden | forbidden | optional |
| `pKa` | `(none)` | -10–20 dimensionless | forbidden | forbidden | optional |
| `logP` | `(none)` | -10–15 dimensionless | forbidden | forbidden | optional |
| `logD` | `(none)` | -10–15 dimensionless | forbidden | forbidden | optional |
| `clearance` | `L/h`, `L/min`, `mL/min`, `L/h/kg`, `mL/min/kg` | 0–100000 L/h | forbidden | forbidden | optional |
| `vmax` | `mg/L/h`, `µg/mL/h`, `mg/dL/h`, `g/L/h`, `mg/L/min` | 0.0001–100000 mg/L/h | **required** | forbidden | optional |
| `km` | any concentration unit (see below) | 0.000001–1000000 mg/L | **required** | forbidden | optional |
| `postmortemRedistribution` | `ratio` | 0–100 ratio | forbidden | forbidden | optional |
| `pmAmRatio` | `ratio` | 0–1000 ratio | forbidden | forbidden | optional |
| `therapeuticDose` | `mg`, `g`, `µg`, `mg/kg`, `mg/day`, `mg/kg/day` | 0–1000000 mg | forbidden | forbidden | optional |
| `maxRecommendedDose` | `mg`, `g`, `µg`, `mg/kg`, `mg/day`, `mg/kg/day` | 0–1000000 mg | forbidden | forbidden | optional |
| `nonMedicalDose` | `mg`, `g`, `µg`, `mg/kg`, `mg/day`, `mg/kg/day` | 0–1000000 mg | forbidden | forbidden | optional |
| `overdoseDose` | `mg`, `g`, `µg`, `mg/kg`, `mg/day`, `mg/kg/day` | 0–1000000 mg | forbidden | forbidden | optional |
| `fatalDose` | `mg`, `g`, `µg`, `mg/kg`, `mg/day`, `mg/kg/day` | 0–1000000 mg | forbidden | forbidden | optional |
| `therapeuticConcentration` | any concentration unit (see below) | 0–1000000 mg/L | **required** | **required** | optional |
| `supratherapeuticConcentration` | any concentration unit (see below) | 0–1000000 mg/L | **required** | **required** | optional |
| `impairmentConcentration` | any concentration unit (see below) | 0–1000000 mg/L | **required** | **required** | optional |
| `toxicConcentration` | any concentration unit (see below) | 0–1000000 mg/L | **required** | **required** | optional |
| `fatalConcentration` | any concentration unit (see below) | 0–1000000 mg/L | **required** | **required** | optional |
| `bloodDetectionWindow` | `h` | 0–8760 h | forbidden | forbidden | optional |
| `oralFluidDetectionWindow` | `h` | 0–8760 h | forbidden | forbidden | optional |
| `urineDetectionWindow` | `h` | 0–8760 h | forbidden | forbidden | optional |

Bounds are checked in the canonical unit, so a value in a denser unit is
converted before the check — 1e6 µg/mL does not sneak past mg/L.

A parameter marked **both required** under "low & high" rejects an entry
backed by only a `median`: report the range the source gives, not a
single reading. Never invent bounds by setting `low = high = median` —
that asserts a zero-width range the source never reported.

### Concentration units

`ng/mL`, `ng/dL`, `ng/L`, `µg/mL`, `µg/dL`, `µg/L`, `mg/mL`, `mg/dL`, `mg/L`, `nmol/mL`, `nmol/dL`, `nmol/L`, `µmol/mL`, `µmol/dL`, `µmol/L`, `mmol/mL`, `mmol/dL`, `mmol/L`

Report the unit the source used. Do not convert to make a value look
comparable — the aggregation pipeline converts, and it records that it did.

## Dose-context parameters

Entry-only parameters whose readings carry structured `doseContext` (see
SKILL.md, "Cmax: structured dose context"). A `valueBasis` is required.

Every other numeric parameter takes only the reported-statistic fields of
`doseContext` — `centralValue`, `centralStatistic`, `intervalKind` — optionally
(see SKILL.md, "What the number is"); every dose field is refused there.

- `cmax` — matrix **required**; concentration units as above for `valueBasis: "concentration"`; a concentration-per-dose unit (e.g. `µmol/L/mg`, `ng/mL/(mg/kg)`) for `"dose_normalized"`; range 0–100000.

| doseContext field | values |
| --- | --- |
| `valueBasis` | `concentration`, `dose_normalized` |
| `centralStatistic` | `arithmetic_mean`, `geometric_mean`, `median`, `single_subject`, `unknown` |
| `intervalKind` | `sd`, `sem`, `ci95`, `iqr`, `range`, `unknown` |
| `doseUnit` | `µg`, `mg`, `g`, `µg/kg`, `mg/kg` |
| `doseBasis` | `active-moiety`, `parent`, `salt`, `free-base` |
| `doseRegimen` | `single`, `multiple`, `steady_state`, `unknown` |
| `ivInputMode` | `bolus`, `infusion`, `unknown` |
| `releaseProfile` | `immediate`, `modified`, `not_applicable`, `unknown` |
| `physicalForm` | `tablet_capsule`, `solution`, `suspension`, `other`, `unknown` |
| `prandialState` | `fasted`, `fed`, `unspecified` |
| `coadministrationState` | `monotherapy`, `with_interacting_drug`, `unknown` |
| `pkPopulation` | `healthy_adult`, `patients_unspecified`, `hepatic_impairment`, `renal_impairment`, `metabolizer_phenotype`, `paediatric`, `elderly`, `pregnancy`, `other`, `unknown` |

## Matrices

`serum`, `plasma`, `whole_blood`, `urine`, `vitreous`, `hair`, `other`

## Scenarios

`living_therapeutic`, `living_toxic`, `living_dui`, `postmortem_non_intox`, `postmortem_mono_intox`, `postmortem_poly_intox`, `case_report`, `case_series`

A scenario is the interpretive reading a concentration belongs to, not the
study design. A half-life has no scenario; its study context goes in
`context`.

## Qualifiers

`<`, `>`, `≤`, `≥`

A qualifier marks ONE censored threshold (`< LOQ`), so a qualified
observation carries a single value — never a low..high range.

## Derivation kinds

`reported`, `digitized`, `calculated`, `modeled`, `inferred`

Only `reported` means the number is printed in the source. Anything else
needs `context.derivation.assumptions`.

## Monograph section ids

Use the id, never a translated title. Every drug already has a monograph;
never propose a new page for a drug that exists.

| id | Norwegian | English |
| --- | --- | --- |
| `pd` | Farmakodynamikk | Pharmacodynamics |
| `pk` | Farmakokinetikk | Pharmacokinetics |
| `metabolism` | Biotransformasjon, metabolitter og prodrugs | Biotransformation, metabolites, precursors and prodrugs |
| `medical_use` | Medisinsk bruk | Medical use |
| `non_medical_use` | Ikke-medisinsk bruk og misbruk | Non-medical use, misuse and abuse |
| `effects` | Effekter, bivirkninger og komplikasjoner | Effects, adverse effects and complications |
| `toxicity` | Toksisitet og overdose | Toxicity and overdose |
| `analytical` | Analytisk toksikologi | Analytical toxicology |
| `forensic` | Rettstoksikologisk tolkning | Forensic interpretation |

## Source types

`pmid`, `doi`, `url`

There is no `freetext`: a paper review requires a resolvable citation, and
every committed item depends on one. A textbook with no DOI backs a
`blockedCandidate`, not an item.
