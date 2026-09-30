-- Bulk PDF drop-off ("the inbox"), decoupled from the request it will satisfy.
--
-- Until now the only way a PDF entered the system was through a citation: both
-- fulfilment routes (the client-upload token and the URL submit) require an
-- ALREADY-OPEN `pdf_requests` row, and `recordCitationPdf` matches on
-- `citation_id` + request id. That is the right invariant for the asset — a
-- stored PDF must belong to exactly one citation, and something must have
-- asked for it — but it forces the *human* to establish the link before the
-- bytes exist anywhere.
--
-- In practice the agents file dozens of requests at a time, and the human who
-- answers them works the other way round: they run a batch of searches in the
-- library proxy, end up with a folder of downloads, and only then find out
-- which download is which. Making them open one queue row at a time, identify
-- the paper by eye, and upload into that row is the expensive half of the
-- task, and it is the half a machine can do: a modern paper carries its own
-- DOI on page one and usually in its filename.
--
-- So the bytes land here first, unattached, and the link is established
-- afterwards — automatically where an identifier resolves to exactly one
-- citation, by a human or an agent where it does not. Nothing downstream
-- changes: attaching still goes through `pdf_requests` + `recordCitationPdf`,
-- so the review gate, the follow-up queue and the extraction queue all see
-- precisely what they would have seen from a one-at-a-time upload.
CREATE TABLE IF NOT EXISTS "pdf_inbox_items" (
  "id" SERIAL PRIMARY KEY,
  -- Blob pointer. Held server-side only, exactly as `citation_pdfs` holds it:
  -- an inbox item is unreviewed licensed full text and is no more public than
  -- an attached one.
  "blob_pathname" TEXT NOT NULL,
  "blob_url" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "content_type" VARCHAR(100) NOT NULL,
  -- What the human called the file. Not decoration: for a paper with no
  -- readable DOI it is often the only handle anyone has, and the matcher
  -- reads it first.
  "original_filename" TEXT NOT NULL,
  -- 'pending'   — uploaded, matching has not produced an attachable answer
  -- 'attached'  — linked to a citation; `citation_pdfs` now owns the blob
  -- 'discarded' — the human rejected it; the blob is deleted on discard
  "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
  -- What the extractor read out of the file: {doi, pmid, pmcid, title, year,
  -- sources}. Stored rather than recomputed because extraction reads the
  -- bytes back out of Blob storage, which is the expensive part of a rematch.
  "extracted" JSONB,
  -- Ranked citation candidates: [{citationId, via, score}]. Recomputed on
  -- demand (`action=rematch`) because the citation corpus grows: a paper with
  -- no match today matches the moment someone cites it.
  "candidates" JSONB,
  -- The candidate an attach acted on. Kept after attachment so the inbox row
  -- remains an audit record of how the link was made.
  "matched_citation_id" INTEGER REFERENCES "citations"("id") ON DELETE SET NULL,
  -- 'exact' | 'strong' | 'weak' | 'none'. Only 'exact' auto-attaches; see
  -- api/_lib/pdf-inbox-match.ts for what each tier is allowed to assert.
  "match_confidence" VARCHAR(8) NOT NULL DEFAULT 'none',
  -- Whether the link was made without a human in the loop, so a reviewer can
  -- audit exactly the set of attachments nobody looked at.
  "auto_attached" BOOLEAN NOT NULL DEFAULT false,
  "attached_at" TIMESTAMP,
  "attached_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "uploaded_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  -- Why an attach attempt failed, in the operator's words rather than a stack
  -- trace. A bulk drop fails item-by-item and must not fail silently.
  "last_error" TEXT,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Drag the same folder in twice and the second drop must be recognised, not
-- duplicated: a second row for identical bytes would be offered for linking to
-- a citation the first row already satisfied. Keyed on the content hash rather
-- than the filename because the duplicate usually arrives renamed.
--
-- Partial, excluding discarded rows: a discard is a statement about that
-- upload ("wrong paper", "unreadable scan"), not a permanent ban on the bytes.
-- Someone who discarded by mistake must be able to drop the file again.
CREATE UNIQUE INDEX IF NOT EXISTS "pdf_inbox_items_sha256_idx"
  ON "pdf_inbox_items" ("sha256")
  WHERE "status" <> 'discarded';
--> statement-breakpoint
-- The queue view reads one status at a time, newest first.
CREATE INDEX IF NOT EXISTS "pdf_inbox_items_status_idx"
  ON "pdf_inbox_items" ("status", "created_at" DESC);
--> statement-breakpoint
-- "Does this citation already have something waiting in the inbox?" — asked
-- per row by the PDF-request queue so a paper nobody has linked yet does not
-- read as a paper nobody has supplied.
CREATE INDEX IF NOT EXISTS "pdf_inbox_items_citation_idx"
  ON "pdf_inbox_items" ("matched_citation_id")
  WHERE "matched_citation_id" IS NOT NULL;
