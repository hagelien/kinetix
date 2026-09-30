-- Index the alternate-handle lookup the citation write path performs (#1018).
--
-- `resolveCitation` looks a paper up under every handle it is known by before
-- inserting. That lookup now also asks whether an existing row carries the
-- incoming handle in `metadata.altIds`, because the PMID<->DOI crosswalk is a
-- best-effort network call: when NCBI is unavailable an incoming paper is known
-- by its DOI alone, and a row filed under its PMID would otherwise not be found
-- by a columns-only comparison — re-creating the one-paper-two-rows split for
-- as long as the outage lasts.
--
-- Without these indexes that arm is an equality test on a JSON expression with
-- nothing to serve it, so every reference write would sequentially scan
-- `citations`. The GIN trigram index from 0093 cannot help: it serves ILIKE
-- containment over the concatenated haystack, not equality on a single key.
--
-- Partial on purpose. Only a minority of rows carry alt ids at all (a paper is
-- only cross-referenced once something resolved its other handle), and the
-- lookup never matches NULL, so indexing the rows that have the key keeps these
-- far smaller than the table.
--
-- The DOI expression is wrapped in lower() to match the predicate verbatim: a
-- DOI is case-insensitive by specification, the query compares it lower-cased,
-- and Postgres only uses an expression index when the query repeats the
-- expression exactly. PMIDs are digits and URLs are stored as given, so both
-- compare literally and are indexed as-is.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator (drizzle-orm/neon-http) splits a migration file on that marker and
-- sends each chunk over Neon's HTTP endpoint as a prepared statement, which
-- accepts exactly one command.

CREATE INDEX IF NOT EXISTS "citations_alt_pmid_idx"
  ON "citations" (("metadata"->'altIds'->>'pmid'))
  WHERE "metadata"->'altIds'->>'pmid' IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citations_alt_doi_idx"
  ON "citations" ((lower("metadata"->'altIds'->>'doi')))
  WHERE "metadata"->'altIds'->>'doi' IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citations_alt_url_idx"
  ON "citations" (("metadata"->'altIds'->>'url'))
  WHERE "metadata"->'altIds'->>'url' IS NOT NULL;
