import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { getDbMock, authMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/learn-attempts.ts';

function createResponse() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = headers ?? {};
        return res;
      },
    ),
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
  req.url = '/api/learn-attempts';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

// A stored unit with 2 questions: Q0 single-best (a correct), Q1 select-all
// (a+b correct). content is read back as already-validated jsonb.
const unitContent = {
  sourceCard: {
    whyItMatters: 'x',
    sourceStatus: ['foundational'],
    estimatedReadingMinutes: 10,
  },
  prerequisites: [],
  preReadingPrompts: ['a', 'b', 'c'],
  objectives: ['o'],
  questions: [
    {
      stem: 'q0',
      format: 'single_best',
      category: 'factual',
      difficulty: 'foundational',
      concepts: ['clearance'],
      sourceSupport: 's',
      options: [
        {
          id: 'a',
          text: 'A',
          isCorrect: true,
          explanation: 'aaaaaaaaaaaaaaaaaaaa',
        },
        {
          id: 'b',
          text: 'B',
          isCorrect: false,
          explanation: 'bbbbbbbbbbbbbbbbbbbb',
        },
      ],
    },
    {
      stem: 'q1',
      format: 'select_all',
      category: 'reasoned',
      difficulty: 'board',
      cognitiveSkill: 'statistical_reasoning',
      concepts: ['stats'],
      sourceSupport: 's',
      options: [
        {
          id: 'a',
          text: 'A',
          isCorrect: true,
          explanation: 'aaaaaaaaaaaaaaaaaaaa',
        },
        {
          id: 'b',
          text: 'B',
          isCorrect: true,
          explanation: 'bbbbbbbbbbbbbbbbbbbb',
        },
        {
          id: 'c',
          text: 'C',
          isCorrect: false,
          explanation: 'cccccccccccccccccccc',
        },
      ],
    },
  ],
};

function makeDb(opts: { unitFound: boolean; prev?: unknown }) {
  const selectResults = [
    opts.unitFound ? [{ content: unitContent }] : [],
    opts.prev ? [opts.prev] : [],
  ];
  let selCall = 0;
  const limit = vi.fn(() => Promise.resolve(selectResults[selCall++] ?? []));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const insertValues = vi.fn(() => {
    const p: Promise<void> & { onConflictDoUpdate?: ReturnType<typeof vi.fn> } =
      Promise.resolve();
    p.onConflictDoUpdate = vi.fn(() => Promise.resolve());
    return p;
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  const db = { select, insert };
  getDbMock.mockReturnValue(db);
  return { db, insertValues };
}

describe('POST /api/learn-attempts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      userId: 5,
      role: 'authenticated',
      groups: [{ id: 1, slug: 'kinetix-learn', name: 'Kinetix Learn' }],
    });
  });

  it('grades server-side, logs attempts, upserts progress, returns the score', async () => {
    const { insertValues } = makeDb({ unitFound: true });
    const { res, state } = createResponse();

    await handler(
      createJsonRequest({
        unitId: 1,
        mode: 'submit_all',
        answers: { 0: ['a'], 1: ['a'] },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    // Q0 correct (exact), Q1 partial -> wrong => 50%
    expect(body.scorePct).toBe(50);
    expect(body.status).toBe('completed');
    expect(typeof body.nextReviewAt).toBe('string');

    // First insert = attempt rows; correctness comes from the server, not the client.
    const attemptRows = insertValues.mock.calls[0]![0] as Array<{
      questionIndex: number;
      correct: boolean;
      cognitiveSkill: string | null;
      userId: number;
    }>;
    expect(attemptRows).toHaveLength(2);
    expect(attemptRows.find((r) => r.questionIndex === 0)!.correct).toBe(true);
    expect(attemptRows.find((r) => r.questionIndex === 1)!.correct).toBe(false);
    expect(attemptRows.find((r) => r.questionIndex === 1)!.cognitiveSkill).toBe(
      'statistical_reasoning',
    );
    expect(attemptRows.every((r) => r.userId === 5)).toBe(true);
    // Second insert = the progress upsert.
    expect(insertValues).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValue(null);
    makeDb({ unitFound: true });
    const { res, state } = createResponse();
    await handler(
      createJsonRequest({
        unitId: 1,
        mode: 'submit_all',
        answers: { 0: ['a'] },
      }),
      res,
    );
    expect(state.statusCode).toBe(401);
  });

  it('returns 403 for signed-in users outside the Learn group', async () => {
    authMock.mockResolvedValue({
      userId: 6,
      role: 'authenticated',
      groups: [],
    });
    makeDb({ unitFound: true });
    const { res, state } = createResponse();
    await handler(
      createJsonRequest({
        unitId: 1,
        mode: 'submit_all',
        answers: { 0: ['a'] },
      }),
      res,
    );
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('kinetix_learn_access_required');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown/unpublished unit', async () => {
    makeDb({ unitFound: false });
    const { res, state } = createResponse();
    await handler(
      createJsonRequest({
        unitId: 999,
        mode: 'submit_all',
        answers: { 0: ['a'] },
      }),
      res,
    );
    expect(state.statusCode).toBe(404);
  });
});
