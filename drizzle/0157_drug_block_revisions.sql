-- Revision history for the monograph blocks that are curated as a whole
-- (#37): metabolism, pharmacodynamics (receptor-target mechanisms) and the PK
-- model structure. These are structured lists, not drug_parameters rows, so
-- drug_parameter_revisions has never recorded them and an admin's direct
-- write left no trace at all.
--
-- One row per change to one drug's block, with a self-contained before/after
-- snapshot. `old_value` is NULL only when the prior state was never recorded;
-- an empty block is an empty snapshot. `created_by` is NULL for a write made
-- by an operator script that runs without a user (seeders, importers), which
-- is still recorded rather than skipped. Nothing is backfilled: history starts
-- with the first write after this migration.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator (drizzle-orm/neon-http) sends each chunk as a prepared statement,
-- which accepts exactly one command.
CREATE TABLE IF NOT EXISTS "drug_block_revisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "drug_id" integer NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "block" varchar(40) NOT NULL,
  "old_value" jsonb,
  "new_value" jsonb NOT NULL,
  "pending_edit_id" integer REFERENCES "pending_edits"("id") ON DELETE SET NULL,
  "created_by" integer REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "drug_block_revisions_block_check"
    CHECK ("block" IN ('metabolism', 'pharmacodynamics', 'modelStructure'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_block_rev_drug_block_idx"
  ON "drug_block_revisions" ("drug_id", "block", "created_at");
