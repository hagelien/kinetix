import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  saveKinelabCase,
  loadKinelabCase,
  listKinelabCases,
} from '@/lib/kinelabCases';
import {
  KINELAB_CASE_KIND,
  type KineLabCaseData,
} from '@/types/kinelabCase';

const VALID_CASE_DATA: KineLabCaseData = {
  kind: KINELAB_CASE_KIND,
  schemaVersion: 1,
  input: {
    modelId: 'ketamine-one-comp-v0',
    analyte: 'ketamine',
    route: 'oral',
    observations: [
      {
        id: 'obs-1',
        analyte: 'ketamine',
        concentration: { value: 0.2, unit: 'mg/L' },
        matrix: 'whole_blood',
        sampleTime: '2030-01-01T03:00:00.000Z',
      },
    ],
    priors: {
      dose: { type: 'uniform', min: 20, max: 500 },
      halfLife: { type: 'fixed', value: 2.5 },
      vd: { type: 'fixed', value: 210 },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: '2030-01-01T00:00:00.000Z',
        latestIso: '2030-01-01T02:00:00.000Z',
      },
    },
    defaultAssayCV: 0.15,
    gridResolution: 40,
    drawCount: 4000,
    seed: 42,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('kinelabCases — persistence helpers', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs new cases to /api/simulator/cases', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 11,
        name: 'demo',
        caseData: VALID_CASE_DATA,
        createdAt: '2030-01-01T00:00:00Z',
      }),
    );
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    const saved = await saveKinelabCase('demo', VALID_CASE_DATA);
    expect(saved.id).toBe(11);

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('/api/simulator/cases');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string) as {
      name: string;
      caseData: { kind?: string };
    };
    expect(body.name).toBe('demo');
    expect(body.caseData.kind).toBe(KINELAB_CASE_KIND);
  });

  it('PUTs to /api/simulator/cases?id=… when caseId is supplied', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: 7,
        name: 'demo',
        caseData: VALID_CASE_DATA,
        createdAt: '2030-01-01T00:00:00Z',
      }),
    );
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    await saveKinelabCase('demo', VALID_CASE_DATA, 7);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('/api/simulator/cases?id=7');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('rejects loadKinelabCase when the saved row is not a KineLab case', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: 7,
        name: 'forward-sim',
        caseData: { drugs: [], displaySettings: {} },
        createdAt: '2030-01-01T00:00:00Z',
      }),
    );
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    await expect(loadKinelabCase(7)).rejects.toThrow(/not a KineLab case/);
  });

  it('listKinelabCases hits /api/simulator/cases?kind=kinelab-case so caseData is included', async () => {
    // The default list endpoint omits caseData for bandwidth, so client-side
    // filtering would always return [] (regression: PR #232 codex P1).
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        cases: [
          {
            id: 1,
            name: 'kinelab-case',
            caseData: VALID_CASE_DATA,
            createdAt: '2030-01-01T00:00:00Z',
          },
        ],
      }),
    );
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    const rows = await listKinelabCases();
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(1);

    const [url] = fakeFetch.mock.calls[0]!;
    expect(String(url)).toContain('kind=kinelab-case');
  });

  it('listKinelabCases defends against rows that slip through with the wrong kind', async () => {
    // Even with a server-side kind filter, the client double-checks via the
    // discriminator so a buggy backend can't bleed forward-simulator rows in.
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        cases: [
          {
            id: 2,
            name: 'forward-sim',
            caseData: { drugs: [], displaySettings: {} },
            createdAt: '2030-01-01T00:00:00Z',
          },
        ],
      }),
    );
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    const rows = await listKinelabCases();
    expect(rows).toEqual([]);
  });

  it('listKinelabCases tolerates a non-array payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, {})) as unknown as typeof fetch;
    const rows = await listKinelabCases();
    expect(rows).toEqual([]);
  });
});
