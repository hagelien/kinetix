-- Free-text spellings folded into another citation by a merge.
--
-- A merge deletes the losing citation row, and for a PMID/DOI/URL loser its
-- handle survives on the winner as `metadata.altIds`, which `resolveCitation`
-- consults before inserting. Free text has no such slot: `altIds` only carries
-- resolvable handles. So once an admin folded two spellings of one paper that
-- the automatic same-work match could not tie together, the next import citing
-- the deleted spelling matched nothing and recreated the duplicate — with its
-- own review and its own PDF request.
--
-- A table rather than another `metadata` key: `metadata` is rebuilt by
-- `normalizeReferenceMetadata` on several write paths, which keeps only the
-- keys it knows, and an alias list there would be one refactor away from being
-- dropped silently.
--
-- `identifier` is unique: one spelling belongs to one paper. Cascades with the
-- citation it points at; a merge repoints a loser's own aliases to the winner
-- before the loser is deleted.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator (drizzle-orm/neon-http) splits a migration file on that marker and
-- sends each chunk over Neon's HTTP endpoint as a prepared statement, which
-- accepts exactly one command.

CREATE TABLE IF NOT EXISTS "citation_freetext_aliases" (
  "id" serial PRIMARY KEY NOT NULL,
  "citation_id" integer NOT NULL REFERENCES "citations"("id") ON DELETE CASCADE,
  "identifier" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "citation_freetext_aliases_identifier_idx"
  ON "citation_freetext_aliases" ("identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citation_freetext_aliases_citation_idx"
  ON "citation_freetext_aliases" ("citation_id");
