/**
 * Tests for the DB-level OTP issue cooldown in auth-request.
 *
 * The cooldown prevents rapid re-issue of OTP codes (email bombing, OTP
 * cycling) even when the in-memory rate limiter is bypassed across multiple
 * serverless instances, by keying on the shared DB state via magicLinkExpires.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, consumeRateLimitMock, sendLoginCodeMock } = vi.hoisted(
  () => ({
    getDbMock: vi.fn(),
    consumeRateLimitMock: vi.fn(),
    sendLoginCodeMock: vi.fn(),
  }),
);

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
  consumeRateLimit: consumeRateLimitMock,
  getClientAddressKey: vi.fn().mockReturnValue('ip:127.0.0.1'),
}));
vi.mock('../../api/_lib/email.js', () => ({
  sendLoginCode: sendLoginCodeMock,
}));

import { MAGIC_LINK_CODE_TTL_MS } from '../../api/_lib/magic-link.js';
import handler from '../../api/auth-request.ts';

function makeReq(email = 'user@example.com'): IncomingMessage {
  const body = JSON.stringify({ email });
  const req = Readable.from([body]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/auth-request';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(body.length),
  };
  return req;
}

function makeCrossOriginReq(): IncomingMessage {
  const req = makeReq();
  req.headers.origin = 'https://evil.example';
  return req;
}

function makeRes() {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((code: number) => {
      state.statusCode = code;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

const NEW_USER_ROW = {
  id: 99,
  email: 'user@example.com',
  magicLinkHash: null,
  magicLinkExpires: null,
  magicLinkFailedAttempts: 0,
};

// auth-request makes DB selects in this order:
//   1. isEmailAllowed → allowedEmails (returns [{id:1}] so the allowlist check passes)
//   2. user lookup (returns userRow, or [] triggering insert for new users)
// The limit() mock uses mockResolvedValueOnce so each sequential call gets
// the right result without depending on which Drizzle table was passed.
//
// updateSucceeds controls whether the atomic WHERE-gated update returns a row
// (simulating winning or losing the concurrent-request race).
function mockDb(
  userRow: Record<string, unknown> | null,
  updateSucceeds = true,
) {
  const userId = (userRow?.id ?? NEW_USER_ROW.id) as number;

  // The update chain now ends in .returning({ id }) — return the user id
  // when the WHERE predicate matches (updateSucceeds=true) or [] when a
  // concurrent request already issued a code (updateSucceeds=false).
  const updateReturning = vi
    .fn()
    .mockResolvedValue(updateSucceeds ? [{ id: userId }] : []);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });

  // Insert always returns a freshly-created user with no OTP state.
  const insertReturning = vi.fn().mockResolvedValue([NEW_USER_ROW]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });

  // limit() is called once per select chain. Return results in call order:
  //   call 1: allowedEmails check → [{id:1}] (email is allowlisted)
  //   call 2: user lookup → existing row or []
  const limitFn = vi
    .fn()
    .mockResolvedValueOnce([{ id: 1 }]) // isEmailAllowed → allowed
    .mockResolvedValueOnce(userRow ? [userRow] : []); // user lookup

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: limitFn }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
  };
  getDbMock.mockReturnValue(db);
  return { db, updateSet, updateWhere };
}

describe('auth-request OTP issue cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough-for-tests';
    // Rate limiter never blocks in these tests.
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    sendLoginCodeMock.mockResolvedValue(undefined);
  });

  it('sends a code when there is no existing OTP (new user)', async () => {
    mockDb(null);
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).toHaveBeenCalledOnce();
  });

  it('rejects cross-origin browser posts before rate limits or DB work', async () => {
    const { res, state } = makeRes();
    await handler(makeCrossOriginReq(), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'cross_origin_request_rejected',
    });
    expect(consumeRateLimitMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
    expect(sendLoginCodeMock).not.toHaveBeenCalled();
  });

  it('sends a code when the previous OTP has expired', async () => {
    mockDb({
      id: 1,
      email: 'user@example.com',
      magicLinkHash: 'v2:' + 'a'.repeat(64),
      magicLinkExpires: new Date(Date.now() - 1000), // expired 1 second ago
      magicLinkFailedAttempts: 0,
    });
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).toHaveBeenCalledOnce();
  });

  it('suppresses re-issue when a valid OTP was just issued (< 60 s ago)', async () => {
    // Active OTP issued 5 seconds ago — the read-side guard returns early.
    const issuedAt = Date.now() - 5_000;
    mockDb({
      id: 1,
      email: 'user@example.com',
      magicLinkHash: 'v2:' + 'a'.repeat(64),
      magicLinkExpires: new Date(issuedAt + MAGIC_LINK_CODE_TTL_MS),
      magicLinkFailedAttempts: 0,
    });
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).not.toHaveBeenCalled();
  });

  it('suppresses re-issue when an active code has outstanding failures (cycling attack)', async () => {
    // Active OTP issued 10 seconds ago with 4 failed attempts — exactly
    // the state an attacker would cycle to reset the counter.
    const issuedAt = Date.now() - 10_000;
    mockDb({
      id: 1,
      email: 'user@example.com',
      magicLinkHash: 'v2:' + 'a'.repeat(64),
      magicLinkExpires: new Date(issuedAt + MAGIC_LINK_CODE_TTL_MS),
      magicLinkFailedAttempts: 4,
    });
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).not.toHaveBeenCalled();
  });

  it('suppresses re-issue after lockout even when magicLinkHash is null', async () => {
    // Simulates the post-lockout state: auth-verify cleared the hash but
    // (deliberately) left magicLinkExpires set so the cooldown survives.
    // An attacker who just exhausted 5 guesses must still wait out the window.
    const issuedAt = Date.now() - 10_000;
    mockDb({
      id: 1,
      email: 'user@example.com',
      magicLinkHash: null, // cleared by lockout in auth-verify
      magicLinkExpires: new Date(issuedAt + MAGIC_LINK_CODE_TTL_MS),
      magicLinkFailedAttempts: 0, // also reset by lockout CASE expression
    });
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).not.toHaveBeenCalled();
  });

  it('allows re-issue once the cooldown window has elapsed (> 60 s)', async () => {
    // Active OTP issued 90 seconds ago — past the 60-second cooldown.
    const issuedAt = Date.now() - 90_000;
    mockDb({
      id: 1,
      email: 'user@example.com',
      magicLinkHash: 'v2:' + 'a'.repeat(64),
      magicLinkExpires: new Date(issuedAt + MAGIC_LINK_CODE_TTL_MS),
      magicLinkFailedAttempts: 0,
    });
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).toHaveBeenCalledOnce();
  });

  it('does not send email when the atomic WHERE predicate blocks a concurrent request', async () => {
    // Simulates the race: read-side check passed (stale snapshot) but the
    // update's WHERE predicate finds the cooldown already armed by a
    // concurrent request, so it returns no rows.
    const issuedAt = Date.now() - 90_000;
    mockDb(
      {
        id: 1,
        email: 'user@example.com',
        magicLinkHash: 'v2:' + 'a'.repeat(64),
        magicLinkExpires: new Date(issuedAt + MAGIC_LINK_CODE_TTL_MS),
        magicLinkFailedAttempts: 0,
      },
      false, // updateSucceeds = false → simulates losing the race
    );
    const { res, state } = makeRes();
    await handler(makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(sendLoginCodeMock).not.toHaveBeenCalled();
  });
});
