-- Audit trail for direct citation metadata changes.
--
-- PATCH /api/references lets any contributor (agents included) overwrite a
-- citation's cached metadata — title, authors, `altIds` — straight on the row,
-- with no review. The route is a deliberate escape hatch, but nothing recorded
-- who changed what, so a wrong or malicious edit could be neither traced nor
-- reverted. One row per change, written before the change is applied.

CREATE TABLE IF NOT EXISTS "citation_metadata_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "citation_id" integer NOT NULL REFERENCES "citations"("id") ON DELETE CASCADE,
  "old_metadata" jsonb,
  "new_metadata" jsonb,
  "refreshed" boolean NOT NULL,
  "changed_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "citation_metadata_history_citation_idx"
  ON "citation_metadata_history" ("citation_id", "changed_at");
