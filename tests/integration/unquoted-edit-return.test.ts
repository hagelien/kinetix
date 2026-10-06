/**
 * An unquoted calculation-driving proposal goes back to the agent that wrote
 * it, not to a human moderator: the agents agree, and the missing quote is
 * something the author can supply (api/_lib/unquoted-edit-return.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentVerifications, agents, disputes, parameterEntries, pendingEdits } from '../../db/schema.js';
import { runAgentConsensus, sweepUnquotedAgentEdits } from '../../api/agent-verifications.js';
import { returnStandsUnrevised } from '../../api/_lib/pending-edit-review-token.js';
import { UNQUOTED_RETURN_PREFIX } from '../../api/_lib/unquoted-edit-return.js';
import { agentProposalLacksSourceQuote } from '../../api/_lib/source-quote-gate.js';
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

describe('the sweep', () => {
  async function seedEdit(opts: { authorIsAgent: boolean; quote: string | null; approvals: number }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const author = opts.authorIsAgent
      ? (await seedAgent(`author-${suffix}`, 'mid')).userId
      : await seedUser(db, { email: `h-${suffix}@example.com`, username: `h-${suffix}`, role: 'contributor' });
    const verifier = await seedAgent(`verifier-${suffix}`, 'flagship');
    const drugId = await seedDrug(db, { slug: `drug-${suffix}` });
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
    for (let i = 0; i < opts.approvals; i++) {
      await db.insert(agentVerifications).values({
        agentId: verifier.agentId,
        targetType: 'pending_edit',
        targetId: edit!.id,
        verdict: 'approve',
        verifierTier: 'flagship',
        rationaleMd: '',
      });
    }
    return edit!.id;
  }

  it('returns an unquoted agent proposal whatever its tally, and nothing else', async () => {
    const oneApproval = await seedEdit({ authorIsAgent: true, quote: null, approvals: 1 });
    const noApproval = await seedEdit({ authorIsAgent: true, quote: null, approvals: 0 });
    const quoted = await seedEdit({ authorIsAgent: true, quote: 'Half-life was 33 h.', approvals: 1 });
    const human = await seedEdit({ authorIsAgent: false, quote: null, approvals: 1 });

    const returned = await sweepUnquotedAgentEdits();
    expect(returned.sort()).toEqual([oneApproval, noApproval].sort());

    const statuses = await db
      .select({ id: pendingEdits.id, status: pendingEdits.status })
      .from(pendingEdits);
    const statusOf = (id: number) => statuses.find((r) => r.id === id)!.status;
    expect(statusOf(oneApproval)).toBe('returned');
    expect(statusOf(noApproval)).toBe('returned');
    expect(statusOf(quoted)).toBe('pending');
    expect(statusOf(human)).toBe('pending');

    // Idempotent: nothing left to return.
    expect(await sweepUnquotedAgentEdits()).toEqual([]);
  });

  it('pages past older proposals that need no quote instead of stalling on them', async () => {
    // Older than the unquoted proposal, and all passing the SQL pre-filter:
    // updates that omit the quote but restate the reading, so the stored
    // sentence carries over and the gate finds them quoted.
    const author = (await seedAgent('author-keeper', 'mid')).userId;
    const drugId = await seedDrug(db, { slug: 'kept' });
    const older = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      const [entry] = await db
        .insert(parameterEntries)
        .values({ drugId, parameter: 'halfLife', low: '2', high: '4', unit: 'h', sourceQuote: `Half-life was 2 to 4 h (${i}).`, createdBy: author } as never)
        .returning({ id: parameterEntries.id });
      await db.insert(pendingEdits).values({
        editType: 'param_entry',
        targetId: entry!.id,
        parameter: 'halfLife',
        proposedValue: { op: 'update', patch: { low: 2, high: 4, unit: 'h' } },
        submittedBy: author,
        status: 'pending',
        submittedAt: older,
      });
    }
    const unquoted = await seedEdit({ authorIsAgent: true, quote: null, approvals: 1 });

    // A window of two: the old sweep spent it on the first two carried-over
    // updates every pass and never reached the unquoted proposal.
    expect(await sweepUnquotedAgentEdits(2)).toEqual([unquoted]);
  });

  it('tells the author of a stale proposal to rebase, not only to add the quote', async () => {
    const author = (await seedAgent('author-stale', 'mid')).userId;
    const drugId = await seedDrug(db, { slug: 'stale' });
    const [entry] = await db
      .insert(parameterEntries)
      .values({ drugId, parameter: 'halfLife', low: '2', high: '4', unit: 'h', createdBy: author } as never)
      .returning({ id: parameterEntries.id });
    // Marked stale by a direct write to its target since it was proposed.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: entry!.id,
        parameter: 'halfLife',
        proposedValue: { op: 'update', patch: { low: 3, high: 5, unit: 'h' } },
        proposedMeta: { conflict: { reason: 'direct_admin_write', id: 'c1', at: new Date().toISOString() } },
        submittedBy: author,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    expect(await sweepUnquotedAgentEdits()).toEqual([edit!.id]);
    const [row] = await db.select().from(pendingEdits).where(eq(pendingEdits.id, edit!.id));
    expect(row!.rejectionComment).toContain(UNQUOTED_RETURN_PREFIX);
    expect(row!.rejectionComment).toMatch(/stale/);
    // The marker stays: only the author's rebase clears it.
    expect((row!.proposedMeta as Record<string, unknown>).conflict).toBeTruthy();
  });

  it('examines at most its scan budget per pass, and rotates where it starts', async () => {
    const author = (await seedAgent('author-budget', 'mid')).userId;
    const drugId = await seedDrug(db, { slug: 'budget' });
    for (let i = 0; i < 3; i++) {
      const [entry] = await db
        .insert(parameterEntries)
        .values({ drugId, parameter: 'halfLife', low: '2', high: '4', unit: 'h', sourceQuote: `Half-life was 2 to 4 h (${i}).`, createdBy: author } as never)
        .returning({ id: parameterEntries.id });
      await db.insert(pendingEdits).values({
        editType: 'param_entry',
        targetId: entry!.id,
        parameter: 'halfLife',
        proposedValue: { op: 'update', patch: { low: 2, high: 4, unit: 'h' } },
        submittedBy: author,
        status: 'pending',
      });
    }
    const unquoted = await seedEdit({ authorIsAgent: true, quote: null, approvals: 0 });

    // From the bottom, a budget of two rows ends among the carried-over
    // updates: the pass stops instead of walking the whole backlog.
    expect(await sweepUnquotedAgentEdits(1, { scanBudget: 2, startId: 0 })).toEqual([]);
    // A pass that starts elsewhere reaches it.
    expect(await sweepUnquotedAgentEdits(1, { scanBudget: 2, startId: unquoted })).toEqual([unquoted]);
  });

  it('returns a proposal whose agent dispute a moderator has overruled', async () => {
    const id = await seedEdit({ authorIsAgent: true, quote: null, approvals: 1 });
    const disputer = await seedAgent('overruled-disputer', 'mid');
    await db.insert(agentVerifications).values({
      agentId: disputer.agentId,
      targetType: 'pending_edit',
      targetId: id,
      verdict: 'dispute',
      verifierTier: 'mid',
      rationaleMd: 'Tabell 2 oppgir en annen verdi enn forslaget.',
      updatedAt: new Date(Date.now() - 60 * 1000),
    });
    const moderator = await seedUser(db, { email: 'mod2@example.com', username: 'mod2', role: 'editor' });
    // The verdict stays as testimony; the ruling against it is what clears it.
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: id,
      status: 'resolved',
      resolution: 'rejected',
      resolvedBy: moderator,
      resolvedAt: new Date(),
      source: 'agent',
      reasonMd: 'Tabell 2 oppgir en annen verdi enn forslaget.',
      createdBy: disputer.userId,
    });

    expect(await sweepUnquotedAgentEdits()).toEqual([id]);
  });
});

describe('at submission', () => {
  it('refuses only an agent’s unquoted calculation-driving proposal', async () => {
    const agent = (await seedAgent('submitter', 'mid')).userId;
    const human = await seedUser(db, { email: 'person@example.com', username: 'person', role: 'contributor' });
    const unquoted = {
      editType: 'parameter',
      parameter: 'halfLife',
      proposedValue: { value: 33 },
      proposedMeta: {},
    };
    const quoted = { ...unquoted, proposedMeta: { sourceQuote: 'Half-life was 33 h.' } };
    const blankQuote = { ...unquoted, proposedMeta: { sourceQuote: '   ' } };

    expect(await agentProposalLacksSourceQuote(agent, unquoted)).toBe(true);
    expect(await agentProposalLacksSourceQuote(agent, blankQuote)).toBe(true);
    expect(await agentProposalLacksSourceQuote(agent, quoted)).toBe(false);
    expect(await agentProposalLacksSourceQuote(human, unquoted)).toBe(false);
  });

  it('leaves an authored parameter alone: the gate covers entry-backed ones only', async () => {
    // PUT /api/drug-parameter refuses every entry-backed parameter, so the
    // parameters it does take sit outside the consensus quote gate as well.
    const agent = (await seedAgent('author-authored', 'mid')).userId;
    expect(
      await agentProposalLacksSourceQuote(agent, {
        editType: 'parameter',
        parameter: 'molecularWeight',
        proposedValue: { value: 180.16 },
        proposedMeta: {},
      }),
    ).toBe(false);
  });
});
