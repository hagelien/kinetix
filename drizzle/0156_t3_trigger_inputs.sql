-- Persisted inputs for the two T3 triggers that had none (issue 17,
-- agents/drug-db-adjudication.md §2, docs/plans/2026-09-18-t3-adjudication-backend.md §3.3).
--
--   agent_verifications.competing_scope  trigger 2. Set by a blind T2
--                       (flagship) verifier alongside its verdict when the
--                       disagreement turns on materially different scope
--                       (population, route, matrix, definition, time window…)
--                       that cannot be collapsed into one answer. Rewritten on
--                       every verdict write, so a re-verdict without it clears
--                       it. The detector reads it only on an explicit verdict
--                       whose effective tier is flagship.
--   adjudication_requests  trigger 5. One row per person asking for a T3
--                       analysis of one version of a target. Bound to the
--                       version they read, like a person's dispute, so a
--                       request says nothing about a later revision. The
--                       requester keeps the final authority: a case it opens
--                       or joins is always handed to a person.
ALTER TABLE "agent_verifications"
  ADD COLUMN IF NOT EXISTS "competing_scope" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adjudication_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "target_type" varchar(40) NOT NULL,
  "target_id" integer NOT NULL,
  "target_version" varchar(80) NOT NULL,
  "requested_by" integer NOT NULL,
  "reason_md" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "adjudication_requests"
    ADD CONSTRAINT "adjudication_requests_requested_by_fk"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjudication_requests_target_version_requester_uq"
  ON "adjudication_requests" ("target_type","target_id","target_version","requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjudication_requests_target_idx"
  ON "adjudication_requests" ("target_type","target_id");
