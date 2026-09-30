import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, consumeRateLimitMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
  consumeRateLimit: consumeRateLimitMock,
  getClientAddressKey: vi.fn().mockReturnValue('ip:127.0.0.1'),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  signToken: vi.fn().mockResolvedValue('test-jwt'),
  setAuthCookie: vi.fn(),
}));

import handler from '../../api/auth-verify.ts';

function makeReq(body: Record<string, unknown>): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/auth-verify';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(raw.length),
  };
  return req;
}

function makeRes() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((code: number, headers?: Record<string, unknown>) => {
      state.statusCode = code;
      state.headers = { ...state.headers, ...(headers ?? {}) };
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function findValue(node: unknown, needle: unknown): boolean {
  if (node === needle) return true;
  if (typeof node !== 'object' || node === null) return false;
  if ('value' in node && (node as Record<string, unknown>).value === needle) {
    return true;
  }
  if ('queryChunks' in node) {
    return (node as Record<string, unknown[]>).queryChunks.some((chunk) =>
      findValue(chunk, needle),
    );
  }
  return false;
}

function mockDbForWrongCode() {
  const storedHash = 'v2:' + 'a'.repeat(64);
  const updateSet = vi.fn();
  const updateWhere = vi.fn().mockResolvedValue(undefined);

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: 1,
              role: 'authenticated',
              emailVerifiedAt: null,
              sessionMaxDays: 30,
              magicLinkHash: storedHash,
              magicLinkExpires: new Date(Date.now() + 60_000),
              magicLinkFailedAttempts: 2,
            },
          ]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: updateSet.mockReturnValue({ where: updateWhere }),
    }),
  };

  getDbMock.mockReturnValue(db);
  return { updateSet, updateWhere, storedHash };
}

async function mockDbForCorrectCode(
  opts: { consumedByConcurrentRequest?: boolean } = {},
) {
  process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough-for-tests';
  const { hashMagicLinkCode } = await import('../../api/_lib/magic-link.ts');
  const code = '123456';
  const storedHash = hashMagicLinkCode(code);
  const updateReturning = vi
    .fn()
    .mockResolvedValue(opts.consumedByConcurrentRequest ? [] : [{ id: 1 }]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: 1,
              role: 'authenticated',
              emailVerifiedAt: null,
              sessionMaxDays: 30,
              magicLinkHash: storedHash,
              magicLinkExpires: new Date(Date.now() + 60_000),
              magicLinkFailedAttempts: 0,
            },
          ]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
  };

  getDbMock.mockReturnValue(db);
  return { code, updateWhere, storedHash };
}

describe('auth-verify atomic magic-link consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough-for-tests';
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it('uses SQL expressions for wrong-code updates', async () => {
    const { updateSet } = mockDbForWrongCode();
    const { res } = makeRes();

    await handler(makeReq({ email: 'user@example.com', code: '000000' }), res);

    expect(updateSet).toHaveBeenCalledOnce();
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    const isSqlObject = (value: unknown): boolean =>
      typeof value === 'object' && value !== null && 'queryChunks' in value;

    expect(isSqlObject(setArg.magicLinkFailedAttempts)).toBe(true);
    expect(isSqlObject(setArg.magicLinkHash)).toBe(true);
    // magicLinkExpires is intentionally absent from the wrong-code update set
    // so that lockout does not reset the cooldown window used by auth-request.
    expect(setArg.magicLinkExpires).toBeUndefined();
  });

  it('scopes wrong-code updates to the verified hash', async () => {
    const { updateWhere, storedHash } = mockDbForWrongCode();
    const { res } = makeRes();

    await handler(makeReq({ email: 'user@example.com', code: '000000' }), res);

    expect(updateWhere).toHaveBeenCalledOnce();
    expect(findValue(updateWhere.mock.calls[0]?.[0], storedHash)).toBe(true);
  });

  it('issues a JWT when the success update consumes the hash', async () => {
    const { code, updateWhere, storedHash } = await mockDbForCorrectCode();
    const { res, state } = makeRes();

    await handler(makeReq({ email: 'user@example.com', code }), res);

    expect(updateWhere).toHaveBeenCalledOnce();
    expect(findValue(updateWhere.mock.calls[0]?.[0], storedHash)).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ success: true });
  });

  it('rejects a correct code when another request already consumed it', async () => {
    const { code } = await mockDbForCorrectCode({
      consumedByConcurrentRequest: true,
    });
    const { res, state } = makeRes();

    await handler(makeReq({ email: 'user@example.com', code }), res);

    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toMatchObject({
      error: 'Invalid or expired code',
    });
  });

  it('applies stayLoggedIn: true preference at verify time (60-day session)', async () => {
    const { code, updateWhere } = await mockDbForCorrectCode();
    const { res, state } = makeRes();

    await handler(
      makeReq({ email: 'user@example.com', code, stayLoggedIn: true }),
      res,
    );

    expect(state.statusCode).toBe(200);
    // The update that consumes the code should include sessionMaxDays = 60.
    const setCall = (
      getDbMock.mock.results[0]?.value as { update: ReturnType<typeof vi.fn> }
    ).update.mock.results[0]?.value as {
      set: ReturnType<typeof vi.fn>;
    };
    const setArg = setCall.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.sessionMaxDays).toBe(60);
    void updateWhere; // consumed by the mock
  });

  it('applies stayLoggedIn: false preference at verify time (30-day session)', async () => {
    // Start with a 60-day session to verify the downgrade path works correctly.
    process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough-for-tests';
    const { hashMagicLinkCode } = await import('../../api/_lib/magic-link.ts');
    const code = '654321';
    const storedHash = hashMagicLinkCode(code);
    const updateReturning = vi.fn().mockResolvedValue([{ id: 2 }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: 2,
                role: 'authenticated',
                emailVerifiedAt: null,
                sessionMaxDays: 60,
                magicLinkHash: storedHash,
                magicLinkExpires: new Date(Date.now() + 60_000),
                magicLinkFailedAttempts: 0,
              },
            ]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
    };
    getDbMock.mockReturnValue(db);

    const { res, state } = makeRes();
    await handler(
      makeReq({ email: 'user@example.com', code, stayLoggedIn: false }),
      res,
    );

    expect(state.statusCode).toBe(200);
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.sessionMaxDays).toBe(30);
    void updateWhere;
  });

  it('keeps existing sessionMaxDays when stayLoggedIn is absent', async () => {
    const { code } = await mockDbForCorrectCode();
    const { res, state } = makeRes();

    await handler(makeReq({ email: 'user@example.com', code }), res);

    expect(state.statusCode).toBe(200);
    // Without stayLoggedIn, the update should preserve sessionMaxDays = 30
    // (the value returned by the mock user row).
    const db = getDbMock.mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    const setArg = (
      db.update.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> }
    ).set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.sessionMaxDays).toBe(30);
  });
});
