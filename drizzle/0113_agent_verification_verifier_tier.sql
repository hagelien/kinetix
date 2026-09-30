-- Snapshot the verifier's capability tier onto each verdict.
--
-- The high-risk consensus gate must know the tier of the model that ACTUALLY
-- cast each approval. Reading the live agents.model_tier at tally time is wrong:
-- if an agent identity is later reassigned from a mid-tier to a flagship model,
-- every one of its past mid-tier approvals would retroactively count as
-- flagship (and a downgrade would erase valid flagship approvals). The tier that
-- mattered is the one in force when the verdict was admitted, so it is captured
-- here at write time and the gate reads this column instead of the mutable
-- agent row.
--
-- One of 'flagship' | 'mid' | 'light' (src/lib/modelTiers.ts), copied from the
-- verifier's agents.model_tier when the verdict is recorded. NULL = the verifier
-- was unclassified at that time, which never counts as flagship (fail-safe).
ALTER TABLE "agent_verifications"
  ADD COLUMN IF NOT EXISTS "verifier_tier" VARCHAR(20);
