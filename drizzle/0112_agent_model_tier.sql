-- Server-owned capability tier for each agent, so the high-risk consensus gate
-- cannot be spoofed.
--
-- The gate that requires a flagship-tier approval before a calculation-driving
-- parameter auto-publishes (see api/_lib/agent-verifications.ts and
-- agents/peer-verification-protocol.md) must not read the tier from the verdict
-- POST body: `agent_verifications.model` is caller-supplied, so a mid- or
-- light-tier verifier could send `claude-opus-5` and have its approval counted
-- as flagship, defeating the gate. The tier belongs on the agent, set by an
-- admin who provisions it, not asserted by the agent at verdict time.
--
-- One of 'flagship' | 'mid' | 'light' (src/lib/modelTiers.ts). NULL = unknown,
-- which the gate treats as NOT flagship — the fail-safe direction: an
-- unclassified agent can never stand in for a top-tier reviewer. Populated per
-- deployment (admin / seed); `agent_verifications.model` stays as the recorded
-- self-report for audit and offline analysis, but is never trusted by the gate.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "model_tier" VARCHAR(20);
