import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { getDbMock, authMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/pending-edits.ts';
import { citations } from '../../db/schema.ts';
import { CLINICAL_CASE_SAFETY_NOTICE } from '../../api/_lib/schemas.ts';

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
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

// Minimal valid clinical-case content — mirrors validCaseContent() in
// tests/lib/clinicalCaseSchema.test.ts so the request clears schema validation
// and reaches the cite-a-source / reference-existence gate under test.
function validCaseContent() {
  const option = (id: string, correct: boolean) => ({
    id,
    text: `alternativ ${id}`,
    isCorrect: correct,
    explanation: `forklaring for ${id} som er minst tjue tegn lang`,
  });
  const question = (n: number) => ({
    stem: `Klinisk resonnement-spørsmål ${n}?`,
    format: 'single_best' as const,
    category: 'reasoned' as const,
    options: [option('a', true), option('b', false), option('c', false)],
    difficulty: 'advanced_lis' as const,
    concepts: ['drug_clearance'],
    sourceSupport: 'Retningslinje, avsnitt 3.',
    cognitiveSkill: 'clinical_reasoning' as const,
  });
  return {
    safetyNotice: CLINICAL_CASE_SAFETY_NOTICE,
    scenario:
      'En fiktiv pasient presenterer med symptomer som krever resonnering rundt dosering.',
    prerequisites: [
      {
        concept: 'drug_clearance',
        level: 'essential' as const,
        why: 'Trengs for å vurdere eksponering.',
      },
    ],
    objectives: ['Anvende retningslinjen på et realistisk scenario.'],
    questions: Array.from({ length: 6 }, (_unused, i) => question(i + 1)),
  };
}

function caseBody(referenceIds: number[]) {
  return {
    editType: 'clinical_case',
    referenceIds,
    proposedMeta: {
      title: 'En klinisk case om dosering',
      slug: 'klinisk-case-dosering',
      difficulty: 'advanced_lis',
      domains: ['pharmacokinetics'],
      requiresExpertReview: true,
    },
    proposedValue: validCaseContent(),
  };
}

// db mock whose citations-existence query (select().from(citations).where())
// resolves to `citationRows`; every other select chain resolves to [] (and is
// .limit()-chainable), and insert().values().returning() -> [{ id }].
let citationRows: { id: number }[] = [];
function mockDb() {
  const returningFn = vi.fn().mockResolvedValue([{ id: 77 }]);
  const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });

  const limitFn = vi.fn().mockResolvedValue([]);
  const whereResult: Promise<never[]> & { limit: typeof limitFn } = Object.assign(
    Promise.resolve([]),
    { limit: limitFn },
  );
  const innerWhereFn = vi.fn().mockReturnValue(whereResult);
  const leftJoinFn = vi.fn().mockReturnValue({ where: innerWhereFn });
  // The reference-existence query reads citationRows at call time.
  const citationWhereFn = vi.fn(() => Promise.resolve(citationRows));
  const fromFn = vi.fn((table: unknown) =>
    table === citations
      ? { where: citationWhereFn }
      : { where: innerWhereFn, leftJoin: leftJoinFn },
  );
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const deleteWhereFn = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([]),
  });
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhereFn });

  const db = { insert: insertFn, select: selectFn, delete: deleteFn };
  getDbMock.mockReturnValue(db);
  return { db, insertFn };
}

describe('POST /api/pending-edits clinical_case reference gate', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    authMock.mockReset();
    citationRows = [];
    authMock.mockResolvedValue({ userId: 5, id: 5, role: 'contributor' });
  });

  it('rejects a case citing a reference that does not resolve to a citation', async () => {
    mockDb();
    // Only one of the two cited ids exists -> length mismatch -> 400.
    citationRows = [{ id: 12 }];
    const { res, state } = createResponse();

    await handler(createJsonRequest(caseBody([12, 34])), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'clinical_case_unknown_reference',
    });
  });

  it('rejects a case with no cited source (missing_source, before existence check)', async () => {
    mockDb();
    const { res, state } = createResponse();

    // Omit referenceIds entirely so the request clears schema validation
    // (the array is optional) and reaches the route-level cite-a-source gate.
    const { referenceIds: _omit, ...noRefBody } = caseBody([12]);
    void _omit;
    await handler(createJsonRequest(noRefBody), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'clinical_case_missing_source',
    });
  });

  it('accepts a case when every cited reference resolves', async () => {
    const { db } = mockDb();
    citationRows = [{ id: 12 }, { id: 34 }];
    const { res, state } = createResponse();

    await handler(createJsonRequest(caseBody([12, 34])), res);

    expect(state.statusCode).toBe(201);
    expect(db.insert).toHaveBeenCalled();
  });
});
