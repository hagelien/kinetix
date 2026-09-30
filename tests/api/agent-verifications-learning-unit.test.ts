import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import {
  targetAuthorUserId,
  verificationTargetVersion,
} from '../../api/_lib/agent-verifications.ts';

function selectReturning(row: unknown) {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => [row] }) }),
    }),
  };
}

describe('learning_unit_revision verification target', () => {
  beforeEach(() => getDbMock.mockReset());

  it('resolves the author from learning_unit_revisions.createdBy', async () => {
    getDbMock.mockReturnValue(selectReturning({ createdBy: 42 }));
    const author = await targetAuthorUserId({
      targetType: 'learning_unit_revision',
      targetId: 7,
    });
    expect(author).toBe(42);
  });

  it('versions on the revision createdAt', async () => {
    const when = new Date('2026-06-17T10:00:00.000Z');
    getDbMock.mockReturnValue(selectReturning({ createdAt: when }));
    const version = await verificationTargetVersion({
      targetType: 'learning_unit_revision',
      targetId: 7,
    });
    expect(version).toBe('2026-06-17T10:00:00.000Z');
  });
});
