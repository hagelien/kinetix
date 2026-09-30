-- Entity monographs (#785, Phase 5). A bio_entity (CYP3A4, a receptor, …) gets
-- its own narrative wiki article instead of being shoe-horned into a fake drug
-- monograph. An entity monograph is a wiki_pages row with
-- page_type='entity_monograph' linked to bio_entities via entity_id; it reuses
-- the topic-page content/fact/section machinery.

ALTER TABLE "wiki_pages"
  ADD COLUMN "entity_id" INTEGER REFERENCES "bio_entities"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "wiki_pages_entity_id_idx" ON "wiki_pages" ("entity_id");
