/**
 * The sign-in code issue cooldown grows with wrong guesses, against real SQL.
 *
 * Each code allows MAX_MAGIC_LINK_FAILURES guesses, and a new code used to be
 * available every 60 s forever — about 7,200 guesses a day at any allowlisted
 * account. `users.magic_link_failures_since_auth` counts wrong guesses across
 * codes until a successful sign-in, and auth-request doubles the cooldown for
 * every MAX_MAGIC_LINK_FAILURES of them (api/_lib/magic-link.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { allowedEmails, users } from '../../db/schema.js';
import requestHandler from '../../api/auth-request.js';
import verifyHandler from '../../api/auth-verify.js';
import {
  hashMagicLinkCode,
  MAGIC_LINK_CODE_TTL_MS,
  MAX_MAGIC_LINK_FAILURES,
} from '../../api/_lib/magic-link.js';
import { clearRateLimitState } from '../../api/_lib/rate-limit.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';

const EMAIL = 'victim@example.com';
const MINUTE = 60_000;

let db: IntegrationDb;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough-for-tests';
  // No email provider: sendLoginCode throws and auth-request logs it, which
  // is all these tests need — they read the issued state from the row.
  delete process.env.RESEND_API_KEY;
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  clearRateLimitState();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await db.insert(allowedEmails).values({ email: EMAIL });
});

function makeReq(url: string, body: Record<string, unknown>): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(raw.length),
  };
  return req;
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  url: string,
  body: Record<string, unknown>,
): Promise<number> {
  // The in-memory per-instance limits are not what is under test.
  clearRateLimitState();
  let status = 200;
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      status = code;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  await handler(makeReq(url, body), res);
  return status;
}

const requestCode = () => call(requestHandler, '/api/auth-request', { email: EMAIL });
const verify = (code: string) =>
  call(verifyHandler, '/api/auth-verify', { email: EMAIL, code });

async function row() {
  const [r] = await db
    .select({
      id: users.id,
      hash: users.magicLinkHash,
      expires: users.magicLinkExpires,
      failures: users.magicLinkFailuresSinceAuth,
    })
    .from(users)
    .where(eq(users.email, EMAIL));
  return r!;
}

/** Pretend the current code was issued `ms` ago. */
async function issuedAgo(ms: number) {
  await db
    .update(users)
    .set({
      magicLinkExpires: new Date(Date.now() - ms + MAGIC_LINK_CODE_TTL_MS),
    })
    .where(eq(users.email, EMAIL));
}

/** Request a code and report whether a new one was issued. */
async function issues(): Promise<boolean> {
  // The first request creates the account row.
  const [existing] = await db
    .select({ hash: users.magicLinkHash })
    .from(users)
    .where(eq(users.email, EMAIL));
  const before = existing?.hash ?? null;
  expect(await requestCode()).toBe(200);
  const after = (await row()).hash;
  return after !== null && after !== before;
}

async function wrongGuesses(n: number) {
  for (let i = 0; i < n; i++) expect(await verify(String(900_000 + i))).toBe(401);
}

describe('sign-in code issue cooldown', () => {
  it('keeps the 60 s cooldown when there are no wrong guesses', async () => {
    expect(await issues()).toBe(true);
    await issuedAgo(30_000);
    expect(await issues()).toBe(false);
    await issuedAgo(MINUTE + 1_000);
    expect(await issues()).toBe(true);
  });

  it('doubles the cooldown after a burned code', async () => {
    expect(await issues()).toBe(true);
    await wrongGuesses(MAX_MAGIC_LINK_FAILURES);
    expect((await row()).hash).toBeNull();
    expect((await row()).failures).toBe(MAX_MAGIC_LINK_FAILURES);

    await issuedAgo(MINUTE + 1_000);
    expect(await issues()).toBe(false);
    await issuedAgo(2 * MINUTE + 1_000);
    expect(await issues()).toBe(true);
  });

  it('counts wrong guesses across codes, so stopping short of a lockout does not dodge it', async () => {
    expect(await issues()).toBe(true);
    await wrongGuesses(MAX_MAGIC_LINK_FAILURES - 1);
    await issuedAgo(MINUTE + 1_000);
    expect(await issues()).toBe(true);

    // One more wrong guess against the fresh code crosses the threshold.
    await wrongGuesses(1);
    expect((await row()).failures).toBe(MAX_MAGIC_LINK_FAILURES);
    await issuedAgo(MINUTE + 1_000);
    expect(await issues()).toBe(false);
  });

  it('does not let code expiry shortcut a cooldown longer than the TTL', async () => {
    expect(await issues()).toBe(true);
    // Six burned codes: the cooldown has reached its 60-minute cap.
    await db
      .update(users)
      .set({
        magicLinkHash: null,
        magicLinkFailuresSinceAuth: 6 * MAX_MAGIC_LINK_FAILURES,
      })
      .where(eq(users.email, EMAIL));

    await issuedAgo(MAGIC_LINK_CODE_TTL_MS + 5 * MINUTE);
    expect(await issues()).toBe(false);
    await issuedAgo(60 * MINUTE + 1_000);
    expect(await issues()).toBe(true);
  });

  it('resets after a successful sign-in', async () => {
    expect(await issues()).toBe(true);
    await wrongGuesses(MAX_MAGIC_LINK_FAILURES - 1);

    // Swap in a known code so the test can sign in with it.
    await db
      .update(users)
      .set({ magicLinkHash: hashMagicLinkCode('123456') })
      .where(eq(users.email, EMAIL));
    expect(await verify('123456')).toBe(200);
    expect((await row()).failures).toBe(0);

    expect(await issues()).toBe(true);
  });
});
