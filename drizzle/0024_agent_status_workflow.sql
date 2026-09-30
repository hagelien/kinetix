-- #319 P3: agent status lifecycle.
--
-- Replaces the binary `active` boolean on `agents` with a three-state
-- lifecycle: 'active' (operational), 'suspended' (reversibly disabled),
-- 'deactivated' (terminal soft-delete; row retained for audit). The
-- enum is enforced at the application layer (src/lib/agentStatus.ts)
-- per the repo's VARCHAR + Zod convention.
--
-- Backfill: the only pre-existing `active=false` rows came from the
-- DELETE soft-delete path, which the old code documented as a kill
-- switch ("agents/remote-routine-setup.md"). Map them to the new
-- terminal `deactivated` state, not the reversible `suspended` state,
-- so an admin can't accidentally revive an intentionally-killed agent
-- with a single click after this migration runs.
--
-- A history table records every transition with actor, timestamp, and
-- optional reason so the admin UI can render a timeline without
-- relying on row-level mutation timestamps.

ALTER TABLE "agents" ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'active';
--> statement-breakpoint

UPDATE "agents" SET "status" = CASE WHEN "active" THEN 'active' ELSE 'deactivated' END;
--> statement-breakpoint

DROP INDEX IF EXISTS "agents_active_idx";
--> statement-breakpoint

ALTER TABLE "agents" DROP COLUMN "active";
--> statement-breakpoint

ALTER TABLE "agents" ADD COLUMN "status_changed_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_changed_at" TIMESTAMP;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_change_reason" TEXT;
--> statement-breakpoint

CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");
--> statement-breakpoint

CREATE TABLE "agent_status_history" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "agent_id" INTEGER NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "from_status" VARCHAR(20),
  "to_status" VARCHAR(20) NOT NULL,
  "changed_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "changed_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "reason" TEXT
);
--> statement-breakpoint
CREATE INDEX "agent_status_history_agent_idx" ON "agent_status_history" USING btree ("agent_id", "changed_at" DESC);
