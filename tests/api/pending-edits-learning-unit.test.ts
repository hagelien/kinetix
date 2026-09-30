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

import { applyApprovedLearningUnit } from '../../api/_lib/pending-edits-helpers.ts';

// Minimal chainable db fake: insert(...).values(...).returning() -> [{ id }];
// update(...).set(...).where(...) resolves; select for slug-existence -> [].
// updateWhereSpy is a vi.fn() so callers can assert it was invoked.
function makeDb(insertedIds: number[], updateWhereSpy = vi.fn().mockResolvedValue(undefined)) {
  const ids = [...insertedIds];
  return {
    insert: () => ({
      values: () => ({
        returning: () => [{ id: ids.shift() ?? 1 }],
      }),
    }),
    update: () => ({ set: () => ({ where: updateWhereSpy }) }),
    _updateWhereSpy: updateWhereSpy,
  };
}

describe('applyApprovedLearningUnit', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    recordApprovalMock.mockReset();
    recordImplicitMock.mockReset();
    fireHookMock.mockReset();
  });

  it('inserts a new unit + revision and stamps approval when targetId is null', async () => {
    const db = makeDb([100, 200]); // unit id 100, revision id 200
    const edit = {
      id: 9,
      editType: 'learning_unit',
      targetId: null,
      proposedValue: { questions: [] },
      proposedMeta: {
        title: 'Tittel',
        slug: 'tittel',
        difficulty: 'foundational',
        domains: ['pharmacokinetics'],
        editSummary: 'først',
      },
      referenceIds: [12],
      submittedBy: 5,
    };
    await applyApprovedLearningUnit(db as never, edit as never, 3);

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
      expect.objectContaining({ kind: 'learning_unit_approved', pendingEditId: 9 }),
    );
  });

  it('updates the existing unit and inserts a revision when targetId is set', async () => {
    // Revision id = 300; no second insert (unit already exists, so ids array
    // only needs one entry for the learningUnitRevisions insert).
    const updateWhereSpy = vi.fn().mockResolvedValue(undefined);
    const db = makeDb([300], updateWhereSpy);
    const edit = {
      id: 11,
      editType: 'learning_unit',
      targetId: 42,
      proposedValue: { questions: [] },
      proposedMeta: {
        title: 'Oppdatert tittel',
        slug: 'oppdatert-tittel',
        difficulty: 'intermediate_lis',
        domains: ['pharmacodynamics'],
        editSummary: 'rettet feil',
      },
      referenceIds: [7],
      submittedBy: 8,
    };
    await applyApprovedLearningUnit(db as never, edit as never, 4);

    // The UPDATE path must have been taken (update().set().where() called).
    expect(updateWhereSpy).toHaveBeenCalled();

    // A revision row is still inserted and approvals are stamped on it.
    expect(recordApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'learning_unit_revision',
        targetId: 300,
        approvedBy: 4,
      }),
    );
    expect(recordImplicitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 8,
        targetType: 'learning_unit_revision',
        targetId: 300,
      }),
    );
    expect(fireHookMock).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ kind: 'learning_unit_approved', pendingEditId: 11 }),
    );
  });
});
