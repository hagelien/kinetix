-- Make a citation's alternate handles searchable (#1018).
--
-- One paper now occupies one row: the strongest handle (PMID > DOI > URL >
-- free text) goes in `citations.identifier`, and the handles it is NOT filed
-- under are kept in `metadata.altIds` so a write arriving under one of them
-- resolves to the same row instead of minting a second — the split that gave
-- one paper two independent `paper_reviews`, and therefore made the same
-- source admissible or inadmissible depending on which handle a seed declared.
--
-- A discarded handle is still what a user has in hand when they paste it into
-- search, so it has to be findable. The expression below adds the four altIds
-- keys to the v2 haystack (whose `translate` flattening of the authors array
-- 0088 introduced is kept verbatim) and MUST stay in sync with
-- CITATION_HAYSTACK in api/_lib/reference-search.ts — Postgres only uses an
-- expression index when the query repeats the expression verbatim, and a
-- mismatch degrades silently to a full scan on a public route rather than
-- erroring.
--
-- Built under a new name and the old index dropped afterwards, for the reason
-- 0088 gives: `CREATE INDEX IF NOT EXISTS` on the existing name would find that
-- name taken and silently keep the STALE expression, and doing it in the other
-- order leaves a window where no index serves search.
--
-- Every statement is separated by a statement-breakpoint marker: the
-- production migrator (drizzle-orm/neon-http) splits a migration file on that
-- marker and sends each chunk over Neon's HTTP endpoint as a prepared
-- statement, which accepts exactly one command.

CREATE INDEX IF NOT EXISTS "citations_search_haystack_v3_trgm_idx"
  ON "citations" USING gin ((
    coalesce("identifier", '') || ' ' ||
    coalesce("metadata"->>'title', '') || ' ' ||
    translate(coalesce("metadata"->>'authors', ''), '[]"', '') || ' ' ||
    coalesce("metadata"->>'journal', '') || ' ' ||
    coalesce("metadata"->>'year', '') || ' ' ||
    coalesce("metadata"->>'volume', '') || ' ' ||
    coalesce("metadata"->>'pages', '') || ' ' ||
    coalesce("metadata"->'altIds'->>'pmid', '') || ' ' ||
    coalesce("metadata"->'altIds'->>'doi', '') || ' ' ||
    coalesce("metadata"->'altIds'->>'pmcid', '') || ' ' ||
    coalesce("metadata"->'altIds'->>'url', '')
  ) gin_trgm_ops);
--> statement-breakpoint
DROP INDEX IF EXISTS "citations_search_haystack_v2_trgm_idx";
