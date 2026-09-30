-- Split `bloodOralFluidDetectionWindow` into `bloodDetectionWindow` and
-- `oralFluidDetectionWindow`.
--
-- One parameter covering two matrices was accurate for neither: oral fluid
-- tracks the free parent drug and usually falls off well before blood does,
-- and blood is the matrix impairment is read from, so a single window forced
-- two different quantities into one range. Sources report them separately too,
-- which meant a per-source entry silently lost which matrix it was measured in.
--
-- Existing values move to `bloodDetectionWindow`, not to both: a stored range
-- is one sourced observation, and copying it into the oral-fluid slot would
-- invent a value no source stated. Blood is the safer landing site — it is the
-- matrix these windows are overwhelmingly reported and used in — and the
-- oral-fluid side is queued for re-sourcing as a priority flag at the end of
-- this migration rather than left as an invisible gap.
--
-- This file does NOT finish the job on a live database. Migrations run during
-- `vercel build`, while the *previous* build is still serving and still
-- accepting writes under the old id, so a value stored in that window is never
-- seen by the statements below and lands in a parameter the new registry does
-- not declare — invisible, and unreachable by any later write. Every statement
-- here is therefore written to be re-runnable, and
-- `npm run backfill:detection-window-split -- --apply` replays them once the
-- new build is live. Run it after deploying; it is a no-op when nothing was
-- written late.

UPDATE "drug_parameters"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- Per-source entries backing the cached aggregate above. Renamed in the same
-- direction so the summary stays consistent with the rows it is computed from.
UPDATE "parameter_entries"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- Edit history: rewritten rather than deleted so the value keeps its
-- provenance chain (who wrote it, under which citation).
UPDATE "drug_parameter_revisions"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- Not-applicable markers. A substance with no blood/oral-fluid window has no
-- blood window either, so the marker carries over; the oral-fluid marker is
-- not fabricated here (that is a curator's judgement, one drug at a time).
UPDATE "drug_parameter_applicability"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- Discussion threads anchored on the parameter (drug-scoped only; topic-fact
-- threads reuse this column with a `fact:<id>` key and never match).
UPDATE "drug_parameter_discussions"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- Open and decided review rows. The `parameter` column drives the review card
-- and the one-open-edit-per-(drug, parameter) indexes; the new id is unused,
-- so no rename can collide with an existing open row.
UPDATE "pending_edits"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- `param_entry` proposals repeat the parameter inside the payload, and
-- approval refuses the edit when the two disagree (param_entry_target_mismatch),
-- so the create payload has to move with the column. Guarded on the payload
-- actually being a create object — a plain `parameter` edit stores the range
-- itself in proposed_value and must not be touched.
UPDATE "pending_edits"
SET "proposed_value" = jsonb_set(
  "proposed_value",
  '{input,parameter}',
  '"bloodDetectionWindow"'::jsonb,
  false
)
WHERE "edit_type" = 'param_entry'
  AND jsonb_typeof("proposed_value") = 'object'
  AND "proposed_value" -> 'input' ->> 'parameter' = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- A queued `wiki_new` monograph draft carries its initial PK values as a bag
-- in proposed_meta.parameters, KEYED by parameter id — not in the `parameter`
-- column, so nothing above reaches it. `validateParameterBag` runs at approval
-- and throws `Unknown parameter` on an id the registry no longer declares,
-- which would strand the draft permanently. Rename the key; when the new key
-- somehow already exists, drop the stale one rather than overwrite, since the
-- newer key is the one a reviewer saw.
UPDATE "pending_edits"
SET "proposed_meta" = CASE
  WHEN jsonb_exists("proposed_meta" -> 'parameters', 'bloodDetectionWindow')
    THEN "proposed_meta" #- '{parameters,bloodOralFluidDetectionWindow}'
  ELSE jsonb_set(
    "proposed_meta" #- '{parameters,bloodOralFluidDetectionWindow}',
    '{parameters,bloodDetectionWindow}',
    "proposed_meta" -> 'parameters' -> 'bloodOralFluidDetectionWindow'
  )
END
WHERE jsonb_typeof("proposed_meta" -> 'parameters') = 'object'
  AND jsonb_exists("proposed_meta" -> 'parameters', 'bloodOralFluidDetectionWindow');
--> statement-breakpoint

-- Agent work queue: priority flags and the verification audit trail.
UPDATE "parameter_priority_flags"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

UPDATE "verification_log"
SET "parameter" = 'bloodDetectionWindow'
WHERE "parameter" = 'bloodOralFluidDetectionWindow';
--> statement-breakpoint

-- Per-user favourite parameters (jsonb array of ids). Rewritten element-wise so
-- a user who pinned the combined window keeps a pin on the blood window.
UPDATE "users"
SET "favorite_parameters" = (
  SELECT jsonb_agg(
    CASE
      WHEN elem = '"bloodOralFluidDetectionWindow"'::jsonb
        THEN '"bloodDetectionWindow"'::jsonb
      ELSE elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("favorite_parameters") WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof("favorite_parameters") = 'array'
  AND "favorite_parameters" @> '["bloodOralFluidDetectionWindow"]'::jsonb;
--> statement-breakpoint

-- Same treatment for the singleton agent focus config (mode='parameters').
UPDATE "agent_focus_config"
SET "parameters" = (
  SELECT jsonb_agg(
    CASE
      WHEN elem = '"bloodOralFluidDetectionWindow"'::jsonb
        THEN '"bloodDetectionWindow"'::jsonb
      ELSE elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("parameters") WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof("parameters") = 'array'
  AND "parameters" @> '["bloodOralFluidDetectionWindow"]'::jsonb;
--> statement-breakpoint

-- Queue the half of the split that no longer has a value. Every drug that
-- carried a combined window now has a blood window and an empty oral-fluid
-- one; flag it so the maintenance agent sources the oral-fluid figure instead
-- of the gap sitting unnoticed behind a parameter that used to look filled.
-- `flagged_by` is NULL (no human raised these). Both a drug that already has
-- an oral-fluid value and one already flagged are skipped, so this statement
-- adds nothing on the re-runs the post-deploy backfill performs
-- (scripts/backfill-detection-window-split.ts).
INSERT INTO "parameter_priority_flags" ("drug_id", "parameter", "status", "note")
SELECT
  dp."drug_id",
  'oralFluidDetectionWindow',
  'active',
  'Split from the former combined blood/oral-fluid detection window (migration 0098): the stored value was kept as the blood window, so the oral-fluid window needs its own source.'
FROM "drug_parameters" dp
WHERE dp."parameter" = 'bloodDetectionWindow'
  AND NOT EXISTS (
    SELECT 1
    FROM "drug_parameters" existing
    WHERE existing."drug_id" = dp."drug_id"
      AND existing."parameter" = 'oralFluidDetectionWindow'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "parameter_priority_flags" f
    WHERE f."drug_id" = dp."drug_id"
      AND f."parameter" = 'oralFluidDetectionWindow'
      AND f."status" = 'active'
  );
