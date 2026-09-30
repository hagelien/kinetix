-- Expand the wiki full-text search GIN index to include the page title.
-- Previously the index only covered content_plaintext, so title matches
-- required an unindexed ILIKE '%q%' sequential scan on every search query.
-- Including title in the tsvector expression lets the single GIN index
-- handle both title and body matches, avoiding the fallback for ordinary
-- ASCII prose queries.
DROP INDEX IF EXISTS "wiki_pages_fts_idx";
--> statement-breakpoint
CREATE INDEX "wiki_pages_fts_idx" ON "wiki_pages" USING gin(
  to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content_plaintext", ''))
);
