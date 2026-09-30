-- #791 Part B step 6: decommission the legacy enzymes / receptor_targets
-- registries.
--
-- Their catalog role was taken over by bio_entities (#785, Phase 7), the edge FK
-- columns that referenced them were dropped in step 4 (migration 0076), and all
-- application readers/writers have now been removed:
--   - the enzyme admin CRUD (POST/PATCH/DELETE on /api/enzymes) and enzymeStore,
--   - the dead receptorTargetStore.searchReceptorTargets catalog search,
--   - the scripts/seed-drugs.ts enzyme lookup (repointed to bio_entities).
-- The /api/enzymes and /api/receptor-targets typeaheads already serve
-- bio_entities. Nothing references these tables any more.
--
-- DROP TABLE is irreversible — take a snapshot first (Neon branch or pg_dump).
-- No CASCADE: every FK that pointed at these tables was already removed, so a
-- plain drop is correct and fails loudly if some unexpected dependency remains.
DROP TABLE IF EXISTS "enzymes";
--> statement-breakpoint
DROP TABLE IF EXISTS "receptor_targets";
