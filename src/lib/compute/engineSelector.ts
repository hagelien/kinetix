import type { ComputeEngine, EngineId } from './types';
import { LiteBrowserEngine } from './liteBrowserEngine';
import { FullRemoteEngine, type FullRemoteEngineOptions } from './fullRemoteEngine';

export type ComputeMode = 'lite' | 'full';

interface SelectorEnv {
  /** Read at call time so tests can stub `import.meta.env`. */
  computeMode?: string;
}

function readEnv(): SelectorEnv {
  // Vite exposes browser-safe variables under `import.meta.env`. Server-side
  // code (api/jobs/*) reads `process.env.KINELAB_FULL_COMPUTE_ENABLED`
  // separately — keep client and server boundaries explicit.
  //
  // Written as ONE literal `import.meta.env` member expression on purpose: Vite replaces the flag
  // statically by matching that expression, and reading it through an alias leaves a live
  // `import.meta.env` in the bundle, where a browser module has no `env` and the flag is dead
  // however it is set. `tests/env-flag-static-replacement.test.ts` pins the form.
  const mode = import.meta.env?.VITE_KINELAB_COMPUTE_MODE;
  return typeof mode === 'string' ? { computeMode: mode } : {};
}

export interface GetComputeEngineOptions {
  /** Force a specific mode regardless of env. */
  mode?: ComputeMode;
  full?: FullRemoteEngineOptions;
}

export function resolveComputeMode(
  envOverride?: SelectorEnv,
): ComputeMode {
  const env = envOverride ?? readEnv();
  return env.computeMode === 'full' ? 'full' : 'lite';
}

let liteSingleton: LiteBrowserEngine | null = null;

export function getComputeEngine(opts: GetComputeEngineOptions = {}): ComputeEngine {
  const mode = opts.mode ?? resolveComputeMode();
  if (mode === 'full') {
    return new FullRemoteEngine(opts.full);
  }
  liteSingleton ??= new LiteBrowserEngine();
  return liteSingleton;
}

export function clearComputeEngineCache(): void {
  liteSingleton = null;
}

export type { EngineId };
