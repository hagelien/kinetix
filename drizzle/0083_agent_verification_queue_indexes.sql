-- Oldest-first candidate scans for /api/agent-verifications-queue.
--
-- The queue asks each target table for its oldest rows below the age cutoff,
-- excluding targets already judged by the caller. Existing indexes covered
-- per-page/per-drug history reads, but not these global polling scans, so each
-- agent cycle could drift toward broad sorts as the audit history grows.
CREATE INDEX IF NOT EXISTS "drug_param_rev_created_idx"
  ON "drug_parameter_revisions" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_revisions_created_idx"
  ON "wiki_revisions" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_reviews_updated_at_idx"
  ON "paper_reviews" ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_param_disc_drug_created_idx"
  ON "drug_parameter_discussions" ("created_at")
  WHERE "drug_id" IS NOT NULL;
