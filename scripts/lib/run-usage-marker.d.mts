// Types for run-usage-marker.mjs (plain ESM so the Stop hook runs under bare
// `node`; see that file's header).

export interface RunUsageMarker {
  version: 1;
  /** The session id the logger posted (the agent_run_usage row's key). */
  sessionId: string;
  workflow: string;
  runtime: string;
  /** Absolute path of the transcript the logger read. */
  transcript: string;
  notes: string | null;
  /** The logger's working directory, so a re-log loads the same `.env`. */
  cwd: string | null;
  loggedAt: string;
}

export type RelogPlan =
  | { relog: true; args: string[]; cwd: string | null }
  | { relog: false; reason: string };

export declare const MARKER_VERSION: 1;
export declare const MARKER_TTL_MS: number;
export declare const RELOG_WINDOW_MS: number;
export declare const RELOG_ENV: 'KINETIX_RUN_USAGE_RELOG';

export declare function markerDir(env?: NodeJS.ProcessEnv): string;
export declare function safeSessionId(id: unknown): string | null;
export declare function markerPath(
  sessionId: unknown,
  env?: NodeJS.ProcessEnv,
): string | null;
export declare function parseMarker(value: unknown): RunUsageMarker | null;
export declare function writeMarker(
  key: string,
  marker: RunUsageMarker,
  opts?: { env?: NodeJS.ProcessEnv; now?: number },
): string;
export declare function readMarker(
  sessionId: unknown,
  env?: NodeJS.ProcessEnv,
): RunUsageMarker | null;
export declare function consumeMarker(
  sessionId: unknown,
  env?: NodeJS.ProcessEnv,
): RunUsageMarker | null;
export declare function planRelog(
  input: unknown,
  marker: RunUsageMarker | null,
  now?: number,
): RelogPlan;
