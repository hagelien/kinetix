import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { getDbMock, getConfigDbMock, withDbRetryMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getConfigDbMock: vi.fn(),
  withDbRetryMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getConfigDb: getConfigDbMock,
  runInPoolTransaction: vi.fn(),
  withDbRetry: withDbRetryMock,
}));

import { fanOutDisputeNotification } from '../../api/_lib/notifications';

const dialect = new PgDialect();

function mockDb(recipients: number) {
  const execute = vi.fn().mockResolvedValue({ rows: [{ recipients }] });
  const insert = vi.fn();
  getDbMock.mockReturnValue({ execute, insert });
  return { execute, insert };
}

describe('fanOutDisputeNotification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts dispute notifications with one SQL statement', async () => {
    const { execute, insert } = mockDb(3);

    await expect(
      fanOutDisputeNotification({
        type: 'dispute_opened',
        disputeId: 12,
        targetType: 'pending_edit',
        targetId: 34,
        actorUserId: 5,
        targetAuthorUserId: 8,
        title: 'Dispute opened',
        bodyMd: 'Please review this contested edit.',
        url: '/review?dispute=12',
      }),
    ).resolves.toEqual({ recipients: 3 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns zero when the SQL insert has no recipients', async () => {
    mockDb(0);

    await expect(
      fanOutDisputeNotification({
        type: 'dispute_resolved',
        disputeId: 12,
        targetType: 'pending_edit',
        targetId: 34,
        actorUserId: 5,
        targetAuthorUserId: null,
        title: 'Dispute resolved',
      }),
    ).resolves.toEqual({ recipients: 0 });
  });
});

