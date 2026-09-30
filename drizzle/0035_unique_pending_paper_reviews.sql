WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY target_id
      ORDER BY submitted_at DESC, id DESC
    ) AS rn
  FROM pending_edits
  WHERE edit_type = 'paper_review'
    AND status = 'pending'
    AND target_id IS NOT NULL
)
UPDATE pending_edits
SET
  status = 'rejected',
  rejection_reason = 'duplicate',
  rejection_comment = 'Superseded by a newer pending paper review before the unique index was added.',
  reviewed_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_edits_open_paper_review_idx"
  ON "pending_edits" ("target_id")
  WHERE "edit_type" = 'paper_review' AND "status" = 'pending';
