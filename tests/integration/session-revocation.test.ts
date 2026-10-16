/**
 * Who an allowlist removal and the admin force-logout revoke, against real
 * SQL. Bumping `users.session_generation` kills session tokens minted under an
 * older generation (api/_lib/auth.ts; that check is unit-tested in src/lib/authSession.test.ts,
 * since PGlite has no `db.batch` for the real session lookup). Here the
 * caller is mocked and the test reads which rows the admin routes stamp.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
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

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { allowedEmailDomains, allowedEmails, users } from '../../db/schema.js';
import adminHandler from '../../api/admin.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;
let adminId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
  adminId = await seedUser(db, {
    email: 'admin@admins.example',
    username: 'admin',
    role: 'admin',
  });
  getUserFromRequestMock.mockResolvedValue({ userId: adminId, role: 'admin' });
});

async function admin(method: string, url: string): Promise<number> {
  let status = 0;
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      status = code;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  const req = {
    method,
    url,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;
  await adminHandler(req, res);
  return status;
}

async function seedMember(email: string) {
  // Each member holds an unredeemed sign-in code, so the tests can check that
  // revocation voids it.
  return seedUser(db, {
    email,
    username: email.split('@')[0]!,
    role: 'contributor',
    magicLinkHash: 'v2:' + 'a'.repeat(64),
    magicLinkExpires: new Date(Date.now() + 10 * 60_000),
  });
}

async function codeVoided(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ hash: users.magicLinkHash })
    .from(users)
    .where(eq(users.id, userId));
  return row!.hash === null;
}

async function revoked(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ generation: users.sessionGeneration })
    .from(users)
    .where(eq(users.id, userId));
  return row!.generation > 0;
}

describe('session revocation targets', () => {
  it('revokes a person removed from the email allowlist', async () => {
    const [entry] = await db
      .insert(allowedEmails)
      .values({ email: 'gone@else.example' })
      .returning({ id: allowedEmails.id });
    const userId = await seedMember('gone@else.example');
    const bystander = await seedMember('other@else.example');

    expect(await admin('DELETE', `/api/admin?resource=allowed-emails&id=${entry!.id}`)).toBe(200);

    expect(await revoked(userId)).toBe(true);
    expect(await codeVoided(userId)).toBe(true);
    expect(await revoked(bystander)).toBe(false);
    expect(await codeVoided(bystander)).toBe(false);
  });

  it('leaves a person still allowed through their domain', async () => {
    await db.insert(allowedEmailDomains).values({ domain: 'org.example' });
    const [entry] = await db
      .insert(allowedEmails)
      .values({ email: 'stays@org.example' })
      .returning({ id: allowedEmails.id });
    const userId = await seedMember('stays@org.example');

    await admin('DELETE', `/api/admin?resource=allowed-emails&id=${entry!.id}`);

    expect(await revoked(userId)).toBe(false);
  });

  it('revokes everyone under a removed domain but the acting admin, and spares the separately listed', async () => {
    const [entry] = await db
      .insert(allowedEmailDomains)
      .values({ domain: 'admins.example' })
      .returning({ id: allowedEmailDomains.id });
    await db.insert(allowedEmails).values({ email: 'listed@admins.example' });
    const colleague = await seedMember('colleague@admins.example');
    const listed = await seedMember('listed@admins.example');

    expect(await admin('DELETE', `/api/admin?resource=allowed-domains&id=${entry!.id}`)).toBe(200);

    expect(await revoked(colleague)).toBe(true);
    expect(await revoked(listed)).toBe(false);
    expect(await revoked(adminId)).toBe(false);
  });

  it('force-logs a user out on request', async () => {
    const userId = await seedMember('victim@else.example');

    expect(
      await admin('POST', `/api/admin?resource=users&action=revoke-sessions&id=${userId}`),
    ).toBe(200);
    expect(await revoked(userId)).toBe(true);
    expect(await codeVoided(userId)).toBe(true);
    expect(
      await admin('POST', `/api/admin?resource=users&action=revoke-sessions&id=999999`),
    ).toBe(404);
  });

  it('refuses revoke-sessions to a non-admin', async () => {
    const userId = await seedMember('member@else.example');
    getUserFromRequestMock.mockResolvedValue({ userId, role: 'editor' });

    expect(
      await admin('POST', `/api/admin?resource=users&action=revoke-sessions&id=${userId}`),
    ).toBe(403);
    expect(await revoked(userId)).toBe(false);
  });
});
