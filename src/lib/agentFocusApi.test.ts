import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAgentFocusConfig,
  searchWikiPages,
  updateAgentFocusConfig,
} from './agentFocusApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAgentFocusConfig', () => {
  it('unwraps the config envelope', async () => {
    const config = {
      mode: 'pages',
      pageIds: [3, 7],
      parameters: [],
      updatedAt: '2026-06-15T00:00:00.000Z',
      pages: [
        { id: 3, title: 'Morfin', slug: 'morfin', pageType: 'drug' },
        { id: 7, title: 'Diazepam', slug: 'diazepam', pageType: 'drug' },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ config }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAgentFocusConfig()).resolves.toEqual(config);
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-focus', undefined);
  });

  it('throws the API error message on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Authentication required' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAgentFocusConfig()).rejects.toThrow(
      'Authentication required',
    );
  });
});

describe('updateAgentFocusConfig', () => {
  it('PUTs the payload as JSON and returns the updated config', async () => {
    const config = {
      mode: 'parameters',
      pageIds: [],
      parameters: ['halfLife', 'bloodPlasmaRatio'],
      updatedAt: '2026-06-15T00:00:00.000Z',
      pages: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ config }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateAgentFocusConfig({
        mode: 'parameters',
        parameters: ['halfLife', 'bloodPlasmaRatio'],
      }),
    ).resolves.toEqual(config);

    expect(fetchMock).toHaveBeenCalledWith('/api/agent-focus', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'parameters',
        parameters: ['halfLife', 'bloodPlasmaRatio'],
      }),
    });
  });
});

describe('updateAgentFocusConfig (methods mode)', () => {
  it('sends methodIds and returns the hydrated methods', async () => {
    const config = {
      mode: 'methods',
      pageIds: [],
      parameters: [],
      methodIds: [9001, 9002],
      updatedAt: '2026-06-15T00:00:00.000Z',
      pages: [],
      methods: [
        { id: 9001, code: '9001', name: 'Synthetic screening panel A', drugIds: [5, 8] },
        { id: 9002, code: '9002', name: 'Synthetic LC-MS/MS panel B', drugIds: [12] },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ config }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateAgentFocusConfig({ mode: 'methods', methodIds: [9001, 9002] }),
    ).resolves.toEqual(config);

    expect(fetchMock).toHaveBeenCalledWith('/api/agent-focus', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'methods', methodIds: [9001, 9002] }),
    });
  });
});

describe('updateAgentFocusConfig (skipWikiContent)', () => {
  it('sends the switch alongside the scope it is combined with', async () => {
    // The pairing the switch exists for: keep the method scope, close the
    // monograph half. The two travel in one request, so a client that dropped
    // the switch would silently save the scope with the wiki action re-opened.
    const config = {
      mode: 'methods',
      pageIds: [],
      parameters: [],
      methodIds: [9001],
      skipWikiContent: true,
      skipWikiContentSetting: true,
      updatedAt: '2026-09-22T00:00:00.000Z',
      pages: [],
      methods: [
        { id: 9001, code: '9001', name: 'Synthetic screening panel A', drugIds: [5] },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ config }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateAgentFocusConfig({
        mode: 'methods',
        methodIds: [9001],
        skipWikiContent: true,
      }),
    ).resolves.toEqual(config);

    expect(fetchMock).toHaveBeenCalledWith('/api/agent-focus', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'methods',
        methodIds: [9001],
        skipWikiContent: true,
      }),
    });
  });
});

describe('searchWikiPages', () => {
  it('does not call the API for a blank query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchWikiPages('   ')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('encodes the query and unwraps results', async () => {
    const results = [
      { id: 1, slug: 'morfin', title: 'Morfin', pageType: 'drug' },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ results }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchWikiPages('mor fin')).resolves.toEqual(results);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/wiki/search?q=mor%20fin&limit=8',
      undefined,
    );
  });
});
