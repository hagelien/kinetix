/**
 * Create (or re-sync) the kinetix-agent user row used by the hourly
 * drug-database maintenance routine. Idempotent via ON CONFLICT upsert on
 * the unique email column.
 *
 * The agent has role=contributor by design: every parameter/monograph
 * change the routine submits flows through the existing pending_edits
 * approval queue. Discussion comments and unreferenced-content flags
 * are posted directly (no review), which contributor already permits.
 *
 * Usage:
 *   npm run seed:agent-user          (reads DATABASE_URL from .env)
 *   DATABASE_URL=... npm run seed:agent-user
 *
 * Prerequisites:
 *   - The users table must exist (migration 0000 or later).
 *
 * Output: prints the agent user's id — wire it into the scheduler's env
 * so the routine's JWT claim `sub` matches.
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { agents, users } from '../db/schema';
import {
  AGENT_POOL_LOCK_KEY,
  AGENT_POOL_LOCK_NAMESPACE,
} from '../src/lib/agentPoolLock';

const AGENT_EMAIL = 'agent@kinetix.internal';
const AGENT_USERNAME = 'kinetix-agent';
const AGENT_ROLE = 'contributor';
// Public-facing metadata for the /agents listing (#319). Mirrors the
// migration 0020 backfill so a fresh DB seeded after migrations have
// run still gets a populated agents row. Norwegian is the canonical
// primary per the AGENTS.md bilingual convention.
const AGENT_NAME_NB = 'Kinetix vedlikeholdsagent';
const AGENT_NAME_EN = 'Kinetix maintenance agent';
const AGENT_DESCRIPTION_NB =
  'Kjører time-baserte oppdateringer mot legemiddeldatabasen. Sender atomiske faktaforslag for menneskelig gjennomgang.';
const AGENT_DESCRIPTION_EN =
  'Hourly drug-database curation routine. Submits parameter and monograph atomic-fact pending edits for human review.';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = neon(DATABASE_URL);
const db = drizzle(client);

async function main(): Promise<void> {
  // Preflight: refuse to revive an agent that an admin has already
  // deactivated. The lifecycle (migration 0024) treats `deactivated`
  // as terminal; running this script on top would bypass
  // transitionAgentStatus, skip the audit history, and re-promote
  // the backing user — silently undoing an intentional kill switch.
  const [existingAgent] = await db
    .select({
      id: agents.id,
      status: agents.status,
      userId: agents.userId,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(users.email, AGENT_EMAIL))
    .limit(1);
  if (existingAgent && existingAgent.status === 'deactivated') {
    console.error(
      [
        `[seed-agent-user] refusing to re-seed: agents.id=${existingAgent.id} is deactivated.`,
        'Reactivate via the admin UI first (PATCH /api/admin?resource=agents&id=N&action=transition)',
        'so the transition is audited; this script will then run normally.',
      ].join('\n'),
    );
    process.exit(2);
  }

  // Suspension is the lifecycle's reversible kill switch: it demotes
  // the backing user to `authenticated`. If the script re-promotes the
  // role on every run, the suspension stops disabling API permissions
  // even though `agents.status='suspended'` remains. Detect that
  // state here and skip the user-role re-sync; display-field refresh
  // still runs so admins can repair name/slug typos.
  const preserveSuspendedRole = existingAgent?.status === 'suspended';
  if (preserveSuspendedRole) {
    console.warn(
      `[seed-agent-user] agents.id=${existingAgent!.id} is suspended; preserving the backing user's role.`,
    );
  }

  const userConflictSet: Record<string, unknown> = {
    username: AGENT_USERNAME,
    // Re-sync on every run so a pre-existing unverified row doesn't
    // leave the account unusable for any auth path gated on a
    // verified email. The timestamp carries no user-visible meaning
    // for a service account, so overwriting it is safe.
    emailVerifiedAt: new Date(),
  };
  if (!preserveSuspendedRole) {
    userConflictSet.role = AGENT_ROLE;
  }
  const [row] = await db
    .insert(users)
    .values({
      email: AGENT_EMAIL,
      username: AGENT_USERNAME,
      role: AGENT_ROLE,
      // Pre-verified so downstream auth checks that gate on a verified
      // email never trip. The agent never uses magic-link login.
      emailVerifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.email,
      set: userConflictSet as never,
    })
    .returning({
      id: users.id,
      email: users.email,
      username: users.username,
      role: users.role,
    });
  // An upsert with RETURNING always yields the row; assert it rather than let
  // the id flow onward as undefined into the agents upsert below.
  if (!row) throw new Error(`upsert of ${AGENT_EMAIL} returned no row`);

  console.log(
    `[seed-agent-user] upserted: id=${row.id} email=${row.email} username=${row.username} role=${row.role}`,
  );

  // Upsert the matching agents row (#319). On a fresh DB the migration
  // 0020 backfill ran before this script existed and produced no rows
  // (kinetix-agent didn't exist yet); this upsert closes that gap so
  // /agents lists the agent immediately after seeding. The lifecycle
  // column is `status` (active|suspended|deactivated) as of migration
  // 0024 — keep this in sync if the enum widens.
  const upsert = db
    .insert(agents)
    .values({
      userId: row.id,
      name: AGENT_NAME_NB,
      nameEn: AGENT_NAME_EN,
      slug: AGENT_USERNAME,
      description: AGENT_DESCRIPTION_NB,
      descriptionEn: AGENT_DESCRIPTION_EN,
      status: 'active',
      // kinetix-agent owns the hook-triggered evaluator routine;
      // other agents (added via P2 admin CRUD) default to opted-out.
      hooksEnabled: true,
    })
    .onConflictDoUpdate({
      target: agents.userId,
      // Preserve the existing lifecycle status on conflict — only
      // fresh inserts land at 'active'. If an admin has suspended the
      // agent, this script must not silently reactivate it (the
      // deactivated path is already short-circuited above).
      set: {
        name: AGENT_NAME_NB,
        nameEn: AGENT_NAME_EN,
        description: AGENT_DESCRIPTION_NB,
        descriptionEn: AGENT_DESCRIPTION_EN,
        updatedAt: new Date(),
      },
    })
    .returning({ id: agents.id, slug: agents.slug });
  // A fresh insert grows the agent pool a consensus re-check counts, so it
  // runs in one transaction with the pool lock (src/lib/agentPoolLock.ts):
  // neon-http's batch is a single transaction, and the xact lock holds until
  // the upsert commits.
  const [, [agentRow]] = await db.batch([
    db.execute(
      sql`SELECT pg_advisory_xact_lock(${AGENT_POOL_LOCK_NAMESPACE}::int, ${AGENT_POOL_LOCK_KEY}::int)`,
    ),
    upsert,
  ]);
  if (agentRow) {
    console.log(
      `[seed-agent-user] agents row upserted: id=${agentRow.id} slug=${agentRow.slug}`,
    );
  }

  console.log(
    [
      '',
      'Scheduler wiring (handled outside this script):',
      `  1. Record user_id=${row.id} for admin/audit lookups; do not put it in the scheduler environment.`,
      '  2. Issue the agent a revocable kxat_ token: `npm run seed:agent-token`',
      '     (agent-backed users can no longer authenticate with a bare JWT).',
      '  3. Set the printed token as KINETIX_TOKEN in the scheduler; scripts/kinetix-api.sh',
      '     sends it as the __Host-kinetix-auth cookie on every API call.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('[seed-agent-user] error:', err);
  process.exit(1);
});
