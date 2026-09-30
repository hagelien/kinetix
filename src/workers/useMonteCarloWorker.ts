import { useEffect, useRef, useCallback } from 'react';
import * as Comlink from 'comlink';
import type { MonteCarloWorkerApi } from './montecarlo.worker';
import type { CanonicalSimulationConfig } from '@/types/simulator';
import type { CanonicalResult } from '@/lib/kinetics-core';

export function useMonteCarloWorker() {
  const workerRef = useRef<Worker | null>(null);
  const apiRef = useRef<Comlink.Remote<MonteCarloWorkerApi> | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('./montecarlo.worker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    apiRef.current = Comlink.wrap<MonteCarloWorkerApi>(worker);

    return () => {
      worker.terminate();
      workerRef.current = null;
      apiRef.current = null;
    };
  }, []);

  const runSimulation = useCallback(
    async (config: CanonicalSimulationConfig): Promise<CanonicalResult> => {
      if (!apiRef.current) throw new Error('Worker not initialized');
      return apiRef.current.runSimulation(config);
    },
    [],
  );

  const runMultipleSimulations = useCallback(
    async (
      configs: CanonicalSimulationConfig[],
    ): Promise<CanonicalResult[]> => {
      if (!apiRef.current) throw new Error('Worker not initialized');
      return apiRef.current.runMultipleSimulations(configs);
    },
    [],
  );

  return { runSimulation, runMultipleSimulations };
}
