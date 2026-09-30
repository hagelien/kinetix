import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { getDbMock, authMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/learn-my-path.ts';

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

function createGetRequest(): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = '/api/learn-my-path';
  req.headers = { host: 'localhost' };
  return req;
}

const unitContent = {
  sourceCard: {
    whyItMatters: 'x',
    sourceStatus: ['foundational'],
    estimatedReadingMinutes: 10,
  },
  prerequisites: [{ concept: 'clearance', level: 'essential', why: 'w' }],
  preReadingPrompts: ['a', 'b', 'c'],
  objectives: ['o'],
  questions: [
    {
      stem: 'q',
      format: 'single_best',
      category: 'reasoned',
      difficulty: 'foundational',
      sourceSupport: 's',
      concepts: ['clearance'],
      cognitiveSkill: 'statistical_reasoning',
      options: [],
    },
  ],
};

function makeDb(queue: unknown[][]) {
  let call = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        const rows = queue[call++] ?? [];
        const p = Promise.resolve(rows) as Promise<unknown[]> & {
          limit?: () => Promise<unknown[]>;
        };
        p.limit = () => Promise.resolve(rows);
        return p;
      },
    }),
  }));
  getDbMock.mockReturnValue({ select });
  return select;
}

describe('GET /api/learn-my-path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      userId: 5,
      role: 'authenticated',
      groups: [{ id: 1, slug: 'kinetix-learn', name: 'Kinetix Learn' }],
    });
  });

  it('returns ranked recommendations with reasons and prerequisite warnings', async () => {
    const select = makeDb([
      // units (with content)
      [
        {
          id: 1,
          title: 'Clearance',
          difficulty: 'foundational',
          domains: ['pharmacokinetics'],
          content: unitContent,
        },
      ],
      // attempts (none yet -> no evidenced concepts)
      [],
      // progress (none)
      [],
    ]);
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.recommendations).toHaveLength(1);
    const rec = body.recommendations[0];
    expect(rec.unitId).toBe(1);
    expect(rec.title).toBe('Clearance');
    // No attempts evidencing 'clearance' yet -> soft prerequisite warning.
    expect(rec.prerequisiteWarning).toEqual(['clearance']);
    expect(typeof rec.reasonCode).toBe('string');
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('dispatches independent ranking reads before awaiting results', async () => {
    let resolveUnits: (rows: unknown[]) => void = () => {};
    const unitsPromise = new Promise<unknown[]>((resolve) => {
      resolveUnits = resolve;
    });
    const select = vi.fn(() => ({
      from: () => ({
        where: () => {
          const rows =
            select.mock.calls.length === 1 ? unitsPromise : Promise.resolve([]);
          const p = rows as Promise<unknown[]> & {
            limit?: () => Promise<unknown[]>;
          };
          p.limit = () => rows;
          return p;
        },
      }),
    }));
    getDbMock.mockReturnValue({ select });
    const { res } = createResponse();

    const pending = handler(createGetRequest(), res);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(select).toHaveBeenCalledTimes(3);
    resolveUnits([]);
    await pending;
  });

  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValue(null);
    makeDb([]);
    const { res, state } = createResponse();
    await handler(createGetRequest(), res);
    expect(state.statusCode).toBe(401);
  });

  it('returns 403 for signed-in users outside the Learn group', async () => {
    authMock.mockResolvedValue({
      userId: 6,
      role: 'authenticated',
      groups: [],
    });
    makeDb([]);
    const { res, state } = createResponse();
    await handler(createGetRequest(), res);
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('kinetix_learn_access_required');
    expect(getDbMock).not.toHaveBeenCalled();
  });
});
