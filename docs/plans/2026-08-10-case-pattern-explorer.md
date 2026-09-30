# Case Pattern Explorer - Kinetix implementation specification

**Status:** Proposed for review  
**Date:** 2026-08-10  
**Primary repository:** `hagelien/kinetix`  
**Related:** [`docs/kinelab-integration.md`](../kinelab-integration.md), [`docs/plans/modelling-trust-release.md`](./modelling-trust-release.md), [`docs/pm-am-ratio-seeding.md`](../pm-am-ratio-seeding.md)

## 1. Decision

Kinetix will add a new analytical workflow inside Modeling called **Case Pattern Explorer**.

The feature is intended for clinical pharmacology and forensic toxicology cases where several related analytes may be measured in one or more matrices and the user wants to understand the **shape of the complete analytical pattern**, not merely one concentration in isolation.

Typical questions include:

- How does this case compare with similar published or curated cases?
- Is a metabolite/parent ratio ordinary or unusual for the relevant context?
- Does the combination of parent drugs and metabolites fit one plausible source drug, or are additional sources required?
- Is a finding compatible with a minor metabolite pathway, or disproportionate compared with source-only reference cases?
- Does the blood/urine pattern look more like recent systemic exposure, metabolically mature exposure, accumulated/repeated exposure, or is the distinction not identifiable?
- Which unmeasured analyte, matrix, or follow-up specimen would most reduce the remaining ambiguity?

The first release will be **descriptive and reference-comparative**, not a black-box exposure classifier. Mechanistic single-dose versus repeated-dose, co-intake, and timing inference will be added only when Kinetix has a model capable of jointly representing the relevant parent/metabolite pathways and specimen matrices.

Case Pattern Explorer is therefore a sibling of the existing simulator/inverse-inference workflow, not another `ComponentEngine` plugged into `DrugSimConfig`.

## 2. Core scientific invariant

The architecture must preserve a strict separation between four levels:

1. **Measurement** - what was actually reported by the laboratory.
2. **Normalization/calculation** - deterministic transformations such as mass-to-molar conversion, lineage sums, ratios, and urine dilution normalization.
3. **Reference comparison** - where the case lies among appropriately matched reference observations.
4. **Exposure inference** - what source drugs, timing patterns, or dosing histories are compatible with the complete pattern.

The UI and report output must never collapse these levels into one statement.

A measured concentration is not an inference. A calculated ratio is not a source attribution. A percentile is not proof of a dosing history.

All derived values must be reproducible from immutable raw observations plus versioned calculation/reference definitions.

## 3. Required outcome

Given a case containing multiple analytes and specimens, Kinetix should be able to:

1. represent every specimen explicitly;
2. retain the laboratory result exactly as entered;
3. resolve the result to a chemical/analyte identity and assay measurand;
4. convert quantitative results to a common internal molar basis where chemically valid;
5. construct relevant metabolic relationships from the existing metabolism graph;
6. calculate only curated, interpretable analytical features by default;
7. show raw and urine-normalized variants without pretending one correction is uniquely correct;
8. compare each feature with a context-matched individual-level reference distribution when available;
9. show the most similar reference cases;
10. enumerate source-drug hypotheses that can and cannot explain the measured pattern;
11. expose which findings support or contradict each hypothesis;
12. state when single versus repeated exposure, timing, or co-intake is not identifiable;
13. recommend additional analyses when a specific unmeasured result would materially reduce ambiguity;
14. preserve complete provenance, feature versions, reference dataset versions, and warnings in a run manifest.

The primary product promise is:

> Kinetix helps the user see how a multi-analyte, multi-matrix case aligns with comparable cases and which exposure histories remain compatible, while making the limits of that comparison explicit.

## 4. Non-goals for the first release

The first release must not:

- produce a universal "drug score" that implies pharmacological equivalence between unrelated substances;
- treat a spot urine/blood concentration ratio as a biological partition coefficient;
- infer administered dose directly from a metabolite/parent ratio unless a validated model specifically supports that inference;
- force a single-dose versus repeated-dose decision when the observations are non-identifying;
- apply antemortem reference distributions to postmortem cases;
- use PM/AM ratios as individual concentration correction factors;
- substitute `<LOQ` or `<LOD` observations with arbitrary point values such as LOQ/2;
- add overlapping free, conjugated, and hydrolysed-total measurements as if they were independent material;
- treat an immunoassay response as analyte-specific molarity without a validated assay-response model;
- call an observed concentration difference metabolic "flux";
- generate a numerical source probability from undocumented priors;
- build reference distributions, percentiles, or nearest-case matches from Kinetix users' own case data;
- promote, copy, aggregate, or derive any part of the reference atlas from user-entered cases, in any release.

The last two are permanent architectural constraints, not first-release scope limits. See section 18.0.

## 5. Fit with the current Kinetix architecture

### 5.1 Reuse existing drug and metabolism entities

Kinetix already models directed parent-to-metabolite links in `drug_metabolites`, with:

- parent drug;
- linked metabolite drug where the metabolite is a first-class catalog entry;
- quantitative conversion-fraction ranges;
- activity;
- evidence notes;
- references;
- reverse precursor lookup through the same table.

Relevant existing code:

- `src/lib/metabolism.ts`
- `api/_lib/metabolismStore.ts`
- `api/drug-metabolism.ts`
- `db/schema.ts`

Case Pattern Explorer must extend this graph rather than build a second metabolism registry.

### 5.2 Reuse existing unit conversion

`src/lib/unitConversion.ts` already supports mass and molar concentration units and molecular-weight-dependent conversion.

Pattern calculations must call the existing conversion functions. No second mass/molar conversion implementation should exist.

The canonical internal concentration for pattern calculations will be:

```text
µmol/L
```

unless a feature explicitly requires another basis.

### 5.3 Reuse existing analytical-method infrastructure

The current analytical-method model already stores:

- method-level supported matrices;
- lower reporting/detection/quantification fields;
- result unit;
- measurement uncertainty;
- component/analyte identity.

Relevant code/data:

- `analytical_methods`
- `analytical_method_components`
- `src/lib/drugApi.ts`
- `drizzle/0050_method_matrices_and_limits.sql`

Pattern Explorer should extend this model with measurand semantics rather than create an unrelated assay registry.

### 5.4 Reuse existing case persistence

`api/simulator/cases.ts` already accepts arbitrary JSONB `caseData` and supports filtering by `caseData.kind`.

The pattern workflow will use:

```text
kind: "pattern-case"
```

This means the first case-builder release requires no dedicated case table migration.

### 5.5 Do not force this into KineLab Lite

The existing KineLab Lite inference boundary rejects mixed matrices and currently approximates `parent_metabolite_simple` cards with parent-only first-order math.

Case Pattern Explorer must therefore begin as a separate deterministic/reference-comparison layer. Mechanistic multi-analyte/multi-matrix inference should later call a model that actually contains the required biology, most naturally the FullRemote/KineLab backend.

## 6. Target architecture

```text
                         KINETIX MODELING
                               |
              +----------------+----------------+
              |                                 |
         Simulation                       Case Pattern
       existing workflow                  new workflow
              |                                 |
        DrugSimConfig                    PatternCaseData
              |                                 |
     PK / Widmark / KineLab          specimens + observations
                                                |
                                      deterministic normalization
                                                |
                                      metabolic lineage graph
                                                |
                                      curated feature engine
                                                |
                                  context-matched reference atlas
                                                |
                                      source compatibility
                                                |
                                  +-------------+-------------+
                                  |                           |
                           descriptive output            Full compute
                                                    mechanistic scenarios
```

The Pattern layer should be pure TypeScript wherever possible so the same definitions can run in browser tests, server APIs, import scripts, and future workers.

## 7. Case domain model

### 7.1 The specimen is the central measurement container

The current simulator is component-centric. Pattern analysis must instead be specimen-centric because one case can contain many analytes in the same blood or urine specimen.

Create:

```text
src/types/patternCase.ts
```

Initial shape:

```ts
export const PATTERN_CASE_KIND = 'pattern-case' as const;

export interface PatternCaseData {
  kind: typeof PATTERN_CASE_KIND;
  schemaVersion: 1;

  /**
   * Set on a case cloned from a sandbox template (section 30.12). Part of
   * the validated contract, not UI state: everything that keeps sandbox
   * data out of statistics and exports reads it back off the saved row.
   */
  sandbox?: true;

  specimens: PatternSpecimen[];
  observations: PatternObservation[];

  context: PatternCaseContext;
  settings?: PatternAnalysisSettings;

  /** Optional last computed snapshot. Raw observations remain authoritative. */
  analysis?: PatternAnalysisSnapshot;

  /**
   * Expert overrides are NOT stored here. They live in their own table
   * with server-stamped attribution — see section 30.12 — because
   * `caseData` is opaque caller-supplied JSON and an authorship claim
   * inside it would be whatever the client chose to send.
   */
}

export interface PatternSpecimen {
  id: string;
  label?: string;

  matrix:
    | 'whole_blood'
    | 'femoral_blood'
    | 'cardiac_blood'
    | 'serum'
    | 'plasma'
    | 'urine'
    | 'vitreous'
    | 'other';

  collectedAt?: string;
  /** Hours from the case time origin (section 7.3); negative before it. */
  relativeTimeHours?: number;

  urine?: {
    creatinineMmolL?: number;
    specificGravity?: number;
    pH?: number;
    volumeMl?: number;
    collectionDurationHours?: number;
    lastVoidRelativeHours?: number;
  };

  postmortem?: {
    bloodSite?: string;
    postmortemIntervalHours?: number;
    preservative?: string;
    decomposition?: 'none' | 'mild' | 'moderate' | 'advanced' | 'unknown';
    bladderVolumeMl?: number;
  };
}

export type PatternTimeOrigin =
  | 'first_specimen_collection'
  | 'declared_exposure'
  | 'death'
  | 'admission';

export interface PatternCaseContext {
  postmortem: boolean;

  /** Declares what t = 0 means for every relative-hour field in this case. */
  timeOrigin: PatternTimeOrigin;

  deathRelativeHours?: number;
  knownExposures?: PatternKnownExposure[];
  renalFunctionNote?: string;
  hepaticFunctionNote?: string;
  notes?: string;
}

export interface PatternKnownExposure {
  drugId: number;
  certainty: 'confirmed' | 'reported' | 'suspected';
  route?: string;
  amount?: number;
  amountUnit?: string;
  timeRelativeHours?: number;
  timeRangeHours?: [number, number];
}
```

### 7.2 Observation model

The observation must retain the laboratory result as entered and separately track how Kinetix interprets that result chemically.

```ts
export type PatternObservationQualifier =
  | 'equal'
  /** Reported below a named limit, no detection statement: `[0, limit)`. */
  | 'below_limit'
  /** Analyte seen but not quantified: `[lowerLimit, limit)` where both known. */
  | 'detected_below_limit'
  | 'above_limit'
  | 'qualitative_positive'
  | 'qualitative_negative';

/**
 * Which threshold a censored result was reported against, named as the
 * source names it. Kinetix does not reclassify it — see section 9.1.
 */
export interface PatternLimitRef {
  /** Verbatim from the method sheet or paper: 'Terskel', 'LOQ', 'MKK', … */
  label: string;
  value: number;
  unit: string;
  /** Where the label came from, so lab and literature stay distinguishable. */
  source: 'method_component' | 'publication' | 'manual';
  /** The method column this came from, when it came from one. */
  column?: 'lod' | 'lor' | 'mkk';
}

export interface PatternObservation {
  id: string;
  specimenId: string;

  /** Catalog identity of the result label / analyte. */
  drugId: number;

  value?: number;
  unit?: string;
  qualifier: PatternObservationQualifier;

  /**
   * Which threshold this result was reported against, as the report names
   * it. Required whenever the qualifier is censored — without it a saved
   * `<X` cannot say what X was, and cannot round-trip the entry choice
   * when the method offers several. See section 9.1.
   */
  limitRef?: PatternLimitRef;
  /** Set only where the source also cites a lower bound (detected_below_limit). */
  lowerLimitRef?: PatternLimitRef;

  /**
   * The method component is the existing composite `(methodId, drugId)` row,
   * resolved from `analyticalMethodId` plus `drugId` above. There is no
   * component surrogate key to store — see section 7.4.
   */
  analyticalMethodId?: number;

  assay?: PatternAssayOverride;
  note?: string;
}

export interface PatternAssayOverride {
  measurandMode?:
    | 'direct'
    | 'free'
    | 'direct_conjugate'
    | 'total_after_hydrolysis'
    | 'class_response'
    | 'unknown';

  /** Species whose MW defines the laboratory's reported mass basis. */
  reportedAsDrugId?: number;

  uncertaintyCV?: number;

  /**
   * Limits as the source states them, under the source's own labels
   * (section 9.1). Each carries its own unit: they are transcribed from a
   * method sheet or paper and need not share the entered result's unit.
   */
  limits?: PatternLimitRef[];
}
```

A result entered as `250 ng/mL total oxazepam after hydrolysis` must remain distinguishable from `250 ng/mL intact oxazepam glucuronide` even if both ultimately map to the same benzodiazepine lineage.

### 7.3 Time origin

Several fields are expressed in relative hours. Without a declared origin the same chronology can be encoded three incompatible ways — a controlled-dose import anchoring on dose, a forensic case anchoring on death, a clinical case anchoring on admission — and time-conditioned reference matching would then compare timelines that do not share a zero.

Every case therefore declares exactly one `timeOrigin`. All relative-hour **instants** in that case are measured from it, increasing forward in time, negative before it:

```text
specimen.relativeTimeHours
specimen.urine.lastVoidRelativeHours
context.deathRelativeHours
knownExposures[].timeRelativeHours
knownExposures[].timeRangeHours
```

**Durations are not origin-relative** and keep their own meaning regardless of the declared origin:

```text
specimen.urine.collectionDurationHours   -- length of the collection
specimen.postmortem.postmortemIntervalHours -- death to collection
```

Consistency rules the schema must enforce:

- `timeOrigin: 'death'` requires `deathRelativeHours` to be `0` or absent;
- `timeOrigin: 'first_specimen_collection'` requires the earliest specimen to be at `0`;
- `timeOrigin: 'declared_exposure'` requires at least one known exposure, and the anchoring exposure to be at `0`;
- a case carrying **no relative-hour instant anywhere** — no specimen time, no exposure time or range, no last-void time — may declare any origin, since nothing is being placed on the axis. A case with any one of them is anchored and gets the origin-specific check above; an exposure at `-2 h` is on the timeline whether or not a specimen is.

**Cross-case comparison.** Reference cohorts declare their own origin under the same rules. Time-conditioned matching is permitted only between compatible origins. Where they differ and no conversion is recorded, Kinetix must refuse the time-conditioned comparison and fall back to the untimed one rather than silently assuming a shared zero. Converting between origins requires a known offset in the case itself — a postmortem interval, a declared dose time — never a default.

### 7.4 Analytical method component identity

`analytical_method_components` is keyed by the composite `(method_id, drug_id)` and has no surrogate `id` column. An observation already carries `analyticalMethodId` and `drugId`, so the component row is fully addressable without storing anything further, and no `analyticalMethodComponentId` field should be introduced.

This matters beyond tidiness: a nonexistent surrogate key would make method-assisted entry and the later contributor relation unimplementable against the current schema. Should a surrogate ever be wanted, it is a migration plus backfill in its own right, not an assumption this plan may make.

## 8. Raw observation preservation

The application must never overwrite the user's raw result with a normalized result.

Store separately:

```ts
export interface ResolvedPatternObservation {
  sourceObservationId: string;

  raw: {
    value?: number;
    unit?: string;
    qualifier: PatternObservationQualifier;
  };

  chemical: {
    observedDrugId: number;
    reportedAsDrugId: number;
    molecularWeight: number | null;
    measurandMode: string;
  };

  molarInterval?: {
    low: number | null;
    high: number | null;
    representative: number | null;
    unit: 'µmol/L';
  };

  warnings: PatternWarning[];
}
```

The displayed raw result should always be recoverable byte-for-byte apart from ordinary JSON numeric formatting.

## 9. Censoring semantics

Pattern analysis must be interval-aware.

Internal interpretation:

| Laboratory result | Qualifier | Quantitative representation |
|---|---|---|
| quantified value | `equal` | point plus analytical uncertainty |
| `<X`, analyte reported as seen | `detected_below_limit` | `[lower, X)` where a lower limit is also cited; otherwise `[0, X)` |
| `<X`, no detection statement | `below_limit` | `[0, X)` |
| `>X` | `above_limit` | `(X, +inf)` |
| qualitative positive | `qualitative_positive` | no numeric value unless assay calibration supports one |
| qualitative negative | `qualitative_negative` | no numeric value unless a quantitative decision limit is known |

`X` is whatever threshold the report actually cites, carried in `limitRef` with the name the source gave it. The arithmetic never needs to know whether that threshold is a detection limit, a quantification limit or a reporting cut-off — `<X` bounds the value below `X` either way.

The two censored rows stay separate for the same reason as before: a report stating the analyte was seen bounds it above zero, and that lower bound is what a source-marker presence claim, a ratio bound and a negative-evidence conclusion rest on. Where no lower limit is cited, both resolve to `[0, X)` and the qualifiers still differ, so a lower limit arriving later tightens the interval without re-entering the result.

When the source does not say whether the analyte was seen, record `below_limit`: it is the weaker claim.

Never substitute half the limit, zero, or the limit itself as a point estimate in the scientific engine.

### 9.1 Limit vocabulary: carry the source's own names

**Kinetix does not classify the laboratory's limits.** The method sheet reports three thresholds — Terskel, Påvisn. and MKK, stored as `lod`, `lor` and `mkk` — and the repository has never agreed with itself about which analytical concept each represents. `db/schema.ts` and `drizzle/0050_method_matrices_and_limits.sql` assign `lor` and `lod` opposite roles. Earlier drafts of this section picked a mapping twice and were wrong both times, in opposite directions.

The reason those attempts failed is not carelessness. The usage is genuinely inconsistent *inside the laboratory*, so there is no single correct mapping to discover: `mkk` exceeds the value in `lod` for 20 of the 55 components carrying both, and `lod` exceeds `lor` for 34 components across the catalog, mostly common OTC and lifestyle substances where Terskel is plainly an interpretive concentration rather than an assay floor —

```text
Paracetamol    Påvisn. 10       Terskel 100      µmol/l
Salisylsyre    Påvisn. 10       Terskel 100      µmol/l
Koffein        Påvisn.  5       Terskel  20      µmol/l
Efedrin        Påvisn.  0.30    Terskel   3.0    µmol/l
Kotinin        Påvisn.  0.0050  Terskel   0.60   µmol/l
```

Any global rule mapping these onto LOD/LOQ/LOR is therefore wrong for some real fraction of the catalog, and wrong silently.

**So the design carries all three verbatim and asserts nothing.**

- All three limits are stored and displayed under the headings the sheet uses — Terskel, Påvisn., MKK — with their values and units, never renamed to LOD/LOQ/LOR.
- A censored observation records **which limit it was reported against**, as a `PatternLimitRef` carrying that label. `<X` bounds the value below `X` regardless of what `X` is called, so the censoring arithmetic needs no taxonomy.
- The entry surface shows the analyte's available limits with their sheet headings and lets the person entering the result pick the one their report cites. They are reading the same report and the same vocabulary; they do not have to translate, and neither does Kinetix.
- Nothing infers a limit from a column's name, and nothing rejects a component because its three values fall in an unexpected order. An unexpected order is information about the sheet, not corruption.

This costs a field on the observation and removes an entire class of silent error. It also generalizes: a published paper states its own limits — LOD, LLOQ, cut-off, whatever the authors wrote — and `pattern_reference_observations` carries them the same way, under the paper's names, with `source: 'publication'`. Two vocabularies coexist because two vocabularies genuinely exist.

**What Kinetix may still say.** Ordering is displayed, not enforced: where a component's limits are shown together, presenting them in ascending order with their labels lets a toxicologist see at a glance that Terskel sits above Påvisn. for paracetamol, which is exactly the fact the old mapping was hiding. Where a feature depends on knowing that one threshold is a *quantification* limit specifically, that requirement is declared by the feature and the feature downgrades when the source does not supply a limit under a label it recognizes — an explicit, per-feature statement rather than a global guess.

**Settled by the laboratory (issue 1058, 2026-09-18).** The laboratory's component registry confirms the design rather than a mapping:

- For each component and sample material, one or more analytical limits are registered. When a component is added to a method, one of them is chosen, and it applies only to that component in that method.
- Each limit has a **type name** and a unit. The type name only tells one limit from another and *does not necessarily describe how the limit is used*: "SCR" need not belong to a screening analysis, and "MKK" does not necessarily mean *minste kvantifiserbare konsentrasjon*.
- One limit may be marked **Avg**: the *svarbrev* limit, used when reporting averaged results.
- A limit may also be registered for a **case category**. It overrides the analytical limit, including when that limit is the Avg one, and it can never be set lower than the analytical limit it overrides.

So Terskel, Påvisn. and MKK are labels, not definitions, and no column of the method sheet can be read as a clinical decision threshold, including for the OTC/lifestyle class. The "above clinical decision threshold" finding stays out of scope: it would need the per-limit usage (Avg, case-category overrides) that the method sheet does not carry, and it would need that usage as data, never inferred from a type name. Code comments and UI tooltips that once gave the three columns fixed meanings (reporting limit, LLOQ, report-as-zero cut-off) were corrected to match.

**Ordering validation is still required.** Vocabulary confusion of this kind fails silently — an inverted interval typechecks and flows into a ratio. So:

- a component with `lor < lod` takes the degraded path above rather than being rejected — 34 real components depend on it;

- every resolved interval must satisfy `low < high`; an interval that does not is a defect, never a value to propagate;
- limits resolve from the `limitRef` recorded on the observation, never from a column's name and never positionally.

Validation applies to the **resolved interval**, not to the component's limits. There is no expected ordering to enforce, because there is no classification to enforce it against — an unexpected order is information about the sheet, and rejecting on it would discard the 34 documented `lor < lod` components.

A `PatternAssayOverride` limit, where present, wins over the stored one and is subject to the same interval check.

**Every stored limit carries a unit and is converted before use — overrides and atlas rows alike.** Limits are transcribed from a method sheet, and a sheet reporting in µmol/L is routinely pasted alongside a result entered in ng/mL. A bound taken as a bare number lands on the wrong scale, and nothing catches it: the ordering check compares limits against each other, so a uniformly wrong-scaled set passes cleanly while the molar interval and every ratio built on it are dimensionally wrong.

This applies wherever a limit is stored beside a result. `pattern_reference_observations` transcribes limits from a paper next to a published value and needs the same unit and the same conversion, since a reference bound wrong by a factor of a thousand corrupts every percentile computed from it.

Each `PatternLimitRef` therefore carries its own `unit`, and `resolveObservations.ts` converts it into the observation's canonical basis before constructing an interval, through the same conversion the value itself uses. Where the unit is missing, or the conversion is not available — a mass-to-molar step with no molecular weight, per section 10.1 — no bound is constructed and the qualifier stands alone. A guessed limit is worse than an absent one.

Derived ratios must preserve bounds:

- quantified numerator / quantified denominator -> finite point or interval;
- quantified numerator / denominator `<LOQ` -> lower ratio bound;
- numerator `<LOQ` / quantified denominator -> upper ratio bound;
- both censored -> interval if mathematically bounded, otherwise indeterminate;
- denominator compatible with zero -> do not emit `Infinity`; emit a one-sided bound or `not_identifiable`.

## 10. Chemical normalization

### 10.1 Canonical molar concentration

For every quantitative observation with a known molecular weight:

```text
raw concentration -> µmol/L
```

Use `convertConcentration()` from `src/lib/unitConversion.ts`.

The molecular weight used must be the **laboratory reporting basis**, not necessarily the latent intact species.

Example:

- hydrolysed total oxazepam reported as ng/mL oxazepam -> use oxazepam MW;
- directly measured intact oxazepam glucuronide reported as ng/mL glucuronide -> use glucuronide MW.

### 10.2 Molar lineage equivalents

When summing chemically related analytes, Kinetix should sum molar equivalents, never raw mass concentrations.

A general lineage selector is:

```ts
export interface FeatureSpeciesTerm {
  /** Stable catalog identity, resolved to a local drug id at load — see 16.5. */
  drug: PatternDrugRef;
  /** Usually 1. Allows explicit stoichiometric accounting when needed. */
  molarEquivalentFactor: number;
}
```

Then:

```text
lineage concentration = sum(molar concentration_i * molarEquivalentFactor_i)
```

For ordinary parent/metabolite/conjugate relationships, the factor is normally `1`.

### 10.3 What the sum means

The result is an **observed analytical lineage concentration**. It is not automatically:

- total amount of drug-related material in the body;
- fraction of dose excreted;
- pharmacologically active burden;
- renal clearance;
- metabolite formation fraction.

The name used in code and UI should preserve this distinction.

Recommended code term:

```text
observedLineageMolarConcentration
```

## 11. Urine normalization

Spot urine concentration is strongly affected by dilution and bladder history. Pattern Explorer should therefore retain multiple parallel views.

### 11.1 Raw urine concentration

```text
C_U
```

This remains the directly observed concentration.

### 11.2 Creatinine-indexed burden

```text
I_Cr = C_U / Cr_U
```

Recommended display unit:

```text
µmol lineage / mmol creatinine
```

This is not a dimensionless urine/blood ratio.

### 11.3 Creatinine-standardized concentration

```text
C_U,CrRef = C_U * Cr_ref / Cr_U
```

Default configurable computational reference:

```text
Cr_ref = 8.84 mmol/L
```

The reference is a normalization convention, not a claim that 8.84 mmol/L is biologically normal.

### 11.4 Specific-gravity-standardized concentration

```text
C_U,SGRef = C_U * (SG_ref - 1) / (SG_U - 1)
```

Default configurable reference:

```text
SG_ref = 1.020
```

### 11.5 Display rule

Show in parallel when available:

```text
Raw
Creatinine-indexed
Creatinine-standardized
Specific-gravity-standardized
```

Do not average creatinine and SG corrections.

A large disagreement between normalization methods should produce a visible specimen-quality warning.

Urine pH should initially be stored as a covariate, not used in a generic Henderson-Hasselbalch correction. Substance-specific pH adjustment may be added only through validated models.

## 12. Cross-matrix feature semantics

Pattern Explorer should support three explicitly named cross-matrix quantities.

### 12.1 Same-analyte matrix enrichment

```text
R_U/B,i = C_U,i / C_B,i
```

### 12.2 Matched-lineage matrix enrichment

```text
R_U/B,L = sum(U lineage species) / sum(B matching lineage species)
```

### 12.3 Parent-anchored urinary-lineage enrichment

```text
R_U/B,P = sum(U lineage species) / B parent
```

The UI must never label these as "partition coefficients".

For spot urine, the explanatory text should state that the numerator is accumulated bladder content over an interval while blood is approximately a point-in-time systemic measurement.

## 13. Timed urine

When urine collection interval and volume are known, unlock separate amount/excretion outputs.

```text
amount excreted = C_U * urine volume
```

```text
excretion rate = amount excreted / collection duration
```

A true renal clearance estimate requires a matching blood/plasma AUC and must not be inferred from a single spot blood concentration.

This should be represented as a separate inference tier rather than silently changing the interpretation of the ordinary spot-urine ratio.

## 14. Metabolic graph

### 14.1 Graph construction

Add a shared function conceptually equivalent to:

```ts
buildMetabolicNeighborhood({
  seedDrugIds,
  upstreamDepth,
  downstreamDepth,
}): MetabolicGraph
```

It should recursively traverse the existing `drug_metabolites` relations.

### 14.2 Batch API

Repeated per-drug calls to `/api/drug-metabolism` will become inefficient for pathway views.

Add:

```text
GET /api/metabolism-graph?module=opioids
```

**Not by case-derived drug ids.** The obvious shape — `?drugIds=1,2,3` seeded from the analytes in the open case — puts the exact analyte panel in a URL, an access log and any proxy in between, which is the disclosure section 41.1 exists to prevent even though no concentration is transmitted. The graph is requested by substance module and the neighbourhood is walked in the browser.

Residual, stated rather than glossed: requesting the opioid module still discloses that the case involves opioids. That is a materially coarser fact than the panel — it does not distinguish a heroin question from a codeine question, or reveal which metabolites were sought and not found — but it is not nothing. A case spanning several modules requests several, and the client may request unrelated modules to blunt that further; whether to do so is a product decision, not something this document should mandate.

Suggested files:

```text
api/metabolism-graph.ts
api/_lib/metabolismGraphStore.ts
src/lib/metabolismGraphApi.ts
```

The API should return only catalog/metabolism data, not case observations.

### 14.3 Edge semantics required for source resolution

The present edge says that A can produce B. For forensic source reasoning it should additionally support:

```ts
export type MetaboliteSourceSpecificity =
  | 'unique'
  | 'strong'
  | 'shared'
  | 'nonspecific'
  | 'unknown';

export type MetaboliteFormationRole =
  | 'major'
  | 'minor'
  | 'trace'
  | 'unknown';
```

Proposed additions to `drug_metabolites`:

```text
source_specificity varchar(20)
formation_role varchar(20)
diagnostic_note text
```

These are evidence-backed biological annotations, not inference results.

They must use the same edit/review/provenance workflow as existing metabolism data.

## 15. Analytical-method/measurand hardening

This is required before Kinetix can safely sum glucuronide-heavy or hydrolysed panels.

### 15.1 Extend method-component semantics

Proposed fields on `analytical_method_components`:

```text
measurand_mode varchar(30)
reported_as_drug_id integer references drugs(id)
hydrolysis_recovery_min numeric
hydrolysis_recovery_median numeric
hydrolysis_recovery_max numeric
overlap_group varchar(100)
```

Suggested `measurand_mode` values:

```text
direct
free
direct_conjugate
total_after_hydrolysis
class_response
unknown
```

### 15.2 Contributor model

For methods where one reported result can contain responses from several latent species, add:

```text
analytical_method_component_contributors
  id
  method_id              -- composite reference to analytical_method_components
  component_drug_id      -- (method_id, drug_id); that table has no surrogate id
  source_drug_id
  molar_response_min
  molar_response_median
  molar_response_max
  contribution_type
  note
  reference_ids
```

Possible contribution types:

```text
direct
after_hydrolysis
cross_reactivity
conversion_artifact
```

### 15.3 Double-counting guard

The lineage engine must refuse or bound a sum when two reported measurands overlap and the overlap cannot be resolved.

Example:

```text
total oxazepam after hydrolysis
+ directly measured oxazepam glucuronide
```

must not be naively summed when the hydrolysed total already contains the glucuronide contribution.

### 15.4 Underidentified assay systems

When the available measurements do not uniquely identify free/conjugated species, calculate the minimum and maximum lineage concentration compatible with:

- non-negative latent concentrations;
- assay response equations;
- result intervals;
- hydrolysis recovery intervals.

A constrained linear-programming implementation may be added later. Until then, unresolved overlap should downgrade or block the affected feature rather than fabricate a split.

## 16. Curated analytical feature registry

### 16.1 Why a registry is required

For `n` analytes there are `n(n-1)/2` pairwise ratios. Most have no useful biological interpretation and many are redundant.

The default UI must therefore expose a curated registry of features rather than every mathematically possible ratio.

Ad-hoc exploratory ratios may be offered separately and clearly labelled as exploratory.

### 16.2 Location

```text
src/lib/pattern/featureRegistry.ts
```

### 16.3 Proposed definition

```ts
export interface PatternFeatureDefinition {
  id: string;
  version: string;
  labelKey: string;
  descriptionKey: string;

  kind:
    | 'parent_metabolite_ratio'
    | 'branch_ratio'
    | 'lineage_burden'
    | 'matrix_same_analyte'
    | 'matrix_lineage_parent'
    | 'matrix_matched_lineage'
    | 'composition'
    | 'source_marker'
    | 'serial_change';

  numerator: FeatureSelector;
  denominator?: FeatureSelector;

  transform:
    | 'identity'
    | 'ratio'
    | 'log10_ratio'
    | 'fraction';

  specimenRequirements: PatternSpecimenRequirement[];
  assayRequirements?: PatternAssayRequirement[];

  urineNormalization:
    | 'none'
    | 'raw_and_creatinine'
    | 'raw_creatinine_and_sg';

  inferenceTargets: Array<
    | 'source'
    | 'kinetic_phase'
    | 'repeated_exposure'
    | 'co_intake'
    | 'metabolic_phenotype'
    | 'specimen_adulteration'
  >;

  referenceCohorts?: PatternCohortRef[];
  referenceCitations: PatternCitationRef[];
}
```

### 16.4 Feature selector

The selector must be explicit enough to make every calculation auditable.

```ts
export type FeatureSelector =
  | { type: 'species'; terms: FeatureSpeciesTerm[] }
  | { type: 'lineage'; lineageId: string; scope: 'observed' | 'matched_panel' }
  | { type: 'presence'; drug: PatternDrugRef };
```

The engine should return the resolved species list used in every calculation.

### 16.5 Stable identities in the registry

The registry is source-controlled and ships with the application; the databases it runs against are separate installations whose serial sequences have no reason to agree. A `drugId: number` written into `featureRegistry.ts` therefore names a different substance — or nothing — in the next database, and a citation merge can invalidate a compiled reference within a single database. Either way the failure is silent: a feature computes against the wrong analyte, or a percentile compares against the wrong cohort, and nothing looks broken.

No numeric database id may appear in a source-controlled registry entry. Use stable identities and resolve them at load:

```ts
export interface PatternDrugRef {
  /** `drugs.pubchem_cid` — the catalog's identity key. Authoritative. */
  pubchemCid: number;
  /** Human-readable hint for diagnostics. Never used to resolve. */
  slug?: string;
}

export interface PatternCitationRef {
  /** Only the identifier-bearing types the citation model already resolves. */
  type: 'pmid' | 'doi' | 'url';
  identifier: string;
}
```

`resolveReferenceSchema` and `createReferenceSchema` in `api/_lib/schemas.ts` accept `freetext`, `url`, `pmid` and `doi`. The registry uses the last three: `freetext` carries no resolvable identifier and cannot serve as a stable key. No type outside that set may appear here without the citation schema and API work to support it landing first — given the fail-loudly rule below, a single unresolvable entry would take the whole registry down with it.

**Citations resolve through the handle system, never by exact `(type, identifier)` match.** `citations` is unique on that pair, but a paper is not: `resolveCitation` files a row under the strongest handle it knows — PMID over DOI over URL — keeps the others in `metadata.altIds`, and promotes an existing weaker row in place. So a registry entry naming a DOI stops matching the column pair the moment that row is promoted to its PMID, while still naming the same paper. Under the fail-loudly rule that would take the registry down over a routine citation merge. Registry load must therefore look the reference up under every handle the paper is known by, using the existing `addressableHandles` / `citationIdentityKey` helpers in `src/lib/citationHandles.ts` and the same resolution path as `resolveCitation`, rather than a direct query.

**Why PubChem CID rather than slug.** A slug looks like the stable choice and is not: `applyParameterChange` regenerates `drugs.slug` whenever the English or Norwegian source name it derives from changes, and an approved rename is ordinary curation rather than an exceptional event. Keying the registry on it would mean a routine name edit unresolved every entry naming that substance and — under the fail-loudly rule below — took the entire feature registry down with it, while the drug itself sat there unchanged. `pubchem_cid` is unique, survives renames, and is already what the repository treats as catalog identity: the catalog drift check keys on it "so a rename is a field change, not a delete+add" (AGENTS.md). All 171 entries in `data/components.ts` carry one.

The consequence is worth stating plainly: **a substance with no PubChem CID cannot be named by a feature definition.** Where a feature needs one, the CID is added to the catalog first. That is the right trade — it pushes a one-off curation step in front of the feature rather than leaving identity to a mutable string.

**Reference cohorts are named by the source, not by a local key.** An earlier draft gave cohorts a `source_key` unique *per installation*, which fails the same test this section applies to everything else: if installation A admits one cohort as `opioid-1` and installation B assigns that key to a different one, the same registry entry resolves in both and quietly computes against two different reference populations. Local uniqueness is not identity.

Cohort identity is anchored to facts about the published dataset, which are the same everywhere:

```ts
export interface PatternCohortRef {
  /** The published source, resolved through the handle system. */
  citation: PatternCitationRef;
  /** `source_dataset_hash` as recorded at admission — immutable (18.1). */
  datasetHash: string;
  /** Immutable at admission. Same bytes, different transform, different cohort. */
  transformationVersion: string;
  importerVersion: string;
  /** Disambiguates subgroups drawn from the same dataset. Never null. */
  subgroupKey: string;
}
```

Citation and dataset hash are properties of the paper and the file, not of the database holding them, so they name the same population in any installation — and they are already immutable after admission because invariant 32 needs them to be.

**The transformation belongs in the identity, not just in the audit trail.** Section 34.3 requires a revised dataset to be a *new admission* rather than a re-run, and a changed transformation is exactly such a revision. So two cohorts can legitimately share a citation, a dataset hash and a subgroup key while differing in `transformation_version` — same source bytes, different derived population. A ref naming only the first three would match both, which is ambiguous within one installation and can bind to different populations across two. Both version columns already exist and are already immutable for invariant 32, so this costs nothing beyond naming them.

**`subgroup_key` is never null.** A nullable column cannot carry this identity: PostgreSQL treats nulls as distinct in a unique index, so `(citation_id, source_dataset_hash, transformation_version, importer_version, subgroup_key)` would permit any number of rows that differ only by all having no subgroup — precisely the ordinary case. The column is `NOT NULL DEFAULT ''`, with the empty string meaning "the whole dataset". A `NULLS NOT DISTINCT` index is the equivalent fix; the sentinel is preferred here only because it removes the three-valued reasoning rather than requiring every future query to remember it.

Load resolves on all five and validates: a registry entry whose resolved cohort differs in any of them fails loudly rather than proceeding.

`subgroup_key` remains curator-assigned, so two installations can still disagree about how the subgroups of one dataset are named. That residue is acceptable because of which way it fails — a disagreement produces no match and a loud load failure, not a silent match against the wrong subgroup.

Resolution rules:

- resolve every identity once at registry load, not per calculation;
- an identity that resolves to nothing is a **load-time failure**, not a silently skipped feature — a registry that half-loads is worse than one that refuses;
- a `slug` hint that disagrees with the resolved row is a maintenance warning, not a load failure. Renames are expected, so a stale hint means the registry text needs refreshing, not that the feature is wrong. It must never participate in resolution, or it reintroduces the fragility it was demoted for;
- the resolved numeric ids stay in memory and are never written back into the registry source.

This also changes what `referenceCitations` means relative to earlier drafts: it is the literature backing the feature *definition*, identified by type and identifier, not a list of `citations.id` values.

### 16.6 Substance modules

Module-granular fetching (section 41.1) needs modules to be a real thing rather than a manner of speaking. Section 33 lists substance families informally; that is not enough to key a request on, and without a registry the client would have to derive a module from the analytes in the open case — which reintroduces exactly the disclosure the module was adopted to prevent.

The registry is source-controlled, alongside the feature registry and under the same identity rules:

```text
src/lib/pattern/substanceModules.ts
```

```ts
export interface PatternSubstanceModule {
  id: string;                 // 'opioids', 'benzodiazepines' — stable, never reused
  version: string;
  labelKey: string;
  /** Members by stable identity, per 16.5. Never database ids. */
  members: PatternDrugRef[];
}
```

Rules that make it usable on both sides of the request:

- **Membership is explicit, not inferred.** A substance belongs to a module because the registry says so, not because a graph walk reached it. Inference would make the mapping differ between client and server, and the two must agree exactly or a fetch returns the wrong neighbourhood.
- **Modules may overlap, and a case may span several.** Codeine sits in the opioid module; a case with codeine and diazepam requests both. Overlap is normal and needs no resolution — the client unions what it receives.
- **Every analyte resolves to at least one module.** A substance in no module cannot be fetched for without naming it, so the generator that builds sandbox templates also fails the build when a method-component substance has no module, rather than leaving a hole that quietly degrades to a case-derived request later.
- **Versioned like the feature registry**, and the version enters the run manifest: which module a substance belonged to affects which references were in scope, so it affects reproducibility.

This lands in Phase 2, before anything fetches by module.


## 17. Feature output

```ts
export interface PatternFeatureResult {
  featureId: string;
  featureVersion: string;

  status:
    | 'point'
    | 'interval'
    | 'lower_bound'
    | 'upper_bound'
    | 'indeterminate'
    | 'blocked';

  rawValue?: PatternNumericInterval;
  log10Value?: PatternNumericInterval;

  numerator: PatternDerivedQuantity;
  denominator?: PatternDerivedQuantity;

  normalization: PatternNormalizationDescriptor;

  calculationWarnings: PatternWarning[];
  quality: PatternFeatureQuality;
}
```

For positive ratios, `log10Ratio` should be the default cross-feature plotting coordinate.

Interpretation:

```text
-2 = 0.01x
-1 = 0.1x
 0 = 1x
+1 = 10x
+2 = 100x
+3 = 1000x
```

The raw fold ratio should always remain available.

## 18. Reference Atlas data model

`parameter_entries` must not be used as the storage model for paired individual-level pattern data. It is a source-level parameter/value store and cannot reproduce covariance between analytes measured in the same person.

Create dedicated reference tables when the first reference-data vertical slice is implemented.

### 18.0 Published sources only

**The reference atlas is a literature and public-dataset artifact. It must never contain, aggregate, or be derived from cases entered by Kinetix users.**

Privacy and data-protection regulation makes a user-contributed case atlas unavailable to this project. This is a hard boundary, not a policy default that a later release may relax:

- every reference cohort must originate from a published article or a published/licensed dataset;
- `pattern_reference_cohorts.citation_id` is `NOT NULL` and enforced in the migration, not only in application code;
- no API route, admin action, import script, background job, or UI affordance may write user case data into any `pattern_reference_*` table;
- there is deliberately no "contribute this case" path, and none may be added;
- the similar-case candidate pool is the reference atlas only (see section 22.0).

The practical consequence is that atlas growth is bounded by curation effort rather than by product usage. Sections 21.4, 22.0 and 30.6 are written for the small-`n` regime this produces, and section 34.3 routes ingestion through the existing paper-extraction pipeline for that reason.

### 18.1 Cohorts

```text
pattern_reference_cohorts
  id
  subgroup_key           -- NOT NULL DEFAULT ''; '' means the whole dataset.
                         -- Identity is (citation_id, source_dataset_hash,
                         -- transformation_version, importer_version,
                         -- subgroup_key), unique together (16.5).
  citation_id            -- NOT NULL; a cohort without a published source is invalid
  name
  cohort_type
  design
  evidence_tier
  population_note
  analytical_note
  time_origin            -- NOT NULL; anchors every relative-hour field below (7.3)
  source_dataset_url
  source_dataset_hash     -- NOT NULL; identity column, immutable after admission
  importer_version        -- NOT NULL; identity column, immutable after admission
  transformation_version  -- NOT NULL; identity column, immutable after admission
  transformation_notes
  version
  authorized_by           -- NOT NULL; the admin who admitted this cohort
  authorized_at           -- NOT NULL
  created_at
  updated_at
```

**Every column in the identity is `NOT NULL`.** PostgreSQL treats nulls as distinct in a unique index, so a single nullable member silently disables the whole five-column constraint and lets the same cohort be admitted twice. That includes `source_dataset_hash`: a cohort transcribed by hand from an article with no downloadable dataset still needs one, so admission computes it over the canonical serialization of what was transcribed rather than leaving it empty. A cohort with no bytes behind it is not a cohort that can be re-verified, which is what invariant 32 exists to guarantee.

**`citation_id` must be registered with the citation merge path.** `resolveCitation` can invoke `mergeCitations`, which repoints an explicit list of current consumers and then deletes the losing row. `pattern_reference_cohorts` is a new consumer, so it has to join that list: left out, a restrictive foreign key makes an ordinary citation merge fail, and a cascading one deletes an admitted cohort along with every case, specimen and observation hanging off it. Merging two citations can also collide two cohorts onto one identity tuple, which the merge must reconcile rather than violate the constraint. Phase 3 carries regression coverage for both — a merge that repoints a cohort, and a merge that would collide two.

`authorized_by` and `authorized_at` are what make invariant 31 auditable: every reference case and observation reaches the atlas through a cohort, so recording admission at the cohort makes it impossible to persist atlas data nobody admitted.

The dataset-identity columns — hash, importer version, transformation version — are what make invariant 32 enforceable. They must be immutable once recorded, because the importer compares the file in hand against them; a comparison against editable values verifies nothing. `transformation_notes` is prose for a human and is not part of that comparison. See section 34.3.

`cohort_type` examples:

```text
controlled_single_dose
controlled_repeated_dose
clinical
DUID
forensic_living
postmortem
other
```

### 18.2 Reference cases

```text
pattern_reference_cases
  id
  cohort_id
  source_subject_key
  sex
  age
  time_origin            -- nullable; overrides the cohort's origin for this case
  context_json
  source_locator
```

`source_subject_key` should be a publication/dataset-local pseudonymous key, never a directly identifying patient identifier.

**Time origin is persisted, not inferred.** Section 7.3 requires a case to be compared only against references sharing a compatible origin, so the atlas has to record what its own relative hours are anchored to — otherwise the matcher cannot tell a dose-anchored controlled study from a death-anchored postmortem series, and `time_relative_hours` on exposures and specimens means nothing across cohorts.

The cohort carries the origin because a cohort is normally one study with one design. A cohort assembled from case reports that genuinely differ sets `pattern_reference_cases.time_origin` per case; the effective origin is the case override where present and the cohort's otherwise. Both use the `PatternTimeOrigin` values from section 7.3, so cases and references are compared in one vocabulary rather than two.

The import contract enforces it: a cohort cannot be admitted without an origin, and importing a case carrying any relative-hour value under a cohort whose effective origin is unset fails with nothing written. Untimed reference cases remain fine — they simply never enter a time-conditioned comparison.

### 18.3 Known exposures

```text
pattern_reference_exposures
  id
  case_id
  drug_id
  certainty
  amount
  amount_unit
  route
  time_relative_hours
  time_low_hours
  time_high_hours
  regimen_json
  source_locator
```

### 18.4 Specimens

```text
pattern_reference_specimens
  id
  case_id
  matrix
  collection_relative_hours
  blood_site
  postmortem_interval_hours
  urine_creatinine_mmol_l
  urine_specific_gravity
  urine_ph
  urine_volume_ml
  collection_duration_hours
  metadata_json
  source_locator
```

**Locator granularity.** Every entity that carries transcribed values needs its own locator, because a single reference case is routinely assembled from several places in a paper: dose and route from a methods table, collection timing from a figure caption, postmortem interval from the case narrative, concentrations from a results table. A locator held only at case and observation level cannot record where the dose or the collection time came from, which would break the auditability the import contract in section 34.3 promises and provenance invariant 29 asserts.

Row-level `source_locator` is the minimum. If a single row's fields come from different places often enough to matter in practice, promote provenance to field level for that entity rather than recording one locator that is right for some columns and wrong for others.

### 18.5 Observations

```text
pattern_reference_observations
  id
  specimen_id
  drug_id
  analytical_method_id   -- with drug_id above, the composite component key (7.4).
                         -- Nullable: a published assay is usually not one of
                         -- this laboratory's methods.
  measurand_mode         -- transcribed from the paper; 'unknown' when silent
  reported_as_drug_id    -- the species defining the paper's mass basis
  hydrolysis_note        -- prose; the structured fields above drive matching
  value
  unit
  qualifier
  limit_label            -- the source's own name for the limit (9.1)
  limit_value
  limit_unit             -- NOT NULL when limit_value is set
  lower_limit_label      -- set only where the paper cites a second, lower limit
  lower_limit_value
  lower_limit_unit       -- NOT NULL when lower_limit_value is set; need not
                         -- match limit_unit (9.1: each threshold carries its own)
  uncertainty_cv
  source_locator
```

**Assay semantics are transcribed, not inherited.** A published reference was not measured by one of this installation's analytical methods, so `analytical_method_id` is usually null and cannot carry the measurand. The paper's own description is transcribed into `measurand_mode` and `reported_as_drug_id` at import, which is what lets section 20 keep hydrolysed and free/intact references apart. This deliberately does not depend on the method-schema hardening in Phase 4: that work makes *local* method semantics machine-readable, and Phase 3 would otherwise be unable to distinguish a total-after-hydrolysis reference from a free one until Phase 4 landed. Where the paper is silent the mode is `unknown` and the reference downgrades rather than matching.

Store raw published observations. Do not store only precomputed ratios.

When feature definitions improve, the entire reference atlas must be recomputable.

### 18.6 Aggregate statistics (Tier C)

Studies reporting only summary statistics cannot be represented as cases, and must not be forced into one. They get a separate table, hanging off the same cohort so provenance and authorization work identically:

```text
pattern_reference_aggregates
  id
  cohort_id
  drug_id
  matrix
  measurand_mode          -- as section 7.2; 'unknown' when the paper is silent
  reported_as_drug_id     -- the species defining the paper's mass basis
  hydrolysis_note         -- prose; the structured fields above drive matching
  statistic_of            -- 'concentration' | 'feature'
  feature_id              -- set when statistic_of = 'feature'; else null
  feature_version
  n
  n_censored              -- reported censored count where the study gives one
  mean
  sd
  median
  p25
  p75
  min
  max
  geometric_mean
  unit
  limit_label             -- the source's own name for the limit (9.1)
  limit_value
  limit_unit              -- NOT NULL when limit_value is set
  population_note
  source_locator
```

Three rules keep this tier from leaking into individual-level claims:

- **No individual percentile may be computed from this table.** It backs an envelope — a shaded band, a min/max, a stated median — and nothing else. Section 19 already forbids synthesizing a distribution from a mean and a range; the table separation is what makes that structural rather than aspirational.
- **A ratio of published means is not a mean of individual ratios.** An aggregate row for a *feature* (`statistic_of = 'feature'`) is only admissible when the study itself reported that feature's statistics. Deriving one by dividing two concentration aggregates is forbidden, and is invariant 17's existing subject.
- **Aggregates and individuals never pool.** A comparison draws from one or the other and says which. Where both exist for a feature, show them as two clearly separated layers rather than merging them into one distribution.

**Assay semantics travel with the aggregate.** A concentration envelope identified only by drug and matrix cannot be matched safely: section 20 requires hydrolysed and non-hydrolysed references to stay distinguishable, and a published total-after-hydrolysis range compared against a case's free or intact concentration is a scientifically invalid comparison that looks entirely reasonable on screen. Aggregates carry the same transcribed measurand fields as individual reference observations (section 18.5), and the matching rules of section 20 apply unchanged. Where the paper is silent, `measurand_mode` is `unknown` and the aggregate downgrades rather than matching — an envelope whose measurand nobody can state is not a comparison, it is a coincidence of units.

`n_censored` is stored because a study that says "12 of 40 were below the limit" is telling you something the median alone cannot, and it feeds directly into the quantified-only estimand of section 21.1. It is named for what it counts rather than for a limit vocabulary, since the paper's own label is carried alongside it per section 9.1.

## 19. Reference evidence tiers

Reference output depends on the evidence available.

Recommended tiers:

| Tier | Data | Allowed use |
|---|---|---|
| A | Individual paired controlled-dose observations | time-dependent distributions and scenario validation |
| B | Individual clinical/forensic observations with adequate context | empirical percentiles and nearest-case matching |
| C | Aggregate study statistics only | literature envelope, no claimed individual percentile distribution |
| D | Mechanistic/popPK simulation only | model-predicted envelope, clearly labelled simulated |
| E | Qualitative metabolic knowledge only | compatibility rules, no numerical distribution |

Kinetix must not synthesize an individual percentile distribution from a study reporting only a mean, median, or range.

**Tier C gets its own table.** The atlas tables in section 18 store case-level specimens and observations only, and a Tier C study reports a mean, a median, a range and an `n` with no individuals behind them. Representing that as fabricated individual cases would corrupt the atlas; hiding it in untyped JSON would make it unreproducible. Since published-only sourcing makes aggregate-only reporting a large share of what can be cited, and section 21.5 names the literature envelope as the expected postmortem comparison path, dropping the tier would gut the postmortem path rather than simplify it. `pattern_reference_aggregates` (section 18.6) lands alongside the case tables in Phase 3.

The separation is the point: aggregates live in a different table from individuals so that no query can accidentally pool them, and so the tier restriction above — no claimed individual percentile from an aggregate — is enforced by which table was read rather than by a flag someone has to remember to check.

## 20. Reference matching

Reference cases must be filtered by context before biochemical similarity is calculated.

Potential matching variables:

- living versus postmortem;
- blood matrix;
- postmortem blood site;
- route;
- single versus repeated administration;
- time since last intake when known;
- known dose or dose range when scientifically relevant;
- urine collection mode;
- creatinine/SG/pH availability;
- hydrolysed versus non-hydrolysed assay basis;
- exact analyte-panel coverage;
- renal/hepatic impairment where reported;
- important enzyme modifiers where reported.

The matching logic must record which filters were applied and which were relaxed.

## 21. Reference comparison statistics

For positive ratio-like features, compare on log10 scale.

### 21.1 Empirical percentile

For adequate individual-level matched data:

```text
percentile = empirical CDF of log10(feature)
```

The UI must show `n` and evidence tier beside the percentile.

**How censored values enter this estimator.** The atlas deliberately stores censored observations (section 9), and a censored value has an interval, not the exact `log10(feature)` this CDF consumes. The same gap propagates into the medians and MADs of 21.2–21.3 and the similarity scores of section 22. **The estimand is therefore the percentile among *quantified* references, labelled as such.** Censored references are excluded from the CDF, and the exclusion is declared rather than hidden.

The alternative — an interval-censored estimator such as Turnbull, or Kaplan–Meier on the reversed axis — is the statistically richer answer and is the right one if these reference sets ever get large. It is not the right one now. Published-only sourcing yields cohorts of single-digit `n` as the expected case rather than the degraded one, and a Turnbull curve fitted to six intervals delivers false precision: a smooth-looking distribution whose shape is an artifact of the estimator, presented in a forensic context where someone will read a number off it. The honest relabelling is cheaper to build, impossible to over-read, and does not pretend to information the corpus does not contain.

What that requires, none of it optional:

- the label says *quantified references*, everywhere the number appears — not a footnote;
- both counts travel with it, `n` quantified and `n` censored, so a percentile resting on 4 of 11 is visibly that;
- the percentile is **suppressed entirely**, not merely annotated, when either test fails: **fewer than 5 quantified references**, or **a censored fraction of one third or more**. Show the individual points and the censored bounds instead.

  Both live behind one setting, `patternReference.percentile`, and the fraction is stored as an exact ratio rather than a decimal:

  ```text
  minQuantifiedN:        5
  maxCensoredRatio:      { numerator: 1, denominator: 3 }
  suppress when          quantified < minQuantifiedN
                         OR censored * denominator >= total * numerator
  ```

  `0.33` is not one third, and the difference is not academic: 33 censored of 100 is below one third but at or above `0.33`, so the two forms disagree exactly at the boundary the invariant tests. Integer cross-multiplication is exact, avoids the float comparison entirely, and makes "one third" mean one third. The documented 4-quantified-of-11 case fails both tests and renders as points;
- censored references still render on the Ratio Atlas as bounds. They are excluded from the *statistic*, not from the display — dropping them from sight would misrepresent the evidence even where the arithmetic is sound.

What is never available is excluding censored references and continuing to call the result a percentile of the matched population. That is the biased option in different clothing, and small reference sets make the bias larger rather than smaller. Substituting LOQ/2 or any other point remains forbidden outright by section 9.

Revisit this if a feature's matched reference set routinely exceeds roughly 30 individuals with a substantial censored fraction — at that size the interval-censored estimator earns its complexity.

### 21.2 Fold from reference median

```text
foldFromMedian = 10^(caseLog10 - referenceMedianLog10)
```

This is often more intuitive than a z-score.

### 21.3 Robust standardized score

When enough points and non-zero spread exist:

```text
robustZ = (x - median) / (1.4826 * MAD)
```

Do not emit a robust z-score when MAD is zero or the matched sample is too small.

### 21.3a One censoring policy for every reference statistic

The quantified-only rule of 21.1 is not a property of the CDF; it is a property of how this atlas treats censored evidence, and it governs **every** statistic computed over matched references — the median of 21.2, the median and MAD of 21.3, and the feature standardization behind the similarity distance of section 22. Specifying it only for the percentile would leave `foldFromMedian` free to discard bounds while the percentile excluded them and labelled it, so the same case could be described two incompatible ways on one screen.

Applied uniformly:

- every such statistic is computed over the **quantified** references only, and censored references are never point-substituted into any of them;
- every such statistic carries the same pair of counts, and is labelled as being over quantified references wherever it is shown;
- the suppression tests of 21.1 — `quantified < minQuantifiedN`, or `censored * denominator >= total * numerator` — gate all of them together. A feature that fails them yields no percentile, no fold-from-median, no robust z, and is excluded from the similarity distance as unusable rather than contributing a value computed on a rump;
- exclusion under this rule counts against reported feature coverage in section 22, exactly as the zero-MAD exclusion does, so a similarity score visibly rests on fewer features rather than a silently narrowed set.

The consequence is that a feature is either usable for reference comparison or it is not, and every view agrees on which. That is worth more here than squeezing a number out of each statistic independently.

### 21.4 Small reference sets

Default presentation rules should be conservative:

- `n >= 20`: empirical percentile may be shown;
- `10 <= n < 20`: show individual distribution and rank, but visibly mark percentile precision as limited;
- `5 <= n < 10`: show individual reference points/range, no strong percentile language;
- `n < 5`: show source cases individually and label comparison insufficient for distributional inference.

These thresholds are product defaults, not biological constants, and should remain configurable/tested.

### 21.5 Small `n` is the expected case, not the exception

Because the atlas is restricted to published sources (section 18.0), the low-`n` branches above will be the ordinary path rather than a degraded one.

Individual-level paired multi-analyte observations are scarce in the literature. Controlled-dose studies exist for several opioid pairs but typically with small cohorts of living volunteers. Postmortem data is published overwhelmingly as aggregate medians and ranges, which section 19 caps at tier C with no individual percentile. The postmortem femoral-blood case that motivates much of this feature will therefore frequently resolve to a literature envelope rather than a percentile.

Design consequences:

- treat "individual reference points with citations" as the primary rendering and the smooth distribution as the exception that must earn its `n` (see section 30.6);
- never let an empty or thin reference result read as a defect. The absence of comparable published data is itself a reportable finding and should be phrased as one;
- expected-tier mix should be visible per substance module so curation effort can be aimed at the gaps.

## 22. Similar Cases engine

### 22.0 Candidate pool

The candidate pool for similarity is the published reference atlas only. Cases belonging to other Kinetix users are never eligible, in any release, under any permission level.

Whether a user may compare a case against **their own** previously saved cases is a separate question with a different legal basis, and is deliberately left unresolved here. If it is later allowed, it must be a visibly separate panel from published references, carry its own evidence tier, and never merge into a published-reference distribution, percentile, or count.

Expect a thin result set. Published case reports rarely supply both a full analyte panel and enough context to pass the hard filter in section 22.1, so matches with coverage of one to three shared features will be common. The coverage fraction required by section 22.3 makes this visible, and the feature should be presented as "published comparable cases to read" rather than as neighbours in a metric space until the atlas supports more.

### 22.1 Hard filter first

Nearest-case similarity must never allow a biochemically similar but contextually incompatible case to outrank an appropriate one merely because the numbers are close.

Apply hard or strongly weighted context matching first.

### 22.2 Feature standardization

For each eligible feature `j`:

```text
z_j = (x_j - median_j) / (1.4826 * MAD_j)
```

or a percentile-normalized equivalent when the feature distribution is strongly non-Gaussian.

**A feature whose matched reference values give `MAD_j = 0` is excluded from the distance, not standardized.** This is not an edge case here: the reference sets are deliberately small, and presence-like or discrete features routinely produce identical matched values. Dividing by it yields `Infinity` or `NaN` coordinates, and a single such feature makes every downstream case distance unusable rather than merely noisy. Section 21.3 already suppresses robust z-scores under the same condition; the Similar Cases path needs the same rule, and the exclusion counts against feature coverage so the user sees a comparison resting on fewer features rather than a silently narrowed one.

### 22.3 Missingness-aware distance

```text
D(a,b) = sqrt(
  sum_j w_j I_abj (z_aj - z_bj)^2
  / sum_j w_j I_abj
)
```

where `I_abj` is 1 only when both cases have a comparable value for feature `j`.

Return the coverage fraction with the distance. A "nearest" case based on one shared feature must not look equally trustworthy as one based on ten.

### 22.4 Correlated features

Do not let ten mathematically redundant ratios overwhelm one independent observation.

Feature definitions should optionally carry a `correlationGroup` or `weightGroup`. Total weight can then be normalized within groups.

## 23. Source Resolver

### 23.1 First release: transparent compatibility, not posterior probability

The initial resolver should enumerate source-drug sets that can explain the measured analyte network.

For each candidate source set, calculate separate evidence dimensions:

1. **graph coverage** - can the sources reach all detected analytes?
2. **source-specific markers** - are unique/strong markers present?
3. **unexplained findings** - which analytes remain unreachable?
4. **expected-but-absent findings** - were informative markers actually tested with sufficient sensitivity?
5. **proportional compatibility** - do curated ratios fit source-only reference cases?
6. **cross-matrix compatibility** - does the paired specimen pattern fit relevant references?
7. **temporal compatibility** - if timing is known, is the observed stage plausible?
8. **alternative explanations** - phenotype, renal function, assay coverage, degradation, postmortem effects.

### 23.2 Candidate source sets

The graph stage can use a minimal set-cover style search to find the smallest source sets capable of reaching the observations.

Do not equate "smallest" with "true". Minimality is an Occam-style ranking feature only.

### 23.3 Negative evidence

Absence is informative only when all of the following are addressed:

- the analyte was actually included in the analytical panel;
- the method had adequate sensitivity;
- specimen/matrix is appropriate;
- timing does not make absence expected;
- degradation/stability does not invalidate the negative result.

Otherwise render absence as `not informative`, not evidence against the source.

### 23.4 Output vocabulary

Use restrained labels such as:

```text
compatible
compatible with limitations
less compatible
not explained by this source set
indeterminate
```

Avoid categorical labels such as `proved`, `excluded`, or numerical source probabilities unless the model and priors justify them.

## 24. Single versus repeated dosing

This question must be treated separately from source resolution.

Under many linear parent/metabolite systems:

```text
C_parent(t) = D * f_parent(t)
C_metabolite(t) = D * f_metabolite(t)
```

so:

```text
C_metabolite / C_parent = f_metabolite(t) / f_parent(t)
```

and dose magnitude cancels.

Therefore many ratios are primarily kinetic-phase markers, not large-dose markers.

Repeated-dose inference should only become a mechanistic feature when the engine can represent:

```text
C_i(t) = sum_k D_k * f_i(t - t_k)
```

for all relevant analytes and specimen outputs.

### 24.1 Descriptive first release

The empirical layer may say that a pattern resembles reference cohorts labelled single-dose or repeated-dose when such individual-level data exist.

It must not claim that the ratio itself proves repeated dosing.

### 24.2 Future mechanistic layer

Scenario families:

```text
single recent intake
single older intake
repeated regular intake
repeated irregular intake
recent intake on accumulated exposure
co-intake of multiple source drugs
```

should be evaluated by FullRemote/KineLab once parent/metabolite and urinary-output models exist.

Every comparison must return an identifiability assessment. If multiple scenario families reproduce the data, the correct result is `indeterminate`.

## 25. Pattern calculation engine

Create:

```text
src/lib/pattern/
  types.ts
  schemas.ts
  resolveObservations.ts
  normalize.ts
  censoring.ts
  urineNormalization.ts
  lineageGraph.ts
  featureRegistry.ts
  calculateFeatures.ts
  referenceMatching.ts
  referenceComparison.ts
  similarity.ts
  sourceResolver.ts
  quality.ts
  interpretation.ts
  manifest.ts
  index.ts
```

Suggested deterministic pipeline:

```ts
export function analyzePatternCase(
  caseData: PatternCaseData,
  catalog: PatternCatalogContext,
  references?: PatternReferenceContext,
): PatternAnalysisResult {
  const validated = validatePatternCase(caseData);
  const resolved = resolveObservations(validated, catalog);
  const normalized = normalizeObservations(resolved, catalog);
  const graph = buildCaseMetabolicGraph(normalized, catalog);
  const features = calculateApplicableFeatures(normalized, graph, catalog);
  const comparisons = references
    ? compareFeaturesToReferences(features, validated, references)
    : [];
  const similarCases = references
    ? findSimilarReferenceCases(features, validated, references)
    : [];
  const hypotheses = resolveSourceCompatibility(
    normalized,
    graph,
    features,
    comparisons,
  );

  return assemblePatternAnalysis({
    normalized,
    graph,
    features,
    comparisons,
    similarCases,
    hypotheses,
  });
}
```

The first deterministic calculations should run synchronously unless profiling shows a need for a worker. Large reference/similarity operations may later move to a Web Worker via Comlink — but never to a server endpoint, for the reasons in section 41.1.

## 26. Pattern analysis result

```ts
export interface PatternAnalysisResult {
  normalizedObservations: ResolvedPatternObservation[];
  metabolicGraph: PatternGraphResult;
  features: PatternFeatureResult[];
  comparisons: PatternReferenceComparison[];
  similarCases: PatternSimilarCase[];
  sourceHypotheses: PatternSourceHypothesis[];

  findings: PatternFinding[];
  warnings: PatternWarning[];

  quality: PatternAnalysisQuality;
  manifest: PatternRunManifest;
}
```

## 27. Quality and trust model

Do not compress all validity into one arbitrary grade.

Track separate domains:

```text
chemical identity
assay measurand clarity
analytical overlap resolution
panel coverage
urine dilution information
matrix compatibility
source specificity
temporal information
reference cohort match
postmortem denominator stability
```

Each domain:

```text
supported
limited
insufficient
blocked
```

Then derive three separate top-level statuses:

```text
calculationStatus
comparisonStatus
inferenceStatus
```

Examples:

- a ratio may be `calculationStatus: supported` while `comparisonStatus: unavailable` because no reference cohort exists;
- a lineage sum may be `blocked` because total-after-hydrolysis overlaps with a direct conjugate result;
- a source inference may be `limited` despite perfectly measured concentrations because the relevant metabolites are shared among several parent drugs.

Use a weakest-link rule within each derived conclusion. Do not average severe limitations away.

## 28. Findings contract

Every generated interpretation should declare which reasoning level it belongs to.

```ts
export interface PatternFinding {
  id: string;

  level:
    | 'measurement'
    | 'calculation'
    | 'reference_comparison'
    | 'compatibility_inference';

  titleKey: string;
  statementKey: string;
  statementParams?: Record<string, unknown>;

  supports: PatternEvidenceItem[];
  contradicts: PatternEvidenceItem[];
  alternativeExplanations: string[];

  strength:
    | 'strong'
    | 'moderate'
    | 'limited'
    | 'indeterminate';

  limitations: PatternWarning[];
  referenceIds: number[];
}
```

The UI should visibly group these levels.

Example:

```text
MEASURED
Morphine was quantified in femoral blood.

CALCULATED
The urinary morphine-lineage / blood morphine ratio is >X.

REFERENCE COMPARISON
The value lies toward the upper part of the matched reference distribution.

COMPATIBILITY INFERENCE
The pattern is compatible with a metabolically mature exposure.

NOT ESTABLISHED
The available observations do not distinguish one older intake from repeated exposure.
```

## 29. Postmortem operating mode

Postmortem analysis must use a separate reference context.

Required PM metadata when available:

```text
blood sampling site
postmortem interval
preservative
decomposition
storage
bladder urine volume
resuscitation context
```

Rules:

- living reference cohorts must not be automatically pooled with PM cases;
- femoral and cardiac blood must remain distinguishable;
- PM/AM ratio data may inform warnings/reference context but must not be used as an individual back-correction factor;
- existing PM/AM and postmortem redistribution parameters remain separate concepts;
- any future postmortem source/timing model must carry its own validation status and reference set.

## 30. User interface

### 30.1 Modeling navigation

Keep `/modeling` as the existing Simulation workspace.

Add a sibling route or stable workspace selector for Case Pattern, recommended:

```text
/modeling/pattern
```

Suggested changes:

```text
src/router.tsx
src/pages/ModelingPage.tsx
src/pages/PatternCasePage.tsx
src/components/modeling/ModelingWorkspace.tsx
src/components/modeling/ModelingModeTabs.tsx
```

`ModelingWorkspace` should accept a mode rather than hard-code `data-modeling-mode="simulator"`.

### 30.2 Input workflow

Recommended sequence:

1. Create/add specimen.
2. Select matrix and optional specimen metadata.
3. Add analytes to that specimen.
4. Enter result, unit, qualifier, and analytical method when known.
5. For urine, optionally enter creatinine, SG, pH, volume, and timing.
6. Repeat for other specimens.
7. Kinetix automatically discovers relevant metabolic neighborhoods and applicable curated features.

### 30.3 Analytical-method-assisted entry

Where the user has access to analytical methods, allow selecting a method to pre-populate its analyte panel and method metadata.

This is particularly useful for laboratory workflows because it makes "not measured" distinguishable from "measured and negative".

Do not expose method-gated data to users who do not already have `methods.read` access.

### 30.4 Case Fingerprint

Default result overview:

- rows: analytes grouped by lineage;
- columns: specimens/matrices;
- cell/marker size: log molar concentration;
- symbol shape: quantified/censored/qualitative;
- outline or secondary indicator: reference position where available;
- hover: raw result, molar value, method, uncertainty, qualifiers, specimen metadata.

A textual accessible table must accompany the graphical view.

### 30.5 Metabolic Pathway Map

Display detected and relevant upstream/downstream analytes in the metabolism graph.

Recommended encoding:

- node = chemical/drug entity;
- node mini-rings = specimen/matrix concentrations;
- node size = log molar concentration or selected normalized metric;
- arrow = known metabolic relation;
- line style = source specificity / evidence role;
- unmeasured relevant nodes visible but visually distinct.

Do not use edge width as metabolic flux unless a validated mechanistic model explicitly estimates flux.

The first implementation can be constrained custom SVG. Do not add a large graph-layout dependency unless the fixed layout proves insufficient.

### 30.6 Ratio Atlas

For every applicable curated feature, render:

- raw fold ratio;
- log10 value;
- bound/interval if censored;
- individual reference points, or a reference distribution where `n` justifies one;
- matched reference n;
- evidence tier;
- matched-context description;
- percentile/fold-from-median only when allowed by data quality.

The default rendering is a dot strip of individual published observations against the case value, with each point linking to its citation and source locator. This is the honest presentation for the sample sizes the published-only atlas will actually yield, and it is what most features will use most of the time.

Smooth distributions are an upgrade applied only when the matched `n` clears the section 21.4 thresholds. Plotly is already available and should be reused for violin/density/scatter rendering in that case; it should not be the first thing built.

Build order for this panel: case value and formula, then individual reference points, then distributions where earned.

### 30.7 Matrix Enrichment / "Now versus accumulated" view

When a validated reference model exists, offer a reference-normalized two-axis plot such as:

```text
x = standardized blood parent/systemic feature
y = standardized urinary lineage burden
```

Quadrant labels must be phrased as compatible patterns rather than deterministic timing labels.

### 30.8 Reference phase/scatter explorer

Allow selected feature pairs to be plotted against individual reference cases.

Examples:

```text
x = blood metabolite/parent log ratio
y = urine-lineage/blood-parent log ratio
```

If controlled-dose timing is available, connect points from the same subject or show a time-conditioned trajectory/envelope.

This can be more informative than a one-dimensional percentile for kinetic phase.

### 30.9 Similar Cases

Show the most similar context-compatible cases as small-multiple fingerprints.

Each card should show:

- cohort/source;
- context match;
- shared-feature coverage;
- distance score;
- known exposure history where published;
- important differences from the user's case.

### 30.10 Source Resolver

Render candidate exposure sets with separate evidence rows, not one opaque score.

Example structure:

```text
Morphine only
  Graph coverage                 complete
  Source-specific support        none
  Quantitative compatibility     good
  Unexplained finding            codeine lineage in urine

Codeine only
  Graph coverage                 complete
  Quantitative compatibility     limited
  Important tension              blood morphine/codeine pattern

Morphine + codeine
  Graph coverage                 complete
  Quantitative compatibility     good
  Additional source required     yes
```

### 30.11 Next Best Test

First release can be rule-based.

For unresolved hypotheses, identify an unmeasured analyte/specimen that has strong discriminatory value according to curated feature/source-marker definitions.

Future implementation may use expected information gain, but no information-theoretic score is needed for the first slice.

### 30.12 Sandbox cases

An empty tool teaches nothing. A toxicologist opening Case Pattern for the first time should find worked examples already there, and should be able to push the numbers around and watch what moves — that is how the relationship between a parent/metabolite ratio and a plausible exposure history becomes legible, and it is not something a static screenshot conveys.

**Seeded coverage.** Ship a sandbox case for every substance that has known metabolites *and* is routinely analysed. Both halves are already derivable from repository data rather than a hand-curated wish list:

```text
a parent P qualifies when
  P is a component of an analytical method (blood and/or urine)
  AND there exists an edge P -> M in `drug_metabolites` where
        M.metabolite_drug_id IS NOT NULL          -- resolved, not free text
    AND M is itself a component of an analytical method
    AND P and M are measurable in matrices the case can pair
```

Both ends have to be measurable, not just the parent. `drug_metabolites.metabolite_drug_id` is nullable while `metabolite_name` is not, so an edge can name a metabolite in free text alone; and a resolved metabolite may still be something no method measures. Either way the parent would qualify on a naive intersection and produce a template with nothing to form a ratio against — an example case that teaches the opposite of the intended lesson.

That intersection is the working definition of "frequently analysed with known metabolites", it regenerates as the catalog grows, and it keeps the seed honest — a substance nobody measures does not get an example case merely because its metabolism is documented. Each case carries the parent and its metabolites in the matrices the methods actually cover, at concentrations drawn from published values where the atlas has them and from plausible illustrative values otherwise, **labelled as to which**.

**Editing, without breaking the layering.** Section 47 requires raw observations, derived facts, reference placement and inference to stay computationally separate. Sandbox editing must not dissolve that, so:

- **Concentrations remain the only authoritative input.** Editing one recomputes every feature, exactly as in a real case.
- **A ratio is editable as a solve, and only where the solve is unique.** Editing a ratio does not store a ratio; it back-solves a concentration and stores *that*, with the user choosing which side is pinned. The derivation chain is preserved and the edited value is still a real observation with a real unit. A ratio that cannot be solved to a non-negative concentration is refused rather than clamped.

  Solve-editing is offered **only when each side of the feature resolves to exactly one observation.** A composite numerator such as `(M3G + M6G) / morphine`, or a cross-matrix lineage ratio, leaves the unpinned side underdetermined — many concentration vectors satisfy the same ratio, and picking one would mutate the case arbitrarily while looking authoritative. Those features render read-only in the sandbox with their inputs editable individually, which reaches the same place without inventing a distribution across the terms. Proportional scaling of a composite side is a defensible future affordance, but it is a *choice* about how the sum divides and must be presented as one rather than smuggled in as a solve.
- **Inferences are editable as an override layer.** The engine's conclusion is always computed and always retained; a human edit sits beside it, visibly attributed, never replacing it in storage.

  Overrides persist in their own table rather than inside the case JSON, for two independent reasons. `analysis` is regenerated on every recompute, so an override stored there would be silently erased by the next run. And `caseData` is accepted as opaque caller-supplied JSON (`z.record(z.string(), z.unknown())`), so an `authorUserId` written into it is whatever the client chose to send — an attribution the UI presents as an expert's name while the server never verified it. That is worse than no attribution, in a document whose whole subject is knowing where a claim came from.

```text
pattern_inference_overrides
  id
  case_id                 -- FK to simulator_cases ON DELETE CASCADE; owner-scoped
                          -- with the case. The existing DELETE path removes the
                          -- case row directly and cleans up no children, so a
                          -- restricting FK would make any case with an override
                          -- undeletable.
  finding_id
  statement               -- the expert's text
  superseded_statement    -- the engine's text at the time of override
  note
  author_user_id          -- STAMPED SERVER-SIDE from the session; never read
                          -- from the request body
  created_at              -- stamped server-side
```

  Attribution and timestamp are derived from the authenticated request and any client-supplied value is ignored. Each override keeps the engine text it superseded, so the pair stays inspectable after the engine's own conclusion has moved on. An overridden inference is rendered as the expert's text with the engine's original one inspectable next to it, and it never feeds back into any computation — not into similar-case ranking, not into source resolution, not into a manifest.

The reason to allow the override at all is that the toxicologist is the expert and the engine is a first-pass instrument; the reason to constrain it this way is that an edited conclusion which looked machine-derived would be the single most dangerous artifact this document could produce.

**Sandbox cases are not evidence.** They carry an explicit `sandbox: true` marker and:

- never enter the reference atlas, under the one-way rule of section 18.0 — they are user-side cases and that route is already closed;
- never appear in the Similar Cases pool, including for other sandbox cases;
- never contribute to any `n`, percentile, or distribution;
- render with a persistent visual marker that survives printing and export, so a screenshot of a sandbox fingerprint cannot be mistaken for a case.

The illustrative concentrations are the hazard here: a plausible number invented for teaching is indistinguishable from a measured one once it leaves the screen. The marker is what keeps it distinguishable, and it is a requirement rather than a nicety.

**Storage: server-side templates behind the method gate, cloned on open — not seed rows, and not a client fixture.** `simulator_cases.created_by` is `NOT NULL` and every read path filters on it, so a seeded row belongs to exactly one account and no other user would ever see it. Per-user seeding is worse: it multiplies rows, drifts as the catalog changes, and gives new accounts nothing until a backfill runs.

Templates are therefore generated rather than seeded — but they must not be shipped to the browser. Eligibility is computed from analytical-method membership and matrix coverage, so a template set discloses **which parent/metabolite pairs are measured and in which matrices**, which is exactly the method data gated to admins and the `rettstoks` group. AGENTS.md is explicit: do not ship method fallbacks in client bundles. A committed fixture imported by client code would hand that gated fact to every account.

```text
data/patternSandboxCases.ts            -- generated, committed, SERVER-SIDE ONLY
scripts/generate-pattern-sandbox-cases.ts
api/pattern/sandbox-templates.ts       -- gated exactly as /api/methods is
```

The templates are served through an endpoint carrying the same admin/`rettstoks` check as `/api/methods`, never imported into a client bundle. Callers without that access get an empty set and no indication of what they are missing — a count or a substance list would leak the same fact more quietly. That audience restriction is not a compromise: Case Pattern is a forensic-toxicology surface whose users are already the method-data audience, and the alternative — generating examples from `drug_metabolites` alone, with no notion of what is actually measured — would produce cases for analytes nobody runs, which is the opposite of the intent.

Opening a template renders it from the API, read-only and owned by nobody. The first edit clones it into an ordinary `simulator_cases` row owned by the editing user, carrying `sandbox: true`, at which point normal ownership applies. Every user with access gets the full set with no provisioning, new accounts included; the generator regenerates as `drug_metabolites` and the method catalog grow, and the diff is reviewable because it is a committed file rather than a migration's side effect.

**Where it lands.** Sandbox cases need the feature engine, so they arrive with Phase 2 — concentrations, ratios, fingerprint and pathway map, all editable. The inference override layer arrives with Phase 5, when there are inferences to override.

## 31. Opioid first vertical slice

Start with a bounded set that exercises shared metabolites, source-specific markers, conjugation, and several parent/metabolite families.

### 31.1 Heroin / morphine / codeine

Candidate analytes:

```text
heroin
6-MAM
morphine
M3G
M6G
codeine
C6G
```

Initial curated features:

```text
blood morphine/codeine
urine morphine/codeine
urine morphine-lineage/codeine-lineage
(M3G + M6G) / morphine
M3G / M6G
urine morphine / blood morphine
urine morphine-lineage / blood morphine
6-MAM presence/absence-with-panel-context
```

### 31.2 Hydrocodone / hydromorphone

```text
hydrocodone
norhydrocodone
hydromorphone
```

Features:

```text
norhydrocodone/hydrocodone
hydromorphone/hydrocodone
hydromorphone/morphine where relevant to morphine-source hypotheses
```

### 31.3 Oxycodone

```text
oxycodone
noroxycodone
oxymorphone
noroxymorphone
```

Features:

```text
noroxycodone/oxycodone
oxymorphone/oxycodone
noroxymorphone/oxycodone
noroxycodone/oxymorphone
observed oxycodone-lineage/oxycodone
```

### 31.4 Fentanyl

```text
fentanyl
norfentanyl
```

Features:

```text
norfentanyl/fentanyl in blood
norfentanyl/fentanyl in urine
urine norfentanyl/blood fentanyl
```

The feature registry must support references and context-specific applicability for every item rather than treating these lists as universal rules.

## 32. Second vertical slice: diazepam family

Use the benzodiazepine family as the first stress test after opioids because it exercises:

- long-lived metabolites;
- metabolites that are also administered drugs;
- shared precursor relationships;
- hydrolysis/conjugation semantics;
- source ambiguity.

Initial analytes:

```text
diazepam
nordazepam
temazepam
oxazepam
relevant glucuronides when represented in the catalog
```

The default source output should use a family scope when source attribution is not unique.

## 33. Other planned substance modules

After the generic engine is stable:

```text
methamphetamine / amphetamine / chiral fractions
lisdexamfetamine / amphetamine
cocaine / benzoylecgonine / ecgonine methyl ester / cocaethylene
THC / 11-OH-THC / THC-COOH and serial urine
tramadol / O-desmethyltramadol / N-desmethyltramadol
venlafaxine / ODV / NDV
methadone / EDDP
buprenorphine / norbuprenorphine / conjugates
GHB with separate endogenous/postmortem rules
```

Each module should be data-driven through the same feature/reference contracts rather than bespoke UI logic.

## 34. Reference-data ingestion and governance

### 34.1 Source of truth

Reference-case rows must link back to the existing Kinetix citation system.

A cohort import should record:

- citation;
- exact source locator for transcribed values;
- whether values came from article tables, supplementary data, or an external dataset;
- dataset URL and hash where applicable;
- transformation notes;
- importer/version.

### 34.2 Individual data preferred

For ratio distributions and nearest-case matching, prefer individual-level paired observations.

Aggregate studies remain useful, but must remain a different evidence tier.

### 34.3 Import path

**Curation is an admin operation in the first implementation.** Reference cases are entered and imported by administrators, not proposed by agents and not contributed by users. That keeps the trust argument short: the person who admits data to the atlas is the person accountable for it, and there is no automated author whose output needs gating.

Two write paths, both admin-only:

```text
1. admin entry / cohort admission -> creates a pattern_reference_cohorts row,
                                     stamped with the admitting admin and time
2. admin bulk import              -> creates cases, specimens, exposures and
                                     observations under an admitted cohort
```

No other route may write `pattern_reference_*`. Agents have no path to the atlas in this design, and users never do (section 18.0).

**What admission must record.** Every cohort carries `citation_id`, `authorized_by` and `authorized_at`, all `NOT NULL` (section 18.1). Since every case, specimen, exposure and observation reaches the atlas through a cohort, that makes unattributed reference data unrepresentable rather than merely discouraged.

**Bulk import must be bound to the dataset that was admitted, not just to the cohort.** A cohort id alone would let an operator load a different file, a newer revision, or output from a changed transformation while satisfying every stated rule. Before persisting anything the importer must recompute the dataset hash from the bytes in hand and match it, together with importer version, transformation version and dataset URL, against the values recorded at admission. Any mismatch aborts with nothing written.

A revised dataset is a **new admission**, not a re-run against the old one — a revision is evidence nobody has looked at yet. Admission values are immutable once recorded; a comparison against editable values verifies nothing.

**Provenance granularity.** Every entity carrying transcribed values has its own `source_locator` (sections 18.2–18.5), because one reference case is routinely assembled from several places in a paper: dose from a methods table, timing from a figure caption, postmortem interval from the narrative, concentrations from a results table.

New files:

```text
src/lib/pattern/referenceImport.ts
api/_lib/patternReferenceStore.ts
scripts/import-pattern-reference.ts
```

Reuse the existing citation store and PubMed tooling for identifying and binding sources. The importer should be idempotent by cohort/source record identity, not by numeric value.

**Curation throughput is the rate limit on this entire feature.** Plan the reference slice as a curation programme with an owner, not as an engineering task that completes.

#### Deferred: agent-assisted extraction

Automating extraction would remove the admin-only property the design above depends on, so it is out of scope until deliberately revisited. The repository already has the pieces — the paper-extraction queue, the PDF rail, citation binding, PubMed tooling — but wiring them to the atlas requires more than pointing them at it.

Preconditions, all of which must land together before any agent is given this path:

- **A reviewable artifact.** `paper_extraction_jobs` deliberately stores no extracted content, and `pending_edits.edit_type` has no member able to carry a paired structured observation set — the extractor emits `wiki_fact`, a prose fact anchored to a wiki page. A staging edit type would be needed, named to fit `varchar(20)` or shipped with a widening migration.
- **A typed job output target.** Nothing on a job selects what it produces. `scope_note` cannot carry it: it is editor steer treated as data, never as instruction, so routing must not depend on it.
- **Three separate agent guards, not one.** Agent write-authority is granted by default and revoked per type in three places: `applyOnAgentConsensus` auto-applies at quorum; a self-review-enabled agent may approve its own edit; and an active agent may moderate another agent's edit — the existing peer-agent guard blocks agents from deciding *human*-submitted edits only, by design. Only `clinical_case` is currently exempt from all three. Any atlas edit type would need all three, with regression tests for each.

The last point generalizes beyond this feature: an opt-out list replicated across three call sites means "this type needs a human" has to be remembered three times, and nothing prompts the next person adding a type to consider it. Worth consolidating into one per-type declaration if agent involvement here is ever revisited.

### 34.4 Citation review

A reference cohort may only be admitted from a source whose relevant methods and results have been reviewed in full under the existing citation governance system. This is a condition of the write path, not a recommendation to the operator — reference data drives inferential displays, and a percentile computed from a paper nobody read in full is exactly the kind of claim this document exists to prevent.

Bind the citation to the cohort at admission and check its review state there. Leaving it to operator discipline puts the atlas outside the citation gate that the rest of the system enforces.

Operator seed/import tooling may use the same deliberate admin/operator pattern as existing curated seeders, but must keep provenance and never silently create a duplicate citation for the same paper.

## 35. APIs

Initial API surface:

```text
GET /api/metabolism-graph?module=<id>          -- never by case-derived drug ids (41.1)
GET /api/pattern/reference-cohorts
GET /api/pattern/reference-cases
GET /api/pattern/reference-features
```

**There is deliberately no `POST /api/pattern/analyze`, `/similarity` or `/source-resolver`.** Earlier drafts listed them as possible later APIs. Any endpoint of that shape must receive observations or derived features to do the thing its name promises, so shipping one would violate section 41.1 by construction — and having it listed as a future option is an invitation to build it the first time client-side performance disappoints. Those three are client libraries in `src/lib/pattern/*`, not routes.

The deterministic engine runs client-side, and must (section 41.1). Server endpoints serve reference data *to* it; they never receive case values.

Case CRUD continues through:

```text
/api/simulator/cases
```

with `kind=pattern-case` for listing.

## 36. State management

Create a dedicated store:

```text
src/stores/patternCaseStore.ts
```

Do not place pattern specimens and observations inside `useSimulatorStore`.

The two workspaces may share generic case-navigation/persistence helpers later, but their domain states are structurally different.

Suggested state:

```ts
interface PatternCaseState {
  caseId: number | null;
  caseName: string;
  data: PatternCaseData;
  analysis: PatternAnalysisResult | null;
  analysisStale: boolean;
  isAnalyzing: boolean;
  savedCases: PatternSavedCaseMeta[];
}
```

Input mutation must mark derived analysis stale using an input hash comparable to the existing modeling result-staleness approach.

## 37. Run manifest and reproducibility

Every analysis snapshot should include:

```ts
export interface PatternRunManifest {
  inputHash: string;
  createdAtIso: string;
  appVersion?: string;

  patternEngineVersion: string;
  featureRegistryVersion: string;
  /** Mandatory: both affect results, so both gate staleness. See below. */
  metabolismGraphVersion: string;
  assaySemanticsVersion: string;

  referenceDatasetVersions: Record<string, string>;
  sourceResolverVersion?: string;

  normalizationConfig: {
    creatinineReferenceMmolL: number;
    specificGravityReference: number;
  };
}
```

If the user reopens a saved analysis after a feature or reference version changes, show the old snapshot as stale and offer recomputation. Do not silently replace the historical result.

**Every dependency that can change a result carries a mandatory version.** Metabolism edges and analytical-method semantics are both editable through their own review workflows, and editing either can change lineage sums, feature values, or source hypotheses on recomputation. If those versions were optional, a manifest that omitted them would pass the staleness check while describing a computation that can no longer be reproduced — which is precisely the guarantee this section exists to make. `metabolismGraphVersion` and `assaySemanticsVersion` are therefore required, not optional.

The remaining optional fields are optional because they are genuinely inapplicable rather than merely absent: `sourceResolverVersion` is unset when no source resolution ran, and `appVersion` is descriptive. A field that is inapplicable must be distinguishable from one that was never recorded; where that distinction cannot be made, the field belongs in the mandatory set. The alternative to a mandatory version is embedding the exact graph and assay definitions in the snapshot — acceptable, but strictly more expensive.

## 38. Privacy and security

User-entered forensic case data remains private to the case owner under the existing simulator-case ownership checks.

**User case data and reference data are separate populations that never mix.** Data flows one way only: reference data may be read into a case analysis; case data never flows into the reference atlas. There is no aggregation, anonymization, or opt-in path that makes the reverse direction acceptable, because the constraint is regulatory rather than technical. See section 18.0.

Do not store names, national identifiers, case-person identifiers, or other patient/decedent PII in the reference atlas.

The shared reference atlas should contain only deidentified publication/dataset-local subject keys and scientific metadata drawn from published sources.

Analytical-method access restrictions must continue to use the existing permission/group logic.

## 39. Internationalization and accessibility

All user-facing strings ship in both:

```text
src/locales/en.json
src/locales/nb.json
```

Charts must have accessible textual/table alternatives.

Color must never be the only encoding for:

- quantified versus censored;
- source-specific versus shared metabolite;
- supported versus limited comparison;
- living versus postmortem reference data.

## 40. Validation and test strategy

### 40.1 Unit/chemical invariants

Tests must prove:

1. ng/mL, µg/L, mg/L and molar equivalents yield identical canonical molarity.
2. Same-analyte urine/blood ratio is unchanged by converting both matrices between equivalent mass/molar units.
3. One mole of a directly measured conjugate contributes exactly its configured lineage molar equivalent.
4. Missing molecular weight blocks cross-kind conversion rather than guessing.

### 40.2 Censoring invariants

5. Quantified numerator / `<LOQ` denominator produces a lower ratio bound, never infinity.
6. `<LOQ` numerator / quantified denominator produces an upper bound.
7. Two censored values return only mathematically defensible bounds.
8. Qualitative results never enter quantitative sums without a response model.

### 40.3 Assay overlap invariants

9. Direct glucuronide plus hydrolysed total is not double-counted.
10. Unresolved overlapping measurands downgrade/block lineage totals.
11. Hydrolysis recovery uncertainty propagates into derived intervals when modelled.

### 40.4 Source/lineage invariants

12. Strict source-specific lineage is never larger than compatible family lineage.
13. A shared metabolite cannot by itself become a unique-source marker.
14. A negative source marker is not used as evidence if it was not measured.
15. A negative source marker is not used as strong evidence if method sensitivity/timing makes the negative non-informative.

### 40.5 Reference invariants

16. Antemortem and postmortem reference cohorts never pool without an explicit model that permits it.
17. Ratio of study means is never treated as an individual ratio distribution.
18. Feature percentiles use only compatible feature versions and assay semantics.
19. Small-n rules suppress unsupported percentile precision.
20. Similarity scores report feature coverage and cannot rank on zero shared features.

### 40.6 Reproducibility invariants

21. Same raw case + same registry/reference versions produces identical deterministic feature output.
22. Changing a feature definition or reference dataset version marks saved results stale.
23. Every displayed feature can enumerate the raw observations and definition that generated it.
24. Every excluded analyte/result has a machine-readable exclusion reason.

### 40.7 Reference provenance and separation invariants

These enforce section 18.0 and must fail loudly rather than warn.

25. A `pattern_reference_cohorts` row cannot be created without a `citation_id`; the database rejects it, not only the application layer.
26. No code path reads from `simulator_cases` and writes to any `pattern_reference_*` table. Assert this structurally, in the same spirit as the existing write-route security tests, so a future contributor cannot add one silently.
27. The similar-case candidate pool contains only reference-atlas rows. A case belonging to any user is never returned as a similar case.
28. No reference percentile, distribution, count, or `n` displayed to a user includes a value that originated from user-entered case data.
29. Reference imports carry citation, source locator, and importer version; a row lacking provenance cannot back an inferential display.
30. A `pattern_reference_*` row can only be written by the two admin paths in section 34.3: cohort admission, or bulk import under an already-admitted cohort. No agent route writes atlas rows at all, and no user route ever does.
31. Every `pattern_reference_cohorts` row carries a non-null `authorized_by` and `authorized_at`, and the importer cannot create a cohort — it resolves an admitted one or fails. Since all atlas rows hang off a cohort, unattributed reference data is unrepresentable rather than merely forbidden.
32. A bulk import aborts with nothing written when the recomputed dataset hash, importer version, transformation version, or dataset URL differs from the values recorded at admission. Resolving a cohort id is not sufficient — the bytes imported must be the bytes admitted — and those values are immutable once recorded.
33. Every entity carrying transcribed values — case, exposure, specimen, observation — has its own `source_locator`. A value whose origin cannot be located in the source cannot be persisted.
34. Cohort admission requires its citation to have been reviewed in full, enforced at the write path rather than left to operator discipline.

### 40.8 Property-based tests

Use `fast-check` for:

- positive scaling invariance of raw ratios;
- unit round trips;
- monotonicity of one-sided bounds;
- lineage sums remaining non-negative;
- no duplicate species in a resolved non-overlapping sum.

### 40.9 Identity, time, and version invariants

Numbered from 35 so the existing invariant numbers, which are cited elsewhere in this document, stay stable.

35. `detected_below_limit` and `below_limit` round-trip as distinct qualifiers unconditionally. Where a lower limit is also cited they produce distinct intervals, and neither acquires nor loses a lower bound it was not given. Where none is cited both are `[0, X)` and the qualifiers still differ, so a lower limit arriving later tightens the interval without re-entering the result.
36. A censored observation carries, and round-trips, the `PatternLimitRef` it was reported against, with the label verbatim from the source — a saved `<X` that cannot say what X was is unresolvable, and a method offering three thresholds makes that ambiguity ordinary rather than rare. Assert that no code path infers a limit from a column's name and that `lod`, `lor` and `mkk` are never renamed to LOD/LOQ/LOR in storage or display — seed from Paracetamol (`Påvisn. 10`, `Terskel 100`), where any global mapping produces a bound wrong by tenfold in one direction or the other. A component whose limits fall in an unexpected order is displayed with its labels, not rejected: 34 catalog components would otherwise vanish. Every limit — case override or `pattern_reference_observations` row — is converted from its stored unit into the observation's basis before a bound is built, and a limit with no unit, or needing an unavailable conversion, yields no bound rather than a raw number. Seed that from a µmol/L limit against a ng/mL result, which no ordering check can catch. No resolved interval has `low >= high`.
37. A case cannot be persisted without a `timeOrigin`, and the origin consistency rules in section 7.3 hold. Reference cohorts carry one too: admission without an origin fails, and importing a case with any relative-hour value under an unset effective origin writes nothing. Time-conditioned matching across incompatible origins is refused and falls back to the untimed comparison; it never assumes a shared zero.
38. Registry load fails loudly when any authoritative identity fails to resolve — a `pubchemCid`, a `PatternCohortRef`, or a citation ref. A cohort ref resolves only when citation, dataset hash, transformation version, importer version and subgroup key all agree, so the same registry entry can never bind to different reference populations in two installations. Two admissions of the same bytes under different transformations are distinct cohorts and must not both match one ref; assert this with `subgroup_key` at its `''` default, where a nullable column would have permitted duplicates. A stale `slug` hint warns and does not fail, and a rename that changes a drug's slug leaves every feature naming it still loading. A citation named by DOI still resolves after its row is promoted to a PMID and the DOI moves to `metadata.altIds`, so a citation merge never fails a load. Assert structurally that no numeric database id appears in registry source, in the same spirit as the existing write-route tests.
39. A feature whose matched reference values have `MAD = 0` is excluded from the similarity distance and counted as missing in reported feature coverage. No case distance is ever `NaN` or `Infinity`.
40. A run manifest without `metabolismGraphVersion` and `assaySemanticsVersion` is rejected. Changing either marks saved results stale, exactly as a feature-registry or reference-dataset version change does.

### 40.10 Sandbox and aggregate-tier invariants

41. `sandbox` survives the full save/load round trip as part of the validated case contract — a schema that strips it silently converts a teaching artifact into apparent evidence. A sandbox case never reaches the reference atlas, never appears in the Similar Cases pool — including for another sandbox case — and contributes to no `n`, percentile, or distribution. Assert the atlas half structurally, alongside the existing user-case write-route test. Templates are served only through the admin/`rettstoks` gate that covers method data and never appear in a client bundle; an account without that access receives an empty set, with no count or substance list that would leak method coverage. Every user with access sees the full set without provisioning, including a newly created account, and a template is owned by nobody until an edit clones it.
42. An inference override round-trips through save and reload, survives a recompute that changes the underlying finding, and retains the superseded engine text. Its `author_user_id` and `created_at` come from the authenticated session — assert that a request supplying either is rejected or has them overwritten, since an attribution the UI renders as an expert's name must never be a value the client chose. Editing a sandbox ratio stores a concentration, never a ratio: the derivation chain from raw observation to feature is intact after the edit, and a ratio with no non-negative solution is refused rather than clamped. Solve-editing is offered only where both sides resolve to exactly one observation; a composite feature such as `(M3G + M6G) / morphine` is read-only rather than distributing an edit across its terms. An overridden inference is stored beside the engine's, never in place of it, and appears in no computation — similarity, source resolution and the run manifest are byte-identical with and without the override.
43. No individual percentile, and no case-level distribution, is ever computed from `pattern_reference_aggregates`. Aggregates and individual observations never pool into one statistic. A feature-level aggregate row exists only where the study reported that feature directly; deriving one by dividing two concentration aggregates is rejected at import, which is invariant 17 enforced at the write path rather than the read.
44. Every statistic over matched references — percentile, fold-from-median, robust z, and the standardization behind the similarity distance — is computed over quantified references only, labelled as such wherever shown, and carries the same quantified and censored counts. The suppression tests gate them together: quantified `n < minQuantifiedN`, or `censored * denominator >= total * numerator` (defaults 5 and 1/3, section 21.1). Assert that a feature failing them yields none of the four rather than some, and assert the exact boundary in both directions — 33 censored of 100 renders, 34 of 100 suppresses — which is where a `0.33` decimal and a true third disagree. Also assert the 4-of-11 case, which fails both tests. Censored references still render as bounds on the Ratio Atlas when excluded from the statistic.
45. No case-derived value reaches an **analysis or compute** endpoint. Persistence is the deliberate exception: `/api/simulator/cases` stores the case, including observations and the optional `analysis` snapshot, under existing per-owner controls (section 41.1). Assert structurally that `src/lib/pattern/*` computation is never invoked from an API handler, and that no endpoint other than case persistence receives an observation value, a feature value, or a case input hash. Reference, method and metabolism-graph fetches are keyed by substance module or method, never by the analyte set of an open case, so neither a network trace nor an access log can reconstruct which analytes a case contains. Assert this for `/api/metabolism-graph` specifically, whose natural signature would have been the case's drug ids.

## 41. Performance targets

For a normal case with fewer than 50 observations and a metabolic neighborhood below a few hundred nodes:

- deterministic normalization/feature calculation should feel instantaneous;
- graph/reference requests should be batched;
- no per-analyte network waterfall;
- expensive similarity/reference work may be memoized by case input hash and reference version;
- pathway rendering must virtualize or collapse distant nodes when a graph becomes large.

No worker should be introduced merely by convention. Profile first.

### 41.1 Case values never leave the browser

Every calculation over user-entered concentrations runs in the browser: normalization, molar lineage sums, censoring intervals, features and ratios, reference placement, similarity, and source resolution. No case-derived value is sent to a server to be computed on. The arithmetic is cheap enough that this costs nothing — the constraint is on where data flows, not on how hard the sums are.

The math is the easy half. The part that needs care is that **a query can disclose a case without carrying a single number.**

- **Fetch reference data, method limits and the metabolism graph by module, not by case** (modules defined in section 16.6). Asking the server for "reference observations for morphine, M3G and M6G in femoral blood" reveals the analyte panel of an open case even though no concentration crossed the wire. In forensic work that panel is sensitive on its own. Reference data is therefore requested at substance-family granularity — the opioid module, the benzodiazepine module — and filtered client-side. Section 21.5 makes this affordable: these cohorts are small by construction, so a module fetch is a modest payload rather than a database dump.
- **Fetch method limits the same way.** Censoring bounds need the analyte's thresholds in the browser (section 9.1), which is permitted for gate-holding users through the existing `/api/methods` route — the AGENTS.md prohibition is on shipping method fallbacks in client *bundles*, not on an authorized runtime fetch. Do not "solve" this by moving censoring server-side.
- **Memoize locally.** The input-hash memoization above is client-side only. A hash of a case's concentrations is a stable fingerprint of that case; sending it to a shared cache would leak correlation across sessions even though the values stay hidden.
- **Keep the manifest local.** Run manifests hash case inputs (section 37). They are computed and compared in the browser.

**What this does not cover, and should not be mistaken for.** Cases are persisted through `/api/simulator/cases`, so raw observations already reside on the server under the existing per-owner access controls — the same arrangement the current simulator uses. Client-side computation prevents case values from reaching *analysis* endpoints, logs and third-party compute; it does not make a case invisible to its own installation. If the intent is stronger than that — local-only cases, or client-side encryption at rest — it is a separate piece of work with real consequences for save, reload and the run manifest, and it should be decided explicitly rather than assumed to follow from this section.

Phase 7's mechanistic scenario inference is the one place a server model is contemplated (section 42). When that lands it must either run on the same client-side boundary or be an explicit, separately-consented step, because it would otherwise transmit exactly the values this section keeps local.

## 42. Phased implementation

### Phase 1 - Pattern case foundation

**Goal:** enter, save, reload, and normalize a multi-specimen case without interpretation.

Build:

```text
src/types/patternCase.ts
src/lib/pattern/schemas.ts
src/lib/pattern/resolveObservations.ts
src/lib/pattern/normalize.ts
src/lib/pattern/censoring.ts
src/stores/patternCaseStore.ts
src/pages/PatternCasePage.tsx
src/components/modeling/pattern/PatternInputRail.tsx
src/components/modeling/pattern/CaseFingerprint.tsx
src/lib/patternCases.ts
router/workspace/i18n changes
```

Reuse `/api/simulator/cases` with `kind: pattern-case`.

Limits are carried under the source's own labels and never reclassified (section 9.1). A censored result stores the threshold it was reported against; resolution reads that, never a column name.

Acceptance:

- multiple specimens and analytes can be entered;
- raw results survive round trip exactly;
- valid results display canonical molar equivalents;
- censored values are represented as bounds;
- detected-below-LOQ and bare `<LOQ` stay distinguishable after save and reload (section 9);
- a censored result records which threshold it was reported against and resolves from that stored `limitRef` (section 9.1), never from a column's name; the label round-trips, and no censoring interval is ever inverted or empty;
- every case declares a time origin and the consistency rules in section 7.3 hold;
- urine metadata is stored;
- no scientific inference is generated yet.

### Phase 2 - Metabolic graph + deterministic feature engine

**Goal:** transform a case into interpretable, audited ratios/compositions.

Build:

```text
api/metabolism-graph.ts
api/_lib/metabolismGraphStore.ts
src/lib/pattern/lineageGraph.ts
src/lib/pattern/featureRegistry.ts
src/lib/pattern/substanceModules.ts
src/lib/pattern/calculateFeatures.ts
src/lib/pattern/urineNormalization.ts
src/components/modeling/pattern/MetabolicPathwayMap.tsx
src/components/modeling/pattern/FeatureTable.tsx
scripts/generate-pattern-sandbox-cases.ts
data/patternSandboxCases.ts            -- server-side only
api/pattern/sandbox-templates.ts
```

Add metabolism-edge diagnostic semantics migration/edit support.

Sandbox cases arrive here (section 30.12), since they need the feature engine to be worth opening: one template per substance with a measurable metabolite, served through the admin/`rettstoks` gate rather than bundled, with editable concentrations and solve-editable ratios. The inference override layer waits for Phase 5.

Acceptance:

- applicable features auto-discover from entered analytes;
- every ratio is molar and directionally named;
- log10 values and raw folds agree;
- raw/Cr/SG urine variants are separate;
- source graph explains why each feature exists;
- no every-pair ratio explosion;
- a sandbox template exists for every qualifying substance, regenerates when the catalog grows, and reaches every gate-holding user including a newly created account with no per-user provisioning; no template or derived count reaches an account outside the method-data gate, and no template is importable from client code;
- editing a sandbox concentration recomputes features and clones the template into the editing user's own case; editing a ratio back-solves a concentration rather than storing a ratio, is offered only where both sides resolve to one observation, and refuses rather than clamps when no non-negative solution exists;
- sandbox cases are marked as such, are absent from every `n` and distribution, and cannot reach the reference atlas.

### Phase 3 - Reference Atlas vertical slice

**Goal:** compare opioid pattern features with individual reference observations extracted from published sources.

Add reference tables, extraction-backed import path, matching logic, and Ratio Atlas.

This phase is gated on curation, not on code. Sequence the curation of a small opioid corpus alongside the engineering work rather than after it, or the phase will complete with an empty atlas.

Both Phase 3 design questions are now settled and carry schema with them: Tier C aggregates get their own table (section 18.6), and reference percentiles use the quantified-only estimand with censored references excluded from the statistic but still displayed as bounds (section 21.1).

This phase also owns the citation-merge work: `pattern_reference_cohorts.citation_id` joins the `mergeCitations` consumer list, with regression coverage for a merge that repoints a cohort and a merge that would collide two cohorts onto one identity tuple (section 18.1).

Suggested files:

```text
db/schema.ts
drizzle/00xx_pattern_reference_atlas.sql
api/_lib/patternReferenceStore.ts
api/pattern/reference-*.ts
src/lib/pattern/referenceImport.ts
src/lib/pattern/referenceMatching.ts
src/lib/pattern/referenceComparison.ts
src/components/modeling/pattern/RatioAtlas.tsx
src/components/modeling/pattern/ReferenceScatter.tsx
```

Curation is admin-only in this phase (section 34.3). No agent path to the atlas is built, which keeps the phase to a schema, an admin surface, and an importer rather than a queue integration with its attendant guards.

Acceptance:

- individual paired source observations are retained;
- every cohort has a citation, reviewed in full, checked at the write path; a cohort without one cannot be persisted;
- atlas rows reach the database by exactly the two admin paths in section 34.3, and no other;
- a bulk import verifies the dataset hash and importer/transformation versions against the values recorded at admission, and aborts on any mismatch;
- every cohort row carries its admitting admin and timestamp, and the importer cannot create a cohort;
- every transcribed entity carries its own source locator;
- cohort/citation/source locator is auditable;
- living/PM and assay-incompatible cohorts remain separate;
- matched `n` and evidence tier are always visible;
- individual reference points render before any distribution work exists;
- percentiles obey small-n rules;
- aggregate-only literature never masquerades as an individual distribution;
- no user case data can reach the atlas, proven by the section 40.7 invariants;
- a feature with no matched published data reports that clearly as a finding rather than rendering an empty chart.

### Phase 4 - Analytical measurand hardening

**Goal:** make hydrolysis, conjugates, assay overlap, and method sensitivity machine-readable.

Extend analytical-method schema and editor/review surfaces.

Acceptance:

- direct/free/total/conjugate results are distinguishable;
- reporting basis is explicit;
- known overlapping measurands cannot be double-counted;
- negative-source evidence checks panel inclusion and method limits;
- feature quality reflects assay coverage.

### Phase 5 - Similar Cases + Source Resolver

**Goal:** turn the pattern into transparent case-to-case and source compatibility reasoning.

Build:

```text
src/lib/pattern/similarity.ts
src/lib/pattern/sourceResolver.ts
src/lib/pattern/quality.ts
src/lib/pattern/interpretation.ts
src/components/modeling/pattern/SimilarCases.tsx
src/components/modeling/pattern/SourceResolver.tsx
src/components/modeling/pattern/QualityPanel.tsx
```

Acceptance:

- context is matched before biochemical distance;
- nearest-case coverage is visible;
- source hypotheses list support, contradictions, and unexplained analytes;
- co-intake is considered only when it improves explanation of real evidence;
- no hidden source priors or fake probabilities;
- an overridden inference (section 30.12) stores the human text beside the engine's, never in place of it, and the override reaches no computation — not similarity, not source resolution, not the manifest.

### Phase 6 - Timed/serial specimens + Next Best Test

**Goal:** exploit repeated measurements and suggest discriminating follow-up analyses.

Add:

- serial specimen feature definitions;
- excretion amount/rate for timed urine;
- new-intake algorithms only where substance-specific validation exists;
- rule-based Next Best Test;
- reference trajectories/phase plots.

### Phase 7 - Mechanistic scenario inference

**Goal:** compare single/repeated/co-intake histories with a scientifically adequate model.

This phase should use FullRemote/KineLab or a future shared model that can jointly generate:

- parent concentrations;
- metabolite concentrations;
- formation pathways;
- repeated doses;
- matrix-specific observations;
- urinary excretion/bladder accumulation;
- relevant postmortem behavior where applicable.

The Pattern UI should consume a versioned scenario-comparison result rather than implement equations in React.

## 43. File-level change map

| Concern | Existing files to reuse/extend | New files |
|---|---|---|
| Modeling shell | `src/pages/ModelingPage.tsx`, `src/components/modeling/ModelingWorkspace.tsx`, `src/router.tsx` | `PatternCasePage.tsx`, `ModelingModeTabs.tsx` |
| Case persistence | `api/simulator/cases.ts` | `src/types/patternCase.ts`, `src/lib/patternCases.ts`, `patternCaseStore.ts` |
| Unit conversion | `src/lib/unitConversion.ts` | pattern normalization wrapper only |
| Metabolism | `src/lib/metabolism.ts`, `api/_lib/metabolismStore.ts`, `drug_metabolites` | graph API/store + edge semantic fields |
| Analytical methods | `analytical_method_components`, `src/lib/drugApi.ts`, method editor/API | measurand semantics + contributor model |
| Reference values | keep `parameter_entries` unchanged for its purpose | dedicated pattern reference tables, published sources only |
| Reference ingestion | `api/_lib/paper-extraction-store.ts`, `api/paper-extractions.ts`, `PaperExtractionQueuePage.tsx`, `citation-store.ts`, PubMed tooling | `patternReferenceStore.ts`, `referenceImport.ts` |
| Compute | keep KineLab Lite unchanged initially | `src/lib/pattern/*`, browser-only (41.1); FullRemote only for Phase 7 mechanistic work, never for case-derived values |
| Visualization | existing Plotly dependency | fingerprint, pathway, ratio atlas, scatter, similar cases |
| Provenance | reuse result hash/manifest principles | `PatternRunManifest` |
| i18n | `src/locales/en.json`, `src/locales/nb.json` | `pattern.*` keys |

## 44. Backward compatibility

- Existing `/modeling` simulator behavior remains unchanged.
- Existing `DrugSimConfig`, `MeasurementEvent`, and `KineLabCaseData` remain valid.
- Existing simulator cases require no migration.
- Existing metabolism rows read with `source_specificity/formation_role = unknown` after additive migration.
- Existing analytical methods read with `measurand_mode = unknown` until curated.
- Pattern features requiring known measurand semantics must downgrade rather than assume a method is hydrolysed/free.
- `parameter_entries` and current monograph concentration aggregation remain untouched.

## 45. Scientific failure modes to design against

The implementation should explicitly test and surface these common traps:

1. comparing raw mass concentrations of molecules with different MW as if directly additive;
2. treating spot urine as a simultaneous blood-equivalent compartment;
3. summing hydrolysed total plus its directly measured conjugate;
4. inferring source from a metabolite shared by several parent drugs;
5. using a negative marker that was never tested;
6. treating a below-LOQ denominator as zero/infinite ratio;
7. comparing a PM femoral-blood case against living plasma references;
8. treating a high metabolite/parent ratio as proof of a large dose;
9. using many correlated ratios as if they were independent evidence;
10. interpreting concentration as metabolic flux;
11. treating ratio-of-means as mean-of-individual-ratios;
12. silently matrix-normalizing with a generic blood/plasma factor;
13. treating creatinine correction as ground truth rather than an alternate normalization;
14. allowing a changed feature/reference definition to silently rewrite a historical case interpretation.

## 46. Definition of done for the first useful release

The first useful release is complete when an authenticated user can:

1. open Modeling -> Case Pattern;
2. create blood and urine specimens;
3. enter several opioid parents/metabolites with units and censored values;
4. optionally select the analytical method and urine creatinine/SG;
5. see a molar Case Fingerprint;
6. see the relevant metabolic pathway;
7. see curated parent/metabolite and cross-matrix features with transparent formulas;
8. see raw and urine-normalized variants;
9. see feature bounds when results are censored;
10. see matched published opioid reference observations, as individual points with citations, and as distributions only where `n` permits;
11. see the most similar compatible published reference cases, with shared-feature coverage shown;
12. see candidate source sets with support, contradictions, and unexplained findings;
13. see explicit statements of what cannot be concluded;
14. save and reopen the case;
15. reproduce the analysis from a run manifest;
16. detect that an old analysis is stale when feature/reference versions change.

The initial release does **not** need to decide single-dose versus repeated-dose mechanistically. It is better to ship a highly trustworthy pattern-comparison tool that says "indeterminate" than a visually polished classifier whose model does not represent the biology.

## 47. Implementation principle

The governing design rule is:

> Raw observations are immutable evidence. Normalizations and ratios are deterministic derived facts. Reference placement is a contextual comparison. Exposure history is an inference. Kinetix must keep those layers visibly and computationally separate.

If that boundary remains intact, the product can grow from simple molar ratios into reference trajectories, source resolution, serial-sample interpretation, and full mechanistic scenario inference without needing to rewrite the scientific contract or weaken forensic auditability.
