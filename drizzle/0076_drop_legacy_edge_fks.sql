-- #791 Part B step 4: drop the legacy edge FK columns.
--
-- Preconditions now all hold: the backfill was verified total (step 1), the
-- bio_entities invariant is enforced (step 2, migration 0074 — receptor edge
-- bio_entity_id NOT NULL, elimination-route enzyme_id/bio_entity_id CHECK), and
-- the legacy read fallback was removed from both stores (step 3). New rows have
-- left these columns NULL since the Phase 7 flip, so they are the last live
-- references from the edge tables to the legacy enzymes / receptor_targets
-- registries. The registry tables themselves are KEPT (open decision #1 —
-- compatibility; their eventual drop is step 6, after a soak).

-- drug_receptor_targets: the legacy (drug_id, receptor_target_id, interaction_type)
-- unique guard is superseded by drug_receptor_targets_bio_unique_idx (0068) on
-- (drug_id, bio_entity_id, interaction_type), which is now total because
-- bio_entity_id is NOT NULL (0074).
DROP INDEX IF EXISTS "drug_receptor_targets_unique_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "drug_receptor_targets_target_idx";
--> statement-breakpoint
ALTER TABLE "drug_receptor_targets" DROP COLUMN IF EXISTS "receptor_target_id";
--> statement-breakpoint
-- drug_elimination_routes: the enzyme_id/bio_entity_id CHECK (0074) and the
-- enzyme_id index are dropped with the column.
ALTER TABLE "drug_elimination_routes" DROP CONSTRAINT IF EXISTS "drug_elimination_routes_enzyme_bio_entity_chk";
--> statement-breakpoint
DROP INDEX IF EXISTS "drug_elimination_routes_enzyme_idx";
--> statement-breakpoint
ALTER TABLE "drug_elimination_routes" DROP COLUMN IF EXISTS "enzyme_id";
