import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { getDbMock, authMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../api/learn-progress.ts';

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
  req.url = '/api/learn-progress';
  req.headers = { host: 'localhost' };
  return req;
}

// Each select() consumes the next queued result; the where() result is a
// thenable that also exposes .limit() so both await styles work.
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

describe('GET /api/learn-progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      userId: 5,
      role: 'authenticated',
      groups: [{ id: 1, slug: 'kinetix-learn', name: 'Kinetix Learn' }],
    });
  });

  it('returns units, competence, and due count for an authed user', async () => {
    const select = makeDb([
      // attempts
      [
        {
          category: 'reasoned',
          cognitiveSkill: 'statistical_reasoning',
          correct: true,
          mode: 'submit_all',
        },
        {
          category: 'reasoned',
          cognitiveSkill: 'statistical_reasoning',
          correct: false,
          mode: 'submit_all',
        },
      ],
      // progress rows
      [
        {
          unitId: 1,
          attempts: 2,
          bestScorePct: 80,
          lastScorePct: 50,
          status: 'completed',
          nextReviewAt: new Date('2026-06-20'),
        },
        {
          unitId: 2,
          attempts: 1,
          bestScorePct: 90,
          lastScorePct: 90,
          status: 'mastered',
          nextReviewAt: new Date('2099-01-01'),
        },
        {
          unitId: 3,
          attempts: 0,
          bestScorePct: 0,
          lastScorePct: 0,
          status: 'in_progress',
          nextReviewAt: null,
        },
      ],
    ]);
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.units).toHaveLength(3);
    expect(body.units[0].status).toBe('completed');
    expect(body.competence.dimensions).toHaveLength(4);
    const stat = body.competence.dimensions.find(
      (d: { dimension: string }) => d.dimension === 'statistical_reasoning',
    );
    expect(stat.accuracyPct).toBe(50);
    expect(body.dueReviewCount).toBe(1);
    expect(select).toHaveBeenCalledTimes(2);
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
