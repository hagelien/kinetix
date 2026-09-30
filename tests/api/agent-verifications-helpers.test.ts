import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import {
  AGENT_CONSENSUS_APPROVE_QUORUM,
  clearVerificationsForTarget,
  consensusApprovalHoldReason,
  countActiveVerifierAgents,
  disputedTargetIdsForType,
  effectiveConsensusQuorum,
  emptyVerificationSummary,
  filterVerificationsForAudience,
  isConsensusQuorumDegraded,
  isHighRiskPendingEdit,
  isSelfReviewAgentUser,
  meetsConsensusApprovalQuorum,
  resolveActiveAgent,
  summariseVerificationsForTargets,
  verifiedByAgentIds,
  verificationTargetVersion,
  visibleVerificationTargetIds,
  type VerificationRow,
  type VerificationSummary,
} from '../../api/_lib/agent-verifications';
import { getDb } from '../../api/_lib/db.js';

interface SummaryRow {
  targetId: number;
  verdict: 'approve' | 'dispute' | 'abstain';
  isImplicit: boolean;
  // Server-owned tier snapshotted onto the verdict at record time (not the
  // self-reported model, and not the mutable current agent row).
  verifierTier?: string | null;
}

function mockSelectQueue(rows: unknown[]): void {
  const builder: Record<string, unknown> = {};
  const chain = (): typeof builder => builder;
  Object.assign(builder, {
    from: vi.fn(chain),
    leftJoin: vi.fn(chain),
    innerJoin: vi.fn(chain),
    where: vi.fn(async () => rows),
    orderBy: vi.fn(async () => rows),
  });
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => builder),
  } as unknown as ReturnType<typeof getDb>);
}

/**
 * Like `mockSelectQueue`, but answers successive `.where()` calls with
 * successive row sets (in call order) rather than the same one every time —
 * for a path that issues more than one `select`/`selectDistinct` query, such
 * as `includeCallerVerdicts`'s follow-up lookup in `agentVerifications`.
 */
function mockSelectSequence(rowSets: unknown[][]): void {
  let call = 0;
  const builder: Record<string, unknown> = {};
  const chain = (): typeof builder => builder;
  Object.assign(builder, {
    from: vi.fn(chain),
    leftJoin: vi.fn(chain),
    innerJoin: vi.fn(chain),
    where: vi.fn(async () => rowSets[call++] ?? []),
  });
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => builder),
    selectDistinct: vi.fn(() => builder),
  } as unknown as ReturnType<typeof getDb>);
}

describe('summariseVerificationsForTargets', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns an empty map when no targetIds are supplied', async () => {
    const map = await summariseVerificationsForTargets({
      targetType: 'pending_edit',
      targetIds: [],
    });
    expect(map.size).toBe(0);
  });

  it('tallies explicit + implicit counts per target', async () => {
    const rows: SummaryRow[] = [
      { targetId: 5, verdict: 'approve', isImplicit: false },
      { targetId: 5, verdict: 'approve', isImplicit: false },
      { targetId: 5, verdict: 'approve', isImplicit: true },
      { targetId: 7, verdict: 'dispute', isImplicit: false },
      { targetId: 7, verdict: 'abstain', isImplicit: false },
    ];
    mockSelectQueue(rows);
    const map = await summariseVerificationsForTargets({
      targetType: 'pending_edit',
      targetIds: [5, 7, 9],
    });

    expect(map.get(5)).toEqual({
      approveCount: 2,
      disputeCount: 0,
      abstainCount: 0,
      implicitApproveCount: 1,
      approveTier2Count: 0,
    });
    expect(map.get(7)).toEqual({
      approveCount: 0,
      disputeCount: 1,
      abstainCount: 1,
      implicitApproveCount: 0,
      approveTier2Count: 0,
    });
    expect(map.has(9)).toBe(false);
  });

  it('counts only snapshotted flagship approvals in approveTier2Count', async () => {
    // Tier is the snapshot on the verdict, so a caller-supplied model string
    // cannot inflate it and a later agent reassignment cannot reclassify it —
    // an unclassified (null) snapshot never counts.
    const rows: SummaryRow[] = [
      { targetId: 5, verdict: 'approve', isImplicit: false, verifierTier: 'flagship' },
      { targetId: 5, verdict: 'approve', isImplicit: false, verifierTier: 'mid' },
      { targetId: 5, verdict: 'approve', isImplicit: false, verifierTier: null },
      // An implicit flagship row is the submitter's own stake — never counted.
      { targetId: 5, verdict: 'approve', isImplicit: true, verifierTier: 'flagship' },
      { targetId: 6, verdict: 'approve', isImplicit: false, verifierTier: 'flagship' },
      { targetId: 6, verdict: 'approve', isImplicit: false, verifierTier: 'mid' },
    ];
    mockSelectQueue(rows);
    const map = await summariseVerificationsForTargets({
      targetType: 'pending_edit',
      targetIds: [5, 6],
    });
    expect(map.get(5)?.approveCount).toBe(3);
    expect(map.get(5)?.approveTier2Count).toBe(1); // only the flagship one
    expect(map.get(6)?.approveCount).toBe(2);
    expect(map.get(6)?.approveTier2Count).toBe(1); // flagship yes, mid no
  });
});

describe('isHighRiskPendingEdit', () => {
  it('flags calc-driving (entry-backed) parameter edits', () => {
    expect(isHighRiskPendingEdit({ editType: 'param_entry', parameter: 'halfLife' })).toBe(true);
    expect(
      isHighRiskPendingEdit({ editType: 'parameter', parameter: 'volumeOfDistribution' }),
    ).toBe(true);
    expect(isHighRiskPendingEdit({ editType: 'param_entry', parameter: 'clearance' })).toBe(true);
  });

  it('does not flag authored/metadata parameters or non-parameter edits', () => {
    // analyteStability is authored, not entry-backed.
    expect(
      isHighRiskPendingEdit({ editType: 'parameter', parameter: 'analyteStability' }),
    ).toBe(false);
    expect(isHighRiskPendingEdit({ editType: 'wiki_fact', parameter: null })).toBe(false);
    expect(isHighRiskPendingEdit({ editType: 'param_entry', parameter: null })).toBe(false);
    expect(isHighRiskPendingEdit({ editType: 'parameter', parameter: 'notAParam' })).toBe(false);
  });
});

describe('consensusApprovalHoldReason', () => {
  const base: VerificationSummary = {
    approveCount: 2,
    disputeCount: 0,
    abstainCount: 0,
    implicitApproveCount: 0,
    approveTier2Count: 0,
  };

  it('holds when the base quorum is unmet', () => {
    expect(
      consensusApprovalHoldReason({ ...base, approveCount: 1 }, 2, { highRisk: false }),
    ).toBe('quorum_unmet');
  });

  it('applies a non-high-risk edit at quorum regardless of tier', () => {
    expect(consensusApprovalHoldReason(base, 2, { highRisk: false })).toBeNull();
  });

  it('holds a high-risk edit with no flagship approval', () => {
    expect(consensusApprovalHoldReason(base, 2, { highRisk: true })).toBe(
      'high_risk_missing_flagship',
    );
  });

  it('applies a high-risk edit once a flagship approval is present', () => {
    expect(
      consensusApprovalHoldReason({ ...base, approveTier2Count: 1 }, 2, { highRisk: true }),
    ).toBeNull();
  });

  it('holds a high-risk edit on the degraded single-approve path even with a flagship approval', () => {
    // Degraded pool: quorum relaxed to 1, one flagship approval — base gate
    // passes, but a high-risk edit needs the full design-target quorum.
    expect(
      consensusApprovalHoldReason(
        { ...base, approveCount: 1, approveTier2Count: 1 },
        1,
        { highRisk: true },
      ),
    ).toBe('high_risk_degraded_quorum');
  });

  it('treats a missing approveTier2Count as zero', () => {
    const legacy = {
      approveCount: 2,
      disputeCount: 0,
      abstainCount: 0,
      implicitApproveCount: 0,
    } as VerificationSummary;
    expect(consensusApprovalHoldReason(legacy, 2, { highRisk: true })).toBe(
      'high_risk_missing_flagship',
    );
  });
});

describe('verifiedByAgentIds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the subset of target ids the agent has already touched', async () => {
    mockSelectQueue([{ targetId: 10 }, { targetId: 30 }]);
    const set = await verifiedByAgentIds({
      agentId: 1,
      targetType: 'drug_parameter_revision',
      targetIds: [10, 20, 30],
    });
    expect(set.has(10)).toBe(true);
    expect(set.has(20)).toBe(false);
    expect(set.has(30)).toBe(true);
  });

  it('returns an empty set for an empty input', async () => {
    const set = await verifiedByAgentIds({
      agentId: 1,
      targetType: 'drug_parameter_revision',
      targetIds: [],
    });
    expect(set.size).toBe(0);
  });
});

describe('filterVerificationsForAudience', () => {
  function row(partial: Partial<VerificationRow>): VerificationRow {
    return {
      id: 0,
      agentId: 1,
      targetType: 'pending_edit',
      targetId: 100,
      verdict: 'approve',
      rationaleMd: '',
      evidenceRefs: [],
      model: null,
      isImplicit: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      agent: { id: 1, slug: 'a', name: 'A' },
      ...partial,
    };
  }

  it('hides implicit rows from non-owning callers', () => {
    const rows = [
      row({ id: 1, agentId: 1, isImplicit: true }),
      row({ id: 2, agentId: 2, isImplicit: false }),
    ];
    const seenByStranger = filterVerificationsForAudience({
      rows,
      callerAgentId: 9,
    });
    expect(seenByStranger.map((r) => r.id)).toEqual([2]);
  });

  it('shows implicit rows to the owning agent only', () => {
    const rows = [
      row({ id: 1, agentId: 1, isImplicit: true }),
      row({ id: 2, agentId: 2, isImplicit: false }),
    ];
    const seenBySelf = filterVerificationsForAudience({
      rows,
      callerAgentId: 1,
    });
    expect(seenBySelf.map((r) => r.id)).toEqual([1, 2]);
  });

  it('shows implicit rows to nobody when there is no caller agent', () => {
    const rows = [
      row({ id: 1, agentId: 1, isImplicit: true }),
      row({ id: 2, agentId: 2, isImplicit: false }),
    ];
    const seenAnon = filterVerificationsForAudience({
      rows,
      callerAgentId: null,
    });
    expect(seenAnon.map((r) => r.id)).toEqual([2]);
  });
});

describe('visibleVerificationTargetIds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('hides pending edits from anonymous callers', async () => {
    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1],
      callerUserId: null,
      callerRole: null,
    });

    expect(visible).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('lets reviewers see all matching pending edits', async () => {
    mockSelectQueue([
      { id: 1, submittedBy: 7 },
      { id: 2, submittedBy: 8 },
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1, 2],
      callerUserId: 99,
      callerRole: 'editor',
    });

    expect(visible).toEqual([1, 2]);
  });

  it('limits non-reviewers to their own pending edits', async () => {
    mockSelectQueue([
      { id: 1, submittedBy: 7 },
      { id: 2, submittedBy: 8 },
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1, 2],
      callerUserId: 7,
      callerRole: 'contributor',
    });

    expect(visible).toEqual([1]);
  });

  // Whatever the verification queue serves, this helper must admit — a row the
  // queue hands out and the POST rejects comes back every cycle as
  // `agent_verification_target_not_found`, unverifiable and undrainable. So the
  // gate is the row's own state (open, and published for wiki targets), not who
  // submitted it: a human contributor's proposal is verifiable too.
  it('lets active agents verify any open pending edit, human- or agent-submitted', async () => {
    // The SQL excludes the caller's own rows; these mocked rows stand for what
    // it returns, before the final status/wiki visibility guard.
    mockSelectQueue([
      { id: 1, submittedBy: 2, editType: 'parameter', status: 'pending' },
      { id: 2, submittedBy: 8, editType: 'parameter', status: 'pending' },
      { id: 3, submittedBy: 8, editType: 'parameter', status: 'draft' },
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1, 2, 3],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
    });

    expect(visible).toEqual([1, 2]);
  });

  it('hides wiki pending edits unless the target page is published', async () => {
    mockSelectQueue([
      {
        id: 1,
        submittedBy: 8,
        editType: 'wiki_fact',
        status: 'pending',
        pageStatus: 'published',
      },
      {
        id: 2,
        submittedBy: 8,
        editType: 'wiki_fact',
        status: 'pending',
        pageStatus: 'draft',
      },
      {
        id: 3,
        submittedBy: 8,
        editType: 'wiki_new',
        status: 'pending',
        pageStatus: null,
      },
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1, 2, 3],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
    });

    expect(visible).toEqual([1]);
  });

  // #1358 / #1361: the drug-parameter history dialog surfaces a revision's
  // linked pending-edit debate to the agents who took part in it, even after
  // the edit is decided — the open-queue rule alone only covers undecided
  // work, so without `includeCallerVerdicts` the debate becomes unreadable to
  // its own participants the moment it resolves.
  it('hides a decided pending edit from a non-reviewer agent by default, even if it verified it', async () => {
    mockSelectQueue([{ id: 1, submittedBy: 8, editType: 'parameter', status: 'approved' }]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
    });

    expect(visible).toEqual([]);
  });

  it('with includeCallerVerdicts, keeps a decided pending edit visible to the agent that verified it', async () => {
    mockSelectSequence([
      [{ id: 1, submittedBy: 8, editType: 'parameter', status: 'approved' }],
      [{ targetId: 1 }],
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
      includeCallerVerdicts: true,
    });

    expect(visible).toEqual([1]);
  });

  it('with includeCallerVerdicts, still hides a decided pending edit the agent never verified', async () => {
    mockSelectSequence([
      [{ id: 1, submittedBy: 8, editType: 'parameter', status: 'approved' }],
      [],
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
      includeCallerVerdicts: true,
    });

    expect(visible).toEqual([]);
  });

  // Review finding on #1361: `includeCallerVerdicts` must not bypass the
  // content gate — an agent's own rationale on a wiki edit stays withheld
  // once the page it targeted is unpublished again, exactly like open-queue
  // eligibility already requires. Only the "must still be pending" half of
  // that rule is meant to relax, not the "page must be published" half.
  it('with includeCallerVerdicts, still hides a decided wiki edit whose page reverted to draft', async () => {
    mockSelectSequence([
      [
        {
          id: 1,
          submittedBy: 8,
          editType: 'wiki_fact',
          status: 'approved',
          pageStatus: 'draft',
        },
      ],
      [{ targetId: 1 }],
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
      includeCallerVerdicts: true,
    });

    expect(visible).toEqual([]);
  });

  it('with includeCallerVerdicts, keeps a decided wiki edit visible while its page stays published', async () => {
    mockSelectSequence([
      [
        {
          id: 1,
          submittedBy: 8,
          editType: 'wiki_fact',
          status: 'approved',
          pageStatus: 'published',
        },
      ],
      [{ targetId: 1 }],
    ]);

    const visible = await visibleVerificationTargetIds({
      targetType: 'pending_edit',
      targetIds: [1],
      callerUserId: 99,
      callerRole: 'contributor',
      callerAgentId: 3,
      includeCallerVerdicts: true,
    });

    expect(visible).toEqual([1]);
  });
});

describe('clearVerificationsForTarget', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // The helper deletes verdicts and then retracts the agent disputes mirrored
  // from them, so the mock has to answer both an UPDATE and a DELETE chain.
  function mockDb(deletedRows: { id: number }[]) {
    const returningSpy = vi.fn(async () => deletedRows);
    const whereSpy = vi.fn(() => ({ returning: returningSpy }));
    const deleteSpy = vi.fn(() => ({ where: whereSpy }));
    const updateReturningSpy = vi.fn(async () => [{ id: 7 }]);
    const updateWhereSpy = vi.fn(() => ({ returning: updateReturningSpy }));
    const setSpy = vi.fn(() => ({ where: updateWhereSpy }));
    const updateSpy = vi.fn(() => ({ set: setSpy }));
    vi.mocked(getDb).mockReturnValue({
      delete: deleteSpy,
      update: updateSpy,
    } as unknown as ReturnType<typeof getDb>);
    return { returningSpy, whereSpy, deleteSpy, updateSpy, setSpy };
  }

  it('issues a DELETE filtered by (targetType, targetId) and returns the row count', async () => {
    const { returningSpy, whereSpy, deleteSpy } = mockDb([{ id: 1 }, { id: 2 }]);

    const count = await clearVerificationsForTarget({
      targetType: 'pending_edit',
      targetId: 42,
    });

    expect(count).toBe(2);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(returningSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when no rows matched (no-op for fresh inserts)', async () => {
    mockDb([]);

    const count = await clearVerificationsForTarget({
      targetType: 'pending_edit',
      targetId: 999,
    });

    expect(count).toBe(0);
  });

  // Revising the payload wipes the verdicts; the disputes those verdicts were
  // mirrored into must go with them, or the row stays "contested" against
  // content that no longer exists — blocking consensus and pinning it to the
  // top of /review until a moderator intervenes.
  it('retracts the agent disputes mirrored from the wiped verdicts', async () => {
    const { updateSpy, setSpy } = mockDb([{ id: 1 }]);

    await clearVerificationsForTarget({
      targetType: 'pending_edit',
      targetId: 42,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0][0]).toMatchObject({
      status: 'resolved',
      resolution: 'withdrawn',
    });
  });
});

describe('emptyVerificationSummary', () => {
  it('returns a fresh zero summary instance', () => {
    const a = emptyVerificationSummary();
    const b = emptyVerificationSummary();
    expect(a).toEqual({
      approveCount: 0,
      disputeCount: 0,
      abstainCount: 0,
      implicitApproveCount: 0,
      approveTier2Count: 0,
    });
    expect(a).not.toBe(b);
  });
});

describe('disputedTargetIdsForType', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the set of explicit-dispute target ids', async () => {
    mockSelectQueue([{ targetId: 11 }, { targetId: 22 }, { targetId: 33 }]);
    const set = await disputedTargetIdsForType({
      targetType: 'pending_edit',
    });
    expect(set.has(11)).toBe(true);
    expect(set.has(22)).toBe(true);
    expect(set.has(33)).toBe(true);
    expect(set.has(44)).toBe(false);
  });

  it('returns an empty set when no rows match', async () => {
    mockSelectQueue([]);
    const set = await disputedTargetIdsForType({
      targetType: 'pending_edit',
    });
    expect(set.size).toBe(0);
  });
});

describe('resolveActiveAgent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockSelectLimit(rows: unknown[]) {
    const limit = vi.fn(async () => rows);
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => ({ limit })),
    };
    const select = vi.fn(() => builder);
    vi.mocked(getDb).mockReturnValue({
      select,
    } as unknown as ReturnType<typeof getDb>);
    return { builder, limit, select };
  }

  it('resolves only through the active-agent user-role gate', async () => {
    const mocks = mockSelectLimit([{ id: 3, userId: 9, slug: 'agent-a' }]);

    const agent = await resolveActiveAgent(9);

    expect(agent).toEqual({ id: 3, userId: 9, slug: 'agent-a' });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.builder.innerJoin).toHaveBeenCalledTimes(1);
    expect(mocks.builder.where).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when the active-agent role gate excludes the row', async () => {
    mockSelectLimit([]);

    await expect(resolveActiveAgent(9)).resolves.toBeNull();
  });
});

describe('verificationTargetVersion (pending_edit)', () => {
  function mockSelectLimitOnce(row: unknown): void {
    const limit = vi.fn(async () => (row ? [row] : []));
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({ from })),
    } as unknown as ReturnType<typeof getDb>);
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('folds the row status into the version string', async () => {
    mockSelectLimitOnce({
      submittedAt: new Date('2026-06-02T10:00:00.000Z'),
      status: 'pending',
    });
    const v = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: 7,
    });
    expect(v).toBe('2026-06-02T10:00:00.000Z|pending');
  });

  it('returns a different string once the row has been approved', async () => {
    mockSelectLimitOnce({
      submittedAt: new Date('2026-06-02T10:00:00.000Z'),
      status: 'approved',
    });
    const v = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: 7,
    });
    expect(v).toBe('2026-06-02T10:00:00.000Z|approved');
  });

  it('returns null when the row no longer exists', async () => {
    mockSelectLimitOnce(null);
    const v = await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: 99,
    });
    expect(v).toBeNull();
  });
});

describe('meetsConsensusApprovalQuorum', () => {
  const summary = (over: Partial<VerificationSummary>): VerificationSummary => ({
    approveCount: 0,
    disputeCount: 0,
    abstainCount: 0,
    implicitApproveCount: 0,
    ...over,
  });

  it('defaults to a two-approval quorum', () => {
    expect(AGENT_CONSENSUS_APPROVE_QUORUM).toBe(2);
  });

  it('applies once two independent approvals land with no dispute', () => {
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 2 }))).toBe(
      true,
    );
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 3 }))).toBe(
      true,
    );
  });

  it('holds below quorum', () => {
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 1 }))).toBe(
      false,
    );
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 0 }))).toBe(
      false,
    );
  });

  it('a single dispute blocks regardless of approval count', () => {
    expect(
      meetsConsensusApprovalQuorum(
        summary({ approveCount: 5, disputeCount: 1 }),
      ),
    ).toBe(false);
  });

  it('ignores implicit approvals and abstentions toward the quorum', () => {
    expect(
      meetsConsensusApprovalQuorum(
        summary({ approveCount: 1, implicitApproveCount: 4, abstainCount: 3 }),
      ),
    ).toBe(false);
  });

  it('honors a custom quorum', () => {
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 2 }), 3)).toBe(
      false,
    );
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 3 }), 3)).toBe(
      true,
    );
  });

  it('applies on a single approval when the quorum is relaxed to 1', () => {
    expect(meetsConsensusApprovalQuorum(summary({ approveCount: 1 }), 1)).toBe(
      true,
    );
    // A dispute still blocks even under a relaxed single-reviewer quorum.
    expect(
      meetsConsensusApprovalQuorum(
        summary({ approveCount: 1, disputeCount: 1 }),
        1,
      ),
    ).toBe(false);
  });
});

describe('effectiveConsensusQuorum', () => {
  it('keeps the full two-reviewer quorum when the pool can supply it', () => {
    // 3 active agents: an agent-authored edit still has 2 eligible verifiers.
    expect(effectiveConsensusQuorum(3)).toBe(2);
    expect(effectiveConsensusQuorum(4)).toBe(2);
    expect(effectiveConsensusQuorum(10)).toBe(2);
  });

  it('relaxes to a single reviewer when only two agents are active', () => {
    // The bug this fixes: with 2 agents the lone non-author verifier can never
    // produce a second approval, so a fixed quorum of 2 is unreachable and
    // agent-authored edits pile up forever. Drop to 1 so consensus can drain.
    expect(effectiveConsensusQuorum(2)).toBe(1);
  });

  it('never returns below 1, even for degenerate pool sizes', () => {
    expect(effectiveConsensusQuorum(1)).toBe(1);
    expect(effectiveConsensusQuorum(0)).toBe(1);
  });

  it('counts a self-review author as one of its own verifiers', () => {
    // The flag adds a reviewer to the pool; it does not lower the bar. With
    // two active agents the quorum RISES from 1 to the design target of 2,
    // because the author's own reasoned verdict is now one of the two.
    expect(effectiveConsensusQuorum(2, { authorSelfReviews: true })).toBe(2);
    expect(effectiveConsensusQuorum(3, { authorSelfReviews: true })).toBe(2);
    // A lone active agent is the one case the flag makes reachable at all.
    expect(effectiveConsensusQuorum(1, { authorSelfReviews: true })).toBe(1);
  });
});

describe('isConsensusQuorumDegraded', () => {
  it('flags pools too small to reach the design-target quorum', () => {
    expect(isConsensusQuorumDegraded(0)).toBe(true);
    expect(isConsensusQuorumDegraded(1)).toBe(true);
    expect(isConsensusQuorumDegraded(2)).toBe(true);
  });

  it('is healthy once three or more agents are active', () => {
    expect(isConsensusQuorumDegraded(3)).toBe(false);
    expect(isConsensusQuorumDegraded(4)).toBe(false);
  });

  it('clears the degraded flag one agent earlier for a self-review author', () => {
    // Two agents where the author reviews itself is two real verdicts, so it
    // is not degraded. One agent still is — and must keep logging as such.
    expect(isConsensusQuorumDegraded(2, { authorSelfReviews: true })).toBe(
      false,
    );
    expect(isConsensusQuorumDegraded(1, { authorSelfReviews: true })).toBe(true);
  });
});

describe('countActiveVerifierAgents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('counts the active, contributor+ agent rows', async () => {
    mockSelectQueue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(await countActiveVerifierAgents()).toBe(3);
  });

  it('returns 0 when no agent is active', async () => {
    mockSelectQueue([]);
    expect(await countActiveVerifierAgents()).toBe(0);
  });
});

describe('isSelfReviewAgentUser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockSelectLimit(rows: unknown[]) {
    const limit = vi.fn(async () => rows);
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => ({ limit })),
    };
    const select = vi.fn(() => builder);
    vi.mocked(getDb).mockReturnValue({
      select,
    } as unknown as ReturnType<typeof getDb>);
    return { builder, limit };
  }

  it('is true only when the row clears every gate at once', async () => {
    // The predicate is one AND: active status, contributor+ backing role, and
    // the admin flag. The query returns a row only when all three hold.
    const mocks = mockSelectLimit([{ id: 3 }]);
    await expect(isSelfReviewAgentUser(9)).resolves.toBe(true);
    expect(mocks.builder.innerJoin).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledWith(1);
  });

  it('is false when no row matches — the standing no-self-review rule', async () => {
    mockSelectLimit([]);
    await expect(isSelfReviewAgentUser(9)).resolves.toBe(false);
  });
});
