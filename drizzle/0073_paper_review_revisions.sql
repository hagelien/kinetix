-- Paper review re-review history. Paper reviews now auto-publish (they no
-- longer pass through the /review queue) and are re-reviewable: an agent may
-- edit an existing review, and every write appends one row here so humans and
-- agents can see, per reference, WHAT changed and WHY. Mirrors
-- learning_unit_revisions. The snapshot is self-contained; `edit_summary`
-- carries the author's reason for the change.

CREATE TABLE IF NOT EXISTS "paper_review_revisions" (
  "id"                 SERIAL PRIMARY KEY,
  "paper_review_id"    INTEGER NOT NULL REFERENCES "paper_reviews"("id") ON DELETE CASCADE,
  "citation_id"        INTEGER NOT NULL REFERENCES "citations"("id") ON DELETE CASCADE,
  "review_markdown"    TEXT NOT NULL,
  "overall_score"      INTEGER,
  "conclusion_support" VARCHAR(30),
  "review_confidence"  VARCHAR(10),
  "read_in_full"       BOOLEAN NOT NULL DEFAULT false,
  "edit_summary"       VARCHAR(500),
  "created_by"         INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"         TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_review_rev_citation_idx"
  ON "paper_review_revisions" ("citation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_review_rev_review_idx"
  ON "paper_review_revisions" ("paper_review_id", "created_at");
--> statement-breakpoint

-- Drain any in-flight paper_review pending edits into live reviews. Because
-- reviews now auto-publish and the /review paper-review tab is being removed,
-- a still-queued review must not linger invisibly. Upsert on citation_id (one
-- current review per citation); the unique open-paper-review index guarantees
-- at most one open edit per citation, so the SELECT never hits the same
-- citation twice in a single INSERT.
INSERT INTO "paper_reviews" (
  "citation_id", "review_markdown", "overall_score",
  "conclusion_support", "review_confidence", "read_in_full", "created_by"
)
SELECT pe."target_id",
       pe."proposed_value"->>'reviewMarkdown',
       NULLIF(pe."proposed_value"->>'overallScore', '')::integer,
       pe."proposed_value"->>'conclusionSupport',
       pe."proposed_value"->>'reviewConfidence',
       COALESCE((pe."proposed_value"->>'readInFull')::boolean, false),
       pe."submitted_by"
FROM "pending_edits" pe
WHERE pe."edit_type" = 'paper_review'
  AND pe."status" = 'pending'
  AND pe."target_id" IS NOT NULL
  AND (pe."proposed_value"->>'reviewMarkdown') IS NOT NULL
ON CONFLICT ("citation_id") DO UPDATE SET
  "review_markdown"    = EXCLUDED."review_markdown",
  "overall_score"      = EXCLUDED."overall_score",
  "conclusion_support" = EXCLUDED."conclusion_support",
  "review_confidence"  = EXCLUDED."review_confidence",
  "read_in_full"       = EXCLUDED."read_in_full",
  "created_by"         = EXCLUDED."created_by",
  "updated_at"         = NOW();
--> statement-breakpoint
UPDATE "pending_edits"
SET "status" = 'approved', "reviewed_at" = NOW()
WHERE "edit_type" = 'paper_review' AND "status" = 'pending';
--> statement-breakpoint

-- Seed history for every existing/drained review so the revision log has a
-- starting point. edit_summary is NULL to mark the imported baseline.
INSERT INTO "paper_review_revisions" (
  "paper_review_id", "citation_id", "review_markdown", "overall_score",
  "conclusion_support", "review_confidence", "read_in_full",
  "edit_summary", "created_by", "created_at"
)
SELECT pr."id", pr."citation_id", pr."review_markdown", pr."overall_score",
       pr."conclusion_support", pr."review_confidence", pr."read_in_full",
       NULL, pr."created_by", pr."updated_at"
FROM "paper_reviews" pr
WHERE NOT EXISTS (
  SELECT 1 FROM "paper_review_revisions" prr
  WHERE prr."paper_review_id" = pr."id"
);
