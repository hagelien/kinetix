-- Speed up dedup lookups from importer/admin write paths. These predicates
-- mirror findOrCreateEntityBySymbol: cosmetic-symbol reuse first, UniProt as a
-- fallback when the incoming row carries that external id.
CREATE INDEX IF NOT EXISTS "bio_entities_normalized_symbol_idx"
  ON "bio_entities" (upper(regexp_replace("symbol", '[^a-zA-Z0-9]', '', 'g')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bio_entities_uniprot_idx"
  ON "bio_entities" (lower("external_ids" ->> 'uniprot'))
  WHERE "external_ids" ? 'uniprot';
