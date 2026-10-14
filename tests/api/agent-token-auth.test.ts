import type { IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import { getUserFromRequest, generateAgentToken } from '../../api/_lib/auth.ts';

/**
 * Minimal chainable drizzle stub. The first `select(...)` resolves to the
 * token+user join (via `.limit`), the second resolves to the group rows
 * (awaited at `.where`). `update(...)` (the last_used_at touch) is a no-op.
 */
function mockDb(opts: {
  tokenRow: Record<string, unknown> | null;
  groups?: Array<Record<string, unknown>>;
}) {
  let selectCall = 0;
  const chain = (result: unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: () => c,
      limit: () => Promise.resolve(result),
      then: (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return c;
  };
  return {
    select: vi.fn(() => {
      const result =
        selectCall === 0
          ? opts.tokenRow
            ? [opts.tokenRow]
            : []
          : (opts.groups ?? []);
      selectCall += 1;
      return chain(result);
    }),
    update: vi.fn(() => ({
      set: () => ({ where: () => Promise.resolve() }),
    })),
  };
}

function requestWithToken(token: string): IncomingMessage {
  return {
    method: 'GET',
    url: '/api/whatever',
    headers: { host: 'localhost', cookie: `__Host-kinetix-auth=${token}` },
  } as IncomingMessage;
}

describe('getUserFromRequest with a persistent agent token', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves a live token to its backing user + live DB role', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(
      mockDb({
        tokenRow: {
          tokenId: 7,
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          agentStatus: 'active',
          userId: 42,
          role: 'editor',
        },
        groups: [{ id: 1, slug: 'curators', name: 'Curators' }],
      }),
    );

    const ctx = await getUserFromRequest(requestWithToken(token));
    expect(ctx).toEqual({
      userId: 42,
      role: 'editor',
      groups: [{ id: 1, slug: 'curators', name: 'Curators' }],
    });
  });

  it('caps an accidentally elevated agent backing user at editor', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(
      mockDb({
        tokenRow: {
          tokenId: 7,
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          agentStatus: 'active',
          userId: 42,
          role: 'admin',
        },
      }),
    );

    const ctx = await getUserFromRequest(requestWithToken(token));
    expect(ctx).toMatchObject({
      userId: 42,
      role: 'editor',
    });
  });

  it('rejects a revoked token', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(
      mockDb({
        tokenRow: {
          tokenId: 7,
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: new Date(),
          agentStatus: 'active',
          userId: 42,
          role: 'editor',
        },
      }),
    );
    expect(await getUserFromRequest(requestWithToken(token))).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(
      mockDb({
        tokenRow: {
          tokenId: 7,
          expiresAt: new Date(Date.now() - 1000),
          revokedAt: null,
          agentStatus: 'active',
          userId: 42,
          role: 'contributor',
        },
      }),
    );
    expect(await getUserFromRequest(requestWithToken(token))).toBeNull();
  });

  it('rejects a token for a suspended agent', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(
      mockDb({
        tokenRow: {
          tokenId: 7,
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          agentStatus: 'suspended',
          userId: 42,
          role: 'authenticated',
        },
      }),
    );
    expect(await getUserFromRequest(requestWithToken(token))).toBeNull();
  });

  it('rejects an unknown token (no matching hash)', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(mockDb({ tokenRow: null }));
    expect(await getUserFromRequest(requestWithToken(token))).toBeNull();
  });
});

describe('getUserFromRequest — the run an agent request belongs to (issue #214)', () => {
  beforeEach(() => vi.clearAllMocks());

  const liveToken = () =>
    mockDb({
      tokenRow: {
        tokenId: 7,
        expiresAt: null,
        revokedAt: null,
        agentStatus: 'active',
        userId: 42,
        role: 'contributor',
      },
    });

  function withRunSession(token: string, runSession: string): IncomingMessage {
    const req = requestWithToken(token);
    req.headers['x-kinetix-run-session'] = runSession;
    return req;
  }

  it('carries a valid X-Kinetix-Run-Session on the agent context', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(liveToken());
    const ctx = await getUserFromRequest(
      withRunSession(token, '0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f'),
    );
    expect(ctx?.runSessionId).toBe('0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f');
  });

  it('leaves the context without a run when the header is malformed', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(liveToken());
    const ctx = await getUserFromRequest(withRunSession(token, 'a b'));
    expect(ctx).not.toBeNull();
    expect(ctx).not.toHaveProperty('runSessionId');
  });

  it('never resolves a run for a token that does not authenticate', async () => {
    const { token } = generateAgentToken();
    getDbMock.mockReturnValue(mockDb({ tokenRow: null }));
    expect(
      await getUserFromRequest(withRunSession(token, 'sess-1')),
    ).toBeNull();
  });
});
