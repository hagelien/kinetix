/**
 * Mint a persistent, revocable API token (`kxat_…`) for a scheduled agent
 * maintenance routine and print it to stdout exactly once. This replaces the
 * old bare-JWT flow (scripts/kinetix-agent-jwt.ts): the JWT auth path now
 * rejects agent-backed users, so the agent must carry a `kxat_` token whose
 * kill switch is a single DB row (revoke) rather than a global JWT_SECRET
 * rotation.
 *
 * Only the SHA-256 hash of the token is stored; the plaintext printed here is
 * the only copy. Wire it into the scheduler as KINETIX_TOKEN (see
 * scripts/kinetix-api.sh).
 *
 * Required env:
 *   DATABASE_URL — same database the API reads.
 *
 * Optional env:
 *   AGENT_SLUG           — agent slug to issue for (default kinetix-agent).
 *   AGENT_TOKEN_TTL_DAYS — token lifetime in days (default 365, the max the
 *                          issuance path allows).
 *   AGENT_TOKEN_LABEL    — human label for the admin token listing.
 *
 * Usage:
 *   npm run seed:agent-token
 *   AGENT_SLUG=reflink-agent npm run seed:agent-token
 *   AGENT_TOKEN_TTL_DAYS=90 npm run seed:agent-token
 *
 * Prerequisites:
 *   - The agent user + agents row must exist (npm run seed:agent-user).
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import { issueAgentToken } from '../api/_lib/agentHelpers';
import { agents } from '../db/schema';

const agentSlug = process.env.AGENT_SLUG?.trim() || 'kinetix-agent';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const ttlDays = Number(process.env.AGENT_TOKEN_TTL_DAYS ?? 365);
if (!Number.isInteger(ttlDays) || ttlDays <= 0 || ttlDays > 365) {
  console.error('AGENT_TOKEN_TTL_DAYS must be an integer in 1..365');
  process.exit(1);
}

const label = process.env.AGENT_TOKEN_LABEL ?? `${agentSlug} scheduler`;

async function main(): Promise<void> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id, userId: agents.userId, status: agents.status })
    .from(agents)
    .where(eq(agents.slug, agentSlug))
    .limit(1);

  if (!agent) {
    console.error(
      `[seed-agent-token] no agents row with slug='${agentSlug}'. Create the agent row first.`,
    );
    process.exit(2);
  }

  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  // Bootstrap issuance: attribute creation to the agent's own backing user
  // (createdBy is advisory). Tokens minted later via Admin → Agents carry the
  // acting admin's id instead.
  const { token, row } = await issueAgentToken({
    agentId: agent.id,
    label,
    expiresAt,
    actorId: agent.userId,
  });

  console.error(
    [
      `[seed-agent-token] issued token id=${row.id} prefix=${row.prefix}`,
      `  agent slug=${agentSlug} agentId=${agent.id} expiresAt=${expiresAt.toISOString()}`,
      '  This plaintext is shown ONCE. Set it as KINETIX_TOKEN in the scheduler:',
      '',
    ].join('\n'),
  );
  // Token alone on stdout so `KINETIX_TOKEN=$(npm run --silent seed:agent-token)`
  // captures exactly the secret.
  process.stdout.write(token);
}

main().catch((err) => {
  console.error('[seed-agent-token] error:', err);
  process.exit(1);
});
