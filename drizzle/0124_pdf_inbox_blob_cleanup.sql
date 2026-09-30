-- Record whether a discarded inbox item's bytes are actually gone.
--
-- Discarding deleted the Blob object with `.catch(() => undefined)` — a
-- best-effort delete whose failure was then unrecoverable. The row had already
-- left the pending queue, nothing revisits a discarded row, and the UI said
-- "discarded", so a transient Blob outage retained licensed full text
-- indefinitely with nothing anywhere recording that it was still there. The
-- partial unique index deliberately lets the same bytes be dropped in again
-- after a discard, so the same file could then accumulate a second object.
--
-- Best-effort is right for the *attempt* — a failed delete must not block a
-- human from clearing their queue — but it must leave a trace. A null
-- `blob_deleted_at` on a discarded row now means "the object may still exist",
-- which is exactly the set `retryPendingBlobDeletions` re-attempts.
--
-- Backfilled to now() for rows that already exist: every discard before this
-- migration either succeeded or is unknowable, and treating an unknowable one
-- as needing cleanup would hand the retry a URL whose object is already gone.
ALTER TABLE "pdf_inbox_items"
  ADD COLUMN IF NOT EXISTS "blob_deleted_at" timestamp;
--> statement-breakpoint
UPDATE "pdf_inbox_items"
  SET "blob_deleted_at" = now()
  WHERE "status" = 'discarded' AND "blob_deleted_at" IS NULL;
--> statement-breakpoint
-- The retry queue: discarded rows whose object is not known to be gone.
CREATE INDEX IF NOT EXISTS "pdf_inbox_items_blob_cleanup_idx"
  ON "pdf_inbox_items" ("created_at")
  WHERE "status" = 'discarded' AND "blob_deleted_at" IS NULL;
