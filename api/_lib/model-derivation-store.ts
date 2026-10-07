/**
 * Read adapter for the catalog model derivation (CV-2c, catalog-coverage track).
 *
 * The pure bridge (`src/lib/modelDerivation.ts`) maps a drug's stored declarations + present
 * parameters onto the engine and derives one model per ADMINISTRATION ROUTE. This module is the
 * thin DB layer that FEEDS it: it reads the drug's model-structure axis declarations (the
 * categorical `parameter_entries` rows, CV-1b), the per-route absorption shapes and route-specific
 * catalog parameters (`route`-scoped `parameter_entries`, CV-2c), and the drug-level catalog
 * parameters (the `drug_parameters` aggregate cache), then delegates. All model logic lives in the
 * pure module (unit-tested there); this file only queries.
 *
 * CV-2c faithful per-route form: absorption, bioavailability (`F`) and the first-order rate (`ka`)
 * are genuinely route-specific, so a route is DECLARED by the presence of a route-scoped row for it
 * (a `route`-keyed absorption shape or a route-specific parameter). The molecule-level axes
 * (disposition/elimination) are read drug-wide and shared across every route.
 *
 * CV-2c-7 — the ATTRIBUTED oral route. Requiring a route-scoped row before anything derives is the
 * faithful rule for a drug whose curation states routes, but it is the wrong answer for one that
 * states none: 694 of 697 catalog drugs reported `no administration route was supplied`, most of
 * them holding a drug-level Tmax and F — quantities no molecule has and no IV dose produces, so
 * their presence IS the catalog saying an extravascular route was studied, with only the route's
 * label unstated. An unstated axis takes a disclosed default (plan §2), so the label does too:
 * `oral`, marked `attributed`, graded exactly as a defaulted axis is and disclosed at the curve.
 * It applies ONLY when the drug declares no route at all, so it can neither displace nor contradict
 * an authored one, and it disappears the moment a curator keys a route. A drug with no
 * extravascular evidence still derives nothing — missing stays missing.
 *
 * This is the READ counterpart of the route-keyed contract (CV-2c-1) and the `route` schema
 * (CV-2c-2). `ka` is route-scoped (CV-2c-3) and `absorptionModel`/`bioavailability` are
 * route-OPTIONAL (CV-2c-4), so the write path can author every route-keyed shape this adapter
 * reads; the attribution above is what covers the catalog until it has been.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { drugs, drugParameters, paperReviews, parameterEntries } from '../../db/schema.js';
import { getDb, runInPoolTransaction } from './db.js';
import {
  isDrugParameterId,
  parameterIsRouteScoped,
  type DrugParameterId,
} from '../../src/lib/drugParameters.js';
import type { NumericRange } from '../../src/types/index.js';
import { meanRange } from '../../src/lib/rangeUtils.js';
import {
  DEFAULT_SUBSTANCE_CLASS,
  substanceIsAdministered,
} from '../../src/lib/parameterApplicability.js';
import { seededSubstanceClass } from '../../data/substanceClasses.js';
import {
  aggregateEntries,
  dropSupersededGrandfathered,
  isAggregateCacheValue,
  type ParameterEntryValue,
} from '../../src/lib/parameterEntryAggregation.js';
import { getDrugParameterMap } from './drugParameterStore.js';
import { computeParameterSummary, loadEntryValuesForParameter } from './parameter-entries-store.js';
import {
  assembleDrugDefinition,
  assembleRouteParams,
  buildRegistrySnapshot,
  findModel,
  registeredAnalytes,
  requiredParametersFor,
  REGISTRY_VERSION,
  ROUTE_IDS,
  type DrugDefinitionAssembly,
  type DrugModelDefinition,
  type RegistrySnapshot,
  type RouteAssemblyInput,
  type RouteId,
  type DerivedModel,
  type DerivedModelGrade,
  type InputSource,
  type RequiredParam,
} from '../../src/lib/kinetics-core/index.js';
import {
  applyCautiousDefaults,
  CAUTIOUS_DEFAULT_ROLES,
  applyKaInference,
  canonicalUnitFor,
  derivedDefinitionMetadata,
  inferVdScaling,
  isRouteAssemblyParameter,
  MODEL_STRUCTURE_AXIS_PARAMETERS,
  parameterRoleFor,
  resolveDrugModelsByRoute,
  inferredKaRange,
  tmaxHoursFrom,
  toAssemblyRanges,
  toAssemblyValues,
  type CatalogParameterValue,
  type CautiousDefaultRole,
  type RouteDeclaration,
  type RouteKeyedDrugModelInputs,
  type RouteModelDerivation,
} from '../../src/lib/modelDerivation.js';

/** The RouteId vocabulary as a lookup, so a `route` string read from the DB is narrowed safely. */
const ROUTE_ID_SET: ReadonlySet<string> = new Set<RouteId>(ROUTE_IDS);
const isRouteId = (value: string | null): value is RouteId =>
  value !== null && ROUTE_ID_SET.has(value);

/**
 * Structural roles that must NOT be shared from the drug-level pool because they are route-specific
 * by the CV-2c contract. `bioavailability` (F) can hold a legacy drug-level cache value, but F is a
 * per-route quantity, so it counts only when a route-specific entry supplies it. (`ka` is
 * `routeScoped` and never reaches `drug_parameters`, so it needs no entry here.)
 */
const DRUG_LEVEL_EXCLUDED_ROLE_IDS: ReadonlySet<DrugParameterId> = new Set<DrugParameterId>([
  'bioavailability',
]);

/**
 * Drug-level parameters that only an EXTRAVASCULAR route can produce, and so evidence that one was
 * studied even when the catalog never named it. Time to peak and bioavailability are both
 * properties of an absorption phase (`ROUTE_ASSEMBLY_PARAMETER_IDS`), not of a molecule: an IV dose
 * has no Tmax to measure and a fixed F = 1. Their presence at drug level is what the attributed
 * oral route below is built on.
 */
const DRUG_LEVEL_ATTRIBUTED_ROUTE_ROLE_IDS: ReadonlySet<DrugParameterId> =
  new Set<DrugParameterId>(['tmax', 'bioavailability']);

/** The molecule-level axes: drug-wide, shared across every route. */
const MOLECULE_AXES: readonly string[] = [
  MODEL_STRUCTURE_AXIS_PARAMETERS.disposition,
  MODEL_STRUCTURE_AXIS_PARAMETERS.elimination,
];

/**
 * The declaration rows `mapRouteKeyedInputs` consumes, however they were fetched — one drug at a
 * time, or grouped out of a catalog-wide read.
 */
interface RouteKeyedInputRows {
  moleculeRows: readonly { parameter: string; categoricalValue: string | null }[];
  routeAxisRows: readonly { categoricalValue: string | null; route: string | null }[];
  routeParamRows: readonly { parameter: string; route: string | null }[];
  drugLevelRows: readonly { parameter: string }[];
}

/**
 * Read a drug's route-keyed model inputs (CV-2c):
 *
 *   - the distinct declared value of each MOLECULE-level axis (disposition / elimination), read
 *     drug-wide and shared across routes;
 *   - per ROUTE: the absorption shape(s) declared for it and the catalog parameters stored
 *     specifically for it (route-specific `bioavailability`, the reviewer-authored `ka`);
 *   - the DRUG-LEVEL catalog parameters (from the `drug_parameters` aggregate cache), shared by
 *     every route.
 *
 * Three queries: the categorical axis declarations, the route-scoped `parameter_entries` rows, and
 * the drug-level parameter cache. No aggregation, no model logic.
 */
export async function readDrugModelInputsByRoute(
  drugId: number,
): Promise<RouteKeyedDrugModelInputs> {
  const db = getDb();

  const moleculeAxes = [...MOLECULE_AXES];
  const [moleculeRows, routeAxisRows, routeParamRows, drugLevelRows] = await Promise.all([
    // Molecule-level categorical declarations (disposition / elimination): drug-wide, so no route
    // filter — a molecule's disposition is the same however it is administered. A non-null
    // categorical value is always a cited declaration (grandfathered synthetic rows carry none).
    db
      .select({
        parameter: parameterEntries.parameter,
        categoricalValue: parameterEntries.categoricalValue,
      })
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          inArray(parameterEntries.parameter, moleculeAxes),
          isNotNull(parameterEntries.categoricalValue),
        ),
      ),
    // Per-ROUTE absorption shapes (CV-2c): categorical `absorptionModel` rows scoped to a route.
    // A drug-level (route NULL) absorption row is a CV-1b legacy declaration that keys no route, so
    // it does not declare one here — the faithful per-route path needs a route.
    db
      .select({
        categoricalValue: parameterEntries.categoricalValue,
        route: parameterEntries.route,
      })
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          eq(parameterEntries.parameter, MODEL_STRUCTURE_AXIS_PARAMETERS.absorption),
          isNotNull(parameterEntries.categoricalValue),
          isNotNull(parameterEntries.route),
        ),
      ),
    // Route-specific NUMERIC catalog parameters (CV-2c): a `route`-scoped `parameter_entries` row
    // carrying a value (route-specific `bioavailability`, `ka`). Categorical rows are excluded
    // (they are the axes above); a usable value means at least one of low/median/high — or a
    // labelled centre (`centralValue`) — is present.
    db
      .select({
        parameter: parameterEntries.parameter,
        route: parameterEntries.route,
      })
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          isNotNull(parameterEntries.route),
          isNull(parameterEntries.categoricalValue),
          or(
            isNotNull(parameterEntries.low),
            isNotNull(parameterEntries.median),
            // A labelled source value keeps its centre here instead of `median`.
            isNotNull(parameterEntries.centralValue),
            isNotNull(parameterEntries.high),
          ),
        ),
      ),
    // Drug-level catalog parameters: the aggregate cache holds one value per drug (half-life, Vd,
    // clearance, and a drug-level bioavailability that the filter below drops as route-specific).
    // Route-scoped parameters (`ka`) never live here.
    db
      .select({ parameter: drugParameters.parameter })
      .from(drugParameters)
      .where(and(eq(drugParameters.drugId, drugId), isNotNull(drugParameters.value))),
  ]);

  return mapRouteKeyedInputs({ moleculeRows, routeAxisRows, routeParamRows, drugLevelRows });
}

/**
 * Map one drug's declaration rows onto its route-keyed model inputs. Pure, so the per-drug read and
 * the catalog-wide snapshot scan share exactly one derivation path.
 */
function mapRouteKeyedInputs({
  moleculeRows,
  routeAxisRows,
  routeParamRows,
  drugLevelRows,
}: RouteKeyedInputRows): RouteKeyedDrugModelInputs {
  // Molecule axes → distinct, sorted value sets (the queries carry no ORDER BY, so sort for a
  // deterministic derivation).
  const moleculeValues = new Map<string, Set<string>>(
    MOLECULE_AXES.map((p) => [p, new Set<string>()]),
  );
  for (const row of moleculeRows) {
    if (row.categoricalValue) moleculeValues.get(row.parameter)?.add(row.categoricalValue);
  }
  const sortedAxis = (param: string): string[] => [...(moleculeValues.get(param) ?? [])].sort();

  // Assemble each declared route's declaration. A route is declared by an absorption row OR a
  // route-specific parameter; either alone is enough (a route with only a `ka` value still derives,
  // taking the disclosed-default absorption shape).
  const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set<V>()));
    set.add(value);
  };
  const routeAbsorption = new Map<RouteId, Set<string>>();
  for (const row of routeAxisRows) {
    if (!isRouteId(row.route) || !row.categoricalValue) continue;
    addTo(routeAbsorption, row.route, row.categoricalValue);
  }
  const routeParameters = new Map<RouteId, Set<DrugParameterId>>();
  for (const row of routeParamRows) {
    if (!isRouteId(row.route)) continue;
    if (
      !isDrugParameterId(row.parameter) ||
      parameterRoleFor(row.parameter) === null ||
      !isRouteAssemblyParameter(row.parameter)
    ) continue;
    addTo(routeParameters, row.route, row.parameter);
  }

  const routes: Partial<Record<RouteId, RouteDeclaration>> = {};
  for (const route of new Set<RouteId>([...routeAbsorption.keys(), ...routeParameters.keys()])) {
    const absorption = [...(routeAbsorption.get(route) ?? [])].sort();
    const presentParameters = [...(routeParameters.get(route) ?? [])].sort();
    routes[route] = {
      // Omit an empty absorption set so the route takes the disclosed default; keep the full set
      // (the pure resolver dedups agreement and surfaces disagreement as a per-route conflict).
      ...(absorption.length > 0 ? { absorption } : {}),
      ...(presentParameters.length > 0 ? { presentParameters } : {}),
    };
  }

  // ATTRIBUTED ORAL ROUTE (CV-2c-7). A drug that names no route at all still routinely holds
  // route-optional evidence at the drug level — a Tmax, a bioavailability. Neither quantity exists
  // for a molecule: both are properties of an absorption phase, so their presence is itself the
  // catalog stating that an extravascular route was studied, with only the route's LABEL left
  // unstated. Requiring the label to be authored before anything derives left 694 of 697 catalog
  // drugs with `no administration route was supplied` — not because the science was missing, but
  // because a column was null.
  //
  // So the label takes the disclosed default the plan §2 grants an unstated axis: `oral`, the
  // generic catalog case, recorded as `attributed` so the grade and the disclosure name it as an
  // assumption rather than a curation. This is narrowly scoped on purpose — it applies ONLY when
  // the drug declares no route whatsoever, so it can never redirect, displace or contradict an
  // authored one, and the moment a curator keys a route the attribution disappears. A drug holding
  // no extravascular evidence still derives nothing: missing stays missing.
  if (Object.keys(routes).length === 0) {
    const drugLevelRouteOptional = drugLevelRows
      .map((r) => r.parameter)
      .filter(
        (p): p is DrugParameterId =>
          isDrugParameterId(p) && DRUG_LEVEL_ATTRIBUTED_ROUTE_ROLE_IDS.has(p),
      )
      .sort();
    if (drugLevelRouteOptional.length > 0) {
      routes.oral = {
        provenance: 'attributed',
        // Only the roles the assembler consumes: a drug-level `tmax` fills no engine role (it is
        // what the `ka` inference solves against), so declaring it would claim a parameter the
        // family does not have.
        ...(drugLevelRouteOptional.includes('bioavailability')
          ? { presentParameters: ['bioavailability' as DrugParameterId] }
          : {}),
      };
    }
  }

  // Drug-level present parameters: cache rows with a structural role that are genuinely
  // molecule-level (half-life, Vd, clearance) and so shared across every route. The route-specific
  // input roles are excluded: `ka` is `routeScoped` and never reaches `drug_parameters`, and
  // `bioavailability` (F) — though it CAN carry a drug-level cache value — is route-specific by the
  // CV-2c contract (a drug's oral F ≠ its intranasal F). Sharing a legacy drug-level F into every
  // route's pool would let it silently complete a route whose own F was never authored, and the
  // assembler would then apply the oral F to intranasal dosing — the exact collapse route-keying
  // removes. So F counts only when a route-specific entry supplies it (read into that route's
  // `presentParameters` above); a route lacking its own F reports it missing (graded down, honest).
  const presentParameters = drugLevelRows
    .map((r) => r.parameter)
    .filter(
      (p): p is DrugParameterId =>
        isDrugParameterId(p) &&
        parameterRoleFor(p) !== null &&
        !parameterIsRouteScoped(p) &&
        !DRUG_LEVEL_EXCLUDED_ROLE_IDS.has(p),
    )
    .sort();

  return {
    dispositionModels: sortedAxis(MODEL_STRUCTURE_AXIS_PARAMETERS.disposition),
    eliminationModels: sortedAxis(MODEL_STRUCTURE_AXIS_PARAMETERS.elimination),
    routes,
    presentParameters,
  };
}

/**
 * Derive a drug's runnable model(s) from its stored declarations — one per ADMINISTRATION ROUTE
 * (CV-2c). A drug with no route-scoped declaration yields an empty array (no route data ⇒ nothing to
 * derive — missing stays missing); each declared route reports whichever roles the catalog cannot
 * supply as missing, and a molecule-axis conflict makes every route not-modelable.
 */
export async function deriveDrugModelsByRoute(drugId: number): Promise<RouteModelDerivation[]> {
  return resolveDrugModelsByRoute(await readDrugModelInputsByRoute(drugId));
}

/** A `numeric(14,6)` column comes back from Drizzle as a string; parse to a finite number or null. */
function parseNumericColumn(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A `drug_parameters.value` jsonb is a `NumericRange` for the range-kind roles read here (a bare
 *  number/string for other kinds); narrow to the range shape, else null so the row is skipped. */
function asNumericRange(value: unknown): NumericRange | null {
  return typeof value === 'object' && value !== null ? (value as NumericRange) : null;
}

/** A catalog value together with where it came from, for the route's grade record. */
type SourcedValue = CatalogParameterValue & { source: InputSource };

const AUTHORED_VALUE: InputSource = { basis: 'uncited', reason: 'authored-value' };

/**
 * The source of a value pooled from `entries`: cited only when every entry the pool draws on names a
 * citation and none is a grandfathered placeholder. Judged over every entry the aggregation
 * considers rather than only those that reached the numeric pool, so an entry the pool happened to
 * skip can make the answer more cautious but never less.
 */
function sourceOfEntries(entries: readonly ParameterEntryValue[]): InputSource {
  const considered = dropSupersededGrandfathered(entries);
  if (
    considered.length === 0 ||
    considered.some((entry) => entry.citationId == null || entry.origin === 'grandfathered')
  ) {
    return { basis: 'uncited', reason: 'uncited-entry' };
  }
  const citationIds = [...new Set(considered.map((entry) => entry.citationId!))].sort((a, b) => a - b);
  return { basis: 'cited', citationIds };
}

/** Equal up to float noise — the cache and a recompute run the same arithmetic on the same rows. */
function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The source of each drug-level cached value the derivation can use (the structural roles and
 * Tmax). A value written by hand or by a seed carries no `derivedFromEntries` marker and is
 * `authored-value`. A marked aggregate is recomputed from the drug's entries; if it no longer
 * matches the cache, the entries behind the cached number cannot be shown and it is `stale-cache`.
 */
async function readDrugLevelSources(
  drugId: number,
  rows: readonly { parameter: string; value: unknown }[],
): Promise<Map<DrugParameterId, InputSource>> {
  const sources = new Map<DrugParameterId, InputSource>();
  const aggregates: { parameter: DrugParameterId; cached: number | null }[] = [];
  for (const row of rows) {
    const p = row.parameter;
    if (!isDrugParameterId(p) || (p !== 'tmax' && parameterRoleFor(p) === null)) continue;
    const range = asNumericRange(row.value);
    if (!range) continue;
    if (!isAggregateCacheValue(row.value)) {
      sources.set(p, AUTHORED_VALUE);
      continue;
    }
    aggregates.push({ parameter: p, cached: meanRange(range) });
  }
  if (aggregates.length === 0) return sources;
  const paramMap = await getDrugParameterMap(getDb(), drugId);
  for (const { parameter, cached } of aggregates) {
    const entries = await loadEntryValuesForParameter(drugId, parameter);
    const summary = await computeParameterSummary(drugId, parameter, paramMap, entries);
    const current = summary?.representative ?? null;
    sources.set(
      parameter,
      cached !== null && current !== null && sameValue(cached, current)
        ? sourceOfEntries(entries)
        : { basis: 'uncited', reason: 'stale-cache' },
    );
  }
  return sources;
}

/** The first value `tmaxHoursFrom` would read from `values`, so its source can be recorded. */
function firstTmax<T extends CatalogParameterValue>(values: readonly T[]): T | undefined {
  return values.find((value) => tmaxHoursFrom([value]) !== undefined);
}

/**
 * The source behind each role of `toAssemblyValues(values)`. Mirrors its rule exactly — a later
 * value fills a role over an earlier one, and a value that does not convert fills nothing — by
 * asking `toAssemblyValues` itself about each value in turn.
 */
function roleSources(values: readonly SourcedValue[]): Partial<Record<RequiredParam, InputSource>> {
  const out: Partial<Record<RequiredParam, InputSource>> = {};
  for (const value of values) {
    const role = parameterRoleFor(value.parameter);
    if (role !== null && toAssemblyValues([value])[role] !== undefined) out[role] = value.source;
  }
  return out;
}

/** A cached range's reported extremes, when it states both. */
function reportedBounds(range: NumericRange): { low: number; high: number } | Record<string, never> {
  return typeof range.min === 'number' &&
    typeof range.max === 'number' &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max)
    ? { low: range.min, high: range.max }
    : {};
}

/** Push `value` onto the array stored under `key`, creating it on first use. */
function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Read a drug's per-route ASSEMBLY inputs (CV-4c-2): each declared route's derivation paired with the
 * CANONICAL-unit median values and the inferred `vdScaling` that the definition assembler (CV-4c-1's
 * `assembleDrugDefinition`) consumes. This is the value-reading counterpart of
 * `readDrugModelInputsByRoute`, which reads only declarations/presence — here the actual numbers are
 * read and, in the pure bridge, converted to engine-canonical units:
 *
 *   - **Drug-level roles** (`halfLife` → t½, `volumeOfDistribution` → Vd, `clearance`) come from the
 *     `drug_parameters` aggregate cache, already pooled to the canonical unit; each contributes its
 *     representative scalar (`meanRange` — median, else mean, else the midpoint of a two-sided range,
 *     the same midpoint-capable reduction the entry pooling uses, so a bounds-only cached value is not
 *     dropped), shared by every route. A drug-level `bioavailability` is excluded — F is route-specific
 *     (CV-2c), never shared into a route (mirrors `readDrugModelInputsByRoute`).
 *   - **Route-scoped roles** (`ka`, route-specific `F`) live raw in `parameter_entries`; each route's
 *     entries for a role are pooled to a canonical median with the SAME primitive the drug-level cache
 *     was built with (`aggregateEntries`, matrix-independent here, weighted by each source's
 *     paper-review score), so several sources for one route combine the same way — favouring
 *     higher-quality sources — rather than an arbitrary row winning.
 *   - **`vdScaling`** is inferred from the drug-level Vd unit (`inferVdScaling`).
 *
 * One `RouteAssemblyInput` per DERIVED route — including a not-modelable one, whose outcome the
 * assembler reports rather than this adapter dropping it. A value the catalog cannot supply stays
 * absent and the assembler reports that route incomplete: missing stays missing. Thin DB read; all
 * conversion and derivation logic lives in the pure modules.
 */
export async function readDrugRouteAssemblyInputs(
  drugId: number,
  preDerived?: readonly RouteModelDerivation[],
): Promise<RouteAssemblyInput[]> {
  // The catalog-wide scan has already derived this drug from batched declaration rows; re-deriving
  // here would re-issue the very per-drug queries that batching removed.
  const derivations = preDerived ?? (await deriveDrugModelsByRoute(drugId));
  if (derivations.length === 0) return [];

  const db = getDb();
  const [drugLevelRows, routeValueRows, substanceRows] = await Promise.all([
    // Drug-level cached values: the aggregate holds one canonical-unit range per drug parameter.
    db
      .select({ parameter: drugParameters.parameter, value: drugParameters.value })
      .from(drugParameters)
      .where(and(eq(drugParameters.drugId, drugId), isNotNull(drugParameters.value))),
    // Route-scoped numeric entries (route-specific `bioavailability`, `ka`) with the fields the
    // pooling primitive needs, including each citation's paper-review score (left-joined exactly as
    // the drug-level aggregation path `loadEntryValuesForParameter` does) so the weighted median
    // favours higher-quality sources rather than weighting every entry equally. Route params are
    // matrix-independent, so `matrix` is not selected.
    db
      .select({
        id: parameterEntries.id,
        parameter: parameterEntries.parameter,
        route: parameterEntries.route,
        low: parameterEntries.low,
        high: parameterEntries.high,
        median: parameterEntries.median,
        centralValue: parameterEntries.centralValue,
        intervalKind: parameterEntries.intervalKind,
        qualifier: parameterEntries.qualifier,
        unit: parameterEntries.unit,
        n: parameterEntries.n,
        citationId: parameterEntries.citationId,
        origin: parameterEntries.origin,
        reviewScore: paperReviews.overallScore,
      })
      .from(parameterEntries)
      .leftJoin(paperReviews, eq(paperReviews.citationId, parameterEntries.citationId))
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          isNotNull(parameterEntries.route),
          isNull(parameterEntries.categoricalValue),
          or(
            isNotNull(parameterEntries.low),
            isNotNull(parameterEntries.median),
            // A labelled source value keeps its centre here instead of `median`.
            isNotNull(parameterEntries.centralValue),
            isNotNull(parameterEntries.high),
          ),
        ),
      ),
    // Whether the entry is ADMINISTERED at all: a cautious default stands in for an absorption
    // input of a dose, so it has no referent for a metabolite or an endogenous marker.
    db
      .select({ substanceClass: drugs.substanceClass, pubchemCid: drugs.pubchemCid })
      .from(drugs)
      .where(eq(drugs.id, drugId))
      .limit(1),
  ]);

  // Where each drug-level cached value came from, recorded beside the value for the grade.
  const drugLevelSources = await readDrugLevelSources(drugId, drugLevelRows);
  const drugLevelSource = (p: DrugParameterId): InputSource =>
    drugLevelSources.get(p) ?? AUTHORED_VALUE;

  // Drug-level canonical values (shared across routes). Excludes route-specific `bioavailability` and
  // any route-scoped role exactly as the derivation's drug-level pool does. The Vd unit is captured for
  // `vdScaling` inference.
  const drugLevelValues: SourcedValue[] = [];
  // The drug-level `tmax`, kept aside from `drugLevelValues`: it fills no engine role (so
  // `toAssemblyValues` would drop it) but it is what the `ka` inference solves against. Whether it
  // may be ATTRIBUTED to a route is decided below, where the drug's route set is visible.
  const drugLevelTmax: SourcedValue[] = [];
  // The drug-level `bioavailability`, likewise kept aside: F is route-specific (CV-2c), so it is
  // never pooled into the shared drug-level values. It is admitted below for an ATTRIBUTED route
  // only — the route the catalog did not name, whose F this drug-level figure therefore is.
  const drugLevelBioavailability: SourcedValue[] = [];
  let vdUnit = '';
  for (const row of drugLevelRows) {
    const p = row.parameter;
    if (!isDrugParameterId(p)) continue;
    if (p === 'tmax') {
      const tmaxRange = asNumericRange(row.value);
      const tmaxRep = tmaxRange ? meanRange(tmaxRange) : null;
      if (tmaxRange && tmaxRep !== null) {
        drugLevelTmax.push({
          parameter: p,
          value: tmaxRep,
          unit: tmaxRange.unit ?? '',
          ...reportedBounds(tmaxRange),
          source: drugLevelSource(p),
        });
      }
      continue;
    }
    if (parameterRoleFor(p) === null) continue;
    if (parameterIsRouteScoped(p) || DRUG_LEVEL_EXCLUDED_ROLE_IDS.has(p)) {
      if (p === 'bioavailability') {
        const fRange = asNumericRange(row.value);
        const fRep = fRange ? meanRange(fRange) : null;
        if (fRange && fRep !== null) {
          drugLevelBioavailability.push({
            parameter: p,
            value: fRep,
            unit: fRange.unit ?? '',
            ...reportedBounds(fRange),
            source: drugLevelSource(p),
          });
        }
      }
      continue;
    }
    const range = asNumericRange(row.value);
    if (!range) continue;
    const unit = range.unit ?? '';
    if (p === 'volumeOfDistribution') vdUnit = unit;
    // Reduce the cached range with the SAME midpoint-capable rule the entry pooling uses
    // (`meanRange`: median, else mean, else the midpoint of a two-sided interval), so a cached value
    // stored as bare `{ min, max }` — common for seed/backfilled t½ and Vd that were never recomputed
    // from entries — is not dropped and reported missing on an otherwise complete model.
    const rep = meanRange(range);
    if (rep === null) continue;
    drugLevelValues.push({
      parameter: p,
      value: rep,
      unit,
      ...reportedBounds(range),
      source: drugLevelSource(p),
    });
  }

  // Route-scoped values: pool each (route, parameter) group to a canonical median with the shared
  // aggregation primitive, so multiple sources for one route combine the same way the drug-level cache
  // does. `matrixRelevant: false` — `ka`/`F` carry no matrix.
  const routeEntryGroups = new Map<
    string,
    { route: RouteId; parameter: DrugParameterId; entries: ParameterEntryValue[] }
  >();
  for (const row of routeValueRows) {
    if (!isRouteId(row.route)) continue;
    const p = row.parameter;
    // `isRouteAssemblyParameter` is the authority here, NOT the engine-role map: `tmax` is
    // route-keyed and pooled like the others but fills no engine role of its own (it is the
    // observable the `ka` inference solves against), so a role check would silently drop it.
    if (!isDrugParameterId(p) || !isRouteAssemblyParameter(p)) continue;
    const key = `${row.route}\u0000${p}`;
    let group = routeEntryGroups.get(key);
    if (!group) routeEntryGroups.set(key, (group = { route: row.route, parameter: p, entries: [] }));
    group.entries.push({
      entryId: row.id,
      citationId: row.citationId ?? null,
      low: parseNumericColumn(row.low),
      high: parseNumericColumn(row.high),
      median: parseNumericColumn(row.median),
      centralValue: parseNumericColumn(row.centralValue),
      intervalKind: row.intervalKind ?? null,
      qualifier: row.qualifier ?? null,
      unit: row.unit,
      matrix: null,
      n: row.n ?? null,
      reviewScore: row.reviewScore ?? null,
      origin: row.origin ?? null,
    });
  }
  // Every route that carries a route-scoped entry for a parameter at all, whether or not it pools
  // to a value — curated evidence a fallback must not be drawn over.
  const routesWithScoped = (parameter: DrugParameterId): Set<RouteId> =>
    new Set<RouteId>(
      [...routeEntryGroups.values()]
        .filter((group) => group.parameter === parameter)
        .map((group) => group.route),
    );
  const routesWithScopedF = routesWithScoped('bioavailability');
  const routeValues = new Map<RouteId, SourcedValue[]>();
  for (const { route, parameter, entries } of routeEntryGroups.values()) {
    const targetUnit = canonicalUnitFor(parameter);
    if (targetUnit === null) continue;
    const summary = aggregateEntries(entries, { targetUnit, matrixRelevant: false });
    if (!summary || summary.representative === null) continue;
    // Already pooled into the canonical unit; `toAssemblyValues` re-checks it (identity).
    pushInto(routeValues, route, {
      parameter,
      value: summary.representative,
      unit: targetUnit,
      ...(summary.min !== null && summary.max !== null ? { low: summary.min, high: summary.max } : {}),
      source: sourceOfEntries(entries),
    });
  }

  const vdScaling = inferVdScaling(vdUnit);
  // Administered unless EITHER the stored class or the canonical classification list says
  // otherwise. The list (`data/substanceClasses.ts`) is the reviewed source the stored column is
  // seeded and backfilled from; consulting it here keeps a known metabolite (benzoylecgonine,
  // EDDP, …) from being given a dose's F in an artifact generated before the backfill ran. It can
  // only WITHHOLD a default, never grant one, so an editor's reclassification is never overridden
  // in the direction that would draw a curve.
  const administered =
    substanceIsAdministered(substanceRows[0]?.substanceClass) &&
    substanceIsAdministered(
      seededSubstanceClass(substanceRows[0]?.pubchemCid ?? undefined) ?? DEFAULT_SUBSTANCE_CLASS,
    );

  // A drug-level `tmax` carries no route label, so attributing it to a route is only sound when
  // there is exactly ONE route to attribute it to — then it either describes that route or it
  // describes nothing the catalog declares, and no other route can be silently given an absorption
  // rate measured for a different one. A multi-route drug must state Tmax per route (the parameter
  // is `routeOptional`, so the drug editor's route selector already authors it): an oral time to
  // peak is not an insufflated one, and guessing between them is exactly the manufactured
  // attribution the plan's "missing stays missing" rules out.
  const soleRouteTmax = derivations.length === 1 ? tmaxHoursFrom(drugLevelTmax) : undefined;
  const soleRouteTmaxValue = derivations.length === 1 ? firstTmax(drugLevelTmax) : undefined;

  // Assemble one route from a derivation: pick the values it may use, run the `ka` inference, and
  // carry the provenance the grade needs. Called for the declared derivation and, when that does not
  // assemble, for its simplified fallback (see `RouteModelDerivation.dispositionFallback`).
  const buildInput = (
    derived: RouteModelDerivation | (DerivedModel & Pick<RouteModelDerivation, 'route' | 'routeProvenance'>),
  ): RouteAssemblyInput => {
    const routeCatalogValues = routeValues.get(derived.route) ?? [];
    // The drug-level F is read as the ORAL F — the reading the attribution itself makes, which is
    // why an attributed route is oral. So it is admitted to an ATTRIBUTED route, and to an asserted
    // `oral` route that has no route-scoped F of its own: a curator naming the route "oral" confirms
    // that reading rather than contradicting it, so it is not graded as an assumption the way an
    // attributed route is. It must not depend on how many OTHER routes are declared: an oral curve
    // running on this F would otherwise vanish the moment a curator authored an IV or intranasal
    // route beside it — curating more would take the curve away. Every non-oral route still
    // withholds it (an intranasal or inhaled F is not the oral figure, and an IV route has F = 1),
    // so one F is never shared across routes — the collapse CV-2c exists to prevent. A route-scoped
    // F always wins.
    const admitsDrugLevelF =
      derived.routeProvenance === 'attributed' || derived.route === 'oral';
    // "Has its own F" is asked of the route-scoped ENTRIES, not of the pooled values: an authored
    // F that pools to no representative (a censored or single-bound entry) is still the route's
    // own curation, and substituting the drug-level figure for it would draw a curve on an F the
    // route-specific evidence may contradict. Such a route stays incomplete — missing stays missing.
    const attributedValues =
      admitsDrugLevelF && !routesWithScopedF.has(derived.route) ? drugLevelBioavailability : [];
    const catalogValues = [...drugLevelValues, ...attributedValues, ...routeCatalogValues];
    const values = toAssemblyValues(catalogValues);
    // A route-scoped Tmax always wins over the drug-level figure: it is the one actually measured
    // for this route.
    const tmaxHours = tmaxHoursFrom(routeCatalogValues) ?? soleRouteTmax;
    const tmaxValue = firstTmax(routeCatalogValues) ?? soleRouteTmaxValue;
    const tmaxSource = tmaxValue?.source;
    const {
      values: withKa,
      inferredParameters,
      declined,
    } = applyKaInference(derived, values, tmaxHours);
    // A missing F runs on the labelled cautious default F = 1 (owner decision 2026-09-29,
    // `applyCautiousDefaults`) — unless the route holds curated F evidence that could not be used
    // (a route-scoped entry that pools to nothing), or the substance is not administered at all:
    // F describes a dose of this substance, and a metabolite or endogenous marker has none.
    const blocked = new Set<CautiousDefaultRole>(administered ? [] : CAUTIOUS_DEFAULT_ROLES);
    if (routesWithScopedF.has(derived.route)) blocked.add('bioavailability');
    const { values: withDefaults, defaultedParameters } = applyCautiousDefaults(
      derived,
      withKa,
      blocked,
    );
    // The source of each value this route runs on: the roles its family requires, filled from the
    // catalog. An inferred role carries the source of the Tmax it was solved from; a defaulted role
    // took no catalog value and has none.
    const inputSources: Partial<Record<RequiredParam, InputSource>> = {};
    if (derived.outcome === 'modelable' && derived.family) {
      const fromCatalog = roleSources(catalogValues);
      for (const role of inferredParameters) if (tmaxSource) fromCatalog[role] = tmaxSource;
      const required = requiredParametersFor(derived.family, {
        ivInfusion: derived.structure.absorption === 'iv-infusion',
      });
      const defaulted = new Set<RequiredParam>(defaultedParameters);
      for (const role of [...required].sort()) {
        const source = fromCatalog[role];
        if (source && !defaulted.has(role) && withDefaults[role] !== undefined) {
          inputSources[role] = source;
        }
      }
    }
    // The reported spread behind each value, for the roles that carry one. An inferred ka takes the
    // spread its Tmax accounts for; a defaulted role took no catalog value and so has no spread.
    const ranges = toAssemblyRanges(catalogValues);
    for (const role of inferredParameters) {
      const kaRange = inferredKaRange(tmaxValue, withKa.eliminationHalfLife);
      if (kaRange) ranges[role] = kaRange;
      else delete ranges[role];
    }
    for (const role of defaultedParameters) delete ranges[role];
    return {
      route: derived.route,
      derived,
      values: withDefaults,
      ...(Object.keys(ranges).length > 0 ? { ranges } : {}),
      inputSources,
      ...(defaultedParameters.length > 0 ? { defaultedParameters } : {}),
      ...(derived.routeProvenance !== 'asserted'
        ? { routeProvenance: derived.routeProvenance }
        : {}),
      ...(vdScaling ? { vdScaling } : {}),
      ...(inferredParameters.length > 0 ? { inferredParameters } : {}),
      ...(declined ? { inferenceDeclined: declined } : {}),
    };
  };

  return derivations.map((derived): RouteAssemblyInput => {
    const declared = buildInput(derived);
    if (!derived.dispositionFallback) return declared;
    // The declared model runs whenever it can: the fallback exists only so that a drug asserting a
    // richer disposition than the catalog can supply keeps the curve it had before the assertion.
    if (assembleRouteParams(declared.derived, declared.values, { vdScaling }).outcome === 'assembled') {
      return declared;
    }
    const simplified = buildInput({
      ...derived.dispositionFallback,
      route: derived.route,
      routeProvenance: derived.routeProvenance,
    });
    // Prefer the simplified form unless it cannot be assembled at all: an `incomplete` simplified
    // route names the catalog gap a curator can actually close (a missing F, a missing Tmax), where
    // the declared route's "family not implemented" names nothing they can act on.
    if (assembleRouteParams(simplified.derived, simplified.values, { vdScaling }).outcome === 'unsupported') {
      return declared;
    }
    return { ...simplified, simplifiedFrom: { disposition: derived.structure.disposition } };
  });
}

/** The display name for a derived model: English first, then Norwegian, then any language present,
 *  falling back to the slug — mirroring how the app resolves an analyte's canonical name. */
function pickDisplayName(names: Record<string, string>, slug: string): string {
  return names.en ?? names.nb ?? Object.values(names)[0] ?? slug;
}

/**
 * Read a drug's derived `DrugModelDefinition` (CV-4c-2b): source its catalog metadata from the drug
 * row (identity fields from `slug`/`names`/`aliases`, plus the disclosed-default matrix, validation
 * status and dose bases via `derivedDefinitionMetadata`), gather its per-route assembly inputs
 * (`readDrugRouteAssemblyInputs`), and assemble via CV-4c-1's `assembleDrugDefinition`.
 *
 * A drug with no runnable route (none declared, or every route not-modelable / lacking required
 * values) is `not-modelable` — reported, no curve (missing stays missing). This is the per-drug step
 * the catalog-wide snapshot generation (CV-4c-2b continued) iterates to build the derived tier.
 *
 * @throws if no drug has the given id — a generation bug, surfaced rather than assembling from nothing.
 */
export async function readDrugModelDefinition(drugId: number): Promise<DrugDefinitionAssembly> {
  const db = getDb();
  const [drugRow] = await db
    .select({ slug: drugs.slug, names: drugs.names })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!drugRow) {
    throw new Error(`readDrugModelDefinition: no drug with id ${drugId}`);
  }
  const inputs = await readDrugRouteAssemblyInputs(drugId);
  const metadata = derivedDefinitionMetadata({
    slug: drugRow.slug,
    displayName: pickDisplayName(drugRow.names, drugRow.slug),
  });
  return assembleDrugDefinition(metadata, inputs);
}

/** The reviewed override tier — today's hand-authored `registry.ts` definitions, reconstructed from
 *  the public surface in the SAME order `REGISTRY_CHECKSUM` was computed over (so a `[]`-derived
 *  snapshot reproduces it bit-for-bit). */
function reviewedOverrides(): DrugModelDefinition[] {
  return registeredAnalytes().map((analyte) => {
    const model = findModel(analyte);
    if (!model) {
      throw new Error(
        `readDerivedRegistrySnapshot: registeredAnalytes() named "${analyte}" but findModel() cannot resolve it`,
      );
    }
    return model;
  });
}

/** The outcome of building the derived registry snapshot from the whole catalog (CV-4c-2b). */
export interface DerivedRegistryBuild {
  /** The merged, checksummed release: the reviewed override tier plus the surviving derived entries. */
  snapshot: RegistrySnapshot;
  /** Slugs of drugs that produced no runnable route — reported, not in the snapshot (missing stays
   *  missing). */
  notModelable: NotModelableCatalogEntry[];
  /**
   * The grade-relevant facts for every ASSEMBLED route of every derived model (CV-3 ↔ CV-4).
   * Without these the committed artifact carries curves nobody can grade, and an ungraded
   * catalog curve is exactly what the plan forbids. Facts, not a computed grade: the CV-3a
   * thresholds are tunable, so a stored grade would pin the scheme at generation time.
   */
  derivedGrades: DerivedModelGrade[];
}

/** A catalog entry deliberately absent from the generated registry, with actionable diagnostics. */
export interface NotModelableCatalogEntry {
  slug: string;
  reason: string;
  routes: Array<{
    route: RouteId;
    outcome: 'incomplete' | 'unsupported';
    missing?: string[];
    reason?: string;
    /** Roles this route DID get, but by inference rather than from a cited value — so a curator
     *  reading the coverage report can tell "ka was solved, F is what is still missing" from
     *  "neither is available". */
    inferred?: string[];
    /** Why an attempted inference was refused — a stored observable the arithmetic rejected, which
     *  is a finding about the drug's data rather than a plain gap. */
    inferenceDeclined?: string;
    /** Declared structure axes the report is about in simplified form — the gap named is the
     *  simplified route's, since that is the one the catalog is closest to running. */
    simplifiedFrom?: Record<string, string>;
    /** Roles filled with a cautious default for this route — absent from the catalog all the same. */
    defaulted?: string[];
  }>;
}

/**
 * Build the derived registry snapshot from the WHOLE catalog (CV-4c-2b): enumerate every drug
 * deterministically, assemble each drug's `DrugModelDefinition` (`readDrugModelDefinition`), and merge
 * the assembled definitions (as `derived`) with the reviewed override tier (as `overrides`) through
 * CV-4a's `buildRegistrySnapshot`. The override tier always wins a shared analyte, so a reviewed
 * nonlinear model is never replaced by a naive DB derivation; a drug with no runnable route is reported
 * in `notModelable` and left out (missing stays missing).
 *
 * **One consistent snapshot.** The enumeration and every per-drug read run inside one
 * `REPEATABLE READ` transaction (like `loadCatalogRows`), so a catalog edit committing mid-scan can
 * neither combine an old state of one drug with a new state of another nor pair a drug's old metadata
 * with its new parameters. Since this checksum is meant to become a committed, reproducible artifact,
 * a torn read would fingerprint a DB state that never existed.
 *
 * **Determinism.** Drugs are enumerated in `slug` order and the override tier is laid down in
 * `registeredAnalytes()` order, so the snapshot — and its checksum — is a pure function of the DB
 * contents and the reviewed tier, not of row/iteration order.
 *
 * **Collision safety.** A derived model's `analyte` is its slug, globally unique, and a derived model
 * carries NO aliases (catalog labels are not analyte ids — see `derivedDefinitionMetadata`). So no two
 * derived entries can collide, and the only merge interaction is the legitimate analyte-vs-override
 * supersession `buildRegistrySnapshot` resolves. Thin DB read + pure merge; no file emission (that is
 * the generation script, CV-4c-2b-b-2).
 */
export async function readDerivedRegistrySnapshot(): Promise<DerivedRegistryBuild> {
  return runInPoolTransaction(async () => {
    // Must precede any query in the transaction to take effect — pins every read to one snapshot.
    await getDb().execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const db = getDb();

    // The DECLARATION reads are issued once for the whole catalog, not once per drug. Per-drug they
    // cost ~5 round trips each (~3.5k for today's 697 drugs), which overran the CI job's ten-minute
    // cap even though every query is individually trivial — the cost is latency, not work. These
    // tables are small enough to read whole and group in memory, and the mapping/derivation below
    // are the SAME pure functions the single-drug path runs, so the batched scan cannot derive
    // anything the per-drug read would not.
    // Ordered explicitly: grouping below preserves row order within a drug, and a route's key
    // insertion order reaches the serialised artifact. An unordered read would let Postgres decide
    // the bytes of a file whose whole purpose is to be byte-reproducible.
    const moleculeAxes = [...MOLECULE_AXES];
    const [drugRows, moleculeRows, routeAxisRows, routeParamRows, drugLevelRows] = await Promise.all([
      db
        .select({ id: drugs.id, slug: drugs.slug, names: drugs.names })
        .from(drugs)
        .orderBy(drugs.slug),
      db
        .select({
          drugId: parameterEntries.drugId,
          parameter: parameterEntries.parameter,
          categoricalValue: parameterEntries.categoricalValue,
        })
        .from(parameterEntries)
        .where(
          and(
            inArray(parameterEntries.parameter, moleculeAxes),
            isNotNull(parameterEntries.categoricalValue),
          ),
        )
        .orderBy(parameterEntries.drugId, parameterEntries.id),
      db
        .select({
          drugId: parameterEntries.drugId,
          categoricalValue: parameterEntries.categoricalValue,
          route: parameterEntries.route,
        })
        .from(parameterEntries)
        .where(
          and(
            eq(parameterEntries.parameter, MODEL_STRUCTURE_AXIS_PARAMETERS.absorption),
            isNotNull(parameterEntries.categoricalValue),
            isNotNull(parameterEntries.route),
          ),
        )
        .orderBy(parameterEntries.drugId, parameterEntries.id),
      db
        .select({
          drugId: parameterEntries.drugId,
          parameter: parameterEntries.parameter,
          route: parameterEntries.route,
        })
        .from(parameterEntries)
        .where(
          and(
            isNotNull(parameterEntries.route),
            isNull(parameterEntries.categoricalValue),
            or(
              isNotNull(parameterEntries.low),
              isNotNull(parameterEntries.median),
              // A labelled source value keeps its centre here instead of `median`.
              isNotNull(parameterEntries.centralValue),
              isNotNull(parameterEntries.high),
            ),
          ),
        )
        .orderBy(parameterEntries.drugId, parameterEntries.id),
      db
        .select({ drugId: drugParameters.drugId, parameter: drugParameters.parameter })
        .from(drugParameters)
        .where(isNotNull(drugParameters.value))
        .orderBy(drugParameters.drugId, drugParameters.parameter),
    ]);

    const groupByDrug = <T extends { drugId: number }>(rows: readonly T[]): Map<number, T[]> => {
      const map = new Map<number, T[]>();
      for (const row of rows) pushInto(map, row.drugId, row);
      return map;
    };
    const moleculeByDrug = groupByDrug(moleculeRows);
    const routeAxisByDrug = groupByDrug(routeAxisRows);
    const routeParamByDrug = groupByDrug(routeParamRows);
    const drugLevelByDrug = groupByDrug(drugLevelRows);

    const derived: DrugModelDefinition[] = [];
    const notModelable: NotModelableCatalogEntry[] = [];
    const derivedGrades: DerivedModelGrade[] = [];
    for (const row of drugRows) {
      const derivations = resolveDrugModelsByRoute(
        mapRouteKeyedInputs({
          moleculeRows: moleculeByDrug.get(row.id) ?? [],
          routeAxisRows: routeAxisByDrug.get(row.id) ?? [],
          routeParamRows: routeParamByDrug.get(row.id) ?? [],
          drugLevelRows: drugLevelByDrug.get(row.id) ?? [],
        }),
      );
      // VALUES stay a per-drug read, for the drugs that actually declare a route. No catalog drug
      // declares one today, so this costs nothing now; when route-scoped data is authored it is
      // paid only by the drugs that have it, and this scan's cost grows with those rather than
      // with the whole catalog.
      const assemblyInputs =
        derivations.length === 0
          ? []
          : await readDrugRouteAssemblyInputs(row.id, derivations);
      const assembly = assembleDrugDefinition(
        derivedDefinitionMetadata({
          slug: row.slug,
          displayName: pickDisplayName(row.names, row.slug),
        }),
        assemblyInputs,
      );
      if (assembly.outcome === 'assembled') {
        derived.push(assembly.definition);
        // Record the grade facts for the routes that actually assembled — the ones a consumer can
        // resolve and therefore must be able to disclose. The route's derivation and its inferred
        // roles are already in hand here; re-deriving them at render time would mean re-reading the
        // catalog, which the offline pin exists to avoid.
        const assembledRoutes = new Set(
          assembly.routeOutcomes
            .filter((route) => route.outcome === 'assembled')
            .map((route) => route.route),
        );
        const routes = assemblyInputs
          .filter((input) => assembledRoutes.has(input.route) && input.derived.family !== undefined)
          .map((input) => ({
            route: input.route,
            structure: input.derived.structure,
            axisProvenance: input.derived.axisProvenance,
            family: input.derived.family!,
            // The route itself was a disclosed assumption when the catalog named none — recorded
            // so the render-time grade counts it exactly as it counts a defaulted axis.
            ...(input.routeProvenance && input.routeProvenance !== 'asserted'
              ? { routeProvenance: input.routeProvenance }
              : {}),
            // No `missingParameters`: this route assembled, so nothing required is absent. The
            // derivation's own set is computed before the ka inference runs and would still name a
            // parameter the inference went on to supply.
            ...(input.inferredParameters?.length
              ? { inferredParameters: [...input.inferredParameters].sort() }
              : {}),
            // The declared model the route runs in simplified form, so the grade counts the gap and
            // the disclosure can say which model the evidence actually describes.
            ...(input.simplifiedFrom ? { simplifiedFrom: { ...input.simplifiedFrom } } : {}),
            // Inputs that ran on a cautious default rather than a catalog value: graded against
            // completeness and stated at the curve.
            ...(input.defaultedParameters?.length
              ? { defaultedParameters: [...input.defaultedParameters].sort() }
              : {}),
            // Where each value came from, so the grade can judge provenance input by input.
            inputSources: input.inputSources ?? {},
          }));
        if (routes.length > 0) {
          derivedGrades.push({ analyte: assembly.definition.analyte, routes });
        }
      } else {
        notModelable.push({
          slug: row.slug,
          reason: assembly.reason,
          routes: assembly.routeOutcomes
            .filter(
              (route): route is typeof route & { outcome: 'incomplete' | 'unsupported' } =>
                route.outcome !== 'assembled',
            )
            .map((route) => ({
              route: route.route,
              outcome: route.outcome,
              ...(route.missing ? { missing: [...route.missing].sort() } : {}),
              ...(route.reason ? { reason: route.reason } : {}),
              ...(route.inferred?.length ? { inferred: [...route.inferred].sort() } : {}),
              ...(route.inferenceDeclined ? { inferenceDeclined: route.inferenceDeclined } : {}),
              ...(route.simplifiedFrom ? { simplifiedFrom: { ...route.simplifiedFrom } } : {}),
              // A defaulted input is still ABSENT from the catalog; a curator reading "missing vd"
              // must also see that F was only defaulted, not found.
              ...(route.defaulted?.length ? { defaulted: [...route.defaulted].sort() } : {}),
              // An attributed route that did NOT assemble is reported as attributed too: a curator
              // reading "oral, missing F" needs to know whether the catalog said "oral".
              ...(route.routeProvenance && route.routeProvenance !== 'asserted'
                ? { routeProvenance: route.routeProvenance }
                : {}),
            })),
        });
      }
    }

    const snapshot = buildRegistrySnapshot(reviewedOverrides(), derived, REGISTRY_VERSION);
    // An override ALWAYS wins (CV-4a), so a derived entry sharing a reviewed analyte (or one of its
    // aliases) is dropped from the release — and its grade has to go with it. A grade left behind
    // would make `derivedRouteGrade()` answer with derived-tier facts for an analyte the REVIEWED
    // tier actually serves, which is both a broken contract and a mislabelled disclosure. Filter on
    // the merge primitive's own report rather than re-deriving the precedence rule here.
    const superseded = new Set(snapshot.supersededByOverride);
    return {
      snapshot,
      notModelable,
      derivedGrades: derivedGrades.filter((grade) => !superseded.has(grade.analyte)),
    };
  });
}
