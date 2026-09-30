# Deep-research drug seeding

Kick-start a drug's whole Kinetix knowledge base from a single research run,
instead of waiting for the maintenance agent to fill it in parameter-by-
parameter over weeks.

```
 research agent                     operator                    Kinetix DB
┌───────────────┐  JSON   ┌──────────────────────────┐  SQL   ┌──────────────┐
│ deep-research │────────▶│ Admin UI upload  OR       │───────▶│ drug + params│
│ prompt        │  v1     │ npm run import:research   │        │ + citations  │
│ (agents/…md)  │         │  [--dry-run] [--overwrite]│        │ + PD + metab │
└───────────────┘         └──────────────────────────┘        └──────────────┘
```

## 1. Produce the JSON

Every drug monograph carries a **Copy seed prompt** button beside its Edit link
for anyone holding `admin.researchImport.run`. It puts the prompt on the
clipboard with that drug's name already substituted and the operator notes left
behind — one click, then paste into the research agent. `src/lib/deepResearchPrompt.ts`
does the extraction from the markdown below, so the button and the file can
never disagree.

To do it by hand instead: run the prompt in `agents/deep-research-drug-seeding.md`
through a scientific deep-research agent, filling in the drug and the context of
use. Copy the whole block between the `PROMPT START` / `PROMPT END` markers — it is written to stand
alone for an agent that knows nothing about Kinetix, and the registry tables and
JSON contract inside it are part of the prompt, not reference material around it.
Leave the "Operator notes" section at the bottom of the file out. The agent
returns **one** `kinetix-deep-research-output-v1` JSON object and nothing else —
no evidence synthesis, no source-appraisal table — because only the JSON reaches
Kinetix, and evidence caveats that matter belong in the `note` on the value they
qualify. Save the object to a file (`cocaine.json`). A worked example lives at
`resources/deep-research-output.example.json`.

The JSON contract is authoritative and is validated on import against the live
parameter registry (`src/lib/drugParameters.ts`) — the prompt spells out the
exact parameter IDs, canonical units, allowed numeric ranges, and object shapes.
Anything that doesn't match is skipped with a warning rather than aborting the
whole import.

The prompt asks for the **whole registry** by default: a run for a new drug page
should return one entry per parameter ID, finalized or `not_finalized` with a
stated blocker, so a gap is visibly "checked, nothing defensible" rather than
"never looked at". When you add or remove a parameter in
`src/lib/drugParameters.ts`, update the registry table in
`agents/deep-research-drug-seeding.md` in the same change — the importer
validates against the registry, so an ID missing from the prompt is simply never
researched. `tests/deep-research-prompt-registry.test.ts` fails when the two
drift apart, in either direction, and also checks each row's canonical unit,
bounds and min/max requirement against the registry spec.

## 2. Import it — the browser (no terminal) **or** the CLI

Both paths call exactly the same validation and write path
(`api/_lib/researchImportStore.ts`), so they behave identically.

### Option A — Admin UI upload (no terminal)

For anyone who can't (or doesn't want to) use a terminal:

1. Sign in as an **admin** and go to **Admin → Seed drug**
   (`/admin?pane=seed`).
2. **Choose JSON file** (upload) or paste the research JSON into the box.
3. Click **Preview** — the server validates the document and shows what will be
   seeded (parameter/source/target/metabolism counts) plus any warnings. Nothing
   is written yet.
4. Optionally tick **Overwrite existing values** (off by default — existing
   curated values are kept).
5. Click **Import**. The whole drug is seeded in one request, attributed to you.

Preview is a server-side dry-run (`POST /api/research-import` with
`dryRun: true`); Import sends `dryRun: false`. Admin-only.

### Option B — CLI dry-run

```bash
npm run import:research -- --file cocaine.json --dry-run
```

Validates and prints the plan (parameters, sources, PD targets, metabolism, and
any warnings) **without touching the database** and without needing a
`DATABASE_URL`. Fix any warnings you care about, then re-run.

### Option B — CLI import

```bash
# reads DATABASE_URL from the environment / .env
npm run import:research -- --file cocaine.json
```

What it writes, in one pass:

| Research JSON                          | Kinetix destination                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drugIdentity`                         | `drugs` row (upsert on `pubchem_cid`, else normalized name/alias), stamped `source = 'deep-research'`                                                         |
| `kinetixParameterValues[]` (finalized) | `drug_parameters` value + a `drug_parameter_revisions` row carrying the citations |
| `kinetixParameterValues[].sourceValues[]` | `parameter_entries`, one row per reading with its own citation (origin `deep-research`); the post-import recompute derives `drug_parameters.value` from them |
| `sources[]`                            | `citations`, one row per **paper** — filed under its strongest handle, weaker ones kept in `metadata.altIds` (issue 1018)                                          |
| `pharmacodynamicTargets[]`             | `drug_receptor_targets` (incl. `assay_species`), resolving/creating each target as a canonical `bio_entities` row                                             |
| `metabolism`                           | `drug_metabolism_profiles`, `drug_elimination_routes`, `drug_metabolites`, `drug_enzyme_interactions`                                                         |

### Species of a pharmacodynamic measurement

`pharmacodynamicTargets[].assaySpecies` is written to
`drug_receptor_targets.assay_species` — on the measurement, never on the
catalog entity. `bio_entities` is shared across every drug, so a species
written there would follow the entity into every other monograph that cites
it; the entity stays human-canonical and the assay species qualifies the Ki /
IC50 / EC50 numbers on that one row. An absent value means the source did not
state a species, which is **not** a claim that the assay was human.

### Source values (kildeverdier) — how an imported parameter is stored

For every registry parameter marked `summarizable`, `drug_parameters.value` is
a **materialized summary**, not an authored number: it is recomputed from the
drug's `parameter_entries` — one row per source reading — as a weighted median
plus IQR, with matrix normalization where that applies. That is what the entry
list, the forest plot and the simulator consume.

A parameter value therefore has two halves in the contract:

- **`value`** — the agent's synthesis. Written to `drug_parameters` with its
  citations on the revision. On a parameter with no entries it stays as the
  authored (grandfathered) value.
- **`sourceValues[]`** — what each paper reported. Written to
  `parameter_entries`, one row per reading, each carrying its own citation,
  `matrix`/`scenario` where the parameter needs them, `n` and a context comment.
  Origin is `deep-research`, which is a real source origin: these rows pool,
  display and can be edited like any contributor's.

At the end of an import every summary for the drug is recomputed, so a parameter
that carried source values ends up with a genuine aggregate rather than a
synthesized scalar. A parameter may carry `sourceValues` and **no** `value` —
the aggregate is then the only value.

#### At least two sources per parameter

Because the displayed value is a pool, a parameter seeded from one paper
aggregates to that paper: no spread, no IQR, and it reads as thinly established.
The prompt therefore asks for readings from **two or more independent sources**
per entry-backed parameter wherever the literature has them, and the importer
reports the shortfall — one summary warning naming the thin parameters and the
number of distinct **papers** each has, plus a `! 1/2 papers` marker on the CLI
plan lines. Papers, not `sourceId`s: two entries in `sources[]` that share a
handle (the same DOI twice, one declaring the PMID and the other the DOI, or a
`doi.org` / PubMed resolver URL and the bare identifier it wraps) are the paper
`resolveCitation` will file in one citation row, so they count once.
The pair a pure validator cannot fold is one whose declared handles do not
overlap at all — those are linked only by NCBI's ID converter, which runs after
parsing.

That makes the count two-stage, and the two stages can differ:

- **Preview** (and `--dry-run`) counts what the document establishes on its own.
  No crosswalk is resolved there, so two entries that are the same article only
  according to NCBI still count as two papers.
- **Import** recounts once `resolveImportCrosswalk` has answered
  (`recountSourceValueCoverage`), and that recomputed line replaces the
  parse-time one rather than sitting beside it. It is the count that matches the
  citation rows the run actually wrote, so a preview that showed no shortfall
  can come back from the import naming one. That is the crosswalk telling you
  two of your sources were one paper — not a validation flake. It is a warning, not a rejection: where only one usable study exists
that is the honest answer, and the prompt asks the agent to say so in the
reading's `comments` rather than manufacture a second citation. Two readings
from the same paper count as one source; so does a review quoting a study
already cited. `analyteStability` is exempt — it takes no source values at all.
So are `loq` and `lod`, but only because they are no longer parameters: an
analytical limit belongs to a validated method in a lab, not to the substance,
and Kinetix carries it per analyte per analytical method instead.

On the prompt side the ask is framed as **search effort**, not only as output
shape: "Before you start" tells the agent to budget two papers per parameter
from the outset, and a closing sweep tells it to revisit every finalized
parameter left with one reading and search again before emitting. That framing
is what the wording alone did not achieve — an agent reading "a parameter should
arrive with two sources" still plans one search per parameter and reports what
that pass happened to find. If a run still comes back with several thin
parameters, check that shape of failure first: a run that stopped early looks
exactly like a literature that has one paper, and the only thing that tells them
apart is whether the single readings carry the "searched, no independent
replication" note the prompt asks for.

Reconciliation across re-runs is by (parameter, citation, matrix, scenario):

- an identical reading is recognised and left alone (a re-run is a no-op);
- a reading that changed since a previous import is applied only under
  `--overwrite`, and is otherwise reported so the operator decides;
- a row a human authored is never rewritten — a second value from the same paper
  is a new observation, not a correction of theirs;
- a reading whose `sourceId` never resolved to a citation is dropped and counted:
  entry-backed parameters are citation-gated by design.

Do not encode several incompatible studies as one artificial range in `value`.
Report each study in `sourceValues[]` and let the aggregate express the spread;
choose a defensible contextual synthesis for `value`, or mark the parameter
`not_finalized`. Analyte stability is matrix-relevant but deliberately **not**
aggregatable across matrices — it takes no source values, and a mixed-matrix
synthesis there is meaningless.

The relationship tables now point only to the unified `bio_entities` registry:
`drug_receptor_targets.bio_entity_id` is required, while enzyme routes and
`drug_enzyme_interactions` use `bio_entity_id` without the retired
`receptor_target_id` / `enzyme_id` columns. The importer resolves or creates
the appropriate `drug_target` or `metabolic_enzyme` function automatically.

### Options

- `--dry-run` — validate + print the plan; no writes.
- `--overwrite` — replace existing curated parameter values. **Default is
  non-destructive** (insert-if-absent): an existing value is kept and counted
  under "kept existing".

### Seeding a drug that already has values

A parameter's citations live on its `drug_parameter_revisions` row, and a kept
value writes no revision — so when the non-destructive default keeps an existing
value, the sources the document cited for the value it proposed instead are left
anchored to nothing. They are deliberately **not** re-pointed at the kept value:
they back a different number, and crediting them to the one already stored would
fabricate provenance. The parameter therefore stays flagged "no references" in
the sidebar and those papers stay out of the drug's bibliography.

Both entry points now report this rather than passing over it — the CLI prints
the affected parameters after the import summary, and the admin panel shows them
under the result counts. When the researched values are the better ones (a
common case on a drug seeded earlier by the auto-extractor), re-run with
`--overwrite` / tick **Overwrite existing values** so each parameter gets a
revision carrying its citations.
- `--user-email <email>` — the user recorded as author of the seeded revisions
  (`drug_parameter_revisions.created_by` is required). Defaults to
  `agent@kinetix.internal` (or `IMPORT_USER_EMAIL`). Run `npm run seed:agent-user`
  once if that user doesn't exist yet, or pass an admin/editor email.
- `--stdin` — read the JSON from stdin instead of `--file`.

The import is **idempotent**: re-running the same file never duplicates rows
(routes, metabolites, PD targets, and enzyme interactions are
insert-if-absent).

### One paper, one citation row

Citations are unique on `(type, identifier)`, so a paper declared as `doi` in
one seed and as `pmid` in another used to become two rows — and because
`paper_reviews` is unique on `citation_id`, two rows meant two independent
reviews, with the `read_in_full` attestation that gates admissibility attached
to only one of them. The importer now resolves every source through
`resolveCitation`, which looks the paper up under **every** handle it is known
by (declared identifiers first, then NCBI's ID converter as a best-effort
lookup) before writing, files it under the strongest one, and keeps the others
in `metadata.altIds` so they stay searchable and so the next seed declaring one
of them lands on the same row. A source that only ever gives free text is left
alone — free text identifies nothing to crosswalk against.

Pairs that were split before this landed are folded together by
`npm run merge:split-citations` (dry-run; `--resolve` also asks NCBI, `--apply`
performs the merge and requires `--user-email`). Where both rows carry a review,
the `read_in_full` one survives and the loser's revision history is re-parented
onto it — including the retired review's own revisions, which the cascade on
`paper_review_id` would otherwise take with it.

`--apply` needs `--user-email` because a merge can change which review backs a
parameter entry, and a review's score is a weight in source-weighted
aggregation: the cached summaries are recomputed on the spot, and those
revisions need an author. There is no second chance for that recompute — a
re-run finds no split pairs left to trigger it.

## Scope, provenance, and review

This is an **operator/admin** tool. Like `seed-drugs.ts` and
`import-farmakologiportalen.ts` it writes directly to the database, bypassing
the API's pending-edit review queue and the agent-only reference gate. That is
the point — it seeds the whole substance at once. Two consequences:

1. **Provenance is preserved.** Every seeded row is tagged
   `drugs.source = 'deep-research'`, and every parameter write records a
   revision with `edit_summary` and the citation ids that back it. The seed is
   fully auditable.
2. **Review still happens — afterwards.** Seeded parameters cite references that
   the paper-review agents have not necessarily read in full yet. They surface
   immediately (kick-start) and the normal review/verification cycle catches up.
   This is why the research prompt insists on real citations, real values, and
   `not_finalized` for anything that can't be defended.

## Tests

- `src/lib/deepResearchImport.test.ts` — pure validation/normalization
  (`npm run test`).
- `tests/integration/research-import.test.ts` — the full DB write path against
  in-process PGlite: drug creation, citation dedup, revisions, bio-entity
  resolution for PD targets and enzyme routes through `bio_entity_id`,
  idempotency, `--overwrite`, and reconciliation with entry-backed parameter
  summaries
  (`npm run test:integration`).
