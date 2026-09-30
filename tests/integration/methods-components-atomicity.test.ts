/**
 * PATCH /api/methods atomicity for the component-set replace (issue #1076,
 * item 5).
 *
 * `replaceComponents` used to run its DELETE and its (re)INSERT as two
 * separate auto-commit statements. If the INSERT failed — e.g. one of the
 * submitted rows names a `drugId` that doesn't exist, tripping the FK — the
 * DELETE had already committed, leaving the method with zero components
 * until someone noticed and re-saved. Wrapping both statements in one
 * `runInPoolTransaction` unit means a failing INSERT rolls the DELETE back
 * too, so the request fails cleanly (500) with the method's previous
 * component set intact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/methods.js';
import { analyticalMethodComponents, analyticalMethods } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authMock.mockReset();
});

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function patchRequest(id: number, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = `/api/methods?id=${id}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

async function seedMethod(componentDrugId: number): Promise<number> {
  const [method] = await db
    .insert(analyticalMethods)
    .values({ code: 'M1', name: 'Screening' })
    .returning({ id: analyticalMethods.id });
  await db
    .insert(analyticalMethodComponents)
    .values({ methodId: method!.id, drugId: componentDrugId });
  return method!.id;
}

async function componentDrugIds(methodId: number): Promise<number[]> {
  const rows = await db
    .select({ drugId: analyticalMethodComponents.drugId })
    .from(analyticalMethodComponents)
    .where(eq(analyticalMethodComponents.methodId, methodId));
  return rows.map((r) => r.drugId).sort((a, b) => a - b);
}

describe('PATCH /api/methods — component replace is atomic (#1076 item 5)', () => {
  it('rolls back the delete when the insert fails, keeping the prior component set', async () => {
    authMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const drugA = await seedDrug(db, { slug: 'drug-a' });
    const methodId = await seedMethod(drugA);
    expect(await componentDrugIds(methodId)).toEqual([drugA]);

    const nonexistentDrugId = 999_999;
    const { res, state } = createResponse();
    await handler(
      patchRequest(methodId, {
        components: [{ drugId: nonexistentDrugId }],
      }),
      res,
    );

    // The FK violation on the bogus drugId surfaces as an unhandled 500 …
    expect(state.statusCode).toBe(500);
    // … but the method's ORIGINAL component (drug A) must still be there:
    // a non-atomic delete-then-insert would have committed the delete and
    // left the method with zero components.
    expect(await componentDrugIds(methodId)).toEqual([drugA]);
  });

  it('still replaces the component set on an ordinary successful edit', async () => {
    authMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const drugA = await seedDrug(db, { slug: 'drug-a' });
    const drugB = await seedDrug(db, { slug: 'drug-b' });
    const methodId = await seedMethod(drugA);

    const { res, state } = createResponse();
    await handler(
      patchRequest(methodId, {
        components: [{ drugId: drugB, lor: 0.1 }],
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(await componentDrugIds(methodId)).toEqual([drugB]);
  });
});
