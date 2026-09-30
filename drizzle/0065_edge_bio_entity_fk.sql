-- Repoint the drug edge tables at the unified biological-entity registry
-- (#785, Phase 2). Additive: a nullable `bio_entity_id` is added alongside the
-- legacy `enzyme_id` / `receptor_target_id` columns and backfilled for existing
-- rows from `bio_entity_id_map` (built in Phase 1). The store layer dual-writes
-- the column for new rows; reads flip to prefer it in Phase 3. The legacy FK
-- columns and the crosswalk table are kept for now and dropped in Phase 7.

ALTER TABLE "drug_elimination_routes"
  ADD COLUMN "bio_entity_id" INTEGER REFERENCES "bio_entities"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "drug_receptor_targets"
  ADD COLUMN "bio_entity_id" INTEGER REFERENCES "bio_entities"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "drug_elimination_routes_bio_entity_idx"
  ON "drug_elimination_routes" ("bio_entity_id");
--> statement-breakpoint
CREATE INDEX "drug_receptor_targets_bio_entity_idx"
  ON "drug_receptor_targets" ("bio_entity_id");
--> statement-breakpoint
-- Backfill existing edge rows from the Phase 1 crosswalk.
UPDATE "drug_elimination_routes" r
SET "bio_entity_id" = m."entity_id"
FROM "bio_entity_id_map" m
WHERE m."source" = 'enzyme' AND m."source_id" = r."enzyme_id";
--> statement-breakpoint
UPDATE "drug_receptor_targets" t
SET "bio_entity_id" = m."entity_id"
FROM "bio_entity_id_map" m
WHERE m."source" = 'receptor_target' AND m."source_id" = t."receptor_target_id";
