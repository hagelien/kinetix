import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDrugTableSearchResults } from '@/components/drug-table/useDrugTableSearchResults';
import { useDrugStore } from '@/stores/drugStore';
import { fetchDrugs, fetchDrugSearchResults } from '@/lib/drugApi';
import type { DrugComponent } from '@/types';

vi.mock('@/lib/drugApi', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/drugApi')>('@/lib/drugApi');
  return { ...actual, fetchDrugs: vi.fn(), fetchDrugSearchResults: vi.fn() };
});

const fetchDrugsMock = vi.mocked(fetchDrugs);
const fetchDrugSearchResultsMock = vi.mocked(fetchDrugSearchResults);

// Two preloaded catalog drugs; "Morfin" matches the client-side fallback,
// "morfin-3-glukuronid" is intentionally absent to model a DB-only drug that
// only the server search can surface.
const catalog: DrugComponent[] = [
  {
    id: '5288826',
    _dbId: 1,
    names: { nb: 'Morfin', en: 'Morphine' },
    _searchKey: 'morfin\tmorphine',
  },
  {
    id: '2244',
    _dbId: 2,
    names: { nb: 'Paracetamol', en: 'Acetaminophen' },
    _searchKey: 'paracetamol\tacetaminophen',
  },
];

function setQuery(q: string) {
  act(() => {
    useDrugStore.setState({ searchQuery: q });
  });
}

describe('useDrugTableSearchResults', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchDrugsMock.mockReset();
    fetchDrugSearchResultsMock.mockReset();
    act(() => {
      useDrugStore.setState({ components: catalog, searchQuery: '' });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the preloaded catalog and never hits the API with no query', () => {
    const { result } = renderHook(() => useDrugTableSearchResults());
    expect(result.current.components).toEqual(catalog);
    expect(fetchDrugSearchResultsMock).not.toHaveBeenCalled();
    expect(fetchDrugsMock).not.toHaveBeenCalled();
  });

  it('queries the server and surfaces a DB-only drug outside the preload', async () => {
    fetchDrugSearchResultsMock.mockResolvedValue({
      drugs: [
        {
          id: 99,
          slug: 'morphine-3-glucuronide',
          names: { nb: 'morfin-3-glukuronid', en: 'Morphine-3-glucuronide' },
          nameShort: null,
          aliases: null,
          pubchemCid: 5484731,
        },
      ],
    });
    fetchDrugsMock.mockResolvedValue({
      drugs: [
        {
          id: 99,
          slug: 'morphine-3-glucuronide',
          names: { nb: 'morfin-3-glukuronid', en: 'Morphine-3-glucuronide' },
          pubchemCid: 5484731,
          popularityScore: 0,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchDrugs>>);

    const { result } = renderHook(() => useDrugTableSearchResults());
    setQuery('morfin-3-glukuronid');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchDrugSearchResultsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'morfin-3-glukuronid',
        limit: 100,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchDrugsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: [99],
        limit: 1,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.current.components.map((c) => c.names.nb)).toEqual([
      'morfin-3-glukuronid',
    ]);
  });

  it('falls back to client-side filtering when the request fails', async () => {
    fetchDrugSearchResultsMock.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useDrugTableSearchResults());
    setQuery('morfin');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // Server failed, so the preloaded catalog is filtered locally — "Morfin"
    // matches, "Paracetamol" does not. The slim search failed before we could
    // hydrate, so the full-row fetch is never reached.
    expect(fetchDrugsMock).not.toHaveBeenCalled();
    expect(result.current.components.map((c) => c.names.nb)).toEqual([
      'Morfin',
    ]);
  });

  it('aborts stale server searches when the query changes', async () => {
    fetchDrugSearchResultsMock.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the request pending so cleanup is responsible for cancellation.
        }),
    );

    renderHook(() => useDrugTableSearchResults());
    setQuery('mor');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const firstSignal = fetchDrugSearchResultsMock.mock.calls[0]?.[0]?.signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal?.aborted).toBe(false);

    setQuery('morf');

    expect(firstSignal?.aborted).toBe(true);
  });
});
