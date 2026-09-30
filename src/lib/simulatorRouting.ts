export type SimulatorMode = 'standard' | 'workbook-ethanol';

export interface SimulatorDrugRef {
  id?: string | number | null;
  pubchemCid?: number | null;
  dbId?: string | number | null;
}

export interface SimulatorRouteOptions {
  concentration?: number;
  concentrationUnit?: string;
}

const ETHANOL_PUBCHEM_CID = 702;

function normalizeId(value: string | number | null | undefined): string {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

/**
 * Decide which simulator implementation should be used for a drug.
 *
 * CID is the primary stable identifier. The fallback only matches identifiers
 * that explicitly carry a CID/PubChem prefix; a bare `"702"` is ambiguous with
 * an internal DB serial and must not route to the ethanol workbook.
 */
export function resolveSimulatorModeForDrug(drug: SimulatorDrugRef): SimulatorMode {
  if (typeof drug.pubchemCid === 'number') {
    return drug.pubchemCid === ETHANOL_PUBCHEM_CID ? 'workbook-ethanol' : 'standard';
  }

  const normalizedId = normalizeId(drug.id);
  if (normalizedId === 'cid:702' || normalizedId === 'pubchem:702') {
    return 'workbook-ethanol';
  }

  return 'standard';
}

/**
 * Build an app URL for simulator launch with centralized mode dispatch.
 *
 * Routes to `/modeling?mode=ethanol` for ethanol (CID 702) and
 * `/modeling?mode=simulator` for everything else, plus drug-specific
 * query params. The legacy `/simulator(/ethanol)` paths still exist as
 * redirects, but new links jump straight to the canonical URL so we
 * skip the redirect hop and don't depend on the redirect surviving any
 * future cleanup.
 */
export function buildSimulatorUrl(
  drug: SimulatorDrugRef,
  options: SimulatorRouteOptions = {},
): string {
  const simMode = resolveSimulatorModeForDrug(drug);
  const params = new URLSearchParams();
  params.set('mode', simMode === 'workbook-ethanol' ? 'ethanol' : 'simulator');

  if (drug.id != null && String(drug.id).length > 0) {
    params.set('drugId', String(drug.id));
  }
  if (typeof options.concentration === 'number' && Number.isFinite(options.concentration) && options.concentration > 0) {
    params.set('conc', String(options.concentration));
  }
  if (options.concentrationUnit) {
    params.set('concUnit', options.concentrationUnit);
  }

  return `/modeling?${params.toString()}`;
}
