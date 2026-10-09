# Postmortem concentration distributions

## What this is

A **cohort distribution** is one laboratory's order statistics for one analyte
in one matrix: N cases, an LOQ, a mean, a median, and the upper percentiles.
The first cohort Kinetix carries is unpublished conference material — a few
hundred drugs and metabolites measured in postmortem femoral venous blood —
under a source heading stating that the data have no link to cause of death.

That heading is the design constraint for everything below. The material is
**not linked to cause of death**. A 97.5th percentile says how often a
concentration turns up in autopsy material; it does not say that concentration
killed anyone.

## Why it is not a `parameter_entries` pool

Every summarizable parameter in `DRUG_PARAMETERS` pools per-paper values into a
weighted median + IQR (see the "Multi-value parameter entries" row in
AGENTS.md). That is the right shape for "what does the literature say this
drug's half-life is". It is the wrong shape here, twice:

1. **A distribution is one object.** Median, p90, p95 and p97.5 all describe the
   same set of cases for one analyte. Averaging this cohort's 97.5th percentile against
   another cohort's would produce a number neither cohort measured.
2. **There is no parameter it could pool into.** The closest candidate is
   `fatalConcentration`, and writing to it would publish a claim the source
   explicitly disclaims.

So the cohort is stored, cited and displayed whole, in its own tables, and the
seeder cannot reach the interpretive concentrations even by mistake.

The source's own `TC in plasma` column and its `median(PM)/TC` ratio are carried
**inside** the cohort row for the same reason. They are shown beside the
percentiles because the ratio is meaningless without them, and they never touch
Kinetix's entry-backed `therapeuticConcentration`, which is built from reviewed
per-paper source values.

## Where things live

| Piece | Path |
| --- | --- |
| Transcribed dataset | **Not in the repository.** The first cohort is unpublished; its JSON file is kept outside the repo and passed to the seeder with `--file <path>` |
| Format example (synthetic) | `tests/fixtures/pm-concentrations-synthetic.json` — invented rows, used by `tests/pm-concentrations-dataset.test.ts` |
| Loader + validation | `scripts/pm-concentrations/dataset.ts` |
| Seeder | `scripts/seed-pm-concentrations.ts` (`npm run seed:pm-concentrations`) |
| Tables | `pm_concentration_sources`, `pm_concentration_distributions` (migration `0100`) |
| API | `api/pm-concentrations.ts` (`GET ?drugIds=` / `?cids=`) |
| Domain layer (conversion, line building) | `src/lib/pmConcentrations.ts` |
| Client + cache | `src/lib/pmConcentrationsApi.ts`, `src/lib/usePmOverlay.ts` |
| Chart controls | `src/components/simulator/PmReferenceLineControls.tsx` |
| Numeric table | `src/components/wiki/DrugPmConcentrations.tsx` |

## Access

The gate is enforced in three places, because each covers a hole the others
leave:

- **The route** (`canAccessPmConcentrations`) — the only one that matters for a
  direct URL.
- **The client hook and monograph component** — a session that *loses* access
  mid-visit keeps rendering what it already holds otherwise; the auth store
  updates in place in this SPA, so nothing else prompts a re-read. Both bind the
  fetched payload to the context that produced it (identity + capability for the
  hook, drug id for the table) and return it only while the two still match.
  Clearing in an effect is a paint too late: React commits the render the store
  update triggered before the effect runs, and that frame would draw the
  previous account's lines.
- **The client cache key** — it is scoped to the signed-in user id. Signing out
  and back in as somebody else never reloads the module, so a cache keyed on
  drug ids alone would serve one account's unpublished payload to the next for
  the rest of the TTL, with no request the server could refuse. Entries from a
  previous identity are also dropped outright rather than merely left
  unreachable, so signing back in re-reads the server instead of resurrecting a
  stale answer.

Gated to admins and granted groups, via the `pmConcentrations.read`
capability (`canAccessPmConcentrations`). The capability's `floorTier` is
`authenticated`, so no admin configuration can put unpublished forensic material
in front of anonymous visitors. An ungated caller gets
`{ sources: [], distributions: [], gated: true }` with HTTP 200 — the same shape
`GET /api/methods` uses, so a monograph page missing this section renders
normally instead of surfacing an error.

## Transcription rules

The dataset file is the reviewable artifact; the loader enforces what can be
checked mechanically. The file for the first cohort is kept outside this
repository because the material is unpublished; there is no default path, and
every loader and seeder call takes the path explicitly.

**The percentile ladder must not run backwards** (`median ≤ p90 ≤ p95 ≤ p97.5`).
This is the only automatic check that catches a mistyped digit in hundreds of
rows nobody will read twice, so a violation is an error, not a warning.

**Printed defects are transcribed, not corrected.** A source table can violate
its own internal consistency. The two kinds seen so far:

- A **percentile printed out of order** — a 90th percentile above the row's own
  95th and 97.5th, almost certainly a misplaced decimal point.
- A **statistic printed as zero** — a mean of 0.00 mg/L beside a non-zero
  median, a real reading rounded to the table's two decimals.

Such a row keeps the printed value, carries an `anomaly` note in Norwegian, and
names the affected statistic in `undrawable`. The table shows the number with
an asterisk and the note; the chart refuses to draw it. Silently fixing
published data is not ours to do, and drawing a line several times too high is
worse than drawing none. The synthetic fixture has one row of each kind.

**Printed precision is preserved.** A float cannot carry a trailing zero, and a
percentile printed `0.20` is not the same statement as `0.2` — in this field
that is a statement about significant figures, and these numbers get quoted.
Rows carry a `printed` map for the values where the two differ; the table takes
the digits from it and the decimal separator from the reader's locale. The loader checks every printed string parses back to
the number it decorates, so the two cannot drift apart.

**Storage identifiers never reach the reader.** `source.matrix` is
`postmortem_femoral_blood`; the table renders it through
`pmConcentrations.matrixName.*`, falling back to the raw identifier for an
unknown matrix — visibly unfinished beats absent.

**Analyte mapping is by PubChem CID**, recorded together with PubChem's own
Title so the mapping is auditable in review without a network call. For the
first cohort, every analyte that already existed in the catalog matched the CID
the catalog itself holds. Rows whose intended analyte is genuinely debatable carry a `reviewNote` that the seeder prints and the UI shows.

## Unit and matrix

Stored figures are **mg/L in postmortem femoral whole blood**, exactly as
published. Nothing is pre-converted:

- **Unit** conversion depends on the reader's display preference.
- **Matrix** conversion depends on the drug's blood:plasma ratio, which is an
  entry-backed value that changes as sources are added.

Baking either into the stored row would freeze a derived number next to the
published one it came from. `convertPmValue` does both at render time, and
returns `null` rather than an approximation when the conversion is undefined — a
molar target unit with no molecular weight, or plasma mode with no B/P ratio.

The B/P ratio is read with `meanRange`, not `representativeValue`: a large part
of the catalog states this parameter as bounds alone (diazepam 0.51–0.59, the
alcohols 0.84–0.92), and reading those as "no ratio" reported the conversion
unavailable for drugs that plainly have one. It still returns `null` rather than
falling back to 1 when there is genuinely nothing — a factor of 1 would not be
"no conversion", it would relabel a whole-blood figure as plasma.

Conversion respects the COHORT's matrix, not just the reader's request. A
whole-blood cohort divides by B/P; a cohort already stored in plasma or serum
passes through untouched; an unrecognised matrix declines. Only the first case
exists today, but the schema accepts any matrix string and the documented growth
path is "add another cohort" — dividing a plasma cohort again would plot it at a
height nobody measured.

Plasma conversion is **opt-in**. The default draws the number as published.
When a reader turns it on and a substance has no B/P ratio, the control panel
names that substance: a missing line is invisible, and silence would read as
"no data" rather than "no ratio". That message tests the ratio itself
(`pmHasUsableBloodPlasmaRatio`) rather than inferring it from a failed
conversion — `convertPmValue` also returns `null` for a molar axis with no
molecular weight or a statistic the row lacks, and naming the wrong absent datum
sends the reader to fill in a value that was never the problem. A converted line also says so in its own
label: the matrix choice persists across sessions, so the next visit would
otherwise open with B/P-derived values drawn, the controls collapsed, and
nothing on the plot separating them from published figures. Both the label and
the panel's conversion note are conditioned on a transformation having actually
happened (`pmConversionApplies`) — a cohort already in plasma passes through, and
calling its percentiles derived would be the same misdescription pointed the
other way.

## Chart behaviour

- Median and the 90th percentile are drawn by default; all six statistics are
  toggleable. The choice is a **per-user** preference persisted in
  `kinetix.settings` (app store v3), not per-case state. It is discarded when a
  *different* account signs in, via the identity-change subscribe in
  `authStore.ts` that already resets the basket and simulator — on a shared
  browser the next reader would otherwise open on someone else's percentiles.
  The subscribe's `completedInitialBootstrap` guard is what keeps a restored
  session (null → user on page load) from counting as an account switch, so the
  preference still survives between sessions for the person who set it.
- A drug's lines live on that drug's y-axis in that drug's colour, and hide with
  its curve — the same rules the therapeutic/toxic/lethal lines follow.
- Percentile lines follow the same y-fit policy as the toxic threshold: they
  join the fit when within `RANGE_INCLUDE_MULTIPLE` of the panel peak, and are
  left out beyond it. This matters more than it looks. A linear y-axis is
  hard-set to `[0, yMax]` and `yMax` counts only the lines that opted in, so a
  line left out of the fit is **clipped**, not merely un-accommodated. Excluding
  every percentile (the first cut of this feature) would have made the default
  median/p90 overlay silently absent exactly when it sits above the curve;
  including every percentile would let a 97.5th percentile a hundredfold above a
  therapeutic-dose curve flatten it. The controls state that anything beyond the
  cut-off needs the log axis, where nothing is clipped. The ceiling is computed
  per SERIES, not per panel: with two same-unit drugs overlaid each gets its own
  y-axis, so judging a line against the panel's largest peak would let a
  high-concentration drug vouch for a line that then flattens a
  low-concentration drug's curve.
- Nothing is drawn in normalized mode: a percentile in mg/L means nothing
  against `C / C_peak`.
- The expanded controls carry everything that qualifies a line: the source's own
  caveats, its citation, and a named warning for any substance whose analyte
  mapping is still unconfirmed. A reader working from the chart never opens the
  monograph, so a qualification that exists only there does not exist.

## Rollout

**Deploying this code does not make the feature visible.** `vercel.json`'s build
command runs the migrations, so a release creates `pm_concentration_sources` and
`pm_concentration_distributions` — empty. Nothing in the deploy path seeds them,
the API then returns no distributions, and every surface renders as though the
drug simply has no postmortem data. The first cohort is a deliberate operator
step, taken once, after the deploy:

The dataset file is not in the repository, so every run names it explicitly;
the seeder exits with an error if `--file` is missing.

```bash
# 1. Validate the dataset without a database (no DATABASE_URL needed).
npm run seed:pm-concentrations -- --file /path/to/dataset.json --dry-run

# 2. Seed against production. Creates any missing substances; prints each one.
DATABASE_URL=… npm run seed:pm-concentrations -- --file /path/to/dataset.json --user-email <operator>
```

Seeding is deliberately **not** wired into the build. On a first run it writes
dozens of new substances into the catalog, which is a decision an operator makes with their
eyes open, not a side effect of shipping a frontend change — and a build-time
mutation that fails leaves a half-seeded cohort behind while the deploy carries
on. Run it after the migration has landed, never before: the seeder needs the
tables the migration creates.

Afterwards:

1. Read the creation report and add Norwegian names for the substances it made
   (it prints every one — see "Substances the seeder creates" below).
2. Confirm the `reviewNote` analyte mappings the seeder prints.
3. Check the feature is live: open a seeded drug's monograph as an admin or
   granted-group member and compare its row (N, median, percentiles) with the
   source table. Nothing appears for anyone else, by design.

## Adding another cohort

1. Transcribe it to a JSON file in the dataset format (see the synthetic
   fixture `tests/fixtures/pm-concentrations-synthetic.json`) with a new
   `source.key`, resolving each analyte to a PubChem CID. An unpublished cohort
   stays outside the repository; a published one may be committed under
   `resources/`, where the CID seed-source scanner will also see it.
2. `npm run seed:pm-concentrations -- --file <path> --dry-run` to validate.
3. Seed it. Nothing about the first cohort changes; the tables are source-keyed
   and the seeder is additive across cohorts and idempotent within one.

## Consistency

A cohort is one unit of meaning, and both the write and the read are built to
keep it that way:

- **The seeder commits the whole cohort in one transaction** — source row, every
  distribution, and the reconciliation. `unit` and `matrix` live on the source
  and are what the client converts *by*, so a run that updated the metadata and
  then failed would leave the API serving old numeric rows interpreted under a
  new unit: a misconverted forensic value with nothing to show it was wrong.
  The cost is one long transaction on a full re-seed, which is the right trade
  for an operator-run script. `createDrug` uses `inTransaction` (which joins the
  caller's) rather than `runInPoolTransaction` — nesting the latter opens a
  second connection that commits independently of the outer rollback and
  deadlocks against its advisory lock (see `api/_lib/db.ts`).
- **The API reads numbers and cohort metadata in one statement.** They were two
  selects at first; a re-seed committing between them could pair pre-update
  numbers with a post-update unit. The join repeats the source row per
  distribution and the handler deduplicates.

## Two claims, two column groups

The monograph table renders the postmortem statistics and the source's
therapeutic plasma concentration under separate `colgroup` headers. This is not
decoration: they are claims about two different populations, and flat in one
header row the TC cell reads as one more statistic from the autopsy cohort —
the exact misreading the whole feature is built to prevent. `median(PM)/TC` sits
with TC, since it is meaningless without it.

Where several cohorts cover one drug, the section heading goes generic and each
table states its own — taking `rows[0]` would file the second cohort's numbers
under the first cohort's qualification, and which one won would be query row
order. The chart controls follow the same rule.

## Correcting an analyte mapping

Row identity in the database is **(source, drug)**, not (source, analyte). So
changing a row's `pubchemCid` — which the `reviewNote` rows exist to invite —
upserts against the *new* drug and leaves the old row untouched, and the API
then serves that distribution for both the corrected substance and the wrong
one. The write path cannot notice: it only ever looks at the drugs the dataset
names.

The seeder therefore reconciles at the end of every run, reporting rows the
dataset no longer claims. `--prune` deletes them. It is not the default because
a partial run (`--no-create-drugs`, a hand-trimmed file) legitimately names
fewer drugs than the cohort holds, and deleting the remainder on that basis
would be worse than leaving a stale row visible for a human.

When more than one cohort covers the same drug, the chart currently picks one
deterministically by source key. Showing several at once needs a UI decision
that has not been made — the API already returns them all.

## A merged substance takes its distribution with it

`drug_id` is `ON DELETE CASCADE`. Merging a duplicate substance away — ordinary
catalog curation, done from a different screen by someone who has never heard of
this cohort — therefore deletes that substance's distribution row too. This is
not hypothetical: it happened during the first production seed. The dataset had
Ephedrine at CID 9294 (the (1R,2S) stereoisomer), the catalog also held CID 5032
(`DL-Ephedrine`, the racemate) as `Efedrin`, and the pair was merged onto 5032
while the seed was landing. The cohort's Ephedrine row went with the deleted
duplicate. The dataset now points at 5032.

Nothing about that was visible. The cohort was one row short and every surface
rendered correctly — Ephedrine simply looked like a substance the source never
measured, which is exactly what 100+ substances in this catalog genuinely are.
The seeder's counters could not see it either: they count *writes*, and the
write succeeded. So the seeder now counts *rows*, lists any analyte that has
none, and exits non-zero. The reconciliation above looks the other way round —
stored rows the dataset no longer claims — and the other way round is not the
direction that fails quietly.

That count is taken **after the transaction commits**, and re-read rather than
derived from what the write loop believes it wrote. This is the whole point of
it. A deletion that starts while the seed is running neither fails nor waits
forever: it blocks on the foreign key until the seeding transaction commits, and
then proceeds. Inside the transaction the row is therefore *always* present and
an in-transaction check *always* passes — moments before the row is removed.
Checking in the transaction would have missed the one incident the check exists
for. Reading after the commit is not airtight either; nothing short of locking
`drugs` would be, and a seeder has no business doing that. It puts the read on
the right side of the event.

Two things this does **not** catch, both worth knowing:

- If the merged-away substance is gone entirely and the dataset still names its
  CID, the seeder does not report a gap — it **creates a replacement substance**
  and writes the row there, resurrecting the duplicate a curator just merged
  away. Repointing the dataset is what prevents this, not the completeness check.
- A drug deleted after the post-commit read is invisible until the next run.

## Merging a substance touches four places, not one

`data/components.ts` and the other CID-keyed seed inputs identify substances by
PubChem CID, so merging two drug rows in the database leaves them pointing at a
CID that no longer exists. `seed-drugs` would then recreate it and re-split the
substance, and `catalog:check` reports it as drift.

Editing the fixtures alone is not enough either, and fails harder than leaving
them stale. `seed-drugs` slugs from `nameEn` and its upsert arbitrates on
`drugs.pubchem_cid` alone, so on a database still holding the old CID an insert
of the new one finds no CID conflict, `ON CONFLICT` never fires, and the
separate unique index on `drugs.slug` raises instead — taking down the whole
seed transaction. A database that already holds *both* rows is fine, because there the arbiter
matches and the update never touches `slug`.

So a merge is four places:

1. **The database** — merge the rows, repointing analytical-method components
   (maintained in the database only) and anything else that references the
   loser.
2. **`data/components.ts`** — the catalog entry.
3. **Every other CID-keyed seed input** — `data/substanceClasses.ts`, any
   `resources/*.json` dataset (`scripts/pubchem/seed-sources.ts` finds these),
   and any dataset kept outside the repository, such as this cohort's file,
   which no repo scan can see and has to be checked by hand.
4. **A migration** — so every other database follows. `0103_efedrin_racemate_cid`
   is the model: an `UPDATE` of the existing row's `pubchem_cid`, guarded by a
   `NOT EXISTS` for the both-rows case, deliberately *not* a merge. The row
   keeps its id, so all 16 tables referencing `drugs.id` stay attached and only
   the identity changes.

   The monograph link is the exception that has to move with it.
   `wiki_pages.drug_cid` is mixed-vintage — `ensureDrugMonograph` writes
   `drugs.id`, the older `scripts/seed-drug-monographs.ts` wrote the PubChem
   CID, and both readers resolve either — so a legacy row points at the old CID
   and changing the drug's identity alone strands it: the monograph detaches
   silently and the next backfill creates a second, empty one beside the written
   page. The migration repoints it in the same statement, via a data-modifying
   CTE so it binds to the row the update actually touched, and skips a
   `drug_cid` that is some other drug's internal id — that is that drug's modern
   link, and adopting it would steal a monograph.

Prefer merging **into** the CID the dataset and fixtures already use. Whichever
way it goes, re-run this seeder afterwards to repair the distribution row.

## Substances the seeder creates

The catalog did not hold every analyte in the first cohort, so the seeder
creates what is missing: PubChem identity, molecular weight (through
`upsertDrugParameter`, so the applicability guard is not bypassed), an English
name, the printed analyte name as an alias, and an empty monograph.

It does **not** guess a substance class. `data/substanceClasses.ts` sets a
deliberately high bar — "nobody administers it in any form", which excludes
morphine and O-desmethyltramadol despite both being metabolites — and dozens of
unreviewed judgements written in bulk is exactly what that file exists to
prevent. Every creation is reported so a curator can add the Norwegian name and
classify the ones that qualify.
