import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: vi.fn(),
}));

vi.mock('../../api/_lib/pubmed.js', () => ({
  fetchPubMedMetadata: vi.fn(),
}));

vi.mock('../../api/_lib/crossref.js', () => ({
  fetchCrossRefMetadata: vi.fn(),
}));

import referencesHandler from '../../api/references.ts';
import referencesResolveHandler from '../../api/references-resolve.ts';
import { getDb } from '../../api/_lib/db.js';
import { getUserFromRequest } from '../../api/_lib/auth.js';

function createPostRequest(url: string): IncomingMessage {
  return {
    method: 'POST',
    url,
    headers: {
      host: 'localhost',
    },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  status: () => number | undefined;
  json: () => Record<string, unknown>;
} {
  let statusCode: number | undefined;
  let body = '';

  const res = {
    headersSent: false,
    writeHead: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    end: vi.fn((chunk?: string) => {
      body = chunk ?? '';
      return res;
    }),
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    json: () => JSON.parse(body),
  };
}

describe('reference route access control', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('denies reference creation for read-only authenticated users', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 1,
      role: 'authenticated',
    });

    const response = createResponse();
    await referencesHandler(createPostRequest('/api/references'), response.res);

    expect(response.status()).toBe(403);
    expect(response.json()).toEqual({ error: 'Contributor role required' });
    expect(getDb).not.toHaveBeenCalled();
  });

  it('denies reference resolver POSTs for read-only authenticated users', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 1,
      role: 'authenticated',
    });

    const response = createResponse();
    await referencesResolveHandler(
      createPostRequest('/api/references-resolve'),
      response.res,
    );

    expect(response.status()).toBe(403);
    expect(response.json()).toEqual({ error: 'Contributor role required' });
    expect(getDb).not.toHaveBeenCalled();
  });
});
