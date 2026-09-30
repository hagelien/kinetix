# Bioentity target dashboard — first collection

**Status:** implementation design  
**Date:** 2026-09-29  
**Scope:** target-centric ligand table, activity-separated quantitative plot, and assay-species filtering for bioentity monographs

## 1. Purpose

Bioentity monographs currently behave primarily as wiki pages, with a structured reverse-metabolism section available for entities that participate in drug elimination. The pharmacodynamic data model already contains enough structured information to make drug-target bioentity monographs substantially more clinically useful without introducing a new scientific persistence model.

This design adds the first target-centric collection of structured views:

1. a **ligand table** listing every drug-target relationship recorded for the entity;
2. an **activity-separated quantitative plot** for Ki, EC50, IC50, Emax, affinity, potency, or efficacy;
3. an **assay-species filter** that distinguishes human, non-human, and unstated evidence.

The page becomes the inverse of the drug monograph. A drug monograph answers “what targets does this drug act on?”; a target bioentity monograph answers “what drugs act on this target, how, how strongly, and in what experimental species?”

The implementation is deliberately read-side heavy. The existing `drug_receptor_targets` rows remain authoritative. This design requires **no database migration and no new write path**.

## 2. Clinical goals

The first collection should let a clinician or pharmacologist answer these questions quickly:

- Which drugs in Kinetix are recorded as acting on this target?
- Is each drug an agonist, partial agonist, antagonist, inverse agonist, modulator, inhibitor, or another interaction type?
- What quantitative affinity or functional potency has been recorded?
- Are the displayed measurements from human assays, non-human assays, or unspecified species?
- What uncertainty/range is represented by the stored `NumericRange`?
- Which source records and evidence notes support the relationship?
- Which drug monograph should I open for the broader clinical context?

The feature is an evidence-navigation surface. It must not imply receptor occupancy, in-vivo clinical effect, therapeutic relevance, or comparative efficacy from an in-vitro Ki/EC50/IC50 value alone.

## 3. Non-goals

This first collection does **not** add:

- assay-level atomic measurements;
- receptor occupancy calculations;
- exposure-to-potency calculations;
- tissue or CNS concentration modeling;
- pathway-biased signaling;
- endogenous ligands as a separate data class;
- new pharmacogenomic, structural, expression, or pathway tables;
- automatically inferred selectivity;
- cross-target selectivity heatmaps;
- a new curation/write workflow.

Those can be layered on later. The first collection should prove that the existing target relationships become useful when read in the opposite direction.

## 4. Existing data used

The implementation should consume the current `drug_receptor_targets` relationship fields without changing their meaning:

- `drugId`
- `bioEntityId`
- `interactionType`
- `tier`
- `affinity`
- `potency`
- `efficacy`
- `ki`
- `ic50`
- `ec50`
- `emax`
- `selectivityRatio`
- `assaySpecies`
- `referenceIds`
- `evidenceNote`

The linked `drugs` row supplies drug identity and monograph navigation.

Important existing invariants remain unchanged:

- a mechanism row is a **summary relationship**, not an assay result;
- `assaySpecies = null` means **unstated**, not human;
- `interactionType` is free-form because receptor pharmacology is wider than a small enum;
- `NumericRange` may contain median, mean, min/max, qualifier, unit, and note;
- multiple interaction types between the same drug and target are separate rows and must remain distinguishable.

## 5. User-facing placement

### 5.1 Existing entity monograph

For a normal `entity_monograph` rendered through `WikiPage`, add the target dashboard after the prose article and before or adjacent to other structured entity collections.

Recommended structured order:

1. prose monograph;
2. **Target pharmacology** collection, when at least one receptor-target relationship exists;
3. linked metabolism drugs, when present;
4. ordinary page discussion/reference surfaces.

The target dashboard should render on any entity with target relationships regardless of whether `bio_entity_functions` currently contains `drug_target`. The relationship itself is authoritative enough to make the section useful and this avoids a hidden page caused by registry-function drift.

### 5.2 Entity fallback page

`EntityMonograph.tsx` currently renders a minimal fallback if a catalog entity has no monograph. Render the same target dashboard there.

This ensures structured pharmacology remains discoverable even before prose has been authored.

### 5.3 Empty state

If no `drug_receptor_targets` rows point to the entity, render nothing. Do not add an empty “Target pharmacology” shell to every entity page.

## 6. Read model

Add a reverse lookup in `api/_lib/receptorTargetStore.ts` analogous to `listEntityMetabolismDrugs`.

Suggested shared type in `src/lib/receptorTargets.ts`:

    export interface EntityTargetLigand {
      relationshipId: number;
      drugId: number;
      drugSlug: string;
      drugNames: Record<string, string>;
      drugMonographSlug: string | null;

      interactionType: string;
      tier: MechanismTier | null;

      affinity: NumericRange | null;
      potency: NumericRange | null;
      efficacy: NumericRange | null;
      ki: NumericRange | null;
      ic50: NumericRange | null;
      ec50: NumericRange | null;
      emax: NumericRange | null;
      selectivityRatio: NumericRange | null;

      assaySpecies: string | null;
      referenceIds: number[];
      evidenceNote: string | null;
    }

The exact drug identity fields should reuse whatever minimal shape existing drug search/monograph-link code already uses. Do not hydrate a full `DrugRow` per ligand.

### 6.1 Store query

Add:

    listEntityTargetLigands(db, entityId): Promise<EntityTargetLigand[]>

The query should:

- select from `drug_receptor_targets`;
- join `drugs` once;
- resolve the drug's monograph slug in the same query if practical, otherwise with one batched lookup;
- filter by `drug_receptor_targets.bio_entity_id = entityId`;
- never issue one query per ligand;
- return all relationship rows, including rows with no quantitative measurements.

Default server ordering should be stable rather than scientifically judgmental. Recommended:

1. normalized interaction type;
2. localized-neutral drug slug/name key;
3. relationship id as tie-breaker.

Clinical sort order belongs in the client where the selected metric is known.

## 7. API

Extend the existing public `GET /api/bio-entities` read route, following the already-established `?metabolismDrugs=` pattern.

Add:

    GET /api/bio-entities?targetLigands=<entityId>

Response:

    {
      "ligands": [ ...EntityTargetLigand ]
    }

Rules:

- positive integer entity id required;
- read-only/public, like the existing catalog reads;
- an entity with zero target relationships returns `{ "ligands": [] }`;
- an invalid/non-positive id does not enter this branch;
- no species or metric filtering is required server-side in v1 because the collection is expected to be small and the client needs the full set for instant switching.

Add the corresponding client helper in `src/lib/bioEntitiesApi.ts`:

    fetchEntityTargetLigands(entityId, signal?)

Do not create a second target-specific API route merely for this view unless the payload later becomes large enough to justify independent pagination/filtering.

## 8. Component structure

Add a self-contained structured monograph component, for example:

    src/components/wiki/EntityTargetLigands.tsx

It owns:

- loading/error/empty handling;
- species filter state;
- selected metric;
- table sorting;
- activity grouping;
- plot data derivation.

If it becomes too large, split only the visual pieces:

    EntityTargetLigands.tsx
    EntityTargetLigandTable.tsx
    EntityTargetActivityPlot.tsx

Keep normalization/scientific formatting logic in a shared pure module, for example:

    src/lib/entityTargetLigands.ts

This module should be testable without React.

## 9. Ligand table

### 9.1 Required columns

The first table should expose:

| Column | Source |
| --- | --- |
| Drug | joined drug identity |
| Activity | `interactionType` |
| Ki | `ki` |
| EC50 | `ec50` |
| IC50 | `ic50` |
| Emax / efficacy | `emax`, falling back to a separate efficacy display rather than merging values |
| Assay species | `assaySpecies` |
| Evidence | `referenceIds` count / reference control |

Do not hide a relationship solely because it lacks numeric measurements. A qualitative “antagonist” row is still clinically useful.

Optional secondary columns, if width allows:

- affinity;
- potency;
- selectivity ratio;
- tier.

### 9.2 Drug navigation

The drug name links to the drug monograph when a monograph slug is available. If not, fall back to the normal drug detail/wiki resolution already used elsewhere rather than rendering a dead link.

Use existing localized drug-name helpers. Do not bake Norwegian or English names into the API response presentation.

### 9.3 Measurement display

Reuse the existing Kinetix `NumericRange` formatting conventions where possible.

A range should remain visibly a range. For example, do not collapse `{min: 3, max: 12, unit: "nM"}` to “7.5 nM” in the table.

Show `NumericRange.note` through the normal detail/tooltip mechanism if one exists.

### 9.4 Evidence detail

At minimum:

- show the number of `referenceIds`;
- reuse the existing citation/reference affordance to open the underlying references where practical;
- show `evidenceNote` in an expandable detail row or tooltip.

Do not derive an “evidence quality score” in this collection.

## 10. Activity grouping

The stored `interactionType` remains untouched. Add a read-only normalization function for presentation.

Suggested presentation groups:

1. agonist;
2. partial agonist;
3. inverse agonist;
4. antagonist;
5. positive allosteric modulator;
6. negative allosteric modulator;
7. inhibitor/blocker;
8. other / unspecified.

Normalization should be conservative:

- trim;
- lowercase;
- normalize spaces and hyphens to underscores;
- map a short explicit alias table to the presentation group;
- unknown values go to “other”, retaining the original label.

Do **not** use broad substring inference that could silently reclassify unfamiliar pharmacological terminology.

Example:

    normalizeInteractionType("partial agonist")
      -> { group: "partial_agonist", label: "partial agonist" }

    normalizeInteractionType("biased_agonist")
      -> { group: "other", label: "biased agonist" }

The table always shows the original/cosmetically formatted interaction type. The grouping is for organization and plotting only.

## 11. Assay-species filter

The control should offer:

- **All**
- **Human**
- **Non-human**
- **Unstated**

Classification is derived at read time from `assaySpecies`; no migration is required.

Recommended conservative classifier:

- `null` / blank -> `unstated`;
- normalized string containing `homo sapiens` or the standalone word `human` -> `human`;
- any other non-empty value -> `non_human`.

This intentionally classifies strings such as “recombinant human (HEK293)” as human while preserving “HEK293” alone as non-human/other rather than guessing that the receptor construct was human.

Do not label `null` as human.

The filter applies simultaneously to the table and plot so they cannot tell contradictory stories.

The UI should always show the count in each class when inexpensive, e.g.:

    All 24 | Human 11 | Non-human 8 | Unstated 5

## 12. Quantitative activity plot

### 12.1 Core behavior

The plot is a target-centric comparison of ligand measurements, grouped by activity.

It must show **one measurement type at a time**.

Metric selector:

- Ki
- EC50
- IC50
- Emax
- Affinity
- Potency
- Efficacy

Only offer/select metrics that have at least one plottable value after the current species filter. Ki should be the initial metric when present because it most directly represents binding affinity. Otherwise choose the first available metric in the order above.

Never mix Ki, EC50, and IC50 points on one numeric axis under a generic “potency” label.

### 12.2 Axis

For concentration-like metrics (Ki, EC50, IC50, affinity/potency when concentration-valued):

- normalize compatible molar units to a common unit for plotting;
- use a logarithmic x-axis;
- display the selected common unit clearly;
- recommended canonical display unit: nM.

Support at minimum:

- M
- mM
- µM / uM
- nM
- pM

If a value uses an unsupported or non-concentration unit, keep it in the table but exclude it from that plot and make the omission understandable.

For Emax/efficacy, do not force logarithmic concentration behavior. Use the stored unit and a linear axis when the displayed rows are unit-compatible. If units are heterogeneous, disable the plot for that metric rather than pretending they are comparable.

### 12.3 Representative point from NumericRange

The plot needs one x value while the table preserves the full range.

Use the same scalar preference already documented for `NumericRange`:

1. median;
2. mean;
3. midpoint of min/max;
4. min if only min exists;
5. max if only max exists.

If both min and max exist, draw a range/error bar around the representative point.

One-sided qualified values (`<`, `>`, `≤`, `≥`) may be plotted with an arrow/limit marker if the chart library supports it cleanly. If not, exclude them from the plot in v1 and retain them in the table. Do not render a one-sided bound as an exact point.

### 12.4 Grouping and labels

Separate rows/bands by normalized activity group. Within a group, sort by the selected measurement scalar, strongest/smallest concentration first for concentration metrics.

Each point/row should expose:

- drug name;
- original interaction type;
- formatted full NumericRange;
- assay species;
- reference count;
- evidence note when present.

A user should be able to move from a point to the corresponding drug monograph.

### 12.5 Interpretation guardrail

The plot label/help text should state that values are assay measurements and do not by themselves establish in-vivo receptor engagement or clinical effect.

No “stronger drug”, “more clinically active”, or receptor-occupancy language should be generated from the chart.

## 13. Responsive behavior

Desktop:

- plot above the table or beside it when the monograph content width comfortably permits;
- table may expose all quantitative columns.

Narrow screens:

- plot remains horizontally readable without requiring the full table width;
- table becomes horizontally scrollable or collapses less-used quantitative columns;
- species and metric controls remain visible above both views.

Do not make hover the only way to access a value; touch and keyboard users need the same detail.

## 14. Loading, error, and partial data

- While loading, use the existing monograph loading/skeleton convention.
- On API failure, the prose monograph must still render.
- The structured collection should fail locally with a small retry/error affordance rather than replacing the page.
- Missing numeric values display as em dash/empty according to existing table conventions.
- A row with `assaySpecies = null` explicitly displays “Unstated”.
- Unknown interaction types are not discarded.

## 15. i18n

All new UI labels go through `src/locales/en.json` and `src/locales/nb.json`.

Likely keys:

    bioEntity.targetPharmacologyHeading
    bioEntity.targetLigands
    bioEntity.targetMetric
    bioEntity.targetSpecies
    bioEntity.speciesAll
    bioEntity.speciesHuman
    bioEntity.speciesNonHuman
    bioEntity.speciesUnstated
    bioEntity.activityAgonist
    bioEntity.activityPartialAgonist
    bioEntity.activityInverseAgonist
    bioEntity.activityAntagonist
    bioEntity.activityPam
    bioEntity.activityNam
    bioEntity.activityInhibitor
    bioEntity.activityOther
    bioEntity.noPlottableMeasurements
    bioEntity.assayMeasurementDisclaimer

Drug names, free-text evidence notes, and stored interaction labels are data and are not translated by the UI.

## 16. Accessibility

The plot cannot be the sole representation of the data. The table is the accessible canonical view.

Requirements:

- chart points are keyboard reachable if the chosen chart implementation exposes them;
- activity groups are distinguishable by text/position, not color alone;
- tooltip content is available through focus/tap;
- axis and metric are announced in accessible text;
- species filter is a standard radio/select control with visible labels;
- empty/error states are plain text, not graphical-only.

## 17. Suggested file-level implementation

### Modify

- `api/_lib/receptorTargetStore.ts`
  - add `listEntityTargetLigands`.

- `api/bio-entities.ts`
  - add `?targetLigands=<id>` reverse lookup.

- `src/lib/receptorTargets.ts`
  - add the entity-centric ligand read type.

- `src/lib/bioEntitiesApi.ts`
  - add `fetchEntityTargetLigands`.

- `src/pages/wiki/WikiPage.tsx`
  - render target dashboard for `entity_monograph` pages.

- `src/pages/wiki/EntityMonograph.tsx`
  - render target dashboard in the no-monograph fallback.

- `src/locales/en.json`
- `src/locales/nb.json`

### Add

- `src/components/wiki/EntityTargetLigands.tsx`
- `src/components/wiki/EntityTargetActivityPlot.tsx` if separation is useful
- `src/lib/entityTargetLigands.ts`
- unit tests for normalization, species classification, unit conversion, and representative-value selection
- component tests
- integration test for the reverse lookup

No `drizzle/` migration is expected.

## 18. Testing plan

### 18.1 Pure unit tests

For `src/lib/entityTargetLigands.ts`:

**Interaction grouping**

- `agonist` -> agonist
- `partial agonist` -> partial agonist
- `partial_agonist` -> partial agonist
- unknown terminology -> other, original label retained

**Species classification**

- `Homo sapiens` -> human
- `recombinant human (HEK293)` -> human
- `human platelets` -> human
- `Rattus norvegicus` -> non-human
- `HEK293` -> non-human/other under the conservative rule
- `null` / blank -> unstated

**NumericRange representative scalar**

- median wins over mean/min/max
- mean wins when median absent
- midpoint used for min+max
- one-sided bounds are flagged as non-exact for plotting

**Unit normalization**

- 1 µM -> 1000 nM
- 1 nM -> 1 nM
- 1 pM -> 0.001 nM
- unsupported units remain non-plottable

### 18.2 Store/integration test

Seed:

- one target entity;
- several drugs;
- agonist, partial-agonist, and antagonist relationships;
- mixed Ki/EC50/IC50 availability;
- human, rat, and null assay species.

Assert:

- reverse lookup returns every relationship pointing to the entity;
- unrelated targets are excluded;
- drug identity is hydrated;
- measurement ranges and reference ids are preserved exactly;
- null species remains null;
- no duplicate relationship is introduced by joins.

### 18.3 API test

Assert:

- `GET /api/bio-entities?targetLigands=<id>` returns public 200;
- empty entity returns an empty array;
- malformed/non-positive ids fall through safely and do not execute the reverse lookup branch.

### 18.4 Component tests

Assert:

- empty data renders no section;
- species filters update both plot and table;
- unknown interaction type appears under Other;
- selecting EC50 excludes rows without EC50 from the plot but not from the table;
- a qualitative-only relationship remains visible;
- null species is shown as Unstated;
- unsupported units remain visible in the table but are not plotted;
- API failure does not break the monograph.

## 19. Performance

Entity target collections are expected to be much smaller than the full drug catalog.

For v1:

- fetch the collection once per entity;
- filter and sort in memory;
- no pagination;
- no per-row drug fetches;
- no per-row reference fetches solely to render the initial table.

If very promiscuous targets later produce large collections, pagination/server filtering can be added without changing the persistence model.

## 20. Scientific/data caveats shown in the UI

The structured view should preserve these distinctions:

- **Ki is not EC50.**
- **IC50 is assay-dependent and is not automatically Ki.**
- **In-vitro affinity/potency is not equivalent to clinical effect.**
- **Assay species and system matter.**
- **A summarized NumericRange can hide heterogeneous methods.**
- **Missing species information is uncertainty, not evidence of a human assay.**

The implementation should therefore prefer transparent missingness over inferred precision.

## 21. Acceptance criteria

The first collection is complete when:

1. Opening a bioentity with receptor-target relationships shows a target-pharmacology section without any new database migration.
2. Every live `drug_receptor_targets` row for that entity is reachable in the ligand table.
3. The table exposes interaction type, existing quantitative measurements, assay species, evidence, and drug navigation.
4. The user can filter the collection by All / Human / Non-human / Unstated.
5. The user can select one quantitative metric at a time and see an activity-grouped plot.
6. Ki/EC50/IC50 are never mixed on one axis as though they were interchangeable.
7. Compatible molar concentration units are normalized for the plot while the original stored range remains visible.
8. Unknown interaction types, missing quantitative data, and unstated species remain visible rather than being silently dropped.
9. Existing drug-monograph pharmacodynamics behavior is unchanged.
10. Existing bioentity write paths and database schema are unchanged.
11. Automated tests cover reverse lookup, species classification, activity grouping, value selection, unit conversion, and the main filter/plot interactions.

## 22. Follow-on work deliberately enabled by this design

Once this reverse read model exists, later features can build on it without changing the first collection:

- sibling-target selectivity matrices;
- two-ligand comparison;
- evidence/completeness summaries;
- cross-target network views;
- clinically contextual exposure-vs-potency displays;
- eventual assay-level evidence rows.

The important architectural step in this phase is therefore not the chart itself. It is establishing a clean, typed, target-centric read model over the existing drug-target relationships.
