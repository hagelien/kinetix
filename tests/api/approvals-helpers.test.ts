import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import { summariseApprovalsForTargets } from '../../api/_lib/approvals';
import { getDb } from '../../api/_lib/db.js';

interface ApprovalRow {
  targetId: number;
  approvedBy: number;
  approver: {
    id: number;
    username: string;
    displayName: string | null;
    role: string;
    isAgent: boolean;
  } | null;
}

function mockSelectQueue(rows: ApprovalRow[]): void {
  const builder: Record<string, unknown> = {};
  const chain = (): typeof builder => builder;
  Object.assign(builder, {
    from: vi.fn(chain),
    leftJoin: vi.fn(chain),
    where: vi.fn(chain),
    orderBy: vi.fn(async () => rows),
  });
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => builder),
  } as unknown as ReturnType<typeof getDb>);
}

describe('summariseApprovalsForTargets', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns an empty map when no targetIds are supplied', async () => {
    const map = await summariseApprovalsForTargets({
      targetType: 'wiki_revision',
      targetIds: [],
    });
    expect(map.size).toBe(0);
  });

  it('aggregates approver lists per targetId', async () => {
    const me = { id: 1, username: 'me', displayName: 'Me', role: 'editor', isAgent: false };
    const you = { id: 2, username: 'you', displayName: null, role: 'admin', isAgent: false };
    mockSelectQueue([
      { targetId: 5, approvedBy: 1, approver: me },
      { targetId: 5, approvedBy: 2, approver: you },
      { targetId: 7, approvedBy: 2, approver: you },
    ]);

    const map = await summariseApprovalsForTargets({
      targetType: 'wiki_revision',
      targetIds: [5, 7, 9],
      callerUserId: 1,
    });

    expect(map.get(5)?.count).toBe(2);
    expect(map.get(5)?.approvers.map((a) => a.id)).toEqual([1, 2]);
    expect(map.get(5)?.approvedByMe).toBe(true);
    expect(map.get(7)?.count).toBe(1);
    expect(map.get(7)?.approvedByMe).toBe(false);
    // Targets with no approvals are absent from the map; callers fall back
    // to count-0.
    expect(map.has(9)).toBe(false);
  });

  it('omits approvedByMe when no caller is supplied', async () => {
    mockSelectQueue([
      {
        targetId: 5,
        approvedBy: 1,
        approver: { id: 1, username: 'a', displayName: null, role: 'editor', isAgent: false },
      },
    ]);
    const map = await summariseApprovalsForTargets({
      targetType: 'wiki_revision',
      targetIds: [5],
    });
    expect(map.get(5)).toBeDefined();
    expect(map.get(5)?.approvedByMe).toBeUndefined();
  });

  it('skips approver entries whose user row is missing (post-cascade)', async () => {
    mockSelectQueue([
      { targetId: 5, approvedBy: 99, approver: null },
    ]);
    const map = await summariseApprovalsForTargets({
      targetType: 'wiki_revision',
      targetIds: [5],
    });
    // Count still reflects the row, but approvers list excludes the
    // dangling reference so the UI doesn't render undefined entries.
    expect(map.get(5)?.count).toBe(1);
    expect(map.get(5)?.approvers).toEqual([]);
  });
});
