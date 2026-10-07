-- T3 automatic closure (docs/plans/2026-09-18-t3-adjudication-backend.md,
-- PR 3). When a panel converges on a case that rests on agent disputes only,
-- the backend acts on its recommendation: both seats approving overrules the
-- agent disputes (`rejected`), both sustaining the objection upholds them and
-- returns the proposal. A person's dispute is never closed this way. The
-- column records what the closure did, or why it handed the case to a person.
ALTER TABLE "adjudication_cases"
  ADD COLUMN IF NOT EXISTS "closure" jsonb;
