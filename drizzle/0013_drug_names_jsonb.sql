-- Reshape drug naming for multilingual scalability:
--   * Old: `name` (Norwegian, NOT NULL) + `name_en` (English, optional) +
--     `name_short` (abbreviation, optional)
--   * New: `names` jsonb keyed by BCP-47 language code (e.g. {"nb": "...",
--     "en": "..."}) + `aliases` jsonb string array (literature variants, brand
--     names, street names) + `name_short` (kept).
--
-- The `search_key` is rebuilt to include every language value plus aliases so
-- the trigram index keeps matching regardless of which UI language is active.

ALTER TABLE "drugs" ADD COLUMN "names" jsonb;--> statement-breakpoint
ALTER TABLE "drugs" ADD COLUMN "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

UPDATE "drugs" SET "names" = jsonb_strip_nulls(jsonb_build_object(
  'nb', NULLIF("name", ''),
  'en', NULLIF("name_en", '')
));--> statement-breakpoint

ALTER TABLE "drugs" ALTER COLUMN "names" SET NOT NULL;--> statement-breakpoint

UPDATE "drugs" SET "search_key" = LOWER(
  COALESCE(
    (SELECT string_agg(value, E'\t') FROM jsonb_each_text("names")),
    ''
  )
  || E'\t' || COALESCE(NULLIF("name_short", ''), '')
  || E'\t' || COALESCE(
    (SELECT string_agg(value, E'\t') FROM jsonb_array_elements_text("aliases")),
    ''
  )
  || E'\t' || COALESCE(NULLIF("category", ''), '')
);--> statement-breakpoint

ALTER TABLE "drugs" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "name_en";
