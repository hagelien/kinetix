import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, runInPoolTransactionMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  runInPoolTransactionMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  runInPoolTransaction: runInPoolTransactionMock,
  // `inTransaction` joins an open transaction rather than opening a second one.
  // Here the caller is already inside the stubbed `runInPoolTransaction`, so the
  // join branch — running `fn` directly — is exactly what production would do.
  inTransaction: (fn: () => unknown) => fn(),
}));

import {
  applyApprovedEdit,
  PendingEditReviewTokenMismatchError,
} from '../../api/_lib/pending-edits-helpers.js';
import { pendingEditReviewToken } from '../../api/_lib/pending-edit-review-token.js';

function pendingEdit(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    editType: 'wiki_fact',
    status: 'pending',
    submittedBy: 12,
    proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
    proposedMeta: null,
    referenceId: null,
    referenceIds: null,
    targetId: 3,
    parameter: null,
    submittedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function mockDbWithPendingEdit(edit: Record<string, unknown>) {
  // applyApprovedEdit runs inside a transaction; for the duration getDb() returns
  // the transaction client. It reads the edit TWICE on that client:
  //
  //   1. an unlocked preflight — `.where(...).limit(1)` — to discover which drug
  //      advisory locks the approval must hold, taken before the row lock so the
  //      lock order matches the merge fold's (advisory → row);
  //   2. the locking read — `.where(...).for('no key update').limit(1)`.
  //
  // So `where` has to offer both continuations. Modelling only the locking one
  // made the preflight throw a TypeError, which surfaced as "expected TypeError
  // to be an instance of PendingEditReviewTokenMismatchError" — the guard under
  // test never ran at all.
  //
  // Both reads resolve to the same row, which is the non-drifting case: the
  // preflight-vs-row token comparison passes, leaving the reviewer's stale token
  // (or the non-pending status) as the thing that actually trips the guard.
  const limit = vi.fn().mockResolvedValue([edit]);
  const forUpdate = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ for: forUpdate, limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  runInPoolTransactionMock.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ select }),
  );
}

describe('applyApprovedEdit review token guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a re-selected edit whose token no longer matches', async () => {
    mockDbWithPendingEdit(
      pendingEdit({
        proposedValue: { type: 'fact', attrs: { factId: 'changed' } },
      }),
    );

    await expect(
      applyApprovedEdit(7, 99, 'token-from-older-review-snapshot'),
    ).rejects.toBeInstanceOf(PendingEditReviewTokenMismatchError);
  });

  it('rejects a re-selected edit that is no longer pending', async () => {
    const reviewed = pendingEdit({ status: 'returned' });
    mockDbWithPendingEdit(reviewed);

    await expect(
      applyApprovedEdit(7, 99, pendingEditReviewToken(reviewed)),
    ).rejects.toBeInstanceOf(PendingEditReviewTokenMismatchError);
  });
});
