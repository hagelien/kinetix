-- Provenance flag for bulk-imported substances.
-- NULL = native Kinetix seed / hand-curated drug; a non-NULL value names the
-- external catalog the substance was imported (or corroborated) from, e.g.
-- 'farmakologiportalen' for rows pulled from
-- https://farmakologiportalen.no/substances. Lets the UI and queries
-- distinguish bulk-imported substances from the original curated set.
ALTER TABLE "drugs" ADD COLUMN IF NOT EXISTS "source" varchar(60);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drugs_source_idx" ON "drugs" USING btree ("source");
