-- Topic-page atomic-fact discussions.
--
-- drug_parameter_discussions previously required a drug_id, which made it a
-- drug-only store. Topic (non-monograph) wiki pages have no drug, so their
-- atomic-fact discussion threads need a wiki_page_id host instead. We make
-- drug_id nullable, add a nullable wiki_page_id (ON DELETE CASCADE so deleting
-- a page reaps its fact threads), and constrain every row to exactly one host
-- (drug XOR page) via num_nonnulls. Existing rows all have drug_id set and
-- wiki_page_id null, so they already satisfy the check.

ALTER TABLE "drug_parameter_discussions" ALTER COLUMN "drug_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drug_parameter_discussions" ADD COLUMN IF NOT EXISTS "wiki_page_id" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "drug_parameter_discussions"
    ADD CONSTRAINT "drug_parameter_discussions_wiki_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("wiki_page_id") REFERENCES "wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_param_disc_page_param_idx" ON "drug_parameter_discussions" ("wiki_page_id","parameter");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "drug_parameter_discussions"
    ADD CONSTRAINT "drug_param_disc_target_chk"
    CHECK (num_nonnulls("drug_id", "wiki_page_id") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
