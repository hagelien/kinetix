export const MODELING_MODES = ['simulator', 'kinelab', 'ethanol'] as const;
export type ModelingMode = (typeof MODELING_MODES)[number];

const MODE_PARAM = 'mode';

export function isModelingMode(value: unknown): value is ModelingMode {
  return (
    typeof value === 'string' &&
    (MODELING_MODES as readonly string[]).includes(value)
  );
}

/**
 * Build a legacy `/modeling?mode=...` URL. `/modeling` now renders one
 * component-engine workspace; `mode` remains only as a redirect shim for old
 * `/simulator`, `/simulator/ethanol`, and `/kinelab` links.
 */
export function buildModelingUrl(
  mode: ModelingMode,
  extraParams?: URLSearchParams,
): string {
  const params = new URLSearchParams(extraParams ?? undefined);
  params.set(MODE_PARAM, mode);
  return `/modeling?${params.toString()}`;
}
