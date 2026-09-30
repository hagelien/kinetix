import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import listPagesHandler from '../../api/wiki/pages.ts';
import searchHandler from '../../api/wiki/search.ts';
import { getDb } from '../../api/_lib/db.js';

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      host: 'localhost',
    },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  state: {
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
  };
} {
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
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
    }),
  } as unknown as ServerResponse;

  return { res, state };
}

function mockSearchDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  vi.mocked(getDb).mockReturnValue({
    select,
  } as unknown as ReturnType<typeof getDb>);

  return { select, limit };
}

function mockLookupPagesDb(rows: unknown[]) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn(() => ({ offset }));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  vi.mocked(getDb).mockReturnValue({
    select,
  } as unknown as ReturnType<typeof getDb>);

  return { select, limit, offset };
}

function mockSummaryPagesDb(rows: unknown[]) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn(() => ({ offset }));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn().mockReturnValueOnce({ from });

  vi.mocked(getDb).mockReturnValue({
    select,
  } as unknown as ReturnType<typeof getDb>);

  return { select, orderBy, limit, offset };
}

describe('wiki lookup routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('respects the caller limit and compact wiki search projection', async () => {
    const { select, limit } = mockSearchDb([
      { slug: 'alprazolam', title: 'Alprazolam', pageType: 'drug_monograph' },
    ]);
    const { res, state } = createResponse();

    await searchHandler(
      createRequest('/api/wiki/search?q=alprazolam&limit=5&view=compact'),
      res,
    );

    expect(limit).toHaveBeenCalledWith(5);
    expect(
      Object.keys(select.mock.calls[0][0] as Record<string, unknown>),
    ).toEqual(['slug', 'title', 'pageType']);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      results: [
        { slug: 'alprazolam', title: 'Alprazolam', pageType: 'drug_monograph' },
      ],
    });
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
  });

  it('keeps title fallback for non-ASCII wiki search queries', async () => {
    const { limit } = mockSearchDb([
      { slug: 'blabaer', title: 'Blabaer', pageType: 'topic' },
    ]);
    const { res, state } = createResponse();

    await searchHandler(
      createRequest('/api/wiki/search?q=%C3%A5&limit=5&view=compact'),
      res,
    );

    expect(limit).toHaveBeenCalledWith(5);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      results: [{ slug: 'blabaer', title: 'Blabaer', pageType: 'topic' }],
    });
  });

  it('uses the summary view for wiki home lists with hierarchy metadata', async () => {
    const { select, orderBy, limit, offset } = mockSummaryPagesDb([
      {
        id: 1,
        slug: 'alprazolam',
        title: 'Alprazolam',
        pageType: 'drug_monograph',
        parentId: null,
        updatedAt: '2026-05-21T00:00:00.000Z',
      },
      {
        id: 2,
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        parentId: 1,
        updatedAt: '2026-05-21T00:00:00.000Z',
      },
    ]);
    const { res, state } = createResponse();

    await listPagesHandler(
      createRequest('/api/wiki/pages?limit=50&view=summary'),
      res,
    );

    expect(select).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(limit).toHaveBeenCalledWith(51);
    expect(offset).toHaveBeenCalledWith(0);
    expect(
      Object.keys(select.mock.calls[0][0] as Record<string, unknown>),
    ).toEqual(['id', 'slug', 'title', 'pageType', 'parentId', 'updatedAt']);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      pages: [
        {
          id: 1,
          slug: 'alprazolam',
          title: 'Alprazolam',
          pageType: 'drug_monograph',
          parentId: null,
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
        {
          id: 2,
          slug: 'diazepam',
          title: 'Diazepam',
          pageType: 'drug_monograph',
          parentId: 1,
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
      ],
      hasMore: false,
    });
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
  });

  it('detects another summary page without running a count query', async () => {
    const { select, limit } = mockSummaryPagesDb([
      {
        id: 1,
        slug: 'alprazolam',
        title: 'Alprazolam',
        pageType: 'drug_monograph',
        parentId: null,
        updatedAt: '2026-05-21T00:00:00.000Z',
      },
      {
        id: 2,
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        parentId: null,
        updatedAt: '2026-05-21T00:00:00.000Z',
      },
      {
        id: 3,
        slug: 'zolpidem',
        title: 'Zolpidem',
        pageType: 'drug_monograph',
        parentId: null,
        updatedAt: '2026-05-21T00:00:00.000Z',
      },
    ]);
    const { res, state } = createResponse();

    await listPagesHandler(
      createRequest('/api/wiki/pages?limit=2&view=summary'),
      res,
    );

    expect(select).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(3);
    expect(JSON.parse(state.body)).toEqual({
      pages: [
        {
          id: 1,
          slug: 'alprazolam',
          title: 'Alprazolam',
          pageType: 'drug_monograph',
          parentId: null,
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
        {
          id: 2,
          slug: 'diazepam',
          title: 'Diazepam',
          pageType: 'drug_monograph',
          parentId: null,
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
      ],
      hasMore: true,
    });
  });

  it('rejects a non-numeric pageId without touching the database', async () => {
    const select = vi.fn();
    vi.mocked(getDb).mockReturnValue({
      select,
    } as unknown as ReturnType<typeof getDb>);
    const { res, state } = createResponse();

    await listPagesHandler(createRequest('/api/wiki/pages?pageId=abc'), res);

    expect(select).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({ error: 'Invalid pageId' });
  });

  it('returns 404 when no page matches the pageId', async () => {
    // fetchAndServePage: SELECT … FROM wiki_pages LEFT JOIN users LEFT JOIN agents WHERE id = ? LIMIT 1
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    const leftJoinInner = vi.fn(() => ({ where }));
    const leftJoinOuter = vi.fn(() => ({ leftJoin: leftJoinInner }));
    const from = vi.fn(() => ({ leftJoin: leftJoinOuter }));
    const select = vi.fn(() => ({ from }));
    vi.mocked(getDb).mockReturnValue({
      select,
    } as unknown as ReturnType<typeof getDb>);
    const { res, state } = createResponse();

    await listPagesHandler(createRequest('/api/wiki/pages?pageId=999'), res);

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toMatchObject({ error: 'Page not found' });
  });

  it('resolves a published page by pageId, exposing slug and drugCid', async () => {
    const page = {
      id: 42,
      slug: 'alprazolam',
      title: 'Alprazolam',
      content: {},
      contentHtml: '',
      pageType: 'drug_monograph',
      drugCid: 123,
      parentId: null,
      status: 'published',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
      updatedBy: null,
    };

    // fetchAndServePage issues 2 queries in parallel after the initial page fetch:
    // Call 1: page query by id (with two leftJoins for updatedBy / isAgent).
    // Call 2: children query (parentId is null so no ancestors CTE is issued).
    let call = 0;
    const select = vi.fn(() => {
      call += 1;
      if (call === 1) {
        // fetchAndServePage page query: SELECT … FROM wiki_pages LEFT JOIN users LEFT JOIN agents WHERE id = ?
        const limit = vi.fn().mockResolvedValue([page]);
        const where = vi.fn(() => ({ limit }));
        const leftJoinInner = vi.fn(() => ({ where }));
        const leftJoinOuter = vi.fn(() => ({ leftJoin: leftJoinInner }));
        const from = vi.fn(() => ({ leftJoin: leftJoinOuter }));
        return { from };
      }
      // call 2: children query
      const orderBy = vi.fn().mockResolvedValue([]);
      const where = vi.fn(() => ({ orderBy }));
      const from = vi.fn(() => ({ where }));
      return { from };
    });
    vi.mocked(getDb).mockReturnValue({
      select,
    } as unknown as ReturnType<typeof getDb>);
    const { res, state } = createResponse();

    await listPagesHandler(createRequest('/api/wiki/pages?pageId=42'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.page.slug).toBe('alprazolam');
    expect(body.page.drugCid).toBe(123);
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
  });

  it('uses the lookup view for slim wiki slug maps without a count query', async () => {
    const { select, limit, offset } = mockLookupPagesDb([
      { slug: 'alprazolam', drugCid: 123 },
      { slug: 'diazepam', drugCid: 456 },
    ]);
    const { res, state } = createResponse();

    await listPagesHandler(
      createRequest(
        '/api/wiki/pages?pageType=drug_monograph&limit=200&view=lookup',
      ),
      res,
    );

    expect(select).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(200);
    expect(offset).toHaveBeenCalledWith(0);
    expect(
      Object.keys(select.mock.calls[0][0] as Record<string, unknown>),
    ).toEqual(['slug', 'drugCid']);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      pages: [
        { slug: 'alprazolam', drugCid: 123 },
        { slug: 'diazepam', drugCid: 456 },
      ],
    });
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
  });
});
