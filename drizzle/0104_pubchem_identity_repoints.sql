-- Repoint two drugs whose `pubchem_cid` named a different record than the drug.
--
--   Eslikarbazepin  195085 -> 9881504
--   Skopolamin     3000322 -> 5184
--
-- Both were found by `npm run audit:pubchem-identity`, which resolves every
-- stored CID against PubChem and compares the InChIKey skeleton. 195085 is a
-- GlyTouCan glycan record (C22H36N2O17) — not this substance at all. 3000322 is
-- a depositor record ("Boro-Scopol") rather than scopolamine's parent entry,
-- which is why the catalog grew two scopolamine rows.
--
-- `data/components.ts` already carries the corrected numbers. This migration is
-- what carries that correction to a database seeded before it.
--
-- Without it, `scripts/seed-drugs.ts` ABORTS on any database still holding the
-- old CID, for exactly the reason documented in
-- `0103_efedrin_racemate_cid.sql`: the seeder slugs from `nameEn`
-- ('Eslicarbazepine' -> 'eslicarbazepine') and its upsert arbitrates on
-- `drugs.pubchem_cid` alone. An insert of (slug 'eslicarbazepine', cid 9881504)
-- finds no CID conflict, the ON CONFLICT clause never fires, and the separate
-- unique index on `drugs.slug` raises instead — taking down the whole seed
-- transaction, including the analytical-method wiring that runs after it.
--
-- Deliberately an UPDATE of the existing row, not a merge. The row keeps its
-- id, so all 16 tables referencing `drugs.id` stay attached. Only the PubChem
-- identity changes, which is the only thing that was wrong.
--
-- The NOT EXISTS guard covers a database that already holds BOTH rows. There
-- the statement is a no-op by design: two rows for one substance is a genuine
-- duplicate needing a human decision about which parameter values and method
-- memberships survive, and picking a winner here would move data nobody
-- reviewed. `scripts/merge-drugs.ts --adopt-cid` is the reviewed path for that,
-- and production is that case for scopolamine — it holds both 3000322 and 5184
-- today, so the second statement pair below is expected to be a no-op there.
-- Such a database does not need rescuing anyway: with the new CID present the
-- seeder's arbiter matches, the insert converts to an update that never touches
-- `slug`, and the seed completes.
--
-- `wiki_pages.drug_cid` is the one link that does NOT ride along on the row id.
-- It is mixed-vintage: `ensureDrugMonograph` writes `drugs.id`, but the older
-- `scripts/seed-drug-monographs.ts` wrote the PubChem CID, and both
-- `ensureDrugMonograph` and `GET /api/drugs?wikiDrugId=` resolve either. A
-- legacy row therefore points at the old CID, and changing the drug's identity
-- alone would strand it — the monograph silently detaches and the next backfill
-- creates a SECOND, empty one beside the written page.
--
-- Each repoint is a data-modifying CTE so the monograph moves onto the row the
-- UPDATE actually touched. Reading the new CID back in a separate statement
-- would, in the both-rows case, find the OTHER drug and move the monograph onto
-- it. The `id = <old cid>` guard mirrors `resolveMonographDrugCids`: a drug_cid
-- that is some unrelated drug's internal id is that drug's modern link, not
-- this one's legacy link, and adopting it would steal a monograph.
--
-- Saved simulator cases are the other thing that does not ride along on the row
-- id, and the one with teeth. `case_data.drugs[].drugId` is
-- `String(pubchemCid ?? id)`, and `hydrateComponentByRouteId` resolves it as a
-- CID FIRST and falls back to an internal id. So a case saved before the
-- repoint keeps the old number, and afterwards it does not merely fail to
-- hydrate — if any drug's internal id equals that number, the case silently
-- loads an UNRELATED substance under the saved case's name. Each repoint gets a
-- second statement rewriting those keys, the way `retarget-pubchem-cid.ts` does.
--
-- Each repoint is therefore ONE statement: the drug, its legacy monograph and
-- its saved cases move together or not at all. That is not a stylistic choice.
-- `apply-migrations-build.ts` uses drizzle's neon-http migrator, which splits
-- on the statement-breakpoint marker (not written out here — the splitter is a
-- plain string search and would cut this comment in half) and sends each chunk
-- over Neon's HTTP endpoint as its own prepared statement, committed
-- independently, with no surrounding transaction to roll back into. Split
-- across a breakpoint, a failure between the two chunks leaves the CID moved
-- and the cases pinned to the retired number, which is exactly the
-- wrong-substance state this is all about.
--
-- That rewrite is conditional on two things:
--
--   * the repoint actually happened, read from the CTE. It CANNOT be tested as
--     "no drug carries the old CID any more": every sub-select in the statement
--     sees the snapshot taken before the CTE ran, so `drugs` still shows the
--     old CID and such a guard would suppress the rewrite outright. In the
--     both-rows case the CTE updates nothing, so the rewrite does not fire and
--     the cases keep pointing at the row that still resolves them.
--   * the old number is not ALSO some CID-less drug's internal id. If it is,
--     the key names two substances and the rewrite cannot tell which cases mean
--     which; `retarget-pubchem-cid.ts` refuses outright on that.
--
-- That second condition has to gate the REPOINT, not just the rewrite. Skipping
-- only the rewrite would be the worst of both: the drug's identity moves, the
-- cases keep the retired number, the CID lookup now finds nothing, and the
-- id fallback hands them the namesake — the silent wrong-substance load this
-- whole exercise is about, manufactured by the fix for it. So when the number
-- is ambiguous AND saved cases actually use it, the drug is left alone
-- entirely, for the same reason the retarget script refuses: give the CID-less
-- drug a CID first, then run `npm run retarget:cid`, which can report what it
-- declined. A database in that state is left needing the correction, and
-- `seed:drugs` will keep aborting on it until someone runs the script — which
-- is the loud outcome, and better than a quiet wrong answer.
--
-- The NEW number needs its own shadow check, and this one is UNCONDITIONAL.
-- If some CID-less drug's internal id equals the CID being adopted, then
-- `drugRowToComponent` keys that drug by this very number, and taking it as a
-- PubChem identity makes the CID lookup win: every saved case for that drug
-- loads the repointed substance instead. Unlike the old-number guard above,
-- there is no "only when cases exist today" version of this — the other drug
-- still has no CID afterwards, so the first case anyone saves for it later
-- resolves here too. A guard scoped to existing rows would be a guard against
-- the past. `retarget-pubchem-cid.ts` refuses outright on the same condition
-- and says which drug to give a CID first; the migration simply declines.
--
-- `updated_at` is deliberately left alone on the cases: nobody edited them, and
-- moving the timestamp would misreport that in every case list.
--
-- Idempotent. Re-running finds no row at the old CID and does nothing.

-- Eslikarbazepin: 195085 (GlyTouCan glycan) -> 9881504 (eslicarbazepine).
WITH "repointed" AS (
  UPDATE "drugs"
  SET "pubchem_cid" = 9881504,
      "updated_at" = now()
  WHERE "pubchem_cid" = 195085
    AND NOT EXISTS (
      SELECT 1 FROM "drugs" AS "existing" WHERE "existing"."pubchem_cid" = 9881504
    )
    AND NOT EXISTS (
      SELECT 1 FROM "drugs" WHERE "id" = 9881504 AND "pubchem_cid" IS NULL
    )
    AND NOT (
      EXISTS (
        SELECT 1 FROM "drugs" WHERE "id" = 195085 AND "pubchem_cid" IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM "simulator_cases"
        WHERE "case_data"->'drugs' @> '[{"drugId":"195085"}]'::jsonb
      )
    )
  RETURNING "id"
),
-- Executed even though nothing selects from it: PostgreSQL runs every
-- data-modifying CTE exactly once, to completion, whether or not the primary
-- query reads its output. Do not "clean this up" into a separate statement —
-- that is precisely the split this migration was restructured to remove.
"monograph" AS (
  UPDATE "wiki_pages"
  SET "drug_cid" = "repointed"."id",
      "updated_at" = now()
  FROM "repointed"
  WHERE "wiki_pages"."page_type" = 'drug_monograph'
    AND "wiki_pages"."drug_cid" = 195085
    AND NOT EXISTS (SELECT 1 FROM "drugs" WHERE "id" = 195085)
  RETURNING "wiki_pages"."id"
)
UPDATE "simulator_cases"
SET "case_data" = jsonb_set(
  "case_data",
  '{drugs}',
  (SELECT jsonb_agg(
     CASE WHEN "d"->>'drugId' = '195085'
          THEN jsonb_set("d", '{drugId}', to_jsonb('9881504'::text))
          ELSE "d" END)
   FROM jsonb_array_elements("case_data"->'drugs') AS "d")
)
WHERE "case_data"->'drugs' @> '[{"drugId":"195085"}]'::jsonb
  -- Gated on the CTE, NOT on "no drug carries 195085 any more". Every
  -- sub-select in this statement reads the snapshot taken before the CTE ran,
  -- so `drugs` still shows the old CID here and a snapshot-based guard would
  -- suppress the rewrite outright.
  AND EXISTS (SELECT 1 FROM "repointed");
--> statement-breakpoint
-- Skopolamin: 3000322 ("Boro-Scopol" depositor record) -> 5184 (scopolamine).
-- A no-op on production, which still holds the 3000322 row for `--adopt-cid` to
-- merge away — the merge rewrites these keys itself.
WITH "repointed" AS (
  UPDATE "drugs"
  SET "pubchem_cid" = 5184,
      "updated_at" = now()
  WHERE "pubchem_cid" = 3000322
    AND NOT EXISTS (
      SELECT 1 FROM "drugs" AS "existing" WHERE "existing"."pubchem_cid" = 5184
    )
    AND NOT EXISTS (
      SELECT 1 FROM "drugs" WHERE "id" = 5184 AND "pubchem_cid" IS NULL
    )
    AND NOT (
      EXISTS (
        SELECT 1 FROM "drugs" WHERE "id" = 3000322 AND "pubchem_cid" IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM "simulator_cases"
        WHERE "case_data"->'drugs' @> '[{"drugId":"3000322"}]'::jsonb
      )
    )
  RETURNING "id"
),
-- Executed even though nothing selects from it: PostgreSQL runs every
-- data-modifying CTE exactly once, to completion, whether or not the primary
-- query reads its output. Do not "clean this up" into a separate statement —
-- that is precisely the split this migration was restructured to remove.
"monograph" AS (
  UPDATE "wiki_pages"
  SET "drug_cid" = "repointed"."id",
      "updated_at" = now()
  FROM "repointed"
  WHERE "wiki_pages"."page_type" = 'drug_monograph'
    AND "wiki_pages"."drug_cid" = 3000322
    AND NOT EXISTS (SELECT 1 FROM "drugs" WHERE "id" = 3000322)
  RETURNING "wiki_pages"."id"
)
UPDATE "simulator_cases"
SET "case_data" = jsonb_set(
  "case_data",
  '{drugs}',
  (SELECT jsonb_agg(
     CASE WHEN "d"->>'drugId' = '3000322'
          THEN jsonb_set("d", '{drugId}', to_jsonb('5184'::text))
          ELSE "d" END)
   FROM jsonb_array_elements("case_data"->'drugs') AS "d")
)
WHERE "case_data"->'drugs' @> '[{"drugId":"3000322"}]'::jsonb
  -- Gated on the CTE, NOT on "no drug carries 3000322 any more". Every
  -- sub-select in this statement reads the snapshot taken before the CTE ran,
  -- so `drugs` still shows the old CID here and a snapshot-based guard would
  -- suppress the rewrite outright.
  AND EXISTS (SELECT 1 FROM "repointed");
