import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Creating a monograph with a `newDrug` payload creates the catalog drug as a
 * side effect. Whole-page submission and drug creation are separate
 * capabilities, so delegating the former must not hand out the latter through
 * this side door — and the same holds when a `wiki_new` draft carrying
 * `newDrug` is approved.
 */

const { getUserFromRequestMock, getDbMock, callerCanMock, insertDrugMock } =
  vi.hoisted(() => ({
    getUserFromRequestMock: vi.fn(),
    getDbMock: vi.fn(),
    callerCanMock: vi.fn(),
    insertDrugMock: vi.fn(),
  }));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getConfigDb: getDbMock,
  runInPoolTransaction: vi.fn(),
  withDbRetry: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
  requestHasAuthCookie: () => true,
}));
vi.mock('../../api/_lib/permissions-store.js', () => ({
  callerCan: callerCanMock,
  loadPermissionOverrides: async () => ({}),
  // The real implementation delegates to callerCan; mirror that so the mock
  // stays honest about which capability the route is asking for.
  callerCanReadWikiPage: async (
    status: string | null,
    auth: { role: string } | null,
  ) =>
    status === 'published'
      ? true
      : status === 'draft'
        ? callerCanMock(auth?.role, 'wiki.draft.read')
        : false,
}));
vi.mock('../../api/_lib/drugs-helpers.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, insertDrug: insertDrugMock };
});

import handler from '../../api/wiki/pages.ts';

function createRequest(body: unknown): IncomingMessage {
  const req = Readable.from([
    JSON.stringify(body),
  ]) as unknown as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = 'POST';
  req.url = '/api/wiki/pages';
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

const NEW_DRUG_PAGE = {
  title: 'Kokain',
  content: { type: 'doc', content: [] },
  pageType: 'drug_monograph',
  newDrug: { names: { nb: 'Kokain' }, pubchemCid: 446220 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getDbMock.mockReturnValue({});
  getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'editor' });
});

/**
 * A stub `select` whose chain also accepts `.innerJoin()`.
 *
 * `PUT` now asks `isActiveAgentUser` whether the caller is an agent before
 * either branch runs — the agent-focus gate on wiki content — and that query
 * joins `agents` to `users`. The joined chain answers "no agent", which is
 * what these human-editor scenarios are, so the gate stays inert and the
 * draft-invisibility rule below is still what the tests measure. The plain
 * chain answers the page lookup exactly as before.
 */
function selectStub(rows: unknown[]) {
  const terminal = (result: unknown[]) => ({
    where: () => ({ limit: async () => result }),
  });
  return vi.fn(() => ({
    from: () => ({ ...terminal(rows), innerJoin: () => terminal([]) }),
  }));
}

describe('PUT /api/wiki/pages against a draft', () => {
  function putRequest(body: unknown): IncomingMessage {
    const req = createRequest(body);
    (req as unknown as { method: string }).method = 'PUT';
    (req as unknown as { url: string }).url = '/api/wiki/pages?slug=kokain';
    return req;
  }

  it('will not copy draft content into a submitter who cannot read drafts', async () => {
    // Holds whole-page submission, but not draft reading and not direct write,
    // so the request takes the pending-edit branch.
    callerCanMock.mockImplementation(
      async (_role: string, capability: string) =>
        capability === 'wiki.page.submit',
    );
    const selectMock = selectStub([
      { id: 5, status: 'draft', content: { secret: 'draft prose' } },
    ]);
    const insertMock = vi.fn();
    getDbMock.mockReturnValue({ select: selectMock, insert: insertMock });

    const { res, state } = createResponse();
    await handler(putRequest({ title: 'Kokain' }), res);

    // Answers exactly as the read path does, and stores nothing.
    expect(state.statusCode).toBe(404);
    expect(insertMock).not.toHaveBeenCalled();
    expect(state.body).not.toContain('draft prose');
  });

  it('will not let a direct write mutate a draft it cannot read', async () => {
    // Holds page submission AND direct write, but not draft reading, so the
    // request takes the direct-update branch rather than the queued one.
    callerCanMock.mockImplementation(
      async (_role: string, capability: string) =>
        capability === 'wiki.page.submit' || capability === 'edit.directWrite',
    );
    const updateMock = vi.fn();
    getDbMock.mockReturnValue({
      select: selectStub([
        { id: 5, status: 'draft', drugCid: null, pageType: 'topic' },
      ]),
      update: updateMock,
    });

    const { res, state } = createResponse();
    await handler(putRequest({ title: 'Kokain', status: 'published' }), res);

    // Same 404 the read path gives, and the page is untouched — publishing a
    // hidden draft would otherwise be reachable through PUT.
    expect(state.statusCode).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/wiki/pages with newDrug', () => {
  it('refuses a caller who may submit pages but may not create drugs', async () => {
    callerCanMock.mockImplementation(
      async (_role: string, capability: string) =>
        capability === 'wiki.page.submit' || capability === 'edit.directWrite',
    );
    const { res, state } = createResponse();

    await handler(createRequest(NEW_DRUG_PAGE), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('drug_create_forbidden');
    expect(insertDrugMock).not.toHaveBeenCalled();
  });

  it('checks drug.create before writing anything', async () => {
    callerCanMock.mockImplementation(
      async (_role: string, capability: string) =>
        capability === 'wiki.page.submit',
    );
    const { res, state } = createResponse();

    await handler(createRequest(NEW_DRUG_PAGE), res);

    expect(state.statusCode).toBe(403);
    expect(callerCanMock).toHaveBeenCalledWith('editor', 'drug.create');
    // The rejection lands before the page insert path touches the database.
    expect(insertDrugMock).not.toHaveBeenCalled();
  });

  it('refuses a parameters bag without the parameter capability', async () => {
    callerCanMock.mockImplementation(
      async (_role: string, capability: string) =>
        capability === 'wiki.page.submit' || capability === 'drug.create',
    );
    const { res, state } = createResponse();

    await handler(
      createRequest({
        ...NEW_DRUG_PAGE,
        // An authored parameter: a summarizable one is refused by the bag
        // itself (400) before the capability question is even reached.
        parameters: { analyteStability: { min: 1, max: 2, unit: 'h' } },
        parametersReferenceId: 4,
      }),
      res,
    );

    // The bag becomes drug-parameter revisions, so it needs that capability
    // even though the page and the drug are both permitted.
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('parameter_submit_forbidden');
    expect(insertDrugMock).not.toHaveBeenCalled();
  });

  it('still refuses a caller who lacks whole-page submission entirely', async () => {
    callerCanMock.mockResolvedValue(false);
    const { res, state } = createResponse();

    await handler(createRequest(NEW_DRUG_PAGE), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('wiki_admin_only_whole_page');
  });
});
