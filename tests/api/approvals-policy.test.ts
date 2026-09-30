import { describe, expect, it } from 'vitest';
import { canAddApprovalStamp, isSelfApproval } from '../../api/approvals';

describe('approval stamp policy', () => {
  // Now resolved against the adjustable capability matrix, hence async; with
  // no overrides stored it must still answer exactly as the old literal check.
  it('allows contributors and higher roles to stamp approvals', async () => {
    expect(await canAddApprovalStamp('authenticated')).toBe(false);
    expect(await canAddApprovalStamp('contributor')).toBe(true);
    expect(await canAddApprovalStamp('editor')).toBe(true);
    expect(await canAddApprovalStamp('admin')).toBe(true);
  });

  it("rejects stamps on the caller's own content", () => {
    expect(isSelfApproval({ actorUserId: 7, ownerUserId: 7 })).toBe(true);
    expect(isSelfApproval({ actorUserId: 7, ownerUserId: 8 })).toBe(false);
    expect(isSelfApproval({ actorUserId: 7, ownerUserId: null })).toBe(false);
  });
});
