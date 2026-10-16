import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Admin capabilities stay with human sessions whatever the matrix says.
 *
 * An agent token is clamped to `editor` at authentication, and most admin
 * capabilities may be lowered to `editor` to delegate them to human editors.
 * Deciding on role alone would hand every editor-tier agent the delegated
 * capability too — `admin.agents.manage` included, which mints tokens for
 * other agents and grants adjudicator / flagship / self-review.
 */

const { getConfigDbMock, withDbRetryMock, getUserFromRequestMock } = vi.hoisted(
  () => ({
    getConfigDbMock: vi.fn(),
    withDbRetryMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
  }),
);

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  getConfigDb: getConfigDbMock,
  runInPoolTransaction: vi.fn(),
  withDbRetry: withDbRetryMock,
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import {
  authCan,
  requireCapability,
  resetPermissionOverridesForTests,
} from '../../api/_lib/permissions-store.ts';
import { requireAdmin } from '../../api/_lib/require-admin.ts';

/** The stored matrix: every row lowers a capability to `minTier`. */
function matrix(rows: Array<{ capability: string; minTier: string }>) {
  const builder = {
    select: () => builder,
    from: () => Promise.resolve(rows),
  };
  getConfigDbMock.mockReturnValue(builder);
}

const HUMAN_EDITOR = { userId: 5, role: 'editor' };
const AGENT_EDITOR = { userId: 6, role: 'editor', agentToken: true };

function createResponse() {
  const state = { statusCode: 0 };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn(() => res),
  } as unknown as ServerResponse;
  return { res, state };
}

const req = { headers: {} } as IncomingMessage;

beforeEach(() => {
  vi.clearAllMocks();
  resetPermissionOverridesForTests();
  withDbRetryMock.mockImplementation((fn: () => Promise<unknown>) => fn());
});

describe('authCan with an admin capability delegated to editors', () => {
  it('admits a human editor', async () => {
    matrix([{ capability: 'admin.agents.manage', minTier: 'editor' }]);
    expect(await authCan(HUMAN_EDITOR, 'admin.agents.manage')).toBe(true);
  });

  it('refuses an editor-tier agent token', async () => {
    matrix([{ capability: 'admin.agents.manage', minTier: 'editor' }]);
    expect(await authCan(AGENT_EDITOR, 'admin.agents.manage')).toBe(false);
  });

  it('leaves non-admin capabilities to the matrix for agents', async () => {
    matrix([]);
    // review.edit.decide ships at editor, and agents peer-review by design.
    expect(await authCan(AGENT_EDITOR, 'review.edit.decide')).toBe(true);
  });
});

describe('route guards with an admin capability delegated to editors', () => {
  it('requireAdmin refuses an agent token but admits a human editor', async () => {
    matrix([{ capability: 'admin.researchImport.run', minTier: 'editor' }]);

    getUserFromRequestMock.mockResolvedValueOnce(AGENT_EDITOR);
    const agent = createResponse();
    expect(
      await requireAdmin(req, agent.res, 'admin.researchImport.run'),
    ).toBeNull();
    expect(agent.state.statusCode).toBe(403);

    getUserFromRequestMock.mockResolvedValueOnce(HUMAN_EDITOR);
    const human = createResponse();
    expect(
      await requireAdmin(req, human.res, 'admin.researchImport.run'),
    ).toEqual(HUMAN_EDITOR);
  });

  it('requireCapability refuses an agent token but admits a human editor', async () => {
    matrix([{ capability: 'admin.settings.manage', minTier: 'editor' }]);

    getUserFromRequestMock.mockResolvedValueOnce(AGENT_EDITOR);
    const agent = createResponse();
    expect(
      await requireCapability(req, agent.res, 'admin.settings.manage'),
    ).toBeNull();
    expect(agent.state.statusCode).toBe(403);

    getUserFromRequestMock.mockResolvedValueOnce(HUMAN_EDITOR);
    const human = createResponse();
    expect(
      await requireCapability(req, human.res, 'admin.settings.manage'),
    ).toEqual(HUMAN_EDITOR);
  });
});
