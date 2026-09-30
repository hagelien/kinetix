# Rettstoks's own detection times (the REFS guideline)

The detection-times module (`/detection-times`) answers "how long can this be
found" from the literature: three `*DetectionWindow` parameters, pooled from
cited source values, visible to every reader.

That is not the number a Rettstoks case is interpreted against. The section has
its own approved, restricted urine-interpretation guideline whose table states,
for urine, the band the section has agreed to use at *its own* cut-offs and for
*its own* case categories. This feature puts that table in front of the people
it applies to, and keeps it clearly apart from the pooled windows.

**The table itself is not in this repository.** It is a restricted internal
document; its rows live only in the `refs_detection_guidelines` database table
and are loaded by an operator from outside the source tree. The repository
carries the schema, the types, the matching and the UI — and synthetic test
fixtures — never the guideline's content or identity.

## Why the two are separate, always

A pooled literature window and a laboratory's agreed band disagree by design: a
lower cut-off buys a longer window, and a laboratory's cut-offs are not the ones
behind the published studies. So the two are never merged, never averaged, and
never rendered in the same grid:

- the pooled cards keep their place, and gain a heading naming them as pooled
  literature — but **only for a reader who can also see the REFS section**,
  since for everyone else there is only one kind of answer on the page;
- the REFS readings live in their own bordered section with the document's
  identity (title, id, version, approval date, owning unit, classification)
  printed beneath them.

## Where it lives

| Piece | File |
| --- | --- |
| The table (rows + document identity) | `refs_detection_guidelines` (DB, key `urine`) — schema in `db/schema.ts`, `drizzle/0136_refs_detection_guidelines.sql` |
| Validated read | `api/_lib/refs-guideline-store.ts` |
| Types, validators, name folding, matching | `src/lib/refsDetectionTimes.ts` |
| Gated route | `api/refs-detection-times.ts` |
| Client fetch + per-identity cache | `src/lib/refsDetectionApi.ts` |
| React binding | `src/lib/useRefsDetectionTimes.ts` |
| Section UI | `src/components/detection/RefsDetectionSection.tsx` |
| Register column + presets | `src/components/DrugTable.tsx`, `src/lib/detectionColumnPresets.ts` |
| Strings | `detection.refs.*`, `drugTable.refsUrineDetection` in both locales |
| Synthetic test table | `src/lib/__tests__/fixtures/refsSyntheticGuideline.ts` |

## The gate

`refsDetectionTimes.read` — admin by default, floored at `authenticated`, and
also granted by membership in the `rettstoks` group. Same shape as
`methods.read` and `pmConcentrations.read`.

An ungated caller gets `200 { rows: [], gated: true }` — the same answer
`/api/methods` gives — because this backs one section of a page the reader is
otherwise entitled to see. The gated branch never reads the database, so
nothing stored (not even the document identity) reaches a caller outside the
gate. An entitled caller on a deployment where the table has not been loaded
gets `503`, which the client renders as "nothing to show" rather than as "the
guideline names none of these substances".

The read is all-or-nothing: a stored row that fails `isRefsUrineDetectionRow`
fails the whole request instead of being filtered out, because a forensic
table with one row silently missing is indistinguishable from a complete one.

## Matching a substance to a row

The guideline names substances in Norwegian and sometimes compounds several
into one cell (e.g. "A/B (synonym)"). Matching folds every name Kinetix knows a
substance by — all languages, short name, aliases — against an index built
from each row's parent, metabolites and `aliases`, ignoring case, spacing,
hyphens and accents.

`aliases` are spellings of the **parent**; a metabolite's synonyms go in
`metaboliteAliases`, keyed by the guideline's own spelling of that metabolite.
The distinction is not cosmetic — the role a match carries decides which half
of a split row (one band for the parent, another for its metabolites) the
reader is told. An alias must also not reach past what the row states: a close
relative the row does not name must stay unmatched rather than inherit a band
stated for something else.

A substance can match more than one row, and that is not a bug to be
deduplicated away: a benzodiazepine can be its own row **and** another row's
listed metabolite. Those cross-references are the guideline's own, and the page
shows the substance's own row first and the rows that merely name it after,
each labelled with how it was reached.

## Reading the whole table

Members get a disclosure that opens the full table (parent, metabolites,
detection time, comment), and the substance register gains a **Urin (REFS)**
column — gated the same way, absent rather than empty for everyone else, since
an empty column would read as "no detection time" for substances the guideline
does in fact name. The "Påvisningstider for alle stoffer" link on
`/detection-times` opens the register full-screen on the detection-time axis
alone, with that column included for members.

## Loading or updating the table (operators only)

The table is written directly to the database by an operator with production
access, from the controlled document, using a script kept **outside** this
repository. Never commit the rows, a seed file, or a migration containing them.

1. Transcribe, do not paraphrase: comments and chapter quotes are the
   document's own wording and stay in Norwegian in every locale.
2. Upsert the single row `key = 'urine'` with `source` (a `RefsGuidelineSource`
   — bump `version` and `approvedFrom` with any row change), `preamble`, and
   `rows` (a `RefsUrineDetectionRow[]`).
3. Carry the guideline's imprecision across as it stands — an empty cell is
   `{ kind: 'notStated' }`, "no documentation" is `{ kind: 'noDocumentation' }`.
   Do not fill either in from another source; that is what the pooled windows
   are for.
4. Validate every row with `isRefsUrineDetectionRow` before writing; the route
   refuses the whole table if one row is malformed.
