/**
 * loadMethods() cache behaviour — correctness under:
 *   #410: in-flight staleness (epoch guard)
 *   #405 review: don't cache transient errors
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDataCache,
  clearMethodsCache,
  loadComponents,
  loadMethods,
} from './index';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('data loader request coalescing', () => {
  beforeEach(() => {
    clearDataCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDataCache();
  });

  it('shares the in-flight components request across concurrent callers', async () => {
    const components = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(components.promise);
    vi.stubGlobal('fetch', fetchMock);

    const first = loadComponents();
    const second = loadComponents();

    components.resolve(
      jsonResponse({
        drugs: [
          {
            id: 1,
            slug: 'ethanol',
            names: { en: 'Ethanol', nb: 'Etanol' },
            nameShort: null,
            aliases: [],
            pubchemCid: 702,
            molecularWeight: 46.1,
            halfLife: null,
            volumeOfDistribution: null,
            bioavailability: null,
            proteinBinding: null,
            bloodPlasmaRatio: null,
            tmax: null,
            pKa: null,
            popularityScore: 10,
            searchKey: 'ethanol\tetanol\talcohol',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        expect.objectContaining({
          id: '702',
          pubchemCid: 702,
          _dbId: 1,
        }),
      ],
      [
        expect.objectContaining({
          id: '702',
          pubchemCid: 702,
          _dbId: 1,
        }),
      ],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/drugs?sort=popularity&limit=1000',
      undefined,
    );
  });

  it('shares the in-flight methods request across concurrent callers', async () => {
    const methods = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(methods.promise);
    vi.stubGlobal('fetch', fetchMock);

    const first = loadMethods();
    const second = loadMethods();

    methods.resolve(
      jsonResponse({
        methods: [
          {
            code: 'LC-MS',
            name: 'LC-MS',
            description: null,
            drugIds: [1],
            pubchemCids: [702],
          },
        ],
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          id: 'LC-MS',
          name: 'LC-MS',
          description: 'LC-MS',
          components: ['702'],
          drugIds: [1],
        },
      ],
      [
        {
          id: 'LC-MS',
          name: 'LC-MS',
          description: 'LC-MS',
          components: ['702'],
          drugIds: [1],
        },
      ],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/methods');
  });
});

describe('loadComponents embedded fallback', () => {
  beforeEach(() => {
    clearDataCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDataCache();
  });

  // When the API returns no drugs the loader hydrates from the embedded
  // `data/components.ts` bundle. That fallback must carry the forensic-tox
  // concentration bands the fixture holds, not just the PK parameters —
  // regression guard for the fields `toComponentFromRaw` used to drop.
  it('maps therapeutic/toxic/fatal concentration bands from the fixture', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ drugs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const components = await loadComponents();

    expect(components.length).toBeGreaterThan(0);
    expect(
      components.some((c) => c.therapeuticConcentration != null),
    ).toBe(true);
    expect(components.some((c) => c.toxicConcentration != null)).toBe(true);
    expect(components.some((c) => c.fatalConcentration != null)).toBe(true);
  });

  it('falls back to the embedded bundle when the drugs fetch rejects', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('transient network error'));
    vi.stubGlobal('fetch', fetchMock);

    const components = await loadComponents();

    expect(components.length).toBeGreaterThan(0);
    expect(components.some((c) => c.fatalConcentration != null)).toBe(true);
  });
});

describe('loadMethods staleness', () => {
  beforeEach(() => {
    clearMethodsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMethodsCache();
  });

  it('discards an in-flight fetch whose auth scope was invalidated mid-flight', async () => {
    const anon = deferred<Response>();
    const auth = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(anon.promise)
      .mockReturnValueOnce(auth.promise);
    vi.stubGlobal('fetch', fetchMock);

    // Anonymous mount kicks off /api/methods (gated → []) while the
    // user signs in. The sign-in path calls clearMethodsCache() and
    // then loadMethods() again — that second call must own the cache,
    // not the still-in-flight anonymous one.
    const anonLoad = loadMethods();
    clearMethodsCache();
    const authLoad = loadMethods();

    // Authenticated response lands first with real methods.
    auth.resolve(
      jsonResponse({
        methods: [
          {
            code: 'GC-MS',
            name: 'GC-MS',
            description: 'Gas chromatography',
            drugIds: [1],
            pubchemCids: [702],
          },
        ],
      }),
    );
    await expect(authLoad).resolves.toEqual([
      {
        id: 'GC-MS',
        name: 'GC-MS',
        description: 'Gas chromatography',
        components: ['702'],
        drugIds: [1],
      },
    ]);

    // Then the stale anonymous fetch finally resolves with the gated
    // empty response. It must NOT overwrite the cache.
    anon.resolve(jsonResponse({ methods: [], gated: true }));
    await expect(anonLoad).resolves.toEqual([
      {
        id: 'GC-MS',
        name: 'GC-MS',
        description: 'Gas chromatography',
        components: ['702'],
        drugIds: [1],
      },
    ]);

    // The next loadMethods() call returns the authenticated cache, not []
    const followup = await loadMethods();
    expect(followup).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns [] from a stale fetch when the fresh fetch has not yet landed', async () => {
    const anon = deferred<Response>();
    const auth = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(anon.promise)
      .mockReturnValueOnce(auth.promise);
    vi.stubGlobal('fetch', fetchMock);

    const anonLoad = loadMethods();
    clearMethodsCache();
    const authLoad = loadMethods();

    // Stale fetch resolves before the fresh one — cache is still null,
    // so it returns [] rather than the gated response.
    anon.resolve(jsonResponse({ methods: [], gated: true }));
    await expect(anonLoad).resolves.toEqual([]);

    // Fresh fetch lands later and populates the cache.
    auth.resolve(
      jsonResponse({
        methods: [
          {
            code: 'LC-MS',
            name: 'LC-MS',
            description: null,
            drugIds: [],
            pubchemCids: [],
          },
        ],
      }),
    );
    await expect(authLoad).resolves.toEqual([
      {
        id: 'LC-MS',
        name: 'LC-MS',
        description: 'LC-MS',
        components: [],
        drugIds: [],
      },
    ]);
  });
});

describe('loadMethods error handling', () => {
  beforeEach(() => {
    clearMethodsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMethodsCache();
  });

  it('does not cache transient fetch errors so the next call retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            methods: [
              {
                code: 'GC-FID',
                name: 'GC-FID',
                description: null,
                drugIds: [],
                pubchemCids: [],
              },
            ],
          }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    // First call fails — must return [] without poisoning the cache.
    await expect(loadMethods()).resolves.toEqual([]);
    // Second call should hit the network again (cache is still null).
    const methods = await loadMethods();
    expect(methods).toEqual([
      {
        id: 'GC-FID',
        name: 'GC-FID',
        description: 'GC-FID',
        components: [],
        drugIds: [],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
