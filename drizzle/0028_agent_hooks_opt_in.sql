-- Per-agent opt-in for the hook-triggered evaluator routine.
--
-- The system now supports multiple agents (kinetix-agent and any
-- additional agents seeded later). The hook-firing path in
-- api/_lib/agentHooks.ts dispatches to a single env-configured
-- routine URL, but only one of those agents — the comment-and-fact
-- evaluator — should drive hook traffic. Default the new flag to
-- FALSE so any future agent is "scheduled-only" until an operator
-- explicitly opts it in, and backfill the existing kinetix-agent so
-- current behaviour is preserved.

ALTER TABLE "agents"
  ADD COLUMN "hooks_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint

UPDATE "agents" SET "hooks_enabled" = TRUE WHERE "slug" = 'kinetix-agent';
