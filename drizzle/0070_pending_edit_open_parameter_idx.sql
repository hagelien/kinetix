-- A drug parameter may have at most ONE open pending edit at a time.
--
-- Contributor-role agents can only see their OWN open rows through
-- GET /api/pending-edits, so a sibling agent's pending edit on the same
-- (drug, parameter) is invisible to them and gets re-derived and re-proposed
-- every maintenance cycle. With no uniqueness guard the review queue
-- accumulates duplicate parameter edits for the same field across days
-- (e.g. ethyl glucuronide `bloodPlasmaRatio`). This index makes the duplicate
-- impossible at the database level; the API surfaces it as a clean 409
-- (parameter_pending_conflict) and a new mode=pending_parameters sweep lets
-- agents see and endorse the existing row instead. Mirrors
-- pending_edits_open_paper_review_idx (paper reviews, issue analog).

-- Step 1: clear pre-existing duplicates so the unique index can be built.
-- Keep only the most recent open edit per (target_id, parameter) and reject the
-- older siblings with the standardized `duplicate` reason (feeds agent-learning
-- like any reviewer rejection). No reviewer is recorded (reviewed_by stays NULL)
-- because this is an automated supersede, not a human decision.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY target_id, parameter
           ORDER BY submitted_at DESC, id DESC
         ) AS rn
  FROM pending_edits
  WHERE edit_type = 'parameter' AND status = 'pending'
)
UPDATE pending_edits pe
SET status = 'rejected',
    rejection_reason = 'duplicate',
    rejection_comment = 'Superseded automatically: a newer pending edit already targets this parameter (migration 0064).',
    reviewed_at = now()
FROM ranked
WHERE pe.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint

-- Step 2: enforce one open pending parameter edit per (drug, parameter).
CREATE UNIQUE INDEX IF NOT EXISTS "pending_edits_open_parameter_idx"
  ON "pending_edits" ("target_id", "parameter")
  WHERE "edit_type" = 'parameter' AND "status" = 'pending';
