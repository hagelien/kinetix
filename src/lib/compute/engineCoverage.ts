import {
  hasFirstOrderEngineData,
  hasIvEngineData,
  type EnginePriorFields,
} from './drugPriors';

// ─── KineLab engine coverage ────────────────────────────────────────────────
//
// Answers "how many components can the KineLab engine actually run?" from the
// data, not from a hardcoded allowlist. The engine has always run on any
// component; the limiting factor is whether the drug row carries the priors
// the engine consumes (half-life + Vd + F) or has to synthesize them from
// fallbacks. This module classifies a component catalog into tiers so the
// count stays honest as the catalog is edited (pinned by `engineCoverage.test.ts`).
//
// Ethanol (and any future zero-order analyte) runs on the Widmark branch with
// a literature-derived elimination-rate prior, so it is engine-ready on Vd
// alone; it is reported separately rather than folded into the first-order
// tiers.

/** Minimal shape shared by the seed catalog (`RawComponent`), the API row
 *  (`DrugRow`) and the runtime component (`DrugComponent`). */
export interface CoverageComponent extends EnginePriorFields {
  name: string;
  nameEn?: string;
}

export type EngineTier =
  | 'first-order' // clean oral or IV run: half-life + Vd + F
  | 'iv-only' // half-life + Vd but no F: clean for IV, F falls back otherwise
  | 'zero-order' // ethanol-style Widmark branch
  | 'fallback-only'; // missing half-life or Vd: runs only on synthesized priors

export interface CoverageEntry {
  slug: string;
  name: string;
  tier: EngineTier;
}

export interface EngineCoverage {
  /** Every classified component, in catalog order. */
  entries: CoverageEntry[];
  /** Fully data-complete first-order components (clean run on any route). */
  firstOrder: CoverageEntry[];
  /** Have half-life + Vd but no bioavailability — clean for IV, F synthesized
   *  otherwise. Excludes the `firstOrder` set. */
  ivOnly: CoverageEntry[];
  /** Zero-order (ethanol) analytes. */
  zeroOrder: CoverageEntry[];
  /** Missing half-life or Vd — only runnable on synthesized priors. */
  fallbackOnly: CoverageEntry[];
  /** Total components in the catalog. */
  total: number;
  /** Components the engine can run cleanly on at least one route
   *  (firstOrder ∪ ivOnly ∪ zeroOrder). */
  engineReady: number;
}

/** Slugify a component name the same way the seeder (`generateSlug`) does, so
 *  coverage slugs line up with `drugs.slug` / the runtime analyte id. */
export function coverageSlug(component: CoverageComponent): string {
  return (component.nameEn || component.name)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

// Zero-order analytes are identified by slug — today just ethanol. Kept as a
// set so a future zero-order component (e.g. GHB, if it moves to a saturable
// branch) is a one-line addition.
const ZERO_ORDER_SLUGS = new Set(['ethanol']);

function classify(component: CoverageComponent, slug: string): EngineTier {
  if (ZERO_ORDER_SLUGS.has(slug)) return 'zero-order';
  if (hasFirstOrderEngineData(component)) return 'first-order';
  if (hasIvEngineData(component)) return 'iv-only';
  return 'fallback-only';
}

/** Classify a component catalog into engine-readiness tiers. */
export function computeEngineCoverage(
  components: readonly CoverageComponent[],
): EngineCoverage {
  const entries: CoverageEntry[] = components.map((component) => {
    const slug = coverageSlug(component);
    return {
      slug,
      name: component.nameEn || component.name,
      tier: classify(component, slug),
    };
  });

  const firstOrder = entries.filter((e) => e.tier === 'first-order');
  const ivOnly = entries.filter((e) => e.tier === 'iv-only');
  const zeroOrder = entries.filter((e) => e.tier === 'zero-order');
  const fallbackOnly = entries.filter((e) => e.tier === 'fallback-only');

  return {
    entries,
    firstOrder,
    ivOnly,
    zeroOrder,
    fallbackOnly,
    total: entries.length,
    engineReady: firstOrder.length + ivOnly.length + zeroOrder.length,
  };
}
