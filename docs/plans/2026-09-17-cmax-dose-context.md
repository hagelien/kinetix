# Cmax source values with structured dose context

Status: reviewed; implementation in progress. Tracked by the epic issue 1338, whose
subtasks are the four release boundaries of *Migration strategy* plus the four
post-release-D features.

**Release A is merged** (issue 1339, by issue 1351): the drug teardown in `api/drugs.ts`
deletes the drug's `parameter_entries` explicitly instead of leaving them to the
`drug_id` cascade, so the `ON DELETE RESTRICT` release B adds never meets a row
it would refuse.

The regression guard is `tests/api/drugs-route.test.ts` — it asserts the entries
are deleted **before** the drugs row, which is the property that matters.
`tests/integration/drug-delete-parameter-entries.test.ts` drives the real handler
against a migrated PGlite schema and is the better end-to-end exercise, but it
**cannot** stand in for that guard while `parameter_entries.drug_id` is still
`ON DELETE CASCADE`: it asserts the entries are absent once the drug is gone, and
the cascade alone satisfies that. Drop the explicit delete and it still passes.
The two tests are not interchangeable. Release B1 made the integration test
cascade-insensitive — not with the restrictive FK, which turned out not to be able
to detect the regression (see the correction under *The self-reference breaks drug
deletion*), but with a test-only trigger recording whether each entry was deleted
while its drug row still existed.

**Release B (issue 1340) is implemented** in issue 1360, as the sequenced slices below —
one PR, since one branch carries them, reviewed commit by commit. Release C (issue 1341)
must not start until issue 1360 is merged **and deployed everywhere**: release C's
writers are only safe once every instance runs these handlers.

What the implementation settled that the text below leaves open:

- **Gate**: `DOSE_CONTEXT_AUTHORING_OPEN` in `src/lib/drugParameters.ts`. Release C
  flips it; nothing else changes to open authoring.
- **Registry**: `entryBacked` is a real flag, and `parameterHasDrugLevelValue`
  keeps an entry-only parameter out of every drug-level surface. Without the flag
  an unsummarized parameter read as hand-authored.
- **Drug delete** *refuses* (409) while another substance's entry or open proposal
  names the drug in its dose context. It does not delete those proposals, for the
  same reason the RESTRICT key protects stored entries: they are someone's
  evidence about a different substance.
- **Merge** repoints the nested ids in every active proposal with one atomic JSONB
  update per path (amendment 8's alternative). A concurrent PATCH serializes
  against it because the PATCH now takes the same locks.
- **Concurrency** is tested on real Postgres
  (`tests/governance/transaction/real-postgres-param-entry-locks.test.ts`): both
  orders against delete and against merge, an update proposal racing a merge in
  both id orders, and the primitive joining its caller's connection.

The slices:

1. **B1** — the nullable columns and both `ON DELETE RESTRICT` foreign keys
   (migration 0127), the merge repointing both columns, the delete refusal when
   *another* drug's entry names the drug, and the cascade-insensitive delete test.
2. **B2** — the duplicate-identity predicates (store, importers, merge) over the
   complete entry shape.
3. **B3** — the read-side model and serialization, the field-aware store write
   path, `centralValue` in the value enumerations, approval-side parsing, the
   registry contract and Cmax entry, and the Cmax-authoring gate.
4. **B4** — the nested-payload handlers and the locking protocol, as amended by
   *Owner review of the locking design* below.

Release A was confirmed in production before B1 began.

**Features 5–7** (after release D): what the implementation settled.

- **Normalizer**: `src/lib/cmaxNormalization.ts`, pure and shared. It checks in a
  fixed order and gives exactly one reason per entry. The four *not poolable*
  reasons keep a visible normalized value; every other reason leaves none. The
  blood:plasma ratio is taken only from sourced, point-valued entries.
- **Summary read model**: `GET /api/parameter-entries?drugId=…&summary=cmax`
  (`getCmaxSummaryForDrug`). It returns every entry's outcome, the strata and a
  headline. The headline has exactly three shapes: one stratum (its weighted
  median and between-cohort spread), several (no single number), or none.
- **Toggle**: the Cmax section on the drug page switches between *Observed Cmax*
  and *Per dose*. Per-dose mode fetches the summary on demand. It labels each
  stratum with what its readings share. Every reading shows its normalized value
  or the reason it was left out.

**Step 8, agent curation** (issue 1346): what the implementation settled.

- **Queue lane**: the gap queue has a fourth lane, `fill_kind: "observation"`,
  over `DOSE_CONTEXT_OBSERVATION_PARAMETERS`. The list is derived from the
  registry: every `doseContext: 'required'` parameter whose authoring gate is
  open. One live entry retires a pair, the same test the model declarations
  use, and the lane ranks last. Before it existed, Cmax was a legal focus
  target, but ticking it narrowed the queue to nothing.
- **Instructions**: `agents/drug-db-maintainer.md` §5 documents the payload and
  the omit-when-unstated rule. `tests/cmax-curation-prompt.test.ts` fails when a
  dose-context field or vocabulary member is missing from it.
- **Review card**: the administered and interacting drugs are shown by name
  (`doseContextDrugNames`), not by id. A metabolite Cmax is filed against the
  metabolite and dosed as its parent, so the parent's name is the fact the
  reviewer checks.
- **Seeding**: no backfill. The corpus comes from the routine working the lane,
  through the ordinary review queue.
Date: 2026-09-17

## Problem

Kinetix is adding `Cmax` as a global drug parameter. Unlike many existing source-entry-backed parameters, a reported peak concentration is not interpretable independently of the administered dose and administration context.

Two papers may report very different raw Cmax values while describing essentially the same dose-proportional exposure. Conversely, dividing by dose can create a false sense of comparability when route, regimen, infusion duration, matrix, or dose family differ.

The current `parameter_entries` model is already the correct evidence layer: one row is one source value with structured context such as matrix, scenario and route. Dose should join those dimensions rather than being hidden in `comments`.

## Goals

1. Store the reported Cmax exactly as the source reports it, including which statistic it is.
2. Store dose and the minimum administration context needed to interpret that Cmax as structured fields on the same source entry.
3. Derive dose-normalized Cmax at read/aggregation time. Never store a second normalized copy of the concentration.
4. Let users switch the source-value / forest-plot view between observed Cmax and dose-normalized Cmax.
5. Make future dose-vs-Cmax plots possible without scraping prose.
6. Avoid silently pooling biologically incompatible observations.
7. Support metabolite Cmax values where the measured analyte is not the administered substance.
8. Keep the design reusable for later dose-dependent endpoints such as AUC.

## Non-goals for the first implementation

- infer a dose from prose in `comments`
- fit a population PK model
- claim dose proportionality from one or two observations
- convert weight-normalized doses to absolute mass without an observed body weight
- normalize dose ranges by an invented midpoint or by a source-supplied representative dose
- pool single-dose and steady-state observations into one headline estimate
- pool observations whose route, formulation, IV input mode, exposure state or reported
  statistic is unknown
- pool observations across different dose levels, which would assume the dose proportionality
  this RFC declines to claim
- model dose history beyond "the preceding regimen was regular, or it was not"
- substitute a default blood:plasma ratio when the real one is missing

## Core design

### 1. Cmax is a raw source measurement

A Cmax source entry stores the measured concentration on the entry itself:

```ts
{
  parameter: 'cmax',
  centralValue: 0.084,
  centralStatistic: 'arithmetic_mean',
  low: 0.070,
  high: 0.098,
  intervalKind: 'sd',
  unit: 'µmol/L',
  matrix: 'plasma',
  ...
}
```

The canonical evidence remains `0.084 µmol/L`. A normalized value such as `0.042 µmol/L/mg` is derived from that evidence and its dose context.

### 1a. The reported statistic must survive storage

The existing entry value fields cannot express a Cmax summary faithfully. `median` is
interpreted as a median by `entryRepresentative` and by every consumer downstream of it, and
`low`/`high` are interpreted as interval bounds with no record of what kind of interval they
are. Cmax is normally reported as an arithmetic mean ± SD, as a geometric mean with a
confidence interval, or as a median with a subject range. Writing a reported mean into
`median` would silently relabel the statistic, and storing an SD interval in `low`/`high`
would make it indistinguishable from a 95% CI or an observed min–max.

That is a change of the reported measurement, so it is not acceptable to paper over it. Add
an explicit statistic representation to `parameter_entries` alongside the dose columns:

```ts
centralValue      numeric(14, 6) | null
centralStatistic  varchar(24)    | null
intervalKind      varchar(24)    | null
```

```ts
type CentralStatistic =
  | 'arithmetic_mean'
  | 'geometric_mean'
  | 'median'
  | 'single_subject'
  | 'unknown';

type IntervalKind =
  | 'sd'
  | 'sem'
  | 'ci95'
  | 'iqr'
  | 'range'
  | 'unknown';
```

Rules:

- `centralValue` is the reported central estimate; `centralStatistic` names what it is.
- **`centralStatistic` is required exactly when a central value exists *and is not a
  censored threshold*.** Two shapes carry no labelable central estimate, and requiring a
  statistic for either would have made its own promised outcome unreachable:

  - an entry reporting only `{ low, high, intervalKind: 'range' }` has nothing to label, so
    its truthful `centralStatistic` is null;
  - a **censored** report such as `< 5 ng/mL` has a threshold, not a central estimate. It is
    stored as `{ centralValue: 5, qualifier: '<' }` with **`centralStatistic` absent**, and
    supplying one is **rejected**: 5 is neither the mean nor the median of anything, and
    labelling it either states something the paper does not. The `median` shorthand may not
    be used with a `qualifier` for the same reason — canonicalization would turn a
    censoring threshold into a reported median, which is the relabelling section 1a exists
    to prevent. `intervalKind` is likewise **forbidden, not merely optional**: a threshold
    is not an interval, so there is no interval whose kind could be named, and "not
    required" left `{ centralValue: 5, qualifier: '<', intervalKind: 'sd' }` passing every
    invariant — it satisfies the centre requirement, has no disagreeing bounds, and
    satisfies the symmetry check vacuously — after which the normalized row would carry an
    SD label for `< 5`. Supplying an `intervalKind` with a `qualifier` is rejected at write.
    The repository's existing rule that every provided bound on a qualified entry must agree
    keeps the remaining shape unambiguous.

  Without these two exemptions there was no truthful way to store a censored Cmax at all:
  `centralValue` demanded a statistic the paper does not supply, `median` asserted one it
  does not claim, and a lone bound fell foul of the `intervalKind` requirement — so the
  `censored_value` outcome promised below could never be reached.

  "No central value, therefore no statistic" and "a threshold, therefore no statistic" are
  both coherent. "A central value whose kind the paper never states" is the one this rule
  refuses.
- `'unknown'` is a truthful label, not a satisfied requirement. An entry **that has a
  central value** and whose paper does
  not say whether it is a mean or a median is **raw evidence only**: it is
  normalization-ineligible with reason `unlabelled_statistic`, and it never forms an
  `'unknown'` pooling stratum. The same holds for `intervalKind: 'unknown'`, whose bounds
  are displayed but never treated as a range, an SD or a CI. A headline is never produced
  from unknown-statistic entries merely because no better stratum exists — in that case the
  drug has no normalized headline, which is the correct answer.
- `low`/`high` keep their existing meaning as bounds, and `intervalKind` names what the
  bounds are. For **Cmax the two are required together**: bounds with no `intervalKind` are
  rejected at write, as is an `intervalKind` with no bounds (see the two-way rule below).
  An earlier draft said such an entry "is `'unknown'`, not a range" — that reading survives
  only for the **legacy non-Cmax entries** whose null fields are preserved unchanged, and it
  is not a path a Cmax write may take.
- `median` remains legal for a genuinely reported median and *means* the same as
  `centralValue` with `centralStatistic: 'median'` — but for Cmax the two are **canonicalized
  to one stored shape on write**, not merely treated as equivalent by readers.

  A Cmax write that supplies `median` has it moved to `centralValue` with
  `centralStatistic: 'median'`, and `median` stored as null; supplying both with equal values
  is accepted and canonicalized the same way; supplying both with *different* values is
  rejected. Without this, one reported median could be stored in three shapes, and the
  complete-entry-shape duplicate comparison (release B) compares *stored* fields — so the
  same cohort submitted twice in two spellings would not collide, would pass duplicate
  detection, and would be **counted twice in the same stratum**. Semantic identity that the
  dedup predicate cannot see is not identity.

  Canonicalizing on write rather than defining cross-shape equality in the predicate is the
  cheaper half: one rule at one seam, instead of every comparison site having to know the
  shorthand. Legacy non-Cmax entries keep `median` as they are — they predate
  `centralStatistic` and nothing rewrites them.
- Existing non-Cmax entries are untouched and read as before: a null `centralStatistic`
  means the entry predates this field and carries the legacy `median`/`low`/`high` reading.

Derived and displayed values must carry the statistic with them. A dose-normalized
arithmetic mean is a normalized arithmetic mean, and a normalized SD interval is not a
confidence interval; the forest plot and the headline summary must label the statistic they
are showing rather than presenting every row as a comparable point estimate. Pooling across
statistics — a geometric mean with an arithmetic mean — is a stratification concern, not a
silent average; see the pooling key below.

### 2. Dose is structured source-entry context

Add the following columns to `parameter_entries`. **Every one is nullable at the database
level, `administeredDrugId` included.** Its requirement is carried by a parameter-scoped
CHECK, not by column nullability — see below for why a `NOT NULL` column would both fail the
migration on legacy rows and reject writes from the previous deployment:

```ts
doseValue                  numeric(14, 6) | null
doseLow                    numeric(14, 6) | null
doseHigh                   numeric(14, 6) | null
doseUnit                   varchar(20)    | null
administeredDrugId         integer        | null   (required for dose-context params)
doseRegimen                varchar(20)    | null
doseIntervalHours          numeric(10, 4) | null
doseNumber                 integer        | null
regimenDurationHours       numeric(10, 4) | null
priorDosingRegular         boolean        | null
ivInputMode                varchar(16)    | null
administrationDurationMin  numeric(10, 4) | null
releaseProfile             varchar(20)    | null
physicalForm               varchar(20)    | null
prandialState              varchar(16)    | null
doseBasis                  varchar(20)    | null
doseSaltForm               varchar(60)    | null
coadministrationState      varchar(24)    | null
interactingDrugId          integer        | null
pkPopulation               varchar(32)    | null
populationQualifier        varchar(80)    | null
valueBasis                 varchar(24)    | null
```

`route` already exists and should be reused. Do not add a second route column for dose context.

`administeredDrugId` is required **for parameters that declare dose context**, and
self-administration is then stored as an explicit self-reference
(`administeredDrugId = drugId`) rather than as null. For every other parameter the column
stays null, and a partial CHECK carries the requirement:

```sql
CHECK (parameter <> 'cmax' OR administered_drug_id IS NOT NULL)
```

— generalised to whatever set of parameters declares `doseContext: 'required'`.

It is deliberately **not** a blanket `NOT NULL` with a whole-table backfill. Setting
`administered_drug_id = drug_id` on every legacy row would assert that each analyte was the
substance administered, which is false for data this repository already holds and documents.
`drugParameters.ts` says so directly about Tmax: "A metabolite's time to peak is measured
after the *parent* is dosed, and it is a routine published endpoint — cocaine studies report
benzoylecgonine's tmax, heroin studies 6-MAM's, nicotine studies cotinine's." Backfilling
those rows would have them claim benzoylecgonine, 6-MAM and cotinine were administered. No
legacy field establishes administration identity, so nothing can be inferred for them, and
inventing provenance on curated evidence is worse than leaving it unrecorded.

Null therefore keeps its honest meaning for legacy rows — *not recorded* — while for a
dose-context parameter the value is always explicit and never inferred.

Encoding "same as the analyte" as null would give the same fact two representations as soon
as drugs are merged. When a merge repoints the FK, an entry whose analyte is the merge
winner and whose `administeredDrugId` pointed at the loser becomes an explicit
self-reference, while every equivalent entry authored on the common path is still null. The
two forms then produce different importer/dedup keys and different pooling strata unless
every live row and every pending payload is normalized before collision detection — and a
CHECK constraint forbidding a self-reference would instead make the merge itself fail.
Cmax has no legacy rows to preserve, so the explicit FK is both the simpler contract and the
one that lets merge repoint and dedupe this field exactly like other identity fields.

The FK is `ON DELETE RESTRICT`: administered-drug identity is provenance, and evidence must
never be silently detached from the substance that produced it.

The distinction the field exists for is unaffected:

```text
entry drug: norclonazepam
administered drug: clonazepam
dose: 2 mg
parameter: cmax
```

The FK must participate in drug merge/repoint logic. Deleting or merging a parent drug must
not leave metabolite PK evidence ambiguous or dangling, and merge-time dedup must compare
the repointed value, so an entry that becomes a self-reference through a merge collides with
an identical self-referencing entry instead of surviving as a duplicate.

### 3. Dose representation

Exact nominal dose:

```ts
{ doseValue: 2, doseUnit: 'mg' }
```

Dose range reported by a pooled cohort:

```ts
{ doseLow: 1, doseHigh: 4, doseUnit: 'mg' }
```

A non-degenerate dose range is valid evidence, but it is **never** eligible for
`Cmax / dose` normalization on the strength of a representative dose — not even one the
paper supplies itself. If a cohort received 1–4 mg and the paper names 2 mg as typical,
dividing the cohort's summary Cmax by 2 does not yield the summary of the participants'
Cmax/dose ratios: dose and concentration are paired per subject and the relationship may be
nonlinear, so the quotient is an observation no one made. Synthesizing a midpoint is the
same error with a worse denominator.

A range-only entry contributes to the normalized summary in exactly two ways:

1. the source itself reports a dose-normalized statistic, which is stored as a **declared
   dose-normalized value** (see below) and never derived, or
2. the curator splits the exact-dose arms into separate entries, each with its own
   `doseValue` and its own reported Cmax.

### A source-reported normalized value needs its own shape

Path 1 was previously stated as an eligibility exception with no representable form. An
entry reporting only Cmax/dose has no `doseValue` to divide by, while the entry value
contract otherwise describes a concentration — so implementing the exception literally would
have meant mislabelling an already-normalized value as a raw Cmax, dividing it a second
time, or leaving it ineligible in contradiction of the promise. All three are wrong.

The entry therefore declares which quantity it holds:

```ts
type ValueBasis = 'concentration' | 'dose_normalized';
```

```ts
valueBasis  varchar(24) | null
```

- `'concentration'` (the default, and what every existing entry is) — the value is a
  measured concentration, its unit is a concentration unit, and the derivation in
  **Derived normalization** applies.
- `'dose_normalized'` — the source reported the ratio itself. The unit is a
  concentration-per-dose unit such as `µmol/L/mg`, the value is already normalized, and the
  normalizer **skips the division only** — it still canonicalizes both halves of the unit.

"Passed through" means the recorded dose is never divided out a second time. It does **not**
mean the number is left alone: a declared ratio in `µmol/L/µg` is the same quantity as one
a thousand times larger in `µmol/L/mg`, so leaving it unconverted would either keep it out
of the canonical-unit stratum it belongs in or, worse, label it with a 1000-fold error.
Numerator and denominator are both converted to canonical units exactly as for a derived
ratio; only the division step is bypassed.

A declared ratio takes whatever dose context the source actually states, and all three
shapes are legitimate:

- **exact** — a paper reporting Cmax/dose for a fixed 2 mg arm truthfully has
  `doseValue: 2`. That is the honest context and must be storable; `valueBasis` alone, not
  the absence of a dose, is what suppresses the division.
- **range** — a variable-dose cohort reporting only a ratio has `doseLow`/`doseHigh`.
- **unstated** — neither, when the source gives a ratio and no dose at all. The dose family
  still resolves from the normalized unit.

The exact-dose requirement that governs `'concentration'` entries does not apply here,
because nothing is being divided. Forbidding `doseValue` on a declared ratio would have made
the commonest source-reported shape — a fixed-dose arm — unstorable.

A declared dose-normalized entry still has to satisfy the rest of the context profile —
route, formulation, prandial state, regimen, coadministration, population, statistic — and
pools only with entries of the same `valueBasis` and the same canonical normalized unit. A
derived ratio and a source-reported ratio are both legitimate, but they are not the same
kind of evidence and the summary labels which it is showing.

The observed/normalized toggle shows such an entry only in normalized mode, since there is
no observed concentration to display; its raw row states the reported ratio and its dose
range.

**`doseValue` and a non-degenerate range are mutually exclusive.** Allowing them to coexist
would give a variable-dose cohort with a paper-supplied representative dose the exact same
stored shape as a single-dose-level entry — `{ doseValue, doseLow, doseHigh }` — with nothing
in the row to tell them apart. A normalizer that trusts `doseValue` would then quietly
reinstate the representative-dose normalization rejected above, and one that excludes every
non-degenerate range would make the nominal shape unusable. Neither is acceptable, and a
discriminator that exists only in the curator's head is not a discriminator.

So the stored shapes are disjoint and a CHECK constraint enforces it:

- **exact dose** — `doseValue` set, `doseLow`/`doseHigh` null.
- **dose range** — `doseLow`/`doseHigh` set, `doseValue` null.
- a degenerate range (`doseLow == doseHigh`) is not a range. It is authored as an exact
  `doseValue` and rejected in range form, so one dose level has exactly one representation.

**Eligibility depends on `valueBasis`, not on the shape alone.** Everything in this section
about a range being unusable applies to `valueBasis: 'concentration'`, where the dose is a
denominator that has to be divided by:

- `'concentration'` + range → never normalization-eligible; `dose_range_without_exact_dose`.
- `'dose_normalized'` + range → **eligible**. The source already did the division, so the
  range is context rather than a denominator, and it yields a `'range'` dose stratum.

The eligibility table under **Validation invariants** is the single statement of this; the
rules here describe the stored shapes only.

A paper's own representative dose for a variable-dose cohort has no column. It belongs in
`comments` as prose, where nothing can normalize by it.

### Dose basis: what the mass represents

A dose number is not interpretable from its unit alone. 100 mg of a hydrochloride salt is not
100 mg of free base, and a parent dose is not an active-moiety dose. Dividing a Cmax by two
numerically equal doses on different bases divides by inequivalent denominators, and pooling
the results reports a difference in salt-factor as if it were a difference in exposure.

This repository already models the distinction and already forbids guessing it —
`src/lib/kinetics-core/types.ts` declares `DoseBasis = 'active-moiety' | 'parent' | 'salt' |
'free-base'` under the comment "The core never infers this from a label." A Cmax dose context
that omits it would be the one place in Kinetix where that inference happens by default.

```ts
doseBasis  varchar(20) | null   // reuses DoseBasis from kinetics-core
```

`doseBasis` joins the pooling key and `normalizationRequires`. It is **never inferred** —
not from the drug name, not from the salt suffix in a product label, not from a default — and
it is required for *normalization*, not for storage: a source that does not state the basis
stores honestly and is raw-evidence-only with reason `unknown_dose_basis`. See
**Required to store is not required to normalize**.

Converting between bases needs a salt factor for the specific salt form, which is separate
evidence; the first implementation does not convert at all. Different bases are simply
different strata, on the same footing as the absolute/weight-normalized family split below.

**`'salt'` alone is not a stratum.** `DoseBasis` records that a salt mass was reported, not
*which* salt, and two salts of the same analyte have different salt factors — so a
hydrochloride dose and a mesylate dose both labelled `'salt'` carry different active-moiety
masses and would pool as if equal. That is the same defect `doseBasis` was added to prevent,
one level down.

```ts
doseSaltForm  varchar(60) | null   // e.g. 'hydrochloride', 'mesylate'
```

- `doseBasis: 'salt'` **with** `doseSaltForm` — poolable, and the salt form joins the
  pooling key, so only identical salt forms pool.
- `doseBasis: 'salt'` **without** `doseSaltForm` — normalizable and fully visible, but
  **not poolable**, reason `unspecified_salt_form`.
- the other three bases (`'free-base'`, `'parent'`, `'active-moiety'`) are unambiguous
  masses and need no qualifier.

`doseSaltForm` is recorded as the source states it and, like `doseBasis`, is never inferred
from a drug name or product label. Normalizing salt-form spellings into a controlled
vocabulary, and applying reviewed salt factors to convert between forms, are both later
work; until then different spellings are different strata, which is conservative in the
right direction.

The initial dose-unit vocabulary should distinguish conversion families:

```ts
absolute mass:       µg, mg, g
weight normalized:   µg/kg, mg/kg
```

`mg/day` and `mg/kg/day` belong to dosing-rate / regimen descriptions, not to the denominator of a single-dose Cmax normalization. They should not be accepted as exact Cmax-normalization dose units.

Absolute and weight-normalized families must never be converted into each other without an observed body weight.

### 4. Regimen is structured, not prose

Initial vocabulary:

```ts
type DoseRegimen =
  | 'single'
  | 'multiple'
  | 'steady_state'
  | 'unknown';
```

For repeated dosing, `doseValue` means the per-administration dose. `doseIntervalHours`
records the interval when known.

Per-administration dose and interval do **not** identify the exposure state. Cmax after the
second 10 mg q12h dose and Cmax after the twentieth differ through accumulation, yet they
share dose, unit, route, regimen and interval. Repeated dosing therefore needs the exposure
position too:

```ts
doseNumber             integer        | null  // 1-based administration index
regimenDurationHours   numeric(10, 4) | null  // elapsed time on the regimen
```

Either one identifies the exposure state **only for an unchanged, uninterrupted regimen**.
After a loading dose, a titration, a dose reduction or a missed administration, two entries
can share current dose, interval, dose number and elapsed duration while carrying quite
different accumulated concentrations. Dose number is a position in a schedule, not a
description of the exposure that produced the peak.

So the regimen's own regularity must be asserted, not assumed:

```ts
priorDosingRegular  boolean | null   // every preceding dose followed the recorded regimen
```

`true` means the curator has confirmed from the source that dosing up to this observation
was constant and uninterrupted. `null` (the paper does not say) and `false` (it did not)
both make the entry `unsupported_regimen_context` — fully visible as raw evidence, never in
a normalized stratum. Dose history richer than a boolean is deliberately out of scope for
the first implementation; a parameter that cannot be asserted is excluded rather than
approximated.

`steady_state` asserts that accumulation has plateaued and needs no exposure position, but
it is still a claim about the preceding regimen, so it carries the same
`priorDosingRegular` requirement.

For the first implementation:

**Every repeated-dose entry needs a positive `doseIntervalHours` to be normalizable.** The
interval is what determines how much accumulates between doses: 10 mg q6h and 10 mg q24h are
different exposures at the same per-administration dose and the same dose number, and a
steady state reached on one interval says nothing about the other. A null interval is not a
poolable stratum, it is missing regimen context — reason `missing_dosing_interval`.

- `single` — `doseNumber` is 1 by definition; no interval applies; poolable.
- `steady_state` — an explicitly verified state, requiring `priorDosingRegular: true` **and**
  a positive `doseIntervalHours`; poolable within its own stratum, and never pooled with
  single-dose values.
- `multiple` — **ineligible for the normalized headline summary** unless it has a positive
  `doseIntervalHours`, `priorDosingRegular: true`, **and** `doseNumber` or
  `regimenDurationHours`; it then pools only with observations sharing interval and exposure
  position. Missing any of the three leaves it fully visible as raw evidence with the
  corresponding reason.
- `unknown` — never poolable, with reason **`unknown_dose_regimen`**. `doseRegimen` is
  nullable, so a paper that omits the regimen stores as null or `'unknown'`; **both map to
  that one reason**, and neither is `unresolved_exposure_state`, which is specifically a
  `multiple` regimen whose exposure position is missing. Without its own member the
  normalizer had no typed outcome for the commonest case of all — a paper that simply does
  not say — and would have had to either admit the entry or invent an untyped reason.

Example:

```ts
{
  doseValue: 2,
  doseUnit: 'mg',
  doseRegimen: 'steady_state',
  doseIntervalHours: 12
}
```

A steady-state Cmax may still be shown as dose-normalized, but it must not be silently
pooled with single-dose values. Accumulation and interval are part of the interpretation.

### 4a. Formulation is part of the observation

An immediate-release and an extended-release product can share analyte, dose, route,
regimen, interval and administered drug and still produce materially different peaks — that
is what modified release is *for*. Nothing in the model above separates them, so the minimum
pooling key would put a 2 mg IR tablet and a 2 mg ER tablet in one stratum and publish a
headline that describes neither. `comments` cannot prevent this: prose is not a key.

Formulation becomes structured context — but as **two independent axes**, not one enum. A
single vocabulary mixing `immediate_release` with `suspension` would force a
modified-release suspension to discard one of its two dimensions: filed as `suspension` it
pools with an immediate-release suspension, filed as `modified_release` it pools with
tablets whose release behaviour differs materially. Whichever the curator picks, something
untrue gets pooled.

```ts
type ReleaseProfile =
  | 'immediate'
  | 'modified'
  | 'not_applicable'   // forms with no release step, e.g. an IV solution
  | 'unknown';

type PhysicalForm =
  | 'tablet_capsule'
  | 'solution'
  | 'suspension'
  | 'other'
  | 'unknown';
```

**`physicalForm` names the dosage form only, never the route class.** An earlier draft
included `'parenteral'`, which overlapped every other member: an IV solution is both
`'parenteral'` and `'solution'`, an IM depot both `'parenteral'` and `'suspension'`. Since
`physicalForm` is an *exact* pooling-key dimension, that overlap cut both ways and both were
wrong — two curators labelling identical IV cohorts `'parenteral'` and `'solution'` split a
stratum that should pool, while an IM solution and a depot suspension both filed as
`'parenteral'` pool despite materially different peaks, which is the precise failure this
section exists to prevent.

Route-class already lives in `route`, and the two dimensions are independent members of the
pooling key, so a route class inside the form vocabulary was redundant as well as
ambiguous.

```ts
releaseProfile  varchar(20) | null
physicalForm    varchar(20) | null
```

Both join the pooling key, independently. A modified-release suspension is
`{ releaseProfile: 'modified', physicalForm: 'suspension' }` and pools only with the same
pair.

`'modified'` deliberately covers extended, sustained, delayed and controlled release as one
class for the first implementation; splitting it further needs evidence we do not have yet.
It is the one remaining lump in this model, and it is a known limit rather than an oversight:
until the data can distinguish those profiles, a `'modified'` stratum is labelled as
covering mixed release behaviour wherever it is displayed.

`'unknown'` on either axis, and `physicalForm: 'other'`, are raw-evidence-only with reason
`unknown_formulation`; neither forms a stratum of its own. An IV bolus of a plain solution is
`{ releaseProfile: 'not_applicable', physicalForm: 'solution' }`.

`'not_applicable'` is keyed on the **form**, not the route: an IV solution has no release
step, but an IM depot suspension plainly does, and it is `{ releaseProfile: 'modified',
physicalForm: 'suspension' }` like any other extended-release product.

### 4b. Prandial state for oral administration

Food materially alters absorption — rate as well as extent — so an oral cohort dosed with a
meal and one dosed fasting are not interchangeable observations of the same drug. Nothing
above separates them, and `comments` cannot participate in a pooling key.

```ts
type PrandialState = 'fasted' | 'fed' | 'unspecified';
```

```ts
prandialState  varchar(16) | null
```

`prandialState` joins the pooling key, and `'unspecified'` — including the very common case
of a paper that simply does not say — is raw-evidence-only with reason
`unknown_prandial_state`, forming no stratum of its own.

**Which routes it applies to is an exhaustive list, not a description.** "Oral and other
enteral routes" and "routes where food cannot affect the peak" are prose that two
implementers can partition differently — `sublingual` and `rectal` sit on the line, and
`ROUTE_IDS` is a flat vocabulary with no classifier to appeal to. Over the seven resolved
routes (`'other'` never reaches this question; it is `unresolved_route` by the rule above):

- **`prandialState` is required for `oral` only.** That is where a food effect is
  established, routinely reported, and large enough to move a peak.
- **it is vacuously satisfied for `intranasal`, `iv`, `im`, `sublingual`, `inhalation` and
  `rectal`** — a missing value on these is never `unknown_prandial_state`, and they pool
  without it.

On the six vacuous routes the normalized entry carries **`prandialState: null`**, not
`'unspecified'`, and null contributes nothing to the pooling key. Two null entries pool
freely, which is safe because `route` is itself a key dimension: a null prandial state can
only ever meet another null one within a single non-`oral` route.

That is deliberately unlike `doseStratum: 'unstated'`, which matches nothing including
another `'unstated'`. The two look similar and are opposites: an unstated dose records that a
real, Cmax-determining quantity is **unknown**, while a null prandial state records that the
question **does not apply** to this route. Unknown never joins; not-applicable always does.

`sublingual` and `rectal` are the deliberate calls. Both bypass gastric emptying and
first-pass exposure to a meal, and neither has a food-effect literature comparable to oral
dosing; requiring a prandial state for them would discard real evidence to satisfy a
covariate nobody reports. If evidence later shows a material food effect on either, moving
it into the required set is a one-line change with its own review — which is the point of
listing routes rather than describing them.

The same treatment applies to the other route-conditional requirement: **`ivInputMode` is
material for `iv` only.** Bolus-versus-infusion is an intravascular distinction; an `im`
depot, an `inhalation` and a `sublingual` dose have no input mode to resolve, and a missing
value on any non-`iv` route is never `unknown_iv_input_mode`.

A test covers **every** `RouteId`, so a route added to `ROUTE_IDS` later fails a test rather
than silently landing in whichever bucket an implementer assumed.

A finer meal-composition vocabulary (high-fat versus light breakfast, as regulatory
bioequivalence work distinguishes) is a later refinement. `'fed'` is one class for the first
implementation, and like `'modified'` release it is labelled as such where displayed rather
than presented as a homogeneous condition.

### 4c. Concomitant treatment

A drug-interaction arm can match every dimension declared so far — same analyte, dose,
route, formulation, prandial state, regimen, matrix and statistic — while coadministration
of a CYP inhibitor or inducer moves Cmax several-fold relative to monotherapy. That is the
entire point of a DDI study, and it makes such an arm the single most dangerous thing to
pool into a monotherapy headline.

The existing `scenario` field cannot carry this. `validateEntryValueInvariants`
(`src/lib/parameterEntries.ts:281-285`) rejects a scenario for any parameter that is not
scenario-relevant, with the message "record the study context in the notes instead" — and
notes cannot participate in a pooling key. Cmax needs its own structured field.

```ts
type CoadministrationState =
  | 'monotherapy'
  | 'with_interacting_drug'
  | 'unknown';
```

```ts
coadministrationState  varchar(24) | null
interactingDrugId      integer     | null   // FK to drugs, ON DELETE RESTRICT
```

- `'monotherapy'` is the only state eligible for the normalized headline in the first
  implementation.
- `'with_interacting_drug'` is stored, fully visible as raw evidence, labelled with the
  interacting substance where known, and ineligible with reason
  `interaction_arm_not_pooled`. These observations are valuable — a later DDI view is the
  natural home for them — but they are not monotherapy exposure and must never be averaged
  into it.
- `'unknown'` is raw-evidence-only with reason `unknown_coadministration_state`. A paper
  that does not state whether subjects were on other drugs has not established monotherapy,
  and assuming it is the failure mode this whole section exists to prevent.

`interactingDrugId` participates in drug merge/repoint logic on the same terms as
`administeredDrugId`.

### 4d. Pharmacokinetic population

A healthy-volunteer arm and a severe hepatic-impairment arm — or a CYP2D6 poor-metabolizer
cohort, or an elderly or paediatric group, or patients in renal failure — can match every
dimension declared so far and still differ in Cmax by a clinically decisive margin. That is
the whole reason such studies are run. Pooling them into one headline would produce a number
describing nobody, and would understate the exposure of exactly the patients for whom the
number matters most.

As with coadministration, `scenario` is unavailable to Cmax, so this needs its own field:

```ts
type PkPopulation =
  | 'healthy_adult'
  | 'patients_unspecified'
  | 'hepatic_impairment'
  | 'renal_impairment'
  | 'metabolizer_phenotype'
  | 'paediatric'
  | 'elderly'
  | 'pregnancy'
  | 'other'
  | 'unknown';
```

```ts
pkPopulation         varchar(32) | null
populationQualifier  varchar(80) | null   // free text: 'Child-Pugh C', 'CYP2D6 PM', '2-6 y'
```

`pkPopulation` joins the pooling key. `'healthy_adult'` is the only population that enters
the first headline summary; every altered population is stored, fully visible, labelled with
its qualifier, and ineligible with reason `altered_population_not_pooled`. `'unknown'` and
`'other'` are ineligible with `unknown_population`.

`populationQualifier` is deliberately free text and deliberately **not** in the pooling key:
it is for display, so a reader sees "Child-Pugh C" rather than just "hepatic impairment".
Nothing aggregates on it. Stratifying within an altered population — mild versus severe
impairment, poor versus ultrarapid metabolizers — needs a structured severity vocabulary
that the first implementation does not attempt; until it exists, altered populations are
raw evidence only, which is the conservative direction.

A per-population headline is the obvious follow-on once the evidence base supports it, and
is where this field pays off beyond exclusion.

### 5. Infusion duration is first-class when relevant

For IV administration, equal doses can have radically different Cmax depending on input
duration. A 2 mg bolus and a 2 mg two-hour infusion are not comparable observations, so
"duration not stated" cannot be treated as optional context that falls into a shared
null-duration stratum.

Input mode is therefore explicit rather than inferred from a null:

```ts
type IvInputMode = 'bolus' | 'infusion' | 'unknown';
```

```ts
ivInputMode                varchar(16)    | null
administrationDurationMin  numeric(10, 4) | null
```

```ts
{ ivInputMode: 'bolus' }                                    // no duration
{ ivInputMode: 'infusion', administrationDurationMin: 120 } // duration required
```

Rules for `iv`, the one route where input duration is material (see the exhaustive route
sets in section 4b — `im`, `inhalation` and the rest have no input mode to resolve):

- `'bolus'` requires a null `administrationDurationMin`; it is its own stratum.
- `'infusion'` requires a positive `administrationDurationMin` and pools only with an
  **exactly equal canonical duration**. "Comparable duration" is not a rule an
  implementation can follow: it would let a 5-minute and a 2-hour infusion share a stratum,
  in the same section that calls input duration a major determinant of Cmax. Durations are
  compared as canonical minutes after unit conversion, and equality is equality. Validated
  duration bins are a later refinement needing evidence about how much difference matters;
  until that evidence exists, exact matching is the rule that cannot silently merge
  incomparable infusions.
- `'unknown'`, and a missing `ivInputMode` on such a route, are
  **normalization-ineligible** with reason `unknown_iv_input_mode`. The entry remains
  visible as raw evidence.

`normalizationRequires` for Cmax therefore includes `'iv_input'`, which is satisfied
vacuously for routes where input duration is not material (oral, for example) and requires a
resolved mode for those where it is. A null duration never means "bolus" by convention.

## Registry contract

Add generic registry properties rather than Cmax-specific validation scattered through the
application.

Route needs a second, stricter notion than the existing one. `routeOptional: true` makes
`validateRouteForParameter` accept a missing route, which is the right behaviour for storing
a paper that never states one — but the pooling key would then drop every such entry into a
single null-route stratum, silently mixing oral, IV and unknown-route observations whose
Cmax values are not comparable at all. Route is not incidental context for Cmax; it is one
of the largest determinants of the peak.

So separate "may be stored without it" from "may be summarized without it":

```ts
type DoseContextMode = 'required' | 'optional' | 'forbidden';

interface BaseParameterSpec {
  ...
  doseContext?: DoseContextMode;
  /**
   * Context that must be known before an entry may be normalized or pooled.
   *
   * What satisfies each requirement is defined by the parameter's own contract, not
   * assumed to be "the field is non-null". For Cmax, `'dose'` is satisfied by an exact
   * dose when `valueBasis` is `'concentration'`, and by *any* dose context — exact, range
   * or none — when it is `'dose_normalized'`, because a declared ratio needs no denominator
   * to divide by. A requirement is a question the parameter answers, not a null check.
   */
  normalizationRequires?: readonly (
    | 'route'
    | 'dose'
    | 'matrix'
    | 'iv_input'
    | 'formulation'
    | 'prandial'
    | 'regimen'
    | 'coadministration'
    | 'population'
    | 'dose_basis'
    | 'statistic'
  )[];
}
```

Cmax should use:

```ts
cmax: {
  group: 'dose_exposure',
  kind: 'range',
  matrixRelevant: true,
  routeOptional: true,
  normalizationRequires: [
    'route',
    'dose',
    'matrix',
    'iv_input',
    'formulation',
    'prandial',
    'regimen',
    'coadministration',
    'population',
    'dose_basis',
    'statistic',
  ],
  doseContext: 'required',
  entryBacked: true,
  summarizable: false,
  ...
}
```

`ROUTE_IDS` ends in `'other'`, and that value is **not a known route** for this purpose. It
is a catch-all: two entries carrying it may describe quite different administrations —
transdermal and intraperitoneal, say — whose Cmax values have no reason to agree. Treating a
non-null route as a resolved one would pool them in a shared `'other'` stratum, which is the
null-route defect wearing a different label. `route: 'other'` is therefore
`{ kind: 'ineligible', reason: 'unresolved_route' }`: storable, fully visible as raw
evidence, never normalized and never pooled. A route that matters enough to pool on is a
route worth adding to `ROUTE_IDS`.

`routeOptional: true` keeps a route-less Cmax storable and visible as raw evidence.
`normalizationRequires: ['route', ...]` makes a resolved route mandatory before that entry can
be dose-normalized, enter the headline summary, or join any pooling stratum. A missing route
yields `eligible: false, reason: 'missing_route'` — visible, explained, and excluded. There
is no null-route stratum.

`entryBacked` is intentionally separate from `summarizable`.

Today most numeric entry-backed parameters are summarizable into the ordinary `drug_parameters` cache. Cmax is different: its useful headline value is dose-normalized, while its source entries are concentrations. Storing a normalized unit such as `µmol/L/mg` in the ordinary concentration-valued cache would mix two dimensions and surprise existing consumers.

A generic `entryBacked` flag also makes the existing distinction clearer for other source-entry-backed parameters that do not have one ordinary drug-level aggregate.

## The context profile is closed, and adding to it is the process

Three rounds of review produced the same finding six different ways: some dimension that
materially changes Cmax — route, dose level, formulation, IV input mode, exposure position,
prandial state — was absent from the pooling key, so observations that differ in it would
have been averaged together. Patching each one as it is spotted is not a design; the next
reviewer finds the seventh.

So the rule is inverted. **An entry is normalizable only if every dimension in the
parameter's declared context profile is resolved.** The profile is an allowlist, not a
blocklist: nothing pools by default, and a dimension that is null, `'unknown'` or
`'unspecified'` makes the entry raw-evidence-only with a named reason. There is no
"remaining context is probably fine" path, and no dimension is optional because it is often
unreported — that is the argument that produces a fabricated headline.

Cmax's declared profile is:

```text
analyte + administered drug          dose level + dose family
route                                release profile + physical form
prandial state (`oral` only)         IV input mode + duration (`iv` only)
regimen + dosing interval            exposure position (non-steady repeated)
prior-dosing regularity              matrix (with a real conversion)
dose basis (salt/free-base/...)      coadministration state
pk population
value basis                          reported central statistic
```

Adding a future dose-dependent parameter (AUC is the obvious next one) means declaring its
own profile up front and defending it, rather than inheriting Cmax's and discovering the
gaps in review.

### Known limits of the context profile

Two dimensions are deliberately coarser than the literature supports, and both are recorded
here rather than left to be rediscovered:

- `releaseProfile: 'modified'` covers extended, sustained, delayed and controlled release as
  one class.
- `prandialState: 'fed'` covers any meal, where bioequivalence work distinguishes high-fat
  from light.

Both are labelled as mixed wherever a stratum built on them is displayed, so a reader is
never told a `'modified'` headline describes one release behaviour. Splitting either is a
data question, not a schema question, and neither should be split speculatively.

## Validation invariants

For a `doseContext: 'required'` parameter:

Shape rules that hold for **every** entry:

- `doseUnit` is required whenever any dose number exists
- all dose numbers must be positive and finite
- `doseLow <= doseHigh`
- `doseValue` and a range are mutually exclusive: at most one of `doseValue` or
  (`doseLow`, `doseHigh`) is set, enforced by CHECK constraint
- **`doseLow` and `doseHigh` are both null or both present**, enforced by CHECK and by the
  API. A one-sided bound satisfies every other invariant here — it is positive, no
  `low <= high` comparison applies, and `doseValue` is absent — yet matches none of the
  exact / range / unstated shapes that eligibility and `DoseStratum` are defined over, so
  two writers could reasonably read it as either a range or a missing dose. There is no
  third shape; a half-open dose is not evidence of a dose
- a degenerate range (`doseLow == doseHigh`) is rejected; author it as `doseValue`
- daily-rate units are rejected as a Cmax dose denominator

**How much dose context is required depends on `valueBasis`**, and the CHECK constraints and
API validation must both be written that way. Stating it once, unconditionally, is what
previously left the declared-ratio shapes unstorable:

**Normalizable** and **poolable** are different questions, and conflating them is what let
unknown-dose ratios into a headline. Normalizable means a dose-normalized value can be shown
for this entry; poolable means it may join a stratum and contribute to the headline summary.

| `valueBasis` | dose context | normalizable | poolable |
| --- | --- | --- | --- |
| `'concentration'` | exact `doseValue` | yes | yes |
| `'concentration'` | range only | no — `dose_range_without_exact_dose` | no |
| `'concentration'` | none | *rejected at write* — a raw Cmax with no dose is not interpretable | — |
| `'dose_normalized'` | exact | yes | yes |
| `'dose_normalized'` | range | yes | yes, with the identical range |
| `'dose_normalized'` | none | yes | **no** — `unstated_dose_level` |

The last row is the one that needs stating outright: two source-reported ratios that both
omit the dose get the same `'unstated'` descriptor, but one cohort may have had 1 mg and the
other 100 mg. Pooling them assumes the dose proportionality settled decision 7 refuses to
claim — the same error as pooling across known dose levels, with less to go on. Such rows
stay fully visible in normalized mode, labelled with their reason, and never aggregate.

`doseBasis: 'salt'` without a `doseSaltForm` is the second normalizable-but-not-poolable
case, for the same reason: the row records that *a* salt mass was reported, which is not
enough to know the denominator. See section 3.

A declared ratio needs no dose at all because nothing is divided; the dose context it does
carry is recorded truthfully and used for the stratum descriptor.

This table is also what `normalizationRequires: ['dose', ...]` *means* for Cmax. The registry
requirement names the dimension that must be resolved, and the parameter's contract says what
resolving it takes — here, an exact dose for a concentration and any dose context for a
declared ratio. Reading the requirement as a bare non-null check would reject the
`'unstated'` shape this table makes eligible, and special-casing Cmax in the generic
evaluator would defeat the point of a registry-level contract. The generic mechanism stays
generic; the per-parameter answer lives with the parameter.
- `doseIntervalHours > 0` when present
- `administrationDurationMin > 0` when present, and only with `ivInputMode: 'infusion'`
- `ivInputMode: 'bolus'` requires a null `administrationDurationMin`
- `ivInputMode` is meaningful only for routes where input duration is material
- `doseSaltForm` is permitted only with `doseBasis: 'salt'`, and is never inferred
- `interactingDrugId` is permitted only with `coadministrationState: 'with_interacting_drug'`
- `populationQualifier` is permitted only for a non-`healthy_adult` population
- `valueBasis` is required to store; `'dose_normalized'` requires a concentration-per-dose
  unit, `'concentration'` requires a concentration unit
- **the denominator family of a declared ratio's unit must match its `doseUnit`.** A value
  reported per `mg/kg` alongside `{ doseValue: 10, doseUnit: 'mg' }` is contradictory: the
  entry would pass through unchanged while producing an absolute-mass `DoseStratum`, giving
  a headline that is both mislabelled and keyed into the wrong family. Validated whenever
  dose context is present; for the `'unstated'` shape the family derives solely from the
  normalized unit, since there is nothing to disagree with.
- interval is meaningful only for `multiple` / `steady_state` / possibly `unknown`, not a known single dose
- infusion duration is meaningful only for routes where a duration exists
- `doseNumber >= 1` and `regimenDurationHours >= 0` when present, and both are meaningful
  only for `multiple` (a `single` entry is dose 1 by definition; `steady_state` needs
  neither)
- `administeredDrugId` is required for dose-context parameters (partial CHECK), null for
  every other parameter, and references an existing drug with `ON DELETE RESTRICT`
- `priorDosingRegular` is meaningful only for `multiple` / `steady_state`
- structured dose fields are forbidden on parameters whose registry says `doseContext: 'forbidden'`

### Required to store is not required to normalize

Several earlier revisions said a context field was "required for Cmax" *and* that a source
which does not state it yields an `'unknown'` value with a named ineligibility. Both cannot
hold: a storage requirement makes the ineligibility unreachable and rejects evidence this
design promises to keep. The `'unknown'` members exist precisely so a paper's silence is
recordable.

The rule, applied uniformly:

**A field is required to store only when its absence makes the row ambiguous or meaningless.
Context the source did not state is stored as `'unknown'` (or null) and refused at
normalization.**

**Three gates, not two.** Storing, normalizing and pooling are separate questions, and the
`NormalizationOutcome` union has three variants precisely because a field can fail one
without failing the next. A single "normalization" column conflated the last two and would
have had an implementer suppress the normalized value of every bounds-only, censored and
unspecified-salt entry — evidence this design exists to keep visible.

The line between the last two columns: **normalization is blocked only when the normalized
number would be uncomputable or uninterpretable** — no dose, no dose basis, no route, no
matrix conversion, no molecular weight, or an unresolved context dimension the headline's
own label claims (formulation, prandial state, population, coadministration, regimen,
interval). **Pooling is blocked when the number is interpretable on its own but not
comparable with its neighbours** — no central value to weigh, a censored threshold rather
than an observation, or a salt whose mass basis is unstated. Salt form sits on the pooling
side because it qualifies the dose *denominator* rather than the context profile: an
unspecified salt still yields a defensible per-milligram number, it is simply not
comparable across salts.

| field | storage | normalization | pooling |
| --- | --- | --- | --- |
| `valueBasis` | **required** — without it the number's meaning is undefined | — | — |
| dose shape invariants | **required** — an ill-formed row is not evidence | — | — |
| `n` | optional, but **must be absent or 1 when `centralStatistic` is `'single_subject'`** — a row whose statistic and cohort size contradict each other is not evidence | — | — |
| `centralValue` | optional — a report giving only a range is real evidence — **except** when `intervalKind` is `'sd'` or `'sem'`, where it is **required at write** | not required; the bounds still normalize and are displayed | **required and finite**, else `missing_central_value`; bound-checked like every other value (below) |
| `qualifier` | optional — a censored report is real evidence. When present, the threshold goes in `centralValue`, `centralStatistic` and `intervalKind` must both be **absent**, and the `median` shorthand may not be used | not required to be absent; the threshold normalizes and is displayed **with its operator** | **must be absent**, else `censored_value` |
| `doseSaltForm` | optional | not required; an unspecified salt still normalizes | required for `'salt'`, else `unspecified_salt_form` |
| `centralStatistic` | optional; `'unknown'` is legal; **rejected when `qualifier` is set** | required **when a central value exists and is not a censored threshold**, else `unlabelled_statistic`; absent is correct when there is nothing to label | — (carried by the `centralValue` row) |
| `intervalKind` | optional; `'unknown'` is legal; **must be absent when both bounds are absent**, and requires its bounds when present | required when bounds exist, else `unlabelled_statistic` | — |
| `doseBasis` | optional | required with dose context, else `unknown_dose_basis` | — |
| `releaseProfile`, `physicalForm` | optional | required, else `unknown_formulation` | — |
| `prandialState` | optional | required on `oral` **only**, else `unknown_prandial_state`; vacuous on the other six resolved routes | — |
| `pkPopulation` | optional | `'healthy_adult'` only, else `altered_population_not_pooled` / `unknown_population` | — |
| `coadministrationState` | optional | `'monotherapy'` only, else `interaction_arm_not_pooled` / `unknown_coadministration_state` | — |
| `ivInputMode` | optional | resolved mode required on `iv` **only**, else `unknown_iv_input_mode`; vacuous on the other six resolved routes | — |
| `doseRegimen` | optional; null and `'unknown'` are both legal | resolved regimen required, else `unknown_dose_regimen` | — |
| `doseIntervalHours` | optional | positive value required for `multiple`/`steady_state`, else `missing_dosing_interval` | — |
| `route` | optional (`routeOptional`) | resolved route required, else `missing_route` / `unresolved_route` | — |

A row failing the **normalization** column yields `{ kind: 'ineligible', reason }`; a row
failing only the **pooling** column yields `{ kind: 'normalized_not_poolable', entry,
reason }`. Both reasons come from the same `IneligibilityReason` vocabulary, which is why
the outcome variant — not the reason — is what says whether a normalized value exists.

`valueBasis` is the one context field that must be supplied: it says whether the stored
number is a concentration or a ratio, and a row that does not say is not interpretable at
all rather than merely unpoolable. Everything else a paper can simply fail to mention, and
this design's entire posture is to keep that evidence visible and out of the headline.

For the reported statistic:

- `centralValue` and `median` must not both be set with disagreeing values; authoring
  `median` is shorthand for `centralStatistic: 'median'`
- **the median shorthand may not contradict an explicit statistic label.** A payload such as
  `{ median: 5, centralStatistic: 'arithmetic_mean' }` says two different things about one
  number, and canonicalizing it would overwrite the label the author explicitly supplied —
  silently converting a reported mean into a reported median, which is precisely the
  relabelling section 1a exists to prevent. When `median` is used, `centralStatistic` must be
  absent or `'median'`; anything else is rejected. The value check alone was not enough,
  because the fields disagree in *kind* rather than in magnitude
- **`centralValue` is subject to every check the existing value fields get.** It is a new
  value-carrying field, so it must join `EntryValueFields` and the loop in
  `validateEntryForParameter` that converts each of `low`/`high`/`median` to the canonical
  unit and rejects anything outside the registry bounds; it must likewise join the qualifier
  agreement check and the containment check in `validateEntryValueInvariants`. Without that,
  `{ centralValue: -1 }` is a physically impossible Cmax that passes every gate and pools —
  the registry bound exists precisely to stop that, and a field added outside the loop is a
  field the bound does not cover. This is part of the field parsing and validation that
  ships in **release B**, not with the writers: a release-B instance approving a release-C
  proposal must reject an out-of-bounds central value rather than store it.

  The general rule this is an instance of: **a new value-carrying column must be added to
  every place that enumerates the value-carrying columns**, exactly as a new context column
  must be added to every duplicate-identity predicate (section 41). Enumerations are where
  this design keeps leaking.
- **for `'sd'` and `'sem'`, the registry bounds apply to `centralValue` only.** `low` and
  `high` are `centre ∓ dispersion` — arithmetic summaries, not observed concentrations — and
  a perfectly ordinary report of `1 ± 2 ng/mL` encodes `low: -1`. Bound-checking that against
  the Cmax minimum of 0 would reject a real, correctly-recorded cohort as though the paper
  had claimed a negative concentration, which is the opposite of this document's posture
  everywhere else: it discards evidence rather than declining to derive from it.

  What is checked instead, for these two kinds: `centralValue` against the registry bounds
  as usual, plus `high ≥ centralValue` so the dispersion is non-negative, plus the symmetry
  rule above. Together those pin the interval exactly, and neither endpoint needs an
  independent bound.

  **`'ci95'` is exempt for the same reason**, and grouping it with the observed kinds was
  wrong. A normal-theory confidence limit is *calculated* uncertainty, not a measurement, so
  a perfectly ordinary `1 ng/mL (95% CI −1–3)` has a negative lower limit exactly as
  `1 ± 2` does. The line is not "is it an interval" but **"is this endpoint something a
  subject exhibited, or something arithmetic produced"**:

  - **arithmetic endpoints** — `'sd'`, `'sem'`, `'ci95'` — bound-check `centralValue` only.
  - **observed endpoints** — `'range'`, `'iqr'`, `'unknown'` — keep the registry bound on
    `low` and `high`, because a minimum, a maximum and a quartile are values subjects
    actually had. A negative `low` on a `'range'` is still a rejected payload.

  `'ci95'` keeps the containment check but **not** the symmetry rule: a CI on a log-scale or
  geometric-mean estimate is legitimately asymmetric, unlike an SD interval. Unlike `'sd'`
  and `'sem'` it also does **not** require a `centralValue` — a confidence interval is an
  interval estimate that stands without its point estimate. When the centre is absent there
  is simply nothing to bound-check, and the entry is bounds-only: displayed, and
  `normalized_not_poolable` with `missing_central_value`, so an unbounded pair of arithmetic
  limits never reaches the headline.
- **`centralStatistic: 'single_subject'` requires `n` to be absent or 1**, and any other
  value is rejected at write. The statistic says the number came from one participant; `n`
  is what `entryWeight` multiplies by, so `{ centralStatistic: 'single_subject', n: 400 }`
  is a payload that contradicts itself and would hand one subject the weight of a
  400-subject cohort — enough, on its own, to decide the weighted median for that stratum.

  Rejecting is right rather than silently overriding the weight to 1. The two fields make
  incompatible claims about the same observation and there is no basis for deciding which
  the author meant, which is the same reasoning the `median` / `centralStatistic` conflict
  gets above. A case report is real evidence and stays fully storable — it simply may not
  also claim to be a cohort.
- **`intervalKind` and the bounds imply each other.** The rule was one-directional — an
  interval kind was required *when bounds exist* — so
  `{ centralValue: 5, centralStatistic: 'arithmetic_mean', intervalKind: 'sd' }` was accepted
  with no dispersion at all, and vacuously satisfied the centre and symmetry checks added in
  the two rounds before this one. The normalized row would then claim and display an SD
  interval for a dispersion nobody reported. `intervalKind` must be **absent when both bounds
  are absent**, and present with its bounds otherwise; either half alone is rejected at write.
- **`intervalKind: 'sd'` or `'sem'` requires a `centralValue`, and the payload is rejected
  without one.** These two are dispersion *around a central estimate*; the bounds are
  `centre ± SD`, so without the centre they are not an interval at all — they are two
  numbers whose meaning was thrown away. A `'range'` or `'iqr'` stands on its own (a minimum
  and a maximum, or two quartiles, are observations in their own right), and a `'ci95'` is
  interpretable as an interval estimate; `'sd'` and `'sem'` are not.

  Without this invariant `{ low, high, intervalKind: 'sd' }` was admissible, went down the
  bounds-only path as `missing_central_value`, and the UI would render an SD interval whose
  centre is unknown — a statistically meaningless display. The document already asserted
  elsewhere that for these two the central value "must therefore already be present"; that
  was an assumption stated as a fact, with nothing enforcing it. It is a write-time
  rejection rather than a normalization reason, because the shape is not evidence: an SD
  without its mean cannot be repaired by later curation of *other* fields.
- `centralValue`, when bounds are present, must lie within `low..high`. For `'sem'` and
  `'sd'` the bounds are a dispersion interval around it rather than a range, but the
  containment check is the same.
- **for `'sd'` and `'sem'`, the two distances from the centre must also be equal**, within
  the stored precision (`numeric(14, 6)`, so `|(high − centre) − (centre − low)| ≤ 1e-6`).
  Containment alone accepts `{ centralValue: 5, low: 4, high: 9, intervalKind: 'sd' }`, which
  no single SD can produce — and the source row and a one-cohort headline would then label
  an impossible interval `centre ± SD`. Symmetry is what makes the label true, and it is a
  write-time rejection like the requirement for the centre itself.

  I kept `low`/`high` and added the invariant rather than storing the dispersion magnitude in
  its own column, which was the other option. A magnitude column would be a second
  representation of the same interval, needing its own parsing, serialization, merge, dedupe
  and CHECK across the four releases, and leaving `low`/`high` free to disagree with it —
  trading an invariant that is one comparison for a synchronization problem that is not.

Normalization eligibility is validated separately from storage: an entry may be perfectly
valid and still be ineligible for the normalized summary. Storage validation never rejects a
paper for being incomplete; it rejects an entry for claiming more than the paper said.

The database should mirror the most important shape invariants with CHECK constraints, as existing route/categorical entry work does. API Zod validation remains the richer error surface.

## Derived normalization

Do not persist a normalized Cmax.

At read time:

1. convert the reported Cmax to the requested/canonical concentration unit
2. normalize the biological matrix — see the hard requirement below
3. canonicalize dose within its family
4. divide concentration by exact dose
5. attach enough context to prevent incompatible pooling

Step 2 must **not** reuse the existing aggregation fallback. `bloodRatioScalar` returns `1`
when the blood:plasma ratio is absent, zero or otherwise invalid, after which
`aggregateEntries` labels plasma and serum values as whole-blood-normalized and pools them.
That fallback is defensible for the existing ranges it was written for; carried into a
published Cmax headline it would fabricate a normalized value out of a missing conversion
factor, which is exactly what the "exclude entries lacking a valid conversion" promise below
forbids — and it would present an unverified number as established fact.

The Cmax normalizer therefore uses its own strict conversion:

- **the canonical target matrix for Cmax normalization is `plasma`**, fixed once here. The
  document previously said "the target matrix" without naming one, while describing results
  as whole-blood-normalized in one place and a plasma headline in another — so two consumers
  could normalize to different matrices, produce numerically different concentrations, and
  share a `normalizedUnit` and a stratum. Plasma is the matrix the PK literature reports
  Cmax in, so it minimises conversions and the evidence loss each one costs.

  This deliberately differs from `aggregateEntries`, which normalizes to whole blood. Cmax
  has its own normalizer (it must, per the strict-conversion rule below), and this is a
  chosen divergence rather than an oversight — recorded here so nobody later "fixes" the
  inconsistency by silently switching target.

  `DoseNormalizedEntry` carries `normalizedMatrix`, and it joins the pooling key, so that a
  future change of target cannot mislabel existing rows or pool across targets.
- **identity is allowed exactly when source and target are on the same side**, which is
  the same-side rule spelled out two bullets below — not exact matrix equality. This bullet
  previously said "only when the entry's matrix already equals the target matrix", which
  contradicted that rule while sitting immediately above it: an implementer reading top to
  bottom would send every serum entry down the cross-matrix branch. Exact equality appears
  nowhere in this document's conversion rules; same-side identity is the only form.
- **the source matrix must be one the concentration axis can represent**, which
  `src/lib/matrixDisplay.ts` already decides: `isConvertibleMatrix` is blood-like or
  plasma-like, and everything else — urine, vitreous, hair, `other` — is off-axis. Such a
  concentration is not a blood-compartment concentration scaled by some factor; it is a
  different quantity, and no ratio converts it. Making ratio validity the only gate would let
  a literal implementation relabel a hair concentration as plasma-normalized and pool it: a
  fabricated value of the worst kind, dimensionally plausible and clinically nonsense. Such
  an entry yields `{ kind: 'ineligible', reason: 'unsupported_matrix_conversion' }`.

  Reuse those predicates rather than enumerating matrices here. `BLOOD_LIKE_MATRICES` is
  wider than `REFERENCE_MATRICES` — it includes femoral, cardiac and postmortem blood — and
  a hand-rolled list in this document would silently diverge from the repository's contract
  the first time either changed.
- **serum and plasma are the same frame, so serum → plasma is identity.**
  `PLASMA_LIKE_MATRICES` is `{ serum, plasma }` and `matrixDisplay` returns a plasma-side
  value unchanged for a plasma-side source; the blood:plasma ratio is used only when crossing
  between whole blood and that frame. An identity rule keyed on *exact* matrix equality would
  send every serum Cmax through the cross-matrix branch, where it would either be excluded
  for want of a ratio or rescaled by a factor that does not apply to it. Identity therefore
  holds whenever source and target are on the same side; the ratio is consulted only for a
  genuine blood ↔ plasma crossing
- for a supported pair, any cross-matrix conversion requires a finite, positive
  blood:plasma ratio for that drug
- **the conversion divides.** `r = [blood] / [plasma]`, so `plasma = blood / r` — and since
  the canonical target is plasma, a whole-blood Cmax of 10 with `r = 0.5` normalizes to
  **20**, not 5. This document required a ratio and never said what to do with it, while the
  nearest worked example in the codebase, `aggregateEntries`, normalizes in the *opposite*
  direction (to whole blood, `blood = r · plasma`, multiplying). An implementer copying the
  neighbouring code would have been off by a factor of `r²` — a quarter of the true value in
  that example — with every rule in this document satisfied.

  **Use `convertToDisplayMatrix` from `src/lib/matrixDisplay.ts` rather than reimplementing
  the arithmetic.** It already encodes both directions and the same-side identity, and
  restating a repository contract in this document has been the most repeated source of
  defects in this review. The required test asserts the **number**, not merely that a
  conversion happened: a direction error is invisible to any test that only checks
  eligibility.
- **the ratio must be source-backed, not merely numeric.** A `mean` or `median` proves the
  *shape* of the value, not its provenance. `bloodPlasmaRatio` is `summarizable: true`, so
  it is an entry-backed parameter with a citation-bearing `parameter_entries` row available
  — but the catalog also carries hand-authored scalars that are explicitly estimates:
  flunitrazepam holds `{ median: 0.6, note: 'estimated from protein binding ~78%' }` and LSD
  `{ median: 1, note: 'estimated; moderate protein binding' }`. Both pass a scalar-shape
  test, and using either would publish a plasma-normalized Cmax headline built on a number
  nobody measured — the exact substitution this document refuses everywhere else, arriving
  through the conversion factor instead of through the value.

  So the ratio is usable only when it resolves from **source-backed `bloodPlasmaRatio`
  entries** — and the normalizer must read **those entries**, not the drug-level scalar
  cached from them. `derivedFromEntries` proves the cache came from entries; it does **not**
  prove the cached `median` was ever reported. `summaryToNumericRange` stores
  `median: summary.representative`, and `representative` is a weighted median of
  `entryRepresentative` values, which midpoints a two-sided interval when an entry has no
  reported central value of its own. A drug whose only sourced B/P evidence is `{ low, high }`
  therefore produces a cache carrying an **invented** `median` with `derivedFromEntries:
  true` — the exact midpoint this document forbids two bullets below, re-entering through
  the provenance check meant to exclude it.

  The rule is therefore: resolve the ratio from `bloodPlasmaRatio` **entries**. An entry is
  an eligible ratio source when all four hold:

  1. its own central value is **reported** (`median` / `centralValue` present on the entry,
     never a synthesized midpoint);
  2. that central value is **finite and positive**. The registry bounds for
     `bloodPlasmaRatio` are `{ min: 0, max: 100 }`, so a zero is legal at write and will
     occur. A non-positive candidate is **excluded from the candidate set** before the
     estimator runs, never carried into it: left in, a sufficiently weighted zero drags the
     weighted median to zero, which the invalid-ratio rule above then reads as no ratio at
     all — one bad row discarding a perfectly good sourced 0.8 and refusing the conversion
     outright;
  3. it carries **no `qualifier`**. A ratio entry may be censored just as a Cmax entry may:
     `{ median: 0.8, qualifier: '<' }` is a threshold, not an observed conversion factor, and
     the shape is legal throughout the repository. Its central value passes the "reported"
     test above and would rescale every whole-blood Cmax for that drug by a number no source
     states — the censored-value failure of round 26, one level down, in the conversion
     factor instead of the value. Such an entry yields `censored_matrix_ratio`;
  4. it is source-backed, as above.

  **Where several entries qualify, the ratio is the `entryWeight`-weighted median of their
  reported central values** — the same estimator, named in the same place, as the headline
  itself. `parameter_entries` permits many rows per drug and parameter, so reported ratios of
  0.6 and 0.9 can both be eligible; without a stated estimator the normalizer would return
  whichever query order surfaced first and publish a different Cmax for the same drug from
  the same evidence. That is the round-23 defect recurring in the conversion factor, and it
  gets the round-23 answer rather than a second estimator invented for this one case.

  Excluding rather than invalidating is deliberate: an unusable row is not evidence against
  the usable ones. No eligible entry but bounds-only ones exist → `bounds_only_matrix_ratio`.
  No eligible entry but only censored ones → `censored_matrix_ratio`. No eligible entry
  because every candidate was non-positive → `missing_matrix_conversion`. No sourced entries
  at all → `unsourced_matrix_ratio`. The cached drug-level scalar is never the input, whatever marker
  it carries.

  All three failures leave the entry visible in its own matrix, eligible the moment the ratio
  is sourced with a reported, uncensored central value. Parsing the `note` prose
  for the word "estimated" is explicitly **not** the test — prose is not a contract, and a
  ratio with no note at all is no better evidenced than one that admits its derivation.
- a missing, zero, negative or non-finite ratio yields
  `{ kind: 'ineligible', reason: 'missing_matrix_conversion' }` — never a scalar of `1`
- **the ratio must be a reported scalar, not a bare interval.** `bloodPlasmaRatio` is a
  `NumericRange`, whose `min`/`max`/`mean`/`median` are all optional, and catalog entries
  exist with bounds and no central estimate at all. `bloodRatioScalar` resolves that shape by
  taking `(min + max) / 2` — the midpoint invention this document forbids for dose ranges,
  applied to the conversion factor instead. Using it here would publish a point Cmax
  conversion no source reported, and would be inconsistent with section 3 besides.

  So: a ratio with a `median` or `mean` is a reported central estimate and is used. A
  bounds-only ratio yields `{ kind: 'ineligible', reason: 'bounds_only_matrix_ratio' }`.

  This costs real coverage — a drug whose catalog B/P is bounds-only cannot cross-matrix
  normalize at all, and some are — and that is the same trade this document makes
  everywhere else: refuse rather than invent, keep the entry visible as raw evidence in its
  own matrix, and let a curator add a sourced central estimate to unlock it. Propagating the
  interval through the conversion into a normalized *range* is the better long-term answer
  and is out of scope here: every consumer of the normalized value, including the pooling
  key and the headline, currently assumes a point estimate, and widening that is its own
  design.

An off-axis matrix remains fully visible as raw evidence in its own matrix, which is the
right home for it: a urine Cmax is a real observation and a real research interest, just not
a member of a plasma headline.

For a **supported blood-compartment pair** missing its ratio, the entry stays visible as raw
evidence in its own matrix and enters the normalized summary once the drug has a real B/P
ratio. That sentence applies to `missing_matrix_conversion` only: an
`unsupported_matrix_conversion` entry is never waiting for a ratio, because no ratio can
convert it, and no later data makes it eligible.

Conceptual result:

```ts
interface DoseNormalizedEntry {
  entryId: number;
  normalizedLow?: number;
  normalizedHigh?: number;
  /**
   * The normalized central estimate. Its meaning is supplied by `centralStatistic`
   * below — this is deliberately NOT called `normalizedMedian`, because a normalized
   * arithmetic or geometric mean is not a median and naming it one would reintroduce
   * exactly the relabelling section 1a exists to prevent.
   */
  normalizedCentralValue?: number;
  normalizedUnit: string; // e.g. µmol/L/mg
  normalizedMatrix: ReferenceMatrix;    // canonically 'plasma'; in the pooling key
  doseStratum: DoseStratum;
  doseBasis: DoseBasis;                 // never inferred; absent means ineligible
  doseSaltForm: string | null;          // required for poolability when basis is 'salt'
  /**
   * Null in exactly two cases, and no others: there is no central value to label
   * (a bounds-only entry), or the central value is a **censored threshold**, which is
   * not a central estimate of any kind. A normalized `< 5` therefore carries
   * `normalizedCentralValue: 5`, its `qualifier`, and a null statistic — the comment
   * that said "null only when there is no central value" was false the moment the
   * censored rule landed, and would have pushed an implementer to invent a statistic
   * for the threshold to satisfy the type.
   */
  centralStatistic: CentralStatistic | null;
  intervalKind: IntervalKind | null;
  /**
   * The weighting inputs, carried through unchanged from the source entry so
   * `entryWeight` can be applied to the normalized entry directly. Without these
   * the estimator cannot weigh anything: `entryWeight` reads exactly these two
   * fields, and a normalized shape that omits them yields n = 1 and score 0 for
   * every cohort — an unweighted median wearing a weighted median's label.
   */
  n: number | null;
  reviewScore: number | null;
  qualifier: QualifierOperator | null;  // carried through; never null-ed on normalization
  route: RouteId;                       // never null for an eligible entry
  releaseProfile: ReleaseProfile;       // never 'unknown' for an eligible entry
  physicalForm: PhysicalForm;           // never 'unknown'/'other' for an eligible entry
  /**
   * `'fasted'` or `'fed'` on an eligible `oral` entry; **null** on the six routes where
   * the requirement is vacuous. Nullable rather than `'unspecified'`: that member is what
   * makes an `oral` entry `unknown_prandial_state`, so reusing it for an IV row would state
   * "the paper did not say" about a question the route never asks. `'unspecified'` therefore
   * never appears on an eligible entry at all.
   */
  prandialState: PrandialState | null;
  coadministrationState: CoadministrationState;  // always 'monotherapy' when eligible
  interactingDrugId: number | null;
  pkPopulation: PkPopulation;           // always 'healthy_adult' when eligible
  populationQualifier: string | null;   // display only, never a key
  valueBasis: ValueBasis;               // derived and source-reported ratios never pool
  regimen: DoseRegimen | null;
  doseIntervalHours: number | null;
  doseNumber: number | null;
  regimenDurationHours: number | null;
  priorDosingRegular: boolean | null;
  ivInputMode: IvInputMode | null;
  administrationDurationMin: number | null;
  administeredDrugId: number;           // explicit, self-referencing when analyte == administered
}
```

The dose dimension is a **stratum descriptor**, not a scalar. A declared ratio from a
variable-dose cohort has no single canonical dose, and manufacturing one would be the
midpoint invention this RFC forbids — so the type admits the shapes that actually occur:

```ts
type DoseStratum =
  | { kind: 'exact'; value: number; unit: 'mg' | 'mg/kg' }
  | { kind: 'range'; low: number; high: number; unit: 'mg' | 'mg/kg' }
  | { kind: 'unstated'; unit: 'mg' | 'mg/kg' };
```

Strata match only on identical descriptors: an exact dose pools with the same exact dose and
a range with the identical range. A range never pools with an exact dose that falls inside
it, and no comparison ever collapses a range to a point.

**`'unstated'` matches nothing, including another `'unstated'`.** Two ratios that both omit
the dose are not known to be comparable — one cohort may have had 1 mg and the other
100 mg — so a descriptor that records the *absence* of a dose level cannot be a stratum key.
It is not "equal because both are unknown"; it is unknown, and unknown never joins.

For a `'concentration'` entry the descriptor is always `'exact'`, since nothing else is
normalizable. `'range'` and `'unstated'` arise only for a declared ratio.

Normalization and poolability are reported separately, so an aggregator cannot read a
successful normalization as permission to pool:

```ts
type NormalizationOutcome =
  /** No normalized value exists. The raw entry is shown with this reason. */
  | { kind: 'ineligible'; reason: IneligibilityReason }
  /** A normalized value exists and is shown, but must not join a stratum. */
  | { kind: 'normalized_not_poolable'; entry: DoseNormalizedEntry; reason: IneligibilityReason }
  /** A normalized value that may enter the headline summary. */
  | { kind: 'poolable'; entry: PoolableEntry };

/**
 * The only shape the headline estimator ever sees. `normalizedCentralValue` is
 * REQUIRED and finite here, because the weighted median is computed over central
 * values and has nothing to weigh without one — and `centralStatistic` is required
 * with it, because `centralStatistic` is a pooling-key dimension and a stratum is
 * only well-posed when every member reports the same kind of central value. The two
 * are required together: a central value without its label is `unlabelled_statistic`,
 * and a label without a value cannot occur.
 */
type PoolableEntry = DoseNormalizedEntry & {
  normalizedCentralValue: number;
  centralStatistic: CentralStatistic;
};
```

**A censored Cmax is normalized and displayed, but never pooled.** A source reporting
`< 5 ng/mL` stores a `qualifier` on the inherited entry shape — `parameterEntries.ts` admits
one, and requires every provided bound to agree because it marks a single threshold rather
than an interval. `parameterEntryAggregation` already excludes such rows from its pool
(`if (e.qualifier) continue;`), and the Cmax headline must do the same: the threshold is a
bound on an unobserved value, not an observation, and a weighted median that swallows it
treats "below 5" as "5".

This document did not mention `qualifier` at all, which failed twice over. The threshold
would have normalized as an ordinary finite central value and entered the headline, **and**
`DoseNormalizedEntry` carried no field to hold the operator, so the normalized display would
have rendered a bare number — turning a censored report into an exact one on screen. The
type now carries `qualifier` through normalization, and a qualified entry is
`{ kind: 'normalized_not_poolable', reason: 'censored_value' }`, shown with its operator.

`normalizedCentralValue` stays optional on `DoseNormalizedEntry` itself, because a paper
reporting only `{ low, high, intervalKind: 'range' }` has produced real evidence that should
normalize and be displayed. Such an entry is
`{ kind: 'normalized_not_poolable', reason: 'missing_central_value' }`: shown with its
interval, kept out of the headline.

**The midpoint of `low..high` is never substituted for the missing central value.** That is
the same refusal the dose range gets in section 3 and the bounds-only B/P ratio gets above,
for the same reason — the midpoint of a subject range is not the cohort's median, and
pooling it would enter an observation nobody made. This is deliberately stricter than
`entryRepresentative` in `parameterEntryAggregation`, which does midpoint a two-sided
interval; that function serves the general parameter display, and the divergence is recorded
here so nobody later "fixes" the inconsistency by teaching the Cmax headline to invent a
central value. Where `intervalKind` is `'sd'` or `'sem'` the bounds are a dispersion interval
around a central value that must therefore already be present, so this case does not arise
for them.

A union rather than a record with optional fields, because the record admitted
`{ normalized: null, poolable: true }` — an aggregator reading `poolable` would have taken a
value that does not exist — and carried no reason for a normalization that failed outright,
so `missing_route` and `missing_matrix_conversion` had nowhere to live even though the UI is
required to explain every excluded row. Each variant now carries exactly the fields its case
has, and every non-poolable case carries a reason.

The three cases in words: `'ineligible'` is an entry with no normalized value at all;
`'normalized_not_poolable'` is an entry with a real normalized value, shown in normalized
mode but never aggregated; `'poolable'` is the only input the headline summary accepts.

The `normalized_not_poolable` set is **exactly four** reasons, and naming them here matters
because a summary that lists two of them reads as exhaustive and sends the other two down
the ineligible path, suppressing evidence this design exists to show:

- `unstated_dose_level` — a declared ratio with no stated dose;
- `unspecified_salt_form` — `doseBasis: 'salt'` without the salt named;
- `censored_value` — a threshold such as `< 5`, displayed with its operator;
- `missing_central_value` — a bounds-only entry, displayed with its interval.

Any later addition to this variant belongs in this list too.

Normalization eligibility should be explicit rather than returning a misleading number:

```ts
{
  eligible: false,
  reason: 'dose_range_without_exact_dose'
}
```

The full initial reason vocabulary:

```ts
type IneligibilityReason =
  | 'dose_range_without_exact_dose'
  | 'missing_dose'
  | 'missing_route'
  | 'unresolved_route'
  | 'missing_matrix_conversion'
  | 'unsupported_matrix_conversion'
  | 'bounds_only_matrix_ratio'
  | 'unsourced_matrix_ratio'
  | 'censored_matrix_ratio'
  | 'missing_molecular_weight'
  | 'incompatible_dose_family'
  | 'unknown_dose_regimen'
  | 'unresolved_exposure_state'
  | 'unsupported_regimen_context'
  | 'unknown_iv_input_mode'
  | 'unknown_formulation'
  | 'unknown_prandial_state'
  | 'missing_dosing_interval'
  | 'interaction_arm_not_pooled'
  | 'unknown_coadministration_state'
  | 'altered_population_not_pooled'
  | 'unknown_population'
  | 'unknown_dose_basis'
  | 'unspecified_salt_form'
  | 'unstated_dose_level'
  | 'missing_central_value'
  | 'censored_value'
  | 'unlabelled_statistic';
```

Every one of these keeps the entry visible as raw evidence and keeps it out of the
normalized summary. None of them is ever resolved by substituting a default.

## Aggregation and the parameter box

Do not put normalized Cmax into the ordinary `drug_parameters` concentration cache.

Instead, compute a Cmax dose-normalized summary at read time from eligible source entries. This can start as a Cmax-specific summary payload, but the implementation should be shaped so AUC can reuse it later.

### How the cohorts in a stratum combine

The pooling key says which cohorts *may* be combined; it does not say how, and every earlier
revision of this document stopped there. That is not a detail left to the implementer: a
sample-size-weighted median of representatives, an unweighted mean of central values, and an
inverse-variance pooled estimate give materially different headlines from identical inputs,
all of them satisfying every rule above.

Because `centralStatistic` is a pooling-key dimension, every entry in a stratum reports the
same kind of central value, so combining them is at least well-posed. The first
implementation:

- **Point estimate: the weighted median of the per-entry normalized central values,
  weighted by `entryWeight` itself.** Cmax calls that exported function rather than
  restating a formula, so "behaves like its neighbours" holds by construction. The weight is
  `n × (REVIEW_SCORE_WEIGHT_FLOOR + reviewScore / 200)` — sample size **scaled by curation
  quality**, not sample size alone — and an entry with no reported `n` is weighted as
  `n = 1`, which is not the same as weight 1, since the score factor still applies. An
  earlier revision of this bullet said "sample-size-weighted" and said entries without `n`
  carry weight 1; both would have produced a different headline from identical inputs the
  moment two entries in a stratum had different review scores.

  Weighted **median** rather than weighted mean, for one reason only: the headline is then
  always a value some cohort actually reported, so an aberrant cohort cannot pull it to a
  number no study observed. It does **not** bound a large cohort's influence. A weighted
  median returns the value at the 50% cumulative-weight crossing, so a cohort holding more
  than half a stratum's weight determines the point estimate outright — intended, and stated
  here rather than denied, because a 400-subject study should outweigh four 10-subject ones.
  Any rule capping or trimming a single cohort's weight is a separate design decision and is
  **not** part of this first implementation.
- **Interval: the observed minimum and maximum of those same per-entry central values**,
  labelled as *between-cohort spread* wherever it is displayed.
- **Reported per-entry intervals are never combined.** An SD, a 95% CI and a subject range
  are different quantities, and pooling them into one interval needs distributional and
  equal-variance assumptions this evidence base does not supply. They remain visible on each
  source row, which is where a reader can interpret them.
- A stratum of **one** cohort shows that cohort's own normalized value and its own reported
  interval, labelled with its `intervalKind` — there is no spread to report, and inventing
  one would be worse than showing the single study plainly.

The headline therefore answers "what do the comparable studies centre on, and how far apart
are they" and does not pretend to be a meta-analytic estimate. Proper inverse-variance
pooling is the better answer and is out of scope: it needs a per-entry variance, which a
large share of published Cmax reports simply do not give, and a rule for what to do when
some entries have one and some do not — its own design, with its own review.

**The tie is broken downward, by reusing `weightedPercentile(points, 0.5)`.** "Weighted
median" is not a unique value when cumulative weight lands exactly on 50% — two equally
weighted cohorts at 0.6 and 0.9 admit 0.6, 0.9 or 0.75, and every one of them is a defensible
reading of the phrase. `weightedPercentile` in `parameterEntryAggregation` already settles it
by stopping at the first point where `cum >= target`, which returns the **lower** candidate;
Cmax uses that function rather than restating the semantics, so the answer is 0.6 and it is
0.6 everywhere in the platform.

Two consequences worth stating, because both were implicit and neither is obvious:

- the midpoint 0.75 is **excluded by the same rule** that forbids midpointing a dose range or
  a bounds-only ratio. Interpolating between two cohorts invents a value neither reported,
  and the estimator's one guarantee — the headline is always a number some cohort observed —
  would not survive it.
- `weightedPercentile` is currently **private**. It must be exported alongside `entryWeight`
  as part of the read-side work in release B, for the same reason `entryWeight` is called
  rather than restated: a second implementation of the percentile is a second set of tie
  semantics, and this document has already been caught restating repository contracts
  incorrectly more than once.

The weighting inputs travel with the entry rather than a precomputed weight. `entryWeight`
stays the single definition of the formula — the rule this document arrived at in round 24
after restating it wrongly — and a stored scalar would be a second copy that silently goes
stale the moment an entry is re-reviewed.

**The displayed label must name the estimator**, not only the stratum: "weighted median of
8 cohorts, spread 0.038–0.051" rather than a bare range. A number whose construction is not
stated is one a reader cannot check.

The headline summary must only pool a coherent stratum. At minimum the pooling key should
include:

```text
dose family (mg vs mg/kg)
dose stratum descriptor                 (exact / range; unstated never pools at all)
normalized matrix                       (canonically plasma; never pooled across targets)
dose basis                              (salt / free-base / parent / active-moiety)
salt form                               (when basis is salt; unspecified never pools)
route                                   (resolved; no null-route and no 'other' stratum)
release profile                         (immediate and modified never pool)
physical form                           (independent of release profile)
prandial state                          (`oral` only; fed and fasted never pool)
coadministration state                  (only monotherapy enters the first headline)
pk population                           (only healthy adults enter the first headline)
value basis                             (derived and source-reported ratios stay distinct)
regimen
and, for repeated dosing, dosing interval
and, for non-steady repeated dosing, exposure position (dose number / regimen duration)
and, for IV input, input mode and exact canonical infusion duration when material
administered drug                       (explicit FK, after merge repointing)
central statistic                       (geometric means are not pooled with arithmetic means)
```

**Dose magnitude is part of the key, not just dose family.** Dividing by dose does not make
observations at different dose levels comparable — it assumes dose proportionality, which
this RFC's own non-goals refuse to claim. Where absorption, metabolism or elimination
saturates, a 1 mg and a 100 mg observation have genuinely different Cmax/dose behaviour, and
pooling them on the shared `mg` family alone would publish a single ratio that misrepresents
both and hides the nonlinearity that is often the clinically interesting part.

For the first implementation, the canonical dose value itself is a stratum dimension: only
observations at the same dose level pool. That is deliberately strict — it yields more
strata and fewer single-number headlines — but it is the only rule that does not smuggle in
an unverified proportionality assumption.

Widening a stratum across dose levels is a later, evidence-bearing feature, not a default:
it requires a validated proportionality range for that drug, established from the data and
recorded as such, and until one exists there is nothing to widen on. The dose-vs-Cmax view
below is where that evidence would come from, which is the right ordering — observe
proportionality first, then rely on it.

Matrix is normalized before pooling only when a real conversion exists — a valid positive
blood:plasma ratio, or an identity conversion because source and target are on the **same
side**, in the sense the conversion rules define (serum and plasma are one frame, so
serum → plasma is identity; "the matrices already match" is not the test). Entries
that cannot be normalized remain visible as raw evidence with their reason, and do not
silently enter the normalized summary.

**Selecting among strata is deterministic, and the first implementation does not select.**
Exactly one eligible stratum → the parameter box shows that stratum's headline with its full
context label. More than one → it shows **"multiple administration contexts"**, the stratum
count, and requires opening the source view. Zero → no headline, with the ineligibility
reasons visible on the rows.

This replaces an earlier "show the dominant/default clinically meaningful stratum" option
that defined neither *dominant* nor *default*. Two implementations reading that sentence
could pick different strata — an oral single dose here, a steady-state IV there — and
publish different Cmax headlines for the same drug from the same evidence, each satisfying
every rule in this document. An underdetermined rule about which number to show is the same
class of defect as an underdetermined estimator, which is what the "How the cohorts in a
stratum combine" section above exists to close.

Ranking strata by clinical relevance is a real feature and a later one: it is a clinical
policy judgement (is the oral single dose the default for every drug? for a drug given only
by infusion?), it needs its own evidence and its own review, and it must arrive with an
explicit total order and a stated tie-break. Until then the honest answer for a
multi-stratum drug is that there is no single number, which is what this document has
preferred at every other fork.

Example headline:

```text
Cmax, oral single dose (plasma, immediate release, fasted, healthy adults)
0.044 µmol/L/mg — weighted median of 8 cohorts
between-cohort spread 0.038-0.051
```

## Source-values / forest-plot UI

The source dialog gets a display toggle for Cmax:

```text
Observed Cmax | Dose-normalized
```

Observed mode shows each paper's reported concentration and its structured dose context.

Dose-normalized mode derives each eligible row in the browser or from an API-normalized payload using the same shared pure normalizer. Ineligible rows remain listed with a reason rather than disappearing.

Example observed rows:

```text
0.5 mg   0.021 µmol/L
1 mg     0.044 µmol/L
2 mg     0.091 µmol/L
```

Example normalized rows:

```text
0.5 mg   0.042 µmol/L/mg
1 mg     0.044 µmol/L/mg
2 mg     0.046 µmol/L/mg
```

Do not normalize the visual interval by a dose midpoint when the study reports only a dose range.

## Dose vs Cmax view

Once both variables are structured, a later view is straightforward:

```text
x = dose
y = observed Cmax
```

This should be treated as an additional visualization, not as the source of truth for normalization.

With enough values, Kinetix can later offer a log-log trend where a slope near 1 is evidence consistent with dose proportionality. That belongs after the storage and display semantics are settled.

## Write surfaces that must be threaded through

Structured dose context — and the reported-statistic fields alongside it — must not work only in the human editor. It must be included in every producer/consumer of `parameter_entries`, including at least:

- direct/admin parameter-entry creation and update
- pending `param_entry` edits and approval re-validation
- conversation ingestion
- deep-research import `sourceValues[]`
- parameter-entry API serialization
- parameter-entry list/editor UI
- citation/review displays where entry context is shown
- **every** duplicate-identity predicate, not only the importers' reconciliation. This is
  the same rule in at least three places: `entryDuplicateExists` in the entries store, the
  importers, and the copied predicates in `api/_lib/drug-merge.ts`. All of them currently
  identify an observation by the legacy value/citation/context tuple — drug, parameter,
  matrix, scenario, route and the value — which does not include a single dimension this
  RFC adds. Two arms of one paper reporting the same Cmax at different doses are then
  "identical": the second is refused on insert, and at merge time one of them is **deleted**
  as a duplicate. Silent loss of curated evidence, from a numeric coincidence.

  Every such predicate must compare the complete entry shape — dose context, basis and salt
  form, regimen and exposure position, formulation, prandial state, coadministration,
  population, statistic, and value basis — and the merge-side comparison must run **after**
  FK repointing, so two rows that become identical through a merge collide and two that stay
  distinct survive. Because these predicates *handle* values rather than create them, they
  belong in release B, before any producer.
- drug merge logic for `administeredDrugId` and `interactingDrugId`, **including the copies
  nested inside active `param_entry` pending-edit payloads**. The merge retargets those
  proposals by the outer `target_id` (`WHERE edit_type = 'param_entry' AND target_id =
  :loserId`), which selects a proposal whose *analyte* is the loser. A proposal whose analyte
  is drug A but whose `administeredDrugId` is the merge loser B is never selected, so
  deleting B leaves a stale nested id: approval after release C then fails validation or FK
  enforcement, or — worse — silently loses the administered-drug provenance the proposal was
  making. `drug-merge.ts` already notes that a create proposal "carr[ies] the drug id in TWO
  places"; these fields add a third and fourth. Repointing them is a release-B handler,
  with a merge test covering both ids
- drug **delete** logic, which currently depends on the `drug_id` cascade (see the migration
  section — the new FK shadows it), **and must also inspect the drug ids nested inside active
  `param_entry` pending payloads**. The teardown in `api/drugs.ts` removes create proposals
  whose outer `target_id` is the drug, and update/delete proposals targeting entries the drug
  owns; it never looks inside the payload JSON, which carries no FK. So after release C a
  proposal for analyte A naming the deleted drug B as its administered or interacting drug
  survives the delete with a stale nested id — and then either fails on approval or keeps
  provenance pointing at a drug that no longer exists. This is the same defect as the merge
  case and needs the same release-B handling, with tests for both ids
- tests/fixtures that compare complete entry shapes

This is the same lesson as route and source-quote additions: a new evidence dimension is only real if all write paths preserve it.

## Migration strategy

Use an additive migration. Existing entries receive null dose and statistic fields and
remain valid because no existing parameter requires dose context yet, and a null
`centralStatistic` preserves the legacy `median`/`low`/`high` reading unchanged.

`administeredDrugId` is required only for dose-context parameters, via a parameter-scoped
CHECK rather than a blanket `NOT NULL`, and legacy rows keep null — see section 2 for why a
whole-table self-reference backfill would fabricate provenance. It is **not** added and
constrained in one migration either: the column, the writers that populate it and the
constraint that requires it are three separate releases, for the reasons set out in the two
sections below. Nothing in this strategy may be read as licence to combine them.

### The self-reference breaks drug deletion unless the delete path changes first

Cmax rows carry a self-reference, so deleting a drug meets its own evidence under
`ON DELETE RESTRICT`. That silently breaks deleting a drug.

`api/drugs.ts` ends its teardown transaction with a bare `tx.delete(drugs)` and relies on
the existing `drug_id` cascade to take the entries with it — the code says so in as many
words: "The entry rows themselves vanish via ON DELETE CASCADE with the drug". A
self-referencing `administeredDrugId` under `ON DELETE RESTRICT` makes that delete fail on
the drug's own evidence. A restriction meant to protect metabolite provenance would instead
make any drug with a Cmax entry undeletable, which is a data-management regression, not a
safety feature. (Scoping the column to dose-context parameters limits this to drugs that
have Cmax data, rather than every drug in the catalog — but it does not remove it, so the
delete path still changes first.)

> **Correction (release B1).** The self-reference does not *reliably* fail a
> cascade-only delete — it fails it *depending on trigger order*, which is worse.
> PostgreSQL fires the foreign-key triggers on `drugs` in trigger-name order, and
> the names (`RI_ConstraintTrigger_a_<oid>`) embed an oid, compared as text. If the
> `drug_id` cascade's trigger sorts first, it removes the self-referencing row
> before the restrict check looks and the delete succeeds; if the restrict
> trigger sorts first, the delete fails. On the integration harness the cascade
> sorts first, so removing release A's explicit delete leaves every test there
> green. On a database whose oids have crossed a digit boundary since
> `parameter_entries` was created, the order can invert. The explicit delete is
> therefore still required — it makes the outcome independent of oids — but the
> restrictive FK cannot serve as the test that detects its absence. The guard is
> a trigger recording whether each entry was deleted while its drug still existed
> (`tests/integration/drug-delete-parameter-entries.test.ts`).

A single FK cannot express both rules, so the delete path carries the distinction — and it
must do so **in a form that works against both the old and the new schema**, because a
rolling deploy runs one against the other in both directions.

The predeployed delete therefore names only columns that already exist:

```sql
DELETE FROM parameter_entries WHERE drug_id = :id;
```

That is by `drug_id` alone — every entry the drug owns, which is exactly the set the
`ON DELETE CASCADE` removed. It cannot mention `administered_drug_id`, which does not exist
yet; a delete written against the new column would fail on every drug deletion the moment it
shipped, which is the same outage by a different route. And because it is behaviourally
identical to the cascade, it is safe to run for as long as the old schema is still live.

The delete change and the schema change must not ship together. If they land in one release,
the migration still runs while the previous deployment is serving requests, and that
deployment's cascade-only delete meets the new restrictive FK — the outage this section
exists to prevent, narrowed to a deploy window instead of removed.

### This section has been wrong four times — read it adversarially

Rounds fourteen through eighteen of review each found the *previous* round's concurrency
answer materially wrong rather than merely incomplete: a scan that could not close the race,
then locks with one member outside the sorted set, then locks that proved ordering but not
existence, then a union formed from an id that is not always a drug id. Every one of those
looked right when written.

Nothing here is known to be wrong now. But the track record in this section is unlike the
rest of the document, and the failure mode — a race that appears under concurrent load and
not in tests — is the kind that survives review by inspection. **This is the part of the RFC
most worth a human engineer's eye before implementation**, and the part where an
implementer should expect to find something the document still has wrong.

### Owner review of the locking design (2026-09-22) — binding amendments

The owner traced this section against `main`
(from the review of issue 1340)
and found no fifth fundamental flaw in the protocol: derive the complete drug-id lock
set, sort once, take every advisory lock before any row lock, re-read existence under
the locks, then write. Two statements below were stale, and the implementation (B4) is
bound by the following amendments, which take precedence over the text after them.

1. **Stale facts, corrected.** `api/drugs.ts` already takes
   `lockDrugForEntryApplicability(id)` around the delete teardown, and
   `drugAdvisoryLockIdsForEdit` already handles `param_entry`: it resolves the owning
   drug and returns `[owner]` (added for the advisory-vs-pending-row ABBA fix). The Cmax
   change **extends** that set from `[owner]` to the sorted, de-duplicated
   `[owner, administeredDrugId, interactingDrugId]`, keeping `assertLockedEntryOwner`
   and the preflight-vs-row review-token check.
2. **Every pending-payload writer is enumerated and goes through one shared
   primitive.** Not only the initial create/update/delete proposals from
   `api/parameter-entries.ts`, but every path that can change an effective `param_entry`
   payload: a submitter's `PATCH /api/pending-edits` revision, re-draft or resubmit, a
   reviewer return that rewrites `proposedValue`, and any other generic pending-edit
   mutation. Without this, the authoring race is closed and then reopened by revising
   the proposal to name a drug being deleted.
3. **Re-read the target entry, not only the referenced drugs.** The order is: derive the
   effective post-write payload → resolve the owning drug for the op → lock the sorted
   unique set → for update/delete, re-read the target entry and verify its owner is a
   drug we hold → re-read every referenced drug row → only then write. A create has no
   target entry, so only the owner and nested-drug existence checks apply.
4. **Ambient transaction.** The shared primitive uses `inTransaction()`, never a bare
   `runInPoolTransaction()`. A nested pool transaction is a second connection; if the
   outer one holds `pg_advisory_xact_lock` and the inner requests the same lock, the two
   wait on each other until timeout. PGlite hides this (one connection, savepoints), so
   it is part of correctness, not style.
5. **Tests beyond PGlite.** The concurrent author-vs-delete and author-vs-merge tests are
   joined by a real-Postgres concurrency test in the manner of
   `tests/governance/transaction/real-postgres-deadlock.test.ts`, and/or a structural test
   that the nested writer keeps the caller's `getDb()` transaction.
6. **One global lock order.** All drug advisory locks from one sorted unique set, before
   any `pending_edits`, `parameter_entries` or `drugs` row lock. Never
   advisory(owner) → row(target) → advisory(interacting).
7. **"Active pending edit" is defined once** — `pending`, `draft` and `returned`, as a
   shared constant — and the nested-id scan, rewrite and delete all use it: a draft or
   returned proposal can be resubmitted with its stale nested id.
8. **Merge-side JSON rewrites keep row-lock semantics.** A read-modify-write of
   `pending_edits.proposed_value` locks the rows `FOR UPDATE` first, as
   `rewriteWikiLinks` does; an atomic JSONB `UPDATE` is equally acceptable, provided the
   competing PATCH path participates in the same advisory-lock protocol (amendment 2).

The two outcomes must be exhaustive. **Author first:** the author holds the full sorted
set, validates, commits; the merge or delete waits, then sees the proposal and repoints
or removes it. **Merge/delete first:** the author waits, acquires the set, re-reads the
post-operation state, finds a missing or repointed target or a missing nested drug, and
refuses the write.

### Scanning the payloads is not enough on its own

A release-B handler that scans existing `param_entry` JSON still loses a race: the merge or
delete scans, finds nothing, removes drug B, and a proposal naming B commits immediately
afterwards. JSON has no FK, so nothing rejects the write. Scanning narrows the window; it
does not close it.

The repository already solves this exact problem for wiki content, and the mechanism
transfers directly. `drugAdvisoryLockIdsForEdit` in `api/_lib/pending-edits-helpers.ts`
extracts every drug reference from a proposal's JSON, resolves slugs to ids, and returns them
**sorted ascending** so all parties take the locks in one order and cannot deadlock; the
caller takes an advisory lock per id before reading the edit row. There is also a companion
refusal that catches a proposal submitted *after* a merge committed, as the last stop before
publication.

That helper currently returns `[]` for every edit type but `wiki_new`, `wiki_page` and
`wiki_fact` — so `param_entry` gets none of it. The first implementation extends the same
three parts rather than inventing a second scheme:

1. `drugAdvisoryLockIdsForEdit` also extracts `administeredDrugId` and `interactingDrugId`
   from a `param_entry` payload — and returns the **union of those with the edit's owning
   drug, sorted once, ascending**.

   **The owning drug has to be resolved per operation, not read off `targetId`.**
   `api/pending-edits.ts` says so in as many words: "`targetId` on the pending row carries
   the drug id for a create and the entry id for update/delete, so enrichment resolves the
   drug differently per op." Forming the union straight from `targetId` would, for an update
   or delete, lock an *entry* id as though it were a drug id — locking the wrong number,
   leaving the real owner unlocked until `assertEntryParameterApplicable` takes it later, and
   omitting the owner from the existence re-read. A concurrent merge whose ids sort the other
   way then still closes the ABBA cycle. So: create takes `targetId` as the drug; update and
   delete resolve the entry's owning `drugId` first, and *that* joins the union. Sorting only the nested ids is not enough: the
   submission and approval paths take the outer target's lock separately today
   (`lockDrugForEntryApplicability(drugId)` before the applicability check), so for an edit
   targeting A and naming B with A > B, the edit would take A then B while a merge of B into
   A takes them ascending — B then A. That is the ABBA deadlock the ordering exists to
   prevent, reintroduced by the one lock left outside the sort. Every lock in the union is
   acquired before the pending-edit row is touched.

   `drug-merge.ts` already does exactly this for its own pair —
   `const orderedIds = [winnerId, loserId].sort((a, b) => a - b)` — and the edit path has to
   sort the same way over a larger set, once every member of that set is genuinely a drug id.

2. Pending-payload **writers** take those locks before committing, and drug **delete** and
   **merge** take the advisory lock for the drug they are removing — the delete path does not
   take it today. Same order, so author-vs-delete and author-vs-merge serialize instead of
   interleaving.

   **Holding the locks is not the same as the drugs existing.** A Postgres advisory lock is
   taken on a number; it succeeds whether or not a row with that id is still there. If a
   delete or merge commits first, the writer then acquires its locks perfectly happily and
   commits stale JSON anyway. So the writer must **re-select every referenced drug row while
   holding the locks** and refuse the write if one is gone — again following the merge, which
   pairs its advisory locks with
   `SELECT id FROM drugs WHERE id IN (…) ORDER BY id FOR UPDATE`. Without that re-read the
   locking buys ordering and nothing else, and the required test below — that the proposal
   itself is refused — could not pass.

3. A **last-stop refusal** on approval, mirroring the wiki one: a `param_entry` proposal
   naming a drug that no longer exists is refused rather than approved into a dangling
   reference. This is defence in depth behind step 2, covering a proposal that predates the
   locking, or any path that slips through — it cannot substitute for the existence check,
   because it only prevents publication, long after the stale row was written.

Required tests: concurrent author-vs-delete and author-vs-merge, for both ids, asserting the
proposal either serializes behind the removal and is refused, or commits before it and is
repointed — never commits a stale id.

FK-backed pending references would be the stronger answer and are worth revisiting later;
they are a change to how every pending edit stores references, which is more than this RFC
should take on.

### The same rule applies to the writers

The requirement constraint has the mirror-image problem on the insert path.
`api/_lib/parameter-entries-store.ts` builds its insert by enumerating columns explicitly,
so a previously deployed instance writes no `administered_drug_id` at all. Tightening the
column in the same release that adds it means every parameter-entry creation served by the
old deployment fails for the length of the rollout — the same defect as the delete case,
with creation broken instead of deletion.

So the constraint lags the column by two releases, and the writers by one:

- **release B** adds every new column **nullable, with no constraint that requires it**, and
  ships no writer for them. Old and new code both write successfully: both leave nulls,
  which are legal.
- **release B** also adds the administered-drug and interacting-drug **FKs**, nullable and
  `ON DELETE RESTRICT`, alongside the columns. A nullable FK constrains only rows that have
  a value, so it is compatible with old code that supplies none — and it has to land with
  the column, not later: release A's delete removes only rows owned by `drug_id`, so a
  window in which a reference can exist unconstrained would let it be orphaned, and a later
  FK creation would then fail on data the rollout itself produced.

  **Release B also ships every piece of code that must handle a value in these columns, and
  no code that can create one.** That means the drug-merge repointing, alongside the delete
  path already shipped in release A. `api/_lib/drug-merge.ts` repoints
  `parameter_entries.drug_id` and then deletes the loser row; it knows nothing of
  `administered_drug_id`, so an entry whose administered drug is the merge loser would hold
  a reference the delete then hits under `ON DELETE RESTRICT`, failing the merge. Shipping
  the merge fix *with* the writers is not enough, because in a rolling deploy an old
  instance still running the unfixed merge can meet a row a new instance has already
  written. The handler must be everywhere before the first value can exist.
- **release C**, once release B is deployed everywhere, ships the **writers** — the paths
  that populate the new columns (`administeredDrugId` defaulting to the entry's own `drugId`
  for a self-administered observation). Only now can a non-null `administered_drug_id` or
  `interacting_drug_id` appear, and by then every instance can delete and merge around one.
- **release D**, once release C is deployed everywhere, adds the partial CHECK requiring
  `administered_drug_id` for dose-context parameters, and the remaining CHECK constraints.
  There is no backfill of any kind: legacy rows keep null, which stays legal for them, and
  the only rows the CHECK governs are ones written by release C's code with the value
  already set.

`ON DELETE RESTRICT` begins firing in release B, with the FK. That is safe precisely because
release A came first: no running code depends on the cascade for these rows any more, since
release A's explicit delete already removes them.

The general rule this is an instance of: **code that must handle a column's values ships
before any code that can create them, and the constraint that requires them ships last.**
Handlers (the delete path, merge repointing, anything that moves or removes referencing
rows) come first, then producers, then the requirement — four releases here, not one.
Shipping a handler alongside its producer is the trap: a rolling deploy runs the old handler
against the new producer's rows. Any other parameter that later
adopts dose context follows the same three steps, and any other cascade a new column shadows
has to be re-checked the same way.

Migration tests must cover both rolling-deploy windows: an insert that omits the new columns
succeeds against the release-B schema, and a drug with entries deletes cleanly at every
stage.

Suggested sequence:

1. **release A** — drug delete removes owned entries explicitly by `drug_id`, replacing
   reliance on the cascade. Schema-compatible both ways; deploy everywhere before step 2.
2. **release B** — add every new column **nullable**, add the administered-drug and
   interacting-drug FKs (nullable, `ON DELETE RESTRICT`), and ship **every handler**:
   - drug-**merge** repointing for the new columns, including the drug ids **nested inside
     active `param_entry` pending-edit payloads**,
   - drug-**delete** handling of those same nested payload ids — the merge and the delete
     path both need it, and listing only the merge here is what left the gap: during the
     release-C rollout an old release-B instance can delete drug B after a new instance has
     already authored a proposal naming B in a nested id, and the JSON carries no FK to
     catch it,
   - **advisory locking of every drug a pending payload references**, without which the two
     handlers above only narrow the race rather than closing it (see below),
   - the duplicate-identity predicates, comparing the complete entry shape,
   - entry **serialization and the read-side entry model**, which read nullable fields and
     are therefore backward-compatible,
   - the **shared entry store's field-aware write path** (`insertParameterEntry`).
     `applyApprovedParameterEntry` publishes an approved create through that same store, so
     deferring it to release C would have a release-B approval persist a release-C payload
     through the legacy column enumeration and **truncate** the new context — with release
     D's CHECK not yet present to catch it. The store ships in B behind the authoring gate;
     release C only enables its producer-facing callers.
   - **`centralValue` added to the value-field enumerations** — `EntryValueFields`, the
     registry bounds loop in `validateEntryForParameter`, and the qualifier/containment
     invariants — so a release-B approval of a release-C proposal rejects an out-of-range or
     inconsistent central value instead of storing it.
   - **approval-side parsing and persistence** of the new fields. Approval is a handler as
     well as a producer: during the release-C rollout a new instance can author a Cmax
     proposal while an old instance receives its *approval*, so an approval path that cannot
     parse the complete shape either refuses a valid approval or persists a truncated
     payload — and release D's CHECK does not exist yet to catch the second. Only proposal
     **authoring** is gated to release C; the ability to approve what authoring produces
     ships in B.
   - the **registry contract** — `entryBacked` / `doseContext` / `normalizationRequires`
     semantics *and* the Cmax registry entry itself. Without it the predeployed approval
     handler cannot do the job it was predeployed for:
     `validateEntryForParameter` rejects any parameter that is neither in
     `SUMMARIZED_PARAMETER_IDS` nor route-scoped with `"cmax" is not a source-entry-backed
     parameter`, so a release-B instance would refuse a valid release-C proposal before ever
     reaching the field parsing.
   - an **explicit Cmax-authoring gate on every generic producer**, shipped in the same
     release as the registry entry. Registration is *not* inert: `POST /api/parameter-entries`
     admits any parameter `validateEntryForParameter` recognises, through both its direct
     write and its queued-proposal branch, so registering Cmax in release B silently opens
     generic authoring a release early — while old instances still run the unrepointed merge
     and delete handlers. That is precisely the mixed-version window this sequence exists to
     close, reopened by the fix for it. The gate refuses Cmax creation on every generic
     producer until release C, and is removed there.

   No writers yet, so every value is null and all of this is a no-op — which is the point:
   every handler is everywhere before the first value exists.
3. **release C** — the **writers**: the write API, pending-edit payload *authoring*,
   conversation ingestion, deep-research import, the editor. These are the producer-facing
   **callers** of a store whose field-aware write path already shipped in release B;
   `insertParameterEntry` itself is deliberately **not** listed here, and release C also
   removes the Cmax-authoring gate rather than adding persistence. An earlier revision of
   this step did list "the entries store's write path", which would have let an implementer
   leave `insertParameterEntry` field-unaware in B — reinstating exactly the silent
   truncation the release-B item above exists to prevent. Values can now appear, and every
   instance can already read, serialize, dedupe, merge, validate, **approve and persist**
   them.
4. **release D** — the parameter-scoped CHECK requiring `administered_drug_id` for
   dose-context parameters, and the remaining CHECK constraints. **No backfill, and no
   blanket `NOT NULL`** — see the two sections above for why either would fabricate
   administration provenance on legacy rows.
The four releases above are the boundaries, and the classification that decides them is
**handler / producer / requirement**, not "schema versus code":

- a **handler** must read, move, repoint, compare or remove a row carrying a value — the
  delete path (release A), and in release B: merge repointing (columns and nested pending
  payloads), the duplicate-identity predicates, and serialization / the read-side entry
  model. Ships before any value can exist.
- a **producer** creates a value — every write path (release C).
- the **requirement** is the CHECK (release D).

Serialization counts as a handler, not read-side polish: if the writers ship first, a Cmax
entry stored in release C cannot be faithfully re-read, reviewed or round-tripped by an API
still returning the legacy shape — for two release windows, on evidence that is being
curated. A reader of nullable fields is backward-compatible, so there is no cost to shipping
it early and a real cost to shipping it late.

Registry semantics (`entryBacked` / `doseContext` / `normalizationRequires`) and the Cmax
registry entry ride with **release B**, not C — because an unregistered parameter is refused
by `validateEntryForParameter` before any handler sees its fields, so a handler without the
registry entry cannot accept the payload it exists to accept.

But registration is **not** inert, and an earlier revision of this document claimed it was.
The generic entry endpoint admits whatever the registry recognises, so registering the
parameter *is* the authoring gate for that path. Release B therefore pairs the registry entry
with an explicit refusal of Cmax creation on every generic producer, lifted in release C.
Registration makes the payload legal to **accept**; the gate keeps it illegal to **create**
for one more release. Those are separable only because the gate is written.

**After release D**, the genuinely new Cmax features, which create no rows and handle no
existing ones:

5. add the pure normalizer and tests
6. add normalized summary read model
7. add observed/normalized toggle to the source plot
8. only after those paths are complete, seed/curate Cmax values

No backfill should attempt to parse dose out of existing comments automatically.

## Tests required before merge

### Schema / validation

- exact dose accepted for Cmax
- range-only dose accepted; ineligible for normalization when
  `valueBasis: 'concentration'`, eligible when `'dose_normalized'`
- a `valueBasis: 'concentration'` Cmax without dose is rejected; a `'dose_normalized'` one
  without dose is accepted (and is normalizable but not poolable — see the eligibility table)
- dose fields rejected for a forbidden parameter
- absolute and weight-normalized dose families remain distinct
- invalid ranges/negative doses rejected
- repeated-dose interval invariants enforced
- metabolite Cmax accepts a different `administeredDrugId`
- Cmax with a self-referencing `administeredDrugId` is accepted and is the common-path shape
- Cmax with a null `administeredDrugId` is rejected by schema and by the partial CHECK
- a non-dose-context entry (a metabolite Tmax, say) with a null `administeredDrugId` is
  **accepted**, and the migration leaves such legacy rows null rather than asserting
  self-administration
- `doseValue` together with a non-degenerate range is rejected by schema and CHECK
- a degenerate range is rejected and must be authored as `doseValue`
- **a one-sided range — only `doseLow` or only `doseHigh` — is rejected by schema and CHECK**
- `ivInputMode: 'bolus'` with a duration is rejected; `'infusion'` without one is rejected
- `releaseProfile` and `physicalForm` are independently settable, including
  `{ modified, suspension }`
- `PhysicalForm` has **no `'parenteral'` member**: an IV solution is
  `{ not_applicable, solution }`, an IM depot suspension is `{ modified, suspension }`, and
  the two never pool. A vocabulary test asserts the members, so reintroducing a route class
  into the form vocabulary fails rather than silently re-creating the overlap
- **every context field the source may omit is accepted at write and refused at
  normalization** — `centralStatistic` (in the case that gates it: a central value present
  and unlabelled), `intervalKind`, `doseBasis`, `releaseProfile`,
  `physicalForm`, `prandialState`, `pkPopulation`, `coadministrationState`, `ivInputMode`
  and a repeated-dose `doseIntervalHours` each get one test proving the row **stores** with
  the value absent or `'unknown'`, and one proving the normalizer refuses it with the reason
  named in the storage/normalization table. A test asserting any of these is *rejected at
  write* contradicts that table and is itself the defect
- `valueBasis` absent **is** rejected at write, being the one context field whose absence
  leaves the number uninterpretable
- an arithmetic mean ± SD, a geometric mean with a CI and a median with a subject range all
  round-trip with their statistic and interval kind intact
- a Cmax written with `median` is stored as `centralValue` + `centralStatistic: 'median'`
  with `median` null; both fields with equal values canonicalize identically; both with
  different values are rejected
- a Cmax with bounds and no `intervalKind` is **rejected at write**, and so is an
  `intervalKind` with no bounds; a *legacy non-Cmax* entry with bounds and a null
  `intervalKind` still reads as `'unknown'` and is untouched
- the same cohort submitted once as `median` and once as `centralValue` collides on the
  duplicate check and cannot be counted twice
- `multiple` regimen without `doseNumber` or `regimenDurationHours` is stored but flagged
  `unresolved_exposure_state`
- `{ centralStatistic: 'single_subject', n: 400 }` is **rejected at write**; the same entry
  with `n: 1` or no `n` is accepted
- a null `doseRegimen` and `doseRegimen: 'unknown'` both store and are both ineligible with
  `unknown_dose_regimen` — not `unresolved_exposure_state`, which stays specific to a
  `multiple` regimen missing its exposure position

### Normalization

- µg/mg/g normalize identically within absolute-mass family
- µg/kg and mg/kg normalize identically within weight-normalized family
- no implicit mg/kg -> mg conversion
- source concentration unit conversion happens before division
- matrix conversion happens before division
- range-only dose does not use midpoint, under either `valueBasis`
- a range-only `'concentration'` entry is ineligible even when a representative dose is
  supplied
- an entry with no route is ineligible with `missing_route`, never pooled into a null stratum
- `route: 'other'` is ineligible with `unresolved_route`, and two `'other'` entries never
  pool with each other
- `centralStatistic: 'unknown'` is ineligible with `unlabelled_statistic` and forms no stratum
- an IV entry with no resolved input mode is ineligible with `unknown_iv_input_mode`
- `releaseProfile: 'unknown'`, `physicalForm: 'unknown'`/`'other'` are ineligible with
  `unknown_formulation`
- `prandialState: 'unspecified'` on `oral` is ineligible with `unknown_prandial_state`; on
  `intranasal`, `iv`, `im`, `sublingual`, `inhalation` or `rectal` the entry is eligible and
  its normalized result carries `prandialState: null`, never `'unspecified'`
- two eligible IV entries with null prandial state **pool with each other**, unlike two
  `'unstated'` dose strata, which never do — not-applicable joins, unknown does not
- `ivInputMode` absent on `iv` is ineligible with `unknown_iv_input_mode`; absent on any
  other resolved route is eligible and pools
- **both route-conditional requirements are tested for every `RouteId`**, so adding a route
  to `ROUTE_IDS` fails a test rather than defaulting silently
- a repeated-dose entry with a null interval is ineligible with `missing_dosing_interval`
- `coadministrationState: 'with_interacting_drug'` is ineligible with
  `interaction_arm_not_pooled` and stays visible, labelled with the interacting drug
- `coadministrationState: 'unknown'` is ineligible with `unknown_coadministration_state`
- a non-`healthy_adult` population is ineligible with `altered_population_not_pooled` and
  stays visible, labelled with its `populationQualifier`
- `pkPopulation: 'unknown'`/`'other'` is ineligible with `unknown_population`
- a missing `doseBasis` is ineligible with `unknown_dose_basis`, and no basis is ever
  inferred from a drug name, salt suffix or default
- a declared ratio with no stated dose is normalizable but not poolable
  (`unstated_dose_level`), and two such entries never pool with each other
- `doseBasis: 'salt'` without `doseSaltForm` is normalizable but not poolable
  (`unspecified_salt_form`)
- two salt-basis entries with different `doseSaltForm` values never pool
- a hand-authored `bloodPlasmaRatio` (the flunitrazepam and LSD catalog estimates) yields
  `unsourced_matrix_ratio` for a cross-matrix entry, and the same drug becomes eligible once
  the ratio is entry-backed with a reported central value; the `note` text is never parsed
- **the direction is asserted numerically**: a whole-blood Cmax of 10 with `r = 0.5`
  normalizes to 20, not 5; a plasma Cmax with the same ratio is unchanged. A test asserting
  only that a conversion occurred would pass with the arithmetic inverted
- a zero-valued sourced B/P entry is excluded from the candidate set and does not drag the
  weighted median: a drug with entries `0` and `0.8` converts by 0.8, and a drug whose only
  candidates are non-positive yields `missing_matrix_conversion`
- a drug whose only sourced B/P entries are **censored** (`{ median: 0.8, qualifier: '<' }`)
  yields `censored_matrix_ratio` and no conversion — the threshold is never treated as the
  ratio, even though it passes the reported-central-value test
- a drug with **two equally weighted** eligible B/P entries, 0.6 and 0.9, resolves to exactly
  **0.6** — the lower candidate, as `weightedPercentile(points, 0.5)` returns — never 0.9,
  never the midpoint 0.75, and never whichever row a query returns first. The assertion is on
  the number: a test saying only "resolves deterministically" passes under all three
- a drug whose only sourced B/P entries are **bounds-only** yields `bounds_only_matrix_ratio`,
  **not** a conversion — even though `summaryToNumericRange` publishes a drug-level `median`
  carrying `derivedFromEntries: true` for exactly that case. The normalizer reads the entries,
  never the cached scalar
- a bounds-only Cmax entry with **no** `centralStatistic` normalizes and is displayed with
  `missing_central_value`; a Cmax entry that *has* a central value and no statistic is
  `unlabelled_statistic` and does not normalize — the two null-statistic cases are different
- a drug with two eligible strata shows "multiple administration contexts" and a count, not
  either stratum's number; a drug with exactly one shows that stratum's headline
- every field on the pooling side of the requirements table (`centralValue`, `qualifier`,
  `doseSaltForm`) yields `normalized_not_poolable` with a visible normalized value, and
  every field on the normalization side yields `ineligible` with no normalized value
- the normalizer reports `poolable` separately from a successful normalization, and the
  headline consumes only `poolable: true` entries
- a `valueBasis: 'dose_normalized'` entry keeps its value basis and is never divided a
  second time, **while still being canonicalized**: the assertion is on the absence of a
  division, not on the number being untouched. A test asserting the value is "unchanged"
  would be satisfied by the 1000-fold unit error below.
- a declared ratio is eligible with an exact dose, with a range, and with no dose at all
- a `'concentration'` entry with no dose at all is rejected, while a declared ratio with no
  dose is accepted — the two bases have different requirements
- a declared ratio whose unit denominator family disagrees with its `doseUnit`
  (`µmol/L/(mg/kg)` with `doseUnit: 'mg'`) is rejected
- declared ratios in `µmol/L/µg`, `µmol/L/mg` and `µmol/L/g` canonicalize to the same
  stratum and the same magnitude — the pass-through skips division, not unit conversion
- a declared ratio from a variable-dose cohort yields a `'range'` dose stratum and is never
  collapsed to a point
- an exact-dose stratum never pools with a range that contains it
- derived and source-reported ratios do not pool with each other
- the normalized result exposes `normalizedCentralValue` carrying the source
  `centralStatistic`, and no field named or treated as a median
- an entry missing any single dimension of the declared context profile is ineligible —
  one test per dimension, so a dimension added later without an eligibility rule fails
- `multiple`/`steady_state` without `priorDosingRegular: true` is ineligible with
  `unsupported_regimen_context`
- cross-matrix normalization without a valid B/P ratio is ineligible with
  `missing_matrix_conversion` and never falls back to a scalar of 1
- a zero, negative or non-finite B/P ratio is `missing_matrix_conversion`, not identity
- a **bounds-only** B/P ratio (`{ min, max }` with no `mean` or `median`) is
  `bounds_only_matrix_ratio`, and the midpoint is never taken — the same refusal the dose
  range gets in section 3
- a B/P ratio carrying a `median` or `mean` converts normally
- a urine, vitreous, hair or `other` matrix entry is `unsupported_matrix_conversion` even
  when the drug has a perfectly valid B/P ratio, and is never pooled into a plasma headline
- same-**side** entries normalize by identity without needing a B/P ratio: plasma → plasma
  and **serum → plasma** both convert unchanged, and neither is excluded for want of a ratio
- every eligible entry reports `normalizedMatrix: 'plasma'`, and two entries normalized to
  different target matrices never pool
- `{ centralValue: 5, centralStatistic: 'arithmetic_mean', intervalKind: 'sd' }` — an
  interval kind with no bounds — is **rejected at write**, as is a Cmax payload carrying
  bounds with no `intervalKind`. No row can claim an interval it does not carry
- a normalized censored entry carries `normalizedCentralValue`, its `qualifier` **and a null
  `centralStatistic`**; the two null-statistic cases on the normalized type are bounds-only
  and censored, and no other
- the concrete payload `{ centralValue: 5, qualifier: '<', unit: 'ng/mL' }` — no
  `centralStatistic`, no `intervalKind` — **stores**, normalizes, and is displayed with its
  operator as `normalized_not_poolable` with `censored_value`; its threshold never enters the
  weighted median. The same payload **with** a `centralStatistic`, with an `intervalKind`
  (`{ centralValue: 5, qualifier: '<', intervalKind: 'sd' }`), and `{ median: 5,
  qualifier: '<' }`, are all rejected at write — a censored row can never carry a dispersion
  label
- `{ centralValue: -1 }` is rejected at write by the registry bounds check, as `low: -1`
  already is, and a `centralValue` outside `low..high` is rejected by the containment check
- `{ low, high, intervalKind: 'sd' }` and the same with `'sem'` are **rejected at write**
  for want of a `centralValue`; the same bounds with `'range'`, `'iqr'` or `'ci95'` are
  accepted — so no SD interval can ever reach the bounds-only display path
- `{ centralValue: 5, low: 4, high: 9, intervalKind: 'sd' }` is **rejected at write** for
  asymmetry, while `{ centralValue: 5, low: 4, high: 6 }` is accepted; the same asymmetric
  bounds with `'range'` or `'iqr'` are accepted, since those are not dispersion around a
  centre and have no symmetry to satisfy
- `{ centralValue: 1, low: -1, high: 3, intervalKind: 'sd' }` — a reported `1 ± 2 ng/mL` —
  **is accepted**: the registry minimum applies to `centralValue`, not to an arithmetic
  endpoint. `{ centralValue: 1, low: -1, high: 3, intervalKind: 'ci95' }` — `1 ng/mL
  (95% CI −1–3)` — is accepted for the same reason, **and** with asymmetric limits such as
  `low: -0.5, high: 4`, since a CI need not be symmetric. `{ low: -1, high: 3, intervalKind:
  'range' }` is still rejected, and `{ centralValue: -1, ... }` is still rejected whatever
  the interval kind
- a bounds-only entry (`{ low, high, intervalKind: 'range' }`, no `centralValue`) normalizes
  and is displayed, but is `normalized_not_poolable` with `missing_central_value`, and its
  midpoint never reaches the headline
- the normalized result carries the source `centralStatistic` and `intervalKind`
- raw entry object is never mutated

### Aggregation

- oral and IV values do not silently pool
- single-dose and steady-state values do not silently pool
- different steady-state intervals do not silently pool
- different administered drugs do not silently pool
- non-steady `multiple` observations at different dose numbers do not silently pool
- non-steady `multiple` observations with no exposure position are excluded from the summary
- geometric means and arithmetic means do not silently pool
- observations at different dose levels do not pool, even within the same dose family
- salt-basis and free-base observations do not pool at the same numeric dose
- immediate-release and modified-release observations do not pool at the same dose
- a modified-release suspension does not pool with a modified-release tablet, nor with an
  immediate-release suspension
- fed and fasted oral observations do not pool at the same dose
- an interaction arm never enters a monotherapy headline, at any dose
- a hepatic-impairment arm never enters a healthy-adult headline, at any dose
- repeated-dose observations at different intervals do not pool at the same dose number
- IV bolus and IV infusion observations do not pool at the same dose
- a 5-minute and a 2-hour infusion do not pool at the same dose; two infusions of equal
  canonical duration do
- a drug whose only entries are unknown-statistic yields no headline rather than a stratum
  built from them
- oral and route-less observations do not silently pool
- ineligible entries remain visible but are excluded from normalized summary
- the headline point estimate is the **weighted median** of per-entry normalized central
  values computed with `entryWeight` itself, so two entries of equal `n` but different review
  scores weigh differently, and an entry with no reported `n` is weighted as `n = 1`
- `n` and `reviewScore` survive normalization unchanged on `DoseNormalizedEntry`, and the
  weighted median computed over normalized entries equals the one computed over the source
  entries. A stratum whose entries have distinct `n` values must **not** produce the
  unweighted median — the assertion that catches a normalized shape which silently dropped
  the weighting inputs
- the point estimate is always a value some cohort reported, never an interpolated one, and a
  cohort holding more than half a stratum's total weight does determine it
- a stratum of two equally weighted cohorts yields the **lower** central value exactly, not
  their midpoint — the same tie semantics as the B/P case and as every other weighted median
  in the platform
- the headline interval is the min–max of those central values, and **no reported SD, CI or
  subject range is ever combined into it**
- a one-cohort stratum shows that cohort's own value and its own reported interval with its
  `intervalKind`, and reports no between-cohort spread
- the rendered label names the estimator and the cohort count, not only the stratum

### UI

- Cmax source dialog offers observed/normalized toggle
- non-Cmax parameters do not show the toggle
- each normalized row keeps its original dose visible
- ineligible rows explain why they were not normalized
- each row labels its reported statistic and interval kind rather than showing a bare bar
- multiple strata are labelled rather than collapsed

### Merge / provenance

- drug merge repoints `administeredDrugId` and `interactingDrugId` (release B, before any
  writer can populate them)
- a merge that makes `administeredDrugId` equal the entry's own drug produces the same
  canonical shape as a natively self-referencing entry, and the two dedupe against each other
- release A's delete removes a drug's owned entries by `drug_id` and succeeds against the
  **old** schema, before `administered_drug_id` exists
- an insert that omits every new column succeeds against the **release-B** schema, as the
  previous deployment's writer would issue it
- a drug merge run by **release-B** code repoints `administered_drug_id` and
  `interacting_drug_id` and then deletes the loser without tripping `ON DELETE RESTRICT` —
  the case an unfixed merge would fail
- deleting a drug that owns ordinary source entries still succeeds at every stage from
  release B onward
- deleting a drug referenced as the administered drug by *another* drug's entries is refused
  by `ON DELETE RESTRICT`, with an error naming the dependent evidence
- the same two cases for `interactingDrugId`
- deleting/merging a referenced administered drug cannot orphan evidence
- pending edits preserve and revalidate the structured fields
- a merge repoints `administeredDrugId` and `interactingDrugId` **inside** an active
  `param_entry` payload whose outer `target_id` is a different drug, and that proposal still
  approves cleanly afterwards
- deleting a drug named only inside such a nested payload leaves no stale reference behind,
  for both ids
- a proposal authored **concurrently** with a delete or merge of a drug it names never
  commits a stale id: it serializes behind the removal and is refused **by the existence
  re-read under its own locks**, or commits before the removal and is repointed by it
- the lock set is the sorted union of the **owning drug** and both nested ids: an edit
  targeting A and naming B, concurrent with a merge of B into A, does not deadlock for
  either ordering of A and B
- an **update/delete** proposal resolves its owning drug from the entry id before sorting —
  the same concurrency test, driven through an update proposal rather than a create, since
  that is the op whose `targetId` is not a drug id
- an approval issued by **release-B** code against a payload authored by release-C code
  parses and persists the complete shape, neither refusing it nor truncating it — including
  passing `validateEntryForParameter`, which requires the Cmax registry entry to be present
  in release B
- **release-B code refuses Cmax creation** through every generic producer — the direct write
  and the queued-proposal branch of `POST /api/parameter-entries` alike — even though the
  parameter is registered; and release C accepts the same request
- a `param_entry` proposal naming a drug that no longer exists is refused at approval, as
  the wiki paths already do
- `entryDuplicateExists` and the merge-side predicates treat two arms of one paper with
  equal Cmax but different dose, regimen, formulation, statistic or population as distinct;
  a merge deletes neither
- two rows made identical by a merge collide on the post-repointing comparison
- deep-research reconciliation considers dose context, so numerically identical Cmax values at different doses are not treated as duplicate observations

## Decisions this PR asks reviewers to challenge

Settled in review (round 1):

1. `administeredDrugId` carries an explicit self-FK with `ON DELETE RESTRICT` rather than
   encoding self-administration as null, because merges would otherwise leave two
   representations of one fact. (Round 8 scopes the *requirement* to dose-context
   parameters via a partial CHECK; it was never a blanket `NOT NULL`.)
2. A non-degenerate dose range is never normalization-eligible on a representative dose;
   exact-dose arms are split into separate entries instead.
3. Route is storable-optional but normalization-required. There is no null-route stratum.
4. Non-steady `multiple` dosing must carry `doseNumber` or `regimenDurationHours` to be
   poolable.
5. Cmax normalization requires a real matrix conversion and never falls back to a
   blood:plasma scalar of 1.
6. The reported statistic is stored explicitly (`centralStatistic`, `intervalKind`) rather
   than being forced into `median`/`low`/`high`.

Settled in review (round 2):

7. Dose magnitude, not just dose family, is a stratum dimension. Pooling across dose levels
   would assume the dose proportionality this RFC refuses to claim; widening a stratum needs
   a validated proportionality range that does not exist yet.
8. `doseValue` and a non-degenerate range are mutually exclusive stored shapes, so a
   representative dose has no column to be normalized from.
9. Formulation is structured context and a stratum dimension; IR and MR never pool.
   (Round 3 splits this into `releaseProfile` and `physicalForm`.)
10. IV input mode is explicit (`bolus` / `infusion` / `unknown`); an unresolved mode is
    normalization-ineligible rather than a null-duration stratum.
11. `'unknown'` statistics and formulations are raw-evidence-only and never form a stratum of
    their own.
12. Repeated dosing requires an explicit `priorDosingRegular` assertion; a loading dose,
    titration or missed dose makes dose number meaningless as an exposure key.

Settled in review (round 3):

13. Release profile and physical form are separate axes, so a modified-release suspension
    discards neither.
14. The normalized result exposes `normalizedCentralValue`, not `normalizedMedian`.
15. Every repeated-dose entry needs a positive dosing interval to be normalizable.
16. Prandial state is structured context and a stratum dimension for `oral` (see 51ag).

Settled in review (round 4):

17. Coadministration state is structured context; only monotherapy enters the first
    headline, and interaction arms stay visible as raw evidence.
18. A self-referencing `administeredDrugId` breaks drug deletion via the existing `drug_id`
    cascade, so the delete path is updated to remove owned entries explicitly, ahead of the
    migration.

Settled in review (round 5):

19. PK population is structured context; only healthy adults enter the first headline, and
    altered populations stay visible as labelled raw evidence.
20. The delete change ships as its own release, written against `drug_id` only so it is
    valid under both schemas; the migration follows in a later release, so no deploy window
    pairs a cascade-only delete with the restrictive FK.
21. A source-reported dose-normalized value is declared with `valueBasis`, passed through
    rather than divided, and never pooled with derived ratios.

Settled in review (round 6):

22. A column, the code that populates it, and the constraint that requires it are three
    releases, not one — writers break on a requirement constraint in a rolling deploy
    exactly as deletion broke on the FK.
23. A declared ratio carries whatever dose context the source states — exact, range or
    none — since `valueBasis`, not the absence of a dose, is what suppresses division.
24. The dose dimension is a stratum descriptor (exact / range / unstated), never a scalar,
    so a variable-dose declared ratio needs no invented canonical dose.

Settled in review (round 7):

25. Dose-context requirements are stated per `valueBasis` rather than once unconditionally,
    in the CHECK constraints and the API validation alike.
26. A declared ratio's unit denominator family must agree with its `doseUnit`.

Settled in review (round 8):

27. "Passed through" means the division is skipped, not the unit conversion.
28. A `normalizationRequires` entry names a dimension; what resolves it is the parameter's
    own contract, not a null check on a column.
29. Write paths are threaded before the constraint, and after every handler. (Round 11
    splits this into four releases: handlers, then producers, then the requirement.)
30. `administeredDrugId` is required per-parameter via a partial CHECK, not a blanket
    `NOT NULL` with a whole-table backfill, because self-referencing every legacy row would
    fabricate administration provenance for metabolite entries the repository already holds.

Settled in review (round 9):

31. The nullable FKs ship with their columns, not after: a nullable FK is compatible with
    code that supplies no value, and deferring it opens a window in which a reference can be
    created and orphaned, which a later FK creation could not then constrain.
32. No step of the rollout backfills or applies a blanket `NOT NULL`. Where an earlier
    revision said otherwise, it was stale text, not an alternative plan.

Settled in review (round 10):

33. Rules that depend on `valueBasis` are stated once, in the eligibility table under
    **Validation invariants**. Other sections describe stored shapes and defer to it rather
    than restating eligibility.

Settled in review (round 11):

34. Dose basis (salt / free-base / parent / active-moiety) is stored context, a pooling-key
    dimension and never inferred — the repository already forbids inferring it in
    `kinetics-core`.
35. Normalizable and poolable are separate questions. A declared ratio with no stated dose
    is normalizable but never poolable (`unstated_dose_level`), since two such rows may come
    from 1 mg and 100 mg cohorts.
36. Salt basis needs the specific salt form to be poolable: `'salt'` records that a salt
    mass was reported, not which salt, and salt factors differ. Without `doseSaltForm` the
    entry is normalizable but never poolable.
37. `'unstated'` matches nothing, including another `'unstated'`, and the normalizer reports
    `poolable` separately so a successful normalization is never read as permission to pool.

Settled in review (round 13):

39. The normalization outcome is a discriminated union, so `{ no value, poolable }` is
    unrepresentable and every non-poolable case carries a reason.
40. Infusion strata match on exactly equal canonical duration. "Comparable" was not a rule.
41. Every duplicate-identity predicate — store, importers, merge — compares the complete
    entry shape, and the merge-side comparison runs after FK repointing.
42. Serialization and the read-side entry model are handlers, not read-side polish, and ship
    in release B before any producer.
43. Merge repointing covers drug ids nested inside active pending-edit payloads, which the
    outer `target_id` retargeting does not reach.

Settled in review (round 14):

44. A blood:plasma ratio converts only among serum, plasma and whole blood. Urine, vitreous,
    hair and `other` are `unsupported_matrix_conversion`, never ratio-converted.
45. The `median` shorthand is canonicalized to `centralValue` + `centralStatistic` on write
    for Cmax, so one reported median has exactly one stored shape and cannot evade the
    duplicate check.
46. The delete path, like merge, must inspect drug ids nested inside active pending payloads;
    the payload JSON carries no FK, so nothing else catches them.

Settled in review (round 15):

47. `route: 'other'` is not a resolved route. It is `unresolved_route` — storable and
    visible, never normalized or pooled — because the catch-all can cover administrations
    with no reason to agree.
48. Both nested-payload handlers, merge **and** delete, are named in the release-B list.
    Naming only one there is what let the delete gap reappear after it was fixed elsewhere.

Settled in review (round 16):

49. Scanning pending payloads does not close the author-vs-removal race — a proposal can
    commit after the scan. Writers, delete and merge all take advisory locks on every
    referenced drug, in the ascending-id order `drugAdvisoryLockIdsForEdit` already
    establishes for wiki content, plus a last-stop refusal at approval. The existing wiki
    mechanism is extended to `param_entry` rather than a second scheme invented.

Settled in review (round 17):

50. The lock set is the **union** of the outer target and the nested ids, sorted once.
    Leaving the outer target's separately-acquired lock outside the sort reintroduces the
    ABBA deadlock the ordering exists to prevent.
51a. The owning drug is resolved per operation before the union is formed: `targetId` is a
    drug id for a create and an *entry* id for update/delete, so using it directly would lock
    the wrong number and leave the real owner unlocked.
51b. Approval is a handler as well as a producer. Its parsing and persistence ship in
    release B; only proposal authoring is gated to release C.
51c. The registry contract ships in release B with the handlers, not with the writers. An
    unregistered parameter is refused before any handler sees its fields, so a handler
    without it cannot accept what it was predeployed to accept.
51f. The canonical target matrix for Cmax normalization is **plasma**, named once, carried
    on the result as `normalizedMatrix` and present in the pooling key. It deliberately
    differs from `aggregateEntries`' whole-blood convention; recorded so the divergence is
    not "fixed" by a silent switch of target.
51g. **Required to store is not required to normalize.** A field is required at write only
    when its absence makes the row ambiguous or meaningless — `valueBasis` and the dose
    shape invariants. Every other context field a source may omit stores as `'unknown'` or
    null and is refused at normalization with a named reason. Saying a field is both
    required and productive of an `'unknown'` ineligibility makes that ineligibility
    unreachable and discards evidence this design exists to keep.
51i. The headline estimator is named, not left to the implementer: the weighted median of
    per-entry normalized central values under `entryWeight` (sample size scaled by review
    score, reused rather than restated), interval = observed min–max of those
    values labelled as between-cohort spread, reported per-entry intervals never combined,
    and the rendered label states the estimator. Inverse-variance pooling is out of scope —
    it needs a per-entry variance many Cmax reports do not publish.
51j. Serum and plasma are one frame (`PLASMA_LIKE_MATRICES`), so serum → plasma is identity
    and the B/P ratio is consulted only for a blood ↔ plasma crossing. Convertibility is
    decided by `matrixDisplay`'s predicates rather than a list restated here, which would
    diverge from the repository's contract.
51k. The median shorthand may not contradict an explicit `centralStatistic`. Comparing only
    the values missed the case where the two fields disagree in kind.
51l. Identity is same-side, stated once. Adding the serum/plasma rule left an older
    exact-equality bullet standing above it; a rule contradicted a few lines earlier is a
    rule an implementer will read the wrong way round.
51m. The headline weight is `entryWeight` itself, not a restatement of it. Review score
    participates, an absent `n` counts as `n = 1` rather than as weight 1, and a cohort
    holding over half a stratum's weight *does* decide the point estimate — the earlier
    non-dominance claim was false of a weighted median and is withdrawn rather than
    reconciled.
51aq. The stale bounds-without-`intervalKind` path is gone, in the section-1a rule and in
    the schema test that repeated it. Two contracts said opposite things about the same
    payload — rejected at write versus stored as `'unknown'` — and either stale statement
    preserved the unlabelled interval the two-way rule removed. The `'unknown'` reading
    survives only for legacy non-Cmax rows.
51ar. `'ci95'` endpoints are arithmetic, not observed, so the registry bound applies to the
    centre only — `1 ng/mL (95% CI −1–3)` is an ordinary report. The split is not
    interval-versus-point but **calculated versus exhibited**: `'sd'`, `'sem'`, `'ci95'` on
    one side, `'range'`, `'iqr'`, `'unknown'` on the other. `'ci95'` keeps containment but
    not symmetry, since a CI on a geometric mean is legitimately asymmetric.
51as. The `normalized_not_poolable` summary names all four reasons. Listing two read as
    exhaustive and would have sent censored and bounds-only rows down the ineligible path,
    suppressing exactly the evidence the variant exists to display.
51ao. `intervalKind` and the bounds imply each other. Requiring a kind *when bounds exist*
    left `{ centralValue, centralStatistic, intervalKind: 'sd' }` with no dispersion at all,
    passing the centre and symmetry checks vacuously and displaying an SD interval nobody
    reported. Both halves are now required together.
51ap. The normalized `centralStatistic` is null in **two** cases, not one: no central value,
    or a censored threshold. The comment claiming the first was the only one became false
    when the censored rule landed, and would have pushed an implementer to invent a
    statistic for a threshold to satisfy the type.
51an. For `'sd'` and `'sem'` the registry bounds apply to `centralValue` only. `low` is
    `centre − dispersion`, so an ordinary `1 ± 2 ng/mL` encodes `-1` and was rejected as a
    negative concentration — discarding a correctly recorded cohort. Non-negative dispersion
    and symmetry pin the interval instead. Every other interval kind keeps the bound on both
    endpoints, because there they are measurements rather than arithmetic.
51am. A censored threshold may not carry an `intervalKind` either. "Not required" is not
    "forbidden": `{ centralValue: 5, qualifier: '<', intervalKind: 'sd' }` satisfied every
    invariant — centre present, bounds not disagreeing, symmetry vacuous — and would have
    displayed an SD label on `< 5`. Both statistic and interval kind are now rejected
    alongside a qualifier, which is the shape the round-32 rule should have had.
51al. `'sd'` and `'sem'` bounds must also be **symmetric** about the centre. Containment
    accepted `{ 5, low 4, high 9 }`, which no single SD produces, and the row would have
    been labelled `centre ± SD` anyway. Symmetry is what makes that label true. Kept
    `low`/`high` plus an invariant rather than adding a magnitude column, which would be a
    second representation to keep in sync across four releases.
51ak. `'sd'` and `'sem'` bounds require a `centralValue` at write. They are dispersion
    around a centre, so without it they are two numbers whose meaning was discarded, and
    the bounds-only path would have rendered an SD interval with an unknown centre. The
    document already claimed the centre "must therefore already be present" — an assumption
    stated as a fact, enforced by nothing.
51aj. `prandialState` is nullable on the normalized entry. The six vacuous routes had no
    representable value: `'unspecified'` is precisely what makes an `oral` entry
    ineligible, so an eligible IV row could only be built by inventing it or bypassing the
    type. Null means the question does not apply and pools freely — the opposite of an
    `'unstated'` dose, which means unknown and pools with nothing.
51ah. `physicalForm` names the dosage form only. `'parenteral'` overlapped `'solution'` and
    `'suspension'` on an exact pooling-key dimension, so identical IV cohorts could split on
    a curator's choice while an IM solution and a depot suspension pooled as one — both
    failures at once. Route class lives in `route`.
51ai. The exhaustive route sets replaced "enteral"/"parenteral" in the canonical context
    profile, the pooling key, the normalized-entry comment and the summary list. Fixing the
    rule and leaving five restatements standing is the recurring defect of this document;
    the audit has to be for the *concept*, not the words the fix happened to use.
51ag. Route-conditional requirements are exhaustive lists, not descriptions. "Enteral
    routes" and "where material" left `sublingual`, `rectal`, `im`, `intranasal` and
    `inhalation` classifiable either way, and `ROUTE_IDS` has no classifier to appeal to.
    `prandialState` is required on `oral` only, `ivInputMode` on `iv` only, and every
    `RouteId` is tested so a new route fails a test rather than defaulting.
51af. The weighted-median tie is broken downward by reusing `weightedPercentile`, which is
    exported for the purpose. "Weighted median" admits three answers when cumulative weight
    lands on 50% — lower, upper, midpoint — and the midpoint is excluded by this document's
    own anti-interpolation rule. Tests assert the number, not determinism.
51ae. `DoseNormalizedEntry` carries `n` and `reviewScore`. `PoolableEntry` is the only shape
    the estimator sees and it did not carry the two fields `entryWeight` reads, so the
    specified weighting was unimplementable — and the silent failure is the dangerous one:
    every cohort defaults to n = 1, score 0, and the headline becomes an unweighted median
    still labelled a weighted one. The inputs travel, not a precomputed weight, so
    `entryWeight` stays the single definition.
51ad. A censored threshold carries no statistic either. Requiring one made the
    `censored_value` outcome unreachable: `centralValue` demanded a label the paper does not
    supply, `median` asserted a reported median, and a lone bound tripped the `intervalKind`
    rule. `{ centralValue: 5, qualifier: '<' }` with no statistic is the stored shape, and
    supplying a statistic or using the `median` shorthand with a qualifier is rejected.
51x. `centralStatistic` is required only when a central value exists. Requiring it always
    made the bounds-only branch — added two rounds earlier and promised a displayed
    normalized value — reachable only by inventing a statistic for a value that is not
    there. `PoolableEntry` requires the value and its label together.
51ab. The conversion divides: `plasma = blood / r`. The document required a ratio and never
    named the arithmetic, while the nearest codebase example normalizes the other way — an
    implementer copying it would have been off by `r²`. Defer to `convertToDisplayMatrix`,
    and assert the number rather than the eligibility.
51ac. Ratio candidates must be finite and positive before the estimator runs. The registry
    allows a zero, and a weighted zero left in the set drags the median to zero, which the
    invalid-ratio rule then reads as no ratio at all — one bad row discarding good evidence.
    Excluded, not invalidating.
51z. A censored ratio entry is not a ratio. `{ median: 0.8, qualifier: '<' }` passes the
    reported-central-value test and is a threshold, so it gets the round-26 treatment one
    level down: `censored_matrix_ratio`, no conversion.
51aa. Several eligible ratio entries resolve by the `entryWeight`-weighted median — the
    same estimator as the headline, not a second one. Filtering candidates without naming
    an estimator is the round-23 defect relocated into the conversion factor.
51y. `derivedFromEntries` is not proof that a cached ratio was reported.
    `summaryToNumericRange` publishes the weighted median of `entryRepresentative`, which
    midpoints a bounds-only entry, so the provenance check admitted the very midpoint the
    rule below it forbids. The normalizer reads the B/P **entries**, requires a reported
    central value on one of them, and never reads the cached scalar.
51u. Storing, normalizing and pooling are three gates, and the requirements table now has
    three columns. One "normalization" column made bounds-only, censored and
    unspecified-salt entries read as wholly ineligible, suppressing normalized evidence the
    outcome contract says to display.
51v. A blood:plasma ratio must be source-backed, not just numerically shaped. The catalog
    carries hand-authored scalars that say outright they are estimates; using one publishes
    a plasma headline built on a number nobody measured. `unsourced_matrix_ratio`, keyed on
    `derivedFromEntries`, never on the note prose.
51w. Stratum selection is deterministic: one eligible stratum shows its headline, more than
    one shows "multiple administration contexts". "The dominant/default clinically
    meaningful stratum" defined neither word and let two implementations publish different
    Cmax headlines from identical evidence. Clinical ranking is a later feature with its own
    total order, tie-break and review.
51s. `single_subject` may not carry a cohort `n`. The statistic and the weight contradicted
    each other with nothing to stop them, and `n: 400` on a one-participant report would
    have carried enough weight to decide a stratum's headline by itself.
51t. A null or `'unknown'` `doseRegimen` is `unknown_dose_regimen`. Every other context
    dimension had its own named reason; the commonest case — a paper that does not state
    the regimen — had none, leaving the normalizer to admit it or invent one.
51q. A censored Cmax (`qualifier: '<'`) is normalized, displayed with its operator, and
    never pooled. The document never mentioned `qualifier`, so a threshold would have
    entered the headline as an observation *and* lost its operator on screen.
51r. `centralValue` joins every enumeration of the value-carrying fields — the registry
    bounds loop, the qualifier agreement check, the containment check. A new value column
    added outside those loops is a column the bounds do not cover, which is the same leak
    as a context column missing from a duplicate-identity predicate.
51o. A poolable entry must carry a finite normalized central value. The discriminated union
    made the *outcome* honest but still handed the poolable branch an entry whose central
    value was optional, so a bounds-only payload could reach a weighted median with nothing
    to weigh. `PoolableEntry` requires it; bounds-only normalizes, displays, and stays out
    of the headline as `missing_central_value`, with no midpoint substituted.
51p. Same-side identity now holds in the aggregation rule and the test list too. Fixing the
    two places the review cited left two more restating "the matrices already match" — the
    rule is cross-referenced from those places now rather than repeated.
51n. The shared entry write path is named in release B only. Leaving it also listed among
    release C's writers let the release-B fix be satisfied on paper while the truncation it
    prevents stayed reachable.
51h. `doseLow` and `doseHigh` are both null or both present. A half-open dose matches none
    of the exact / range / unstated shapes and is not evidence of a dose.
51e. A blood:plasma ratio must be a reported scalar. A bounds-only `NumericRange` is
    `bounds_only_matrix_ratio`, never midpointed — the rule against inventing a dose midpoint
    applies equally to inventing a conversion factor. Interval propagation into a normalized
    range is the better answer and is out of scope, since every consumer of the normalized
    value assumes a point estimate.
51d. Registration is **not** inert — the generic entry endpoint admits whatever the registry
    recognises, so registering the parameter is itself an authoring gate. Release B pairs the
    registry entry with an explicit refusal of Cmax creation on every generic producer,
    lifted in release C. "Legal to accept" and "legal to create" are separable only because
    that gate is written down.

    The general form, which the last three rounds have each been an instance of: **a handler
    needs everything required to *accept* the payload, not merely to parse it** — the
    registry entry that makes the parameter legal, the schema that admits the fields, and the
    existence checks that validate its references.
51. An advisory lock proves ordering, not existence — it is taken on a number, not a row. The
    writer re-selects every referenced drug under its locks and refuses if one is gone,
    as `drug-merge.ts` already pairs its advisory locks with `SELECT … FOR UPDATE`. The
    approval-time refusal is defence in depth behind that, not a substitute for it.
38. Code that must handle a column's values ships before any code that can create them:
    handlers (delete path, merge repointing), then producers (writers), then the requirement
    (CHECK). Shipping a handler alongside its producer fails, because a rolling deploy runs
    the old handler against the new producer's rows.

### A note on reading this document

Rounds 6-10 of review found, repeatedly, that a rule corrected in one section was left
standing in another — and since each statement here reads as a complete instruction, an
implementer following the stale one lands the defect the correction removed. Two conventions
follow from that, and they bind future edits:

1. **Each rule has one home.** Dose-context eligibility lives in the eligibility table;
   release sequencing lives in the migration section; the required context dimensions live
   in the context profile. Everywhere else refers to them rather than restating them.
2. **Where this document contradicts itself, the "settled in review" list wins**, and the
   contradicting text is a defect to be reported, not a choice to be made.

Still open for review:

1. Should Cmax dose be required immediately, or should imported historical Cmax be allowed
   with `doseContext: incomplete`?
2. Should the first headline summary be restricted to single-dose observations, leaving
   steady-state only in the source view until a richer stratified UI exists?
3. Is a generic `entryBacked` registry flag worth adding now, or should Cmax use a narrower
   dedicated entry-backed list until another parameter needs the distinction?
4. Should `centralStatistic`/`intervalKind` be backfilled for existing non-Cmax entries, or
   left null as the legacy reading indefinitely?
5. Are the deliberate lumps in **Known limits of the context profile** — `'modified'` release
   and `'fed'` — acceptable for the first implementation, or should either be split before
   any data is curated?

Questions the earlier drafts left here about IV input representation and `doseValue`/range
coexistence are gone: sections 5 and 3 now settle both, and leaving them open would have
made this list contradict the contract above.

The implementation should be adjusted based on review of these points before data is curated
into the new shape.
