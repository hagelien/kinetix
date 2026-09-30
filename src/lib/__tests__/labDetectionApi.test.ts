/**
 * The client cache in front of the gated guideline route.
 *
 * Two things it must get right, and they pull in opposite directions: an answer
 * belongs to the identity that asked for it (a shared browser must not serve
 * one member's restricted table to the next reader), and a FAILURE must not
 * become the answer (a dropped request would otherwise leave a member looking
 * at an empty guideline for the rest of the session, with nothing to retry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_LAB_PAYLOAD,
  fetchLabDetectionTimes,
  resetLabDetectionCache,
} from '../labDetectionApi';
import { SYNTHETIC_LAB_SOURCE } from './fixtures/labSyntheticGuideline';

const PAYLOAD = {
  source: SYNTHETIC_LAB_SOURCE,
  preamble: 'Synthetic preamble …',
  rows: [
    {
      key: 'ketamin',
      parent: 'Ketamin',
      metabolites: [],
      readings: [{ scope: 'both', statement: { kind: 'band', band: 'week' } }],
    },
  ],
  gated: false,
};

const fetchMock = vi.fn();

describe('fetchLabDetectionTimes', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    resetLabDetectionCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetLabDetectionCache();
  });

  it('asks once and serves the same answer afterwards', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD });

    expect(await fetchLabDetectionTimes(1)).toEqual(PAYLOAD);
    expect(await fetchLabDetectionTimes(1)).toEqual(PAYLOAD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again for a different identity, and never reuses the previous one', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD });
    await fetchLabDetectionTimes(1);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...EMPTY_LAB_PAYLOAD, gated: true }),
    });
    expect((await fetchLabDetectionTimes(2)).rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a network failure instead of caching the empty answer', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchLabDetectionTimes(1)).toBe(EMPTY_LAB_PAYLOAD);

    fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD });
    expect(await fetchLabDetectionTimes(1)).toEqual(PAYLOAD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await fetchLabDetectionTimes(1)).toBe(EMPTY_LAB_PAYLOAD);

    fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD });
    expect((await fetchLabDetectionTimes(1)).rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a malformed body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nope: 1 }) });
    expect(await fetchLabDetectionTimes(1)).toBe(EMPTY_LAB_PAYLOAD);

    fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD });
    expect((await fetchLabDetectionTimes(1)).rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no source', { preamble: '', rows: [], gated: false }],
    ['a half-filled source', { ...PAYLOAD, source: { title: 'x' } }],
    ['no preamble', { source: PAYLOAD.source, rows: [], gated: false }],
    [
      'a row with no readings',
      { ...PAYLOAD, rows: [{ ...PAYLOAD.rows[0], readings: [] }] },
    ],
    [
      'a row with no parent',
      { ...PAYLOAD, rows: [{ ...PAYLOAD.rows[0], parent: undefined }] },
    ],
    [
      'metabolites that are not strings',
      { ...PAYLOAD, rows: [{ ...PAYLOAD.rows[0], metabolites: [{}] }] },
    ],
    [
      'a band the module has no label for',
      {
        ...PAYLOAD,
        rows: [
          {
            ...PAYLOAD.rows[0],
            readings: [
              { scope: 'both', statement: { kind: 'band', band: 'fortnight' } },
            ],
          },
        ],
      },
    ],
    [
      'a scope that is not one',
      {
        ...PAYLOAD,
        rows: [{ ...PAYLOAD.rows[0], readings: [{ scope: 'sideways', statement: { kind: 'curves' } }] }],
      },
    ],
  ])('refuses a 200 with %s, and does not cache it', async (_label, body) => {
    // Everything downstream trusts the shape: the index walks `row.parent`,
    // the section reads five fields off `source` during render. A payload that
    // is almost right does not degrade — it throws mid-render.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
    expect(await fetchLabDetectionTimes(1)).toBe(EMPTY_LAB_PAYLOAD);

    fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD });
    expect((await fetchLabDetectionTimes(1)).rows).toHaveLength(1);
  });

  it('keeps a server-sent gated answer, which is a real answer', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...PAYLOAD, rows: [], gated: true }),
    });

    await fetchLabDetectionTimes(1);
    await fetchLabDetectionTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('survives an environment with no fetch at all', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', undefined);

    await expect(fetchLabDetectionTimes(1)).resolves.toBe(EMPTY_LAB_PAYLOAD);
  });
});
