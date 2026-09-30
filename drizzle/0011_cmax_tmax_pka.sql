-- Idempotent: the original migration tried to ADD COLUMN "cmax", which fails
-- with SQLSTATE 42701 because cmax is a reserved PostgreSQL system column
-- name (alongside cmin, xmin, xmax, ctid, tableoid, oid). The DROP COLUMN
-- statement that ran before it left some environments without
-- postmortem_redistribution AND without the new columns, so this rewrite uses
-- IF EXISTS / IF NOT EXISTS to converge any in-between state.
ALTER TABLE "drugs" DROP COLUMN IF EXISTS "postmortem_redistribution";--> statement-breakpoint
ALTER TABLE "drugs" ADD COLUMN IF NOT EXISTS "peak_concentration" jsonb;--> statement-breakpoint
ALTER TABLE "drugs" ADD COLUMN IF NOT EXISTS "tmax" jsonb;--> statement-breakpoint
ALTER TABLE "drugs" ADD COLUMN IF NOT EXISTS "pka" jsonb;
