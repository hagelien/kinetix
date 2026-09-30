/**
 * Binds the reviewed drug catalog (`data/components.ts`) to the pure
 * kinetics-core provenance cross-check as a `CatalogLookup`.
 *
 * This lives in `src/lib/kinetics-provenance/` — NOT in the pure
 * `src/lib/kinetics-core/` package (which must stay dependency-free and never
 * import the app catalog, plan §6), and NOT in `scripts/` (AGENTS.md forbids
 * `src/` tests importing `scripts/`). Both the report generator
 * (`scripts/generate-registry-provenance.ts`) and the vitest provenance suite
 * import this single binding, so the shipped report and the CI gate normalise the
 * catalog identically — they cannot drift apart.
 */
import { embeddedComponents, type RawComponent } from '../../../data/components';
import {
  REGISTRY_PROVENANCE,
  PROVENANCE_REFERENCE_WEIGHT_KG,
  type CatalogLookup,
  type CatalogParams,
  type CatalogRange,
} from '../kinetics-core/provenance';

const byCid = new Map<number, RawComponent>(
  embeddedComponents.map((c) => [c.pubchemCid, c]),
);

/** Normalise a catalog RangeData into a canonical-unit CatalogRange. */
function toRange(
  r: RawComponent['halfLife'] | undefined,
  scale = 1,
): CatalogRange | undefined {
  if (!r) return undefined;
  const point = r.median ?? r.mean;
  const out: CatalogRange = {};
  if (r.min !== undefined) out.min = r.min * scale;
  if (r.max !== undefined) out.max = r.max * scale;
  if (point !== undefined) out.point = point * scale;
  return out.min === undefined && out.max === undefined && out.point === undefined
    ? undefined
    : out;
}

/**
 * The injected catalog lookup: for a registered analyte, the catalog parameters
 * converted into the core's canonical units. Only fields with an unambiguous
 * catalog unit are surfaced; a Vd stated in total litres is converted with the
 * documented reference weight and flagged (see provenance.ts — it can never
 * certify a `catalog` claim).
 */
export const catalogLookup: CatalogLookup = (analyte) => {
  const entry = REGISTRY_PROVENANCE.find((e) => e.analyte === analyte);
  if (!entry) return undefined;
  const c = byCid.get(entry.pubchemCid);
  if (!c) return undefined;

  const params: CatalogParams = { pubchemCid: entry.pubchemCid };

  if (c.halfLife?.unit === 'h') {
    params.eliminationHalfLifeHours = toRange(c.halfLife);
  }

  const vd = c.volumeOfDistribution;
  if (vd?.unit === 'L/kg') {
    params.vdLitersPerKg = toRange(vd);
  } else if (vd?.unit === 'L') {
    params.vdLitersPerKg = toRange(vd, 1 / PROVENANCE_REFERENCE_WEIGHT_KG);
    params.vdFromTotalLiters = true;
  }

  if (c.bioavailability?.unit === 'fraction') {
    params.bioavailability = toRange(c.bioavailability);
  }

  return params;
};
