/**
 * The cost section of scripts/benchmark-agent-tiers.ts against real SQL: which
 * outputs a logged run is credited with depends on the queries' time bounds,
 * which the pure-function unit tests cannot see.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentRunUsage,
  agentVerifications,
  agents,
  pendingEdits,
} from '../../db/schema.js';
import { runBenchmark } from '../../scripts/benchmark-agent-tiers.js';
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

const at = (hhmm: string) => new Date(`2026-10-02T${hhmm}:00Z`);
const rateCard = {
  sonnet: { inputPerMTok: 3, outputPerMTok: 15, models: ['sonnet-5'] },
};

/** One agent with one logged run from 00:00 to 01:00 costing $4.50. */
async function seedRun() {
  const humanId = await seedUser(db, {
    email: 'editor@example.com',
    username: 'editor',
    role: 'editor',
  });
  const userId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'claude-sonnet-5',
    role: 'contributor',
  });
  const [agent] = await db
    .insert(agents)
    .values({
      userId,
      name: 'Sonnet',
      slug: 'claude-sonnet-5',
      status: 'active',
      modelTier: 'mid',
    })
    .returning({ id: agents.id });
  await db.insert(agentRunUsage).values({
    agentId: agent!.id,
    createdBy: userId,
    modelTier: 'mid',
    workflow: 'producer',
    runtime: 'claude-code',
    model: 'claude-sonnet-5',
    sessionId: 's1',
    startedAt: at('00:00'),
    durationMs: 3_600_000,
    createdAt: at('01:00'),
    inputTokens: 1_000_000,
    outputTokens: 100_000,
  });
  return { agentId: agent!.id, userId, humanId };
}

describe('benchmark cost-per-output bounds', () => {
  it('credits a run with a verdict it revised, though first cast before telemetry', async () => {
    const { agentId } = await seedRun();
    await db.insert(agentVerifications).values({
      agentId,
      targetType: 'pending_edit',
      targetId: 1,
      verdict: 'approve',
      rationaleMd: 'Checked against the primary source.',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: at('00:30'),
    });

    const report = await runBenchmark({ since: null, rateCard });
    const [sonnet] = report.agentCosts;
    expect(sonnet).toMatchObject({ verdicts: 1 });
    expect(sonnet!.costPerVerdict).toBeCloseTo(4.5);
  });

  it('credits a run under way at --since with its outputs from before the cutoff', async () => {
    const { userId, humanId } = await seedRun();
    await db.insert(pendingEdits).values({
      editType: 'parameter',
      proposedValue: { min: 1, max: 2 },
      status: 'approved',
      submittedBy: userId,
      reviewedBy: humanId,
      submittedAt: at('00:10'),
    });

    const report = await runBenchmark({ since: at('00:30'), rateCard });
    const [sonnet] = report.agentCosts;
    expect(sonnet).toMatchObject({ runs: 1, acceptedEdits: 1 });
    expect(sonnet!.costPerAcceptedEdit).toBeCloseTo(4.5);
  });
});
