# Keeping `data/components.ts` in sync with the live catalog

## The problem

`data/components.ts` looks like a database mirror. It is not, and never was.

Data has only ever flowed one way, by hand:

```
data/components.ts  ──  npm run seed:drugs  ──▶  drugs / drug_parameters / metabolism tables
```

Nothing read the database back into the file. Meanwhile every write path added
since the last hand-edit writes **only** to the database:

- the `/review` pending-edit queue (`parameter`, `param_entry`, `metabolism`, … edits)
- `parameter_entries` aggregation, which recomputes `drug_parameters.value` as a
  weighted median + IQR cache
- `api/research-import.ts` / `npm run import:research` (deep-research seeding)
- `npm run import:farmakologiportalen` / `npm run backfill:farmakologiportalen-links`
- the scheduled maintainer agents

So the fixture ages in place. It remains an operational input, not merely a
backup copy. There are four live consumers:

1. **`npm run seed:drugs` treats it as the live seed.** This is not limited to
   bootstrapping an empty database: a populated database is also affected by a
   reseed. See [The seeder gap](#the-seeder-gap) for the ownership and overwrite
   rules.
2. **The kinetics-core provenance gate treats it as the reviewed catalog.**
   `scripts/generate-registry-provenance.ts` cross-checks the frozen registry
   against this file. If the file is a fossil, the gate is measuring against a
   fossil.
3. **The forensic pattern engine uses it at runtime for molecular weights.**
   `src/lib/pattern/catalogAnalytes.ts` statically builds its CID-to-molecular-
   weight lookup from `embeddedComponents`. That lookup gates supported
   analytes and supplies the mass↔molar conversions used when validating and
   resolving pattern cases. A database-only molecular-weight correction does
   not reach those calculations until the fixture is exported and the app is
   redeployed. Do not remove or demote the fixture without first repointing this
   consumer.
4. **`src/data/index.ts` serves it as the offline fallback.** `loadComponents()`
   calls `GET /api/drugs` first and falls back to `embeddedComponents` when the
   API throws or returns zero rows. This preserves the reference table and its
   client-side molecular-weight and blood/plasma conversions, but it does not
   make the whole application offline-capable: database-backed auth, wiki,
   review, saved-case, and method features still fail, and the simulator search
   reads the API directly. The fallback includes interpretive toxicology ranges
   and currently has no user-visible freshness indicator. Once selected it is
   cached for the SPA session; there is no production retry or cache clear, so
   a transient initial failure can keep serving the fixture after the API has
   recovered.

Only the fourth consumer is about Neon availability. The live seed, provenance
gate, and pattern-engine lookup all depend on fixture freshness while the
database is healthy. Consequently, the drift check must not be retired merely
because the offline fallback has limited scope.

## The tools

```bash
npm run catalog:check    # report drift, exit 1 if the fixture is stale
npm run catalog:export   # refresh data/components.ts from the live database
```

Both read `DATABASE_URL` from `.env` (like the other db scripts).

`--check` asks exactly one question: **would `catalog:export` change this
file?** It diffs the fixture against the *merge result* — what a refresh would
actually write — not against the raw database projection. That makes the gate
convergent by construction: run the refresh it recommends and the next check
passes. Diffing the raw projection instead would report everything the merge
deliberately preserves (see Safety properties) as drift no refresh could clear,
leaving the exporter saying "already up to date" while the gate stayed red.

It also fails on any live drug the fixture cannot represent (no PubChem CID —
the fixture's identity). Such a drug never enters the diff at all, so without
that the check could report "in sync" while the offline catalog is missing
drugs.

Because the default merge preserves fixture-only entries and values, this check
is intentionally **deletion-blind**. A live change or addition is reported, but
deleting a drug or seed-owned value from the database is not: the conservative
merge retains it, and a later reseed can restore it. If deletion safety matters,
review a `--prune` diff or add a separate fixture-only-row alarm; a green
ordinary `catalog:check` does not prove that a reseed cannot resurrect data.

Useful flags on `scripts/export-components.ts`:

| Flag | Effect |
| --- | --- |
| `--check` | Report drift and exit 1 instead of writing. |
| `--prune` | Mirror the database exactly: delete fixture entries **and field values** it has none for. Off by default. |
| `--out <path>` | Write the result elsewhere. `data/components.ts` is always the *input*. |
| `--max-drifts <n>` | Cap the per-drug rows printed (default 25). |

## What is compared

The check is **semantic**, not textual. Both sides go through the same
sanitizer, so none of these count as drift:

- key order inside a range literal
- a `note` that is only whitespace
- an all-empty `metabolism: { enzymes: [], metabolites: [], eliminationRoutes: [] }`
  block (several hand-written entries carry one; the projection omits it)
- `derivedFromEntries`, the machine marker the aggregation pipeline stamps on
  recomputed caches — the fixture has no field for it and could not back up the
  provenance claim anyway
- a free-text `qualifier`. That field is a comparison operator (`<`, `>`, `≤`,
  `≥`), not prose, but live data carries legacy values — migration 0078
  deliberately preserved a `qualifier: "approximately"` row. Rendering one would
  emit a `data/components.ts` that fails `tsc`, so unrepresentable qualifiers
  are dropped on both sides of the comparison

That is deliberate: the fixture stays hand-editable, so a hand-formatted entry
and a generated one must be able to sit side by side without the gate crying
wolf.

Entries are keyed on `pubchemCid`, matching the seeder's upsert target. A drug
renamed in the database is therefore a `name` field change, not a delete plus an
add.

### Field mapping

`drug_parameters.parameter` → `RawComponent` key. Most are identity; the three
interpretive bands are not:

| Parameter id | Fixture field |
| --- | --- |
| `molecularWeight`, `halfLife`, `volumeOfDistribution`, `bioavailability`, `proteinBinding`, `bloodPlasmaRatio`, `tmax`, `pKa` | same name |
| `therapeuticConcentration` | `therapeuticRange` |
| `toxicConcentration` | `toxicRange` |
| `fatalConcentration` | `lethalRange` |

Parameters the fixture has no field for (`logP`, `clearance`, the dose bands,
the detection windows, …) are ignored — the fixture is a subset by design.

Metabolism comes from `drug_elimination_routes` (split into `enzymes` for
`kind='enzyme'` and `eliminationRoutes` for the rest, each in `sort_order`) and
`drug_metabolites` (in `sort_order`).

## Safety properties

The refresh overwrites a curated file, so it is deliberately conservative:

- **Fixture-only entries are kept.** A drug in the file with no database row is
  the ordinary case for any database that was never seeded (a fresh branch, a
  dev instance, a Neon preview). Removing them requires `--prune`. Duplicate
  CIDs collapse onto the database row only when there *is* one — with no row to
  supply the canonical entry, every duplicate is kept rather than one synonym
  being silently chosen.
- **Fixture-only field values are kept.** The database wins wherever it has a
  value; the fixture's survives where it has none. This is a correctness
  requirement, not caution — see "The seeder gap" below. `--prune` mirrors the
  database exactly instead.
- **The read is one snapshot.** The projection spans four tables; it runs inside
  a `REPEATABLE READ` transaction so a mutation committing mid-read cannot
  produce a torn projection (a drug deleted after the `drugs` read would
  otherwise survive with its parameters emptied by FK cascades, and that
  stripped version would overwrite the file).
- **A zero-row projection refuses to write.** An empty result means the
  connection landed on an unseeded or wrong database; writing it out would
  delete the whole catalog for a configuration mistake.
- **Existing entries keep their position**, and new drugs are appended in
  codepoint order by name — so a refresh is a reviewable diff, not a 170-entry
  reordering. (Codepoint, not `localeCompare`: a locale-sensitive sort would
  make the output depend on the runner's ICU data.)
- **The preamble is never regenerated.** Only the array literal is replaced; the
  `RangeData` / `RawComponent` declarations above it stay hand-maintained.

## After a refresh

Re-run the provenance gate:

```bash
npm run kinetics:provenance:check
```

A refreshed catalog can legitimately turn a previously in-range registry
parameter into declared drift. That is the gate working. Resolving it — retune
the registry, or record a `reviewed-override` with a rationale — is a human
decision, not something the exporter should paper over.

## The seeder gap

The fixture is a live write input even after initial bootstrap. On a populated
database, `seed-drugs.ts` updates seed-owned parameter rows to the fixture's
values and deletes them when the fixture omits them.
`SEED_OWNED_PARAMETER_IDS` includes `molecularWeight`, so a stale fixture can
undo a live molecular-weight or other seed-owned PK correction on reseed. This
is why fixture freshness is an operational concern rather than merely an
offline-display concern.

`seed-drugs.ts` reads the fixture by *registry parameter id*, but three
parameters are stored under different keys in the fixture:
`therapeuticConcentration` → `therapeuticRange`, `toxicConcentration` →
`toxicRange`, `fatalConcentration` → `lethalRange`. Indexing by the registry id
returned `undefined` for all three, so **seeding never wrote them** — and 68 of
the 171 committed entries carry at least one.

Two consequences, both now fixed:

1. Every one of those hand-curated forensic thresholds was dropped on the way
   into the database. `seed-drugs.ts` now maps the keys via
   `fixtureFieldForParameter`, so a fresh seed round-trips them.
2. A refresh that replaced whole components would have deleted them from the
   fixture too, for any database seeded before that fix. Hence the field-level
   merge above.

The three are deliberately **not** added to the seeder's
`SEED_OWNED_PARAMETER_IDS`, and the seeder now treats non-owned parameters as
**insert-only** (`ON CONFLICT DO NOTHING`). Both halves matter:

- Not being seed-owned keeps them out of the seeder's cleanup loop, so a re-seed
  cannot *delete* a reviewed threshold the fixture happens not to carry.
- Insert-only keeps a re-seed from *overwriting* one. All three are
  `summarizable`, meaning `drug_parameters.value` is a recomputed cache over
  reviewed `parameter_entries` (weighted median + IQR). An unconditional upsert
  would replace a current aggregate with a stale fixture scalar and leave it
  wrong until the next entry mutation triggered a recompute.

Net effect: a fresh database gets the bands; a curated one is never clobbered.

## Rolling a fixture metabolite link out to a live database

The same gap in a second direction: `data/components.ts` names a substance's
metabolites, `seed-drugs.ts` turns those names into `drug_metabolites` rows,
and a production deploy does not run the seeder. So a metabolite added to the
fixture reaches a fresh install and no existing one — invisible until something
reads the edge. The pattern profile's source walk does: a missing
methadone→EDDP edge is the difference between an assessment that resolves its
sources and one that reports the graph uncurated.

**After the deploy**, run:

```
npm run backfill:metabolite-links            # dry run, prints what it would do
npm run backfill:metabolite-links -- --apply # writes
```

Deliberately not in `deploy-production.yml`, for the same reason
`backfill:substance-classes` is not: a data mutation that runs automatically on
production is a decision for whoever owns the deploy, not a side effect of a
code change.

What it will and will not do:

- it applies an **explicit list of pairs**, by PubChem CID on both sides, not
  the whole fixture. Absence from the live table is not evidence an edge
  belongs there — a curator who deleted a wrong link would have it restored on
  every run;
- it **never deletes and never rewrites**. Curators and two importers write to
  this table, and a fixture that has not caught up would drop their work;
- it **reports rather than acts** where the parent already carries an
  unresolved free-text row naming that substance in any language. The insert
  would collide with the parent-and-name index, and resolving that row in place
  would be a rewrite;
- it is **idempotent**, so running it again is free.

## Known fixture defect

`data/components.ts` currently has two entries sharing PubChem CID 3121:
`Valproat` and `Valproinsyre` (both `Valproic acid`, identical molecular
weight). `seed-drugs.ts` upserts on `pubchem_cid`, so only the last of the two
ever reaches the database and the other's data is silently discarded.

The exporter reports this rather than resolving it, because choosing the
canonical Norwegian name is a terminology call. A `catalog:export` refresh
collapses the pair onto the single database row automatically. The unit suite
pins the duplicate in `src/lib/catalogExport.test.ts` — tighten that assertion
to zero once the fixture is deduplicated.

## Where the code lives

| Piece | File |
| --- | --- |
| Pure mapping, rendering, semantic diff | `src/lib/catalogExport.ts` |
| The database read (`getDb()`-based, so the PGlite harness can inject) | `api/_lib/catalogExportStore.ts` |
| CLI + file I/O | `scripts/export-components.ts` |
| Unit tests (incl. a full round trip over the real fixture) | `src/lib/catalogExport.test.ts` |
| Integration tests over real SQL | `tests/integration/catalog-export.test.ts` |
| PR gate (tests + typecheck, path-filtered) | `.github/workflows/catalog-sync.yml` |
| Weekly drift check against the live DB | `.github/workflows/catalog-drift.yml` |

The two workflows split by what can trigger them. Changes to the exporter or the
fixture produce a diff, so `catalog-sync.yml` gates them on the PR. Drift comes
from database writes, which leave no trace in the repo — nothing to trigger on —
so `catalog-drift.yml` runs on a schedule instead.
