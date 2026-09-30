import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  drugRowToComponent,
  fetchDrugById,
  fetchDrugsByIds,
  fetchDrugByWikiDrugId,
  fetchDrugSearchResults,
  type DrugRow,
} from './drugApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drugRowToComponent', () => {
  it('preserves dynamically merged drug parameter values for table sorting', () => {
    const row = {
      id: 42,
      slug: 'example-drug',
      names: { nb: 'Eksempel', en: 'Example' },
      nameShort: null,
      aliases: null,
      pubchemCid: 12345,
      molecularWeight: 250.1,
      halfLife: null,
      volumeOfDistribution: null,
      bioavailability: null,
      proteinBinding: null,
      bloodPlasmaRatio: null,
      tmax: null,
      pKa: null,
      popularityScore: 7,
      searchKey: null,
      monographSlug: 'example-monograph',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
      ki: { min: 10, max: 20, unit: 'nmol/L' },
      therapeuticDose: { median: 15, unit: 'mg' },
    } as DrugRow & Record<string, unknown>;

    const component = drugRowToComponent(row) as unknown as Record<
      string,
      unknown
    >;

    expect(component.pubchemCid).toBe(12345);
    expect(component._monographSlug).toBe('example-monograph');
    expect(component.ki).toEqual({ min: 10, max: 20, unit: 'nmol/L' });
    expect(component.therapeuticDose).toEqual({ median: 15, unit: 'mg' });
  });

  it('keys a CID-bearing drug by its bare CID (unchanged since before #1256)', () => {
    const row = { id: 42, pubchemCid: 2118 } as DrugRow;
    expect(drugRowToComponent(row).id).toBe('2118');
  });

  it('keys a CID-less drug by its internal id under an explicit drug: prefix (#1256)', () => {
    // Before #1256 this was the bare string '803', indistinguishable from a
    // PubChem CID — the ambiguity a different, CID-bearing drug with
    // pubchem_cid=803 relied on `hydrateComponentByRouteId` resolving first.
    const row = { id: 803, pubchemCid: null } as DrugRow;
    expect(drugRowToComponent(row).id).toBe('drug:803');
  });
});

describe('fetchDrugSearchResults', () => {
  it('forwards AbortSignal to the underlying fetch request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ drugs: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDrugSearchResults({
      q: 'alp',
      limit: 3,
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/drugs?view=search&q=alp&limit=3',
      { signal: controller.signal },
    );
  });
});

describe('fetchDrugById', () => {
  it('dedupes concurrent identical drug row requests', async () => {
    let resolveJson!: (value: { drug: Partial<DrugRow> }) => void;
    const jsonPromise = new Promise<{ drug: Partial<DrugRow> }>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => jsonPromise,
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchDrugById(42);
    const second = fetchDrugById(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/drugs?id=42', undefined);

    resolveJson({
      drug: {
        id: 42,
        slug: 'example-drug',
        names: { en: 'Example' },
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        drug: {
          id: 42,
          slug: 'example-drug',
          names: { en: 'Example' },
        },
      },
      {
        drug: {
          id: 42,
          slug: 'example-drug',
          names: { en: 'Example' },
        },
      },
    ]);
  });
});

describe('fetchDrugsByIds', () => {
  it('dedupes ids and requests a single batched drug lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ drugs: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDrugsByIds([42, 42, 43]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/drugs?ids=42%2C43&limit=2',
      undefined,
    );
  });

  it('does not hit the network for an empty id list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDrugsByIds([])).resolves.toEqual({ drugs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchDrugByWikiDrugId', () => {
  it('dedupes concurrent wiki drug id resolver requests', async () => {
    let resolveJson!: (value: { drug: Partial<DrugRow> }) => void;
    const jsonPromise = new Promise<{ drug: Partial<DrugRow> }>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => jsonPromise,
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchDrugByWikiDrugId(2118);
    const second = fetchDrugByWikiDrugId(2118);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/drugs?wikiDrugId=2118',
      undefined,
    );

    resolveJson({
      drug: {
        id: 42,
        slug: 'alprazolam',
        names: { en: 'Alprazolam' },
        pubchemCid: 2118,
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        drug: {
          id: 42,
          slug: 'alprazolam',
          names: { en: 'Alprazolam' },
          pubchemCid: 2118,
        },
      },
      {
        drug: {
          id: 42,
          slug: 'alprazolam',
          names: { en: 'Alprazolam' },
          pubchemCid: 2118,
        },
      },
    ]);
  });
});
