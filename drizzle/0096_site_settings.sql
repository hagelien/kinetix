-- Runtime policy switches (Admin -> Settings).
--
-- The registry in src/lib/siteSettings.ts names every switch and carries the
-- value the code ships with; this table holds only the deviations an admin
-- makes, so a stock install starts empty and behaves exactly as before. An
-- absent key means "use the shipped default".
--
-- `key` is the natural key. Rows whose id a later release drops are ignored at
-- read time (sanitizeSiteSettings) rather than migrated away, so no FK to
-- application code is implied here. `value` is jsonb — every switch is a
-- boolean today, but a future one may need a richer value.
CREATE TABLE IF NOT EXISTS "site_settings" (
  "key" VARCHAR(64) PRIMARY KEY,
  "value" JSONB NOT NULL,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);
