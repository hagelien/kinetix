-- Preserve elevated agent roles across a reversible suspension.
--
-- The agents lifecycle (migration 0024) demotes the backing users row
-- to `authenticated` whenever an agent is suspended or deactivated.
-- For deactivation that's correct — the row is terminal. For
-- suspension it discards an intentional elevation (e.g. an `editor`
-- agent), and reactivation could only restore back to `contributor`.
--
-- This column captures the role the user held the moment we suspend,
-- so a later active transition can restore the exact prior tier. The
-- column is cleared whenever the agent returns to `active` or is
-- finally deactivated; it should never carry meaning while
-- agents.status='active'.

ALTER TABLE "agents" ADD COLUMN "pre_suspension_role" VARCHAR(20);
