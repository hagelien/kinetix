-- Subcutaneous, transdermal and buccal administration routes (#81).
--
-- `parameter_entries.route` (0111, CV-2c) admitted eight routes, none of them
-- subcutaneous, transdermal or buccal. A subcutaneous depot (buprenorphine
-- CAM2038) or a patch (fentanyl, buprenorphine) therefore had nowhere to be
-- filed but `other`, or no route at all with the route written into the prose.
-- This widens the CHECK to the kinetics-core `ROUTE_IDS` vocabulary, which now
-- carries all three; `src/lib/modelStructureVocabulary.test.ts` reads the
-- newest definition of this constraint and holds it equal to `ROUTE_IDS`.
--
-- Existing rows are NOT rewritten. Whether an `other` entry, or a route-less
-- entry whose comments mention a patch or a subcutaneous dose, is really one of
-- the new routes is a reading of its source, and a pattern match cannot make
-- it: "transdermal" in a comment may describe a comparison arm, and a route-less
-- bioavailability is a drug-level value that a route tag would move out of the
-- drug-level pool. So the candidates are queued instead, as parameter priority
-- flags — the maintenance queue 0098 used for the same purpose — naming the
-- entries to look at. A re-tag then goes through an ordinary reviewed entry
-- edit, and a flag is resolved the way every flag is.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_route_vocabulary";
--> statement-breakpoint

-- NULL passes, exactly as in 0111: NULL is the legitimate drug-level value.
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_route_vocabulary"
  CHECK (
    "route" IS NULL
    OR "route" IN (
      'oral', 'intranasal', 'iv', 'im', 'subcutaneous', 'sublingual', 'buccal',
      'rectal', 'transdermal', 'inhalation', 'other'
    )
  );
--> statement-breakpoint

-- The re-tag queue. A candidate is an entry for a parameter that can carry a
-- route (`bioavailability`, `tmax`, `cmax`, `ka`, `absorptionModel` — the
-- registry's route-scoped and route-optional ids, held in step with this list
-- by the 0151 integration test) that EITHER is tagged `other`, OR has no route
-- and names one of the new routes in its prose. One flag per (drug, parameter),
-- as the flag API keeps it; the note lists up to 25 entry ids. The note is
-- Norwegian, like all stored content a migration writes (AGENTS.md).
--
-- A pair that already has an active flag gets no second one here; the next
-- statement appends this note to that flag instead. Both statements skip a
-- flag already carrying the marker `(migrering 0151)`, so a re-run adds
-- nothing.
WITH "candidates" AS (
  SELECT
    pe."drug_id",
    pe."parameter",
    array_agg(pe."id" ORDER BY pe."id") AS "ids"
  FROM "parameter_entries" pe
  WHERE pe."parameter" IN ('bioavailability', 'tmax', 'cmax', 'ka', 'absorptionModel')
    AND (
      pe."route" = 'other'
      OR (
        pe."route" IS NULL
        AND concat_ws(' ', pe."comments", pe."observation_context", pe."source_quote")
          ~* '(subkutan|subcutan|\ms\.c\.|\msc\M|transderm|plaster|\mpatch|bukkal|buccal)'
      )
    )
  GROUP BY pe."drug_id", pe."parameter"
)
INSERT INTO "parameter_priority_flags" ("drug_id", "parameter", "status", "note")
SELECT
  c."drug_id",
  c."parameter",
  'active',
  format(
    'Administrasjonsvei til vurdering (migrering 0151): kildeoppføring #%s har ruten «other» eller nevner subkutan, transdermal eller bukkal tilførsel i teksten%s. Rutene subcutaneous, transdermal og buccal finnes nå. Foreslå ny rute for oppføringen der en av dem passer kilden, og la den stå ellers.',
    array_to_string(c."ids"[1:25], ', #'),
    CASE WHEN cardinality(c."ids") > 25
      THEN format(' (og %s til)', cardinality(c."ids") - 25)
      ELSE ''
    END
  )
FROM "candidates" c
WHERE NOT EXISTS (
  SELECT 1
  FROM "parameter_priority_flags" f
  WHERE f."drug_id" = c."drug_id"
    AND f."parameter" = c."parameter"
    AND f."status" = 'active'
);
--> statement-breakpoint

-- A pair with an active flag raised before this migration keeps that flag, and
-- the re-tag request is appended to its note (the flag API keeps one active
-- flag per pair, so a second would be folded into it anyway).
WITH "candidates" AS (
  SELECT
    pe."drug_id",
    pe."parameter",
    array_agg(pe."id" ORDER BY pe."id") AS "ids"
  FROM "parameter_entries" pe
  WHERE pe."parameter" IN ('bioavailability', 'tmax', 'cmax', 'ka', 'absorptionModel')
    AND (
      pe."route" = 'other'
      OR (
        pe."route" IS NULL
        AND concat_ws(' ', pe."comments", pe."observation_context", pe."source_quote")
          ~* '(subkutan|subcutan|\ms\.c\.|\msc\M|transderm|plaster|\mpatch|bukkal|buccal)'
      )
    )
  GROUP BY pe."drug_id", pe."parameter"
)
UPDATE "parameter_priority_flags" f
SET "note" = concat_ws(
  E'\n\n',
  NULLIF(f."note", ''),
  format(
    'Administrasjonsvei til vurdering (migrering 0151): kildeoppføring #%s har ruten «other» eller nevner subkutan, transdermal eller bukkal tilførsel i teksten%s. Rutene subcutaneous, transdermal og buccal finnes nå. Foreslå ny rute for oppføringen der en av dem passer kilden, og la den stå ellers.',
    array_to_string(c."ids"[1:25], ', #'),
    CASE WHEN cardinality(c."ids") > 25
      THEN format(' (og %s til)', cardinality(c."ids") - 25)
      ELSE ''
    END
  )
)
FROM "candidates" c
WHERE f."drug_id" = c."drug_id"
  AND f."parameter" = c."parameter"
  AND f."status" = 'active'
  AND position('(migrering 0151)' IN coalesce(f."note", '')) = 0;
