-- Repoint Efedrin from PubChem CID 9294 to CID 5032.
--
-- Both CIDs are ephedrine: 9294 is the (1R,2S) stereoisomer, 5032 is
-- `DL-Ephedrine`, the racemate. Same formula, same molecular weight (165.23).
-- Kinetix standardizes on the racemate, and production was merged onto 5032 by
-- hand. This migration is what carries that decision to every other database.
--
-- Without it, `scripts/seed-drugs.ts` ABORTS on any database still holding 9294.
-- The seeder slugs from `nameEn` ('Ephedrine' -> 'ephedrine') and its upsert
-- arbitrates on `drugs.pubchem_cid` alone, so an insert of (slug 'ephedrine',
-- cid 5032) finds no CID conflict, the ON CONFLICT clause never fires, and the
-- separate unique index on `drugs.slug` raises instead. That takes down the
-- whole seed transaction, including the analytical-method wiring that runs
-- after it.
--
-- Deliberately an UPDATE of the existing row, not a merge. Nothing else moves:
-- the row keeps its id, so all 16 tables referencing `drugs.id` — analytical
-- method components, parameters, entries, the postmortem distribution — stay
-- attached. Only the substance's PubChem identity changes, which is the only
-- thing that was wrong.
--
-- The NOT EXISTS guard covers the database that already holds BOTH rows (one
-- from this fixture, one created by the PM concentration seeder). There the
-- statement is a no-op by design: two rows for one substance is a genuine
-- duplicate needing the same human decision production got, and picking a
-- survivor here would move parameter values and method memberships nobody
-- reviewed. That case does not need rescuing anyway — with a 5032 row present
-- the seeder's arbiter matches, the insert converts to an update that never
-- touches `slug`, and the seed completes.
--
-- The monograph link is the one thing that does NOT ride along on the row id,
-- and so has to move with the identity. `wiki_pages.drug_cid` is mixed-vintage:
-- `ensureDrugMonograph` writes `drugs.id`, but the older
-- `scripts/seed-drug-monographs.ts` wrote the PubChem CID, and both
-- `ensureDrugMonograph` and `GET /api/drugs?wikiDrugId=` resolve either. A
-- legacy row therefore points at 9294, and changing the drug's CID alone would
-- strand it — the monograph silently detaches and the next backfill creates a
-- SECOND, empty one beside the written page.
--
-- Written as a data-modifying CTE so the repoint is bound to the row the UPDATE
-- actually touched. Reading `pubchem_cid = 5032` back in a separate statement
-- would, in the both-rows case above, find the OTHER drug and move the
-- monograph onto it.
--
-- The `id = 9294` guard mirrors `resolveMonographDrugCids`: a drug_cid that is
-- some unrelated drug's internal id is that drug's modern link, not this one's
-- legacy link, and adopting it would steal a monograph.
--
-- Idempotent, and a no-op on production, which has no 9294 row left and whose
-- Efedrin monograph already stores the internal id.
WITH "repointed" AS (
  UPDATE "drugs"
  SET "pubchem_cid" = 5032,
      "updated_at" = now()
  WHERE "pubchem_cid" = 9294
    AND NOT EXISTS (
      SELECT 1 FROM "drugs" AS "existing" WHERE "existing"."pubchem_cid" = 5032
    )
  RETURNING "id"
)
UPDATE "wiki_pages"
SET "drug_cid" = "repointed"."id",
    "updated_at" = now()
FROM "repointed"
WHERE "wiki_pages"."page_type" = 'drug_monograph'
  AND "wiki_pages"."drug_cid" = 9294
  AND NOT EXISTS (SELECT 1 FROM "drugs" WHERE "id" = 9294);
