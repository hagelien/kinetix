-- Add a GIN full-text-search index on wiki_pages.content_plaintext.
-- Without this, every wiki/search query forces a sequential scan with
-- to_tsvector() computed on every row. The expression index lets
-- PostgreSQL resolve @@ matches and ts_rank ordering using the prebuilt
-- tsvectors, reducing search cost from O(n) to O(log n).
--
-- The expression exactly mirrors the one in api/wiki/search.ts so
-- PostgreSQL automatically picks up the index for those queries without
-- any code changes.

CREATE INDEX IF NOT EXISTS "wiki_pages_fts_idx"
  ON "wiki_pages"
  USING gin (to_tsvector('english', coalesce("content_plaintext", '')));
