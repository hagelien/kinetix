/**
 * Caps on the agent hook fires that comments cause, against real SQL.
 *
 * `comment_posted` is the one hook event a lowest-tier signed-in user can
 * cause, and each fire starts a billed routine session. The caps are counted
 * from the database — the author's drug-scoped comments, and everyone's, in
 * the last hour — so they hold across serverless instances. A capped fire is recorded as `skipped` / `rate_limited`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc } from 'drizzle-orm';
import { agentHookRuns, agents, drugParameterDiscussions } from '../../db/schema.js';
import {
  COMMENT_HOOK_GLOBAL_LIMIT,
  COMMENT_HOOK_PER_AUTHOR_LIMIT,
  _resetAgentUserCache,
  fireAgentHookForActor,
} from '../../api/_lib/agentHooks.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;

beforeAll(async () => {
  // No hook endpoint configured: an uncapped fire stops at "not configured"
  // and records a plain `skipped`, which tells it apart from a capped one.
  delete process.env.CLAUDE_CODE_AGENT_HOOK_URL;
  delete process.env.CLAUDE_CODE_AGENT_HOOK_TOKEN;
  delete process.env.CLAUDE_CODE_AGENT_HOOKS_DISABLED;
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  // The agent-user cache outlives the truncation (it is module state, and the
  // integration worker shares modules across files): ids restart, so a stale
  // entry could mark this file's commenter as an agent.
  _resetAgentUserCache();
  userId = await seedUser(db, { role: 'authenticated' });
  drugId = await seedDrug(db);
});

async function postComments(n: number, author = userId) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const [row] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId, parameter: 'halfLife', body: `c${i}`, createdBy: author })
      .returning({ id: drugParameterDiscussions.id });
    ids.push(row!.id);
  }
  return ids;
}

async function fireFor(commentId: number) {
  await fireAgentHookForActor(userId, {
    kind: 'comment_posted',
    drugId,
    parameter: 'halfLife',
    commentId,
    authorUserId: userId,
    body: 'x',
  });
  const [run] = await db
    .select({ outcome: agentHookRuns.outcome, errorMessage: agentHookRuns.errorMessage })
    .from(agentHookRuns)
    .orderBy(desc(agentHookRuns.id))
    .limit(1);
  return run!;
}

describe('comment hook caps', () => {
  it('fires for a commenter within the per-author cap', async () => {
    const ids = await postComments(COMMENT_HOOK_PER_AUTHOR_LIMIT);
    expect(await fireFor(ids.at(-1)!)).toEqual({ outcome: 'skipped', errorMessage: null });
  });

  it('skips a fire once the commenter is over the per-author cap', async () => {
    const ids = await postComments(COMMENT_HOOK_PER_AUTHOR_LIMIT + 1);
    expect(await fireFor(ids.at(-1)!)).toEqual({
      outcome: 'skipped',
      errorMessage: 'rate_limited',
    });
  });

  // Comments are committed before their hook fires, so counting them (not
  // recorded runs) includes every fire still in flight in a concurrent burst.
  it('skips a fire once people across the site exceed the global cap', async () => {
    const others = await Promise.all(
      Array.from({ length: COMMENT_HOOK_GLOBAL_LIMIT }, (_, i) =>
        seedUser(db, { email: `u${i}@example.com`, username: `u${i}`, role: 'authenticated' }),
      ),
    );
    for (const author of others) await postComments(1, author);
    const [commentId] = await postComments(1);
    expect(await fireFor(commentId!)).toEqual({
      outcome: 'skipped',
      errorMessage: 'rate_limited',
    });
  });

  it("does not count agents' comments toward the global cap", async () => {
    const agentUser = await seedUser(db, {
      email: 'agent@example.com',
      username: 'agent',
      role: 'contributor',
    });
    await db.insert(agents).values({ userId: agentUser, name: 'a', slug: 'a', status: 'active' });
    await postComments(COMMENT_HOOK_GLOBAL_LIMIT + 5, agentUser);
    const [commentId] = await postComments(1);
    expect(await fireFor(commentId!)).toEqual({ outcome: 'skipped', errorMessage: null });
  });
});
