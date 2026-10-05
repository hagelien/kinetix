/**
 * An unquoted calculation-driving proposal goes back to the agent that wrote
 * it, not to a human moderator: the agents agree, and the missing quote is
 * something the author can supply (api/_lib/unquoted-edit-return.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentVerifications, agents, disputes, parameterEntries, pendingEdits } from '../../db/schema.js';
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

async function scenario(opts: {
  authorIsAgent: boolean;
  quote: string | null;
  approvals: number;
  agentDispute?: boolean;
  humanDispute?: boolean;
  upheldRuling?: boolean;
  proposedMeta?: Record<string, unknown>;
}) {
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
      proposedMeta:
        opts.proposedMeta ?? (opts.quote === null ? null : { sourceQuote: opts.quote }),
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
  if (opts.agentDispute) {
    const disputer = await seedAgent('verifier-disputer', 'mid');
    await db.insert(agentVerifications).values({
      agentId: disputer.agentId,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'dispute',
      verifierTier: 'mid',
      rationaleMd: 'Tabell 2 oppgir en annen verdi enn forslaget.',
    });
  }
  if (opts.humanDispute) {
    const human = await seedUser(db, { email: 'mod@example.com', username: 'mod', role: 'editor' });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: edit!.id,
      status: 'open',
      source: 'human',
      reasonMd: 'Verdien stemmer ikke med referansen som er oppgitt.',
      createdBy: human,
    });
  }
  if (opts.upheldRuling) {
    const human = await seedUser(db, { email: 'judge@example.com', username: 'judge', role: 'editor' });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: edit!.id,
      status: 'resolved',
      resolution: 'upheld',
      resolvedBy: human,
      resolvedAt: new Date(),
      source: 'human',
      reasonMd: 'Verdien stemmer ikke med referansen som er oppgitt.',
      createdBy: human,
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

  it('is not returned while a peer disputes it', async () => {
    const { outcome, row } = await scenario({ authorIsAgent: true, quote: null, approvals: 2, agentDispute: true });
    expect(outcome).toMatchObject({ outcome: 'held', reason: 'source_quote_missing' });
    expect(row.status).toBe('pending');
  });

  it('is not returned while a person disputes it', async () => {
    const { row } = await scenario({ authorIsAgent: true, quote: null, approvals: 2, humanDispute: true });
    expect(row.status).toBe('pending');
  });

  it('does not overwrite a reviewer’s standing return the author bare-resubmitted', async () => {
    // Returned with a substantive note, then resubmitted without a revision:
    // replacing that note with the quote-only one would let the author clear
    // the reviewer's objection by adding a quote.
    const { row } = await scenario({
      authorIsAgent: true,
      quote: null,
      approvals: 2,
      proposedMeta: { returnedAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(row.status).toBe('pending');
    expect(row.rejectionComment ?? '').not.toContain('source quote missing');
  });

  it('is not returned while an upheld ruling still binds the unrevised payload', async () => {
    const { row } = await scenario({ authorIsAgent: true, quote: null, approvals: 2, upheldRuling: true });
    expect(row.status).toBe('pending');
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

describe('a source-value update that only echoes the stored quote', () => {
  it('stays held rather than bouncing back to an author who cannot fix it', async () => {
    const author = (await seedAgent('author-agent', 'mid')).userId;
    const flagship = await seedAgent('verifier-flagship', 'flagship');
    const mid = await seedAgent('verifier-mid', 'mid');
    const drugId = await seedDrug(db, { slug: 'ghb' });
    const sentence = 'Terminal half-life ranged from 2 to 4 h.';
    const [entry] = await db
      .insert(parameterEntries)
      .values({ drugId, parameter: 'halfLife', low: '2', high: '4', unit: 'h', sourceQuote: sentence, createdBy: author } as never)
      .returning({ id: parameterEntries.id });
    // The reading moves but the sentence is the stored one: the write treats it
    // as an echo and the value would publish unquoted.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: entry!.id,
        parameter: 'halfLife',
        proposedValue: { op: 'update', patch: { low: 3, high: 5, quote: sentence } },
        submittedBy: author,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    for (const [agentId, tier] of [[flagship.agentId, 'flagship'], [mid.agentId, 'mid']] as const) {
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
    expect(outcome).toMatchObject({ outcome: 'held', reason: 'source_quote_missing' });
    const [row] = await db.select().from(pendingEdits).where(eq(pendingEdits.id, edit!.id));
    expect(row!.status).toBe('pending');
  });
});
