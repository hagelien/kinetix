/**
 * Registry ↔ catalog provenance cross-check.
 *
 * The harmonization plan (§18, and the "registry provenance follow-up" in
 * `docs/kinetics-core/roadmap.md`) requires the reviewed drug catalog
 * (`data/components.ts`) to be the single author-time source for the frozen,
 * checksummed `registry.ts` release — while the run-time engine still consumes an
 * immutable, pinned snapshot (never live catalog rows). This module is the bridge
 * that keeps those two honest: it cross-checks every registry parameter that the
 * catalog can speak to, and turns an *undeclared* divergence into a detectable
 * failure.
 *
 * Why not simply auto-generate the whole registry from the catalog? Because the
 * catalog cannot supply a runnable model on its own (plan §3: "a drug-monograph
 * row is not automatically a runnable model"):
 *   - it has no first-order absorption rate (`kaPerHour`) — absorption is
 *     route-specific and reviewer-supplied (see `NOT_IN_CATALOG_PARAMS`);
 *   - it carries a single bioavailability, not the per-route split a model needs;
 *   - several fields are noisy auto-extractions (wrong units, stray metabolites).
 * So the registry stays hand-authored and reviewed, and this cross-check enforces
 * the weaker-but-real guarantee the plan actually needs: any registry parameter
 * declared to *track* the catalog must stay within tolerance of it, and any
 * parameter that intentionally departs must carry a recorded reviewer rationale.
 *
 * This module is PURE (no catalog import, no I/O): the catalog is injected as a
 * `CatalogLookup`, so the core stays dependency-free and Hermes-safe. The
 * app-level generator script and the test supply the real catalog; unit tests can
 * supply a synthetic one. `REGISTRY_PROVENANCE` below is the reviewed author-time
 * annotation — the "single reviewed source" decision for each parameter.
 */
import type { RouteId, RouteModelParams, VdScaling } from './types.js';
import { centralValue } from './param.js';
import { findModel, registeredAnalytes, REGISTRY_VERSION } from './registry.js';

/**
 * A catalog anchor for one parameter, normalised into the core's canonical units
 * (hours, L/kg, 0-1 fraction). Either a `[min, max]` range, a central `point`
 * (median/mean), or both — whatever the catalog entry provides.
 */
export interface CatalogRange {
  min?: number;
  max?: number;
  /** Central value (catalog median, or mean when no median is given). */
  point?: number;
}

/** Catalog parameters for one analyte, normalised to canonical units. */
export interface CatalogParams {
  pubchemCid?: number;
  /** From catalog `halfLife` when its unit is hours. */
  eliminationHalfLifeHours?: CatalogRange;
  /** From catalog `volumeOfDistribution`; see `vdFromTotalLiters`. */
  vdLitersPerKg?: CatalogRange;
  /**
   * True when `vdLitersPerKg` was derived from a total-litre catalog value using
   * `PROVENANCE_REFERENCE_WEIGHT_KG`. That conversion assumes a body weight the
   * catalog did not state, so a comparison against it is informational only and
   * must never gate (a `catalog`-sourced Vd is only allowed against an explicit
   * L/kg catalog value).
   */
  vdFromTotalLiters?: boolean;
  /** From catalog `bioavailability` when its unit is a fraction. */
  bioavailability?: CatalogRange;
}

/** Injected catalog access, keyed by canonical analyte id. Keeps core pure. */
export type CatalogLookup = (analyte: string) => CatalogParams | undefined;

/**
 * Reference body weight used ONLY to convert a catalog Vd given in total litres
 * into L/kg for a rough comparison. It is never used in a simulation and never
 * gates a result — see `vdFromTotalLiters`.
 */
export const PROVENANCE_REFERENCE_WEIGHT_KG = 70;

/** Registry parameters the catalog can speak to (and this module cross-checks). */
export type CheckableParam =
  | 'eliminationHalfLifeHours'
  | 'vdLitersPerKg'
  | 'bioavailability';

export const CHECKABLE_PARAMS: readonly CheckableParam[] = [
  'eliminationHalfLifeHours',
  'vdLitersPerKg',
  'bioavailability',
];

/**
 * Registry parameters the catalog structurally cannot supply, so they are never
 * cross-checked and are always reviewer-authored:
 *   - `kaPerHour`  — first-order absorption rate (route-specific, no catalog field);
 *   - `vdScaling`  — total-weight vs lean-body-mass Vd scaling (a modelling choice
 *     that materially changes concentrations but has no catalog analogue).
 * Both are surfaced per route in the provenance report (see
 * `reviewerAuthoredRouteParams`) so a change is a recorded, diffable decision
 * rather than a silent one.
 */
export const NOT_IN_CATALOG_PARAMS = [
  'kaPerHour',
  'vdScaling',
  'absorptionLagHours',
  'zeroOrderDurationHours',
  'firstOrderFraction',
] as const;

/** A reviewer-authored (non-catalog-checkable) route parameter summary. */
export interface ReviewerAuthoredRoute {
  analyte: string;
  route: RouteId;
  family: string;
  /** Absorption rate; null for families with no first-order absorption phase (IV, zero-order). */
  kaPerHour: number | null;
  /**
   * Zero-order (constant-rate) input duration in hours (SC-4A) — a reviewer-authored
   * value with no catalog analogue, present for the `one-compartment-zero-order` and
   * `one-compartment-mixed-order` families, so a change to a controlled-release duration
   * is a diffable decision.
   */
  zeroOrderDurationHours?: number;
  /**
   * Fraction of the absorbed dose entering via the first-order pathway (SC-4A) — a
   * reviewer-authored value with no catalog analogue, present only for the
   * `one-compartment-mixed-order` family, so a change to the parallel-input split is a
   * diffable decision.
   */
  firstOrderFraction?: number;
  /** Inter-compartmental micro-rates (per hour); present for two-compartment only. */
  k12PerHour?: number;
  k21PerHour?: number;
  /** Saturable-elimination params (mg/L·h⁻¹, mg/L); present for Michaelis–Menten only. */
  vmaxMgPerLPerHour?: number;
  kmMgPerL?: number;
  /**
   * Parent→metabolite formation, stoichiometry and per-species disposition (SC-3A);
   * present for the parent-metabolite family only. ALL of these are reviewer-authored:
   * the formation fraction and molar masses have no catalog analogue, and the
   * per-species disposition (parent/metabolite elimination half-lives and Vd/kg) is
   * skipped by the catalog cross-check too — that gate compares a single terminal-t½/Vd
   * scalar, which this family does not carry. Recording them here makes a change to the
   * coupling OR either species' disposition a diffable provenance decision (rendered
   * into the committed report), not just an opaque registry-checksum change. The
   * metabolite analyte id is recorded since it defines which additional analyte the
   * family emits.
   */
  formationFraction?: number;
  parentMolarMass?: number;
  metaboliteMolarMass?: number;
  metaboliteAnalyte?: string;
  parentEliminationHalfLifeHours?: number;
  parentVdLitersPerKg?: number;
  metaboliteEliminationHalfLifeHours?: number;
  metaboliteVdLitersPerKg?: number;
  /**
   * The Vd scaling mode actually in effect (defaulted, so a silent fallback shows),
   * or `null` for a family that applies NO subject Vd scaling — the structural
   * CL/Vc family uses reference-subject absolute volumes (covariate/allometric
   * scaling is S2), so reporting `total-weight` here would be false audit data.
   */
  vdScaling: VdScaling | null;
  /**
   * Absorption lag time `tlag` (h), SC-4A — a reviewer-authored value with no catalog
   * analogue. Present only for a first-order route that declares one, so changing a
   * route's lag (which materially changes its curve) is a diffable provenance decision
   * rather than a silent one.
   */
  absorptionLagHours?: number;
}

/**
 * Every registered route's reviewer-authored parameters — the ones the catalog
 * cross-check cannot cover. Rendered into the committed provenance report so a
 * change to absorption or Vd-scaling mode is a visible, reviewable diff (and the
 * generator's `--check` fails on a stale report), closing the gap where a route
 * could switch scaling mode with no recorded decision.
 */
export function reviewerAuthoredRouteParams(): ReviewerAuthoredRoute[] {
  const out: ReviewerAuthoredRoute[] = [];
  for (const analyte of registeredAnalytes()) {
    const model = findModel(analyte);
    if (!model) continue;
    for (const routeId of Object.keys(model.routes) as RouteId[]) {
      const p = model.routes[routeId];
      if (!p) continue;
      out.push({
        analyte,
        route: routeId,
        family: p.family,
        kaPerHour:
          p.family === 'iv-one-compartment' || p.family === 'one-compartment-zero-order'
            ? null
            : centralValue(p.kaPerHour),
        ...(p.family === 'one-compartment-zero-order'
          ? { zeroOrderDurationHours: centralValue(p.zeroOrderDurationHours) }
          : {}),
        ...(p.family === 'one-compartment-mixed-order'
          ? {
              zeroOrderDurationHours: centralValue(p.zeroOrderDurationHours),
              firstOrderFraction: centralValue(p.firstOrderFraction),
            }
          : {}),
        ...(p.family === 'two-compartment-first-order'
          ? { k12PerHour: centralValue(p.k12PerHour), k21PerHour: centralValue(p.k21PerHour) }
          : {}),
        ...(p.family === 'michaelis-menten'
          ? {
              vmaxMgPerLPerHour: centralValue(p.vmaxMgPerLPerHour),
              kmMgPerL: centralValue(p.kmMgPerL),
            }
          : {}),
        ...(p.family === 'parent-metabolite-first-order'
          ? {
              formationFraction: centralValue(p.formationFraction),
              parentMolarMass: p.parentMolarMass,
              metaboliteMolarMass: p.metaboliteMolarMass,
              metaboliteAnalyte: p.metaboliteAnalyte,
              parentEliminationHalfLifeHours: centralValue(p.parentEliminationHalfLifeHours),
              parentVdLitersPerKg: centralValue(p.parentVdLitersPerKg),
              metaboliteEliminationHalfLifeHours: centralValue(
                p.metaboliteEliminationHalfLifeHours,
              ),
              metaboliteVdLitersPerKg: centralValue(p.metaboliteVdLitersPerKg),
            }
          : {}),
        // The structural CL/Vc family applies NO subject Vd scaling (reference-subject
        // absolute volumes; covariate scaling is S2), so record `null` rather than a
        // `total-weight` placeholder that would misreport the model as subject-scaled.
        vdScaling: p.family === 'one-compartment-clv' ? null : p.vdScaling ?? 'total-weight',
        // Absorption lag (SC-4A) is reviewer-authored with no catalog analogue; record
        // it whenever a first-order route declares one so a lag change is diffable.
        ...(('absorptionLagHours' in p && p.absorptionLagHours)
          ? { absorptionLagHours: centralValue(p.absorptionLagHours) }
          : {}),
      });
    }
  }
  return out;
}

/** One reviewed latent→observed matrix conversion a model declares (SC-5A). */
export interface DeclaredMatrixTransform {
  /** The model this transform belongs to (its primary analyte id). */
  model: string;
  /** The analyte this conversion applies to (the primary when the transform omits it). */
  analyte: string;
  from: string;
  to: string;
  ratio: number;
  rationale: string;
}

/**
 * Every registered model's declared matrix transforms (SC-5A) — reviewed latent→observed
 * conversions with no catalog analogue. Surfaced in the committed provenance report so a
 * change to a conversion ratio (which rescales every reported concentration) is a visible,
 * reviewable diff rather than a silent one. Empty until a reviewed model declares one.
 */
export function declaredMatrixTransforms(): DeclaredMatrixTransform[] {
  const out: DeclaredMatrixTransform[] = [];
  for (const analyte of registeredAnalytes()) {
    const model = findModel(analyte);
    if (!model) continue;
    for (const t of model.matrixTransforms ?? []) {
      out.push({
        model: analyte,
        analyte: t.analyte ?? analyte,
        from: t.from,
        to: t.to,
        ratio: t.ratio,
        rationale: t.rationale,
      });
    }
  }
  return out;
}

/** One reviewed observation residual-error layer a model declares (SC-5B). */
export interface DeclaredObservationError {
  /** The model this layer belongs to (its primary analyte id). */
  model: string;
  /** The analyte the layer applies to (the primary when the layer omits it). */
  analyte: string;
  layer: string;
  proportionalCv: number | undefined;
  additiveSd: number | undefined;
  rationale: string;
}

/**
 * Every registered model's declared observation residual-error layers (SC-5B) — reviewer-
 * authored measurement-error components with no catalog analogue. Surfaced in the committed
 * provenance report so a change to a CV or additive SD (which widens every reported band) is
 * a visible, reviewable diff. Empty until a reviewed model declares one.
 */
export function declaredObservationError(): DeclaredObservationError[] {
  const out: DeclaredObservationError[] = [];
  for (const analyte of registeredAnalytes()) {
    const model = findModel(analyte);
    if (!model) continue;
    for (const l of model.observationError ?? []) {
      out.push({
        model: analyte,
        analyte: l.analyte ?? analyte,
        layer: l.layer,
        proportionalCv: l.proportionalCv,
        additiveSd: l.additiveSd,
        rationale: l.rationale,
      });
    }
  }
  return out;
}

export type ProvenanceSource =
  /** Declared to track the catalog: MUST stay within tolerance (the anti-drift gate). */
  | 'catalog'
  /** Intentionally departs from the catalog: a `rationale` is required. */
  | 'reviewed-override';

export interface ParamProvenance {
  source: ProvenanceSource;
  /** Required for `reviewed-override`; ignored for `catalog`. */
  rationale?: string;
}

/**
 * Per-analyte provenance annotations. A parameter is keyed by `RouteId`, or by
 * `'*'` when the same decision applies to every route the model declares (e.g. a
 * disposition parameter shared across routes). A route-specific entry wins over
 * `'*'`.
 */
export type RouteKey = RouteId | '*';

export interface RegistryProvenanceEntry {
  analyte: string;
  /** Stable catalog identity — the generator/test match the catalog on this. */
  pubchemCid: number;
  params: Partial<Record<CheckableParam, Partial<Record<RouteKey, ParamProvenance>>>>;
}

/**
 * The reviewed author-time provenance for the current registry release.
 *
 * This is the record the plan asks for: for every catalog-checkable registry
 * parameter, an explicit reviewer decision — either "this tracks the catalog"
 * (and the test enforces that it does) or "this intentionally departs, here is
 * why". Bump alongside `REGISTRY_VERSION` when a model is added or a decision
 * changes.
 */
export const REGISTRY_PROVENANCE: RegistryProvenanceEntry[] = [
  {
    analyte: 'amphetamine',
    pubchemCid: 3007,
    params: {
      // Catalog half-life 9-11 h; registry 11 h sits at the upper bound.
      eliminationHalfLifeHours: { '*': { source: 'catalog' } },
      // Catalog Vd 4 L/kg; registry 4.0 L/kg — exact.
      vdLitersPerKg: { '*': { source: 'catalog' } },
      // Catalog carries a single F≈0.75; the model needs a per-route split, so
      // each route is a reviewed departure from that single value.
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale:
            'Route-split of the single catalog F≈0.75: oral 0.80 (well-absorbed sulphate salt).',
        },
        intranasal: {
          source: 'reviewed-override',
          rationale:
            'Route-split of the single catalog F≈0.75: intranasal 0.70.',
        },
      },
    },
  },
  {
    analyte: 'cocaine',
    pubchemCid: 446220,
    params: {
      // Catalog half-life 0.5-1.5 h; registry 1.5 h sits at the upper bound.
      eliminationHalfLifeHours: { '*': { source: 'catalog' } },
      // Catalog Vd is an auto-extracted TOTAL-litre value (~266 L ≈ 3.8 L/kg at
      // the 70 kg reference), not a per-kg figure; 2.7 L/kg is the reviewed
      // literature value. A departure by construction, not drift.
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale:
            'Catalog Vd is a total-litre auto-extraction (~3.8 L/kg @70 kg); 2.7 L/kg is the reviewed literature value (Chow 1985, Clin Pharmacol Ther 38:318, Vd ~1.6-2.7 L/kg).',
        },
      },
      // Catalog F 0.57 is a generic single absolute value; the model needs a
      // per-route split, so each route is a reviewed departure from it (plan B1:
      // ship reviewed literature values, not the legacy mirror). Notably the
      // generic catalog 0.57 coincides with Jeffcoat's OBSERVED smoked value, so
      // the inhalation route matches the catalog figure while the other routes
      // are the reviewed per-route literature values.
      bioavailability: {
        intranasal: {
          source: 'reviewed-override',
          rationale:
            'Intranasal cocaine: 0.80 measured nasal-insufflation bioavailability (Jeffcoat 1989, Drug Metab Dispos 17:153-159), above the generic catalog 0.57.',
        },
        inhalation: {
          source: 'reviewed-override',
          rationale:
            'Smoked/crack cocaine: 0.57 OBSERVED smoked bioavailability (Jeffcoat 1989, Drug Metab Dispos 17:153-159) — intact drug is well absorbed but the observed value is reduced by pyrolytic degradation on heating. Evidence-faithful (matches Jeffcoat and the generic catalog 0.57), not rounded up.',
        },
        oral: {
          source: 'reviewed-override',
          rationale:
            'Oral cocaine: 0.33 reviewed bioavailability after extensive first-pass (Wilkinson 1980, Clin Pharmacol Ther 27:386-394, oral F ~0.32).',
        },
      },
    },
  },
  // Linear-model migration wave (R5). These MIRROR Redose's legacy parameters as
  // the harmonization baseline, so every checkable parameter is a reviewed
  // override relative to the (often absent or noisy) catalog value — the value is
  // pinned to reproduce the legacy curve, independent of catalog drift.
  {
    analyte: 'methylphenidate',
    pubchemCid: 4158,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy t½ 2.5 h (harmonization baseline); catalog ~2.4 h.',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy Vd 2.5 L/kg (harmonization baseline); catalog ~2.23 L/kg.',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy oral F 0.30 (harmonization baseline).',
        },
        intranasal: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy intranasal F 0.55 (harmonization baseline).',
        },
      },
    },
  },
  {
    analyte: 'lsd',
    pubchemCid: 5761,
    params: {
      // 3.0 h is within 10% of the catalog central 2.92 h (auto-extracted).
      eliminationHalfLifeHours: { '*': { source: 'catalog' } },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy Vd 0.65 L/kg (harmonization baseline); catalog reports 0.47 L/kg (Dolder 2017).',
        },
      },
      bioavailability: {
        sublingual: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy sublingual F 0.70 (harmonization baseline); catalog has no F for LSD.',
        },
      },
    },
  },
  {
    analyte: '2cb',
    pubchemCid: 62065,
    params: {
      // 3.0 h sits inside the catalog range 2–4 h (limited human data).
      eliminationHalfLifeHours: { '*': { source: 'catalog' } },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy Vd 2.0 L/kg (harmonization baseline); catalog has no Vd for 2C-B.',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy oral F 0.70 (harmonization baseline); catalog has no F for 2C-B.',
        },
        intranasal: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy intranasal F 0.65 (harmonization baseline); catalog has no F for 2C-B.',
        },
      },
    },
  },
  {
    analyte: 'thc',
    pubchemCid: 16078,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Terminal t½ 28 h mirrors Redose legacy; catalog half-life varies widely by matrix/use pattern.',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'This is the CENTRAL volume V1 (0.27 L/kg), not the large apparent steady-state Vd the catalog reports; tissue loading is captured by k12/k21.',
        },
      },
      bioavailability: {
        inhalation: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy inhaled F 0.25 (harmonization baseline).',
        },
        oral: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy oral F 0.06 (first-pass metabolism).',
        },
      },
    },
  },
  // Michaelis–Menten migration wave (A3). Saturable elimination (Vmax/Km) is not
  // catalog-checkable and is surfaced in the reviewer-authored table; the nominal
  // terminal half-life here is a display/horizon value, NOT real elimination, so
  // it is a reviewed override even where a catalog half-life exists.
  {
    analyte: 'ghb',
    pubchemCid: 10413,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale:
            'Nominal terminal t½ 1.2 h (horizon/display only); GHB elimination is saturable (Vmax/Km). Catalog ~0.37 h is an auto-extraction.',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy Vd 0.4 L/kg (harmonization baseline); catalog range 0.4–0.8 L/kg.',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy oral F 0.60 (harmonization baseline); catalog ~0.25 is an auto-extraction.',
        },
      },
    },
  },
  {
    analyte: 'ethanol',
    pubchemCid: 702,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale:
            'Nominal terminal t½ 6 h (horizon/display only); ethanol elimination is zero-order-like saturable (Vmax/Km). Catalog ~0.25 h is an auto-extraction.',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale:
            'vdLitersPerKg = 1 is a Widmark placeholder — the real Vd is weight·r (r≈0.55–0.68 from the subject), so the effective L/kg matches the catalog 0.53–0.6 body-water range.',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy oral F 0.85 (harmonization baseline).',
        },
      },
    },
  },
  {
    analyte: 'mdma',
    pubchemCid: 1615,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale:
            'Nominal terminal t½ 8 h (horizon/display only); MDMA elimination is saturable (Vmax/Km auto-inhibition). Catalog ~8.6 h is an auto-extraction.',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy Vd 6.5 L/kg (lipophilic, harmonization baseline); catalog range 4–6 L/kg.',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy oral F 0.70 (harmonization baseline).',
        },
      },
    },
  },
  {
    analyte: 'lisdexamfetamine',
    pubchemCid: 11597698,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Released d-amphetamine disposition t½ 11 h (mirrors amphetamine); lisdexamfetamine is not in the catalog.',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Released d-amphetamine Vd 4.0 L/kg (mirrors amphetamine, lipophilic); lisdexamfetamine is not in the catalog.',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'F 0.30 folds the ~0.295 mg-amphetamine-per-mg-prodrug mass conversion with near-complete availability (Redose baseline).',
        },
      },
    },
  },
  {
    analyte: 'ketamine',
    pubchemCid: 3821,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Terminal t½ 2.5 h (mirrors Redose); the catalog 0.17–0.25 h is the α-distribution phase, not terminal elimination.',
        },
      },
      // Catalog Vd 2.3–5 L/kg; registry 3.0 sits inside that range.
      vdLitersPerKg: { '*': { source: 'catalog' } },
      bioavailability: {
        intranasal: { source: 'reviewed-override', rationale: 'Mirrors Redose legacy intranasal F 0.35 (harmonization baseline).' },
        im: { source: 'reviewed-override', rationale: 'Mirrors Redose legacy IM F 0.93 (harmonization baseline).' },
        oral: { source: 'reviewed-override', rationale: 'Mirrors Redose legacy oral F 0.20 (harmonization baseline).' },
      },
    },
  },
  {
    analyte: 'psilocybin',
    // Modelled as the psilocin active moiety; psilocybin itself is not a catalog
    // row, so the identity is psilocin (pubchem 4980).
    pubchemCid: 4980,
    params: {
      eliminationHalfLifeHours: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy psilocin-equivalent terminal t½ 2.5 h (harmonization baseline).',
        },
      },
      vdLitersPerKg: {
        '*': {
          source: 'reviewed-override',
          rationale: 'Mirrors Redose legacy Vd 1.0 L/kg (hydrophilic, harmonization baseline).',
        },
      },
      bioavailability: {
        oral: {
          source: 'reviewed-override',
          rationale: 'F 0.50 folds oral availability + psilocybin→psilocin conversion (Redose baseline).',
        },
      },
    },
  },
];

const PROVENANCE_BY_ANALYTE: Map<string, RegistryProvenanceEntry> = new Map(
  REGISTRY_PROVENANCE.map((e) => [e.analyte, e]),
);

/** The reviewed provenance decision for one (analyte, route, param) slot. */
export function provenanceFor(
  analyte: string,
  route: RouteId,
  param: CheckableParam,
): ParamProvenance | undefined {
  const byParam = PROVENANCE_BY_ANALYTE.get(analyte)?.params[param];
  if (!byParam) return undefined;
  return byParam[route] ?? byParam['*'];
}

export type Classification =
  | 'within-range'
  | 'near-point'
  | 'divergent'
  | 'no-catalog-value';

/** A value is catalog-consistent when it lands in the range or near the point. */
export function isCatalogConsistent(c: Classification): boolean {
  return c === 'within-range' || c === 'near-point';
}

const RANGE_EPSILON = 1e-9;
const DEFAULT_REL_TOL = 0.1;

function classify(
  value: number,
  range: CatalogRange | undefined,
  relTol: number,
): Classification {
  if (!range) return 'no-catalog-value';
  const { min, max, point } = range;
  // A complete [min, max] range is a HARD bound: when the catalog states both
  // ends, a value outside it is divergent even if it happens to be near the
  // central point. The point tolerance is only a fallback for rows that give a
  // central value without a full range — otherwise a catalog-tracking parameter
  // could drift past the reviewed bounds and still pass as `near-point`.
  if (min !== undefined && max !== undefined) {
    const lo = min * (1 - RANGE_EPSILON);
    const hi = max * (1 + RANGE_EPSILON);
    return value >= lo && value <= hi ? 'within-range' : 'divergent';
  }
  if (point !== undefined) {
    const denom = Math.max(Math.abs(point), 1e-12);
    if (Math.abs(value - point) / denom <= relTol) return 'near-point';
    return 'divergent';
  }
  // Only a one-sided bound (or nothing) — too weak to certify consistency.
  return min === undefined && max === undefined ? 'no-catalog-value' : 'divergent';
}

export interface CrossCheckRow {
  analyte: string;
  route: RouteId;
  param: CheckableParam;
  registryValue: number;
  catalog?: CatalogRange;
  /** True when `catalog` was derived from a total-litre Vd (informational only). */
  vdFromTotalLiters?: boolean;
  classification: Classification;
  /** The reviewed decision, or undefined when no annotation exists (a gap). */
  provenance?: ParamProvenance;
  /**
   * The gate. True when the reviewed decision and the measured reality disagree:
   *   - a `catalog`-sourced parameter that is NOT catalog-consistent (drift), or
   *   - any checkable parameter with no provenance annotation (an unreviewed gap).
   * `reviewed-override` never trips the gate — a documented departure is allowed.
   */
  undeclaredDivergence: boolean;
}

export interface CrossCheckReport {
  registryVersion: string;
  referenceWeightKg: number;
  relTolerance: number;
  rows: CrossCheckRow[];
  /** Rows that failed the gate. Empty means the registry is provenance-clean. */
  undeclared: CrossCheckRow[];
}

function registryValueFor(
  route: RouteModelParams | undefined,
  param: CheckableParam,
): number | undefined {
  if (!route) return undefined;
  // The structural CL/Vc family (SC-1A) is parameterised by clearance/volume, not
  // by a terminal half-life or an L/kg Vd, so it has none of the catalog-checkable
  // scalars this anti-drift gate compares. Structural-parameter provenance is a
  // registry-v2 concern (SC-8A); until then a clv route is simply not cross-checked
  // here rather than crashing on a field it does not carry. (No clv model ships in
  // the registry yet, so this is a compile-time guard as much as a runtime one.)
  if (route.family === 'one-compartment-clv') return undefined;
  // The parent-metabolite family (SC-3A) carries per-species disposition
  // (parentEliminationHalfLifeHours / metaboliteEliminationHalfLifeHours and their
  // own Vd/kg), not the single terminal-t½/Vd scalars this gate compares, plus a
  // formation-fraction and molar masses that have no catalog analogue. Reviewed
  // parent/metabolite verticals (SC-3B) carry their own per-species evidence; until
  // then a parent-metabolite route is not cross-checked here rather than crashing on
  // a field it does not carry. (No such model ships in the registry yet, so this is a
  // compile-time guard as much as a runtime one.)
  if (route.family === 'parent-metabolite-first-order') return undefined;
  // Disposition params (elimination, Vd) are catalog-checkable for every family.
  // Bioavailability only exists where the family models an absorption phase — IV
  // fixes F = 1, so it has no bioavailability parameter to check.
  switch (param) {
    case 'eliminationHalfLifeHours':
      return centralValue(route.eliminationHalfLifeHours);
    case 'vdLitersPerKg':
      return centralValue(route.vdLitersPerKg);
    case 'bioavailability':
      // Absorption families (oral/two-compartment) have F; IV fixes F = 1.
      return route.family === 'iv-one-compartment'
        ? undefined
        : centralValue(route.bioavailability);
  }
}

/**
 * Cross-check every registered model's catalog-checkable parameters against the
 * injected catalog. Iterates each route independently (each route declares its
 * own disposition/absorption), so a per-route regression cannot hide behind a
 * shared annotation.
 */
export function crossCheckRegistry(
  catalog: CatalogLookup,
  opts: { relTolerance?: number } = {},
): CrossCheckReport {
  const relTol = opts.relTolerance ?? DEFAULT_REL_TOL;
  const rows: CrossCheckRow[] = [];

  for (const analyte of registeredAnalytes()) {
    const model = findModel(analyte);
    if (!model) continue;
    const cat = catalog(analyte);
    const routeIds = Object.keys(model.routes) as RouteId[];
    for (const routeId of routeIds) {
      const route = model.routes[routeId];
      for (const param of CHECKABLE_PARAMS) {
        const registryValue = registryValueFor(route, param);
        if (registryValue === undefined) continue;

        const catalogRange = cat?.[param];
        const vdFromTotalLiters =
          param === 'vdLitersPerKg' ? cat?.vdFromTotalLiters : undefined;

        const provenance = provenanceFor(analyte, routeId, param);
        const classification = classify(registryValue, catalogRange, relTol);

        // A total-litre-derived Vd is too soft to certify a `catalog` claim
        // against, so treat it as "no catalog value" for gate purposes.
        const usableForGate = !(param === 'vdLitersPerKg' && vdFromTotalLiters);

        let undeclaredDivergence: boolean;
        if (!provenance) {
          undeclaredDivergence = true; // unreviewed gap
        } else if (provenance.source === 'catalog') {
          undeclaredDivergence =
            !usableForGate || !isCatalogConsistent(classification);
        } else {
          undeclaredDivergence = false; // reviewed-override
        }

        rows.push({
          analyte,
          route: routeId,
          param,
          registryValue,
          catalog: catalogRange,
          vdFromTotalLiters,
          classification,
          provenance,
          undeclaredDivergence,
        });
      }
    }
  }

  return {
    registryVersion: REGISTRY_VERSION,
    referenceWeightKg: PROVENANCE_REFERENCE_WEIGHT_KG,
    relTolerance: relTol,
    rows,
    undeclared: rows.filter((r) => r.undeclaredDivergence),
  };
}

/**
 * Structural completeness of the reviewed provenance table: every
 * catalog-checkable (analyte, route, param) slot present in the registry must
 * carry an annotation, and every annotation must be well-formed
 * (`reviewed-override` requires a rationale). Returns human-readable problems;
 * empty means the table fully covers the current registry.
 */
export function auditProvenanceCompleteness(): string[] {
  const problems: string[] = [];
  // Track coverage at BOTH granularities: `analyte:param` (does any route carry
  // this checkable param?) and `analyte:route:param` (this exact slot), so a
  // stale route-specific annotation on a removed route is still caught even when
  // another route keeps the same param.
  const seenParam = new Set<string>();
  const seenRoute = new Set<string>();

  // A duplicate analyte entry makes `provenanceFor` (Map, last-wins) and
  // `catalogLookup` (find, first-wins) disagree — reject before anything relies
  // on either. Flag once per duplicated analyte.
  const analyteCounts = new Map<string, number>();
  for (const entry of REGISTRY_PROVENANCE) {
    analyteCounts.set(entry.analyte, (analyteCounts.get(entry.analyte) ?? 0) + 1);
  }
  for (const [analyte, count] of analyteCounts) {
    if (count > 1) {
      problems.push(`duplicate provenance entry for analyte ${analyte} (${count} entries)`);
    }
  }

  for (const analyte of registeredAnalytes()) {
    const model = findModel(analyte);
    if (!model) continue;
    const routeIds = Object.keys(model.routes) as RouteId[];
    for (const routeId of routeIds) {
      const route = model.routes[routeId];
      for (const param of CHECKABLE_PARAMS) {
        if (registryValueFor(route, param) === undefined) continue;
        const prov = provenanceFor(analyte, routeId, param);
        seenParam.add(`${analyte}:${param}`);
        seenRoute.add(`${analyte}:${routeId}:${param}`);
        if (!prov) {
          problems.push(`missing provenance for ${analyte} ${routeId} ${param}`);
          continue;
        }
        if (prov.source === 'reviewed-override' && !prov.rationale?.trim()) {
          problems.push(
            `reviewed-override without rationale: ${analyte} ${routeId} ${param}`,
          );
        }
      }
    }
  }

  // Flag stale annotations that no longer match any registry model/parameter, so
  // a removed model, renamed parameter, or dropped ROUTE cannot leave dead
  // provenance behind. A `'*'` key is stale only when NO route carries the param;
  // a specific-route key is stale when that exact route no longer carries it.
  for (const entry of REGISTRY_PROVENANCE) {
    if (!findModel(entry.analyte)) {
      problems.push(`stale provenance entry for unknown analyte ${entry.analyte}`);
      continue;
    }
    for (const param of Object.keys(entry.params) as CheckableParam[]) {
      if (!seenParam.has(`${entry.analyte}:${param}`)) {
        problems.push(
          `stale provenance for ${entry.analyte} ${param} (not a checkable registry parameter)`,
        );
        continue;
      }
      for (const routeKey of Object.keys(entry.params[param] ?? {}) as RouteKey[]) {
        if (routeKey === '*') continue;
        if (!seenRoute.has(`${entry.analyte}:${routeKey}:${param}`)) {
          problems.push(
            `stale provenance for ${entry.analyte} ${routeKey} ${param} (route no longer carries this checkable parameter)`,
          );
        }
      }
    }
  }

  return problems;
}
