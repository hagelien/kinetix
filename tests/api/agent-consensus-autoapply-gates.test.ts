import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two things agent consensus must never publish on its own, however clean
// the tally: a clinical_case (safety-critical, spec §12 Stage 12 — a human
// expert moderator always signs it off) and anything a human submitted (agents
// verify human proposals, but approving one is a moderator's call). A
// learning_unit from an agent in the same state still auto-applies. We drive
// applyOnAgentConsensus directly with its DB/consensus dependencies mocked.

const {
  getDbMock,
  applyApprovedEditMock,
  summariseMock,
  countActiveMock,
  hasOpenDisputeMock,
  isActiveAgentUserMock,
  isSelfReviewAgentUserMock,
  quoteAfterUpdateMock,
  returnUnquotedAgentEditMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  applyApprovedEditMock: vi.fn().mockResolvedValue(undefined),
  summariseMock: vi.fn(),
  countActiveMock: vi.fn(),
  hasOpenDisputeMock: vi.fn().mockResolvedValue(false),
  isActiveAgentUserMock: vi.fn(),
  isSelfReviewAgentUserMock: vi.fn(),
  quoteAfterUpdateMock: vi.fn().mockResolvedValue(null),
  returnUnquotedAgentEditMock: vi.fn().mockResolvedValue({ returned: true }),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: vi.fn() }));
vi.mock('../../api/_lib/notifications.js', () => ({
  fanOutDisputeNotification: vi.fn(),
}));
vi.mock('../../api/_lib/unquoted-edit-return.js', () => ({
  returnUnquotedAgentEdit: returnUnquotedAgentEditMock,
}));
vi.mock('../../api/_lib/disputes.js', () => ({
  hasOpenDispute: hasOpenDisputeMock,
  unresolvedDisputeVerdictCount: vi.fn(async () => 0),
  pendingEditUpheldRulingStands: vi.fn(async () => false),
  upsertOpenDispute: vi.fn(),
  withdrawOpenDispute: vi.fn(),
  withdrawAgentDisputesForTarget: vi.fn(),
}));
vi.mock('../../api/_lib/drugs-helpers.js', () => ({
  ParameterApplyError: class ParameterApplyError extends Error {},
}));
vi.mock('../../api/_lib/pending-edits-helpers.js', () => ({
  applyApprovedEdit: applyApprovedEditMock,
  PendingEditReviewTokenMismatchError: class PendingEditReviewTokenMismatchError extends Error {},
  WikiFactApprovalError: class WikiFactApprovalError extends Error {},
}));
vi.mock('../../api/_lib/parameter-entries-store.js', () => ({
  quoteAfterUpdate: quoteAfterUpdateMock,
}));
vi.mock('../../api/_lib/agent-verifications.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../api/_lib/agent-verifications.js')>();
  return {
    ...actual,
    // Three active agents → quorum 2 (the design target, not degraded).
    countActiveVerifierAgents: countActiveMock,
    summariseVerificationsForTargets: summariseMock,
    isActiveAgentUser: isActiveAgentUserMock,
    isSelfReviewAgentUser: isSelfReviewAgentUserMock,
    // Page visibility has its own integration test; these fixtures target published pages.
    pendingEditTargetOpenToAgents: vi.fn(async () => true),
  };
});

import { applyOnAgentConsensus } from '../../api/agent-verifications.ts';
import { PendingEditReviewTokenMismatchError } from '../../api/_lib/pending-edits-helpers.js';

// A `param_entry` create payload carrying a verbatim source quote. Every
// high-risk fixture needs one now: a calculation-driving parameter does not
// auto-publish on consensus without the sentence its value was read off, so a
// fixture without one would be held by the quote guard before the tier gate it
// is trying to exercise ever runs.
function quotedEntryPayload(quote = 'Median Tmax was 2 hours (fasted, 40 mg).') {
  return { op: 'create', input: { quote } };
}

// getDb().select({...}).from().where().limit() -> [{ editType, submittedBy,
// parameter, proposedValue, proposedMeta }]
function dbReturningEdit(
  editType: string,
  submittedBy = AGENT_USER_ID,
  parameter: string | null = null,
  payload: { proposedValue?: unknown; proposedMeta?: unknown } = {},
) {
  const row = {
    editType,
    submittedBy,
    parameter,
    targetId: 99,
    proposedValue: payload.proposedValue ?? null,
    proposedMeta: payload.proposedMeta ?? null,
  };
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => [row] }) }),
    }),
  };
}

const AGENT_USER_ID = 8;
const HUMAN_USER_ID = 2;

describe('applyOnAgentConsensus — human-only gates', () => {
  beforeEach(() => {
    applyApprovedEditMock.mockClear();
    countActiveMock.mockReset().mockResolvedValue(3);
    hasOpenDisputeMock.mockReset().mockResolvedValue(false);
    summariseMock.mockReset().mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0 }]]),
    );
    isActiveAgentUserMock
      .mockReset()
      .mockImplementation(async (userId: number) => userId === AGENT_USER_ID);
    isSelfReviewAgentUserMock.mockReset().mockResolvedValue(false);
  });

  it('auto-applies a learning_unit at quorum with no dispute', async () => {
    getDbMock.mockReturnValue(dbReturningEdit('learning_unit'));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  // The author of a proposal can PATCH it, and an agent with self-review
  // enabled needs only one other approval — so the payload can move between the
  // moment this gate reads it and the moment the apply writes it. No lock helps:
  // the race is between the decision and the write. The apply is therefore bound
  // to the version that was decided about, and a mismatch is reported as "not
  // applied" rather than published.
  it('does NOT publish when the proposal changed after the decision', async () => {
    getDbMock.mockReturnValue(dbReturningEdit('learning_unit'));
    applyApprovedEditMock.mockRejectedValueOnce(
      new PendingEditReviewTokenMismatchError(),
    );

    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });

    expect(applied).toBe(false);
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  it('does NOT auto-apply a clinical_case even at quorum with no dispute', async () => {
    getDbMock.mockReturnValue(dbReturningEdit('clinical_case'));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  // A human contributor's proposal is peer-verified like any other (it is in
  // the agents' queue), but agent consensus must never publish it: that call
  // belongs to a human moderator. Regression guard for the read/apply
  // asymmetry introduced when the queue stopped filtering by submitter.
  it('does NOT auto-apply a human-submitted edit at quorum with no dispute', async () => {
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', HUMAN_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  it('auto-applies the same edit type when an agent submitted it', async () => {
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  // agents.self_review_enabled makes the author an eligible verifier, so it
  // ENLARGES the pool rather than lowering the bar. With two active agents the
  // quorum therefore rises from 1 (author excluded, one verifier left) to the
  // design target of 2 — the same tally that would have auto-applied without
  // the flag now waits for a second approval.
  it('raises the quorum for a self-review author instead of lowering it', async () => {
    countActiveMock.mockResolvedValue(2);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 1, disputeCount: 0 }]]),
    );
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: AGENT_USER_ID,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  // The one deployment the flag exists for: a single active agent, whose own
  // reasoned verdict is the only review available. Quorum 1, and it applies.
  it('lets a lone self-review agent carry its own edit', async () => {
    countActiveMock.mockResolvedValue(1);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 1, disputeCount: 0 }]]),
    );
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: AGENT_USER_ID,
    });
    expect(applied).toBe(true);
    expect(applyApprovedEditMock).toHaveBeenCalledWith(
      1,
      AGENT_USER_ID,
      expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  // A dispute still blocks, self-review or not — including the author's own
  // second thoughts, which upsert over its earlier verdict.
  it('still blocks on a dispute against a self-review author', async () => {
    countActiveMock.mockResolvedValue(1);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 1, disputeCount: 1 }]]),
    );
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: AGENT_USER_ID,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  // Revoking the grant must never be what causes a publish. The apply path
  // re-reads the flag by default, so an admin turning self-review off between
  // the verdict landing and the tally running would shrink the quorum from 2
  // to 1 and let the author's just-recorded approval carry the edit — the
  // exact inversion of what revoking it means. The caller passes the grant its
  // request was admitted under instead.
  it('sizes the quorum by the caller’s snapshot, not a later re-read', async () => {
    countActiveMock.mockResolvedValue(2);
    // The row now says false — an admin revoked it a moment ago.
    isSelfReviewAgentUserMock.mockResolvedValue(false);
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 1, disputeCount: 0 }]]),
    );
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));

    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: AGENT_USER_ID,
      authorSelfReviews: true,
    });

    // Snapshot true → pool of 2 → quorum 2 → one approval is not enough.
    // Had the re-read won, quorum would be 1 and this would have published.
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(isSelfReviewAgentUserMock).not.toHaveBeenCalled();
  });

  it('falls back to the row when no snapshot is supplied', async () => {
    countActiveMock.mockResolvedValue(1);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 1, disputeCount: 0 }]]),
    );
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));

    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: AGENT_USER_ID,
    });

    expect(applied).toBe(true);
    expect(isSelfReviewAgentUserMock).toHaveBeenCalled();
  });

  // The flag is about the agent's OWN work. A human's edit is never published
  // by consensus, whatever the author flag or the tally says.
  it('never auto-applies a human edit even with self-review on', async () => {
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', HUMAN_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });
});

// Capability-aware consensus. A high-risk edit — one that writes a
// calculation-driving (entry-backed) drug parameter — must not auto-publish on
// the agreement of two mid-tier agents that may share a blind spot: it needs at
// least one flagship-tier approval and never rides the degraded single-approve
// path. Non-high-risk edits (metadata/authored params, wiki facts) are
// unaffected. `approveTier2Count` is the count of explicit approvals from a
// flagship-tier verifier; omitting it in a mocked summary is treated as 0.
describe('applyOnAgentConsensus — capability-aware high-risk gate', () => {
  beforeEach(() => {
    applyApprovedEditMock.mockClear();
    countActiveMock.mockReset().mockResolvedValue(3); // quorum 2 (not degraded)
    hasOpenDisputeMock.mockReset().mockResolvedValue(false);
    isActiveAgentUserMock
      .mockReset()
      .mockImplementation(async (userId: number) => userId === AGENT_USER_ID);
    isSelfReviewAgentUserMock.mockReset().mockResolvedValue(false);
  });

  it('HOLDS a calc-driving parameter approved only by mid-tier agents', async () => {
    // Two approvals, none from a flagship model → held for a human.
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0, approveTier2Count: 0 }]]),
    );
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife'),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  it('APPLIES a calc-driving parameter once one flagship approval is present', async () => {
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0, approveTier2Count: 1 }]]),
    );
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: quotedEntryPayload(),
      }),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  it('HOLDS a calc-driving parameter on the degraded single-approve path', async () => {
    // Lone self-review agent: base quorum relaxes to 1, but a high-risk edit
    // never auto-applies below the design-target quorum of 2 — even with a
    // flagship approval — so it waits for a human.
    countActiveMock.mockResolvedValue(1);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 1, disputeCount: 0, approveTier2Count: 1 }]]),
    );
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'volumeOfDistribution'),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: AGENT_USER_ID,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  it('does NOT gate a non-calc-driving (authored) parameter edit', async () => {
    // analyteStability is authored, not entry-backed → not high-risk → the
    // ordinary two-approval consensus still publishes it.
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0, approveTier2Count: 0 }]]),
    );
    getDbMock.mockReturnValue(
      dbReturningEdit('parameter', AGENT_USER_ID, 'analyteStability'),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  it('does NOT gate a wiki_fact edit (no parameter)', async () => {
    summariseMock.mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0, approveTier2Count: 0 }]]),
    );
    getDbMock.mockReturnValue(dbReturningEdit('wiki_fact', AGENT_USER_ID));
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });
});

// Evidence completeness. A calculation-driving parameter does not publish
// unattended unless the proposal records the verbatim sentence its value was
// read off. This is the guard for the failure the tier gate above cannot see:
// a proposal citing the correct document, approved by reviewers who did not
// re-derive the number, carrying a value read out of the wrong sentence.
describe('applyOnAgentConsensus — source-quote gate', () => {
  beforeEach(() => {
    applyApprovedEditMock.mockClear();
    countActiveMock.mockReset().mockResolvedValue(3); // quorum 2 (not degraded)
    hasOpenDisputeMock.mockReset().mockResolvedValue(false);
    isActiveAgentUserMock
      .mockReset()
      .mockImplementation(async (userId: number) => userId === AGENT_USER_ID);
    isSelfReviewAgentUserMock.mockReset().mockResolvedValue(false);
    // A clean, fully-qualified tally throughout: quorum met, no dispute, a
    // flagship approval present. The quote is then the only variable, so every
    // hold below is attributable to it and to nothing else.
    summariseMock.mockReset().mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0, approveTier2Count: 1 }]]),
    );
  });

  it('HOLDS an entry create with no quote, on an otherwise perfect tally', async () => {
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'tmax', {
        proposedValue: { op: 'create', input: { median: 1, unit: 'h' } },
      }),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(false);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    // Back to the agent that wrote it, to add the quote.
    expect(returnUnquotedAgentEditMock).toHaveBeenCalledWith(
      expect.objectContaining({ pendingEditId: 1 }),
    );
  });

  it('APPLIES the same edit once the quote is present', async () => {
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'tmax', {
        proposedValue: {
          op: 'create',
          input: { median: 2, unit: 'h', quote: 'Median Tmax was 2 hours.' },
        },
      }),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  it('HOLDS an entry update with no quote', async () => {
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'tmax', {
        proposedValue: { op: 'update', patch: { median: 1, unit: 'h' } },
      }),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(false);
  });

  // An empty quote is the absence of a quote wearing a coat. A client that
  // serializes a blank form field, or a routine that fills the key to satisfy
  // a schema, must not clear a gate whose entire purpose is to make somebody
  // write a sentence down.
  it('treats a blank or whitespace-only quote as no quote', async () => {
    for (const quote of ['', '   ', '\n\t ']) {
      applyApprovedEditMock.mockClear();
      getDbMock.mockReturnValue(
        dbReturningEdit('param_entry', AGENT_USER_ID, 'tmax', {
          proposedValue: { op: 'create', input: { median: 1, quote } },
        }),
      );
      const applied = await applyOnAgentConsensus({
        pendingEditId: 1,
        approverUserId: 7,
      });
      expect(applied).toBe(false);
      expect(applyApprovedEditMock).not.toHaveBeenCalled();
    }
  });

  // A delete proposes REMOVING a row. The case for removal is an argument —
  // wrong drug, superseded, duplicate — not a sentence in a document, so
  // demanding a quote would be demanding evidence of an absence.
  it('does NOT gate an entry delete, which asserts no value', async () => {
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'tmax', {
        proposedValue: { op: 'delete' },
      }),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    // The third argument binds the apply to the proposal version this gate
    // decided about, so an author who edits their own payload after the tally
    // cannot have the new content published on the old verdicts.
    expect(applyApprovedEditMock).toHaveBeenCalledWith(1, 7, expect.any(String),
      expect.objectContaining({ revalidate: expect.any(Function) }),
    );
  });

  // A direct drug-parameter write has nowhere on its value to carry a quote,
  // so it travels in proposed_meta. Same gate, different pocket.
  it('reads a direct parameter edit’s quote from proposed_meta', async () => {
    getDbMock.mockReturnValue(
      dbReturningEdit('parameter', AGENT_USER_ID, 'halfLife', {
        proposedValue: { low: 7, high: 9 },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(false);

    applyApprovedEditMock.mockClear();
    getDbMock.mockReturnValue(
      dbReturningEdit('parameter', AGENT_USER_ID, 'halfLife', {
        proposedValue: { low: 7, high: 9 },
        proposedMeta: { sourceQuote: 'Terminal half-life ranged from 7 to 9 h.' },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(true);
  });

  // The guard is scoped to calculation-driving values. Identity metadata and
  // authored parameters were never high-risk and must not start needing a
  // quote — widening it would strand ordinary maintenance in the human queue
  // for no safety gain.
  it('does NOT gate a non-calc-driving parameter or a wiki_fact', async () => {
    for (const row of [
      dbReturningEdit('parameter', AGENT_USER_ID, 'analyteStability'),
      dbReturningEdit('wiki_fact', AGENT_USER_ID),
    ]) {
      applyApprovedEditMock.mockClear();
      getDbMock.mockReturnValue(row);
      const applied = await applyOnAgentConsensus({
        pendingEditId: 1,
        approverUserId: 7,
      });
      expect(applied).toBe(true);
    }
  });
});

// The mirror of the gate's purpose: it must not block work that IS quoted.
// The editor omits an untouched quote on purpose and the update preserves the
// stored one when the reading is unchanged, so reading the payload alone would
// classify such a proposal as unquoted and hold it forever — a contributor
// fixing a typo in the comments of a well-quoted entry could never publish it.
describe('applyOnAgentConsensus — an entry update inherits its stored quote', () => {
  beforeEach(() => {
    applyApprovedEditMock.mockClear();
    countActiveMock.mockReset().mockResolvedValue(3);
    hasOpenDisputeMock.mockReset().mockResolvedValue(false);
    isActiveAgentUserMock
      .mockReset()
      .mockImplementation(async (userId: number) => userId === AGENT_USER_ID);
    isSelfReviewAgentUserMock.mockReset().mockResolvedValue(false);
    summariseMock.mockReset().mockReturnValue(
      new Map([[1, { approveCount: 2, disputeCount: 0, approveTier2Count: 1 }]]),
    );
    quoteAfterUpdateMock.mockReset().mockResolvedValue(null);
  });

  it('APPLIES an update whose payload omits a quote the entry still carries', async () => {
    // The store says the stored sentence survives this patch.
    quoteAfterUpdateMock.mockResolvedValue('Half-life was 9 h.');
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: { op: 'update', patch: { comments: 'Typo fixed.' } },
      }),
    );
    const applied = await applyOnAgentConsensus({
      pendingEditId: 1,
      approverUserId: 7,
    });
    expect(applied).toBe(true);
    expect(quoteAfterUpdateMock).toHaveBeenCalledWith(99, {
      comments: 'Typo fixed.',
    });
  });

  it('HOLDS the same update when the write would clear the quote', async () => {
    // The reading moved, so the store reports no surviving quote.
    quoteAfterUpdateMock.mockResolvedValue(null);
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: { op: 'update', patch: { median: 11 } },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(false);
  });

  // The same question in the other direction, and the more dangerous one.
  //
  // The editor re-sends the sentence already on the entry when the curator did
  // not touch it, so a STATED quote is very often an echo. The write recognises
  // an echo as "unchanged" and puts it back through the preserve-or-clear rule,
  // which clears it once the reading has moved. A gate that read the payload
  // and saw a non-empty string would call that proposal quoted, auto-publish
  // it, and leave a calculation-driving value on the record with no provenance
  // at all — the #1201 failure, reached through the gate meant to prevent it.
  it('HOLDS an update that STATES a quote the write would clear as an echo', async () => {
    quoteAfterUpdateMock.mockResolvedValue(null);
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: {
          op: 'update',
          patch: { median: 11, quote: 'Half-life was 9 h.' },
        },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(false);
    // The store was asked despite the payload carrying a quote: that IS the fix.
    expect(quoteAfterUpdateMock).toHaveBeenCalledWith(99, {
      median: 11,
      quote: 'Half-life was 9 h.',
    });
  });

  // …and it must still apply when the stated quote genuinely survives, or the
  // fix would simply have closed the path for everyone.
  it('APPLIES an update whose stated quote the write keeps', async () => {
    quoteAfterUpdateMock.mockResolvedValue('Half-life was 11 h.');
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: {
          op: 'update',
          patch: { median: 11, quote: 'Half-life was 11 h.' },
        },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(true);
  });

  // A fault resolving the effective quote is not an approval. We do not know
  // what the write would leave behind, and "we do not know" must never
  // authorize an unattended publication.
  it('HOLDS when the store cannot answer', async () => {
    quoteAfterUpdateMock.mockRejectedValue(new Error('connection lost'));
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: {
          op: 'update',
          patch: { median: 11, quote: 'Half-life was 11 h.' },
        },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(false);
  });

  // A create has no stored row to inherit from, so the payload verdict stands.
  it('does NOT consult the store for a create', async () => {
    getDbMock.mockReturnValue(
      dbReturningEdit('param_entry', AGENT_USER_ID, 'halfLife', {
        proposedValue: { op: 'create', input: { median: 9 } },
      }),
    );
    expect(
      await applyOnAgentConsensus({ pendingEditId: 1, approverUserId: 7 }),
    ).toBe(false);
    expect(quoteAfterUpdateMock).not.toHaveBeenCalled();
  });
});
