import { useEffect, useRef, useCallback } from 'react';
import * as Comlink from 'comlink';
import type {
  InferenceWorkerApi,
  RunInferenceArgs,
  RunScenarioComparisonArgs,
  WorkerInferenceOutput,
  WorkerScenarioComparisonOutput,
} from './inference.worker';

export function useInferenceWorker() {
  const workerRef = useRef<Worker | null>(null);
  const apiRef = useRef<Comlink.Remote<InferenceWorkerApi> | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./inference.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    apiRef.current = Comlink.wrap<InferenceWorkerApi>(worker);

    return () => {
      worker.terminate();
      workerRef.current = null;
      apiRef.current = null;
    };
  }, []);

  const runInference = useCallback(
    async (args: RunInferenceArgs): Promise<WorkerInferenceOutput> => {
      if (!apiRef.current) throw new Error('Inference worker not initialized');
      return apiRef.current.runInference(args);
    },
    [],
  );

  const runScenarioComparison = useCallback(
    async (
      args: RunScenarioComparisonArgs,
    ): Promise<WorkerScenarioComparisonOutput> => {
      if (!apiRef.current) throw new Error('Inference worker not initialized');
      return apiRef.current.runScenarioComparison(args);
    },
    [],
  );

  return { runInference, runScenarioComparison };
}
