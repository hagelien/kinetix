-- Trigram indexes for reference search (/api/references?view=search and the
-- reference index's `q` filter).
--
-- Search matches a pasted DOI/PubMed ID, a half-remembered title or author, or
-- a phrase from the agent's paper review — all as case-insensitive
-- `ILIKE '%…%'` predicates, which only a GIN trigram index can serve. pg_trgm
-- is already installed by 0008 (drug search); the CREATE EXTENSION here keeps
-- the migration self-contained.
--
-- Each term is evaluated as a UNION of two single-table scans (see
-- api/_lib/reference-search.ts) precisely so these two indexes are usable: a
-- predicate spanning both sides of a join can never be answered by an index.
--
-- The citations expression MUST stay character-for-character in sync with
-- CITATION_HAYSTACK in api/_lib/reference-search.ts — Postgres only uses an
-- expression index when the query repeats the expression verbatim. It is built
-- with `||` rather than concat_ws() because concat_ws is merely STABLE and so
-- is rejected in an index expression.
--
-- Every statement is separated by a statement-breakpoint marker: the
-- production migrator (drizzle-orm/neon-http) splits a migration file on that
-- marker and sends each chunk over Neon's HTTP endpoint as a prepared
-- statement, which accepts exactly one command. A chunk holding two commands
-- fails at deploy time with `cannot insert multiple commands into a prepared
-- statement`. (Do not write the marker text into prose — the split is a plain
-- string split and would cut the comment in half.)

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citations_search_haystack_trgm_idx"
  ON "citations" USING gin ((
    coalesce("identifier", '') || ' ' ||
    coalesce("metadata"->>'title', '') || ' ' ||
    coalesce("metadata"->>'authors', '') || ' ' ||
    coalesce("metadata"->>'journal', '') || ' ' ||
    coalesce("metadata"->>'year', '') || ' ' ||
    coalesce("metadata"->>'volume', '') || ' ' ||
    coalesce("metadata"->>'pages', '')
  ) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_reviews_markdown_trgm_idx"
  ON "paper_reviews" USING gin ("review_markdown" gin_trgm_ops);
