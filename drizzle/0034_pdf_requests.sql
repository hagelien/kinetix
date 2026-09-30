-- PDF request & fulfillment workflow.
--
-- pdf_requests: filed by the review agent when a cited paper has no
-- legitimately free full text. One open request per citation (unique on
-- citation_id); a contributor fulfils it via upload or a downloadable URL.
--
-- citation_pdfs: the durable full-text asset. Bytes live in Vercel Blob;
-- this row stores the pointer (blob_pathname, kept server-side only) plus
-- integrity/provenance metadata. One current PDF per citation.

CREATE TABLE "pdf_requests" (
  "id" SERIAL PRIMARY KEY,
  "citation_id" INTEGER NOT NULL REFERENCES "citations"("id") ON DELETE CASCADE,
  "status" VARCHAR(12) NOT NULL DEFAULT 'open',
  "reason" TEXT,
  "requested_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "fulfilled_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "fulfilled_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "pdf_requests_citation_idx" ON "pdf_requests" USING btree ("citation_id");
--> statement-breakpoint

CREATE INDEX "pdf_requests_status_idx" ON "pdf_requests" USING btree ("status");
--> statement-breakpoint

CREATE TABLE "citation_pdfs" (
  "id" SERIAL PRIMARY KEY,
  "citation_id" INTEGER NOT NULL REFERENCES "citations"("id") ON DELETE CASCADE,
  "blob_pathname" TEXT NOT NULL,
  "blob_url" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "content_type" VARCHAR(100) NOT NULL,
  "source" VARCHAR(8) NOT NULL,
  "source_url" TEXT,
  "uploaded_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "citation_pdfs_citation_idx" ON "citation_pdfs" USING btree ("citation_id");
