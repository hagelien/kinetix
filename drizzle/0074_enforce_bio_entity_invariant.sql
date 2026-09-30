-- #791 Part B step 2: enforce the bio_entities invariant now that the backfill
-- is verified total in production (`npm run verify:bio-backfill` → clean).
--
-- drug_receptor_targets always resolves to a bio_entity (receptor_target_id is
-- left null on Phase 7 rows), so the unified FK is now mandatory. Its existing
-- ON DELETE SET NULL action cannot coexist with NOT NULL, so re-create it as
-- ON DELETE RESTRICT: a catalog entity referenced by a drug's PD profile can no
-- longer be silently deleted — the admin must clear the relationships first.
ALTER TABLE "drug_receptor_targets"
  DROP CONSTRAINT "drug_receptor_targets_bio_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE "drug_receptor_targets"
  ALTER COLUMN "bio_entity_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "drug_receptor_targets"
  ADD CONSTRAINT "drug_receptor_targets_bio_entity_id_fkey"
  FOREIGN KEY ("bio_entity_id") REFERENCES "bio_entities"("id") ON DELETE RESTRICT;
--> statement-breakpoint
-- drug_elimination_routes.bio_entity_id is legitimately null for non-enzyme and
-- unmatched-enzyme routes, so it cannot be NOT NULL. The invariant that keeps
-- the legacy enzymes read fallback provably dead is narrower: no route may carry
-- a legacy enzyme_id without a bio_entity_id. Phase 7 writes always leave
-- enzyme_id null, so this holds going forward.
ALTER TABLE "drug_elimination_routes"
  ADD CONSTRAINT "drug_elimination_routes_enzyme_bio_entity_chk"
  CHECK (NOT ("enzyme_id" IS NOT NULL AND "bio_entity_id" IS NULL));
