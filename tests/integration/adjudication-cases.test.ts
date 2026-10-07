/**
 * T3 adjudication cases against real SQL
 * (docs/plans/2026-09-18-t3-adjudication-backend.md §3.1–§3.3, §3.6, §5):
 * the detector opens one permanent case per (target, version), a moved target
 * invalidates its live case, a decided version never reopens, the verdicts are
 * copied so a later re-verdict cannot rewrite the appeal, seats are claimed
 * atomically by eligible adjudicators only, and opinions are append-only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { eq, sql } from 'drizzle-orm';
import {
  adjudicationCaseSeats,
  adjudicationCases,
  adjudicationOpinions,
  agentVerifications,
  agents,
  disputes,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import handler from '../../api/agent-verifications.js';
import {
  claimAdjudicationSeat,
  detectAdjudicationCase,
  sweepAdjudicationCases,
} from '../../api/_lib/adjudication/cases.js';
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
  getUserFromRequestMock.mockReset();
});

async function seedAgent(
  slug: string,
  opts: { tier?: string | null; adjudicator?: boolean; status?: string } = {},
) {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({
      userId,
      name: slug,
      slug,
      status: opts.status ?? 'active',
      modelTier: opts.tier ?? null,
      adjudicator: opts.adjudicator ?? false,
    })
    .returning({ id: agents.id });
  return { userId, agentId: row!.id };
}

/** A published page and a pending fact edit on it, submitted by `authorUserId`. */
async function seedEdit(authorUserId: number) {
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: `page-${Math.random().toString(36).slice(2)}`,
      title: 'Diazepam',
      status: 'published',
      createdBy: authorUserId,
      updatedBy: authorUserId,
    })
    .returning({ id: wikiPages.id });
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 20–100 timer.',
      proposedValue: { factStatement: 'Halveringstiden er 20–100 timer.' },
      submittedBy: authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id, submittedAt: pendingEdits.submittedAt });
  return {
    editId: edit!.id,
    version: `${edit!.submittedAt.toISOString()}|pending`,
  };
}

async function verdictOn(
  agentId: number,
  editId: number,
  verdict: 'approve' | 'dispute' | 'abstain',
  tier: string | null,
  rationaleMd = `Vurdering fra agent ${agentId}.`,
) {
  const [row] = await db
    .insert(agentVerifications)
    .values({
      agentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict,
      rationaleMd,
      evidenceRefs: [],
      isImplicit: false,
      verifierTier: tier,
      recordedVerifierTier: tier,
    })
    .onConflictDoUpdate({
      target: [
        agentVerifications.agentId,
        agentVerifications.targetType,
        agentVerifications.targetId,
      ],
      set: { verdict, rationaleMd, updatedAt: new Date() },
    })
    .returning({ id: agentVerifications.id });
  return row!.id;
}

/** A T1 dispute and a T2 approval on a fresh edit: the canonical T3 case. */
async function seedDisagreement() {
  const author = await seedAgent('author', { tier: 'mid' });
  const t1 = await seedAgent('t1', { tier: 'mid' });
  const t2 = await seedAgent('t2', { tier: 'flagship' });
  const edit = await seedEdit(author.userId);
  const t1Verdict = await verdictOn(t1.agentId, edit.editId, 'dispute', 'mid', 'Verdien er feil.');
  const t2Verdict = await verdictOn(t2.agentId, edit.editId, 'approve', 'flagship', 'Stemmer med kilden.');
  return { author, t1, t2, ...edit, t1Verdict, t2Verdict };
}

async function casesFor(editId: number) {
  return db
    .select()
    .from(adjudicationCases)
    .where(eq(adjudicationCases.targetId, editId))
    .orderBy(adjudicationCases.id);
}

describe('T3 case detection', () => {
  it('opens one case pinned to the version, with the lower tiers copied in', async () => {
    const s = await seedDisagreement();
    const outcome = await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    expect(outcome.result).toBe('opened');

    const [kase] = await casesFor(s.editId);
    expect(kase).toMatchObject({
      targetType: 'pending_edit',
      targetVersion: s.version,
      triggers: ['t1_t2_disagreement'],
      disputeOrigin: 'agent',
      state: 'open',
      t2VerificationId: s.t2Verdict,
    });
    expect(kase!.t2Snapshot.map((v) => v.rationaleMd)).toEqual(['Stemmer med kilden.']);
    expect(kase!.t1Snapshot.verdicts.map((v) => v.verdict)).toEqual(['dispute']);
  });

  it('is not rewritten by a later re-verdict on the same version', async () => {
    const s = await seedDisagreement();
    await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    // T2 re-verdicts in place (the verdict row is upserted, same id).
    await verdictOn(s.t2.agentId, s.editId, 'approve', 'flagship', 'Omskrevet begrunnelse.');
    expect(
      (await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId })).result,
    ).toBe('unchanged');

    const [kase] = await casesFor(s.editId);
    expect(kase!.t2Snapshot.map((v) => v.rationaleMd)).toEqual(['Stemmer med kilden.']);
  });

  it('opens nothing on a T1 dispute before T2 has spoken', async () => {
    const author = await seedAgent('author', { tier: 'mid' });
    const t1 = await seedAgent('t1', { tier: 'mid' });
    const edit = await seedEdit(author.userId);
    await verdictOn(t1.agentId, edit.editId, 'dispute', 'mid');

    expect(
      (await detectAdjudicationCase({ targetType: 'pending_edit', targetId: edit.editId })).result,
    ).toBe('none');
    expect(await casesFor(edit.editId)).toEqual([]);
  });

  it('records a person’s open dispute as the case’s origin', async () => {
    const s = await seedDisagreement();
    const human = await seedUser(db, { email: 'h@example.com', username: 'h', role: 'contributor' });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: s.editId,
      createdBy: human,
      source: 'human',
      reasonMd: 'Feil populasjon.',
      targetVersion: s.version,
    });
    await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    const [kase] = await casesFor(s.editId);
    expect(kase!.disputeOrigin).toBe('human');
    expect(kase!.t1Snapshot.openDisputes.map((d) => d.source)).toEqual(['human']);
  });

  it('adds a later trigger to the live case without touching its snapshots', async () => {
    const s = await seedDisagreement();
    await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    const second = await seedAgent('t2b', { tier: 'flagship' });
    await verdictOn(second.agentId, s.editId, 'dispute', 'flagship');

    const outcome = await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    expect(outcome.result).toBe('joined');
    const [kase] = await casesFor(s.editId);
    expect(kase!.triggers).toEqual(['t1_t2_disagreement', 'flagship_disagreement']);
    expect(kase!.t2Snapshot).toHaveLength(1);
  });

  it('invalidates a live case when the target moves, and adjudicates the new version afresh', async () => {
    const s = await seedDisagreement();
    await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    // A revision: a new submittedAt is a new version.
    const revisedAt = new Date(Date.now() + 60_000);
    await db
      .update(pendingEdits)
      .set({ submittedAt: revisedAt })
      .where(eq(pendingEdits.id, s.editId));

    const outcome = await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    expect(outcome.invalidated).toBe(1);
    expect(outcome.result).toBe('opened');
    const cases = await casesFor(s.editId);
    expect(cases.map((c) => [c.state, c.invalidatedReason])).toEqual([
      ['invalidated', 'target_version_moved'],
      ['open', null],
    ]);
    expect(cases[1]!.targetVersion).toBe(`${revisedAt.toISOString()}|pending`);
  });

  it('never reopens a decided version, however often the sweep re-reads it', async () => {
    const s = await seedDisagreement();
    await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    await db
      .update(adjudicationCases)
      .set({ state: 'converged', closedAt: new Date() })
      .where(eq(adjudicationCases.targetId, s.editId));

    for (let i = 0; i < 3; i++) await sweepAdjudicationCases();
    expect(
      (await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId })).result,
    ).toBe('terminal');
    expect(await casesFor(s.editId)).toHaveLength(1);
  });

  it('is the sweep’s backstop: opens what the verdict path missed and invalidates moved targets', async () => {
    const s = await seedDisagreement();
    const first = await sweepAdjudicationCases();
    expect(first.opened).toHaveLength(1);

    await db
      .update(pendingEdits)
      .set({ status: 'returned' })
      .where(eq(pendingEdits.id, s.editId));
    const second = await sweepAdjudicationCases();
    expect(second.invalidated).toBe(1);
    // The returned version still carries the disagreement, so it is its own case.
    expect(second.opened).toHaveLength(1);
  });

  it('opens the case at verdict time when the T2 approval lands through the API', async () => {
    const author = await seedAgent('author', { tier: 'mid' });
    const t1 = await seedAgent('t1', { tier: 'mid' });
    const t2 = await seedAgent('t2', { tier: 'flagship' });
    const edit = await seedEdit(author.userId);
    await verdictOn(t1.agentId, edit.editId, 'dispute', 'mid');

    getUserFromRequestMock.mockResolvedValue({ userId: t2.userId, role: 'contributor' });
    const body = JSON.stringify({
      targetType: 'pending_edit',
      targetId: edit.editId,
      targetVersion: edit.version,
      verdict: 'approve',
      rationaleMd: 'Kontrollert mot primærkilden; verdien stemmer.',
    });
    const req = Readable.from([body]) as IncomingMessage;
    req.method = 'POST';
    req.url = '/api/agent-verifications';
    req.headers = {
      host: 'localhost',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    const state = { statusCode: 0 };
    const res = {
      headersSent: false,
      writeHead: vi.fn((code: number) => {
        state.statusCode = code;
        return res;
      }),
      end: vi.fn(() => res),
    } as unknown as ServerResponse;
    await handler(req, res);
    expect(state.statusCode).toBeLessThan(300);

    const [kase] = await casesFor(edit.editId);
    expect(kase).toMatchObject({ state: 'open', triggers: ['t1_t2_disagreement'] });
  });
});

describe('T3 panel seats', () => {
  async function openCase() {
    const s = await seedDisagreement();
    const { caseId } = await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    return { ...s, caseId: caseId! };
  }

  it('seats two eligible adjudicators, one per seat, and refuses a third', async () => {
    const { caseId } = await openCase();
    const a = await seedAgent('adj-a', { tier: 'flagship', adjudicator: true });
    const b = await seedAgent('adj-b', { tier: 'flagship', adjudicator: true });
    const c = await seedAgent('adj-c', { tier: 'flagship', adjudicator: true });

    expect(await claimAdjudicationSeat({ caseId, agentId: a.agentId })).toEqual({
      ok: true,
      seat: 'a',
      alreadySeated: false,
    });
    expect(await claimAdjudicationSeat({ caseId, agentId: b.agentId })).toEqual({
      ok: true,
      seat: 'b',
      alreadySeated: false,
    });
    expect(await claimAdjudicationSeat({ caseId, agentId: c.agentId })).toEqual({
      ok: false,
      reason: 'panel_full',
    });
    // Re-claiming returns the seat already held; one identity never takes both.
    expect(await claimAdjudicationSeat({ caseId, agentId: a.agentId })).toEqual({
      ok: true,
      seat: 'a',
      alreadySeated: true,
    });
  });

  it('keeps one identity off both seats even if the claim path is bypassed', async () => {
    const { caseId } = await openCase();
    const a = await seedAgent('adj-a', { tier: 'flagship', adjudicator: true });
    await db.insert(adjudicationCaseSeats).values({ caseId, seat: 'a', agentId: a.agentId });
    await expect(
      db.insert(adjudicationCaseSeats).values({ caseId, seat: 'b', agentId: a.agentId }),
    ).rejects.toThrow();
  });

  it('refuses an agent without the grant, without the flagship tier, or suspended', async () => {
    const { caseId } = await openCase();
    for (const [slug, opts] of [
      ['flagship-no-grant', { tier: 'flagship', adjudicator: false }],
      ['grant-not-flagship', { tier: 'mid', adjudicator: true }],
      ['grant-unclassified', { tier: null, adjudicator: true }],
      ['suspended', { tier: 'flagship', adjudicator: true, status: 'suspended' }],
    ] as const) {
      const agent = await seedAgent(slug, opts);
      expect(await claimAdjudicationSeat({ caseId, agentId: agent.agentId })).toEqual({
        ok: false,
        reason: 'not_eligible',
      });
    }
  });

  it('refuses an adjudicator whose verdict the case rests on', async () => {
    const s = await openCase();
    await db
      .update(agents)
      .set({ adjudicator: true })
      .where(eq(agents.id, s.t2.agentId));
    expect(await claimAdjudicationSeat({ caseId: s.caseId, agentId: s.t2.agentId })).toEqual({
      ok: false,
      reason: 'conflicted',
    });
  });

  it('refuses a seat on a case that is no longer open', async () => {
    const { caseId } = await openCase();
    await db
      .update(adjudicationCases)
      .set({ state: 'invalidated' })
      .where(eq(adjudicationCases.id, caseId));
    const a = await seedAgent('adj-a', { tier: 'flagship', adjudicator: true });
    expect(await claimAdjudicationSeat({ caseId, agentId: a.agentId })).toEqual({
      ok: false,
      reason: 'case_not_open',
    });
  });
});

/** The trigger's refusal, which drizzle wraps as the cause of its own error. */
async function expectAppendOnlyRefusal(query: PromiseLike<unknown>) {
  const err = await Promise.resolve(query).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  const messages = [err, (err as { cause?: unknown })?.cause].map((e) =>
    e instanceof Error ? e.message : String(e),
  );
  expect(messages.join(' ')).toMatch(/append-only/);
}

describe('T3 opinions are append-only', () => {
  async function seatedCase() {
    const s = await seedDisagreement();
    const { caseId } = await detectAdjudicationCase({ targetType: 'pending_edit', targetId: s.editId });
    const a = await seedAgent('adj-a', { tier: 'flagship', adjudicator: true });
    await claimAdjudicationSeat({ caseId: caseId!, agentId: a.agentId });
    return caseId!;
  }
  const opinion = (caseId: number, revisionNo: number, extra = {}) => ({
    caseId,
    seat: 'a' as const,
    revisionNo,
    resolution: 'abstain' as const,
    proposition: 'Halveringstiden hos voksne.',
    reasoningMd: 'Full tekst mangler.',
    confidence: 'low',
    ...extra,
  });

  it('appends a superseding revision, and refuses every update and delete', async () => {
    const caseId = await seatedCase();
    const [first] = await db
      .insert(adjudicationOpinions)
      .values(opinion(caseId, 1))
      .returning({ id: adjudicationOpinions.id });
    const [second] = await db
      .insert(adjudicationOpinions)
      .values(opinion(caseId, 2, { supersedesOpinionId: first!.id }))
      .returning({ id: adjudicationOpinions.id });
    expect(second!.id).toBeGreaterThan(first!.id);

    await expectAppendOnlyRefusal(
      db
        .update(adjudicationOpinions)
        .set({ finalizedAt: new Date() })
        .where(eq(adjudicationOpinions.id, first!.id)),
    );
    await expectAppendOnlyRefusal(
      db.delete(adjudicationOpinions).where(eq(adjudicationOpinions.id, first!.id)),
    );
    // Two appends cannot share a revision number on one seat.
    await expect(db.insert(adjudicationOpinions).values(opinion(caseId, 2))).rejects.toThrow();
  });

  it('refuses an opinion from a seat nobody holds', async () => {
    const caseId = await seatedCase();
    await expect(
      db.insert(adjudicationOpinions).values({ ...opinion(caseId, 1), seat: 'b' }),
    ).rejects.toThrow();
  });

  it('accepts a scalar or a range with a unit, and refuses a mixed or unitless shape', async () => {
    const caseId = await seatedCase();
    const approve = { resolution: 'approve' as const, confidence: 'high' };
    await db
      .insert(adjudicationOpinions)
      .values(opinion(caseId, 1, { ...approve, resolvedValue: 1, resolvedUnit: 'L/min' }));
    await db.insert(adjudicationOpinions).values(
      opinion(caseId, 2, { ...approve, resolvedLow: 20, resolvedHigh: 100, resolvedUnit: 'h' }),
    );
    for (const [n, bad] of [
      [3, { resolvedValue: 1, resolvedLow: 1, resolvedHigh: 2, resolvedUnit: 'h' }],
      [4, { resolvedLow: 1, resolvedUnit: 'h' }],
      [5, { resolvedLow: 5, resolvedHigh: 1, resolvedUnit: 'h' }],
      [6, { resolvedValue: 1 }],
      [7, { resolvedUnit: 'h' }],
    ] as const) {
      await expect(
        db.insert(adjudicationOpinions).values(opinion(caseId, n, { ...approve, ...bad })),
      ).rejects.toThrow();
    }
    // A human-required opinion must say why.
    await expect(
      db.insert(adjudicationOpinions).values(opinion(caseId, 8, { humanRequired: true })),
    ).rejects.toThrow();
    const [{ n }] = (
      await db.execute(sql`select count(*)::int as n from adjudication_opinions`)
    ).rows as Array<{ n: number }>;
    expect(n).toBe(2);
  });
});
