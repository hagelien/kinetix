-- Catalog identity flip (#785, Phase 7). The metabolism/PD edit paths now
-- resolve against bio_entities, so a new mechanism row may have only a
-- bio_entity_id and no legacy receptor_target_id. Drop the NOT NULL and add a
-- unified-id uniqueness guard. The legacy receptor_target_id / enzyme_id
-- columns and the enzymes / receptor_targets tables are KEPT (open decision #1:
-- compatibility), populated on old rows and simply left null on new ones.

ALTER TABLE "drug_receptor_targets"
  ALTER COLUMN "receptor_target_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "drug_receptor_targets_bio_unique_idx"
  ON "drug_receptor_targets" ("drug_id", "bio_entity_id", "interaction_type")
  WHERE "bio_entity_id" IS NOT NULL;
