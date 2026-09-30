-- Clear `qualifier` where it holds prose instead of a comparison operator.
--
-- `qualifier` is `<`, `>`, `≤` or `≥` and nothing else (`QUALIFIER_OPERATORS`,
-- src/types/index.ts): it marks a CENSORED THRESHOLD, which is why the value
-- renders as the operator followed by ONE figure. Text written there is
-- therefore wrong twice over — it reads as part of the number, and its
-- single-value branch hides a real min–max span behind whichever bound the
-- formatter picks.
--
-- Both schemas refuse it today (`DRUG_PARAMETERS[*].zod` for an authored
-- parameter, `parameterEntries.ts` for a source value) and `formatRange`
-- ignores a stored one, so nothing displays wrong right now. What is left is
-- the sediment: six rows written before the enum was tightened, all of them
-- carrying a population, a measurement condition or a field label in a slot
-- that means "the true value lies above/below this". They are frozen — the API
-- rejects any edit that would rewrite them as they stand — and every reader of
-- the column has to know to ignore them. So they are corrected here rather than
-- tolerated, in the same spirit as 0116/0117: the fix for a stray value is
-- data, not a permanent exception in the code that reads it.
--
-- The information itself is kept. Where the note already carries what the
-- qualifier says, the key is simply dropped; where the qualifier says something
-- the note does not, that statement is added to the note in the note's own
-- language before the key goes. Nothing is deleted uninspected — the six live
-- rows, and what happens to each:
--
--   alprazolam  logPlogD  "logP"       note opens "Lipofilisitet … (logP
--                                      oktanol/vann)". Redundant → drop.
--   amphetamine logPlogD  "logP"       note opens "logP (n-oktanol/vann,
--                                      nøytral form)". Redundant → drop.
--   morphine    logPlogD  "logP/logD"  note names both cLogP and cLogD7,4 and
--                                      says to read the row as a broad
--                                      lipophilicity marker. Redundant → drop.
--   caffeine    pKa       "amin"       WRONG, not merely redundant: the note
--                                      states the protonation site correctly
--                                      (N7/N9 of the imidazole ring, the
--                                      caffeinium cation). Caffeine has no
--                                      basic amine. Drop it, and do not carry
--                                      it into the note.
--   caffeine    tmax      "adult PO"   the note describes formulation and
--                                      fasting state but never says who or by
--                                      which route → folded into the note.
--   ethanol     logPlogD  "25C"        a measurement temperature, stated
--                                      nowhere else on the row → folded into
--                                      the note.
--
-- The three "redundant" verdicts are conditions, not assumptions: each drop
-- requires the note to still say `logP` (or `cLogP`) at the time it runs, since
-- a note edited since these were read would leave the qualifier as the row's
-- only remaining label. Morphine's is stricter again — its `logP/logD` claims
-- BOTH measurements, so the note must still carry both — and a row that fails
-- either check keeps its text through the sweep instead. Caffeine's `amin` is
-- the exception and drops unconditionally: see its statement.
--
-- Two of the six therefore gain a sentence and four lose a field. A last
-- statement sweeps anything this file's author never saw — another
-- environment, a row written between here and deploy — by folding the text
-- into the note under a Norwegian label (`note` is authored content rendered
-- verbatim and can never be localized afterwards, so a fixed label wrapped
-- around it follows the same rule — AGENTS.md, "Seeded and imported content is
-- authored content"). That is deliberately the clumsy option: a generic rule
-- cannot tell a redundant label from a wrong one, and an unreviewed string
-- appended visibly is recoverable in a way a silent delete is not.
--
-- EVERY fold — the sweep and the two by name — happens only where the result
-- still fits `note`'s 500-character schema bound (`DRUG_PARAMETERS[*].zod`,
-- src/lib/drugParameters.ts). That bound is counted the way zod counts it:
-- JavaScript's `.length` is UTF-16 CODE UNITS, so an emoji or any other
-- non-BMP character costs two there and one to `char_length()`. The guards
-- therefore add an upper bound on the surrogate pairs a string can hold —
-- every 4-byte UTF-8 character carries 3 bytes more than its single code
-- point, so `(octet_length - char_length) / 3` can only over-count them.
-- Over-counting is the safe direction: it can leave a repairable row for a
-- curator, never write a note the API will then refuse. And each guard measures
-- the string its own statement would write, rather than the stored note plus a
-- hand-counted suffix length — the arithmetic version had the caffeine sentence
-- one unit short of itself, which is exactly the note this bound exists to stop.
-- Postgres would store an over-long one happily, but every later edit validates
-- the whole value, so it would leave the row as stuck as the qualifier did — a
-- different unpublishable field, not a repair. A row that cannot fit keeps its
-- qualifier and stays on `npm run audit:qualifiers`'s list, where a curator can
-- shorten the note and clear the field in one edit. In the live database the guard is a no-op: the
-- two named notes are ~120 and ~240 characters and the added sentences 38 and
-- 25. It is there for the row edited in another deployment, or between this
-- file and the deploy that runs it — the same reason the sweep exists at all.
--
-- Scope, deliberately:
--   * `parameter_entries` is NOT touched. Its `qualifier` column holds only
--     operators (59 rows, all `<`/`>`/`≤`/`≥`) and cannot acquire prose: every
--     write validates against the zod enum. `npm run audit:qualifiers` is what
--     re-checks that claim, in all three places, against the live database.
--   * `pending_edits` is NOT touched. An open proposal carrying a prose
--     qualifier is unapprovable, but it belongs to its author: it is repaired
--     by a resubmit or closed by a return, never by rewriting the queue
--     underneath the person being asked to fix it.
--   * `drug_parameter_revisions` is NOT touched, as in 0117 — the log records
--     what was stored when, and minting a revision here would need an editing
--     user who made no such edit.
--
-- Re-running changes nothing: every statement selects on the non-operator
-- qualifier it removes, so a second pass matches no rows.

-- ── The length bound, counted in UTF-16 code units ─────────────────────────
-- A transient helper so the three guards below state the rule once. Created
-- and dropped inside this migration; `pg_temp` is not usable here because the
-- neon-http migrator runs each statement on its own connection.
CREATE OR REPLACE FUNCTION kinetix_0118_utf16_len(s text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT char_length(s) + (octet_length(s) - char_length(s)) / 3
  $$;
--> statement-breakpoint

-- ── Rows whose qualifier states something the note does not ────────────────
UPDATE "drug_parameters" AS dp
SET "value" = (dp."value" - 'qualifier')
  || jsonb_build_object(
       'note',
       btrim(coalesce(dp."value" ->> 'note', '') || ' Verdiene er målt ved 25 °C.')
     )
FROM "drugs" d
WHERE d."id" = dp."drug_id"
  AND d."slug" = 'ethanol'
  AND dp."parameter" = 'logPlogD'
  AND dp."value" ->> 'qualifier' = '25C'
  -- Measured on the string this statement would actually write, never on a
  -- hand-counted constant for the suffix: counting one of these by eye is how
  -- the caffeine guard below was a unit short of its own sentence.
  AND kinetix_0118_utf16_len(
        coalesce(dp."value" ->> 'note', '') || ' Verdiene er målt ved 25 °C.'
      ) <= 500;
--> statement-breakpoint

UPDATE "drug_parameters" AS dp
SET "value" = (dp."value" - 'qualifier')
  || jsonb_build_object(
       'note',
       btrim(coalesce(dp."value" ->> 'note', '') || ' Gjelder voksne etter peroral dosering.')
     )
FROM "drugs" d
WHERE d."id" = dp."drug_id"
  AND d."slug" = 'caffeine'
  AND dp."parameter" = 'tmax'
  AND dp."value" ->> 'qualifier' = 'adult PO'
  AND kinetix_0118_utf16_len(
        coalesce(dp."value" ->> 'note', '')
        || ' Gjelder voksne etter peroral dosering.'
      ) <= 500;
--> statement-breakpoint

-- ── Rows whose note already says it ────────────────────────────────────────
-- Dropping these is safe only BECAUSE the note carries the same distinction, so
-- the statement checks that rather than assuming it: the notes read here today
-- were read at a point in time, and a row edited since — in another deployment,
-- or between this file and the deploy that runs it — would otherwise have its
-- last measurement label deleted by a rule that no longer describes it. When
-- the note no longer says `logP` (`cLogP` matches too, case-insensitively), the
-- row simply falls through to the sweep below and keeps the text under a label.
UPDATE "drug_parameters" AS dp
SET "value" = dp."value" - 'qualifier'
FROM "drugs" d
WHERE d."id" = dp."drug_id"
  AND (d."slug", dp."parameter", dp."value" ->> 'qualifier') IN (
    ('alprazolam', 'logPlogD', 'logP'),
    ('amphetamine', 'logPlogD', 'logP')
  )
  AND coalesce(dp."value" ->> 'note', '') ILIKE '%logp%';
--> statement-breakpoint

-- ── Morphine, whose qualifier claims BOTH measurements ─────────────────────
-- `logP/logD` says the stored range spans a computed logD7,4 and an octanol/
-- water logP — a wider claim than either row above, and one a note mentioning
-- only logP would no longer carry. So it needs both distinctions present, not
-- just the first: with logD gone from the note, the row falls through to the
-- sweep and keeps the combined label.
UPDATE "drug_parameters" AS dp
SET "value" = dp."value" - 'qualifier'
FROM "drugs" d
WHERE d."id" = dp."drug_id"
  AND d."slug" = 'morphine'
  AND dp."parameter" = 'logPlogD'
  AND dp."value" ->> 'qualifier' = 'logP/logD'
  AND coalesce(dp."value" ->> 'note', '') ILIKE '%logp%'
  AND coalesce(dp."value" ->> 'note', '') ILIKE '%logd%';
--> statement-breakpoint

-- ── Caffeine's pKa, where the qualifier is WRONG rather than redundant ──────
-- No note check here, deliberately, and it is the opposite reasoning: "amin"
-- names a group caffeine does not have, so preserving it under any label —
-- which is what falling through to the sweep would do — preserves an error in
-- the one field a reader sees. It goes whatever the note says now.
UPDATE "drug_parameters" AS dp
SET "value" = dp."value" - 'qualifier'
FROM "drugs" d
WHERE d."id" = dp."drug_id"
  AND d."slug" = 'caffeine'
  AND dp."parameter" = 'pKa'
  AND dp."value" ->> 'qualifier' = 'amin';
--> statement-breakpoint

-- ── Anything else carrying prose in the field ──────────────────────────────
-- Not seen here, so not judged here: the text is preserved verbatim under a
-- Norwegian label, and a curator can shorten it in a later edit. Skipped when
-- the fold would push `note` past its 500-character bound — see the header.
UPDATE "drug_parameters" AS dp
SET "value" = (dp."value" - 'qualifier')
  || jsonb_build_object(
       'note',
       btrim(
         coalesce(dp."value" ->> 'note', '')
         || ' (kvalifikator: ' || (dp."value" ->> 'qualifier') || ')'
       )
     )
WHERE jsonb_typeof(dp."value") = 'object'
  AND dp."value" ? 'qualifier'
  AND dp."value" ->> 'qualifier' <> ''
  AND dp."value" ->> 'qualifier' NOT IN ('<', '>', '≤', '≥')
  AND kinetix_0118_utf16_len(
        coalesce(dp."value" ->> 'note', '')
        || ' (kvalifikator: ' || (dp."value" ->> 'qualifier') || ')'
      ) <= 500;
--> statement-breakpoint

DROP FUNCTION IF EXISTS kinetix_0118_utf16_len(text);
