# Multi-Value Drug Parameters — Implementation Plan

> Status: Phases 1–4 implemented. Design plan for transitioning drug parameters
> from single-value to multi-value (one entry per source paper), with a
> structured per-entry `matrix`, aggregation into a summary value, and a
> graphical stacked-interval / forest-plot visualization of concentration ranges.
>
> - **Phase 1 (schema + backfill)** — shipped (issue 978, issue 979): `parameter_entries`
>   with `parameter`/`median`/`qualifier`/`origin`, the grandfather backfill, the
>   `param_entry` open-entry index, and the `matrixRelevant`/`summarizable` flags.
> - **Phase 2 (aggregation + cache)** — `parameterEntryAggregation.ts` (weighted
>   median + IQR, matrix-normalized), `parameter-entries-store.ts` recompute, and
>   `parameterSummaries` on the single-drug API.
> - **Phase 3 (review pipeline)** — the `param_entry` pending-edit type, submit/
>   admin-direct routes, and `applyApprovedParameterEntry`.
> - **Phase 4 (UI)** — `ParameterEntryList` + `ParameterForestPlot`, wired into
>   the monograph sidebar.
> - **Phase 5a (generalize beyond concentrations)** — shipped. Every range
>   parameter whose reported value varies between papers is now entry-backed:
>   half-life, Vd, bioavailability, protein binding, B/P, Tmax, pKa, logP, logD,
>   clearance, C/P, the five dose ranges and the three detection windows (blood,
>   oral fluid, urine — split apart in migration `0098`), alongside
>   the interpretive concentrations. `matrix` and `scenario` became nullable
>   (migration `0085`) because they are concentration dimensions; unit, bounds and
>   dimension applicability are read from the registry per parameter.
>   `loq`/`lod`/`analyteStability` stay `matrixRelevant` but NOT `summarizable`:
>   they are matrix-specific analytical properties with no valid cross-matrix pool.
> - **Phase 5b (retire legacy endpoint)** — DEFERRED. The legacy
>   `reference-concentrations` endpoint is kept as a fenced compatibility surface
>   (its writes recompute the new cache; the issue 979 guards stop it mutating
>   synthetic rows). Its deletion is a breaking change best done as its own
>   reviewed step.

## Approach

**"A2 delivered A3-first."** Generalize the existing `reference_concentrations`
table into a per-parameter **entry store** (`parameter_entries`), keep
`drug_parameters` as a **recomputed summary cache** (aggregate written on every
entry mutation, also recomputable on read), and add a `matrixRelevant` flag to
the parameter registry. The first shipped increment covers the interpretive
concentration parameters (`therapeuticConcentration`,
`supratherapeuticConcentration`, `impairmentConcentration`,
`toxicConcentration`, `fatalConcentration`) plus `loq`/`lod`; the schema,
aggregation module, and registry flag are designed to generalize to any
range-kind parameter later.

This reverses the direction of migration `drizzle/0023`, which had collapsed the
multi-row `reference_concentrations` table into the single-value
`drug_parameters.therapeuticConcentration`. Crucially, that table and all its
rows still exist (0023 only demoted it to "legacy reads"; it was never dropped
— still referenced live in `api/_lib/citation-usage.ts`). That table is our
migration seed.

## Design decisions up front

### (a) Review unit = the ENTRY, via a new `editType` — not the parameter

The review unit becomes the **individual entry** (one paper, one matrix, one
value). An entry maps 1:1 to a single scientific claim from a single source —
exactly the granularity the `paper_review` reference gate already assumes.
Reviewing "the whole parameter's set of entries" as one blob would make the
citation gate ambiguous (which of N citations must be read-in-full?) and would
resurrect the duplicate-edit problem the `(drug,parameter)` unique index solves.

- New `editType = 'param_entry'` (11 chars, safely inside
  `pending_edits.edit_type` `varchar(20)`). `proposedValue` is a discriminated
  `{op:'create', entry}` / `{op:'update', patch}` / `{op:'delete'}` payload,
  mirroring the existing `bio_entity` editType pattern in
  `api/_lib/pending-edits-helpers.ts`.
- `targetId` = the drug id for `create`, the entry id for `update`/`delete`. The
  `parameter` column carries the `DrugParameterId`.
- **The existing `(drug,parameter)` unique index does NOT change and does NOT
  apply.** `pending_edits_open_parameter_idx` is predicated on
  `edit_type = 'parameter'`. Entry edits use `edit_type = 'param_entry'`, so
  multiple open entry edits per `(drug,parameter)` coexist by design — that is
  the point of multi-value. We add a **new, narrower** partial unique index to
  prevent duplicate concurrent edits against the *same entry*:
  `pending_edits_open_entry_idx` on `(target_id, parameter)` where
  `edit_type='param_entry' AND status='pending' AND proposed_value->>'op' <> 'create'`
  — at most one open update/delete per existing entry, while `create` rows are
  unconstrained.
- **Citation gating is reused verbatim.** Each entry carries exactly one
  `citationId`. On submit and on approval, call the existing
  `assertReferencesJudgedForActor(referenceIds, actorUserId)` with the entry's
  single citation. Agents need a read-in-full `paper_review`; humans are
  trusted; `freetext` citations are exempt exactly as today. `parameter_entries`
  rows join `filterUsedCitationIds` / `collectUsedCitationIdsForDrug` /
  `collectReferenceUsage` so entry citations count as "in use".

### (b) Summary row: compute-on-WRITE cache + compute-on-READ enrichment

- The `drug_parameters` row for a summarized parameter is kept as a **derived
  cache**, recomputed and written on every entry create/update/delete/approval
  inside the same transaction. It stores a plain `NumericRange`
  (matrix-normalized to whole blood, unit-normalized to the parameter's
  `canonicalUnit`) so **every existing consumer keeps working untouched**: the
  drug-table sort index, the list serializer (`mergeDrugParametersIntoRow`), the
  simulator overlay (`buildSimulatorReferenceRangeFromParameters`), and the
  typed frontend `drug.therapeuticConcentration` field.
- The **richer** payload (individual entries + weighted-median/IQR summary +
  per-matrix breakdown) is attached at read time on the single-drug response
  under `parameterEntries` / `parameterSummaries`, computed by the pure
  aggregation module.
- **Existing 0023-migrated single values are grandfathered.** A parameter with a
  hand-authored `drug_parameters` value but **zero** entries keeps rendering
  that value. The recompute only overwrites the cache when ≥1 entry exists.
  Hand-authored values are not deleted; they coexist until entries supersede
  them. Each cache recompute writes a `drug_parameter_revisions` row
  (`editSummary` = "Recomputed from N source entries", `referenceIds` = union of
  contributing entry citations) so history and attribution stay intact.

### (c) Migration / back-compat for existing rows and the overlay

- **Rename-and-generalize in place** rather than a parallel table. Migration
  `0078` renames `reference_concentrations` → `parameter_entries`, adds a
  `parameter varchar(60)` column, and back-fills it by mapping `scenario` →
  `DrugParameterId` (living_therapeutic→therapeuticConcentration,
  living_toxic→toxicConcentration, living_dui→impairmentConcentration,
  postmortem_\*→fatalConcentration). Every existing row, FK, and the `id`
  sequence is preserved, so `citation-usage.ts` needs only its
  table/column identifiers repointed — no data reconstruction.
- `src/lib/referenceConcentrationsOverlay.ts` already has both paths:
  `buildSimulatorReferenceRange(rows,…)` and
  `buildSimulatorReferenceRangeFromParameters(drug,…)`. Because we keep the
  `drug_parameters` cache in sync, the parameters path keeps working with zero
  changes; the row path is reused by the new forest plot (it already does
  matrix→blood + unit conversion + bucket merge — the exact read-time
  conversion this approach mandates).
- `api/reference-concentrations.ts` stays alive as a thin compatibility shim
  during Phases 1–3 and is retired in Phase 5.

### (d) Rollout sequencing (nothing breaks between phases)

1. Schema + backfill (additive; table renamed but column-compatible).
2. Write path: entry store + aggregation + cache sync (admin-direct only).
3. Review pipeline: `param_entry` editType through `/review`.
4. Read API + React entry list + forest plot.
5. Retire legacy reference-concentration surfaces + broaden to all range params.

Each phase is independently shippable and leaves the app fully working.

---

## Phase 1 — Schema generalization + backfill

**Migration `drizzle/0078_parameter_entries.sql`** (next index after `0077`;
add the `0078` entry to `drizzle/meta/_journal.json`):

- `ALTER TABLE reference_concentrations RENAME TO parameter_entries;`
- Rename indexes (`ref_conc_drug_idx` → `parameter_entries_drug_idx`, etc.).
- `ADD COLUMN parameter varchar(60);` back-fill from `scenario` via the mapping
  above; then `ALTER COLUMN parameter SET NOT NULL`.
- `ADD COLUMN sort_order integer NOT NULL DEFAULT 0;` (entry ordering within a
  parameter box).
- Keep `low, high, unit, matrix, scenario, n, comments, citation_id, created_by,
  created_at, updated_at`. `scenario` becomes optional context metadata.
- New indexes: `parameter_entries_drug_param_idx` on `(drug_id, parameter)`,
  `parameter_entries_citation_idx` on `(citation_id)`.
- This is a `RENAME`, so schema-diff will not see a destructive drop.

**Migration `drizzle/0079_pending_edit_open_entry_idx.sql`**:

- `CREATE UNIQUE INDEX CONCURRENTLY pending_edits_open_entry_idx ON pending_edits (target_id, parameter) WHERE edit_type = 'param_entry' AND status = 'pending' AND (proposed_value->>'op') <> 'create';`
  (mirrors `drizzle/0070`; the integration harness strips `CONCURRENTLY`).

**`db/schema.ts`:** rename the `referenceConcentrations` export →
`parameterEntries` (table `parameter_entries`); add `parameter` and `sortOrder`
columns and the new indexes. Keep a temporary
`export const referenceConcentrations = parameterEntries;` alias so unmodified
importers compile until repointed.

**`src/lib/drugParameters.ts` — registry changes:**

- Add `matrixRelevant?: boolean` and `summarizable?: boolean` to
  `BaseParameterSpec`. `matrixRelevant: true` on the seven concentration params;
  absent on half-life, Vd, pKa, etc. Add helpers `parameterIsMatrixRelevant(id)`
  and `parameterIsSummarizable(id)`.
- Update the comment (~lines 765–768) that says matrix is captured in free-text
  `note` to point at `parameter_entries.matrix`.
- Export `SUMMARIZED_PARAMETER_IDS` (Phase-1 set = the seven above) as the single
  source of truth shared by the write/read paths and the migration.

**Types:** `src/lib/referenceConcentrations.ts` is retained as-is (its
matrix/scenario/unit enums + zod are reused directly by entries).

**Tests:** `tests/integration/parameter-entries-migration.test.ts` — assert the
rename preserved rows, the `parameter` back-fill mapping is correct per scenario,
and FK cascade on drug delete still fires (PGlite integration harness).

---

## Phase 2 — Entry store + aggregation module + cache sync (admin-direct write)

**New pure module `src/lib/parameterEntryAggregation.ts`** (no DB, unit-tested;
reuses `src/lib/unitConversion.ts` and the matrix→blood logic already in
`referenceConcentrationsOverlay.ts`):

```ts
export interface ParameterEntryValue {
  low: number | null; high: number | null;
  unit: string; matrix: ReferenceMatrix | null;
  n: number | null; reviewScore: number | null;  // paper_review.overallScore, 0–100
}
export interface AggregationContext {
  targetUnit: string;                 // parameter canonicalUnit
  bloodPlasmaRatio?: NumericRange | number | null;
  molecularWeight?: number | null;
  matrixRelevant: boolean;
}
export interface ParameterSummary {
  representative: number | null;      // weighted median
  iqrLow: number | null; iqrHigh: number | null;  // 25th/75th weighted percentile
  min: number | null; max: number | null;
  unit: string; entryCount: number; contributingCitationIds: number[];
  byMatrix: Record<ReferenceMatrix, { min?: number; max?: number; n: number }>;
}
export function aggregateEntries(entries: ParameterEntryValue[], ctx: AggregationContext): ParameterSummary | null;
export function summaryToNumericRange(summary: ParameterSummary): NumericRange;  // the drug_parameters cache value
```

- **Weighting:** `weight = (n ?? 1) * (0.5 + reviewScore/200)` so a large,
  well-reviewed study dominates while an un-reviewed entry still counts.
  Weighted median + weighted 25/75 percentiles over each entry's representative
  point. Keep the formula a single exported constant so it is tunable.
- **Normalization at read** (verbatim storage rule honored — entries store
  source-matrix, source-unit values): matrix→whole_blood via `bloodPlasmaRatio`
  and unit→`targetUnit` via molecular weight, reusing the exact conversion
  helpers. Entries whose conversion fails (molar without MW) drop from the
  numeric aggregate but are still listed individually. When `matrixRelevant` is
  false, skip matrix normalization.

**New store `api/_lib/parameter-entries-store.ts`** (absorbs
`api/_lib/reference-concentrations-helpers.ts`):

- `listParameterEntries`, `listParameterEntriesForDrugIds`,
  `getParameterEntryById`, `insertParameterEntry`, `updateParameterEntry`,
  `deleteParameterEntry` — same shape as the current DAO but with `parameter`
  and a LEFT JOIN on `paper_reviews` (on `citation_id`) so the aggregator gets
  the review score.
- `recomputeAndCacheParameterSummary(db, drugId, parameter, actorUserId)`: load
  all entries, load the drug's `bloodPlasmaRatio`/`molecularWeight`, call
  `aggregateEntries`, then:
  - ≥1 entry: `upsertDrugParameter(...)` + insert a `drug_parameter_revisions`
    row (`editSummary: 'Recomputed from N source entries'`, `referenceIds` =
    contributing citations).
  - 0 entries: leave any hand-authored `drug_parameters` value untouched
    (grandfather rule).
  - Runs inside the caller's `runInPoolTransaction` so entry write + cache write
    + revision commit atomically.

**Zod (`src/lib/referenceConcentrations.ts` + `api/_lib/schemas.ts`):**

- `parameterEntryInputSchema` = existing `referenceConcentrationInputSchema`
  extended with `parameter: z.enum(SUMMARIZED_PARAMETER_IDS)` and a refine:
  `matrix` required when `parameterIsMatrixRelevant(parameter)`, optional
  otherwise; `citationId` required for matrix-relevant params.
- `parameterEntryUpdateSchema`, and
  `parameterEntryEditSchema = z.discriminatedUnion('op', [create, update, delete])`
  in `api/_lib/schemas.ts` for the Phase-3 review payload.

**API `api/parameter-entries.ts`** (new; `api/reference-concentrations.ts` kept
as a shim):

- `GET ?drugId=&parameter=` → `{ items, summary }`; `GET ?drugIds=` batch.
  Public, cached.
- `POST`/`PATCH`/`DELETE`: admin-direct write path, each calling the store then
  `recomputeAndCacheParameterSummary`.

**Repoint `api/_lib/citation-usage.ts`:** swap the three `referenceConcentrations`
reads to `parameterEntries` (column names unchanged — import + identifier swaps).

**i18n (`src/locales/{en,nb}.json`):** `parameterEntries.summary.*`
(`weightedMedian`, `iqr`, `nStudies`, `byMatrix`, `sourceCount`, `noEntries`),
`parameterEntries.form.*`, and error keys (`matrixRequired`, `citationRequired`).
Every key in both files.

**Tests:**

- `src/lib/parameterEntryAggregation.test.ts` (unit): weighted median/IQR,
  matrix normalization, molar-without-MW drop, single-bound entries, empty set,
  weighting monotonicity.
- `tests/integration/parameter-entries.test.ts`: insert entries → cache
  recomputed, revision written, grandfather rule, FK cascade.

---

## Phase 3 — Review pipeline (contributor entries through `/review`)

- **`api/_lib/schemas.ts`:** register `param_entry` in the pending-edit editType
  handling; `parameterEntryEditSchema` validates `proposedValue`.
- **`api/parameter-entries.ts`:** for non-admin (or admin `submitForReview`),
  insert a `pending_edits` row (`editType='param_entry'`, `targetId` = drugId for
  create / entryId for update-delete, `parameter`, `referenceIds=[citationId]`,
  `proposedValue={op,…}`). Rely on `pending_edits_open_entry_idx` for the
  concurrent-guard (409 `entry_pending_conflict` for update/delete collisions;
  creates never collide). Call `assertReferencesJudgedForActor([citationId],
  auth.userId)` before enqueue (400 `reference_not_judged`).
- **`api/_lib/pending-edits-helpers.ts`:**
  - Add `applyApprovedParameterEntry(db, edit, reviewerId)` in
    `applyApprovedEditEffects` (alongside the `bio_entity` branch). Re-validate
    `proposedValue`, create/update/delete the entry, then
    `recomputeAndCacheParameterSummary` (produces the revision row →
    `recordApproval`/`recordImplicitAgentApproval` and fires the
    `parameter_approved` agent hook, so approval/verification machinery lights up
    unchanged).
  - Add a `markConflictingPendingEdits` branch for `param_entry`: mark other
    pending `param_entry` rows targeting the **same entry id** stale; creates
    don't conflict.
- **House-rule compliance:** No inline review-status badges on the entry list
  (browse surface). Verification/read-in-full status surfaces only in the
  parameter discussion panel (`VerificationSummary`) and history dialog
  (`ParameterHistoryDialog`).

**Tests:**

- `tests/api/parameter-entry-route.test.ts` (mocked): submit→pending, admin
  direct, 409 on same-entry update, reference-gate 400 for agent without
  read-in-full, human bypass.
- `tests/integration/parameter-entry-review.test.ts`: full submit→approve→
  entry-created→cache-recomputed→revision+approval-stamp chain on PGlite.

---

## Phase 4 — Read API enrichment + React (entry list + forest plot)

- **`api/drugs.ts`:** in the single-drug handlers, add a parallel fetch of
  entries + summaries for the summarized params, attached as
  `drug.parameterEntries: Record<paramId, SerializedEntry[]>` and
  `drug.parameterSummaries: Record<paramId, ParameterSummary>`. The batch list
  serializer stays on the cache (avoid N+1).
- **Frontend API `src/lib/parameterEntriesApi.ts`** (new; supersedes
  `referenceConcentrationsApi.ts`): typed fetch (single + batch) + create/update/
  delete. Keep the old module re-exporting for one release.
- **React components:**
  - **`src/components/wiki/ParameterEntryList.tsx`** — generalizes
    `ReferenceConcentrationsList.tsx`. Per summarized parameter, renders the
    individual entries (value + matrix + n + linked citation) and the aggregated
    summary line (weighted median + IQR + "n studies"). Reuses `UnitTooltip`,
    `REFERENCE_MATRIX_LABEL_KEYS`, `referenceModulePath`.
  - **`src/components/wiki/ParameterForestPlot.tsx`** — React/SVG forest plot:
    one horizontal interval per entry (low–high, marker at representative), a
    summary diamond at the weighted median/IQR, matrix encoded by color. Default
    = forest; a toggle switches to the **stacked-interval** view. **Invoke the
    `dataviz` skill before writing chart code** for palette/mark/axis/legend
    conventions (light + dark, accessible categorical colors). No chart library —
    inline SVG.
  - **`DrugMonographSidebar.tsx`** — the summarized-parameter boxes render the
    summary value from `parameterSummaries` (falling back to the cache/authored
    value), with an expander that mounts `ParameterEntryList` +
    `ParameterForestPlot`. Collapsed box shows only the summary.
  - **`ReferenceConcentrationsAdminSection.tsx`** → generalize to
    `ParameterEntriesAdminSection.tsx` with a `parameter` selector.
  - **`src/pages/SimulatorPage.tsx`** — overlay path stays on
    `buildSimulatorReferenceRangeFromParameters` (cache); no change required.
- **i18n:** `parameterEntries.forestPlot.*` (`title`, `stackedToggle`,
  `forestToggle`, `summaryDiamond`, `matrixLegend`), axis labels, expand/collapse,
  empty-state — both locales.

**Tests:** `ParameterEntryList.test.tsx`, `ParameterForestPlot.test.tsx`
(render, matrix grouping, summary line, toggle), extend the admin-section test,
and `tests/api/drugs-route.test.ts` for the enriched single-drug response.

---

## Phase 5a — Generalize to all range params (shipped)

Between-source spread is not a concentration-only phenomenon: a half-life, logP,
blood:plasma ratio or protein-binding figure differs from paper to paper
(method, population, assay), so the literature spread IS the parameter's range.
`summarizable` was therefore broadened from the five interpretive concentrations
to every range parameter with real literature variance.

What that required beyond the flag flip:

- **`matrix` / `scenario` are concentration dimensions**, so both columns became
  nullable (`0085`). Forcing a matrix on a half-life would record a dimension the
  source never reported. The registry now carries `scenarioRelevant` alongside
  `matrixRelevant`; the entry schema requires each dimension exactly where its
  flag is set and rejects it everywhere else.
- **Validation moved from hardcoded concentration rules to the registry**
  (`validateEntryForParameter`): allowed units come from the parameter's own
  `allowedUnits`, bounds from its `bounds` — which for logP/logD/pKa admit
  NEGATIVE values. Both the POST and PATCH endpoints call it explicitly rather
  than folding it into the request schema: an update payload carries no
  `parameter` (immutable on the row, and older queued proposals omit it), and a
  zod issue would surface as an uncoded English 400 that the editor could only
  print verbatim. Called directly, both return
  `param_entry_invalid_for_parameter`, which is translated at the React
  boundary. The STORED payload (`parameterEntryInputSchema`) keeps the rules
  inline so a queued proposal is re-validated at approval.
- **`src/lib/parameterUnits.ts`** owns unit handling: which units an entry may
  carry, and conversion. Concentrations pivot as before; other families are plain
  linear rescales (`mL/min` ↔ `L/h`, `g`/`µg` ↔ `mg` for absolute doses, and
  pointedly NOT `L/h` ↔ `L/h/kg` or `mg/kg` ↔ `mg`, which differ by a body weight
  or dosing interval no entry carries); dimensionless parameters store `''`. A
  unit with no defined conversion is excluded from the pool and disclosed by the
  forest plot's "not shown" note — never silently rescaled.
- **The blood:plasma ratio is now both entry-backed and a normalization input**
  for every concentration aggregate, so an entry on it restales this drug's
  concentration caches. `recomputeParameterAndDependents` handles that cascade on
  the admin-direct and approved-edit paths; `recomputeSummariesCitingCitation`
  runs it too, because a paper re-score can move the pooled ratio without any
  entry changing. The sweep is scoped to parameters that actually have entries
  (or a stale derived cache) rather than the whole registry, so it does not grow
  with every parameter added.
- **The forest plot picks its axis from the parameter, not the data.** logP,
  logD and pKa carry `alreadyLogarithmic` in the registry: they ARE logarithms,
  so a log axis would transform them twice and flatten the spread between
  sources. Those plot linear regardless of sign, as does any summary containing a
  value ≤ 0 (which a log axis cannot place at all).
- **Identical recomputes no longer write a revision.** A sweep now touches ~20
  parameters instead of five, so a no-op cache write would spray duplicate rows
  through `ParameterHistoryDialog` (risk 5 below). "Identical" covers provenance
  as well as the number: swapping an entry's citation for another paper reporting
  the same value leaves the aggregate untouched but must still record a revision,
  because `referenceIds` on the revision chain is what
  `collectParameterCitationUsageForDrug` reads to answer "which parameter cites
  this reference?".

Two invariants the wider sweep put under new pressure:

- **The grandfather rule now guards against the placeholders themselves.** A
  `grandfathered` row is a migration artifact, not a source, and a parameter
  backed only by one stays hand-editable — so a curator may have corrected the
  value since. `recomputeAndCacheParameterSummary` therefore refuses to publish
  an aggregate built from grandfathered rows alone over a value it did not
  derive; only a real source entry takes over.
- **Locking is per DRUG, not per parameter** (`lockDrugForRecompute`, taken at
  the top of `recomputeAndCacheParameterSummary` and `recomputeSummariesForDrug`).
  Recomputes are not independent per parameter — B/P and molecular weight
  normalize every concentration aggregate — so a per-parameter lock made that
  dependency raceable both ways: an ABBA deadlock between a B/P mutation and a
  molecular-weight sweep, and a visibility hole where a sweep chose its parameter
  set from committed state and so missed a concurrent transaction inserting a
  drug's FIRST entry for one (that transaction then published a cache normalized
  with the pre-change ratio, and nothing revisited it). One lock at the level the
  work spans removes both. `recomputeSummariesCitingCitation` is the only path
  that locks several drugs; it sorts by drug id so two re-scores acquire in the
  same order.

Excluded on purpose: `loq`, `lod` and `analyteStability` — matrix-specific
analytical properties whose per-matrix summary is still an open design; and the
metadata parameters, which are identity constants rather than measurements.

---

## Phase 5b — Retire legacy surfaces

- Remove the `api/reference-concentrations.ts` shim, the
  `referenceConcentrationsApi.ts` / `ReferenceConcentrationsList.tsx` re-export
  shims, and the `referenceConcentrations` alias in `db/schema.ts`. Update
  `agents/drug-db-maintainer.md`.
- Optional migration to drop unused legacy columns if product confirms they are
  superseded by `note`/`parameter`.

---

## Open questions / risks

1. **Weighting formula is a product/scientific decision.** The `(n, reviewScore)`
   weighting and IQR-vs-min/max choice affect the displayed "truth." Ship behind
   a single exported constant, get forensic-toxicologist sign-off, and consider
   an admin-visible "how this summary is computed" note.
2. **Grandfather ambiguity.** A drug with both a hand-authored value and a later
   single weak entry: the recompute overwrites the authored value the moment the
   first entry lands. Consider back-filling authored values as synthetic entries
   (citation = the `drug_parameter_revisions.referenceId`) during Phase 1 so
   nothing is silently replaced. Recommended: add that back-fill to `0078` for
   parameters that have an authored value but no legacy rows.
3. **Cache/entry divergence.** Compute-on-write can drift if an entry is mutated
   outside the store. Mitigation: a `scripts/` reconcile task and an integration
   test asserting `recomputeAndCacheParameterSummary` is idempotent.
4. **`edit_type` length.** `param_entry` (11) is safe; do NOT use
   `concentration_entry` (20, at the column limit).
5. **Revision-history noise.** Every entry edit writes a recompute revision;
   this could flood `ParameterHistoryDialog`. Tag recompute revisions distinctly
   (`editSummary` prefix) so the UI can group/collapse them.
6. **Molar entries without MW** drop from the numeric summary but are still
   listed — the forest plot must communicate "not included in summary" without
   an inline review-status-style badge (a neutral axis note, not a warning glyph).
7. **`scenario` vs `parameter` overlap.** Both encode the interpretive bucket for
   concentrations. Keep `scenario` as optional finer context (postmortem poly vs
   mono) but make the `parameter` the authoritative bucket to avoid
   double-classification.

## Critical files

- `db/schema.ts`
- `src/lib/drugParameters.ts`
- `api/_lib/pending-edits-helpers.ts`
- `src/lib/referenceConcentrationsOverlay.ts`
- `api/_lib/reference-concentrations-helpers.ts`
