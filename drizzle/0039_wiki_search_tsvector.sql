-- Add a stored generated tsvector column to wiki_pages.
--
-- The current GIN index is a functional index on to_tsvector(...). When a
-- search query uses ts_rank() for ordering, PostgreSQL must call to_tsvector()
-- again on each candidate row to compute the rank — even though the index
-- already did the same computation to answer the @@ predicate. For a wiki page
-- with thousands of words, one to_tsvector() call costs ~1–5 ms; with many
-- matching pages that scales up before the LIMIT is applied.
--
-- A GENERATED ALWAYS AS STORED column pre-computes the tsvector at write time
-- and persists it alongside the row. Both the GIN index (for @@ matching) and
-- ts_rank() (for ORDER BY) then read the stored value directly, eliminating
-- the per-candidate recomputation.
--
-- The column is maintained automatically by PostgreSQL on INSERT/UPDATE, so no
-- application-level sync is required. The search query in api/wiki/search.ts
-- references it by name via sql`search_tsvector`.

ALTER TABLE "wiki_pages"
  ADD COLUMN IF NOT EXISTS "search_tsvector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content_plaintext", ''))
  ) STORED;
--> statement-breakpoint
DROP INDEX IF EXISTS "wiki_pages_fts_idx";
--> statement-breakpoint
CREATE INDEX "wiki_pages_fts_idx" ON "wiki_pages" USING gin("search_tsvector");
