import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readLiveMock } = vi.hoisted(() => ({ readLiveMock: vi.fn() }));

// The store has its own integration tests; here only the route's contract is under test.
vi.mock('../../api/_lib/model-derivation-store.js', () => ({
  readLiveDerivedModel: readLiveMock,
}));

import handler from '../../api/derived-model.ts';

function createRequest(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function createResponse() {
  const state: { status?: number; headers: Record<string, unknown>; body?: string } = { headers: {} };
  const res = {
    headersSent: false,
    setHeader(name: string, value: unknown) {
      state.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      state.status = status;
      for (const [k, v] of Object.entries(headers)) state.headers[k.toLowerCase()] = v;
      res.headersSent = true;
    },
    end(body?: string) {
      state.body = body;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

beforeEach(() => readLiveMock.mockReset());

describe('GET /api/derived-model', () => {
  it('returns the live build, edge-cached for a minute', async () => {
    readLiveMock.mockResolvedValue({ status: 'not-modelable', entry: { slug: 'x', reason: 'r', routes: [] } });
    const { res, state } = createResponse();
    await handler(createRequest('GET', '/api/derived-model?slug=x'), res);
    expect(readLiveMock).toHaveBeenCalledWith('x');
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body!).status).toBe('not-modelable');
    expect(String(state.headers['cache-control'])).toContain('s-maxage=60');
  });

  it('answers 404 for a slug the catalogue does not hold', async () => {
    readLiveMock.mockResolvedValue({ status: 'not-found' });
    const { res, state } = createResponse();
    await handler(createRequest('GET', '/api/derived-model?slug=nope'), res);
    expect(state.status).toBe(404);
  });

  it('rejects a missing slug and any method but GET', async () => {
    const missing = createResponse();
    await handler(createRequest('GET', '/api/derived-model'), missing.res);
    expect(missing.state.status).toBe(400);

    const post = createResponse();
    await handler(createRequest('POST', '/api/derived-model?slug=x'), post.res);
    expect(post.state.status).toBe(405);
    expect(readLiveMock).not.toHaveBeenCalled();
  });
});
