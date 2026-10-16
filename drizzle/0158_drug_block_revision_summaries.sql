-- Preserve the author's rationale in the revision itself, independently of
-- pending_edits retention. Direct writes have no proposal to recover it from.
ALTER TABLE "drug_block_revisions" ADD COLUMN IF NOT EXISTS "edit_summary" text;
--> statement-breakpoint
UPDATE "drug_block_revisions" r
SET "edit_summary" = p."proposed_meta" ->> 'editSummary'
FROM "pending_edits" p
WHERE r."pending_edit_id" = p."id"
  AND r."edit_summary" IS NULL
  AND jsonb_typeof(p."proposed_meta" -> 'editSummary') = 'string';
