-- Unified disputes + in-app notifications (see
-- docs/superpowers/specs/2026-06-23-unified-disputes.md).
--
-- `disputes` is the canonical, human- AND agent-authored record that a target
-- (fact / parameter / revision / pending edit) is contested. Agent dispute
-- *verdicts* keep flowing through agent_verifications and keep driving consensus
-- auto-apply unchanged; the API additionally mirrors each agent dispute into a
-- row here (source='agent') so this table is the single place to enumerate every
-- open dispute (the deterministic GET /api/disputes feed agents poll) and the
-- signal that fans out notifications. Human disputes (source='human') also block
-- consensus auto-apply.
--
-- `notifications` is the in-app inbox. Dispute open/resolve fans out to the
-- target author plus every reviewer/editor/admin. Agents are not notified here;
-- they pull the disputes feed instead. In-app only (no email).

CREATE TABLE IF NOT EXISTS "disputes" (
  "id" serial PRIMARY KEY NOT NULL,
  "target_type" varchar(40) NOT NULL,
  "target_id" integer NOT NULL,
  "created_by" integer NOT NULL,
  "source" varchar(20) DEFAULT 'human' NOT NULL,
  "reason_md" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'open' NOT NULL,
  "resolution" varchar(20),
  "resolved_by" integer,
  "resolved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "type" varchar(40) NOT NULL,
  "target_type" varchar(40),
  "target_id" integer,
  "dispute_id" integer,
  "title" text NOT NULL,
  "body_md" text,
  "url" text,
  "read_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "disputes"
    ADD CONSTRAINT "disputes_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "disputes"
    ADD CONSTRAINT "disputes_resolved_by_users_id_fk"
    FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_dispute_id_disputes_id_fk"
    FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- At most one OPEN dispute per (author, target); re-disputing updates that row.
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_open_author_target_idx"
  ON "disputes" ("target_type","target_id","created_by") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_target_idx" ON "disputes" ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_status_created_idx" ON "disputes" ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_read_idx" ON "notifications" ("user_id","read_at","created_at");
