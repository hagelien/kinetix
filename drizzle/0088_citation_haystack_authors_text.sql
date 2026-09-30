-- Rebuild the citation search haystack index so `authors` is indexed as the
-- text the UI shows, not as JSON.
--
-- `metadata->>'authors'` renders a jsonb array as JSON text — `["Huertas T",
-- "Aasen B"]`. The structural characters land between the names, so an author
-- list copied off a reference page (`authors.join(', ')` in
-- src/pages/ReferencePage.tsx) tokenized to `huertas`, `t,`, `aasen`, `b` and
-- the `t,` term matched nothing: the haystack held `T", ` and never `T, `.
-- `translate` deletes `[`, `]` and `"`, leaving `Huertas T, Aasen B`.
--
-- The expression MUST stay in sync with CITATION_HAYSTACK in
-- api/_lib/reference-search.ts — Postgres only uses an expression index when
-- the query repeats the expression verbatim, and a mismatch degrades silently
-- to a full scan on a public route rather than erroring. `translate` is
-- IMMUTABLE, so the expression is still indexable.
--
-- Built under a new name and the old index dropped afterwards, rather than
-- dropped and recreated in place: `CREATE INDEX IF NOT EXISTS` on the existing
-- name would find that name taken and silently keep the STALE expression, and
-- doing it in the other order leaves a window where no index serves search.

CREATE INDEX IF NOT EXISTS "citations_search_haystack_v2_trgm_idx"
  ON "citations" USING gin ((
    coalesce("identifier", '') || ' ' ||
    coalesce("metadata"->>'title', '') || ' ' ||
    translate(coalesce("metadata"->>'authors', ''), '[]"', '') || ' ' ||
    coalesce("metadata"->>'journal', '') || ' ' ||
    coalesce("metadata"->>'year', '') || ' ' ||
    coalesce("metadata"->>'volume', '') || ' ' ||
    coalesce("metadata"->>'pages', '')
  ) gin_trgm_ops);
--> statement-breakpoint
DROP INDEX IF EXISTS "citations_search_haystack_trgm_idx";
