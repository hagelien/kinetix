/**
 * The grade a derived model carries with it, from generation to render (CV-3 ↔ CV-4).
 *
 * CV-4 emits the derived tier as assembled `DrugModelDefinition`s: routes, parameters, metadata —
 * everything the ENGINE needs to produce a curve, and nothing about how much that curve should be
 * trusted. CV-3 grades a `DerivedModel`: which axes were a disclosed default, which required
 * parameters the catalog could not supply, which were inferred rather than cited. Those two halves
 * were never joined, so a consumer resolving a derived model from the committed artifact had the
 * curve and no way to grade it — and an ungraded catalog curve is exactly what the plan forbids.
 *
 * This module is the join. It defines the per-route grade RECORD the generation step writes
 * alongside each derived definition, and rebuilds the `DerivedModel` that record describes so the
 * ordinary CV-3a/CV-3c path (`gradeDerivedModel`, `describeDerivedModel`) can run at render time
 * against a model nobody re-derived. The record holds facts, never a computed grade: the grading
 * thresholds are tunable (plan §8), so a committed grade would silently pin the scheme as it stood
 * when the artifact was generated, while committed FACTS re-grade correctly under a newer scheme.
 *
 * Pure and portable: no DB, no engine change, no `CORE_VERSION` bump.
 */
import type { AxisProvenance, DerivedModel, RouteProvenance } from './derive-model.js';
import type { ModelStructure, RequiredParam } from './model-structure.js';
import type { ModelFamily, RouteId } from './types.js';

/** The grade-relevant facts about ONE assembled route of a derived model. */
export interface DerivedRouteGrade {
  route: RouteId;
  /**
   * Whether the catalog NAMED this route (`asserted`, the default when absent) or the read adapter
   * attributed it from evidence only a route can produce — a drug-level Tmax/F — while the label
   * itself was unstated. An attributed route is a disclosed assumption about the model, so it is
   * graded like a defaulted axis rather than passed off as curation.
   */
  routeProvenance?: RouteProvenance;
  /** The resolved model structure — the declaration with disclosed defaults filled in (CV-2a). */
  structure: ModelStructure;
  /** Which axes were asserted from the drug's declarations and which took the default. */
  axisProvenance: {
    disposition: AxisProvenance;
    elimination: AxisProvenance;
    absorption: AxisProvenance;
  };
  /** The composed engine family this route assembled into. */
  family: ModelFamily;
  /**
   * Roles whose value was inferred rather than read from a cited entry (CV-2c-6: `ka` from Tmax).
   *
   * There is deliberately no `missingParameters` counterpart. A record is written only for a route
   * that ASSEMBLED, and `assembleRouteParams` assembles only when every required role has a finite
   * value — so an assembled route has nothing missing, by construction. Carrying the derivation's
   * own `missingParameters` here would be worse than redundant: that set is computed BEFORE the
   * inference runs, so an inferred `ka` still appears in it, and the model would be penalised twice
   * for one parameter — once on completeness for being absent, once on inference for being solved.
   */
  inferredParameters?: readonly RequiredParam[];
  /**
   * Asserted structure axes this route runs in a SIMPLER form than the drug declares, keyed by axis
   * with the declared value — e.g. `{ disposition: 'two-compartment' }` when the route runs
   * one-compartment because the catalog cannot yet supply the two-compartment micro-constants.
   * `structure` is what runs. Graded like a defaulted axis: in both cases the curve's shape is not
   * one the evidence asserts. Absent when the route runs exactly what was declared.
   */
  simplifiedFrom?: Partial<ModelStructure>;
  /**
   * Roles that ran on a labelled cautious default because the catalog holds no value for them
   * (F = 1, a fast `ka`). §5.1 grades completeness C when one input uses an explicitly conservative
   * default, D when more do. Absent when every value came from the catalog or an inference.
   */
  defaultedParameters?: readonly RequiredParam[];
}

/** Every assembled route's grade record for one derived model, keyed by its analyte id. */
export interface DerivedModelGrade {
  analyte: string;
  routes: readonly DerivedRouteGrade[];
}

/**
 * Rebuild the `DerivedModel` a route's grade record describes.
 *
 * The record is written for routes that ASSEMBLED, so the outcome is `modelable` by construction —
 * a not-modelable route produces no curve and is reported in the coverage diagnostics instead — and
 * the rebuilt model carries no `missingParameters`, because an assembled route has none (see the
 * note on `DerivedRouteGrade`).
 * Feeding the result to `gradeDerivedModel`/`describeDerivedModel` yields exactly the grade the
 * generation-time derivation would have produced, without re-reading the catalog. Pure.
 */
export function derivedModelFromGrade(record: DerivedRouteGrade): DerivedModel {
  return {
    outcome: 'modelable',
    structure: record.structure,
    axisProvenance: record.axisProvenance,
    defaulted:
      record.axisProvenance.disposition === 'defaulted' ||
      record.axisProvenance.elimination === 'defaulted' ||
      record.axisProvenance.absorption === 'defaulted',
    family: record.family,
  };
}

/** The grade record for one route of one derived model, or `undefined` if either is unknown. */
export function findDerivedRouteGrade(
  grades: readonly DerivedModelGrade[],
  analyte: string,
  route: RouteId,
): DerivedRouteGrade | undefined {
  return grades.find((g) => g.analyte === analyte)?.routes.find((r) => r.route === route);
}
