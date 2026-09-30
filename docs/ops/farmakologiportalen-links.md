# Farmakologiportalen monograph links — rollout and refresh

Each drug monograph shows a link to the same substance on
[farmakologiportalen.no](https://farmakologiportalen.no), rendered from
`drugs.farmakologiportalen_path` in the metadata strip beside the PubChem CID.

**Migration 0101 adds that column NULL for every existing row.** The monograph
renders a link only where a path is stored, and nothing in `vercel build`
stores one — so the deploy that carries 0101 ships the feature switched off
until the backfill runs. That is the one manual step, and it is the same shape
as `npm run retire:loq-lod` (AGENTS.md): a data job that has no business
running inside a build.

## Rolling it out

After the production deploy that includes migration 0101:

1. Run **Actions → farmakologiportalen-links → Run workflow** with
   `dry_run: true`. It prints one line per substance it would link, plus a
   summary. Read the `ambiguous name` count — those are substances two drugs in
   the catalog answer to by the same spelling; they are left unlinked on
   purpose and want a curator, not a retry.
2. Run it again with `dry_run: false` to write.
3. Spot-check a monograph. A linked drug shows `Farmakologiportalen: monograph`
   under the title; an unlinked one shows nothing there.

Locally, with a production `DATABASE_URL` in `.env`, the same job is:

```bash
npm run backfill:farmakologiportalen-links -- --dry-run
npm run backfill:farmakologiportalen-links
```

## Refreshing

Re-run it whenever the links should catch up with the portal — it adds
substances over time, and occasionally moves a path. The job is idempotent:
it writes only rows whose stored path differs from the portal's current one, so
a run that changes nothing reports zeros and touches no `updated_at`.

The workflow is dispatch-only. A weekly `schedule:` block would keep the links
current without anyone remembering, at the cost of making it an unattended
writer to the production catalog — a deliberate choice, left to whoever owns
the release process. `npm run import:farmakologiportalen` also refreshes these
links, but it fetches ~1500 content pages and resolves a PubChem CID per
substance on the way; use it when you want the parameters, not the links.

## What it will not do

- **It never guesses.** A spelling that two different drugs answer to resolves
  to neither of them (`drugs.names` has no cross-drug uniqueness — one string
  can be one drug's `nb` name and another's `en` name). Those are reported and
  skipped, because a link on the wrong monograph sends a reader to a different
  substance and still looks like it works. See below for how to clear them.
- **It never invents an address.** Only a `/content/<id>/<slug>` path from the
  portal's own index is stored, and `farmakologiportalenUrl()` refuses anything
  else before it reaches an `href`.
- **It does not mark drugs as imported.** `drugs.source` is untouched; a
  hand-curated drug the portal also lists gets a link without being relabelled.

## Clearing an `ambiguous name`

An ambiguous line means two catalog rows share a name — usually two PubChem
entries for one substance (a racemate and a stereoisomer, a salt and its free
acid, a systematic name and a common one). The link is the symptom; the two
rows are the problem, and they are just as confusing to a reader browsing the
catalog. **Check the CIDs before assuming duplication** — a row can also be
carrying an outright wrong CID, which is a different bug with a different fix.

`npm run audit:pubchem-identity` answers that question for the whole catalog at
once: it asks PubChem what each stored CID actually is, and sorts what it cannot
match into `wrong-compound` (the CID is a different substance — fix the CID) and
`variant-record` (another PubChem record for the right substance — the thing that
produces two rows for one drug). Its `by name` column is a suggestion from the
same kind of lookup that produced the bad CIDs in the first place, so read the
molecular formula rather than the number.

Once curation has decided the two rows are one substance, merge them:

```bash
npm run merge:drugs -- --into <survivor id> --from <loser id>            # dry run
npm run merge:drugs -- --into <survivor id> --from <loser id> --apply
```

When the **loser** is the row carrying the correct CID — the usual shape when a
CID-keyed seeder created the second row — add `--adopt-cid` so the survivor
takes it as part of the same transaction:

```bash
npm run merge:drugs -- --into <survivor id> --from <loser id> --adopt-cid --apply
```

That is not a convenience. `pubchem_cid` is UNIQUE, so the right number is not
free until the loser is gone, and the seed file that created the loser is keyed
by that number — so a merge that retires it leaves exactly the resurrection the
merge refuses on. Splitting it into a merge and a separate `retarget:cid` leaves
the catalog sitting between the two with the right substance under the wrong
identity.

The survivor is the row whose PubChem CID and slug you want to keep. The merge
moves the loser's parameters, method memberships, metabolite links and
postmortem distributions across (survivor wins any it already has), folds in
its names, shortname and aliases so nothing stops being searchable, inherits
its portal link and `source` where the survivor has none, and then deletes it
the way the admin delete does.

It **refuses** rather than proceeding whenever it would destroy something: a
relation it does not know how to move, a colliding metabolite link or cohort
distribution carrying its own evidence, a link whose label matches but whose
substance differs, a link between the two drugs that would become a self-edge,
a loser monograph with prose on it, or a saved simulator case that would have
to be repointed onto a drug with no PubChem CID whose id another drug carries
as its CID (give that drug its CID first). Read the dry run before applying.

**Then retire the loser's CID from every source keyed by one.** A merge deletes
a database row; it does not retire the substance from the repo files that seed
that database, and each of those is keyed by PubChem CID. Leave one behind and
the next seed run resurrects what you just merged. Grep the loser's CID and fix
every hit:

```bash
grep -rn "<loser CID>" data/ resources/
```

- `data/components.ts` — the offline fallback catalog **and** a `seed:drugs`
  input. **Repoint** the entry to the surviving CID rather than deleting it, or
  the substance drops out of the degraded-mode catalog altogether. The merge
  warns when the loser's CID is here. Because the exporter keeps fixture-only
  entries, a stale CID here does not even surface as drift.
- `resources/pm-concentrations-*.json` — `seed:pm-concentrations` resolves by
  CID and **creates missing drugs by default**, so a stale CID here rebuilds the
  merged-away row with a cohort distribution attached.
- `resources/pm-am-ratios-*.json` — `seed:pm-am-ratios` also resolves by CID but
  **skips** what it cannot find, reporting it as missing. A stale CID here is a
  hole rather than a duplicate: the PM/AM observation silently stops attaching
  to the surviving row on the next fresh seed.

Analytical-method memberships live only in the database
(`analytical_method_components`); the DB merge repoints them, and no repository
fixture seeds them.

**A repointed CID in `data/components.ts` also needs a migration.** Correcting
the number in that file fixes a *fresh* database. On one already seeded with the
old CID, `seed:drugs` then **aborts**: it slugs from `nameEn` and upserts with
`drugs.pubchem_cid` as the sole arbiter, so an insert of (existing slug, new
CID) finds no CID conflict, `ON CONFLICT` never fires, and the separate unique
index on `drugs.slug` raises instead — taking down the whole seed transaction,
including the analytical-method wiring that runs after it. Write a guarded
repoint migration alongside the file change;
`drizzle/0104_pubchem_identity_repoints.sql` is the template. Four things it has
to carry:

1. A `NOT EXISTS` guard so a database already holding both rows is left for a
   reviewed merge rather than silently picked for.
2. A repoint of any legacy `wiki_pages.drug_cid` still storing the old CID.
3. **A rewrite of `simulator_cases.case_data.drugs[].drugId`.** This is the one
   that bites. The key is `String(pubchemCid ?? id)` and the app resolves it as
   a CID *then falls back to an internal id*, so a case left pinned to the
   retired number does not fail — it silently loads whatever drug happens to
   have that internal id and simulates it. If the retired number is also a
   CID-less drug's internal id, the key is ambiguous: **skip the repoint
   entirely** rather than just the rewrite, or you manufacture that exact
   failure. Leave it for `npm run retarget:cid`, which refuses out loud.
4. **All of it in one statement**, per repoint, as chained data-modifying CTEs.
   The neon-http migrator commits each statement-breakpoint chunk
   independently with no surrounding transaction, so a split leaves the CID
   moved and the cases stale if the second chunk fails. Note the consequence:
   inside one statement every sub-select reads the pre-CTE snapshot, so the
   rewrite must be gated on `EXISTS (SELECT 1 FROM "repointed")` and *not* on
   "no drug carries the old CID any more" — the latter reads the old snapshot
   and suppresses the rewrite outright.

Neither `wiki_pages.drug_cid` nor the saved-case keys ride along on the row id,
which is why an `UPDATE` of the CID column alone is never the whole change.

Then re-run `npm run catalog:check` and `npm run kinetics:provenance:check`.

Then re-run the backfill — the name is now unambiguous and the link lands.
