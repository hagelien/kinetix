const ETHANOL_DRUG_IDS = new Set(['702', 'ethanol']);

export const ETHANOL_PUBCHEM_CID = 702;
// PR 3: legacy `/simulator/ethanol` is now a redirect to
// `/modeling?mode=ethanol`. The constant points at the canonical URL
// directly so callers in SimulatorPage etc. don't depend on the
// redirect surviving cleanup. Note: `ETHANOL_SIMULATOR_PATH` already
// carries `?mode=ethanol`; consumers appending more params with `?`
// must use `&` to chain (see SimulatorPage's intra-app navigate call).
export const ETHANOL_SIMULATOR_PATH = '/modeling?mode=ethanol';

export function isEthanolDrugId(drugId: string | number | null | undefined): boolean {
  if (drugId == null) return false;
  return ETHANOL_DRUG_IDS.has(String(drugId).toLowerCase());
}

export function getSimulatorPathForDrug(drugId: string | number): string {
  return isEthanolDrugId(drugId)
    ? ETHANOL_SIMULATOR_PATH
    : '/modeling?mode=simulator';
}

export function buildSimulatorUrlForDrug(
  drugId: string | number,
  options?: { conc?: number; concUnit?: string },
): string {
  const mode = isEthanolDrugId(drugId) ? 'ethanol' : 'simulator';
  const params = new URLSearchParams({
    mode,
    drugId: String(drugId),
  });

  if (options?.conc != null && Number.isFinite(options.conc) && options.conc > 0) {
    params.set('conc', String(options.conc));
  }
  if (options?.concUnit) {
    params.set('concUnit', options.concUnit);
  }

  return `/modeling?${params.toString()}`;
}
