import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDrugIndicators,
  fetchWikiPageIndicators,
  invalidateDrugIndicators,
  invalidateWikiPageIndicators,
} from './drugIndicatorsApi';

afterEach(() => {
  vi.useRealTimers();
  invalidateDrugIndicators();
  invalidateWikiPageIndicators();
  vi.unstubAllGlobals();
});

describe('fetchDrugIndicators', () => {
  it('dedupes concurrent indicator requests for the same drug', async () => {
    let resolveJson!: (value: unknown) => void;
    const jsonPromise = new Promise<unknown>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => jsonPromise,
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchDrugIndicators(42);
    const second = fetchDrugIndicators(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/drug-indicators?drugId=42');

    resolveJson({
      comments: { halfLife: 2 },
      refs: { halfLife: [10, 11] },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        comments: { halfLife: 2 },
        refs: { halfLife: [10, 11] },
      },
      {
        comments: { halfLife: 2 },
        refs: { halfLife: [10, 11] },
      },
    ]);
  });

  it('reuses a successful drug indicator response inside the cache window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T00:00:00.000Z'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          comments: { halfLife: 2 },
          refs: { halfLife: [10, 11] },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: { halfLife: 2 },
      refs: { halfLife: [10, 11] },
    });
    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: { halfLife: 2 },
      refs: { halfLife: [10, 11] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    await fetchDrugIndicators(42);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed drug indicator responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: vi.fn() })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: { pKa: 1 }, refs: {} }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: {},
      refs: {},
    });
    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: { pKa: 1 },
      refs: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears a cached drug indicator response when invalidated', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: { halfLife: 1 }, refs: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: { halfLife: 2 }, refs: {} }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: { halfLife: 1 },
      refs: {},
    });
    invalidateDrugIndicators(42);
    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: { halfLife: 2 },
      refs: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache an in-flight drug indicator response after invalidation', async () => {
    let resolveStaleJson!: (value: unknown) => void;
    const staleJsonPromise = new Promise<unknown>((resolve) => {
      resolveStaleJson = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => staleJsonPromise,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: { halfLife: 2 }, refs: {} }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const staleRequest = fetchDrugIndicators(42);
    invalidateDrugIndicators(42);
    resolveStaleJson({ comments: { halfLife: 1 }, refs: {} });

    await expect(staleRequest).resolves.toEqual({
      comments: { halfLife: 1 },
      refs: {},
    });
    await expect(fetchDrugIndicators(42)).resolves.toEqual({
      comments: { halfLife: 2 },
      refs: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWikiPageIndicators', () => {
  it('reuses successful topic-page indicator responses independently from drug ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          comments: { 'fact:abc': 3 },
          refs: {},
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWikiPageIndicators(42)).resolves.toEqual({
      comments: { 'fact:abc': 3 },
      refs: {},
    });
    await expect(fetchWikiPageIndicators(42)).resolves.toEqual({
      comments: { 'fact:abc': 3 },
      refs: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/drug-indicators?wikiPageId=42',
    );
  });
});
