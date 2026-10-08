# Deep-research drug seeding prompt (`kinetix-deep-research-output-v1`)

Give this prompt to a scientific deep-research agent to kick-start a drug's whole
Kinetix knowledge base in one pass. The output is **one JSON object and nothing
else** — `npm run import:research`, or **Admin → Seed drug**, writes it straight
to the database: the drug row, its parameters, the citations backing them,
pharmacodynamic targets, and the metabolism box. See
`docs/deep-research-seeding.md` for the end-to-end workflow.

## How to use this file

On a drug that already has a monograph in Kinetix there is nothing to copy by
hand: the page's **Copy seed prompt** button (admins) puts the block below on the
clipboard with that drug's name already filled in. The rest of this section
describes what that button does, and is what to follow for a drug Kinetix does
not have a page for yet.

The prompt is everything between the two `PROMPT START` / `PROMPT END` markers
below, and it is **self-contained on purpose**: it is written to be pasted into
any capable research chatbot that has never heard of Kinetix. Copy the whole
marked block — the rules, the parameter glossary, the registry tables and the
JSON contract are all part of it and none of them work alone. Fill in the three
bracketed placeholders in the **Input** section before sending; leave everything
else as-is.

Kinetix-internal notes — what the importer does with the JSON, which database
tables it touches, how to keep this file in sync with the registry — live in
[Operator notes](#operator-notes) at the bottom, outside the prompt. Do not paste
those: they describe machinery the research agent cannot see and should not
reason about.

The contract below is authoritative and must match the live schema — it is
validated by `src/lib/deepResearchImport.ts` against the parameter registry
`src/lib/drugParameters.ts`. Anything outside the contract is discarded, so
narrative synthesis, evidence-grade prose and source-appraisal tables are not
requested: every finding has to arrive as a field of the JSON object or it does
not reach the database.

---

<!-- PROMPT START -->

# ▼ ▼ ▼ PROMPT — copy from here ▼ ▼ ▼

## What you are producing

You are a scientific deep-research agent. You are compiling a structured
pharmacology record for **Kinetix**, a drug reference database used by
clinicians, clinical pharmacologists and forensic toxicologists. It covers a
substance across its whole life-cycle in one monograph: physicochemistry,
pharmacokinetics, therapeutic dosing and therapeutic-drug-monitoring ranges,
recreational and overdose exposure, concentrations associated with impairment
and with death, analytical detection limits and detection windows, postmortem
redistribution, receptor pharmacology and metabolism.

Two consequences for how you should work:

- **Forensic and postmortem findings carry the same weight as clinical ones.**
  A postmortem case series is a first-class source here, not an afterthought.
- **Your output is imported verbatim.** It is written into the database as-is
  and appears in the application immediately. There is no editor between you and
  the reader who will re-check your numbers. A value you cannot defend must be
  reported as unestablished (see `not_finalized` below) rather than guessed.

Kinetix is a Norwegian product read by Norwegian clinicians and forensic
toxicologists, so the prose you write goes in **Norwegian Bokmål** — see
"Content language" below before you write a single note. The identity block
asks for both a Norwegian and an English name for the same reason.

## Before you start

- **This task requires live literature and database search.** If you have no
  search capability in this session, say so plainly and stop — do **not**
  produce the JSON object from memory. Fabricated PMIDs and half-remembered
  numbers are worse than no seed at all.
- **Budget the search for two papers per parameter, not one.** Almost every
  parameter here is stored as a pool of per-paper readings, so a parameter is
  not finished when you have a defensible number — it is finished when you have
  that number from **two independent papers**, or have searched for the second
  and established that the literature does not have one. Plan the run that way
  from the outset. A pass that stops at the first usable value for each of ~28
  parameters returns a seed that Kinetix displays as thinly established
  throughout, and the only remedy then is to research the drug again from
  scratch. See "Source values" below for what counts as independent.
- **The output is long** — roughly 28 parameter entries, each carrying the
  individual source readings behind it, plus targets, metabolism and a source
  list. Do not truncate it, do not abbreviate it with `...` or
  "(remaining parameters omitted)", and do not split it across several blocks. If
  you cannot emit the whole object in one response, say so instead of emitting a
  partial one: truncated JSON fails to parse and the entire research run is lost.

## Output format

Return **exactly one fenced `json` block containing a single
`kinetix-deep-research-output-v1` object. Nothing else** — no summary, report,
commentary, table or explanation before, after or around it. Every finding must
be expressed as a field of that object; anything that cannot be is not wanted.

## Content language — the prose goes in Norwegian

Kinetix's interface, monographs and discussion are Norwegian Bokmål, and your
output is imported verbatim: nothing translates it afterwards. **Every free-text
string you write must therefore be Norwegian Bokmål**, or it will sit in English
in the middle of a Norwegian page for as long as the record survives. That is
every prose field in the contract:

- `note` — on a parameter's `value`, on a `not_finalized` entry, on an
  elimination route, on an enzyme interaction
- `comments` — on every reading in `sourceValues[]`
  (but **not** `quote` on the same reading: a quotation stays in the source's
  own language, because translating it destroys what it is for)
- `evidenceNote` — on pharmacodynamic targets and on metabolites
- `profileEvidenceNote` — on the metabolism profile
- `label` — the free-text description of a non-enzyme elimination route
- `targetName` — a pharmacodynamic target Kinetix does not already hold is
  created from this string, and it becomes the target's display name on the
  monograph: `Dopamintransportør`, not `Dopamine transporter`

Everything that is not prose stays exactly as this prompt specifies it, because
it is matched against a machine registry rather than read:

- JSON keys, `schemaVersion`, parameter IDs, `status`, and every enumerated
  value (`kind`, `role`, `activity`, `tier`, `matrix`, `scenario`,
  `citationType`, `interactionType`, `strength`)
- units (`mg/L`, `h`, `nM`), qualifiers and all numbers
- gene, protein and enzyme symbols (`CYP3A4`, `SLC6A3`, `UGT2B7`), metabolite
  names, the Latin binomial in `assaySpecies`, and cell-line identifiers
  (`CHO-K1`, `HEK293`) — but the qualifier around them is prose, so it is
  Norwegian: `Homo sapiens (rekombinant, HEK293)`
- citation metadata — `title`, `authors` and `journalOrSource` stay in the
  source's own language — and `names.en`, which is the English name by
  definition

Write the way a senior pharmacologist writes to a colleague: full Norwegian
sentences, and Norwegian medical terminology where the field has it (fullblod,
halveringstid, biotilgjengelighet, postmortal redistribusjon, mekanistisk
hemming). Where the established term in Norwegian toxicology *is* the English
or Latin one, use it — do not invent a calque to avoid it.

And write Norwegian with its own letters: `æ`, `ø` and `å`, never folded to
`ae`/`oe`/`aa` or `a`/`o`/`a` (`ærlig`, not `aerlig`; `målt`, not `malt`;
`også`, not `ogsaa`). Your output is imported verbatim, so a transliterated
note is what a clinician reads for as long as the row survives — and nothing in
the import path needs it, since the whole chain is UTF-8. The same goes for
scientific symbols (`µ`, `≤`, `–`, `β`): write the character, do not
approximate it.

## Input

- **Drug/substance:** `[DRUG NAME]`

## Coverage — the whole registry

Emit one `kinetixParameterValues[]` entry for **every one of the 28 measured
parameter IDs** in the "Parameter registry" table below, plus `drugIdentity`,
`pharmacodynamicTargets[]`, `metabolism` and `sources[]`. A parameter you could
not establish is `"status": "not_finalized"` with a `note` naming the blocker —
**not** an omission. Silence is indistinguishable from "not searched"; only
`finalized` entries are imported, so a `not_finalized` entry costs nothing and
records that the literature was checked. Narrow this set only if the input above
explicitly asks for a subset.

Coverage has a second dimension: **depth per parameter**. Almost every parameter
here is stored as a pool of per-paper readings, so a finalized parameter should
arrive with `sourceValues[]` from **at least two independent sources** wherever
the literature has two. A parameter backed by one paper is thin evidence, and
Kinetix shows it as such. See "Source values" below.

`status` takes exactly two values: `"finalized"` (you stand behind this value)
and `"not_finalized"` (you could not establish it). Anything else is treated as
not finalized.

On a `not_finalized` entry set `value` to `null` and put the blocker, in
Norwegian, in a **top-level `note`** on the entry (not inside `value`) — the
whole entry is skipped on import and its `value` is never read. See the `logD` entry in the JSON
contract below.

## Evidence rules

- Be conservative and precise. Never give a number without its context — the
  context belongs in that value's `note` (route, population, matrix, assay,
  caveat), which is the only place it survives.
- Never pool incompatible contexts: route, formulation, single vs repeated dose,
  healthy vs patient, plasma vs whole blood vs oral fluid vs urine vs tissue,
  parent vs metabolite, racemate vs enantiomer, therapeutic vs overdose,
  antemortem vs postmortem, femoral vs cardiac.
- Search broadly: primary human PK/PD, population PK, regulatory labels/EPARs/
  FDA reviews, forensic toxicology, IUPHAR/ChEMBL/BindingDB for targets, DDI/
  mass-balance/microsome data for metabolism — across generic/INN/brand/salt/
  enantiomer/metabolite/street names and identifiers (CID, CAS, ATC, DrugBank,
  ChEMBL, IUPHAR).
- **One synthesized value per parameter — but several source values behind it.**
  A parameter carries a single synthesized `value`, so never disguise
  incompatible studies as one artificial min–max range there: give one
  defensible, explicitly contextualized number, or `not_finalized` naming the
  conflict. What each individual paper reported goes in that parameter's
  `sourceValues[]` instead, one entry per reading — **aim for at least two
  independent sources per parameter** (see "Source values" below). Disagreement
  between papers is data here, not a problem to average away before reporting.
- Do not fabricate citations or values, and do not hide uncertainty. Every
  citation you give must be one you actually located; every number must trace to
  a source you actually read or to a database record you actually retrieved.
  Mark anything you cannot defend `not_finalized`.

## Value rules

- `schemaVersion` MUST be `"kinetix-deep-research-output-v1"`.
- Use **only** the exact parameter IDs and canonical units in the registry table.
  Never invent a parameter ID. `cmax` is not a Kinetix parameter — do not emit
  it.
- Numeric values use the shape
  `{ "min", "max", "mean", "median", "unit", "qualifier", "note" }`, with only
  the fields the evidence supports. There is no `value` field. Use `median` for a
  single representative scalar; `mean` only when a source reports or justifies an
  arithmetic mean.
- Keep every number inside the parameter's **allowed range** (last column of the
  table). An out-of-range value fails validation and is dropped with a warning —
  if the literature genuinely reports one, use `not_finalized`.
- **Dimensionless parameters (`pKa`, `logP`, `logD`) MUST omit `unit`
  entirely** — not `"unitless"`, not `""`.
- **Ionization: prefer the structured `ionizationConstants[]` block** (see its
  own section below) over the scalar `pKa` parameter. The scalar `pKa` is kept
  only for backwards compatibility and cannot express a polyprotic or amphoteric
  molecule, nor which charge transition a value belongs to. Emit `pKa` in
  `kinetixParameterValues[]` only when you have a single value and no charge
  information at all.
- `qualifier` is ONLY a comparison operator (`<`, `>`, `≤`, `≥`) for one-sided
  bounds. Route/population/matrix/assay/caveat text goes in `note`, never here.
- Convert percentages to fractions for `bioavailability` and `proteinBinding`:
  62 % → `0.62`.
- `halfLife`, `volumeOfDistribution`, `bioavailability` and `proteinBinding`
  **require both `min` and `max`.** With only one robust value, set both to the
  same number and say why in `note`.
- Every finalized parameter with evidence lists the `sourceIds` backing it, and
  every id in a `sourceIds` MUST resolve to an entry in `sources[]`.
- For interpretive concentrations, state the biological matrix **and** the
  scenario in `note`. Analyte stability is matrix-specific and is not a valid
  cross-matrix aggregate — one matrix per value, named in `note`, or
  `not_finalized`.
- **Do not report LOQ or LOD.** They are not parameters here: a limit of
  quantification or detection belongs to a validated method in a particular
  laboratory, not to the substance, and Kinetix carries the real figures per
  analyte per analytical method instead. An importer warning is all a `loq` or
  `lod` entry earns.
- Receptor/target data goes in `pharmacodynamicTargets[]`, never in
  `kinetixParameterValues[]`; metabolism goes in `metabolism`.
- Return valid JSON. `null`/`[]` for unknowns, no placeholder examples, and no
  keys beyond the contract — extra keys are discarded on import.

### Ionization constants — go in `ionizationConstants[]`

Identify **all** experimentally established macroscopic pKa values relevant to
aqueous ionization. For each value, identify the corresponding net molecular
charge transition. Do **not** infer a microscopic ionization site unless the
source establishes it. Prefer experimental measurements; calculated values MUST
be marked `"evidenceType": "predicted"`.

Each entry is one acid-dissociation equilibrium:

| Field                | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `pKa`                | The pKa of this equilibrium (−10 – 20).                                                      |
| `protonatedCharge`   | Net molecular charge **before** deprotonation.                                              |
| `deprotonatedCharge` | Net molecular charge **after** deprotonation. Always `protonatedCharge − 1`.                |
| `evidenceType`       | `"experimental"` or `"predicted"`. Omitting it records the value as `predicted`.            |
| `type`               | Optional: `"macroscopic"` (default) or `"microscopic"` (only where a source establishes it). |
| `siteLabel`          | Optional free-text description of the ionizable group/site.                                  |
| `temperatureC`, `medium` | Optional measurement conditions.                                                        |
| `note`               | Optional Norwegian free-text caveat that is not the site, medium or temperature (e.g. "verdi for fri base"). |
| `sourceIds`          | The `sources[]` handles backing this constant. Multiple readings of the **same** transition aggregate here; different transitions stay separate entries. |

The charge transition is the primary representation. A base is `+1 → 0`
(BH⁺ ⇌ B); an acid is `0 → -1` (HA ⇌ A⁻). Examples: a monoprotic base is one
`+1 → 0` entry; an amphoteric compound is a `+1 → 0` entry **and** a `0 → -1`
entry; a diprotic base is `+2 → +1` **and** `+1 → 0`. iPMR reads only the
`+1 → 0` pKa for its basicity term, and a measured `logD` stays independent —
Kinetix can derive `logD` from `logP` + this profile when no measured `logD`
exists.

## What the less obvious parameters mean

Most IDs below are standard pharmacology. These carry a specific meaning in this
record, so do not reinterpret them:

- **`therapeuticDose`** — the usual therapeutic dose range in approved use.
  **`maxRecommendedDose`** — the labelled ceiling (per dose or per day; say which
  in `note` and pick the matching unit). **`nonMedicalDose`** — typical
  non-medical/recreational dose. **`overdoseDose`** — doses reported to cause
  significant toxicity. **`fatalDose`** — doses reported in fatalities.
- **`therapeuticConcentration`** — concentrations expected on therapeutic dosing
  (the TDM range where one exists). **`supratherapeuticConcentration`** — above
  that range but below overt toxicity. **`toxicConcentration`** — associated with
  clinical toxicity. **`impairmentConcentration`** — associated with
  psychomotor/driving impairment. **`fatalConcentration`** — reported in fatal
  cases. These bands overlap in the literature and are rarely crisply
  demarcated; give the range a source actually reports and state in `note` what
  the source based it on, rather than inventing cut-offs between the bands.
- **`bloodDetectionWindow` / `oralFluidDetectionWindow` / `urineDetectionWindow`**
  — time from administration during which the analyte remains detectable, in
  hours. One parameter per matrix: file a blood window under blood and an
  oral-fluid window under oral fluid, never a combined figure under both. State
  the dose, route and the assay cut-off it depends on in `note`, since the window
  is meaningless without them.
- **`analyteStability`** — the analyte's degradation half-life in a stored
  specimen, in hours. State the matrix, storage temperature, preservative
  (e.g. sodium fluoride) and the degradation endpoint the source used in `note`.
- **`bloodPlasmaRatio`** — whole-blood to plasma concentration ratio (B/P).
- **`postmortemRedistribution` / `pmAmRatio`** — two different quantities;
  see the section below the tables.

## Parameter registry (exact IDs + canonical units)

This is the **complete** set of drug parameters Kinetix stores — 34 IDs. Emit
values already converted to the canonical unit where one exists.

### Identity & metadata — goes in `drugIdentity`, not `kinetixParameterValues[]`

The first column is the internal parameter name; the second is the **JSON key you
actually emit** (see the contract below — the two names differ for the language
names).

| Parameter ID      | JSON field in `drugIdentity`      | Kind           | Constraint                                    |
| ----------------- | --------------------------------- | -------------- | --------------------------------------------- |
| `nameNb`          | `names.nb`                        | text           | ≤ 300 chars (Norwegian Bokmål name)           |
| `nameEn`          | `names.en` (or `preferredName`)   | text           | ≤ 300 chars (English name)                    |
| `nameShort`       | `nameShort`                       | text           | ≤ 50 chars                                    |
| `aliases`         | `aliases`                         | list of text   | ≤ 50 entries, ≤ 200 chars each                |
| `pubchemCid`      | `pubchemCid`                      | integer        | 1 – 999 999 999                               |
| `molecularWeight` | `molecularWeight`                 | number (g/mol) | 0.0001 – 100 000; bare number, no unit string |

At least one of `names.nb`, `names.en` or `preferredName` is required. Set
`names.nb` only to a Norwegian name you can source (INN names are usually
identical or near-identical across the two languages) — leave it `null` rather
than machine-translating.

### The 28 measured parameters — go in `kinetixParameterValues[]`

The "Sidebar group" column is only how the application groups these on screen;
it has no effect on what you emit.

| Sidebar group         | Parameter ID                                                                                                 | Value kind | Canonical `unit` (accepted units)                                                     | Allowed range |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------- | ------------- |
| chemistry             | `pKa`                                                                                                        | scalar     | **omit unit** (dimensionless)                                                         | −10 – 20      |
| chemistry             | `logP`                                                                                                       | scalar     | **omit unit** (dimensionless)                                                         | −10 – 15      |
| chemistry             | `logD`                                                                                                       | scalar     | **omit unit** (dimensionless, pH 7.4)                                                 | −10 – 15      |
| pharmacokinetics      | `halfLife` (needs min & max)                                                                                 | range      | `h`                                                                                   | 0 – 10 000    |
| pharmacokinetics      | `tmax`                                                                                                       | range      | `h`                                                                                   | 0 – 240       |
| pharmacokinetics      | `volumeOfDistribution` (needs min & max)                                                                     | range      | `L/kg`                                                                                | 0.01 – 1 000  |
| pharmacokinetics      | `bioavailability` (needs min & max)                                                                          | fraction   | `fraction`                                                                            | 0 – 1         |
| pharmacokinetics      | `proteinBinding` (needs min & max)                                                                           | fraction   | `fraction`                                                                            | 0 – 1         |
| pharmacokinetics      | `bloodPlasmaRatio`                                                                                           | ratio      | `ratio`                                                                               | 0 – 100       |
| pharmacokinetics      | `clearance`                                                                                                  | range ³    | `L/h` (also `L/min`, `mL/min`, `L/h/kg`, `mL/min/kg`)                                 | 0 – 100 000   |
| pharmacokinetics      | `vmax` (saturable elimination only)                                                                          | range ⁴    | `mg/L/h` (also `µg/mL/h`, `mg/dL/h`, `g/L/h`, `mg/L/min`)                             | 0.0001 – 100 000 |
| pharmacokinetics      | `km` (saturable elimination only)                                                                            | range ⁴    | `mg/L` (also `µg/mL`, `ng/mL`, `µg/L`, `ng/L`, `mg/dL`, `mmol/L`, `µmol/L`, `nmol/L`) | 0.000001 – 1 000 000 |
| dose & exposure       | `therapeuticDose`, `maxRecommendedDose`, `nonMedicalDose`, `overdoseDose`, `fatalDose`                       | range ³    | `mg` (also `g`, `µg`, `mg/kg`, `mg/day`, `mg/kg/day`)                                 | 0 – 1 000 000 |
| interpretive conc.    | `therapeuticConcentration`, `supratherapeuticConcentration`, `impairmentConcentration`, `toxicConcentration` | range ¹    | `mg/L` (also `µg/mL`, `ng/mL`, `µg/L`, `ng/L`, `mg/dL`, `mmol/L`, `µmol/L`, `nmol/L`) | 0 – 1 000 000 |
| analytics & detection | `bloodDetectionWindow`, `oralFluidDetectionWindow`, `urineDetectionWindow`                                    | range      | `h`                                                                                   | 0 – 8 760     |
| analytics & detection | `analyteStability`                                                                                           | range ²    | `h`                                                                                   | 0 – 87 600    |
| postmortem            | `fatalConcentration`                                                                                         | range ¹    | `mg/L` (concentration family, as above)                                               | 0 – 1 000 000 |
| postmortem            | `postmortemRedistribution` (C/P)                                                                             | ratio      | `ratio`                                                                               | 0 – 100       |
| postmortem            | `pmAmRatio` (PM/AM)                                                                                          | ratio      | `ratio`                                                                               | 0 – 1 000     |

¹ Matrix- **and** scenario-relevant: the value means nothing without the sampled
matrix (serum / plasma / whole blood / oral fluid / urine / tissue) and the
interpretive scenario (living therapeutic, postmortem mono-intoxication, …).
State both in `note`. `fatalConcentration` sits in the **postmortem** group, not
with the interpretive concentrations.

² Matrix-specific and **not** aggregatable across matrices — degradation in
urine and in whole blood are different quantities with no blood:plasma
conversion between them. One matrix per value, named in `note`, or
`not_finalized`.

⁴ Matrix-relevant, not scenario-relevant: Vmax and Km are concentrations, so
the value means nothing without the matrix it was measured in. Name the matrix
(serum / plasma / whole blood) in `note`; Kinetix models only plasma and serum
values, and never converts a whole-blood figure into them.

³ The weight-normalized units (`L/h/kg`, `mL/min/kg`, `mg/kg`, `mg/kg/day`) are
a **separate family from their absolute counterpart** — Kinetix never
rescales one into the other, because doing so needs a body weight no entry
carries. Convert to the absolute unit yourself, from a genuine **per-subject
pairing** (one subject's own per-kg value and that same subject's own
reported weight), **only for a systemic clearance reported per kg** — a
single multiplication by weight in **kilograms**, and a real reconstruction
of that subject's own absolute clearance. **Never convert `CL/F`** (apparent,
oral-route clearance divided by an unknown bioavailability): multiplying by
weight cancels the `/kg` but not the `/F`, so the result is still an apparent
clearance, not the systemic `L/h`/`mL/min` it would be pooled as, and the two
can differ by a factor of bioavailability. Convert only when the source
states or the design implies genuine systemic clearance (an IV arm, or `CL/F`
already corrected for a known `F`); leave a `CL/F` reported per kg in its
per-kg unit, unconverted, same as any other unconvertible reading. **Convert
the weight to kg first if the source reports it in pounds or grams** (a
US-cohort or neonatal study routinely does) — multiplying by the raw number
off by a factor of 2.205 or 1000 is worse than not converting at all — and
name that unit conversion alongside the clearance derivation. **Never convert
a
dose reported in `mg/kg` or `mg/kg/day`.** `mg/kg/day` cannot reach the
canonical `mg` by weight alone — that only gets to `mg/day`, itself outside
the convertible family. `mg/kg` reaches `mg` arithmetically, but the number
it reports is almost always a prescribed **regimen** (a pediatric dose, an
induction dose), not a measured absolute quantity — multiplying it by one
subject's weight produces a mass that encodes that subject's body size, not
the drug's dose, and pooling it into `therapeuticDose`/`maxRecommendedDose`/
etc. as though it were a general absolute dose skews the aggregate. Submit
both as reported; they stay out of the aggregate, as documented. Name the
weight and the derivation in `note` for a finalized value or `comments` for a
`sourceValues[]` reading (the finalized value has no `comments` field — see
"Value rules" and "Field rules for each object" below). Do **not** multiply a
cohort-level summary (a mean or median per-kg value) by a mean/median sample
weight: the product of means is not the mean of products, and a range cannot
be reconstructed that way at all — that arithmetic manufactures an absolute
value the paper never reported. Submit the bare per-kg unit in every other
case, including whenever you lack a genuine per-subject pairing.

A derived value has no sentence stating it, so it needs its own `quote`: give
the source's own words for **both** operands — the subject's per-kg value and
the subject's weight — never a restatement of the computed number, which the
source never wrote. When more than one subject in the same reading is paired
this way, that is still **one reading**, not one per subject — the importer
weights a reading by citation, and a reading per subject would let one paper
outweigh every other source on the parameter. Derive every paired subject's
absolute value, then report the reading the normal way: `median` (and
`low`/`high` if the source gives a spread) across those computed values, `n`
set to the count actually paired. `comments` (2000 characters) and `note`
(**500** — `value.note` is far shorter than a `sourceValues[]` reading's
`comments`, and `normalizeParameterValue` silently truncates an over-length
one mid-pair rather than rejecting it) both have limits a large arm's
per-subject pairs can exceed: list every pair only while it comfortably fits
the field you're writing to, and past that name the calculation method and a
locator instead — in Norwegian, since a stored `note`/`comments` is rendered
verbatim (e.g. "beregnet fra hver av n=24 forsøkspersoners egen vekt og
kg-normerte clearance, tabell 2") — rather than transcribing every value and
having the
entry rejected or, for the deep-research importer, silently dropped for
exceeding the limit. `quote` has no such fallback: it has its own
1000-character limit and must stay **verbatim** source words, so a locator is
not evidence there. This importer writes `sourceValues[]` straight to
`parameter_entries` and recomputes the published aggregate — there is no
pending-edit queue behind it, so an absent `quote` here does not hold the
reading for a human the way it would on a contributor-submitted row. When the
operands for every paired subject do not fit verbatim within `quote`'s limit,
**do not emit that reading at all**: a `sourceValues[]` reading is optional,
and one you cannot evidence within the field's limits is one to drop, not
publish anyway. If dropping it leaves only one other, properly quoted reading,
keep the parameter `finalized` on that single reading per the thin-source
policy above — do not `not_finalized` a parameter that still has honest
evidence just because a second, unquotable reading had to be dropped; that
would discard the valid reading along with the one you rightly excluded. Only
`not_finalized` the parameter if dropping it leaves none at all. Never submit
just one paired subject's value as though it stood for the whole reading.

A value with a unit outside its family, a `unit` on a dimensionless scalar, or a
number outside the allowed range is dropped by the importer with a warning.

### Source values — what each paper reported (`sourceValues[]`)

The `value` above is your *synthesis*: one number for the parameter. Kinetix
does not store a parameter that way. Every parameter in the table except
`analyteStability` is **source-value backed**: the displayed range is
recomputed from one row per paper (a weighted median with an inter-quartile
range, normalized to whole blood where that applies), and those rows are what
the forest plot, the per-source list and the "how well established is this"
signal are drawn from. A parameter with a synthesized value and no source values
has none of that — and the first source value anyone adds later replaces your
synthesis with an aggregate of that single row.

So for each of those parameters, also report **what each source actually said**,
from **two or more independent sources wherever the literature supports it**:

```json
"sourceValues": [
  {
    "sourceId": "S1",
    "low": 0.7,
    "high": 1.3,
    "centralValue": 1.0,
    "centralStatistic": "arithmetic_mean",
    "intervalKind": "range",
    "unit": "h",
    "n": 12,
    "comments": "Friske voksne, én intravenøs enkeltdose, plasma.",
    "quote": "The mean terminal half-life was 1.0 h (range 0.7–1.3) in healthy adults."
  },
  {
    "sourceId": "S2",
    "centralValue": 1.6,
    "centralStatistic": "median",
    "unit": "h",
    "n": 24,
    "comments": "Kroniske brukere, intranasal tilførsel, fullblod.",
    "quote": "Median Tmax after intranasal administration was 1.6 h in chronic users."
  }
]
```

**Say what each number is.** `centralValue` is the centre the source reports
and `centralStatistic` names it: `arithmetic_mean`, `geometric_mean`,
`median`, `single_subject`, or `unknown` when the source does not say. A mean
never goes in `median` — "0.54 (0.12) h, mean (SD)" is `centralValue: 0.54`,
`centralStatistic: "arithmetic_mean"`, not a median. `intervalKind` says what
`low`/`high` are: `sd`, `sem`, `ci95`, `iqr`, `range` or `unknown`; it is
required whenever bounds sit beside a `centralValue`. For `sd`
and `sem` the bounds are the centre minus and plus the dispersion, symmetric
around `centralValue` ("0.54 ± 0.12" is `low: 0.42, high: 0.66`). A range with
no reported centre is `low`/`high` + `intervalKind: "range"` and no
`centralValue`. A censored threshold (`< 5`) stays `qualifier` + the single
value in `low`/`high`/`median`, with no statistic.

`quote` is the verbatim text that reading was taken from — the sentence, table
cell or figure caption, in the **source's own language**, not translated. It is
the one exception to the Norwegian rule above, because translating a quotation
destroys what it is for.

Quote the text that states the value for the condition the row claims it for.
Citing the right paper is not the same as reading the right number out of it: a
value carried over from a neighbouring arm, dose or fed/fasted state looks
perfectly well-sourced and is wrong, and that is the error class this field
exists to make visible. If no sentence in the paper says what the row says,
report what the paper does say.

**Two independent sources is the target, per parameter.** One reading pools into
an aggregate of itself: no spread, no inter-quartile range, no agreement between
groups to show, and the parameter is displayed as thinly established. Two
readings from different investigators are worth more here than one carefully
chosen "best" number, so keep searching for a corroborating paper on every
parameter rather than stopping at the first usable one. Specifically:

- **Independent means different papers.** Two readings from the same study are
  one source, not two: the parameter still counts as single-sourced. Nor does a
  review that merely quotes the paper you already cited count as a second — that
  is the same measurement twice, and pooling it would double-count it.
- **Never manufacture the second source.** Do not split one paper's range into
  two objects, do not cite a paper you did not locate, and do not attach a
  loosely related number to make a parameter look better supported. A single
  honest reading is fine — the requirement is that you searched for a second,
  not that one exists.
- **"Only one source exists" is a search result, not a default.** You reach it
  by searching for the second reading and not finding one — never by stopping at
  the first. When that is genuinely where you land, say so in that reading's
  `comments` (f.eks. "Eneste humane PK-studien som ble funnet; ingen uavhengig
  replikasjon."),
  so the thin backing reads as a fact about the literature rather than a gap in
  the search. Be suspicious of landing there on a physicochemical constant
  (`pKa`, `logP`), a `halfLife`, a `tmax` or a `clearance`: those are reported
  by more than one paper for almost any substance that has been studied at all,
  so a single reading on one of them usually means the search stopped early.
  Search again under the substance's other names, salts, enantiomers and
  identifiers before accepting it.
- The exception is `analyteStability`: it takes no source values at all, being
  matrix-specific rather than poolable.

Field rules for each object:

- **One object per reading**, not per paper: a study reporting separate values
  for two populations gives two objects, both with the same `sourceId`.
- **`sourceId`** must appear in `sources[]`. A reading without a resolvable
  source is dropped — every entry is citation-gated by design.
- **At least one** of `low`, `high`, `centralValue`. Put a reported centre in
  `centralValue` with `centralStatistic` saying what it is — a mean is
  `arithmetic_mean`, never folded into `median` — and `low`/`high` for a
  reported range or dispersion, with `intervalKind` saying which. The centre
  must lie inside `low`..`high`. Send `median` only as shorthand for a reported
  median, and never alongside `centralValue`. A censored threshold (`< 5`) is
  the exception: `qualifier` plus the single value in `low`/`high`/`median`,
  with no statistic.
- **`unit`** as reported — any accepted unit for that parameter (the table's
  "accepted units"). Do **not** convert between units in the same family (e.g.
  `mL/min` → `L/h`); Kinetix normalizes those. Clearance's `L/h/kg`/
  `mL/min/kg` are a narrow exception — see footnote ³ on the parameter table:
  convert to the absolute unit yourself only from a genuine per-subject
  pairing (one subject's own weight and own per-kg value), never by
  multiplying cohort-level summary statistics. A dose in `mg/kg` or
  `mg/kg/day` is never converted this way — see footnote ³. Omit the unit
  entirely (`""`) for the dimensionless scalars `pKa`,
  `logP`, `logD`.
- **`qualifier`** (`<`, `>`, `≤`, `≥`) for a censored threshold ("< 0.05 mg/L").
  A censored reading carries one value, not a range.
- **`matrix`** and **`scenario`** are required for the five interpretive /
  postmortem concentrations (`therapeuticConcentration`,
  `supratherapeuticConcentration`, `impairmentConcentration`,
  `toxicConcentration`, `fatalConcentration`) and must be **absent** on every
  other parameter. `matrix` is one of `serum`, `plasma`, `whole_blood`, `urine`,
  `vitreous`, `hair`, `other`; `scenario` is one of `living_therapeutic`,
  `living_toxic`, `living_dui`, `postmortem_non_intox`, `postmortem_mono_intox`,
  `postmortem_poly_intox`, `case_report`, `case_series` — a half-life has no matrix and no interpretive scenario; its
  study context belongs in `comments`.
- **`n`** — the sample size behind the reading, when stated. It weights the pool.
- **`comments`** — the study context in one line, in Norwegian: population,
  route, matrix, assay, anything that explains why this paper's number differs
  from another's.
- Report only readings you actually read. If your only access is a review's
  summary of an older study, the reading belongs to the **review** — cite it as
  the source rather than attributing a number to a paper you have not read.

Keep the synthesized `value` as well: it is what the monograph shows until the
recompute runs, and the fallback for a parameter whose readings turn out not to
be poolable. Do not tune it to match the aggregate — report both faithfully and
let them disagree if they disagree.

### The thin-parameter sweep — do this before you emit

When the object is otherwise complete, go back over it before you emit it: list
every `finalized` parameter whose `sourceValues[]` carries readings from **fewer
than two distinct papers** — one reading, or none at all sitting behind a
synthesized `value` — and run a further targeted search for a corroborating
paper on each. Only `analyteStability` is exempt, because it takes no source
values at all; every other parameter is in scope.

This sweep is part of the task, not optional polish. It is the step that
separates "the literature has one reading" from "I stopped after the first hit",
and only the first of those is a defensible seed — from the outside the two are
indistinguishable, which is why the distinction has to be made here, by you.

Finish each one by adding the readings you found. Where a parameter genuinely
rests on one paper, leave the single reading and record in its `comments` that
you searched and the literature has no independent replication. A finalized
`value` with **no** readings under it is never where to stop: you synthesized it
from something, and that something is what Kinetix pools — report it as a
reading even when it is the only one.

### C/P vs PM/AM — two different postmortem quantities, never pooled

- `postmortemRedistribution` (**C/P**) is a _within-body gradient_: two sites
  sampled after death at the same time (cardiac vs femoral blood).
- `pmAmRatio` (**PM/AM**) is a _paired-specimen ratio across death_: an
  antemortem clinical specimen against postmortem femoral blood from the same
  decedent. Only the postmortem member is defined (femoral whole blood at
  mortuary admission); the antemortem member is whatever routine hospital draw
  exists, so specimen-site and matrix differences are embedded in the ratio
  alongside the postmortem change — do not present it as isolating the latter.
  Individual-case ratios run into the hundreds, hence the wider bound. A PM/AM
  ratio is a population-level descriptor and must **never** be offered as a
  factor for back-calculating an antemortem concentration from a postmortem one;
  say so in `note`, along with the study context (drug class, time from
  antemortem sampling to death and from death to postmortem sampling, _n_).

Both are **matrix-independent dimensionless ratios, not concentrations**: their
`sourceValues[]` readings take **no `matrix` and no `scenario`** — those two
fields belong only to the five interpretive/postmortem *concentrations* listed
above, and a C/P or PM/AM reading that sets either is dropped by the importer
with a warning. The specimen context that the ratio is built from — that C/P
compares cardiac against femoral whole blood, that PM/AM's postmortem member is
femoral whole blood — is not a poolable dimension of this number, so it does not
go in a column; record it in the reading's `comments` (and the study-level
caveats in `note`).

Report each under its own ID. If the only evidence is a mixed "postmortem
redistribution" figure that does not say which of the two designs it came from,
mark both `not_finalized` rather than guessing.

## JSON contract

```json
{
  "schemaVersion": "kinetix-deep-research-output-v1",
  "drugIdentity": {
    "preferredName": "Cocaine",
    "names": { "en": "Cocaine", "nb": "Kokain" },
    "nameShort": null,
    "aliases": ["benzoylmethylecgonine", "coke"],
    "pubchemCid": 446220,
    "molecularWeight": 303.35
  },
  "kinetixParameterValues": [
    {
      "parameter": "halfLife",
      "status": "finalized",
      "value": {
        "min": 0.7,
        "max": 1.7,
        "median": 1.2,
        "unit": "h",
        "note": "Akutt enkeltdose hos voksne; plasma/fullblod; intravenøst, intranasalt og peroralt."
      },
      "sourceIds": ["S1", "S2"],
      "sourceValues": [
        {
          "sourceId": "S1",
          "low": 0.7,
          "high": 1.3,
          "median": 1.0,
          "unit": "h",
          "n": 12,
          "comments": "Friske voksne, én intravenøs enkeltdose, plasma."
        },
        {
          "sourceId": "S2",
          "median": 1.6,
          "unit": "h",
          "comments": "Kroniske brukere, intranasal tilførsel, fullblod."
        }
      ]
    },
    {
      "parameter": "therapeuticConcentration",
      "status": "finalized",
      "value": {
        "min": 0.05,
        "max": 0.3,
        "unit": "mg/L",
        "note": "Levende personer, fullblod, terapeutisk bruk som lokalanestetikum."
      },
      "sourceIds": ["S2", "S4"],
      "sourceValues": [
        {
          "sourceId": "S2",
          "low": 0.05,
          "high": 0.3,
          "unit": "mg/L",
          "matrix": "whole_blood",
          "scenario": "living_therapeutic",
          "comments": "Lokalanestesi, levende personer."
        },
        {
          "sourceId": "S4",
          "median": 0.15,
          "unit": "mg/L",
          "matrix": "plasma",
          "scenario": "living_therapeutic",
          "comments": "Terapeutisk område fra oppslagsverk, plasma, intranasal lokal bruk."
        }
      ]
    },
    {
      "parameter": "pKa",
      "status": "finalized",
      "value": {
        "median": 8.6,
        "note": "Svak base — enhet utelatt (dimensjonsløs)."
      },
      "sourceIds": ["S3", "S4"],
      "sourceValues": [
        {
          "sourceId": "S3",
          "median": 8.7,
          "unit": "",
          "comments": "Oppføring i stoffdatabase; enhet utelatt (dimensjonsløs)."
        },
        {
          "sourceId": "S4",
          "median": 8.6,
          "unit": "",
          "comments": "Verdi for fri base fra oppslagsverk."
        }
      ]
    },
    {
      "parameter": "logD",
      "status": "not_finalized",
      "value": null,
      "note": "Fant ingen målt logD 7,4; bare beregnede verdier som spriker mer enn én logenhet.",
      "sourceIds": []
    }
  ],
  "ionizationConstants": [
    {
      "pKa": 8.6,
      "protonatedCharge": 1,
      "deprotonatedCharge": 0,
      "evidenceType": "experimental",
      "sourceIds": ["S3", "S4"]
    }
  ],
  "pharmacodynamicTargets": [
    {
      "targetSymbol": "SLC6A3",
      "targetName": "Dopamintransportør",
      "interactionType": "inhibitor",
      "tier": "primary",
      "ki": { "median": 0.64, "unit": "µM" },
      "ic50": null,
      "ec50": null,
      "emax": null,
      "affinity": null,
      "potency": null,
      "efficacy": null,
      "selectivityRatio": null,
      "assaySpecies": "Homo sapiens (rekombinant, HEK293)",
      "sourceIds": ["S1"],
      "evidenceNote": "Radioligandbinding til rekombinant DAT. Blokkering av dopaminreopptak er hovedmekanismen."
    }
  ],
  "metabolism": {
    "profileEvidenceNote": "Hydrolyseres raskt av karboksylesteraser til benzoylecgonin og ecgoninmetylester.",
    "profileSourceIds": ["S1"],
    "eliminationRoutes": [
      {
        "kind": "enzyme",
        "enzymeOrEntitySymbol": "CES1",
        "label": "Carboxylesterase 1",
        "fraction": 0.4,
        "fractionMin": null,
        "fractionMax": null,
        "note": null,
        "sourceIds": ["S1"]
      },
      {
        "kind": "renal_unchanged",
        "label": "Glomerulær filtrasjon av uendret morstoff",
        "fraction": 0.05,
        "sourceIds": []
      }
    ],
    "metabolites": [
      {
        "metaboliteName": "Benzoylecgonine",
        "activity": "inactive",
        "conversionFraction": 0.35,
        "conversionFractionMin": null,
        "conversionFractionMax": null,
        "evidenceNote": null,
        "sourceIds": ["S1"]
      }
    ],
    "enzymeInteractions": [
      {
        "enzymeOrEntitySymbol": "CYP3A4",
        "role": "substrate",
        "strength": "moderate",
        "note": "N-demetylering til norkokain.",
        "sourceIds": ["S1"]
      }
    ]
  },
  "sources": [
    {
      "sourceId": "S1",
      "citationType": "pmid",
      "identifier": "29462364",
      "pmid": "29462364",
      "doi": "10.1093/jat/bky007",
      "url": null,
      "title": "Bioavailability and Pharmacokinetics of Oral Cocaine in Humans",
      "authors": ["Coe MA", "Jufer Phipps RA", "Cone EJ", "Walsh SL"],
      "journalOrSource": "J Anal Toxicol",
      "year": 2018
    },
    {
      "sourceId": "S2",
      "citationType": "pmid",
      "identifier": "31150569",
      "pmid": "31150569",
      "doi": "10.1002/dta.2657",
      "title": "Detection of cocaine and its metabolites in whole blood and plasma following a single dose, controlled administration of intranasal cocaine",
      "authors": ["Menzies EL", "Archer JRH", "Dargan PI"],
      "journalOrSource": "Drug Test Anal",
      "year": 2019
    },
    {
      "sourceId": "S3",
      "citationType": "url",
      "identifier": "https://pubchem.ncbi.nlm.nih.gov/compound/446220",
      "url": "https://pubchem.ncbi.nlm.nih.gov/compound/446220",
      "title": "PubChem Compound Summary — Cocaine (CID 446220)"
    },
    {
      "sourceId": "S4",
      "citationType": "freetext",
      "identifier": "Baselt RC. Disposition of Toxic Drugs and Chemicals in Man. 12th ed. Seal Beach, CA: Biomedical Publications; 2020.",
      "title": "Disposition of Toxic Drugs and Chemicals in Man, 12th ed.",
      "authors": ["Baselt RC"],
      "year": 2020
    }
  ]
}
```

### Field reference

- **`drugIdentity`** — see the identity table above. `pubchemCid` is what
  identifies the substance, so supply it whenever you can confirm it.
- **`kinetixParameterValues[]`** — `parameter` (an exact ID from the registry
  table) + `status` + `value` (the numeric shape above, or `null` when not
  finalized) + `sourceIds` + `sourceValues[]` (see "Source values" above —
  two or more independent sources per parameter wherever the literature has
  them). Keep the `not_finalized` entries: they are what records that a
  parameter was searched and found unestablished.
- **`ionizationConstants[]`** — one entry per acid-dissociation equilibrium, each
  with `pKa`, the `protonatedCharge` → `deprotonatedCharge` transition (adjacent
  integers), `evidenceType`, and `sourceIds`. See the "Ionization constants"
  section above. Different transitions are separate entries and are never pooled;
  multiple readings of the same transition share one entry's `sourceIds`.
- **`pharmacodynamicTargets[]`** — one entry per receptor, transporter, enzyme or
  other molecular target.
  - `targetSymbol` — the official gene/protein symbol (`SLC6A3`, `HTR2A`,
    `CHRNA4`), left exactly as the nomenclature has it. Give `targetName` too —
    the Norwegian name (`Dopamintransportør`), since it is what the monograph
    displays for a target Kinetix has to create. One of the two is required,
    but **give the symbol whenever the target has one**: the symbol is what
    identifies the entity in the catalog, and a target supplied by name alone
    is filed under that name instead.
  - `interactionType` — free text, ≤ 60 characters, using the standard
    pharmacological vocabulary: `agonist`, `partial_agonist`, `inverse_agonist`,
    `antagonist`, `inhibitor`, `substrate`, `positive_allosteric_modulator`,
    `negative_allosteric_modulator`, `reuptake_inhibitor`, `releaser`. Use
    `unspecified` when the source does not say.
  - `tier` — one of `primary`, `secondary`, `tertiary`, or `null`. `primary` is
    the target that accounts for the main clinical effect.
  - `ki`, `ic50`, `ec50`, `emax`, `affinity`, `potency`, `efficacy`,
    `selectivityRatio` — the numeric shape `{min, max, mean, median, unit}`;
    omit or `null` when unknown. Report the unit the source uses (`nM`, `µM`,
    `%`) — these fields are not unit-converted or range-checked, so an unclear
    unit silently becomes a wrong number. For `affinity`, state in `evidenceNote`
    whether it is pKi/pKd, since the convention varies.
  - `assaySpecies` — the species the measurement was made in, ≤ 80 characters:
    `Homo sapiens`, `Rattus norvegicus`, `Homo sapiens (rekombinant, CHO-K1)`.
    Name the expression system in parentheses when the preparation is
    recombinant — the binomial and the cell line are identifiers and stay as
    they are, the qualifier around them is Norwegian. **This is a species claim, so leave it out (or `null`) when the
    source does not state one** — an absent value reads as "unstated", while a
    wrong one makes animal data look human. Human data is preferred; a non-human
    value is still worth reporting, it just carries lower transferability.
    Kinetix stores this on the measurement, not on the target: the target entity
    is the human protein either way.
  - `evidenceNote` — the remaining context, in Norwegian: assay type,
    tissue/cell system, and anything that qualifies the number. For `affinity`,
    say whether it is pKi or pKd here.
- **`metabolism`**
  - `eliminationRoutes[].kind` ∈ `enzyme`, `metabolized`, `renal_unchanged`,
    `fecal_biliary`, `other_unchanged`. For `enzyme` routes,
    `enzymeOrEntitySymbol` is the enzyme symbol (`CYP3A4`, `UGT2B7`, `CES1`) and
    stays a symbol; otherwise `label` is free text and goes in Norwegian, since
    it is what the reader sees next to the route. `fraction`, `fractionMin` and `fractionMax`
    are 0–1 fractions of the administered dose, not percentages.
  - `metabolites[].activity` ∈ `active`, `inactive`, `unknown`;
    `conversionFraction`, `conversionFractionMin` and `conversionFractionMax` are
    0–1 fractions of the parent dose converted to that metabolite.
  - `enzymeInteractions[]` describes what the drug does to (or with) an enzyme,
    as opposed to how it is cleared. `role` ∈ `substrate`, `inducer`,
    `inhibitor` (required — an entry without one is dropped); `strength` ∈
    `weak`, `moderate`, `strong`, or `null`.
- **`sources[]`** — `sourceId` is the local handle (`S1`, `S2`, …) used by every
  `sourceIds` reference in the document; it does not leave this JSON.
  `citationType` ∈ `pmid`, `doi`, `url`, `freetext`, with `identifier` holding
  the matching value. A PMID is digits only; a DOI starts `10.`.
  - **Declare the strongest handle you have.** The order is PMID > DOI > URL >
    free-text: with a PMID in hand, set `citationType` to `pmid` and put the PMID
    in `identifier`, even if you also have a DOI.
  - **Fill `pmid`, `doi`, `url` and `title` alongside whenever you have them —
    this matters more than which type you declare.** The importer files each
    paper under the strongest handle it can see across all of those fields and
    keeps the rest as searchable alternates, so a paper reported with both a PMID
    and a DOI lands in one row no matter which type you declared. Omitting the
    other identifiers is what makes a paper hard to recognize: the same article
    reported by PMID in one seed and by DOI in another, with nothing linking the
    two, is the case Kinetix has to resolve against PubMed afterwards.
    `authors`, `journalOrSource` and `year` become the citation metadata shown to
    readers.
- **Emit no keys beyond those shown here.** Extra keys — evidence-grade scores,
  confidence ratings, quality-control blocks, per-source appraisal tables — are
  discarded without warning. An evidence caveat that matters belongs in the
  relevant `note`, which is stored.

# ▲ ▲ ▲ PROMPT — copy to here ▲ ▲ ▲

<!-- PROMPT END -->

---

## Operator notes

Kinetix-internal detail. **Not part of the prompt** — do not paste this section
into the research agent.

### What the importer does with each block

- **`drugIdentity`** — needs at least one of `names.nb` / `names.en` /
  `preferredName`. `pubchemCid` is the primary dedupe key (falls back to
  normalized name/alias). `molecularWeight` is seeded as the `molecularWeight`
  parameter automatically.
- **`kinetixParameterValues[]`** — non-`finalized` entries are skipped on import
  but are what records coverage. A finalized value is written to
  `drug_parameters` and cited in a `drug_parameter_revisions` row.
  `sourceValues[]` are written to `parameter_entries` (origin `deep-research`),
  one row per reading, each tied to its own citation; the recompute at the end of
  the import then derives `drug_parameters.value` from them, so an imported
  summarizable value is a real aggregate rather than an authored scalar that the
  first hand-added entry would displace. A parameter may carry only
  `sourceValues` and no `value` — the aggregate is computed from the rows.
  Entries are reconciled on (parameter, citation, matrix, scenario): an identical
  reading is left alone, a changed reading on a row a previous import wrote is
  applied only under `--overwrite` (and reported otherwise), and rows a human
  authored are never rewritten.
  - **Source-value coverage is reported, not enforced.** The prompt asks for
    readings from at least two independent sources per entry-backed parameter
    (`MIN_SOURCES_PER_PARAMETER` in `deepResearchImport.ts`); a parameter that
    arrives with fewer is still imported, and named in one summary warning —
    per-parameter warnings would bury every other warning on a whole-registry
    seed, where a shortfall is common. The count is per paper, not per
    `sourceId`: sources sharing a handle are folded first, since
    `resolveCitation` will file them as one citation. The CLI plan also marks
    the thin parameters (`! 1/2 papers`). Rejecting them would be worse than importing
    them: it would push the agent toward inventing a second citation, which is
    the one failure mode this format cannot detect.
- **`pharmacodynamicTargets[]`** — `targetSymbol` (or `targetName`) resolves to a
  canonical Kinetix bio-entity (created if new, tagged `drug_target`). `tier` is
  validated against `primary`/`secondary`/`tertiary` and falls back to `null`;
  `interactionType` is free text truncated at 60 chars, defaulting to
  `unspecified`. The measurement fields are stored as given — they are neither
  unit-converted nor bounds-checked. The relationship is stored only through the
  required `drug_receptor_targets.bio_entity_id`; the old receptor-target catalog
  FK no longer exists.
  - **`assaySpecies` is stored on the measurement, not on the entity (issue 1017).**
    `bio_entities` is a catalog shared across every drug, so writing a species
    onto the entity would leak out of the drug being seeded: an existing
    `SLC6A3` row would get its `organism` rewritten by whichever drug was seeded
    last, and every other drug pointing at it would inherit the change. The
    entity is the thing being modelled — human by default — and the species of a
    *preparation* is a property of the observation, so it lives in
    `drug_receptor_targets.assay_species` (migration 0092). NULL means unstated,
    not human. `findOrCreateEntityBySymbol` is nonetheless organism-aware now, so
    a genuinely non-human entity created through the admin API can no longer be
    bound to by a human-symbol lookup; the import path never asks for a
    non-human entity.
- **`metabolism`** — enzyme routes and interactions use the unified
  `bio_entities` registry via `bio_entity_id`; the legacy `enzyme_id` column has
  been removed. A metabolite that is itself a Kinetix drug is auto-linked by
  name.
- **`sources[]`** — `citationFromSource()` now genuinely picks the strongest
  handle (issue 1018): the declared `citationType` decides which field is read, then
  `canonicalCitationHandle()` re-files the source under the strongest of every
  identifier the source object carries, with the rest kept as `altIds`. The
  write path (`resolveCitation` in `api/_lib/citation-store.ts`) looks a paper up
  under **every** handle it is known by before inserting, so a DOI declared for a
  paper already filed under its PMID resolves to the existing row — with its
  `paper_reviews` row, and therefore its `read_in_full` attestation — instead of
  creating a second row that would carry its own independent review. Handles the
  document does not supply are resolved against NCBI's ID converter by the
  caller (`resolveImportCrosswalk`), best-effort: if that lookup fails the source
  is simply filed under the handle it declared. Pairs that were already split
  before this landed are folded together by
  `npm run merge:split-citations -- --resolve --apply --user-email <address>`.
- **Not read by the importer** — `evidenceQuality`, `concordance` and a
  `qualityControl` block were part of earlier revisions of this prompt and are
  silently discarded.

### Review posture

This importer is an admin bulk-seed: it bypasses the review queue and the agent
reference gate, so a seeded value appears in the app immediately, even if its
cited papers have never been read in full. The prompt states the consequence
("your output is imported verbatim … there is no editor between you and the
reader") without the internal vocabulary, which means nothing to an outside
agent.

### Keeping this file in sync

When you add or remove a parameter in `src/lib/drugParameters.ts`, update the
registry tables here in the same change.
`tests/deep-research-prompt-registry.test.ts` fails when the two drift apart, in
either direction, and also checks each row's canonical unit, bounds, min/max
requirement and matrix/scenario footnote markers against the registry spec. It
parses the markdown tables directly, so keep their column headers and the
code-span formatting of IDs and units intact.
