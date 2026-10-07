-- T3 adjudication outcomes (docs/plans/2026-09-18-t3-adjudication-backend.md
-- §3.5, §3.7). When both panel seats are final the case is sealed and the two
-- opinions are compared in code; these columns hold what that produced.
--
--   convergence     the typed comparison: whether the opinions agree on
--                   resolution, scope and (where both endorse one) value, and
--                   the reason when they do not.
--   recommendation  the agreed resolution, scope and canonical value of a
--                   converged case — a recommendation only; nothing here
--                   resolves a dispute.
--   t4_required     a person must take the case: the panel diverged, a
--                   panelist asked for a human, or a person's dispute is part
--                   of it.
--   handoff         the T4 package for that person: target and version, both
--                   opinions in full, the lower-tier record, the decisive
--                   sources and a statement of what remains disputed, so
--                   nobody reconstructs the appeal from logs.
--   adjudicated_target  the target's source row as the panel adjudicated it,
--                   copied at sealing for every outcome, so the record of what
--                   was decided survives later revisions of the live row.
ALTER TABLE "adjudication_cases"
  ADD COLUMN IF NOT EXISTS "convergence" jsonb;--> statement-breakpoint
ALTER TABLE "adjudication_cases"
  ADD COLUMN IF NOT EXISTS "recommendation" jsonb;--> statement-breakpoint
ALTER TABLE "adjudication_cases"
  ADD COLUMN IF NOT EXISTS "t4_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "adjudication_cases"
  ADD COLUMN IF NOT EXISTS "handoff" jsonb;;--> statement-breakpoint
ALTER TABLE "adjudication_cases"
  ADD COLUMN IF NOT EXISTS "adjudicated_target" jsonb;
