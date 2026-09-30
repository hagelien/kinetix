/**
 * Read/write surface for `drug_ionization_constants` (structured pKa).
 *
 * The read path serializes rows into the shared {@link IonizationConstant}
 * shape the frontend and iPMR consume; the write path seeds a drug's profile
 * from a deep-research import, idempotently. Kept in api/_lib (not scripts/) so
 * the PGlite integration suite can exercise it without the CLI.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drugIonizationConstants } from '../../db/schema.js';
import type { IonizationConstant } from '../../src/lib/ionizationConstants.js';
import type { ImportIonizationConstant } from '../../src/lib/deepResearchImport.js';

export type { ImportIonizationConstant };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

interface IonizationConstantRow {
  pka: string;
  protonatedCharge: number;
  deprotonatedCharge: number;
  constantType: string;
  evidenceType: string;
  siteLabel: string | null;
  temperatureC: string | null;
  medium: string | null;
  referenceIds: number[] | null;
  note: string | null;
}

function serializeRow(row: IonizationConstantRow): IonizationConstant {
  const c: IonizationConstant = {
    pKa: Number(row.pka),
    protonatedCharge: row.protonatedCharge,
    deprotonatedCharge: row.deprotonatedCharge,
    type: row.constantType === 'microscopic' ? 'microscopic' : 'macroscopic',
    evidenceType: row.evidenceType === 'predicted' ? 'predicted' : 'experimental',
  };
  if (row.siteLabel) c.siteLabel = row.siteLabel;
  if (row.temperatureC != null) c.temperatureC = Number(row.temperatureC);
  if (row.medium) c.medium = row.medium;
  if (row.referenceIds && row.referenceIds.length) c.referenceIds = row.referenceIds;
  if (row.note) c.note = row.note;
  return c;
}

/**
 * One drug's ionization profile, ordered so the strongest (most protonated)
 * transition comes first — the natural reading order of a titration ladder.
 */
export async function getIonizationConstantsForDrug(
  db: AnyDb,
  drugId: number,
): Promise<IonizationConstant[]> {
  const rows: IonizationConstantRow[] = await db
    .select({
      pka: drugIonizationConstants.pka,
      protonatedCharge: drugIonizationConstants.protonatedCharge,
      deprotonatedCharge: drugIonizationConstants.deprotonatedCharge,
      constantType: drugIonizationConstants.constantType,
      evidenceType: drugIonizationConstants.evidenceType,
      siteLabel: drugIonizationConstants.siteLabel,
      temperatureC: drugIonizationConstants.temperatureC,
      medium: drugIonizationConstants.medium,
      referenceIds: drugIonizationConstants.referenceIds,
      note: drugIonizationConstants.note,
    })
    .from(drugIonizationConstants)
    .where(eq(drugIonizationConstants.drugId, drugId));

  return rows
    .map(serializeRow)
    .sort((a, b) => b.protonatedCharge - a.protonatedCharge);
}

/**
 * Bulk-fetch ionization profiles for many drugs. Returns a map keyed by drugId;
 * drugs with no constants are simply absent.
 */
export async function getIonizationConstantsByDrugIds(
  db: AnyDb,
  drugIds: number[],
): Promise<Map<number, IonizationConstant[]>> {
  const out = new Map<number, IonizationConstant[]>();
  if (drugIds.length === 0) return out;
  const rows: (IonizationConstantRow & { drugId: number })[] = await db
    .select({
      drugId: drugIonizationConstants.drugId,
      pka: drugIonizationConstants.pka,
      protonatedCharge: drugIonizationConstants.protonatedCharge,
      deprotonatedCharge: drugIonizationConstants.deprotonatedCharge,
      constantType: drugIonizationConstants.constantType,
      evidenceType: drugIonizationConstants.evidenceType,
      siteLabel: drugIonizationConstants.siteLabel,
      temperatureC: drugIonizationConstants.temperatureC,
      medium: drugIonizationConstants.medium,
      referenceIds: drugIonizationConstants.referenceIds,
      note: drugIonizationConstants.note,
    })
    .from(drugIonizationConstants)
    .where(inArray(drugIonizationConstants.drugId, drugIds));
  for (const row of rows) {
    const list = out.get(row.drugId) ?? [];
    list.push(serializeRow(row));
    out.set(row.drugId, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.protonatedCharge - a.protonatedCharge);
  }
  return out;
}

export interface IonizationSeedStats {
  inserted: number;
  updated: number;
  skipped: number;
  /**
   * Rows that would have changed but were left untouched by the non-destructive
   * default — a curated (human) row, or a research row whose value differs while
   * `overwrite` is off. Reported, not silently overwritten.
   */
  kept: number;
}

/** `origin` value the importer stamps on the rows it writes (mirrors parameter_entries). */
export const IONIZATION_IMPORT_ORIGIN = 'deep-research';

/**
 * Identity a constant is reconciled on across re-runs: the transition plus the
 * qualifiers that make two rows genuinely distinct measurements rather than the
 * same one restated (evidence provenance, macro/micro, medium, temperature).
 * Two constants for the same transition that differ only in these are separate
 * rows; an exact repeat updates the existing one instead of duplicating.
 */
function reconcileKey(c: {
  protonatedCharge: number;
  deprotonatedCharge: number;
  type: string;
  evidenceType: string;
  siteLabel: string | null;
  medium: string | null;
  temperatureC: number | null;
}): string {
  return [
    c.protonatedCharge,
    c.deprotonatedCharge,
    c.type,
    c.evidenceType,
    // siteLabel distinguishes microscopic equilibria at different ionizable
    // sites that otherwise share a transition; must match the importer's dedupe.
    (c.siteLabel ?? '').toLowerCase(),
    (c.medium ?? '').toLowerCase(),
    c.temperatureC ?? '',
  ].join('\0');
}

/**
 * Seed a drug's ionization constants from an import, idempotently.
 *
 * A re-run reconciles on {@link reconcileKey}: an identical constant is skipped,
 * and a new transition is inserted. A matching-transition row whose pKa/sources
 * differ is only rewritten when it is a research row AND `overwrite` is set —
 * a curated (human) row is never overwritten, and a differing research row is
 * kept-and-reported under the non-destructive default. Different transitions
 * are never merged.
 */
export async function seedIonizationConstants(
  db: AnyDb,
  drugId: number,
  constants: ImportIonizationConstant[],
  resolveRefIds: (sourceIds: string[]) => number[],
  userId: number,
  overwrite = false,
): Promise<IonizationSeedStats> {
  const stats: IonizationSeedStats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    kept: 0,
  };
  if (constants.length === 0) return stats;

  const existing: Array<{
    id: number;
    pka: string;
    protonatedCharge: number;
    deprotonatedCharge: number;
    constantType: string;
    evidenceType: string;
    siteLabel: string | null;
    medium: string | null;
    temperatureC: string | null;
    referenceIds: number[] | null;
    note: string | null;
    origin: string;
  }> = await db
    .select({
      id: drugIonizationConstants.id,
      pka: drugIonizationConstants.pka,
      protonatedCharge: drugIonizationConstants.protonatedCharge,
      deprotonatedCharge: drugIonizationConstants.deprotonatedCharge,
      constantType: drugIonizationConstants.constantType,
      evidenceType: drugIonizationConstants.evidenceType,
      siteLabel: drugIonizationConstants.siteLabel,
      medium: drugIonizationConstants.medium,
      temperatureC: drugIonizationConstants.temperatureC,
      referenceIds: drugIonizationConstants.referenceIds,
      note: drugIonizationConstants.note,
      origin: drugIonizationConstants.origin,
    })
    .from(drugIonizationConstants)
    .where(eq(drugIonizationConstants.drugId, drugId));

  const byKey = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    byKey.set(
      reconcileKey({
        protonatedCharge: row.protonatedCharge,
        deprotonatedCharge: row.deprotonatedCharge,
        type: row.constantType,
        evidenceType: row.evidenceType,
        siteLabel: row.siteLabel,
        medium: row.medium,
        temperatureC: row.temperatureC == null ? null : Number(row.temperatureC),
      }),
      row,
    );
  }

  for (const c of constants) {
    const refIds = resolveRefIds(c.sourceIds);
    const match = byKey.get(reconcileKey(c));
    if (match) {
      bump(stats, await reconcile(db, match, c, refIds, overwrite, userId));
      continue;
    }
    // onConflictDoNothing against the identity unique index: if a concurrent
    // import for the same drug created this measurement between our lookup and
    // here, the loser inserts nothing rather than duplicating the row.
    const insertedRows = await db
      .insert(drugIonizationConstants)
      .values({
        drugId,
        pka: String(c.pKa),
        protonatedCharge: c.protonatedCharge,
        deprotonatedCharge: c.deprotonatedCharge,
        constantType: c.type,
        evidenceType: c.evidenceType,
        siteLabel: c.siteLabel,
        temperatureC: c.temperatureC == null ? null : String(c.temperatureC),
        medium: c.medium,
        referenceIds: refIds.length ? refIds : null,
        note: c.note,
        origin: IONIZATION_IMPORT_ORIGIN,
        createdBy: userId,
        updatedBy: userId,
      })
      .onConflictDoNothing()
      .returning({ id: drugIonizationConstants.id });
    if (insertedRows.length) {
      stats.inserted += 1;
      continue;
    }
    // A concurrent import won the insert. Re-read the row that landed and run
    // the ordinary reconciliation against it, so a losing --overwrite request
    // still applies its correction (and a non-overwrite one reports kept/skipped
    // truthfully) instead of blindly reporting "already present".
    const winner = await findByIdentity(db, drugId, c);
    bump(stats, winner ? await reconcile(db, winner, c, refIds, overwrite, userId) : 'skipped');
  }
  return stats;
}

/** The existing-row fields the reconciliation decision reads. */
interface ExistingConstantRow {
  id: number;
  pka: string;
  referenceIds: number[] | null;
  note: string | null;
  origin: string;
}

function bump(stats: IonizationSeedStats, outcome: keyof IonizationSeedStats): void {
  stats[outcome] += 1;
}

/**
 * Decide what an import reading does to an existing row of the same identity:
 * skip when nothing changed, keep-and-report a curated row or any differing row
 * on a non-destructive run, and update only a row this importer wrote under
 * `--overwrite`. Shared by the pre-loaded-match path and the concurrent-insert
 * recovery path so both make the identical decision.
 */
async function reconcile(
  db: AnyDb,
  existing: ExistingConstantRow,
  c: ImportIonizationConstant,
  refIds: number[],
  overwrite: boolean,
  userId: number,
): Promise<keyof IonizationSeedStats> {
  const sameValue = Number(existing.pka) === c.pKa;
  const sameNote = (existing.note ?? null) === (c.note ?? null);
  const existingRefs = existing.referenceIds ?? [];
  const union = [...new Set([...existingRefs, ...refIds])];

  if (sameValue && sameNote) {
    // The value and caveat match; only the citations may differ.
    if (union.length === existingRefs.length) return 'skipped';
    // Provenance-only union: the import cites additional papers for a constant
    // whose value is unchanged. Attaching them is additive — it never rewrites
    // the human's claim — so it applies even to a curated row and without
    // --overwrite. Otherwise those citations never reach reference_ids and the
    // bibliography, unreviewed-reference sweep and gap queue can't see them.
    //
    // The union is computed IN the UPDATE against the row's current value (read
    // under the row lock), not from the value we read earlier: two imports each
    // adding a different source would otherwise both write their own union and
    // the last one would drop the other's citation. Duplicates are folded by
    // first occurrence (authored reference order is meaningful).
    const incoming = sql`ARRAY[${sql.join(
      refIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::int[]`;
    await db
      .update(drugIonizationConstants)
      .set({
        referenceIds: sql`(
          SELECT array_agg(x ORDER BY ord)
          FROM (
            SELECT x, min(ord) AS ord
            FROM unnest(
              coalesce(${drugIonizationConstants.referenceIds}, '{}'::int[]) || ${incoming}
            ) WITH ORDINALITY AS t(x, ord)
            GROUP BY x
          ) s
        )`,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(drugIonizationConstants.id, existing.id));
    return 'updated';
  }

  // The value or the caveat differs. A curated row, or any change on a
  // non-destructive run, is kept-and-reported; only a row this importer wrote is
  // rewritten under --overwrite.
  if (existing.origin !== IONIZATION_IMPORT_ORIGIN || !overwrite) return 'kept';
  // Value changed: the new reading's own citations back it, so replace rather
  // than union (the old references backed the old value).
  await db
    .update(drugIonizationConstants)
    .set({
      pka: String(c.pKa),
      siteLabel: c.siteLabel,
      note: c.note,
      referenceIds: refIds.length ? refIds : null,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(eq(drugIonizationConstants.id, existing.id));
  return 'updated';
}

/** The existing row sharing a constant's reconciliation identity, if any. */
async function findByIdentity(
  db: AnyDb,
  drugId: number,
  c: ImportIonizationConstant,
): Promise<ExistingConstantRow | undefined> {
  const t = drugIonizationConstants;
  // Temperature is matched numerically (25.1 = 25.10), not as text, so the
  // NUMERIC(5,2) trailing-zero form of a stored value still matches the incoming
  // rounded number; site/medium match case-insensitively with NULL folded to ''.
  const [row] = await db
    .select({
      id: t.id,
      pka: t.pka,
      referenceIds: t.referenceIds,
      note: t.note,
      origin: t.origin,
    })
    .from(t)
    .where(
      and(
        eq(t.drugId, drugId),
        eq(t.protonatedCharge, c.protonatedCharge),
        eq(t.deprotonatedCharge, c.deprotonatedCharge),
        eq(t.constantType, c.type),
        eq(t.evidenceType, c.evidenceType),
        sql`lower(coalesce(${t.siteLabel}, '')) = lower(coalesce(${c.siteLabel}, ''))`,
        sql`lower(coalesce(${t.medium}, '')) = lower(coalesce(${c.medium}, ''))`,
        sql`${t.temperatureC} IS NOT DISTINCT FROM ${
          c.temperatureC == null ? null : String(c.temperatureC)
        }::numeric`,
      ),
    )
    .limit(1);
  return row;
}
