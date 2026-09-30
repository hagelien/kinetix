import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import { issueAgentToken } from '../../api/_lib/agentHelpers.ts';

/**
 * issueAgentToken folds the status check into the INSERT and only falls
 * back to a `select` (to tell 404 from 409) when zero rows were inserted.
 */
function mockDb(opts: {
  insertRows?: Array<Record<string, unknown>>;
  agentExists?: boolean;
}) {
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(opts.agentExists ? [{ id: 1 }] : []),
  };
  return {
    execute: vi.fn(() => Promise.resolve({ rows: opts.insertRows ?? [] })),
    select: vi.fn(() => selectChain),
  };
}

const insertedRow = {
  id: 5,
  agent_id: 1,
  token_hash: 'deadbeef',
  prefix: 'kxat_ab12cd…',
  label: 'ci',
  created_by: 9,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  last_used_at: null,
  revoked_at: null,
  revoked_by: null,
};

describe('issueAgentToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a token when the atomic insert lands a row', async () => {
    getDbMock.mockReturnValue(mockDb({ insertRows: [insertedRow] }));
    const { token, row } = await issueAgentToken({
      agentId: 1,
      label: 'ci',
      expiresAt: new Date(Date.now() + 86_400_000),
      actorId: 9,
    });
    expect(token.startsWith('kxat_')).toBe(true);
    expect(row.id).toBe(5);
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it('raises 409 when no row is inserted but the agent still exists (concurrent deactivation)', async () => {
    getDbMock.mockReturnValue(mockDb({ insertRows: [], agentExists: true }));
    await expect(
      issueAgentToken({
        agentId: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
        actorId: 9,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'agent_terminal' });
  });

  it('raises 404 when no row is inserted and the agent is gone', async () => {
    getDbMock.mockReturnValue(mockDb({ insertRows: [], agentExists: false }));
    await expect(
      issueAgentToken({
        agentId: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
        actorId: 9,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'agent_not_found' });
  });
});
