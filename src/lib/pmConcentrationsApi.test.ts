import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPmConcentrationCache,
  fetchPmConcentrationsByDrugIds,
} from './pmConcentrationsApi';

const GATED = { sources: [], distributions: [], gated: true };

function payload(analyte: string) {
  return {
    sources: [{ key: 'synthetic-test-cohort', unit: 'mg/L' }],
    distributions: [{ analyte, drugId: 1 }],
  };
}

function mockFetch(...responses: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    } as Response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('pmConcentrationsApi cache', () => {
  beforeEach(() => {
    clearPmConcentrationCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves a repeat request for one identity from cache', async () => {
    const fetchMock = mockFetch(payload('Diazepam'));

    const first = await fetchPmConcentrationsByDrugIds([1], 7);
    const second = await fetchPmConcentrationsByDrugIds([1], 7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not serve one account\'s gated payload to the next', async () => {
    // The scenario: a granted member reads the data, signs out, and somebody
    // else signs in — all without a page reload, so this module-level cache
    // survives. Keyed on ids alone it would hand over the previous session's
    // unpublished payload for the rest of the TTL.
    const fetchMock = mockFetch(payload('Diazepam'), GATED);

    const member = await fetchPmConcentrationsByDrugIds([1], 7);
    expect(member.distributions).toHaveLength(1);

    const next = await fetchPmConcentrationsByDrugIds([1], 42);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(next.distributions).toEqual([]);
    expect(next.gated).toBe(true);
  });

  it('re-asks the server after signing out', async () => {
    const fetchMock = mockFetch(payload('Diazepam'), GATED);

    await fetchPmConcentrationsByDrugIds([1], 7);
    const anonymous = await fetchPmConcentrationsByDrugIds([1], null);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anonymous.gated).toBe(true);
  });

  it('does not restore the old payload when the first account returns', async () => {
    // The prune on identity change has to be real: if the entries merely became
    // unreachable by key, signing back in would resurrect a stale payload
    // instead of re-reading the server's current answer.
    const fetchMock = mockFetch(payload('Diazepam'), GATED, GATED);

    await fetchPmConcentrationsByDrugIds([1], 7);
    await fetchPmConcentrationsByDrugIds([1], 42);
    const back = await fetchPmConcentrationsByDrugIds([1], 7);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(back.gated).toBe(true);
  });

  it('treats an id set as one key regardless of order or repeats', async () => {
    const fetchMock = mockFetch(payload('Diazepam'));

    await fetchPmConcentrationsByDrugIds([2, 1], 7);
    await fetchPmConcentrationsByDrugIds([1, 2, 2], 7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when there are no ids', async () => {
    const fetchMock = mockFetch();

    const result = await fetchPmConcentrationsByDrugIds([null, undefined], 7);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.distributions).toEqual([]);
  });
});
