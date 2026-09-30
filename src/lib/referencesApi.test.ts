import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDrugReferences } from './referencesApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDrugReferences', () => {
  it('dedupes concurrent reference requests for the same drug', async () => {
    let resolveJson!: (value: unknown) => void;
    const jsonPromise = new Promise<unknown>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => jsonPromise,
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchDrugReferences(42);
    const second = fetchDrugReferences(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/references?drugId=42');

    resolveJson({
      references: [
        {
          id: 10,
          drugId: 42,
          type: 'pmid',
          identifier: '123',
          metadata: null,
          createdAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          id: 10,
          drugId: 42,
          type: 'pmid',
          identifier: '123',
          metadata: null,
          createdAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      [
        {
          id: 10,
          drugId: 42,
          type: 'pmid',
          identifier: '123',
          metadata: null,
          createdAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    ]);
  });
});
