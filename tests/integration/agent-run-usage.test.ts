/**
 * `recordAgentRunUsage` against real SQL: the tier is the server-side snapshot
 * of `agents.model_tier` at write time, and a second log for the same
 * (agent, session) replaces the row — both depend on the subquery and the
 * unique index matching the ON CONFLICT target, which only a real database
 * checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRunUsage, agents } from '../../db/schema.js';
import { recordAgentRunUsage } from '../../api/_lib/agent-run-usage.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

async function seedAgent(modelTier: string | null) {
  const userId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'claude-sonnet-5',
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({
      userId,
      name: 'Sonnet',
      slug: 'claude-sonnet-5',
      status: 'active',
      modelTier,
    })
    .returning({ id: agents.id });
  return { agentId: row!.id, userId };
}

const run = {
  workflow: 'producer' as const,
  runtime: 'claude-code' as const,
  model: 'claude-sonnet-5',
  sessionId: 'sess-1',
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 5,
  cacheReadTokens: 900,
};

describe('recordAgentRunUsage', () => {
  it('snapshots the tier at write time', async () => {
    const { agentId, userId } = await seedAgent('mid');
    const first = await recordAgentRunUsage({ agentId, userId, data: run });
    expect(first?.modelTier).toBe('mid');

    // Reclassifying the identity later does not move the past run.
    await db
      .update(agents)
      .set({ modelTier: 'flagship' })
      .where(eq(agents.id, agentId));
    const second = await recordAgentRunUsage({
      agentId,
      userId,
      data: { ...run, sessionId: 'sess-2' },
    });
    expect(second?.modelTier).toBe('flagship');
    const [past] = await db
      .select({ tier: agentRunUsage.modelTier })
      .from(agentRunUsage)
      .where(eq(agentRunUsage.id, first!.id));
    expect(past?.tier).toBe('mid');
  });

  it("keeps the first write's tier, workflow and time when a run is re-logged after reclassification", async () => {
    const { agentId, userId } = await seedAgent('mid');
    const first = await recordAgentRunUsage({ agentId, userId, data: run });
    const [before] = await db.select().from(agentRunUsage);

    await db
      .update(agents)
      .set({ modelTier: 'flagship' })
      .where(eq(agents.id, agentId));
    const again = await recordAgentRunUsage({
      agentId,
      userId,
      data: { ...run, workflow: 'escalation', outputTokens: 50 },
    });

    expect(again).toEqual({ id: first!.id, modelTier: 'mid' });
    const [after] = await db.select().from(agentRunUsage);
    expect(after).toMatchObject({
      modelTier: 'mid',
      workflow: 'producer',
      outputTokens: 50,
    });
    expect(after!.createdAt).toEqual(before!.createdAt);
  });

  it('stores the per-model split', async () => {
    const { agentId, userId } = await seedAgent('mid');
    const split = {
      'claude-sonnet-5': {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 5,
        cacheReadTokens: 900,
      },
    };
    await recordAgentRunUsage({
      agentId,
      userId,
      data: { ...run, modelUsage: split },
    });
    const [row] = await db.select().from(agentRunUsage);
    expect(row!.modelUsage).toEqual(split);
  });

  it('records an unclassified identity as NULL, never a guessed tier', async () => {
    const { agentId, userId } = await seedAgent(null);
    const row = await recordAgentRunUsage({ agentId, userId, data: run });
    expect(row?.modelTier).toBeNull();
  });

  it('replaces the row on a re-log of the same session instead of double-counting', async () => {
    const { agentId, userId } = await seedAgent('mid');
    const first = await recordAgentRunUsage({ agentId, userId, data: run });
    const again = await recordAgentRunUsage({
      agentId,
      userId,
      data: { ...run, outputTokens: 50 },
    });
    expect(again?.id).toBe(first?.id);
    const rows = await db.select().from(agentRunUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outputTokens: 50, cacheReadTokens: 900 });

    // Runs without a session id never collide (NULLs are distinct).
    await recordAgentRunUsage({
      agentId,
      userId,
      data: { ...run, sessionId: null },
    });
    await recordAgentRunUsage({
      agentId,
      userId,
      data: { ...run, sessionId: null },
    });
    expect(await db.select().from(agentRunUsage)).toHaveLength(3);
  });
});
