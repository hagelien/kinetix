-- Agent-generated quality reviews of cited scientific papers.
--
-- One current review per citation (unique on citation_id); the
-- paper-review-agent upserts on re-review. Review prose is Norwegian
-- (bokmål) markdown stored in review_markdown; the verdict fields mirror the
-- rubric in agents/kinectics_science_paper_review_agent_instructions.md.
-- Surfaced read-only on the reference page via GET /api/paper-reviews and
-- written via the contributor-gated POST on the same endpoint.

CREATE TABLE "paper_reviews" (
  "id" SERIAL PRIMARY KEY,
  "citation_id" INTEGER NOT NULL REFERENCES "citations"("id") ON DELETE CASCADE,
  "review_markdown" TEXT NOT NULL,
  "overall_score" INTEGER,
  "conclusion_support" VARCHAR(30),
  "review_confidence" VARCHAR(10),
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "paper_reviews_citation_idx" ON "paper_reviews" USING btree ("citation_id");
--> statement-breakpoint

CREATE INDEX "paper_reviews_created_at_idx" ON "paper_reviews" USING btree ("created_at");
