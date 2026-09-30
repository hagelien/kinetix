# Weeding out fabricated references

**Audience:** whoever curates the reference database.
**Tool:** `npm run audit:citations` (`scripts/audit-citation-authenticity.ts`).

## What went wrong

A citation row holds two things that were never checked against each other: a
**handle** (`pmid:30973059`) and a **metadata blob** (title, authors, journal,
year). When the blob was written by a language model rather than fetched from
the registry, the two can describe different papers — and nothing in the UI
says so, because the UI shows the stored blob and links out to the stored
number.

`pmid:30973059` was filed as *"A case of flubromazepam toxicity: analysis of
serum and urine"* (Carpenter et al., 2019). NCBI says 30973059 is
*"Scandinavian research on complementary and alternative medicine"* (Danell et
al.). Searching for the stored title finds nothing anywhere: the paper does not
exist, and a real PMID was attached to it.

## The cheap way to find them all

Not by reading references, and not by asking a model to re-check its own work.
By asking the registries, which answer for free and in bulk:

1. **Stage 1 — bulk compare.** PubMed's `esummary` returns 200 records per
   request, so the entire PMID table is ~13 requests and under a minute. For
   each row, compare the registry record against the stored blob.
2. **Stage 2 — title search.** Only for rows stage 1 could not vouch for: ask
   PubMed whether the stored title exists under *any* handle. This is what
   separates a repairable mis-filing from an invented paper — and it is the
   slow part by a wide margin. NCBI's rate limit, not the work, sets the pace:
   a few seconds per row, so a thousand suspects is a couple of hours. Set
   `NCBI_API_KEY` to raise the ceiling from 3 to 10 requests a second, or run
   `--no-stage2` when the question is only how bad the table is.

**Agreement is judged on author surnames and year, never on the title alone.**
Titles differ for innocent reasons — a Norwegian title stored against an
English record, a dropped subtitle, sentence case. Author lists do not collide
by accident.

## Reading the verdicts

| Verdict | Meaning | Action |
| --- | --- | --- |
| `ok` | Handle and metadata name the same work. | None. |
| `title-drift` | Same work, translated or paraphrased title. | Safe to fix in bulk: refresh the metadata from the registry. |
| `wrong-handle` | The paper is real, filed under the wrong identifier. Stage 2 found the right one. | Retarget the row, one at a time. |
| `dead-handle` | The identifier resolves to nothing. | Curation call. |
| `unfindable` | The identifier names an unrelated paper and no record carries the stored title. | Curation call — most likely fabricated. |
| `registry-silent` | The DOI is real — DataCite has it — but publishes no title or authors to check it against. | Existence confirmed, identity unchecked. **Never a deletion candidate.** |

A verdict is evidence, not a ruling, and every registry this asks is partial:

- Stage 2 asks PubMed, which is not the literature — a real paper indexed only
  elsewhere would read as `unfindable`, which is why stage 3 asks Crossref too.
  Over the full table that moved 74 real papers out of the delete list.
- Crossref is not the DOI system. Zenodo and ResearchGate register through
  DataCite, and Crossref answers 404 for both; asking DataCite as well moved
  two rows out of `dead-handle`.
- A book chapter, a national report or a thesis may be in none of them, and
  still reads as `unfindable`.

Check the row before acting on it.

## Why the audit will not delete anything

Deleting a citation orphans every parameter entry it backs, and a large share
of the suspect rows back several. Each finding is printed with its blast radius
(`backs N parameter(s)`) so the list can be worked worst-first, and rows that
carry a human-attested paper review are flagged `[reviewed]` — those were read
by someone and are almost never the problem.

The order that keeps the database usable while it is being cleaned:

1. Refresh `title-drift` metadata in bulk. No editorial judgement needed.
2. Retarget `wrong-handle` rows to the identifier stage 2 found.
3. Work `dead-handle` and `unfindable` worst-first. For each, the question is
   not "is this citation good" but "is the *number it backs* still true" — so
   the parameter entries are re-sourced or withdrawn, and the citation goes
   with them.

## Findings

The first full run (2026-09-22) found that half the PubMed references did not
describe the paper their identifier resolves to, and not one of the reviewed
references was among them. Its reports, worklists and pre-delete backups are
production data and are kept by the operator outside this repository.

## Acting on it

`npm run repair:citations -- --report <report.json>` carries out the verdicts.
It is a **dry run by default**; `--apply` requires `--actor <userId>` because
the parameter revisions it writes are attributed to a person.

- `wrong-handle` rows are repointed to the identifier the audit found, with
  metadata refetched from the registry. Where a citation already holds that
  identifier the two are merged instead of updated, since `(type, identifier)`
  is unique.
- `unfindable` / `dead-handle` rows are deleted under this policy: a parameter
  entry or fact with **other** sound references loses only the bad reference
  and survives; one whose **only** support was the bad reference is assumed
  erroneous and goes with it. Parameter values are repooled from the survivors
  by the ordinary recompute, which clears the published value when nothing is
  left and records a revision either way.

Every affected row is dumped to a backup JSON before the first delete, and the
run aborts if that file cannot be written.

## Usage

```bash
npm run audit:citations                          # everything, both stages (hours)
npm run audit:citations -- --no-stage2           # stage 1 only, ~1 minute
npm run audit:citations -- --type doi            # DOIs via Crossref
npm run audit:citations -- --limit 200           # sample
npm run audit:citations -- --json report.json    # machine-readable findings
npm run audit:citations -- --checkpoint /tmp/x   # where to keep stage 2's answers
```

Stage 2 writes every answer to `.citation-audit-checkpoint.jsonl` as it gets
it, and a re-run skips what that file already holds. An interrupted run — a
closed laptop, a recycled container — therefore costs the rows it had not
reached, not the whole stage. The file is not deleted on success; delete it
yourself to force a fresh set of lookups.

Set `NCBI_API_KEY` before a full run: it raises NCBI's ceiling from 3 to 10
requests a second, which is most of stage 2's wall time.

Run it after any bulk import of references, and before trusting a new source.

## Running a deletion

The 2026-09-22 deletion has been applied. The shape below is what any future
batch follows.

The rows to delete are specified by a report file, which is the audit's own
report narrowed to the rows it condemns. Keep that file (and the backup the run
writes) outside the repository — both are production data — so the run needs
no re-audit: regenerating it costs hours against NCBI's rate limit.

```bash
npm run repair:citations -- \
  --report <private-dir>/citation-deletions-<date>.json \
  --only delete --apply --actor <userId> \
  --backup <private-dir>/backups/citation-deletion-backup-<date>.json
```

`--actor` is the user id the resulting parameter revisions are attributed to.
The backup of every affected row is written before the first delete and the run
aborts if it cannot be written. Put it somewhere durable and commit it: these
runs happen in an ephemeral container, and a backup on that disk dies with the
session.

Re-run the dry form (drop `--apply`) first to confirm the plan against the
database as it is now. Expect it to be slow — the deletes themselves take
seconds, but recomputing every affected parameter's published value is one
round trip per pair and ran about half an hour for 1 543 of them.

Afterwards, re-run `npm run audit:citations -- --no-stage2` to confirm the
table against the registries, and check directly that no `reference_ids` array
still carries a deleted id.
