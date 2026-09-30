import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchReferenceConcentrations,
  fetchReferenceConcentrationsBatch,
} from './referenceConcentrationsApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchReferenceConcentrationsBatch', () => {
  it('deduplicates ids and fills missing groups with empty arrays', async () => {
    const row = {
      id: 10,
      drugId: 42,
      low: 100,
      high: 200,
      unit: 'ng/mL',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      n: null,
      comments: null,
      citationId: null,
      citation: null,
      createdBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ itemsByDrugId: { '42': [row] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchReferenceConcentrationsBatch([42, 7, 42]),
    ).resolves.toEqual({
      42: [row],
      7: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reference-concentrations?drugIds=42%2C7',
    );
  });

  it('does not call the API for an empty id set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchReferenceConcentrationsBatch([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits requests into chunks that fit the API batch limit', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);
    const row = {
      id: 20,
      drugId: 101,
      low: 10,
      high: 20,
      unit: 'ng/mL',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      n: null,
      comments: null,
      citationId: null,
      citation: null,
      createdBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ itemsByDrugId: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ itemsByDrugId: { '101': [row] } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchReferenceConcentrationsBatch(ids, {
      matrix: 'serum',
    });

    expect(result[1]).toEqual([]);
    expect(result[101]).toEqual([row]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/reference-concentrations?drugIds=${ids.slice(0, 100).join('%2C')}&matrix=serum`,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/reference-concentrations?drugIds=101&matrix=serum',
    );
  });

  it('rejects the batch when any chunk request fails', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);
    const row = {
      id: 30,
      drugId: 1,
      low: 5,
      high: 15,
      unit: 'ng/mL',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      n: null,
      comments: null,
      citationId: null,
      citation: null,
      createdBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ itemsByDrugId: { '1': [row] } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchReferenceConcentrationsBatch(ids)).rejects.toThrow(
      'Failed to fetch reference concentrations: 503',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchReferenceConcentrations', () => {
  it('can bypass browser cache for admin refreshes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchReferenceConcentrations(42, { fresh: true }),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reference-concentrations?drugId=42&fresh=1',
      { cache: 'no-store' },
    );
  });
});
