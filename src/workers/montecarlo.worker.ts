import * as Comlink from 'comlink';
import { installLiveDerivedEntry, simulateScenario } from '@/lib/kinetics-core';
import type { CanonicalSimulationConfig } from '@/types/simulator';

/**
 * Thin isolation boundary around the canonical engine. Scientific equations,
 * distributions and random-number generation deliberately live in
 * kinetics-core; the worker owns no alternative implementation.
 */
function runSimulation(config: CanonicalSimulationConfig) {
  // Resolve through the same live catalogue answers the main thread resolved and will grade by.
  for (const entry of config.liveDerived ?? []) installLiveDerivedEntry(entry);
  return simulateScenario(config.scenario);
}

const monteCarloWorkerApi = {
  runSimulation,
  runMultipleSimulations(configs: CanonicalSimulationConfig[]) {
    return configs.map(runSimulation);
  },
};

export type MonteCarloWorkerApi = typeof monteCarloWorkerApi;
export type CanonicalWorkerResult = ReturnType<typeof runSimulation>;
// Retained as a compile-time migration guard: the worker no longer returns the
// lossy legacy shape; only the main-thread adapter may construct it.
Comlink.expose(monteCarloWorkerApi);
