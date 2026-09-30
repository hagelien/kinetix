-- Issue #284: Atomic-fact contributions on pending_edits.
--
-- Adds the columns needed to represent a single-fact submission/edit:
--   * section_id           → which monograph section the fact belongs to
--   * field_id             → optional sub-field within the section
--   * fact_statement       → the normalized claim (≤ ~400 chars, enforced by API)
--   * fact_operation       → 'add' | 'replace' | 'remove'
--   * fact_target_anchor   → JSON anchor identifying the existing fact node
--                            for replace/remove ops (typically { factId })
--
-- All columns are nullable so the legacy editTypes (parameter, wiki_page,
-- wiki_new) keep working unchanged. The new editType 'wiki_fact' is enforced
-- at the API layer rather than via a CHECK constraint.
--
-- Index on (target_id, section_id) supports the conflict-detection lookup:
-- when one wiki_fact is approved, we need to find other pending facts on the
-- same page+section quickly.

ALTER TABLE "pending_edits" ADD COLUMN "section_id" VARCHAR(40);
--> statement-breakpoint
ALTER TABLE "pending_edits" ADD COLUMN "field_id" VARCHAR(60);
--> statement-breakpoint
ALTER TABLE "pending_edits" ADD COLUMN "fact_statement" TEXT;
--> statement-breakpoint
ALTER TABLE "pending_edits" ADD COLUMN "fact_operation" VARCHAR(20);
--> statement-breakpoint
ALTER TABLE "pending_edits" ADD COLUMN "fact_target_anchor" JSONB;
--> statement-breakpoint
CREATE INDEX "pending_edits_section_idx"
  ON "pending_edits" USING btree ("target_id", "section_id");
