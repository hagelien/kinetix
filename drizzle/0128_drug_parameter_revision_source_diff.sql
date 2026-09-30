-- Record which citations entered/left a parameter's pooled aggregate.
--
-- The edit-history dialog showed a revision's summary ("Recomputed from 3
-- source entries") with no trace of which sources dropped out or why (#1358).
-- `reference_ids` on the OLD revision still names the prior contributing set,
-- but nothing diffed it against the new one, and a deleted citation can't be
-- looked up after the fact anyway.
--
-- `source_diff` holds `{added, removed}` arrays of `{citationId, label}`,
-- computed once at revision-write time (so the label is captured before a
-- citation that gets removed can disappear out from under a later read).
-- Nullable: most revisions don't change the contributing set, and existing
-- rows predate this column entirely.
ALTER TABLE "drug_parameter_revisions"
  ADD COLUMN IF NOT EXISTS "source_diff" jsonb;
