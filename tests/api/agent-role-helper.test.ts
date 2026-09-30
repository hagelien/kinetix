import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import { setAgentRole, AgentAdminError } from '../../api/_lib/agentHelpers.ts';

/**
 * Mock the slice of drizzle setAgentRole touches: a preflight `select`,
 * an atomic `execute` (active path CTE), and a guarded `update().returning`
 * (suspended path).
 */
function mockDb(opts: {
  preflight: Array<Record<string, unknown>>;
  executeRows?: Array<Record<string, unknown>>;
  updateRows?: Array<Record<string, unknown>>;
}) {
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(opts.preflight),
  };
  const updateChain: Record<string, unknown> = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(opts.updateRows ?? []),
  };
  return {
    select: vi.fn(() => selectChain),
    execute: vi.fn(() => Promise.resolve({ rows: opts.executeRows ?? [] })),
    update: vi.fn(() => updateChain),
  };
}

const activeAgentRow = {
  id: 1,
  user_id: 42,
  name: 'Agent',
  name_en: null,
  slug: 'agent',
  description: null,
  description_en: null,
  maintainer_user_id: null,
  status: 'active',
  status_changed_by: null,
  status_changed_at: null,
  status_change_reason: null,
  pre_suspension_role: null,
  hooks_enabled: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('setAgentRole', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a role outside contributor/editor', async () => {
    getDbMock.mockReturnValue(mockDb({ preflight: [] }));
    await expect(
      setAgentRole({ agentId: 1, role: 'admin', actorId: 9 }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_role' });
  });

  it('rejects a deactivated agent (terminal)', async () => {
    getDbMock.mockReturnValue(
      mockDb({ preflight: [{ id: 1, userId: 42, status: 'deactivated' }] }),
    );
    await expect(
      setAgentRole({ agentId: 1, role: 'editor', actorId: 9 }),
    ).rejects.toMatchObject({ status: 409, code: 'agent_terminal' });
  });

  it('updates the live role for an active agent', async () => {
    getDbMock.mockReturnValue(
      mockDb({
        preflight: [{ id: 1, userId: 42, status: 'active' }],
        executeRows: [activeAgentRow],
      }),
    );
    const result = await setAgentRole({
      agentId: 1,
      role: 'editor',
      actorId: 9,
    });
    expect(result.role).toBe('editor');
    expect(result.agent.id).toBe(1);
  });

  it('raises a conflict when the active guard matches no rows (concurrent transition)', async () => {
    // Preflight saw 'active', but the guarded CTE update matched nothing —
    // the agent left 'active' between read and write.
    getDbMock.mockReturnValue(
      mockDb({
        preflight: [{ id: 1, userId: 42, status: 'active' }],
        executeRows: [],
      }),
    );
    await expect(
      setAgentRole({ agentId: 1, role: 'editor', actorId: 9 }),
    ).rejects.toMatchObject({ status: 409, code: 'status_conflict' });
  });

  it('raises a conflict when the suspended guard matches no rows', async () => {
    getDbMock.mockReturnValue(
      mockDb({
        preflight: [{ id: 1, userId: 42, status: 'suspended' }],
        updateRows: [],
      }),
    );
    await expect(
      setAgentRole({ agentId: 1, role: 'editor', actorId: 9 }),
    ).rejects.toBeInstanceOf(AgentAdminError);
    await expect(
      setAgentRole({ agentId: 1, role: 'editor', actorId: 9 }),
    ).rejects.toMatchObject({ status: 409, code: 'status_conflict' });
  });

  it('stashes the role on pre_suspension_role for a suspended agent', async () => {
    getDbMock.mockReturnValue(
      mockDb({
        preflight: [{ id: 1, userId: 42, status: 'suspended' }],
        updateRows: [{ ...activeAgentRow, status: 'suspended' }],
      }),
    );
    const result = await setAgentRole({
      agentId: 1,
      role: 'editor',
      actorId: 9,
    });
    // Live role stays authenticated while suspended.
    expect(result.role).toBe('authenticated');
  });
});
