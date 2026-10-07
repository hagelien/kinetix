import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugParameters, parameterEntries } from '../../db/schema.js';
import {
  deriveDrugModelsByRoute,
  readDrugModelInputsByRoute,
  readDrugRouteAssemblyInputs,
  readDrugModelDefinition,
  readDerivedRegistrySnapshot,
} from '../../api/_lib/model-derivation-store.js';
import {
  assembleDrugDefinition,
  derivedModelFromGrade,
  gradeDerivedModel,
  registeredAnalytes,
  REGISTRY_CHECKSUM,
  REGISTRY_VERSION,
} from '../../src/lib/kinetics-core/index.js';
import { CAUTIOUS_DEFAULT_BIOAVAILABILITY } from '../../src/lib/modelDerivation.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';
import { recomputeAndCacheParameterSummary } from '../../api/_lib/parameter-entries-store.js';
import { runInPoolTransaction } from '../../api/_lib/db.js';

/**
 * CV-2c-5 — the route-keyed read adapter. Exercises the real DB read against PGlite: the
 * molecule-level categorical axes (disposition/elimination) read drug-wide, the per-route absorption
 * shapes and route-specific parameters read from `route`-scoped `parameter_entries`, and the
 * drug-level parameters read from the `drug_parameters` cache — then fed to the pure
 * `resolveDrugModelsByRoute`. Rows are inserted directly (the DB CHECK admits a valid RouteId on any
 * parameter; the app-level write path currently route-scopes only `ka`, so the absorption/`F`
 * branches are exercised at the level the schema already supports — see the store's header).
 */

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

/** Insert a categorical model-structure axis row (disposition/elimination drug-level, or a
 *  route-keyed absorption shape). */
async function insertAxis(
  drugId: number,
  userId: number,
  parameter: string,
  categoricalValue: string,
  route: string | null = null,
): Promise<void> {
  await db.insert(parameterEntries).values({
    drugId,
    parameter,
    categoricalValue,
    unit: '',
    route,
    createdBy: userId,
    origin: 'contributor',
  } as never);
}

/** Insert a numeric parameter entry (drug-level when `route` is null, route-specific otherwise). */
async function insertNumeric(
  drugId: number,
  userId: number,
  parameter: string,
  route: string | null,
  over: { low?: number; high?: number; median?: number; unit?: string; qualifier?: string } = {},
): Promise<void> {
  await db.insert(parameterEntries).values({
    drugId,
    parameter,
    ...(over.qualifier ? { qualifier: over.qualifier } : {}),
    low: String(over.low ?? 1),
    high: over.high != null ? String(over.high) : null,
    median: over.median != null ? String(over.median) : null,
    unit: over.unit ?? '',
    route,
    createdBy: userId,
    origin: 'contributor',
  } as never);
}

/** Publish a drug-level parameter into the aggregate cache (presence is all the adapter reads). */
async function setDrugLevelParameter(
  drugId: number,
  userId: number,
  parameter: string,
  value: unknown,
): Promise<void> {
  await db.insert(drugParameters).values({
    drugId,
    parameter,
    value: value as never,
    updatedBy: userId,
  });
}

describe('CV-2c-5 — route-keyed model derivation read adapter', () => {
  it('does not promote a malformed route-tagged molecule parameter into route assembly', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertNumeric(drugId, userId, 'halfLife', 'oral', { median: 4, unit: 'h' });
    expect((await readDrugModelInputsByRoute(drugId)).routes).toEqual({});
    expect(await readDrugRouteAssemblyInputs(drugId)).toEqual([]);
  });

  it('yields no derivation for a drug with only drug-level (route-null) declarations', async () => {
    // CV-1b drug-level absorption keys no route, so the faithful per-route path derives nothing —
    // "missing stays missing" until route-keyed data is authored.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order'); // route null → not a route
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(inputs.dispositionModels).toEqual(['one-compartment']);
    expect(inputs.eliminationModels).toEqual(['first-order']);
    expect(inputs.presentParameters).toEqual(['halfLife', 'volumeOfDistribution']);
    expect(inputs.routes).toEqual({});
    expect(await deriveDrugModelsByRoute(drugId)).toEqual([]);
  });

  it('declares a route from a route-specific ka and completes an oral first-order model', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    // ka and F are route-specific for the oral route.
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { low: 0.6, high: 0.9 });

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(Object.keys(inputs.routes)).toEqual(['oral']);
    expect(inputs.routes.oral).toEqual({
      absorption: ['first-order'],
      presentParameters: ['bioavailability', 'ka'],
    });

    const models = await deriveDrugModelsByRoute(drugId);
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('oral');
    expect(models[0]!.outcome).toBe('modelable');
    expect(models[0]!.family).toBe('one-compartment-first-order');
    // t½ + Vd (drug-level) + ka + F (route-specific) fully parameterises the oral first-order model.
    expect(models[0]!.missingParameters).toBeUndefined();
  });

  // Codex P1 on #1452: a labelled point estimate (migration 0135) stores its centre only in
  // `central_value` — low/high/median all NULL — and must still count as a usable route value.
  it('completes an oral route from central-value-only ka and F entries', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    for (const [parameter, value, unit] of [
      ['ka', '1.2', '1/h'],
      ['bioavailability', '0.75', ''],
    ] as const) {
      await db.insert(parameterEntries).values({
        drugId,
        parameter,
        centralValue: value,
        centralStatistic: 'arithmetic_mean',
        unit,
        route: 'oral',
        createdBy: userId,
        origin: 'contributor',
      } as never);
    }

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(inputs.routes.oral).toEqual({
      absorption: ['first-order'],
      presentParameters: ['bioavailability', 'ka'],
    });
    const assembly = await readDrugRouteAssemblyInputs(drugId);
    expect(assembly.length).toBeGreaterThan(0);
    const models = await deriveDrugModelsByRoute(drugId);
    expect(models[0]!.outcome).toBe('modelable');
    expect(models[0]!.missingParameters).toBeUndefined();
  });

  it('reads a route-keyed absorption shape and derives one model per declared route', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    // Two routes: IV bolus (complete from t½ + Vd) and oral first-order (ka missing).
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const models = await deriveDrugModelsByRoute(drugId);
    const byRoute = new Map(models.map((m) => [m.route, m]));
    expect([...byRoute.keys()].sort()).toEqual(['iv', 'oral']);
    expect(byRoute.get('iv')!.family).toBe('iv-one-compartment');
    expect(byRoute.get('iv')!.missingParameters).toBeUndefined();
    expect(byRoute.get('oral')!.family).toBe('one-compartment-first-order');
    // No route-specific ka authored → the honest incomplete signal.
    expect(byRoute.get('oral')!.missingParameters).toEqual(
      expect.arrayContaining(['ka', 'bioavailability']),
    );
  });

  it('shares molecule axes across routes and sinks every route on a molecule conflict', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    // Two disagreeing disposition declarations — a curation contradiction, not a model.
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'dispositionModel', 'two-compartment');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(inputs.dispositionModels).toEqual(['one-compartment', 'two-compartment']);

    const models = await deriveDrugModelsByRoute(drugId);
    // Both the ka-declared oral route and the absorption-declared iv route are present…
    expect(models.map((m) => m.route).sort()).toEqual(['iv', 'oral']);
    // …and both are not-modelable because the shared molecule axis conflicts.
    for (const m of models) {
      expect(m.outcome).toBe('not-modelable');
      expect(m.reason).toMatch(/conflicting disposition/);
    }
  });

  it('surfaces a per-route absorption conflict as not-modelable for that route alone', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    // The oral route carries two disagreeing absorption shapes; iv is clean.
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertAxis(drugId, userId, 'absorptionModel', 'zero-order', 'oral');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugModelInputsByRoute(drugId);
    // The read adapter passes the deduped, sorted set for the conflicting route.
    expect(inputs.routes.oral?.absorption).toEqual(['first-order', 'zero-order']);

    const byRoute = new Map((await deriveDrugModelsByRoute(drugId)).map((m) => [m.route, m]));
    expect(byRoute.get('oral')!.outcome).toBe('not-modelable');
    expect(byRoute.get('oral')!.reason).toMatch(/conflicting absorption declarations for route oral/);
    // The clean iv route is unaffected — a per-route conflict does not sink the whole drug.
    expect(byRoute.get('iv')!.outcome).toBe('modelable');
    expect(byRoute.get('iv')!.family).toBe('iv-one-compartment');
  });

  it('does not turn a route-scoped ka on route iv into an IV-labelled extravascular model', async () => {
    // `validateRouteForParameter` accepts any RouteId for `ka`, so a curator CAN store ka against
    // route: 'iv' — nonsensical (IV has no absorption rate). The route is then declared with no
    // absorption shape; the read+derivation must reject it, not apply the extravascular default.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertNumeric(drugId, userId, 'ka', 'iv', { low: 0.5, high: 2, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(inputs.routes.iv).toEqual({ presentParameters: ['ka'] });

    const models = await deriveDrugModelsByRoute(drugId);
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('iv');
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.family).toBeUndefined();
    expect(models[0]!.reason).toMatch(/route iv is incompatible with absorption shape/);
  });

  it('does not let a legacy drug-level bioavailability complete a route lacking its own F', async () => {
    // Codex P2: a drug with a legacy drug-level F cache value + a route-scoped ka on intranasal must
    // NOT treat intranasal as complete — its own F (≠ the oral/drug-level F) was never authored.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'intranasal');
    await insertNumeric(drugId, userId, 'ka', 'intranasal', { low: 0.5, high: 2, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    // Legacy drug-level bioavailability — must stay out of the shared route pool.
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8 });

    const inputs = await readDrugModelInputsByRoute(drugId);
    // Drug-level pool carries the molecule params only; F is excluded as route-specific.
    expect(inputs.presentParameters).toEqual(['halfLife', 'volumeOfDistribution']);

    const models = await deriveDrugModelsByRoute(drugId);
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('intranasal');
    expect(models[0]!.family).toBe('one-compartment-first-order');
    // Intranasal has its own ka but no route-specific F → F is honestly missing, not borrowed.
    expect(models[0]!.missingParameters).toEqual(['bioavailability']);
  });

  it('rejects a route-scoped ka on an explicit IV bolus route (contradiction, not silently dropped)', async () => {
    // Even with a coherent IV input shape declared, a route-SCOPED ka on IV is contradictory — the
    // engine would silently drop it. The route-keyed resolver surfaces it as not-modelable.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await insertNumeric(drugId, userId, 'ka', 'iv', { low: 0.5, high: 2, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const models = await deriveDrugModelsByRoute(drugId);
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('iv');
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.family).toBeUndefined();
    expect(models[0]!.reason).toMatch(/absorption rate \(ka\).*no first-order absorption phase/);
  });

  it('rejects a route-specific bioavailability on an IV route (F fixed at 1, not silently dropped)', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    // A route-scoped F entry on the IV route (read into the route's own params).
    await insertNumeric(drugId, userId, 'bioavailability', 'iv', { low: 0.6, high: 0.9 });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const models = await deriveDrugModelsByRoute(drugId);
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('iv');
    expect(models[0]!.outcome).toBe('not-modelable');
    expect(models[0]!.reason).toMatch(/bioavailability \(F\).*fixes F = 1/);
  });

  it('declares a route from a route-specific parameter even with no absorption shape', async () => {
    // A route with only a ka value still derives, taking the disclosed-default absorption shape.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 2, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(inputs.routes.oral).toEqual({ presentParameters: ['ka'] });

    const models = await deriveDrugModelsByRoute(drugId);
    expect(models).toHaveLength(1);
    expect(models[0]!.route).toBe('oral');
    expect(models[0]!.absorptionShape).toBeNull();
    expect(models[0]!.axisProvenance.absorption).toBe('defaulted');
    expect(models[0]!.family).toBe('one-compartment-first-order');
  });
});

/**
 * CV-4c-2 — the canonical-value read (`readDrugRouteAssemblyInputs`). Reads the actual stored numbers
 * (not just presence), converts them to engine-canonical units, infers `vdScaling` from the Vd unit,
 * and pairs each per-route derivation with the `AssemblyValues` the definition assembler consumes. The
 * catalog's canonical units equal the engine's, so most conversions are identity; the interesting
 * cases are the route-scoped pooling (`ka`/`F` from `parameter_entries`) and a non-canonical drug-level
 * unit (clearance). One case assembles the whole `DrugModelDefinition` to prove the spine end to end.
 */
describe('CV-4c-2 — route-keyed canonical value read adapter', () => {
  it('reads drug-level t½ + Vd into an IV route with no vdScaling (L/kg = total-weight default)', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    const iv = inputs[0]!;
    expect(iv.route).toBe('iv');
    expect(iv.derived.family).toBe('iv-one-compartment');
    expect(iv.values).toEqual({ eliminationHalfLife: 4, vd: 0.7 });
    // L/kg is the total-weight default — vdScaling is omitted (matches a hand-authored model).
    expect(iv.vdScaling).toBeUndefined();
  });

  it('pools route-scoped ka + F into their route and shares drug-level values, then assembles a definition', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    // Three ka sources for the oral route → pooled to their weighted median (1.0); one F source.
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 0.6, unit: '1/h' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1.0, unit: '1/h' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1.4, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { median: 0.75, unit: 'fraction' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    const oral = inputs[0]!;
    expect(oral.route).toBe('oral');
    expect(oral.values.eliminationHalfLife).toBe(4);
    expect(oral.values.vd).toBe(0.7);
    expect(oral.values.ka).toBeCloseTo(1.0, 6); // weighted median of {0.6, 1.0, 1.4}
    expect(oral.values.bioavailability).toBe(0.75);

    // End to end: the inputs assemble into a runnable one-compartment first-order definition.
    const assembly = assembleDrugDefinition(
      {
        analyte: 'test-drug',
        displayName: 'Test Drug',
        modelId: 'derived:test-drug',
        matrix: 'plasma',
        validationStatus: 'literature-derived',
        supportedBases: ['parent'],
      },
      inputs,
    );
    expect(assembly.outcome).toBe('assembled');
    if (assembly.outcome !== 'assembled') throw new Error('expected assembled');
    expect(Object.keys(assembly.definition.routes)).toEqual(['oral']);
    const route = assembly.definition.routes.oral!;
    expect(route.family).toBe('one-compartment-first-order');
    // vdScaling omitted for total-weight, matching a hand-authored model.
    expect(route.vdLitersPerKg).toEqual({ kind: 'fixed', value: 0.7 });
    expect(route.vdScaling).toBeUndefined();
  });

  it('pools a route-scoped ka stored as a low/high range to its midpoint (no median column)', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'ka', 'oral', { low: 0.5, high: 1.5, unit: '1/h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs[0]!.values.ka).toBeCloseTo(1.0, 6); // midpoint of a two-sided interval
  });

  it('reduces a bounds-only cached drug-level value to its midpoint (not dropped as missing)', async () => {
    // A seed/backfilled t½ or Vd cached as a bare { min, max } (no median/mean) must still supply a
    // value — the midpoint — so an otherwise complete model is not reported missing its t½/Vd.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { min: 3, max: 5, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { min: 0.6, max: 0.8, unit: 'L/kg' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    // Midpoints: (3+5)/2 = 4, (0.6+0.8)/2 = 0.7 — the IV model fully parameterises.
    expect(inputs[0]!.values).toEqual({ eliminationHalfLife: 4, vd: 0.7 });
    expect(inputs[0]!.derived.family).toBe('iv-one-compartment');
  });

  it('converts a non-canonical drug-level unit (clearance L/min → L/h)', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'clearance', { median: 2, unit: 'L/min' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    // 2 L/min → 120 L/h (identity for the others).
    expect(inputs[0]!.values.clearance).toBeCloseTo(120, 6);
  });

  it('does not share a drug-level bioavailability into a non-oral route (F is route-specific)', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'intranasal');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1.0, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    // The route-less F is the oral F: the oral route keeps it, the intranasal route does not borrow
    // it — it runs on the labelled cautious default instead, never on the oral 0.8.
    const oral = inputs.find((i) => i.route === 'oral')!;
    expect(oral.values.ka).toBe(1.0);
    expect(oral.values.bioavailability).toBe(0.8);
    expect(oral.defaultedParameters).toBeUndefined();
    const nasal = inputs.find((i) => i.route === 'intranasal')!;
    expect(nasal.values.bioavailability).toBe(CAUTIOUS_DEFAULT_BIOAVAILABILITY);
    expect(nasal.defaultedParameters).toEqual(expect.arrayContaining(['bioavailability']));
  });

  it('does not substitute the drug-level F for a route-scoped F that pools to no value', async () => {
    // A censored route-scoped F ("< 0.5") is the route's own curation even though it has no point
    // value; drawing the curve on the drug-level 0.8 instead would contradict it.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1.0, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', {
      low: 0.5,
      qualifier: '<',
      unit: 'fraction',
    });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.values.bioavailability).toBeUndefined();
  });

  it('keeps an oral curve running on the drug-level F when another route is authored beside it', async () => {
    // Regression: an oral route admitted the drug-level F only while it was the SOLE route, so
    // authoring an IV route withdrew the F and dropped the established oral curve.
    const drugId = await seedDrug(db, { slug: 'oral-then-iv', names: { en: 'oral-then-iv' } });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1.0, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    const before = await readDerivedRegistrySnapshot();
    expect(
      before.snapshot.definitions.find((d) => d.analyte === 'oral-then-iv')?.routes.oral,
    ).toBeDefined();

    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    const after = await readDerivedRegistrySnapshot();
    const definition = after.snapshot.definitions.find((d) => d.analyte === 'oral-then-iv');
    expect(definition?.routes.oral).toBeDefined();
    expect(definition?.routes.iv).toBeDefined();
  });

  it('keeps the drug-level F when a curator names the drug’s sole route as oral', async () => {
    // Before the route was named, this drug ran on an ATTRIBUTED oral route with the drug-level F.
    // Naming the route "oral" confirms that attribution; it must not withhold the F the route was
    // already running on — curating more may never take the curve away.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.routeProvenance).toBeUndefined();
    expect(inputs[0]!.values.bioavailability).toBe(0.8);
    expect(inputs[0]!.inferredParameters).toEqual(['ka']);
  });

  it('yields no assembly inputs for a drug with no declared route', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order'); // route null → not a route
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    expect(await readDrugRouteAssemblyInputs(drugId)).toEqual([]);
  });

  it('carries a not-modelable route through so the assembler can report its outcome', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    // A route-scoped ka on an IV bolus route is contradictory → not-modelable, but still returned.
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await insertNumeric(drugId, userId, 'ka', 'iv', { median: 1.0, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.route).toBe('iv');
    expect(inputs[0]!.derived.outcome).toBe('not-modelable');
    const assembly = assembleDrugDefinition(
      {
        analyte: 'x',
        displayName: 'X',
        modelId: 'derived:x',
        matrix: 'plasma',
        validationStatus: 'literature-derived',
        supportedBases: ['parent'],
      },
      inputs,
    );
    expect(assembly.outcome).toBe('not-modelable');
    expect(assembly.routeOutcomes[0]!.outcome).toBe('unsupported');
  });
});

/**
 * CV-4c-2b — the per-drug definition read (`readDrugModelDefinition`). Sources catalog metadata from
 * the drug row (identity + disclosed defaults) and assembles the whole `DrugModelDefinition` from the
 * per-route inputs. The value read is covered above; here we check the metadata + end-to-end assembly.
 */
describe('CV-4c-2b — per-drug derived definition read', () => {
  it('assembles a definition with derived-tier metadata from the drug row', async () => {
    const drugId = await seedDrug(db, {
      slug: 'testdrug',
      names: { nb: 'Testmiddel', en: 'Test Drug' },
      aliases: ['brand-x', 'street-y'],
    });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const assembly = await readDrugModelDefinition(drugId);
    expect(assembly.outcome).toBe('assembled');
    if (assembly.outcome !== 'assembled') throw new Error('expected assembled');
    const def = assembly.definition;
    // Identity from the drug row (analyte = slug, English display name), disclosed defaults.
    expect(def.analyte).toBe('testdrug');
    expect(def.displayName).toBe('Test Drug');
    expect(def.modelId).toBe('testdrug-derived-v1');
    expect(def.matrix).toBe('plasma');
    expect(def.validationStatus).toBe('literature-derived');
    expect(def.supportedBases).toEqual(['active-moiety', 'parent']);
    // No aliases: the drug's catalog aliases (brand/street labels) are NOT promoted to analyte ids.
    expect(def.aliases).toBeUndefined();
    // The IV route assembled from t½ + Vd.
    expect(Object.keys(def.routes)).toEqual(['iv']);
    expect(def.routes.iv!.family).toBe('iv-one-compartment');
  });

  it('reports not-modelable for a drug with no declared route (missing stays missing)', async () => {
    const drugId = await seedDrug(db, { slug: 'noroutedrug' });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });

    const assembly = await readDrugModelDefinition(drugId);
    expect(assembly.outcome).toBe('not-modelable');
  });

  it('assembles only the runnable route when another route is incomplete', async () => {
    const drugId = await seedDrug(db, { slug: 'partialdrug' });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    // IV bolus completes from t½ + Vd; oral first-order holds only a censored F ("< 0.5"), which
    // pools to no value and — being curated evidence — also blocks the cautious default.
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1, unit: '1/h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', {
      low: 0.5,
      qualifier: '<',
      unit: 'fraction',
    });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const assembly = await readDrugModelDefinition(drugId);
    expect(assembly.outcome).toBe('assembled');
    if (assembly.outcome !== 'assembled') throw new Error('expected assembled');
    // Only the IV route is runnable; oral is reported incomplete but left out of the routes map.
    expect(Object.keys(assembly.definition.routes)).toEqual(['iv']);
    const oral = assembly.routeOutcomes.find((o) => o.route === 'oral');
    expect(oral?.outcome).toBe('incomplete');
    expect(oral?.missing).toEqual(expect.arrayContaining(['bioavailability']));
  });

  it('falls back to the Norwegian name when no English name is present', async () => {
    const drugId = await seedDrug(db, { slug: 'nbonly', names: { nb: 'Bare Norsk' } });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const assembly = await readDrugModelDefinition(drugId);
    if (assembly.outcome !== 'assembled') throw new Error('expected assembled');
    expect(assembly.definition.displayName).toBe('Bare Norsk');
  });
});

/**
 * CV-4c-2b — the catalog snapshot builder (`readDerivedRegistrySnapshot`). Enumerates the whole
 * catalog, assembles each drug, and merges the derived tier with the reviewed override tier via CV-4a.
 * The load-bearing invariant: a catalog that adds no derived model reproduces `REGISTRY_CHECKSUM`
 * bit-for-bit (the offline pin path). Also covers override supersession and alias-collision stripping.
 */
describe('CV-4c-2b — derived registry snapshot builder', () => {
  /** Seed a fully-modelable IV bolus drug (t½ + Vd) with the given slug/aliases. */
  async function seedIvModelableDrug(slug: string, aliases: string[] = []): Promise<void> {
    const drugId = await seedDrug(db, { slug, names: { en: slug }, aliases });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
  }

  it('reproduces REGISTRY_CHECKSUM when the catalog adds no derived model', async () => {
    // No drugs seeded → derived is empty → the snapshot is exactly the reviewed override tier, and its
    // checksum must equal the pinned one (the reproducibility guarantee, plan §6).
    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.version).toBe(REGISTRY_VERSION);
    expect(build.snapshot.checksum).toBe(REGISTRY_CHECKSUM);
    expect(build.snapshot.definitions).toHaveLength(registeredAnalytes().length);
    expect(build.snapshot.supersededByOverride).toEqual([]);
    expect(build.notModelable).toEqual([]);
  });

  it('adds a modelable derived drug after the override tier', async () => {
    await seedIvModelableDrug('novel-analyte');
    const build = await readDerivedRegistrySnapshot();
    const analytes = build.snapshot.definitions.map((d) => d.analyte);
    // Overrides first, the derived entry appended.
    expect(analytes.slice(0, registeredAnalytes().length)).toEqual(registeredAnalytes());
    expect(analytes).toContain('novel-analyte');
    const derivedDef = build.snapshot.definitions.find((d) => d.analyte === 'novel-analyte')!;
    expect(derivedDef.modelId).toBe('novel-analyte-derived-v1');
    expect(Object.keys(derivedDef.routes)).toEqual(['iv']);
    expect(build.snapshot.supersededByOverride).toEqual([]);
  });

  it('lets a reviewed override supersede a derived drug sharing its analyte', async () => {
    const overrideAnalyte = registeredAnalytes()[0]!;
    await seedIvModelableDrug(overrideAnalyte); // same slug as a reviewed model
    const build = await readDerivedRegistrySnapshot();
    // The derived entry is dropped; the reviewed override remains authoritative.
    expect(build.snapshot.supersededByOverride).toContain(overrideAnalyte);
    // Exactly one definition resolves under that analyte, and it is the hand-authored one
    // (a derived model uses modelId `<slug>-derived-v1`).
    const claiming = build.snapshot.definitions.filter((d) => d.analyte === overrideAnalyte);
    expect(claiming).toHaveLength(1);
    expect(claiming[0]!.modelId).not.toContain('-derived-v1');
  });

  it('drops the grade of a derived entry an override supersedes', async () => {
    // The grade must not outlive the definition it describes. A catalog drug sharing a reviewed
    // analyte is dropped from the release, so keeping its grade would make derivedRouteGrade()
    // answer with derived-tier facts for an analyte the REVIEWED tier serves.
    const overrideAnalyte = registeredAnalytes()[0]!;
    await seedIvModelableDrug(overrideAnalyte);
    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.supersededByOverride).toContain(overrideAnalyte);
    expect(build.derivedGrades.map((g) => g.analyte)).not.toContain(overrideAnalyte);
  });

  it('keeps the grade of a derived entry an override only aliases past', async () => {
    // The mirror case: a distinct drug whose catalog ALIAS equals a reviewed analyte is not
    // superseded (it resolves under its own slug), so its grade must survive.
    const overrideAnalyte = registeredAnalytes()[0]!;
    await seedIvModelableDrug('alias-collides', [overrideAnalyte]);
    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.supersededByOverride).not.toContain('alias-collides');
    expect(build.derivedGrades.map((g) => g.analyte)).toContain('alias-collides');
  });

  it('does not let a drug whose catalog alias equals a reviewed analyte resolve to the wrong model', async () => {
    const overrideAnalyte = registeredAnalytes()[0]!;
    // A distinct drug whose catalog alias happens to equal a reviewed analyte — the derived model must
    // NOT carry that label as an analyte id (which would collide with / shadow the reviewed model). It
    // resolves only under its own unique slug.
    await seedIvModelableDrug('distinct-drug', [overrideAnalyte]);
    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.supersededByOverride).not.toContain('distinct-drug');
    const survivor = build.snapshot.definitions.find((d) => d.analyte === 'distinct-drug')!;
    expect(survivor).toBeDefined();
    expect(survivor.aliases).toBeUndefined();
  });

  it('carries a grade for every assembled route of a derived model', async () => {
    // The CV-3 ↔ CV-4 join: a consumer resolving this model from the committed artifact must be
    // able to grade it. Facts travel, not a computed grade.
    const drugId = await seedDrug(db, { slug: 'graded-analyte', names: { en: 'graded-analyte' } });
    const userId = await seedUser(db);
    // Absorption asserted per route; disposition and elimination left unstated so they take the
    // disclosed default — which is exactly what the grade has to disclose.
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { median: 0.75, unit: 'fraction' });
    await insertNumeric(drugId, userId, 'tmax', 'oral', { median: 1, unit: 'h' });

    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.definitions.map((d) => d.analyte)).toContain('graded-analyte');

    const grade = build.derivedGrades.find((g) => g.analyte === 'graded-analyte');
    expect(grade).toBeDefined();
    expect(grade!.routes).toHaveLength(1);
    const oral = grade!.routes[0]!;
    expect(oral.route).toBe('oral');
    expect(oral.family).toBe('one-compartment-first-order');
    expect(oral.axisProvenance).toEqual({
      disposition: 'defaulted',
      elimination: 'defaulted',
      absorption: 'asserted',
    });
    // The ka came from the Tmax inference, and that fact reaches the artifact.
    expect(oral.inferredParameters).toEqual(['ka']);
    // The route assembled, so nothing required is missing — and crucially the inferred ka is NOT
    // also recorded as missing, which would penalise the model twice for one parameter.
    expect('missingParameters' in oral).toBe(false);
    const rebuilt = derivedModelFromGrade(oral);
    expect(rebuilt.missingParameters).toBeUndefined();
    expect(
      gradeDerivedModel(rebuilt, { inferredParameters: oral.inferredParameters }).factors.find(
        (f) => f.factor === 'completeness',
      )?.grade,
    ).toBe('A');
  });

  it('records no grade for a drug that assembles no route', async () => {
    await seedDrug(db, { slug: 'ungraded-analyte' });
    const build = await readDerivedRegistrySnapshot();
    expect(build.derivedGrades.map((g) => g.analyte)).not.toContain('ungraded-analyte');
  });

  it('reports a drug with no runnable route as not-modelable and omits it', async () => {
    await seedDrug(db, { slug: 'unmodelable' }); // no route declarations at all
    const build = await readDerivedRegistrySnapshot();
    expect(build.notModelable.map((entry) => entry.slug)).toContain('unmodelable');
    expect(build.snapshot.definitions.map((d) => d.analyte)).not.toContain('unmodelable');
  });
});

/**
 * The `ka`-from-Tmax inference, read end to end against the real DB.
 *
 * The catalog holds no `ka` for any drug and no reviewer authors one per route, so every
 * extravascular route was incomplete by construction. A route-scoped Tmax is the observable the
 * literature actually reports, and `kinetics-core/ka-inference.ts` solves the absorption rate from
 * it. These cases pin the whole path — route-scoped read → pooling → inference → assembly — and,
 * just as importantly, the cases where the inference must REFUSE.
 */
describe('CV-2c — ka inferred from a route-scoped Tmax', () => {
  /** Declare a one-compartment, first-order-elimination drug with one first-order route. */
  async function seedExtravascularDrug(
    drugId: number,
    userId: number,
    route: string,
  ): Promise<void> {
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', route);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'bioavailability', route, { median: 0.75, unit: 'fraction' });
  }

  /** The Tmax the forward relation gives for an inferred ka — the round-trip check. */
  function tmaxFor(ka: number, halfLifeHours: number): number {
    const ke = Math.LN2 / halfLifeHours;
    return Math.log(ka / ke) / (ka - ke);
  }

  it('solves ka from a route-scoped Tmax and assembles the route', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await seedExtravascularDrug(drugId, userId, 'oral');
    // t½ = 4 h → ke = 0.173/h, so 1/ke = 5.77 h; a 1 h Tmax is comfortably inside the inferable
    // (absorption-faster-than-elimination) regime.
    await insertNumeric(drugId, userId, 'tmax', 'oral', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    const oral = inputs[0]!;
    expect(oral.route).toBe('oral');
    expect(oral.values.ka).toBeGreaterThan(0);
    // The inferred rate reproduces the Tmax it was solved from.
    expect(tmaxFor(oral.values.ka!, 4)).toBeCloseTo(1, 8);
    // And it is declared as inferred, so the grade and the disclosure can name it.
    expect(oral.inferredParameters).toEqual(['ka']);

    const assembly = assembleDrugDefinition(
      {
        analyte: 'test-drug',
        displayName: 'Test Drug',
        modelId: 'derived:test-drug',
        matrix: 'plasma',
        validationStatus: 'literature-derived',
        supportedBases: ['parent'],
      },
      inputs,
    );
    expect(assembly.outcome).toBe('assembled');
    if (assembly.outcome !== 'assembled') throw new Error('expected assembled');
    expect(assembly.definition.routes.oral!.family).toBe('one-compartment-first-order');
    // The inference rides along with the route's outcome.
    expect(assembly.routeOutcomes[0]).toMatchObject({ route: 'oral', inferred: ['ka'] });
  });

  it('works the same for intranasal and inhalation', async () => {
    for (const route of ['intranasal', 'inhalation'] as const) {
      await resetIntegrationDb(db);
      const drugId = await seedDrug(db);
      const userId = await seedUser(db);
      await seedExtravascularDrug(drugId, userId, route);
      // A fast insufflated/smoked absorption: a 10-minute Tmax.
      await insertNumeric(drugId, userId, 'tmax', route, { median: 0.167, unit: 'h' });

      const inputs = await readDrugRouteAssemblyInputs(drugId);
      expect(inputs, route).toHaveLength(1);
      expect(inputs[0]!.route, route).toBe(route);
      expect(inputs[0]!.inferredParameters, route).toEqual(['ka']);
      expect(tmaxFor(inputs[0]!.values.ka!, 4)).toBeCloseTo(0.167, 8);
    }
  });

  it('keeps each route’s Tmax separate — a fast nasal route is not given the slow oral rate', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'intranasal');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { median: 0.4, unit: 'fraction' });
    await insertNumeric(drugId, userId, 'bioavailability', 'intranasal', { median: 0.8, unit: 'fraction' });
    await insertNumeric(drugId, userId, 'tmax', 'oral', { median: 2, unit: 'h' });
    await insertNumeric(drugId, userId, 'tmax', 'intranasal', { median: 0.25, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    const byRoute = new Map(inputs.map((i) => [i.route, i]));
    const oralKa = byRoute.get('oral')!.values.ka!;
    const nasalKa = byRoute.get('intranasal')!.values.ka!;
    expect(tmaxFor(oralKa, 4)).toBeCloseTo(2, 8);
    expect(tmaxFor(nasalKa, 4)).toBeCloseTo(0.25, 8);
    // The whole point of keying Tmax by route: the faster route gets the faster absorption.
    expect(nasalKa).toBeGreaterThan(oralKa);
  });

  it('lets a cited route-scoped ka win over the Tmax inference', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await seedExtravascularDrug(drugId, userId, 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 0.9, unit: '1/h' });
    await insertNumeric(drugId, userId, 'tmax', 'oral', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs[0]!.values.ka).toBeCloseTo(0.9, 6);
    // Authored evidence is not an inference, and must not be labelled as one.
    expect(inputs[0]!.inferredParameters).toBeUndefined();
  });

  it('refuses the flip-flop regime and leaves the route incomplete', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await seedExtravascularDrug(drugId, userId, 'oral');
    // Tmax 8 h against a 4 h half-life (1/ke = 5.77 h): absorption is the slower process, so the
    // stored half-life is not safely an ELIMINATION half-life. No ka is manufactured from it.
    await insertNumeric(drugId, userId, 'tmax', 'oral', { median: 8, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs[0]!.values.ka).toBeUndefined();
    expect(inputs[0]!.inferredParameters).toBeUndefined();
    // The refusal is recorded, not silent: a curator can tell "the Tmax was there and the
    // arithmetic rejected it" (a finding about this drug's stored values) from "no Tmax".
    expect(inputs[0]!.inferenceDeclined).toMatch(/absorption-rate-limited/);

    const assembly = assembleDrugDefinition(
      {
        analyte: 'test-drug',
        displayName: 'Test Drug',
        modelId: 'derived:test-drug',
        matrix: 'plasma',
        validationStatus: 'literature-derived',
        supportedBases: ['parent'],
      },
      inputs,
    );
    expect(assembly.outcome).toBe('not-modelable');
    expect(assembly.routeOutcomes[0]).toMatchObject({ outcome: 'incomplete', missing: ['ka'] });
    expect(assembly.routeOutcomes[0]!.inferenceDeclined).toMatch(/absorption-rate-limited/);
  });

  it('uses a drug-level Tmax when the drug declares exactly one route', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await seedExtravascularDrug(drugId, userId, 'oral');
    // No route label on this Tmax — but there is only one route it could describe.
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs[0]!.inferredParameters).toEqual(['ka']);
    expect(tmaxFor(inputs[0]!.values.ka!, 4)).toBeCloseTo(1, 8);
  });

  it('refuses to attribute a drug-level Tmax when the drug declares several routes', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'intranasal');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    // An unlabelled Tmax cannot be told apart from an oral one, an insufflated one, or neither —
    // so it is attributed to no route rather than to both.
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.values.ka, input.route).toBeUndefined();
      expect(input.inferredParameters, input.route).toBeUndefined();
    }
  });

  it('prefers a route-scoped Tmax over the drug-level figure', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await seedExtravascularDrug(drugId, userId, 'oral');
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 3, unit: 'h' });
    await insertNumeric(drugId, userId, 'tmax', 'oral', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    // The route's own measurement, not the drug-wide one.
    expect(tmaxFor(inputs[0]!.values.ka!, 4)).toBeCloseTo(1, 8);
  });

  it('does not infer a ka for an IV route, which has no absorption phase', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'one-compartment');
    await insertAxis(drugId, userId, 'eliminationModel', 'first-order');
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs[0]!.values.ka).toBeUndefined();
    expect(inputs[0]!.inferredParameters).toBeUndefined();
    // The IV route still assembles: it never needed a ka.
    expect(inputs[0]!.derived.family).toBe('iv-one-compartment');
  });
});

/**
 * CV-2c-7 — the attributed oral route, read end to end against the real DB.
 *
 * Requiring a route-scoped row before anything derives is right for a drug whose curation names
 * routes, and wrong for the 694 catalog drugs that name none while holding a drug-level Tmax and F
 * — quantities only an absorption phase produces. These cases pin what the attribution does (fills
 * in the unstated LABEL, disclosed as an assumption) and, more importantly, what it must never do:
 * displace an authored route, or manufacture a route out of molecule-level data alone.
 */
describe('CV-2c-7 — attributed oral route', () => {
  it('attributes an oral route from drug-level Tmax + F and assembles a complete model', async () => {
    // The catalog's ordinary shape (this is zopiclone's): t½, Vd, F and Tmax at drug level, no
    // route named anywhere, no structure axis declared.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 5.2, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 1.3, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1.5, unit: 'h' });

    const inputs = await readDrugModelInputsByRoute(drugId);
    expect(inputs.routes).toEqual({ oral: { provenance: 'attributed', presentParameters: ['bioavailability'] } });

    const assembly = await readDrugRouteAssemblyInputs(drugId);
    expect(assembly).toHaveLength(1);
    const oral = assembly[0]!;
    expect(oral.route).toBe('oral');
    expect(oral.routeProvenance).toBe('attributed');
    expect(oral.derived.family).toBe('one-compartment-first-order');
    expect(oral.values.eliminationHalfLife).toBe(5.2);
    expect(oral.values.vd).toBe(1.3);
    // The drug-level F IS this route's F: there is no other route it could belong to.
    expect(oral.values.bioavailability).toBe(0.8);
    // And the drug-level Tmax solves the ka, exactly as a route-scoped one would.
    expect(oral.values.ka).toBeGreaterThan(0);
    expect(oral.inferredParameters).toEqual(['ka']);
  });

  it('derives nothing from molecule-level data alone (missing stays missing)', async () => {
    // t½ + Vd describe the molecule, not an absorption phase — no route is evidenced, so none is
    // attributed and the drug stays honestly unmodelable.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    expect((await readDrugModelInputsByRoute(drugId)).routes).toEqual({});
    expect(await readDrugRouteAssemblyInputs(drugId)).toEqual([]);
  });

  it('never attributes a route when the catalog names one, and still withholds the drug-level F', async () => {
    // The attribution is scoped to drugs that declare NO route, so an authored intranasal route is
    // neither joined by a phantom oral one nor handed the drug-level (oral) F.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'intranasal');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs.map((i) => i.route)).toEqual(['intranasal']);
    expect(inputs[0]!.routeProvenance).toBeUndefined();
    // Not the drug-level (oral) 0.8: the labelled cautious default, disclosed as one.
    expect(inputs[0]!.values.bioavailability).toBe(CAUTIOUS_DEFAULT_BIOAVAILABILITY);
    expect(inputs[0]!.defaultedParameters).toEqual(expect.arrayContaining(['bioavailability']));
  });

  it('gives way to a route-scoped F once one is authored for the oral route', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { median: 0.55, unit: 'fraction' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    // The route is now ASSERTED (a route-scoped row names it), and its own F wins.
    expect(inputs[0]!.routeProvenance).toBeUndefined();
    expect(inputs[0]!.values.bioavailability).toBe(0.55);
  });

  it('names the attribution in the coverage report for a route that could not be assembled', async () => {
    // "oral, missing F" reads as a curation gap in a stated route. A curator has to be able to see
    // that the route was assumed too — that entry is answered by keying the route, not by citing
    // another value.
    const drugId = await seedDrug(db, { slug: 'attributed-incomplete', names: { en: 'attributed-incomplete' } });
    const userId = await seedUser(db);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    // Tmax evidences an absorption phase, but with no Vd the oral route cannot assemble (a volume
    // has no cautious direction, so it is never defaulted). F is absent too: it gets the cautious
    // default, and the report still says so — defaulted is not found.
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const build = await readDerivedRegistrySnapshot();
    const entry = build.notModelable.find((e) => e.slug === 'attributed-incomplete');
    expect(entry?.routes).toEqual([
      {
        route: 'oral',
        outcome: 'incomplete',
        missing: ['vd'],
        inferred: ['ka'],
        routeProvenance: 'attributed',
        defaulted: ['bioavailability'],
      },
    ]);
  });

  it('records the attribution in the committed grade record and grades it as a defaulted input', async () => {
    const drugId = await seedDrug(db, {
      slug: 'attributed-analyte',
      names: { en: 'attributed-analyte' },
    });
    const userId = await seedUser(db);
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 5.2, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 1.3, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1.5, unit: 'h' });

    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.definitions.map((d) => d.analyte)).toContain('attributed-analyte');
    const grade = build.derivedGrades.find((g) => g.analyte === 'attributed-analyte');
    expect(grade?.routes[0]?.routeProvenance).toBe('attributed');
  });
});

/**
 * A declared disposition richer than the catalog can run.
 *
 * The two-compartment family needs k12, k21 and a central volume, none of which the catalog stores,
 * so a drug that gained a cited "two-compartment" fact used to stop being modelable at all — the
 * catalog learning more took the curve away. It now runs the one-compartment form, and the
 * simplification is recorded so the grade and the coverage report can say so.
 */
describe('declared two-compartment disposition — simplified, not dropped', () => {
  async function seedTwoCompartmentOralDrug(
    slug: string,
  ): Promise<{ drugId: number; userId: number }> {
    const drugId = await seedDrug(db, { slug, names: { en: slug } });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'two-compartment');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 44, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 1.4, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 0.9, unit: 'h' });
    return { drugId, userId };
  }

  it('runs the one-compartment form and records the simplification in the grade record', async () => {
    const { drugId, userId } = await seedTwoCompartmentOralDrug('two-comp-analyte');
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { median: 0.94, unit: 'fraction' });

    const inputs = await readDrugRouteAssemblyInputs(drugId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.derived.family).toBe('one-compartment-first-order');
    expect(inputs[0]!.derived.axisProvenance.disposition).toBe('asserted');
    expect(inputs[0]!.simplifiedFrom).toEqual({ disposition: 'two-compartment' });

    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.definitions.map((d) => d.analyte)).toContain('two-comp-analyte');
    const oral = build.derivedGrades.find((g) => g.analyte === 'two-comp-analyte')!.routes[0]!;
    expect(oral.structure.disposition).toBe('one-compartment');
    expect(oral.simplifiedFrom).toEqual({ disposition: 'two-compartment' });
  });

  it('names the simplified route’s own gap in the coverage report when even that cannot run', async () => {
    // The report should name the simplified route's own gap (closable by a curator), not
    // "two-compartment is not implemented".
    const drugId = await seedDrug(db, { slug: 'two-comp-nasal', names: { en: 'two-comp-nasal' } });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'dispositionModel', 'two-compartment');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'intranasal');
    await insertNumeric(drugId, userId, 'ka', 'intranasal', { median: 2, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    // No Vd: the simplified route still cannot run, and the report names that gap.

    const build = await readDerivedRegistrySnapshot();
    const entry = build.notModelable.find((e) => e.slug === 'two-comp-nasal');
    expect(entry?.routes).toEqual([
      {
        route: 'intranasal',
        outcome: 'incomplete',
        missing: ['vd'],
        simplifiedFrom: { disposition: 'two-compartment' },
        defaulted: ['bioavailability'],
      },
    ]);
  });

  it('does not simplify a saturable elimination to a linear one', async () => {
    // Only disposition is simplified. A Michaelis–Menten drug run as first-order would be
    // qualitatively wrong at exactly the doses that matter, so it stays not-modelable.
    const drugId = await seedDrug(db, { slug: 'saturable-analyte', names: { en: 'saturable-analyte' } });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'eliminationModel', 'michaelis-menten');
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'bioavailability', { median: 0.8, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const build = await readDerivedRegistrySnapshot();
    expect(build.snapshot.definitions.map((d) => d.analyte)).not.toContain('saturable-analyte');
  });
});

/**
 * Owner decision (2026-09-29): a route missing its bioavailability runs on a labelled cautious
 * default (F = 1) rather than producing no curve, and says so in its grade record. Inputs with no
 * cautious direction (ka, t½, Vd) still stay missing.
 */
describe('a cautious default for a missing bioavailability', () => {
  it('runs an oral route with no F on F = 1 and records the default in the grade record', async () => {
    const drugId = await seedDrug(db, { slug: 'no-f-analyte', names: { en: 'no-f-analyte' } });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await setDrugLevelParameter(drugId, userId, 'tmax', { median: 1, unit: 'h' });

    const build = await readDerivedRegistrySnapshot();
    const definition = build.snapshot.definitions.find((d) => d.analyte === 'no-f-analyte');
    const oral = definition?.routes.oral;
    expect(oral?.family).toBe('one-compartment-first-order');
    if (oral?.family !== 'one-compartment-first-order') throw new Error('expected oral first-order');
    expect(oral.bioavailability).toEqual({ kind: 'fixed', value: CAUTIOUS_DEFAULT_BIOAVAILABILITY });
    const grade = build.derivedGrades.find((g) => g.analyte === 'no-f-analyte')!.routes[0]!;
    expect(grade.defaultedParameters).toEqual(['bioavailability']);
    // The Tmax-solved ka is an inference, not a default, and stays recorded as such.
    expect(grade.inferredParameters).toEqual(['ka']);
  });

  it('never defaults ka: a route with no Tmax and no ka stays incomplete', async () => {
    // No absorption rate is cautious at every time — a faster one raises the peak and lowers late
    // concentrations — so a missing ka is never filled.
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'bioavailability', 'oral', { median: 0.7, unit: 'fraction' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const [input] = await readDrugRouteAssemblyInputs(drugId);
    expect(input!.values.ka).toBeUndefined();
    expect(input!.defaultedParameters).toBeUndefined();
    const assembly = await readDrugModelDefinition(drugId);
    expect(assembly.outcome).toBe('not-modelable');
    expect(assembly.routeOutcomes[0]?.missing).toEqual(['ka']);
  });

  it('never defaults a half-life or a volume: a route missing one stays incomplete', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });

    const assembly = await readDrugModelDefinition(drugId);
    expect(assembly.outcome).toBe('not-modelable');
    expect(assembly.routeOutcomes[0]?.missing).toEqual(['vd']);
  });

  it('gives no default to a substance nobody doses (a metabolite)', async () => {
    const drugId = await seedDrug(db, { substanceClass: 'metabolite' });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const [input] = await readDrugRouteAssemblyInputs(drugId);
    expect(input!.values.bioavailability).toBeUndefined();
    expect(input!.defaultedParameters).toBeUndefined();
  });

  it('gives no default to an analyte the canonical list classifies, even while its row says drug', async () => {
    // Regression: every stored `substance_class` is still the `drug` default until the backfill
    // runs, so benzoylecgonine (CID 448223) was given a dose's F. The reviewed list withholds it.
    const drugId = await seedDrug(db, { slug: 'benzoylecgonine-test', pubchemCid: 448223 });
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertNumeric(drugId, userId, 'ka', 'oral', { median: 1, unit: '1/h' });
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 5, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 1, unit: 'L/kg' });

    const [input] = await readDrugRouteAssemblyInputs(drugId);
    expect(input!.values.bioavailability).toBeUndefined();
    expect(input!.defaultedParameters).toBeUndefined();
  });

  it('gives an IV route no default: it needs neither F nor ka', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    await insertAxis(drugId, userId, 'absorptionModel', 'bolus', 'iv');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });

    const [input] = await readDrugRouteAssemblyInputs(drugId);
    expect(input!.defaultedParameters).toBeUndefined();
    expect(input!.values.bioavailability).toBeUndefined();
  });
});


describe('per-input sources in the grade record', () => {
  /** A drug-level or route-scoped numeric entry that cites `citationId` (null: no citation). */
  async function insertSourced(
    drugId: number,
    userId: number,
    parameter: string,
    route: string | null,
    median: number,
    unit: string,
    citationId: number | null,
  ): Promise<void> {
    await db.insert(parameterEntries).values({
      drugId,
      parameter,
      low: String(median),
      median: String(median),
      unit,
      route,
      citationId,
      createdBy: userId,
      origin: 'contributor',
    } as never);
  }

  /** Publish a drug-level aggregate the way the entry write path does. */
  async function recompute(drugId: number, userId: number, parameter: 'halfLife' | 'volumeOfDistribution') {
    await runInPoolTransaction(() => recomputeAndCacheParameterSummary(drugId, parameter, userId));
  }

  async function oralSources(slug: string) {
    const build = await readDerivedRegistrySnapshot();
    return build.derivedGrades.find((g) => g.analyte === slug)?.routes[0];
  }

  it('records cited entries behind every input the curve runs on', async () => {
    const drugId = await seedDrug(db, { slug: 'cited-analyte', names: { en: 'cited-analyte' } });
    const userId = await seedUser(db);
    const c1 = await seedAdmissibleCitation(db, { identifier: '1001' });
    const c2 = await seedAdmissibleCitation(db, { identifier: '1002' });
    const c3 = await seedAdmissibleCitation(db, { identifier: '1003' });
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertSourced(drugId, userId, 'halfLife', null, 4, 'h', c1);
    await insertSourced(drugId, userId, 'halfLife', null, 5, 'h', c2);
    await insertSourced(drugId, userId, 'volumeOfDistribution', null, 0.7, 'L/kg', c2);
    await recompute(drugId, userId, 'halfLife');
    await recompute(drugId, userId, 'volumeOfDistribution');
    await insertSourced(drugId, userId, 'bioavailability', 'oral', 0.75, 'fraction', c3);
    await insertSourced(drugId, userId, 'tmax', 'oral', 1, 'h', c3);

    const oral = await oralSources('cited-analyte');
    expect(oral?.inferredParameters).toEqual(['ka']);
    expect(oral?.inputSources).toEqual({
      eliminationHalfLife: { basis: 'cited', citationIds: [c1, c2].sort((a, b) => a - b) },
      vd: { basis: 'cited', citationIds: [c2] },
      bioavailability: { basis: 'cited', citationIds: [c3] },
      // The inferred ka carries the source of the Tmax it was solved from.
      ka: { basis: 'cited', citationIds: [c3] },
    });
  });

  it('marks a seeded drug-level value as authored, and leaves a defaulted F out', async () => {
    const drugId = await seedDrug(db, { slug: 'seeded-analyte', names: { en: 'seeded-analyte' } });
    const userId = await seedUser(db);
    const c1 = await seedAdmissibleCitation(db, { identifier: '2001' });
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await setDrugLevelParameter(drugId, userId, 'halfLife', { median: 4, unit: 'h' });
    await setDrugLevelParameter(drugId, userId, 'volumeOfDistribution', { median: 0.7, unit: 'L/kg' });
    await insertSourced(drugId, userId, 'tmax', 'oral', 1, 'h', c1);

    const oral = await oralSources('seeded-analyte');
    expect(oral?.defaultedParameters).toEqual(['bioavailability']);
    expect(oral?.inputSources).toEqual({
      eliminationHalfLife: { basis: 'uncited', reason: 'authored-value' },
      vd: { basis: 'uncited', reason: 'authored-value' },
      ka: { basis: 'cited', citationIds: [c1] },
    });
  });

  it('marks a pool with an uncited entry, and a cache its entries no longer reproduce', async () => {
    const drugId = await seedDrug(db, { slug: 'mixed-analyte', names: { en: 'mixed-analyte' } });
    const userId = await seedUser(db);
    const c1 = await seedAdmissibleCitation(db, { identifier: '3001' });
    await insertAxis(drugId, userId, 'absorptionModel', 'first-order', 'oral');
    await insertSourced(drugId, userId, 'halfLife', null, 4, 'h', c1);
    await insertSourced(drugId, userId, 'volumeOfDistribution', null, 0.7, 'L/kg', c1);
    await recompute(drugId, userId, 'halfLife');
    await recompute(drugId, userId, 'volumeOfDistribution');
    // Later entries the cache was never recomputed for: the cached t½ is no longer their pool.
    await insertSourced(drugId, userId, 'halfLife', null, 9, 'h', c1);
    await insertSourced(drugId, userId, 'halfLife', null, 9, 'h', c1);
    await insertSourced(drugId, userId, 'bioavailability', 'oral', 0.75, 'fraction', c1);
    await insertSourced(drugId, userId, 'tmax', 'oral', 1, 'h', null);

    const oral = await oralSources('mixed-analyte');
    expect(oral?.inputSources?.eliminationHalfLife).toEqual({ basis: 'uncited', reason: 'stale-cache' });
    expect(oral?.inputSources?.vd).toEqual({ basis: 'cited', citationIds: [c1] });
    expect(oral?.inputSources?.ka).toEqual({ basis: 'uncited', reason: 'uncited-entry' });
  });
});
