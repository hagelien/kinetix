-- A parameter entry may have at most ONE open update/delete pending edit at a
-- time (Phase 3 of multi-value parameters, editType = 'param_entry').
--
-- For update/delete ops, `target_id` is the entry id, so this mirrors
-- pending_edits_open_parameter_idx but scoped to entry edits: it stops two
-- contributors (or an agent that cannot see a sibling's pending row) from
-- queuing duplicate edits against the same existing entry; the API surfaces the
-- collision as a clean 409 (entry_pending_conflict).
--
-- `create` ops are DELIBERATELY unconstrained: a parameter is multi-value, so
-- many concurrent proposals to ADD new entries must be allowed to coexist. The
-- `(proposed_value ->> 'op') <> 'create'` predicate excludes them.
-- CONCURRENTLY so building the index on a live database does not block
-- inserts/updates/deletes on the review queue. This makes 0079 a
-- non-transactional migration: it is registered in
-- scripts/apply-migrations-build.ts NON_TRANSACTIONAL_MIGRATIONS and applied
-- outside the transactional migrator (the integration harness strips
-- CONCURRENTLY since a single-connection test DB has no concurrency to honor).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "pending_edits_open_entry_idx"
  ON "pending_edits" ("target_id", "parameter")
  WHERE "edit_type" = 'param_entry'
    AND "status" = 'pending'
    AND ("proposed_value" ->> 'op') <> 'create';
