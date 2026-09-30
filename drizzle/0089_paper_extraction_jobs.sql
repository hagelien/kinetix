-- Paper fact-extraction queue.
--
-- Editors and admins upload a full-text paper through the existing PDF rail
-- (pdf_requests -> citation_pdfs -> Vercel Blob) and then enqueue it here. A
-- scheduled agent claims one job per run, reads the stored PDF, and files the
-- paper's atomic facts as `wiki_fact` pending edits against the monographs and
-- wiki pages they belong to. Nothing bypasses the human review queue.
--
-- The table stores no extracted content: it is a work ticket (what to read,
-- who asked, what the run produced). The facts themselves live in
-- pending_edits and, once approved, in wiki_pages.
--
-- Plain (non-CONCURRENT) index builds: the table is created empty in this same
-- migration, so there is nothing to block.
CREATE TABLE IF NOT EXISTS "paper_extraction_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "citation_id" integer NOT NULL REFERENCES "citations"("id") ON DELETE cascade,
  "status" varchar(12) DEFAULT 'queued' NOT NULL,
  "scope_note" text,
  "target_drug_ids" integer[],
  "requested_by" integer REFERENCES "users"("id") ON DELETE set null,
  "claimed_by" integer REFERENCES "users"("id") ON DELETE set null,
  "claimed_at" timestamp,
  -- Identifies the claim INSTANCE, not its owner: the expected deployment runs
  -- one agent identity on a schedule, so a dead run and the run that later
  -- reclaimed its job share a claimed_by. Minted per claim, required to report.
  "claim_token" varchar(32),
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "result_summary" text,
  "facts_submitted" integer,
  "pending_edit_ids" integer[],
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- At most one OPEN job per paper. Two open jobs on the same citation means two
-- agent runs reading the same PDF and submitting the same facts, which lands as
-- duplicate wiki_fact rows a reviewer has to reconcile by hand. Finished jobs
-- are deliberately unconstrained so a paper can be re-extracted later (an
-- improved full text, a section the first pass skipped).
CREATE UNIQUE INDEX IF NOT EXISTS "paper_extraction_jobs_open_citation_idx"
  ON "paper_extraction_jobs" ("citation_id")
  WHERE status IN ('queued', 'claimed');
--> statement-breakpoint
-- Covers the claim query: the oldest claimable job, filtered by status.
CREATE INDEX IF NOT EXISTS "paper_extraction_jobs_status_created_idx"
  ON "paper_extraction_jobs" ("status", "created_at");
