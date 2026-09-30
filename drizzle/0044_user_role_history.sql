-- Append-only audit log for admin-initiated user role changes.
-- Every call to PATCH /api/admin?resource=users writes a row here so there is
-- a permanent record of who promoted (or demoted) whom and when. Mirrors the
-- pattern established by agent_status_history for agent lifecycle events.
CREATE TABLE IF NOT EXISTS "user_role_history" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "from_role" varchar(20),
  "to_role" varchar(20) NOT NULL,
  "changed_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_role_history_user_idx"
  ON "user_role_history" ("user_id", "changed_at");
