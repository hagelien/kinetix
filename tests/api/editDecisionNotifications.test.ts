import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyContributionFeedbackMock } = vi.hoisted(() => ({
  notifyContributionFeedbackMock: vi.fn(),
}));
vi.mock('../../api/_lib/notifications.js', () => ({
  notifyContributionFeedback: notifyContributionFeedbackMock,
}));

import {
  notifyEditDecision,
  notifyEditDecisionAfterCommit,
} from '../../api/_lib/editDecisionNotifications';

const args = {
  edit: { id: 7, submittedBy: 12, editType: 'parameter' },
  decision: 'rejected' as const,
  actorUserId: 99,
  note: 'Wrong population.',
};

describe('notifyEditDecisionAfterCommit', () => {
  beforeEach(() => vi.clearAllMocks());

  // Reject and return commit before the notice is written: a failed notice
  // must not surface as an error for a decision that already stands.
  it('swallows and logs a failed notice', async () => {
    notifyContributionFeedbackMock.mockRejectedValue(new Error('insert failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyEditDecisionAfterCommit(args)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('writes the notice when it can', async () => {
    notifyContributionFeedbackMock.mockResolvedValue({ notified: true });
    await notifyEditDecisionAfterCommit(args);
    expect(notifyContributionFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'edit_rejected', recipientUserId: 12 }),
    );
  });
});

describe('notifyEditDecision', () => {
  // Used inside the approval transaction, where the notice must commit or
  // roll back with the approval: it propagates the failure.
  it('propagates a failed notice', async () => {
    notifyContributionFeedbackMock.mockRejectedValue(new Error('insert failed'));
    await expect(notifyEditDecision(args)).rejects.toThrow('insert failed');
  });
});
