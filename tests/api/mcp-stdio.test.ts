import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/pubmed-eutils.js', () => ({
  searchPubMed: vi.fn().mockResolvedValue({
    query: 'aspirin',
    translatedQuery: null,
    sort: 'relevance',
    total: 3,
    offset: 0,
    warnings: [],
    records: [],
  }),
  fetchRecords: vi.fn(),
  fetchAbstracts: vi.fn(),
  findRelated: vi.fn(),
  resolveIdentifiers: vi.fn(),
  fetchPmcFullText: vi.fn(),
}));

import { serveStdio } from '../../api/_lib/mcp-stdio.ts';
import { createPubMedMcpServer } from '../../api/_lib/mcp-pubmed-server.ts';

/** Feed lines in, collect whatever the server writes back. */
async function exchange(lines: string[]): Promise<{
  messages: unknown[];
  raw: string;
}> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));

  await serveStdio({
    server: createPubMedMcpServer(),
    input: Readable.from(lines.map((line) => `${line}\n`)),
    output,
  });

  const raw = Buffer.concat(chunks).toString();
  return {
    raw,
    messages: raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
  };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('serveStdio', () => {
  it('answers initialize with the same identity as the HTTP transport', async () => {
    const { messages } = await exchange([
      rpc('initialize', { protocolVersion: '2025-06-18' }),
    ]);

    expect(messages).toHaveLength(1);
    const result = (messages[0] as { result: Record<string, never> }).result;
    expect(result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'kinetix-pubmed', version: '1.0.0' },
    });
  });

  it('exposes the same seven tools the HTTP route serves', async () => {
    const { messages } = await exchange([rpc('tools/list')]);
    const tools = (
      messages[0] as { result: { tools: Array<{ name: string }> } }
    ).result.tools;

    expect(tools.map((t) => t.name)).toEqual([
      'search_pubmed',
      'fetch_pubmed_records',
      'fetch_abstracts',
      'find_related_articles',
      'resolve_identifier',
      'fetch_pmc_full_text',
      'export_citations',
    ]);
  });

  it('writes exactly one line per response and nothing else', async () => {
    // A stray non-message line on stdout desynchronises the client's parser,
    // which is why diagnostics go to stderr.
    const { raw } = await exchange([
      rpc('ping', undefined, 1),
      rpc('ping', undefined, 2),
    ]);

    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('preserves request order across responses', async () => {
    const { messages } = await exchange([
      rpc('ping', undefined, 1),
      rpc('tools/list', undefined, 2),
      rpc('ping', undefined, 3),
    ]);
    expect(messages.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it('stays silent for a notification', async () => {
    const { raw } = await exchange([
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ]);
    expect(raw).toBe('');
  });

  it('ignores blank lines', async () => {
    const { messages } = await exchange(['', '  ', rpc('ping')]);
    expect(messages).toHaveLength(1);
  });

  it('returns a parse error for a malformed line and keeps serving', async () => {
    const { messages } = await exchange(['{not json', rpc('ping', undefined, 2)]);

    expect((messages[0] as { error: { code: number } }).error.code).toBe(-32700);
    expect((messages[1] as { id: number }).id).toBe(2);
  });

  it('answers a legacy batch with an array on one line', async () => {
    const { raw, messages } = await exchange([
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]),
    ]);

    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    expect(messages[0]).toHaveLength(2);
  });

  it('rejects an empty batch instead of hanging the client', async () => {
    // `[]` is an invalid request, not an all-notification batch — staying
    // silent would leave the client waiting forever. The HTTP transport
    // already answers this payload with the same error.
    const { messages } = await exchange(['[]']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
  });

  it('stays silent for an all-notification batch, like the HTTP 202', async () => {
    const { raw } = await exchange([
      JSON.stringify([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/cancelled' },
      ]),
    ]);
    expect(raw).toBe('');
  });

  it('runs a tool end to end', async () => {
    const { messages } = await exchange([
      rpc('tools/call', {
        name: 'search_pubmed',
        arguments: { query: 'aspirin' },
      }),
    ]);

    const result = (
      messages[0] as {
        result: { isError: boolean; structuredContent: { total: number } };
      }
    ).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent.total).toBe(3);
  });

  it('needs no bearer token — the client owns the process', async () => {
    // The HTTP route answers 503 with MCP_BEARER_TOKEN unset; stdio has no
    // listener to protect, so the same call just works.
    delete process.env.MCP_BEARER_TOKEN;
    const { messages } = await exchange([rpc('tools/list')]);
    expect(messages[0]).toHaveProperty('result');
  });

  it('resolves when the input stream closes', async () => {
    // This is how a client shuts a stdio server down.
    await expect(exchange([rpc('ping')])).resolves.toBeDefined();
  });
});
