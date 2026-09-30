-- Replace the binary `preferred_concentration_unit` setting with a
-- multi-select `enabled_concentration_units` array (#306). The first item
-- is the user's primary display unit; the rest control which alternatives
-- the unit-converter tooltips and pickers expose. Existing users keep
-- their previous primary plus the other default so the UI doesn't suddenly
-- collapse to a single unit on first login after the migration.

ALTER TABLE "users"
  ADD COLUMN "enabled_concentration_units" jsonb NOT NULL
  DEFAULT '["µmol/L","mg/L"]'::jsonb;
--> statement-breakpoint

UPDATE "users"
SET "enabled_concentration_units" = CASE
  WHEN "preferred_concentration_unit" = 'mg/L'
    THEN '["mg/L","µmol/L"]'::jsonb
  ELSE '["µmol/L","mg/L"]'::jsonb
END;
--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN "preferred_concentration_unit";
