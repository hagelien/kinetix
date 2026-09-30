import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, recordApprovalMock, recordImplicitMock, fireHookMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    recordApprovalMock: vi.fn(),
    recordImplicitMock: vi.fn(),
    fireHookMock: vi.fn(),
  }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/approvals.js', () => ({
  recordApproval: recordApprovalMock,
}));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  recordImplicitAgentApproval: recordImplicitMock,
}));
vi.mock('../../api/_lib/agentHooks.js', () => ({
  fireAgentHookForActorAsync: fireHookMock,
}));

import { applyApprovedClinicalCase } from '../../api/_lib/pending-edits-helpers.ts';

// Capture the values passed to the learning_units insert so the test can assert
// kind:'clinical_case' is written. insert(...).values(payload).returning() ->
// [{ id }]; update(...).set(...).where() resolves.
function makeDb(insertedIds: number[]) {
  const ids = [...insertedIds];
  const insertedValues: Record<string, unknown>[] = [];
  return {
    _insertedValues: insertedValues,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedValues.push(v);
        return { returning: () => [{ id: ids.shift() ?? 1 }] };
      },
    }),
    update: () => ({
      set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  };
}

const validMeta = {
  title: 'Klinisk case',
  slug: 'klinisk-case',
  difficulty: 'advanced_lis',
  domains: ['pharmacokinetics'],
  editSummary: 'først',
  requiresExpertReview: true,
};

describe('applyApprovedClinicalCase', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    recordApprovalMock.mockReset();
    recordImplicitMock.mockReset();
    fireHookMock.mockReset();
  });

  it('inserts a learning_units row with kind:clinical_case + a revision and stamps approval', async () => {
    const db = makeDb([100, 200]); // unit id 100, revision id 200
    const edit = {
      id: 9,
      editType: 'clinical_case',
      targetId: null,
      proposedValue: { scenario: 'fiktiv', questions: [] },
      proposedMeta: validMeta,
      referenceIds: [12, 34],
      submittedBy: 5,
    };
    await applyApprovedClinicalCase(db as never, edit as never, 3);

    // The unit insert is the first insert; it must carry kind + the PRIMARY
    // citation (referenceIds[0]).
    const unitInsert = db._insertedValues[0]!;
    expect(unitInsert.kind).toBe('clinical_case');
    expect(unitInsert.citationId).toBe(12);
    expect(unitInsert.status).toBe('published');

    expect(recordApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'learning_unit_revision',
        targetId: 200,
        approvedBy: 3,
      }),
    );
    expect(recordImplicitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 5,
        targetType: 'learning_unit_revision',
        targetId: 200,
      }),
    );
    expect(fireHookMock).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ pendingEditId: 9, unitId: 100 }),
    );
  });

  it('throws if no anchor citation is present on a new case', async () => {
    const db = makeDb([1, 2]);
    const edit = {
      id: 10,
      editType: 'clinical_case',
      targetId: null,
      proposedValue: { scenario: 'fiktiv', questions: [] },
      proposedMeta: validMeta,
      referenceIds: null,
      submittedBy: 5,
    };
    await expect(
      applyApprovedClinicalCase(db as never, edit as never, 3),
    ).rejects.toThrow();
  });
});
