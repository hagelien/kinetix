/**
 * Advisory-lock key that serialises growth of the agent pool with consensus
 * re-checks (issue #1357).
 *
 * A consensus re-check counts the active agents to pick its quorum (a pool of
 * two allows one approval, a pool of three needs two). Row locks cannot stop a
 * new agent INSERT, so every path that creates an agent takes this key
 * exclusively in its transaction — `pg_advisory_xact_lock(1357, 0)` — and the
 * re-check takes it shared. The admin API, `scripts/seed-agent-user.ts` and
 * the SQL in `agents/adding-a-new-agent.md` all use it.
 */
export const AGENT_POOL_LOCK_NAMESPACE = 1357;
export const AGENT_POOL_LOCK_KEY = 0;
