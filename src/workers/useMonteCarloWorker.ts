import { useEffect, useRef, useCallback } from 'react';
import * as Comlink from 'comlink';
import type { MonteCarloWorkerApi } from './montecarlo.worker';
import type { CanonicalSimulationConfig } from '@/types/simulator';
import { liveDerivedEntries, type CanonicalResult } from '@/lib/kinetics-core';

/** Carry the main thread's live catalogue answers with a run (see `CanonicalSimulationConfig`),
 *  unless the caller already pinned the answers its run must use. */
export function withLiveDerived(config: CanonicalSimulationConfig): CanonicalSimulationConfig {
  if (config.liveDerived) return config;
  const live = liveDerivedEntries();
  return live.length === 0 ? config : { ...config, liveDerived: live };
}

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
      return apiRef.current.runSimulation(withLiveDerived(config));
    },
    [],
  );

  const runMultipleSimulations = useCallback(
    async (
      configs: CanonicalSimulationConfig[],
    ): Promise<CanonicalResult[]> => {
      if (!apiRef.current) throw new Error('Worker not initialized');
      return apiRef.current.runMultipleSimulations(configs.map(withLiveDerived));
    },
    [],
  );

  return { runSimulation, runMultipleSimulations };
}
