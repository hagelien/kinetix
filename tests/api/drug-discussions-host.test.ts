import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  recordImplicitAgentApprovalMock,
  fireAgentHookMock,
  summariseApprovalsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  recordImplicitAgentApprovalMock: vi.fn(),
  fireAgentHookMock: vi.fn(),
  summariseApprovalsMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  recordImplicitAgentApproval: recordImplicitAgentApprovalMock,
}));
vi.mock('../../api/_lib/agentHooks.js', () => ({
  fireAgentHookForActorAsync: fireAgentHookMock,
}));
vi.mock('../../api/_lib/approvals.js', () => ({
  summariseApprovalsForTargets: summariseApprovalsMock,
}));

import handler from '../../api/drug-discussions.ts';

function createRequest(
  query: string,
  method: 'GET' | 'POST' = 'GET',
  body: Record<string, unknown> = { body: 'hello' },
): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = (
    method === 'POST' ? Readable.from([raw]) : Readable.from([])
  ) as IncomingMessage;
  req.method = method;
  req.url = `/api/drug-discussions?${query}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(raw.length),
  };
  return req;
}

function createResponse() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, string | number | readonly string[]>,
  };
  const res = {
    headersSent: false,
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    writeHead: vi.fn(
      (
        statusCode: number,
        headers?: Record<string, string | number | readonly string[]>,
      ) => {
        state.statusCode = statusCode;
        if (headers) Object.assign(state.headers, headers);
        return res;
      },
    ),
    setHeader: vi.fn(
      (name: string, value: string | number | readonly string[]) => {
        state.headers[name] = value;
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

/** A chainable select() stub that resolves to `rows`. */
function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

function mockSelectDb(rows: unknown[], pageStatus?: string) {
  const select = vi.fn();
  if (pageStatus) {
    select
      .mockReturnValueOnce(selectChain([{ status: pageStatus }]))
      .mockReturnValueOnce(selectChain(rows));
  } else {
    select.mockReturnValue(selectChain(rows));
  }
  getDbMock.mockReturnValue({ select });
  return select;
}

function mockInsertDb(
  row: unknown,
  pageStatus?: string,
  parentRows?: unknown[],
) {
  const chain = {
    values: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve([row])),
  };
  const db: Record<string, unknown> = { insert: vi.fn(() => chain) };
  if (pageStatus) {
    db.select = vi.fn(() => selectChain([{ status: pageStatus }]));
  } else if (parentRows) {
    db.select = vi.fn(() => selectChain(parentRows));
  }
  getDbMock.mockReturnValue(db);
  return chain;
}

describe('/api/drug-discussions host validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue(null);
    summariseApprovalsMock.mockResolvedValue(new Map());
  });

  it('rejects neither drugId nor wikiPageId', async () => {
    const { res, state } = createResponse();
    await handler(createRequest('parameter=fact:abc'), res);
    expect(state.statusCode).toBe(400);
  });

  it('rejects both drugId and wikiPageId', async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest('drugId=1&wikiPageId=2&parameter=fact:abc'),
      res,
    );
    expect(state.statusCode).toBe(400);
  });

  it('rejects an empty parameter on a drug thread', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const { res, state } = createResponse();
      await handler(createRequest('drugId=9&parameter=', method), res);
      expect(state.statusCode).toBe(400);
    }
  });

  it('rejects a wikiPageId thread without a fact parameter', async () => {
    const { res, state } = createResponse();
    await handler(createRequest('wikiPageId=5'), res);
    expect(state.statusCode).toBe(400);
  });

  it('lists a topic-page fact thread keyed by wikiPageId', async () => {
    mockSelectDb([], 'published');
    const { res, state } = createResponse();
    await handler(createRequest('wikiPageId=5&parameter=fact:abc'), res);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ discussions: [] });
  });

  it('hides draft topic-page fact threads from anonymous callers', async () => {
    const select = mockSelectDb([], 'draft');
    const { res, state } = createResponse();
    await handler(createRequest('wikiPageId=5&parameter=fact:abc'), res);
    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toEqual({
      error: 'Page not found',
      code: 'wiki_page_not_found',
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(summariseApprovalsMock).not.toHaveBeenCalled();
  });

  it('allows editors to list draft topic-page fact threads without caching', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 9, role: 'editor' });
    mockSelectDb([], 'draft');
    const { res, state } = createResponse();
    await handler(createRequest('wikiPageId=5&parameter=fact:abc'), res);
    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('inserts a topic-page fact comment with wikiPageId and null drugId', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    const chain = mockInsertDb(
      { id: 1, wikiPageId: 5, drugId: null },
      'published',
    );
    const { res, state } = createResponse();
    await handler(
      createRequest('wikiPageId=5&parameter=fact:abc', 'POST'),
      res,
    );
    expect(state.statusCode).toBe(201);
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        drugId: null,
        wikiPageId: 5,
        parameter: 'fact:abc',
      }),
    );
    // Topic-page comments have no drug, so the drug-scoped agent hook must
    // not fire; the implicit-approval bookkeeping still runs.
    expect(fireAgentHookMock).not.toHaveBeenCalled();
    expect(recordImplicitAgentApprovalMock).toHaveBeenCalled();
  });

  it('rejects contributor comments against draft topic-page facts', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    const chain = mockInsertDb({ id: 1, wikiPageId: 5, drugId: null }, 'draft');
    const { res, state } = createResponse();
    await handler(
      createRequest('wikiPageId=5&parameter=fact:abc', 'POST'),
      res,
    );
    expect(state.statusCode).toBe(404);
    expect(chain.values).not.toHaveBeenCalled();
    expect(recordImplicitAgentApprovalMock).not.toHaveBeenCalled();
  });

  it('still fires the agent hook for a drug-scoped comment', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    mockInsertDb({ id: 2, drugId: 9, wikiPageId: null });
    const { res, state } = createResponse();
    await handler(createRequest('drugId=9&parameter=fact:abc', 'POST'), res);
    expect(state.statusCode).toBe(201);
    expect(fireAgentHookMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ kind: 'comment_posted', drugId: 9 }),
    );
  });

  it('rejects a reply whose parent is not in the same thread', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    const chain = mockInsertDb(
      { id: 3, drugId: 9, wikiPageId: null },
      undefined,
      [],
    );
    const { res, state } = createResponse();
    await handler(
      createRequest('drugId=9&parameter=fact:abc', 'POST', {
        body: 'hi',
        parentId: 41,
      }),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(chain.values).not.toHaveBeenCalled();
    expect(recordImplicitAgentApprovalMock).not.toHaveBeenCalled();
  });

  it('accepts a reply whose parent is in the same thread', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    const chain = mockInsertDb(
      { id: 3, drugId: 9, wikiPageId: null },
      undefined,
      [{ id: 41 }],
    );
    const { res, state } = createResponse();
    await handler(
      createRequest('drugId=9&parameter=fact:abc', 'POST', {
        body: 'hi',
        parentId: 41,
      }),
      res,
    );
    expect(state.statusCode).toBe(201);
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 41 }),
    );
  });
});
