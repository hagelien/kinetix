/**
 * An unquoted calculation-driving proposal goes back to the agent that wrote
 * it, not to a human moderator: the agents agree, and the missing quote is
 * something the author can supply (api/_lib/unquoted-edit-return.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentVerifications, agents, pendingEdits } from '../../db/schema.js';
import { runAgentConsensus } from '../../api/agent-verifications.js';
import { returnStandsUnrevised } from '../../api/_lib/pending-edit-review-token.js';
import { UNQUOTED_RETURN_PREFIX } from '../../api/_lib/unquoted-edit-return.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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

async function seedAgent(name: string, tier: string | null): Promise<{ userId: number; agentId: number }> {
  const userId = await seedUser(db, { email: `${name}@example.com`, username: name, role: 'contributor' });
  const [agent] = await db
    .insert(agents)
    .values({ userId, name, slug: name, status: 'active', modelTier: tier })
    .returning({ id: agents.id });
  return { userId, agentId: agent!.id };
}

async function scenario(opts: { authorIsAgent: boolean; quote: string | null; approvals: number }) {
  const author = opts.authorIsAgent
    ? (await seedAgent('author-agent', 'mid')).userId
    : await seedUser(db, { email: 'human@example.com', username: 'human', role: 'contributor' });
  const flagship = await seedAgent('verifier-flagship', 'flagship');
  const mid = await seedAgent('verifier-mid', 'mid');
  const drugId = await seedDrug(db, { slug: 'ghb' });
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'parameter',
      targetId: drugId,
      parameter: 'halfLife',
      proposedValue: { value: 33 },
      proposedMeta: opts.quote === null ? null : { sourceQuote: opts.quote },
      submittedBy: author,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  const verifiers: Array<[number, string]> = [
    [flagship.agentId, 'flagship'],
    [mid.agentId, 'mid'],
  ];
  for (const [agentId, tier] of verifiers.slice(0, opts.approvals)) {
    await db.insert(agentVerifications).values({
      agentId,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      verifierTier: tier,
      rationaleMd: '',
    });
  }
  const outcome = await runAgentConsensus({ pendingEditId: edit!.id, approverUserId: flagship.userId });
  const [row] = await db.select().from(pendingEdits).where(eq(pendingEdits.id, edit!.id));
  return { outcome, row: row! };
}

describe('an unquoted calculation-driving proposal', () => {
  it('goes back to the submitting agent with a note, instead of waiting for a person', async () => {
    const { outcome, row } = await scenario({ authorIsAgent: true, quote: null, approvals: 2 });
    expect(outcome).toMatchObject({ outcome: 'held', reason: 'source_quote_missing' });
    expect(row.status).toBe('returned');
    expect(row.rejectionComment).toMatch(new RegExp(`^${UNQUOTED_RETURN_PREFIX.replace(/[[\]]/g, '\\$&')}`));
    expect(row.rejectionComment).toContain('halfLife');
    expect(row.reviewedBy).toBeNull();
    // Consensus stays held until the author actually revises it.
    expect(returnStandsUnrevised(row.proposedMeta)).toBe(true);
  });

  it('stays in the human queue when a person submitted it', async () => {
    const { outcome, row } = await scenario({ authorIsAgent: false, quote: null, approvals: 2 });
    expect(outcome).toMatchObject({ outcome: 'held', reason: 'source_quote_missing' });
    expect(row.status).toBe('pending');
  });
});

describe('a quoted proposal', () => {
  it('is not returned', async () => {
    const { outcome, row } = await scenario({
      authorIsAgent: true,
      quote: 'Terminal half-life averaged 33 h in healthy adults.',
      approvals: 1,
    });
    expect(outcome).toMatchObject({ outcome: 'held', reason: 'quorum_unmet' });
    expect(row.status).toBe('pending');
  });
});
