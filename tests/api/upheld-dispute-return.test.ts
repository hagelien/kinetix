import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  fireAgentHookForSubmitterAsyncMock,
  isActiveAgentUserMock,
  isSelfReviewAgentUserMock,
  notifyEditDecisionMock,
} = vi.hoisted(() => ({
  notifyEditDecisionMock: vi.fn(),
  getDbMock: vi.fn(),
  fireAgentHookForSubmitterAsyncMock: vi.fn(),
  isActiveAgentUserMock: vi.fn(),
  isSelfReviewAgentUserMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/agentHooks.js', () => ({
  fireAgentHookForSubmitterAsync: fireAgentHookForSubmitterAsyncMock,
}));
vi.mock('../../api/_lib/editDecisionNotifications.js', () => ({
  notifyEditDecision: notifyEditDecisionMock,
}));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  isActiveAgentUser: isActiveAgentUserMock,
  isSelfReviewAgentUser: isSelfReviewAgentUserMock,
}));

import {
  composeUpheldReturnNote,
  returnPendingEditForUpheldDispute,
  UPHELD_RETURN_NOTE_MAX,
} from '../../api/_lib/upheld-dispute-return.ts';

/** The slice of drizzle the helper touches: one guarded read, one guarded update. */
function mockDb(opts: {
  edit?: Record<string, unknown>;
  updated?: Array<Record<string, unknown>>;
}) {
  const setSpy = vi.fn();
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(opts.edit ? [opts.edit] : []),
  };
  const whereSpy = vi.fn();
  const updateChain: Record<string, unknown> = {
    set: (values: Record<string, unknown>) => {
      setSpy(values);
      return updateChain;
    },
    where: (predicate: unknown) => {
      whereSpy(predicate);
      return updateChain;
    },
    returning: () => Promise.resolve(opts.updated ?? [{ id: 10 }]),
  };
  return {
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => updateChain),
    },
    setSpy,
    whereSpy,
  };
}

/** Every primitive a drizzle SQL/condition tree binds, cycles skipped. */
function collectLeaves(node: unknown, seen = new Set<unknown>()): unknown[] {
  if (node === null || node === undefined) return [];
  if (node instanceof Date) return [node];
  if (typeof node !== 'object') return [node];
  if (seen.has(node)) return [];
  seen.add(node);
  return Object.values(node as Record<string, unknown>).flatMap((v) =>
    collectLeaves(v, seen),
  );
}

const pendingEdit = {
  id: 10,
  status: 'pending',
  editType: 'parameter',
  targetId: 55,
  submittedBy: 7,
  parameter: 'halfLife',
  submittedAt: new Date('2026-09-21T10:00:00.000Z'),
};

function args(overrides: Record<string, unknown> = {}) {
  return {
    pendingEditId: 10,
    disputeId: 12,
    source: 'agent',
    reasonMd: 'The quoted sentence does not state the value at all.',
    evidenceRefs: [{ citationId: 3371 }],
    disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z'),
    resolvedBy: 1,
    mayDecide: true,
    mayDecideOwn: false,
    mayDecideModelStructure: true,
    ...overrides,
  };
}

describe('composeUpheldReturnNote', () => {
  it('marks the ruling and keeps the objection verbatim', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'agent',
      reasonMd: 'Sitatet oppgir ikke tallet.',
      evidenceRefs: [{ citationId: 3371 }],
    });

    expect(note).toContain('[dispute #12 (agent) upheld by a moderator');
    expect(note).toContain('Sitatet oppgir ikke tallet.');
    expect(note).toContain('#3371');
  });

  it('omits the evidence line when the dispute carried none', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'human',
      reasonMd: 'Feil populasjon.',
    });

    expect(note).not.toContain('Belegg:');
  });

  // A dispute may run to 5000 chars; a return note every other writer caps at
  // 2000. Trimming must not cost the marker or the sources — those are what
  // make the note actionable at all.
  it('stays inside the return-note cap, keeping marker and evidence', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'agent',
      reasonMd: 'x'.repeat(5000),
      evidenceRefs: [{ citationId: 3371 }, { url: 'https://example.org/p' }],
    });

    expect(note.length).toBeLessThanOrEqual(UPHELD_RETURN_NOTE_MAX);
    expect(note).toContain('[dispute #12 (agent) upheld by a moderator');
    expect(note).toContain('#3371');
    expect(note).toContain('https://example.org/p');
    expect(note).toContain('[…]');
  });
});

// Codex P1 (review comment 4064265351): the evidence line was appended whole
// after the body was trimmed, so evidence larger than the budget blew the cap
// the module exports — 20 refs of a 2000-char URL each are schema-legal.
describe('composeUpheldReturnNote evidence budget', () => {
  it('bounds the note when the evidence alone exceeds the cap', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'agent',
      reasonMd: 'Sitatet oppgir ikke tallet, og kilden er sekundær.',
      evidenceRefs: Array.from({ length: 20 }, () => ({
        url: `https://example.org/${'u'.repeat(1990)}`,
      })),
    });

    expect(note.length).toBeLessThanOrEqual(UPHELD_RETURN_NOTE_MAX);
    // The reasoning survives: a note that is all citations says nothing about
    // what to change.
    expect(note).toContain('Sitatet oppgir ikke tallet');
    expect(note).toContain('[dispute #12 (agent) upheld by a moderator');
  });

  it('keeps the cap when body and evidence are both oversized', () => {
    const note = composeUpheldReturnNote({
      disputeId: 7,
      source: 'human',
      reasonMd: 'y'.repeat(5000),
      evidenceRefs: Array.from({ length: 20 }, (_, i) => ({
        citationId: i + 1,
        url: `https://example.org/${'v'.repeat(1900)}`,
      })),
    });

    expect(note.length).toBeLessThanOrEqual(UPHELD_RETURN_NOTE_MAX);
    expect(note).toContain('yyy');
  });
});

describe('returnPendingEditForUpheldDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Nobody is an agent unless a case says so.
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
  });

  it('returns the edit with the objection as its note and wakes the author', async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(args());

    expect(outcome).toEqual({ returned: true });
    const values = setSpy.mock.calls[0][0];
    expect(values.status).toBe('returned');
    expect(values.rejectionReason).toBeNull();
    expect(values.rejectionComment).toContain('does not state the value');
    expect(values.reviewedBy).toBe(1);
    // No payload change, so nothing may touch the revision marker: the upheld
    // ruling has to keep standing until the author actually revises.
    expect(values.proposedMeta).toBeUndefined();
    expect(fireAgentHookForSubmitterAsyncMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ kind: 'edit_returned', pendingEditId: 10 }),
    );
    // A human submitter learns of it through their inbox (and email, if
    // they opted in); the helper itself skips agents.
    expect(notifyEditDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        edit: expect.objectContaining({ id: 10, submittedBy: 7 }),
        decision: 'returned',
        actorUserId: 1,
      }),
    );
  });

  it('leaves an already-decided proposal alone', async () => {
    const { db, setSpy } = mockDb({
      edit: { ...pendingEdit, status: 'approved' },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(args());

    expect(outcome).toEqual({ returned: false, reason: 'not_open' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(fireAgentHookForSubmitterAsyncMock).not.toHaveBeenCalled();
  });

  it('reports a proposal that no longer exists', async () => {
    const { db } = mockDb({});
    getDbMock.mockReturnValue(db);

    expect(await returnPendingEditForUpheldDispute(args())).toEqual({
      returned: false,
      reason: 'not_found',
    });
  });

  // The manual path refuses `return_self_not_allowed` without
  // review.edit.decideOwn; upholding a dispute must not be a side door around
  // it.
  it("refuses to return the moderator's own submission without decideOwn", async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ resolvedBy: 7 }),
    );

    expect(outcome).toEqual({
      returned: false,
      reason: 'own_edit_not_allowed',
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("returns a moderator's own submission when they may decide it", async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ resolvedBy: 7, mayDecideOwn: true }),
    );

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });

  // A concurrent decision — or a submitter revision — wins: the locked update
  // matches nothing, and the ruling is not written over whatever replaced it.
  it('yields to a decision or revision that raced the ruling', async () => {
    const { db } = mockDb({ edit: pendingEdit, updated: [] });
    getDbMock.mockReturnValue(db);

    expect(await returnPendingEditForUpheldDispute(args())).toEqual({
      returned: false,
      reason: 'revised_since',
    });
    expect(fireAgentHookForSubmitterAsyncMock).not.toHaveBeenCalled();
  });

  // Codex P1 (review comment 4064447896): the predicate pins the version the
  // ruling was read against, not just the status, so a submitter revision
  // landing in the read→write gap cannot be returned under the old objection.
  it('locks the update to the payload version it read', async () => {
    const { db, whereSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);

    await returnPendingEditForUpheldDispute(args());

    // The predicate is a drizzle SQL tree (self-referential through the table
    // objects), so walk it for the values it binds rather than serializing it.
    const bound = collectLeaves(whereSpy.mock.calls[0]?.[0]);
    expect(bound).toContain('pending');
    expect(bound.some((v) => v instanceof Date && v.getTime() === pendingEdit.submittedAt.getTime())).toBe(true);
    expect(bound.some((v) => typeof v === 'string' && v.includes('date_trunc'))).toBe(true);
  });
});

// Codex P1 (review comment 4064265324): the auto-return is a moderation act
// and has to carry the manual path's guards. `dispute.resolve` is a different
// capability with its own floor, and an agent can hold the editor role, so
// without these an uphold was a side door around
// `agent_moderation_of_human_edit_not_allowed` and the decide capability.
describe('returnPendingEditForUpheldDispute moderation guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
  });

  it('refuses without review.edit.decide, before touching the edit', async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ mayDecide: false }),
    );

    expect(outcome).toEqual({ returned: false, reason: 'decide_not_allowed' });
    expect(db.select).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("refuses an agent returning a human contributor's proposal", async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);
    // resolver (1) is an active agent; submitter (7) is a human.
    isActiveAgentUserMock.mockImplementation(async (userId: number) =>
      userId === 1,
    );

    const outcome = await returnPendingEditForUpheldDispute(args());

    expect(outcome).toEqual({
      returned: false,
      reason: 'agent_moderation_not_allowed',
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(fireAgentHookForSubmitterAsyncMock).not.toHaveBeenCalled();
  });

  // Agent-on-agent moderation is the peer pipeline working as designed.
  it("allows an agent returning another agent's proposal", async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockResolvedValue(true);

    const outcome = await returnPendingEditForUpheldDispute(args());

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });

  // A human moderator is unaffected by the agent guard.
  it('allows a human moderator returning an agent submission', async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockImplementation(async (userId: number) =>
      userId === 7,
    );

    const outcome = await returnPendingEditForUpheldDispute(args());

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });
});

// Codex P1 (review comment 4064447884): a cited categorical axis whose
// approval changes the model family is admin-tier to decide, and the manual
// path refuses every review action on one without that capability.
describe('returnPendingEditForUpheldDispute model-structure guard', () => {
  const modelStructureEdit = {
    ...pendingEdit,
    editType: 'param_entry',
    parameter: 'absorptionModel',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
  });

  it('refuses a model-structure edit without edit.modelStructure.decide', async () => {
    const { db, setSpy } = mockDb({ edit: modelStructureEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ mayDecideModelStructure: false }),
    );

    expect(outcome).toEqual({
      returned: false,
      reason: 'model_structure_not_allowed',
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('returns a model-structure edit when the caller may decide one', async () => {
    const { db, setSpy } = mockDb({ edit: modelStructureEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(args());

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });

  // An ordinary parameter edit is untouched by the model-structure tier, even
  // when the caller lacks it — that capability gates the enum axes only.
  it('leaves an ordinary parameter edit outside the model-structure gate', async () => {
    const { db, setSpy } = mockDb({
      edit: { ...pendingEdit, editType: 'param_entry', parameter: 'halfLife' },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ mayDecideModelStructure: false }),
    );

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });
});

// Codex P1 (review comment 4064590498): `review.edit.decideOwn` is the HUMAN
// grant — the manual path excludes active agents from it precisely so that
// lowering it to its editor floor does not hand every agent the licence
// `agents.self_review_enabled` hands out one at a time.
describe('returnPendingEditForUpheldDispute self-return parity', () => {
  const ownEdit = { ...pendingEdit, submittedBy: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
  });

  it('refuses an agent self-return on the capability alone', async () => {
    const { db, setSpy } = mockDb({ edit: ownEdit });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockResolvedValue(true);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ resolvedBy: 1, mayDecideOwn: true }),
    );

    expect(outcome).toEqual({
      returned: false,
      reason: 'own_edit_not_allowed',
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('allows an agent self-return on its own self-review grant', async () => {
    const { db, setSpy } = mockDb({ edit: ownEdit });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ resolvedBy: 1, mayDecideOwn: false }),
    );

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });

  // The two carve-outs that ask for a second party whatever the grant says.
  it('refuses a self-review agent on a clinical case', async () => {
    const { db } = mockDb({
      edit: { ...ownEdit, editType: 'clinical_case' },
    });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);

    expect(
      await returnPendingEditForUpheldDispute(
        args({ resolvedBy: 1, mayDecideOwn: false }),
      ),
    ).toEqual({ returned: false, reason: 'own_edit_not_allowed' });
  });

  it('refuses a self-review agent on a model-structure axis', async () => {
    const { db } = mockDb({
      edit: {
        ...ownEdit,
        editType: 'param_entry',
        parameter: 'absorptionModel',
      },
    });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);

    expect(
      await returnPendingEditForUpheldDispute(
        args({ resolvedBy: 1, mayDecideOwn: false }),
      ),
    ).toEqual({ returned: false, reason: 'own_edit_not_allowed' });
  });

  // A human moderator with the grant is unaffected.
  it('allows a human self-return on the capability', async () => {
    const { db, setSpy } = mockDb({ edit: ownEdit });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ resolvedBy: 1, mayDecideOwn: true }),
    );

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });
});

// Codex P1 (review comment 4064590508): no version token reaches this call —
// a dispute is resolved by id, from the queue as readily as from the card — so
// the row lock alone cannot establish that the payload is the one the
// objection was written about. The timestamps can.
describe('returnPendingEditForUpheldDispute staleness against the objection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
  });

  it('refuses to return a payload revised after the objection was raised', async () => {
    const { db, setSpy } = mockDb({
      edit: {
        ...pendingEdit,
        proposedMeta: { revisedAt: '2026-09-21T12:00:00.000Z' },
      },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z') }),
    );

    expect(outcome).toEqual({ returned: false, reason: 'revised_since' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(fireAgentHookForSubmitterAsyncMock).not.toHaveBeenCalled();
  });

  it('returns a payload last revised before the objection', async () => {
    const { db, setSpy } = mockDb({
      edit: {
        ...pendingEdit,
        proposedMeta: { revisedAt: '2026-09-21T10:30:00.000Z' },
      },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({ disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z') }),
    );

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });

  // No marker means no revision is on record — the ordinary case.
  it('returns an unrevised payload', async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);

    expect(await returnPendingEditForUpheldDispute(args())).toEqual({
      returned: true,
    });
    expect(setSpy).toHaveBeenCalled();
  });
});

// #1327: `createdAt` never moves when the dispute's own author re-disputes
// the same target (only `reasonMd`/`evidenceRefs`/`targetVersion` refresh),
// so a dispute opened before a revision and then explicitly re-stated
// against that later revision still carried its original `createdAt` — and
// the old raw-timestamp check refused the auto-return even though the
// refreshed dispute's `targetVersion` proves the objection was re-confirmed
// against current content.
describe('returnPendingEditForUpheldDispute staleness anchored to targetVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
  });

  it('returns a payload revised before the refreshed targetVersion, despite a stale createdAt', async () => {
    const { db, setSpy } = mockDb({
      edit: {
        ...pendingEdit,
        proposedMeta: { revisedAt: '2026-09-21T12:00:00.000Z' },
      },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({
        // The dispute was first opened before the revision...
        disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z'),
        // ...but its author re-disputed after it, moving targetVersion past
        // the revision. The `submittedAt` half is what anchors the check.
        targetVersion: '2026-09-21T12:30:00.000Z|pending',
      }),
    );

    expect(outcome).toEqual({ returned: true });
    expect(setSpy).toHaveBeenCalled();
  });

  it('still refuses when the refreshed targetVersion predates the revision', async () => {
    const { db, setSpy } = mockDb({
      edit: {
        ...pendingEdit,
        proposedMeta: { revisedAt: '2026-09-21T12:00:00.000Z' },
      },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({
        disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z'),
        targetVersion: '2026-09-21T11:30:00.000Z|pending',
      }),
    );

    expect(outcome).toEqual({ returned: false, reason: 'revised_since' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('falls back to disputeRaisedAt when targetVersion is null (row predates the column)', async () => {
    const { db, setSpy } = mockDb({
      edit: {
        ...pendingEdit,
        proposedMeta: { revisedAt: '2026-09-21T12:00:00.000Z' },
      },
    });
    getDbMock.mockReturnValue(db);

    const outcome = await returnPendingEditForUpheldDispute(
      args({
        disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z'),
        targetVersion: null,
      }),
    );

    expect(outcome).toEqual({ returned: false, reason: 'revised_since' });
    expect(setSpy).not.toHaveBeenCalled();
  });
});

// Codex P1 (review comment 4064590513): `evidenceRefSchema` accepts a ref with
// only a quote, and the dispute panel shows it; dropping it from the note left
// the author nothing to reconcile against, since the resolved row is not
// readable through the open feed (#1318).
describe('composeUpheldReturnNote quote-only evidence', () => {
  it('renders a quote when the ref carries no identifier', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'human',
      reasonMd: 'Sitatet oppgir ikke tallet.',
      evidenceRefs: [{ quote: 'The observed value of logP is provided by PubChem.' }],
    });

    expect(note).toContain(
      '«The observed value of logP is provided by PubChem.»',
    );
  });

  it('bounds a very long quote', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'human',
      reasonMd: 'Sitatet oppgir ikke tallet.',
      evidenceRefs: [{ quote: 'q'.repeat(900) }],
    });

    expect(note.length).toBeLessThanOrEqual(UPHELD_RETURN_NOTE_MAX);
    expect(note).toContain('…»');
  });

  // An identifier still wins: it is what the author can look up.
  it('prefers the citation id over the quote', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'agent',
      reasonMd: 'Sitatet oppgir ikke tallet.',
      evidenceRefs: [{ citationId: 3371, quote: 'irrelevant here' }],
    });

    expect(note).toContain('#3371');
    expect(note).not.toContain('irrelevant here');
  });
});

// Codex P1 (review comment 4064721848): nothing can establish which version
// an objection's prose was written about — a reviewer can read one version and
// post about it after the submitter replaced it. Dating the marker is what
// lets the author check the objection against their own revision history
// instead of assuming it describes what they have now (#1321).
describe('composeUpheldReturnNote dates the objection', () => {
  it('carries the raised-at stamp in the marker', () => {
    const note = composeUpheldReturnNote({
      disputeId: 12,
      source: 'human',
      reasonMd: 'Sitatet oppgir ikke tallet.',
      raisedAt: new Date('2026-09-21T11:00:00.000Z'),
    });

    expect(note).toContain('raised 2026-09-21T11:00Z');
  });

  it('omits the stamp when the timestamp is missing or unusable', () => {
    for (const raisedAt of [null, undefined, new Date('nope')]) {
      const note = composeUpheldReturnNote({
        disputeId: 12,
        source: 'human',
        reasonMd: 'Sitatet oppgir ikke tallet.',
        raisedAt,
      });
      expect(note).toContain('[dispute #12 (human) upheld by a moderator');
      expect(note).not.toContain('raised');
    }
  });

  it('passes the dispute timestamp through to the stored note', async () => {
    const { db, setSpy } = mockDb({ edit: pendingEdit });
    getDbMock.mockReturnValue(db);
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);

    await returnPendingEditForUpheldDispute(
      args({ disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z') }),
    );

    expect(setSpy.mock.calls[0][0].rejectionComment).toContain(
      'raised 2026-09-21T11:00Z',
    );
  });
});
