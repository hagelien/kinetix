-- #321: per-user favorite parameter ids for the monograph sidebar's
-- collapsed mode. Stored as a jsonb string[] keyed by DRUG_PARAMETER_ID;
-- defaults to an empty array so existing users see "no favorites set"
-- (the sidebar falls back to "show everything" when the list is empty
-- so users without preferences set get a useful default view).

ALTER TABLE "users"
  ADD COLUMN "favorite_parameters" jsonb NOT NULL DEFAULT '[]'::jsonb;
