-- Generalize 0143's free-text aliases to every handle a merge folds away.
--
-- 0143 kept a merged-away free-text spelling findable because `metadata.altIds`
-- has no slot for free text. But `altIds` also holds only ONE handle per type,
-- and the merge fills it gap-only: fold three URL rows of one paper into a
-- fourth and at most one of the three URLs survives there. The next import
-- citing either of the others matched nothing and recreated the duplicate. So
-- the alias table now records every handle the deleted row answered to — its
-- own and each of its alt ids — keyed by (type, identifier).
--
-- An ALTER of 0143's table rather than a rewrite of 0143: a database that has
-- already applied 0143 would never re-run an edited file, and would be left
-- with the old shape under code that expects the new one.
--
-- Existing rows are all free text (0143 recorded nothing else), hence the
-- default used to backfill the new column; it is dropped afterwards so a
-- writer must say what kind of handle it is recording. DOIs are stored
-- lower-case by the writer (`aliasIdentifier`).
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator (drizzle-orm/neon-http) splits a migration file on that marker and
-- sends each chunk over Neon's HTTP endpoint as a prepared statement, which
-- accepts exactly one command.

ALTER TABLE IF EXISTS "citation_freetext_aliases" RENAME TO "citation_identifier_aliases";
--> statement-breakpoint
ALTER TABLE "citation_identifier_aliases" ADD COLUMN IF NOT EXISTS "type" varchar(10) NOT NULL DEFAULT 'freetext';
--> statement-breakpoint
ALTER TABLE "citation_identifier_aliases" ALTER COLUMN "type" DROP DEFAULT;
--> statement-breakpoint
DROP INDEX IF EXISTS "citation_freetext_aliases_identifier_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "citation_identifier_aliases_type_identifier_idx"
  ON "citation_identifier_aliases" ("type", "identifier");
--> statement-breakpoint
ALTER INDEX IF EXISTS "citation_freetext_aliases_citation_idx" RENAME TO "citation_identifier_aliases_citation_idx";
