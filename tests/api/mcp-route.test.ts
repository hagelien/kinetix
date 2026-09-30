import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { searchPubMedMock, fetchRecordsMock, fetchPmcFullTextMock } = vi.hoisted(
  () => ({
    searchPubMedMock: vi.fn(),
    fetchRecordsMock: vi.fn(),
    fetchPmcFullTextMock: vi.fn(),
  }),
);

vi.mock('../../api/_lib/pubmed-eutils.js', () => ({
  searchPubMed: searchPubMedMock,
  fetchRecords: fetchRecordsMock,
  fetchAbstracts: vi.fn(),
  findRelated: vi.fn(),
  resolveIdentifiers: vi.fn(),
  fetchPmcFullText: fetchPmcFullTextMock,
}));

import handler from '../../api/mcp.ts';
import { clearRateLimitState } from '../../api/_lib/rate-limit.ts';

const TOKEN = 'test-mcp-token';

function createRequest(options: {
  method?: string;
  url?: string;
  body?: unknown;
  token?: string | null;
  origin?: string;
}): IncomingMessage {
  const raw = options.body === undefined ? '' : JSON.stringify(options.body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = options.method ?? 'POST';
  req.url = options.url ?? '/api/mcp';
  req.headers = {
    host: 'kinetix.no',
    'content-type': 'application/json',
    'x-real-ip': '127.0.0.1',
    ...(raw ? { 'content-length': String(Buffer.byteLength(raw)) } : {}),
    ...(options.token === null
      ? {}
      : { authorization: `Bearer ${options.token ?? TOKEN}` }),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  return req;
}

function createResponse() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, string>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, string>) => {
        state.statusCode = statusCode;
        Object.assign(state.headers, headers ?? {});
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

async function call(options: Parameters<typeof createRequest>[0]) {
  const { res, state } = createResponse();
  await handler(createRequest(options), res);
  return {
    status: state.statusCode,
    headers: state.headers,
    json: state.body ? JSON.parse(state.body) : null,
  };
}

function rpc(method: string, params?: unknown, id: number | null = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

describe('POST /api/mcp', () => {
  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = TOKEN;
    clearRateLimitState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.MCP_BEARER_TOKEN;
  });

  describe('transport and auth', () => {
    it('fails closed with 503 when no token is configured', async () => {
      delete process.env.MCP_BEARER_TOKEN;
      const res = await call({ body: rpc('tools/list') });
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('mcp_not_configured');
    });

    it('rejects a missing bearer token with 401 and a challenge', async () => {
      const res = await call({ body: rpc('tools/list'), token: null });
      expect(res.status).toBe(401);
      expect(res.headers['WWW-Authenticate']).toContain('Bearer');
    });

    it('rejects a wrong bearer token', async () => {
      const res = await call({ body: rpc('tools/list'), token: 'nope' });
      expect(res.status).toBe(401);
    });

    it('answers the unauthenticated health probe', async () => {
      const res = await call({
        method: 'GET',
        url: '/api/mcp?health=1',
        token: null,
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ status: 'ok', configured: true });
    });

    it('answers CORS preflight without a token', async () => {
      const res = await call({ method: 'OPTIONS', token: null });
      expect(res.status).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res.headers['Access-Control-Allow-Headers']).toContain(
        'Authorization',
      );
    });

    it('refuses GET (no server-initiated stream) with 405', async () => {
      const res = await call({ method: 'GET' });
      expect(res.status).toBe(405);
      expect(res.headers.Allow).toContain('POST');
    });

    it('accepts a cross-origin POST — the bearer token is the guard', async () => {
      const res = await call({
        body: rpc('ping'),
        origin: 'https://chatgpt.com',
      });
      expect(res.status).toBe(200);
      expect(res.json.result).toEqual({});
    });

    it('rate-limits a caller that floods the endpoint', async () => {
      let last = await call({ body: rpc('ping') });
      for (let i = 0; i < 130 && last.status === 200; i += 1) {
        last = await call({ body: rpc('ping') });
      }
      expect(last.status).toBe(429);
      expect(last.headers['Retry-After']).toBeDefined();
    });
  });

  describe('protocol', () => {
    it('echoes a supported protocol version on initialize', async () => {
      const res = await call({
        body: rpc('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.json.result.protocolVersion).toBe('2025-03-26');
      expect(res.json.result.serverInfo.name).toBe('kinetix-pubmed');
      expect(res.json.result.capabilities.tools).toBeDefined();
      expect(res.json.result.instructions).toContain('PMID');
    });

    it('falls back to the latest version for an unknown one', async () => {
      const res = await call({
        body: rpc('initialize', { protocolVersion: '1999-01-01' }),
      });
      expect(res.json.result.protocolVersion).toBe('2025-06-18');
    });

    it('lists tools with JSON Schema input definitions', async () => {
      const res = await call({ body: rpc('tools/list') });
      const names = res.json.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('search_pubmed');
      expect(names).toContain('fetch_abstracts');
      expect(names).toContain('export_citations');

      const search = res.json.result.tools.find(
        (t: { name: string }) => t.name === 'search_pubmed',
      );
      expect(search.inputSchema.type).toBe('object');
      expect(search.inputSchema.properties.query).toBeDefined();
      expect(search.inputSchema.required).toContain('query');
      expect(search.annotations.readOnlyHint).toBe(true);
    });

    it('acknowledges a notification with 202 and no body', async () => {
      const res = await call({
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(res.status).toBe(202);
      expect(res.json).toBeNull();
    });

    it('returns a JSON-RPC parse error for malformed JSON', async () => {
      const { res, state } = createResponse();
      const req = Readable.from(['{not json']) as IncomingMessage;
      req.method = 'POST';
      req.url = '/api/mcp';
      req.headers = {
        host: 'kinetix.no',
        authorization: `Bearer ${TOKEN}`,
        'x-real-ip': '127.0.0.1',
      };
      await handler(req, res);
      expect(state.statusCode).toBe(200);
      expect(JSON.parse(state.body).error.code).toBe(-32700);
    });

    it('returns method-not-found for an unknown method', async () => {
      const res = await call({ body: rpc('does/not/exist') });
      expect(res.json.error.code).toBe(-32601);
    });

    it('handles a legacy batch as an array of responses', async () => {
      const res = await call({
        body: [rpc('ping', undefined, 1), rpc('ping', undefined, 2)],
      });
      expect(Array.isArray(res.json)).toBe(true);
      expect(res.json).toHaveLength(2);
    });

    it('rejects an oversized batch instead of dispatching it', async () => {
      const res = await call({
        body: Array.from({ length: 21 }, (_, i) =>
          rpc('tools/call', { name: 'search_pubmed', arguments: { query: 'x' } }, i),
        ),
      });
      expect(res.json.error.code).toBe(-32600);
      expect(res.json.error.message).toContain('20-message limit');
      // Nothing reached NCBI.
      expect(searchPubMedMock).not.toHaveBeenCalled();
    });

    it('charges the rate limiter for every message in a batch', async () => {
      // 12 batches of 10 exceeds the 120/minute ceiling; charging one hit per
      // request instead of per message would let all 12 through.
      let last = await call({ body: rpc('ping') });
      for (let i = 0; i < 12 && last.status === 200; i += 1) {
        last = await call({
          body: Array.from({ length: 10 }, (_, n) =>
            rpc('ping', undefined, n + 1),
          ),
        });
      }
      expect(last.status).toBe(429);
    });

    it('rejects a non-scalar request id instead of echoing it back', async () => {
      // JSON-RPC allows only a string, a number, or null; echoing an object
      // back breaks correlation for a client that matches on the id.
      for (const id of [{ nested: 1 }, [1, 2], true]) {
        const res = await call({
          body: { jsonrpc: '2.0', id, method: 'ping' },
        });
        expect(res.json.error.code).toBe(-32600);
        expect(res.json.id).toBeNull();
      }
    });

    it('answers a request whose id is explicitly null', async () => {
      // JSON-RPC identifies a notification by an absent id, not a null one;
      // treating null as a notification leaves the client hanging.
      const res = await call({
        body: { jsonrpc: '2.0', id: null, method: 'ping' },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ jsonrpc: '2.0', id: null, result: {} });
    });
  });

  describe('tools/call', () => {
    it('runs search_pubmed and returns structured content', async () => {
      searchPubMedMock.mockResolvedValue({
        query: '(trimipramine) AND ("Journal Article"[Publication Type])',
        translatedQuery: 'trimipramine[All Fields]',
        total: 42,
        offset: 0,
        warnings: [],
        records: [
          {
            pmid: '33245133',
            title: 'A study',
            authors: ['Mantinieks D'],
            collectiveAuthors: [],
            journal: 'Journal of Analytical Toxicology',
            journalAbbrev: 'J Anal Toxicol',
            year: 2021,
            publicationDate: '2021 Jan',
            volume: '45',
            issue: '1',
            pages: '10-20',
            doi: '10.1093/jat/bkaa107',
            pmcid: null,
            publicationTypes: ['Journal Article'],
            url: 'https://pubmed.ncbi.nlm.nih.gov/33245133/',
          },
        ],
      });

      const res = await call({
        body: rpc('tools/call', {
          name: 'search_pubmed',
          arguments: {
            query: 'trimipramine',
            article_types: ['Journal Article'],
            max_results: 5,
          },
        }),
      });

      expect(searchPubMedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'trimipramine',
          articleTypes: ['Journal Article'],
          maxResults: 5,
          sort: 'relevance',
        }),
      );
      expect(res.json.result.isError).toBe(false);
      expect(res.json.result.structuredContent.total).toBe(42);
      expect(res.json.result.structuredContent.returned).toBe(1);
      expect(res.json.result.structuredContent.truncated).toBe(true);
      expect(res.json.result.content[0].text).toContain('33245133');
    });

    it('rejects invalid arguments with -32602 before calling NCBI', async () => {
      const res = await call({
        body: rpc('tools/call', {
          name: 'fetch_abstracts',
          arguments: { pmids: ['not-a-pmid'] },
        }),
      });
      expect(res.json.error.code).toBe(-32602);
      expect(res.json.error.message).toContain('numeric PubMed ID');
    });

    it('rejects an offset past PubMed\'s 9,999-record retrieval ceiling', async () => {
      // Entrez answers "Search Backend failed" for retstart > 9998; catching it
      // here turns that into an argument error that says what to do instead.
      const res = await call({
        body: rpc('tools/call', {
          name: 'search_pubmed',
          arguments: { query: 'aspirin', offset: 10000 },
        }),
      });
      expect(res.json.error.code).toBe(-32602);
      expect(res.json.error.message).toContain('9,999');
      expect(searchPubMedMock).not.toHaveBeenCalled();
    });

    it('accepts the largest offset PubMed will serve', async () => {
      searchPubMedMock.mockResolvedValue({
        query: 'aspirin',
        translatedQuery: null,
        total: 60000,
        offset: 9998,
        warnings: [],
        records: [],
      });
      const res = await call({
        body: rpc('tools/call', {
          name: 'search_pubmed',
          arguments: { query: 'aspirin', offset: 9998 },
        }),
      });
      expect(res.json.result.isError).toBe(false);
    });

    it('rejects an unknown tool name', async () => {
      const res = await call({
        body: rpc('tools/call', { name: 'drop_database', arguments: {} }),
      });
      expect(res.json.error.code).toBe(-32602);
      expect(res.json.error.message).toContain('Unknown tool');
    });

    it('reports an upstream failure as isError, not a transport error', async () => {
      searchPubMedMock.mockRejectedValue(
        new Error('NCBI request failed with status 500'),
      );
      const res = await call({
        body: rpc('tools/call', {
          name: 'search_pubmed',
          arguments: { query: 'trimipramine' },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.json.result.isError).toBe(true);
      expect(res.json.result.content[0].text).toContain('status 500');
    });

    it('formats citations without a second NCBI round trip per style', async () => {
      fetchRecordsMock.mockResolvedValue([
        {
          pmid: '33245133',
          title: 'Postmortem drug redistribution',
          authors: ['Mantinieks D', 'Gerostamoulos D', 'Glowacki L'],
          collectiveAuthors: [],
          journal: 'Journal of Analytical Toxicology',
          journalAbbrev: 'J Anal Toxicol',
          year: 2021,
          publicationDate: '2021 Jan',
          volume: '45',
          issue: '1',
          pages: '10-20',
          doi: '10.1093/jat/bkaa107',
          pmcid: null,
          publicationTypes: ['Journal Article'],
          url: 'https://pubmed.ncbi.nlm.nih.gov/33245133/',
        },
      ]);

      const res = await call({
        body: rpc('tools/call', {
          name: 'export_citations',
          arguments: { pmids: ['33245133'], format: 'vancouver' },
        }),
      });

      expect(res.json.result.content[0].text).toContain('PMID: 33245133');
      expect(res.json.result.content[0].text).toContain('2021;45(1):10-20');
      // Every entry is prefixed with its PMID, so a client reading only the
      // content block keeps the identifier even in formats that omit it.
      expect(res.json.result.content[0].text.startsWith('PMID 33245133\n')).toBe(
        true,
      );
      expect(res.json.result.structuredContent.notFound).toEqual([]);
    });

    it('returns PMC full text once, not in both representations', async () => {
      const body = 'x'.repeat(30_000);
      fetchPmcFullTextMock.mockResolvedValue({
        pmcid: 'PMC7772728',
        text: body,
        available: true,
        note: 'Lossy plain-text rendering.',
      });

      const res = await call({
        body: rpc('tools/call', {
          name: 'fetch_pmc_full_text',
          arguments: { pmcid: 'PMC7772728' },
        }),
      });

      expect(res.json.result.content[0].text).toBe(body);
      // The body lives in the content block only; structuredContent carries
      // the metadata and a length, so a 30 KB article is not sent twice.
      expect(res.json.result.structuredContent.text).toBeUndefined();
      expect(res.json.result.structuredContent.characters).toBe(30_000);
      expect(res.json.result.structuredContent.available).toBe(true);
      expect(JSON.stringify(res.json).length).toBeLessThan(body.length * 2);
    });

    it('explains an unavailable PMC article instead of returning nothing', async () => {
      fetchPmcFullTextMock.mockResolvedValue({
        pmcid: 'PMC29627',
        text: null,
        available: false,
        note: 'No open-access full text returned for this PMCID.',
      });

      const res = await call({
        body: rpc('tools/call', {
          name: 'fetch_pmc_full_text',
          arguments: { pmcid: '29627' },
        }),
      });

      expect(res.json.result.structuredContent.available).toBe(false);
      expect(res.json.result.structuredContent.characters).toBe(0);
      expect(res.json.result.content[0].text).toContain('No open-access');
    });

    it('names unciteable PMIDs in the citation text, not just the structure', async () => {
      fetchRecordsMock.mockResolvedValue([]);
      const res = await call({
        body: rpc('tools/call', {
          name: 'export_citations',
          arguments: { pmids: ['1', '999999999'], format: 'apa' },
        }),
      });

      // Every PMID unknown: without the note this block would be empty and the
      // client would have no idea why.
      expect(res.json.result.content[0].text).toContain('Not found in PubMed');
      expect(res.json.result.content[0].text).toContain('1, 999999999');
      expect(res.json.result.structuredContent.notFound).toEqual([
        '1',
        '999999999',
      ]);
    });

    it('reports PMIDs PubMed did not return', async () => {
      fetchRecordsMock.mockResolvedValue([]);
      const res = await call({
        body: rpc('tools/call', {
          name: 'fetch_pubmed_records',
          arguments: { pmids: ['1', '999999999'] },
        }),
      });
      expect(res.json.result.structuredContent.notFound).toEqual([
        '1',
        '999999999',
      ]);
    });
  });
});
