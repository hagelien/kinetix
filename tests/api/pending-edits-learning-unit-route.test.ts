import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { getDbMock, authMock, assertRefsMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
  assertRefsMock: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));
vi.mock('../../api/_lib/pending-edits-helpers.js', async (orig) => ({
  ...(await orig()),
  assertReferencesJudged: assertRefsMock,
}));

import handler from '../../api/pending-edits.ts';

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string; headers: Record<string, unknown> };
} {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function createJsonRequest(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/pending-edits';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

// Minimal valid learningUnitContent — mirrors validUnitContent() in
// tests/lib/learningUnitSchema.test.ts so the request clears schema validation
// and actually reaches the reference-gate code under test.
function validUnitContent() {
  const option = (id: string, correct: boolean) => ({
    id,
    text: `alternativ ${id}`,
    isCorrect: correct,
    explanation: `forklaring for ${id} som er minst tjue tegn lang`,
  });
  const question = (n: number) => ({
    stem: `Spørsmål ${n} om kilden?`,
    format: 'single_best' as const,
    category: 'factual' as const,
    options: [option('a', true), option('b', false), option('c', false), option('d', false)],
    difficulty: 'foundational' as const,
    concepts: ['drug_clearance'],
    sourceSupport: 'Avsnitt 2 i kilden.',
  });
  return {
    sourceCard: {
      whyItMatters: 'Denne kilden forankrer kjernebegrepet clearance.',
      sourceStatus: ['foundational'],
      estimatedReadingMinutes: 20,
    },
    prerequisites: [
      { concept: 'drug_clearance', level: 'essential' as const, why: 'Trengs for eksponering.' },
    ],
    preReadingPrompts: [
      'Legg merke til hvordan eksponering defineres.',
      'Se om komparatoren støtter konklusjonen.',
      'Vurder om endepunktet er klinisk meningsfullt.',
    ],
    objectives: ['Forstå clearance i kontekst av kilden.'],
    questions: Array.from({ length: 10 }, (_unused, i) => question(i + 1)),
  };
}

function unitBody(refId: number) {
  return {
    editType: 'learning_unit',
    referenceIds: [refId],
    proposedMeta: {
      title: 'Kjernebegreper i clearance',
      slug: 'kjernebegreper-clearance',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
    },
    proposedValue: validUnitContent(),
  };
}

// Minimal db mock: insert().values().returning() -> [{ id }]
// Plus the helpers that the handler calls after a successful insert.
// buildEnrichmentMaps uses: select().from().where().limit() and
// select().from().leftJoin().where(), as well as summariseVerificationsForTargets
// which also calls db. We stub all these chains to return empty arrays.
function mockDb() {
  const returningFn = vi.fn().mockResolvedValue([{ id: 77 }]);
  const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });

  // Chainable select stub that handles:
  //   .from().where().limit()  — enrichment queries
  //   .from().leftJoin().where() — users join with agents
  //   .from().where()           — summariseVerificationsForTargets (directly awaited)
  // Make .where() both awaitable (thenable returning []) and chainable (.limit()).
  const limitFn = vi.fn().mockResolvedValue([]);
  // whereResult must be a thenable (Promise-like) so `await db.select()...where()` works,
  // AND expose .limit() for callers that chain .limit() after .where().
  const whereResult: Promise<never[]> & { limit: typeof limitFn } = Object.assign(
    Promise.resolve([]),
    { limit: limitFn },
  );
  const innerWhereFn = vi.fn().mockReturnValue(whereResult);
  const leftJoinFn = vi.fn().mockReturnValue({ where: innerWhereFn });
  const fromFn = vi.fn().mockReturnValue({ where: innerWhereFn, leftJoin: leftJoinFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  // clearVerificationsForTarget uses delete().where().returning().
  const deleteReturningFn = vi.fn().mockResolvedValue([]);
  const deleteWhereFn = vi.fn().mockReturnValue({ returning: deleteReturningFn });
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhereFn });

  // summariseVerificationsForTargets / recordImplicitAgentApproval also issue
  // inserts; the second insert mock call gets the same stub.
  const db = {
    insert: insertFn,
    select: selectFn,
    delete: deleteFn,
  };
  getDbMock.mockReturnValue(db);
  return { db, insertFn, valuesFn, returningFn };
}

describe('POST /api/pending-edits learning_unit', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    authMock.mockReset();
    assertRefsMock.mockReset();
    authMock.mockResolvedValue({ userId: 5, id: 5, role: 'contributor' });
  });

  it('rejects a unit whose source has no read-in-full review', async () => {
    mockDb();
    assertRefsMock.mockRejectedValue(
      Object.assign(new Error('unreviewed'), { code: 'reference_unreviewed' }),
    );
    const { res, state } = createResponse();

    await handler(createJsonRequest(unitBody(42)), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'learning_unit_unreviewed_source',
    });
  });

  it('accepts a unit anchored to a reviewed citation', async () => {
    const { db, insertFn } = mockDb();
    assertRefsMock.mockResolvedValue(undefined);
    const { res, state } = createResponse();

    await handler(createJsonRequest(unitBody(42)), res);

    expect(state.statusCode).toBe(201);
    expect(db.insert).toHaveBeenCalled();
  });
});
