ALTER TABLE "drug_parameter_revisions" ADD COLUMN "reference_ids" integer[];--> statement-breakpoint
ALTER TABLE "pending_edits" ADD COLUMN "reference_ids" integer[];--> statement-breakpoint
UPDATE "drug_parameter_revisions" SET "reference_ids" = ARRAY["reference_id"] WHERE "reference_id" IS NOT NULL AND "reference_ids" IS NULL;--> statement-breakpoint
UPDATE "pending_edits" SET "reference_ids" = ARRAY["reference_id"] WHERE "reference_id" IS NOT NULL AND "reference_ids" IS NULL;
