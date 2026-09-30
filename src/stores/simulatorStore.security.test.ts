import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrugComponent } from '@/types';

vi.mock('@/lib/drugApi', () => ({
  fetchDrugComponentBySlug: vi.fn(),
}));

import { fetchDrugComponentBySlug } from '@/lib/drugApi';
import { useSimulatorStore } from './simulatorStore';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const component: DrugComponent = {
  id: 'ethanol',
  names: { en: 'Ethanol', nb: 'Etanol' },
};

const kinelabCaseData = {
  kind: 'kinelab-case',
  schemaVersion: 1,
  input: {
    modelId: 'ethanol_lite',
    analyte: 'ethanol',
    route: 'oral',
    defaultAssayCV: 0.08,
    drawCount: 1000,
    observations: [
      {
        id: 'obs-private',
        sampleTime: '2026-06-01T12:00:00.000Z',
        concentration: { value: 0.42, unit: 'mg/L' },
      },
    ],
    priors: {
      dose: { kind: 'uniform', min: 20, max: 500 },
    },
    subject: {
      weightKg: 61,
      sex: 'female',
      age: 37,
    },
  },
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchDrugComponentBySlug).mockReset();
  useSimulatorStore.getState().reset();
});

describe('useSimulatorStore auth-bound session isolation', () => {
  it('ignores a KineLab case load that resolves after the simulator session is reset', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({
            id: 101,
            name: 'User A private case',
            caseData: kinelabCaseData,
          }),
        ),
    );
    const delayedDrug = deferred<DrugComponent>();
    vi.mocked(fetchDrugComponentBySlug).mockReturnValue(delayedDrug.promise);

    const load = useSimulatorStore.getState().loadCase(101);
    await vi.waitFor(() => {
      expect(fetchDrugComponentBySlug).toHaveBeenCalledWith('ethanol');
    });

    useSimulatorStore.getState().reset();
    delayedDrug.resolve(component);
    await load;

    expect(useSimulatorStore.getState().caseName).toBe('New Case');
    expect(useSimulatorStore.getState().caseId).toBeNull();
    expect(useSimulatorStore.getState().drugs).toEqual([]);
  });
});
