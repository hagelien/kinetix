/**
 * `setAgentRole` and `transitionAgentStatus` build their result row with a raw
 * `WITH agent_update AS (UPDATE … RETURNING …) SELECT … FROM agent_update` CTE.
 * When the final SELECT names a column the inner RETURNING does not emit, the
 * statement is invalid SQL and the whole admin operation 500s — a failure only
 * a real database shows, since the unit tests mock `db.execute`. This exercises
 * both against real SQL and asserts the server-owned `model_tier` round-trips,
 * which is exactly the column whose omission from one RETURNING broke role
 * changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../db/schema.js';
import { setAgentRole, transitionAgentStatus } from '../../api/_lib/agentHelpers.js';
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

async function seedFlagshipAgent(): Promise<{ agentId: number; actorId: number }> {
  const actorId = await seedUser(db, {
    email: 'admin@example.com',
    username: 'admin',
    role: 'admin',
  });
  const userId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'kinetix-opus-verifier',
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({
      userId,
      name: 'Flagship verifier',
      slug: 'kinetix-opus-verifier',
      status: 'active',
      modelTier: 'flagship',
    })
    .returning({ id: agents.id });
  return { agentId: row!.id, actorId };
}

describe('agentHelpers raw-SQL CTEs return model_tier', () => {
  it('setAgentRole promotes without invalid SQL and returns the stored tier', async () => {
    const { agentId, actorId } = await seedFlagshipAgent();
    const res = await setAgentRole({ agentId, role: 'editor', actorId });
    expect(res.role).toBe('editor');
    expect(res.agent.modelTier).toBe('flagship');
  });

  it('transitionAgentStatus suspends and returns the stored tier', async () => {
    const { agentId, actorId } = await seedFlagshipAgent();
    const res = await transitionAgentStatus({
      agentId,
      to: 'suspended',
      actorId,
    });
    expect(res.agent.status).toBe('suspended');
    expect(res.agent.modelTier).toBe('flagship');
  });
});
