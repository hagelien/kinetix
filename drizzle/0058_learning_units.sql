-- Kinetix Learn Phase A: source-anchored learning units + revision history.
-- A unit is anchored to a citation that already carries a read-in-full
-- paper_review (gate enforced at submit time). Revisions mirror
-- wiki_revisions so agent peer-verification can target an approved revision.

CREATE TABLE IF NOT EXISTS "learning_units" (
  "id"          SERIAL PRIMARY KEY,
  "citation_id" INTEGER NOT NULL REFERENCES "citations"("id") ON DELETE RESTRICT,
  "slug"        VARCHAR(300) NOT NULL UNIQUE,
  "title"       VARCHAR(500) NOT NULL,
  "content"     JSONB NOT NULL,
  "difficulty"  VARCHAR(30) NOT NULL,
  "domains"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status"      VARCHAR(20) NOT NULL DEFAULT 'published',
  "created_by"  INTEGER NOT NULL REFERENCES "users"("id"),
  "updated_by"  INTEGER REFERENCES "users"("id"),
  "created_at"  TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_units_citation_idx"
  ON "learning_units" ("citation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_units_difficulty_idx"
  ON "learning_units" ("difficulty");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_unit_revisions" (
  "id"              SERIAL PRIMARY KEY,
  "unit_id"         INTEGER NOT NULL REFERENCES "learning_units"("id") ON DELETE CASCADE,
  "content"         JSONB NOT NULL,
  "edit_summary"    VARCHAR(500),
  "pending_edit_id" INTEGER REFERENCES "pending_edits"("id") ON DELETE SET NULL,
  "created_by"      INTEGER NOT NULL REFERENCES "users"("id"),
  "created_at"      TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_unit_rev_unit_idx"
  ON "learning_unit_revisions" ("unit_id", "created_at");
