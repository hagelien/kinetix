CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
UPDATE "drugs"
SET "search_key" = LOWER(
  CONCAT_WS(
    E'\t',
    "name",
    NULLIF("name_short", ''),
    NULLIF("name_en", ''),
    NULLIF("category", '')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drugs_search_key_trgm_idx"
  ON "drugs" USING gin ("search_key" gin_trgm_ops);
