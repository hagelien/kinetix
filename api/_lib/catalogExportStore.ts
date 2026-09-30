/**
 * Read the live drug catalog in the shape `data/components.ts` stores it.
 *
 * The counterpart to `scripts/seed-drugs.ts`: that script pushes the fixture
 * into `drugs` / `drug_parameters` / the metabolism tables, this one reads the
 * same tables back out. Kept behind `getDb()` (rather than opening its own
 * connection like the seeder does) so the PGlite integration harness can point
 * it at a real migrated database via `setDbForTesting` and exercise the actual
 * SQL — the joins and sort orders below are where a projection bug would hide.
 *
 * Pure mapping, rendering, and diffing live in `src/lib/catalogExport.ts`.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { getDb, runInPoolTransaction } from './db.js';
import {
  drugs,
  drugParameters,
  drugEliminationRoutes,
  drugMetabolites,
  bioEntities,
} from '../../db/schema.js';
import type { CatalogDrugRow } from '../../src/lib/catalogExport.js';

/**
 * Display label for a non-enzyme elimination route that carries no free-text
 * `label`. The seeder always writes one, but the metabolism edit form can store
 * a route as a bare `kind`, and the fixture has no field for a kind — so give
 * it the same word a curator would have typed ('Renal' is what the existing
 * hand-written entries use).
 */
function routeKindLabel(kind: string): string {
  switch (kind) {
    case 'renal_unchanged':
      return 'Renal';
    case 'fecal_biliary':
      return 'Fecal/biliary';
    case 'metabolized':
      return 'Metabolized';
    case 'other_unchanged':
      return 'Other';
    default:
      return kind;
  }
}

/**
 * Read the whole catalog from a single consistent snapshot.
 *
 * The projection spans four tables read as four separate queries. Outside a
 * transaction each is its own implicit one, so a mutation committing mid-read
 * yields a torn projection: a drug deleted after the `drugs` read survives in
 * memory with its parameters and metabolism emptied by the FK cascades, and a
 * metabolism replacement can pair old routes with new metabolites. Because the
 * output overwrites a curated file, a torn read is silent data corruption
 * rather than a transient glitch.
 *
 * REPEATABLE READ pins every statement in the transaction to one snapshot;
 * READ COMMITTED (the default) would take a fresh one per statement and leave
 * the hazard in place.
 */
export async function loadCatalogRows(): Promise<CatalogDrugRow[]> {
  return runInPoolTransaction(async () => {
    // Must precede any query in the transaction to take effect.
    await getDb().execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    return readCatalogRows();
  });
}

async function readCatalogRows(): Promise<CatalogDrugRow[]> {
  const db = getDb();

  const drugRows = await db
    .select({
      id: drugs.id,
      pubchemCid: drugs.pubchemCid,
      names: drugs.names,
    })
    .from(drugs)
    .orderBy(asc(drugs.id));

  if (drugRows.length === 0) return [];

  const byId = new Map<number, CatalogDrugRow>();
  for (const row of drugRows) {
    byId.set(row.id, {
      pubchemCid: row.pubchemCid,
      names: row.names,
      parameters: {},
      enzymes: [],
      metabolites: [],
      eliminationRoutes: [],
    });
  }

  // Whole-table reads rather than per-drug queries: the catalog is small
  // (hundreds of rows), and this is an offline maintenance path where one round
  // trip per table beats an N+1 across every drug. All four run inside the
  // caller's REPEATABLE READ transaction, so they see one snapshot.
  const parameterRows = await db
    .select({
      drugId: drugParameters.drugId,
      parameter: drugParameters.parameter,
      value: drugParameters.value,
    })
    .from(drugParameters);
  for (const row of parameterRows) {
    const target = byId.get(row.drugId);
    if (target) target.parameters[row.parameter] = row.value;
  }

  // `sortOrder` then `id`: sortOrder is the curated display order the monograph
  // renders, and the id tiebreak keeps two rows sharing a sortOrder from
  // swapping places between runs and showing up as phantom drift.
  const routeRows = await db
    .select({
      drugId: drugEliminationRoutes.drugId,
      kind: drugEliminationRoutes.kind,
      label: drugEliminationRoutes.label,
      entitySymbol: bioEntities.symbol,
      entityName: bioEntities.name,
    })
    .from(drugEliminationRoutes)
    .leftJoin(bioEntities, eq(drugEliminationRoutes.bioEntityId, bioEntities.id))
    .orderBy(
      asc(drugEliminationRoutes.drugId),
      asc(drugEliminationRoutes.sortOrder),
      asc(drugEliminationRoutes.id),
    );
  for (const row of routeRows) {
    const target = byId.get(row.drugId);
    if (!target) continue;
    if (row.kind === 'enzyme') {
      // Prefer the curated label, fall back to the canonical entity it links
      // to — a route created through the metabolism form may carry only the
      // `bio_entity_id`.
      const label = row.label || row.entitySymbol || row.entityName;
      if (label) target.enzymes.push(label);
    } else {
      target.eliminationRoutes.push(row.label || routeKindLabel(row.kind));
    }
  }

  const metaboliteRows = await db
    .select({
      parentDrugId: drugMetabolites.parentDrugId,
      metaboliteName: drugMetabolites.metaboliteName,
    })
    .from(drugMetabolites)
    .orderBy(
      asc(drugMetabolites.parentDrugId),
      asc(drugMetabolites.sortOrder),
      asc(drugMetabolites.id),
    );
  for (const row of metaboliteRows) {
    const target = byId.get(row.parentDrugId);
    if (target) target.metabolites.push(row.metaboliteName);
  }

  return [...byId.values()];
}
