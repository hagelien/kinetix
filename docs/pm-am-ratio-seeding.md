# PM/AM ratio seeding (Mantinieks et al. 2021)

Seeds the `pmAmRatio` drug parameter — the postmortem/antemortem drug
concentration ratio — from Table I of:

> Mantinieks D, Gerostamoulos D, Glowacki L, Di Rago M, Schumann J,
> Woodford NW, Drummer OH. **Postmortem Drug Redistribution: A Compilation of
> Postmortem/Antemortem Drug Concentration Ratios.** *Journal of Analytical
> Toxicology* 2021;45(4):368–377. [doi:10.1093/jat/bkaa107](https://doi.org/10.1093/jat/bkaa107)

```
resources/pm-am-ratios-…json ──▶ scripts/pm-am-ratios/dataset.ts ──▶ npm run seed:pm-am-ratios ──▶ parameter_entries
   (transcribed Table I)            (zod + registry validation)          [--dry-run]                 + recomputed
                                                                                                    drug_parameters cache
```

## What PM/AM is — and what it is not

`pmAmRatio` is a **paired-specimen ratio across death**: an antemortem clinical
specimen against postmortem femoral blood drawn at mortuary admission from the
same decedent. It is a different quantity from `postmortemRedistribution` (C/P),
which is a within-body gradient — **two sites sampled after death at the same
time** (cardiac vs femoral blood). The two share the monograph's postmortem box;
they are never pooled.

It is *paired specimens*, not "the same site over time". Only the postmortem
member is defined: femoral whole blood at mortuary admission. The antemortem
member is whatever routine hospital draw exists — venous, of unstated site, and
whole blood, plasma or serum. Specimen-site and matrix differences are therefore
embedded in the ratio alongside the postmortem change, and it must not be read
as isolating the latter.

The paper's own conclusion is that there was **no obvious relationship** between
antemortem and postmortem concentrations for most drugs. A PM/AM ratio is a
population-level descriptor of how much drugs of that kind moved between life
and mortuary admission — it must **not** be used as a factor to back-calculate
an antemortem concentration from a measured postmortem one. Every seeded entry
carries that caveat in its `comments`.

## Data model

One Table I row → one `parameter_entries` row:

| Table I column        | Entry field | Notes |
| --------------------- | ----------- | ----- |
| PM/AM ratio, median   | `median`    | Central estimate for the aggregate |
| PM/AM ratio, range    | `low`/`high`| Individual-case extremes, not a CI |
| *n*                   | `n`         | Paired AM/PM cases; weights the pooled aggregate |
| —                     | `unit`      | Always `ratio` (dimensionless) |
| drug class, t₁, t₂, *P*, caveats | `comments` | See below |

`pmAmRatio` has no interpretive `scenario`, and it is **not matrix-relevant** —
see below. The study context — drug class, the median time from AM sampling to
death (t₁) and from death to PM sampling (t₂), the significance-test result, and
any drug-specific caveat — goes into `comments`, which is where a
matrix-independent parameter records its context.

### Why `matrix` is not set (and what to watch instead)

The AM specimen matrix genuinely affects the number: this cohort was about 35%
plasma/serum, and restricting pholcodine to AM whole blood drops its median from
16 to 5.0. But the `matrix` column cannot carry that:

- A PM/AM value has **two** matrices — the postmortem numerator (femoral whole
  blood) and the antemortem denominator. One column cannot express the pair.
- The column's only aggregation effect is `matrixToWholeBlood`: multiply a
  serum/plasma value by the blood:plasma ratio. For a ratio the correction runs
  the **other way** — with a plasma denominator the measured value is
  `true × B/P`, so recovering a whole-blood-equivalent ratio means *dividing* by
  B/P. Marking the entry matrix-relevant would multiply, compounding the error.
- This paper's row is a median over a *mixed*-matrix cohort, so there is no
  single matrix to label it with in the first place.

So the AM composition stays curation context in `comments`. The consequence is a
**sourcing rule, not a code guard**: PM/AM entries from studies whose AM matrix
composition is not comparable should not be pooled into one summary. Check that
before adding a second source to this parameter.

`drug_parameters.pmAmRatio` is a **recomputed cache** of the entry pool, like
every other summarizable parameter. The seeder recomputes it after each insert
rather than writing a value directly.

## Running it

```bash
npm run seed:pm-am-ratios -- --dry-run        # validate + print the plan, no DB
npm run seed:pm-am-ratios                     # write (reads DATABASE_URL from .env)
npm run seed:pm-am-ratios -- --user-email me@example.com
DATABASE_URL=… npm run seed:pm-am-ratios
```

The seeder is an **admin/operator tool**: like `scripts/seed-drugs.ts` and
`scripts/import-research-output.ts` it writes directly and bypasses the
pending-edit review queue. Provenance stays complete — every entry links the
paper's DOI citation, and the recompute records a `drug_parameter_revision`
crediting it.

Behaviour:

- **Idempotent by source observation, not by value.** The seeder owns at most one
  entry per (drug, `pmAmRatio`, this citation). A corrected transcription
  **updates** that row; it never inserts a second one. Value-keyed matching would
  double-weight the paper when a bound moves, and would silently keep a stale `n`
  or comment when only those change (neither is compared by
  `entryDuplicateExists`). If more than one entry already cites this paper for a
  drug, the seeder skips it and reports it for a human rather than guessing.
- **Decides under the drug lock.** `parameter_entries` has no unique constraint on
  (drug, parameter, citation), so an unsynchronized "does it exist?" read is a
  TOCTOU: two overlapping runs could both see nothing and both insert. The
  identity check therefore runs *inside* the write transaction, after
  `pg_advisory_xact_lock(drug_id)` — the same lock recompute takes, just held over
  the decision as well. The pre-check outside the transaction is only a fast path
  for rows that are already current.
- **Invalidates stale proposals.** Updating a seeded row calls
  `markEntryMutationsConflicted` in the same transaction, as the direct-write
  routes do. Without it a contributor's queued update/delete still holds the
  pre-correction snapshot and could later be approved, silently reverting the
  corrected values or deleting the row.
- **Resolves the citation by paper, not by handle.** The row is resolved through
  the shared `resolveCitation` path (issue 1018), which matches DOIs
  case-insensitively — a DOI is case-insensitive by spec but
  `citations.identifier` is text and its unique index is not — *and* recognizes
  the paper when it is already filed under its PMID. Either miss would mint a
  second citation, which carries its own entries and double-weights the paper,
  and hides the first row's paper review (including the `read_in_full`
  attestation the parameter gate reads). An existing row keeps its own metadata
  field by field — it may be CrossRef-resolved or human-curated, and the
  dataset's hand-transcribed record must not overwrite it — while fields the row
  lacks are filled in. The dataset's publisher URL is kept as an alt id rather
  than becoming a separate `url` citation.
- **Additive.** Entries from other sources are untouched; the cache is recomputed
  over the whole pool, not overwritten with this paper's value.
- **Never creates drugs.** An analyte with no matching `drugs.pubchem_cid` row is
  reported and skipped. Add the substance, then re-run.
- **Does not require a read-in-full review.** The API's contributor path gates
  parameter values on `assertReferencesJudged`; this operator-vetted bulk path
  deliberately does not, matching `seed-drugs.ts` and `import-research-output.ts`.
  A missing review is reported **before** the writes — after 42 committed entries
  the notice would tell the operator nothing they can act on — and seeding
  continues.
- **Stamps its revisions.** Each recompute's `drug_parameter_revision` gets the
  operator's `recordApproval` (plus `recordImplicitAgentApproval` when the account
  is an active agent), mirroring `api/parameter-entries.ts`. Unstamped, the live
  revision would stay an unapproved level-0 row invisible to the peer sweep.

Analytes are matched by **PubChem CID**, which is language-independent — the
paper's English names map onto the Norwegian-named drug rows without a
translation table.

## Coverage

All 42 analytes from Table I (the drugs with ≥ 10 paired AM/PM values) are in
the dataset. Anything without a matching drug row is listed at the end of a run
and skipped; add the substance and re-run.

Two analyte-identity notes:

- Table I's **"Desmethylvenlafaxine"** is the *O*-desmethyl metabolite —
  desvenlafaxine, **CID 125017**. It is not *N*-desmethylvenlafaxine
  (**CID 3501942**), which is a separate registry entry. The dataset row is named
  `O-Desmethylvenlafaxine` so the two cannot be confused.
- **Hydroxyrisperidone** is seeded onto paliperidone (**CID 115237**), following
  the paper, which counts the risperidone metabolite and administered
  paliperidone as one drug.

Each row also records `pubchemName` — PubChem's own Title for the CID, captured
at transcription time. It exists purely so the CID↔analyte mapping is auditable
in review without a network call, and it earns its keep: one transposed digit in
the first draft pointed pholcodine at an unrelated peptide. On every write the
seeder logs `paper analyte → resolved drug name` for the same reason — a
mistyped CID matches the *wrong* drug rather than nothing.

Median PM/AM ratios for **clonazepam (0.35)** and **nitrazepam (0.14)** appear in
the paper's discussion as "data not shown". They are deliberately **not** seeded:
no *n* and no range are reported, and by the paper's own inclusion rule both had
fewer than 10 paired cases, so pooling them as if they were Table I rows would
overstate the evidence.

The blood:plasma ratio column of Table I is quoted from Baselt (11th ed.), not
measured in this study, so it is not seeded from this source.

## Tests

`tests/pm-am-ratios-dataset.test.ts` checks the transcription against the
published table (spot-checked medians/ranges/*n* across drug classes, the exact
set of statistically significant rows, 42 unique analytes) and asserts every row
builds a payload that passes the live registry validation.
