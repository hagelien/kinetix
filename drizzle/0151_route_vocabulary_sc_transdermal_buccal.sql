-- Widen the administration-route vocabulary with subcutaneous, transdermal and buccal (#81), held
-- in step with kinetics-core ROUTE_IDS by modelStructureVocabulary.test.ts. Additive only: every
-- existing row already satisfies the wider list, so nothing is rewritten. Entries previously
-- filed under 'other' or tagged in prose are NOT re-tagged here; that goes through a reviewer
-- queue, not a silent migration.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_route_vocabulary";
--> statement-breakpoint

ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_route_vocabulary"
  CHECK (
    "route" IS NULL
    OR "route" IN (
      'oral', 'intranasal', 'iv', 'im', 'sublingual', 'buccal', 'subcutaneous', 'transdermal',
      'rectal', 'inhalation', 'other'
    )
  );
