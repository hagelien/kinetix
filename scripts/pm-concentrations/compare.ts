/**
 * Deciding whether a stored distribution already says what the dataset says.
 *
 * Split out of the seeder so it can be tested: the seeder's module body runs
 * `main()` on import and would open a database connection.
 *
 * The comparison exists so a re-run reports what it actually changed. That
 * report is the only thing standing between "the transcription was corrected"
 * and "every row was rewritten with the values it already had", and an
 * operator re-running this against forensic data is entitled to know which
 * happened.
 */
import type { PmConcentrationRow } from './dataset';

/** The subset of a stored row the comparison reads. */
export type StoredRow = {
  n: number;
  loq: string | null;
  mean: string | null;
  median: string | null;
  p90: string | null;
  p95: string | null;
  p975: string | null;
  tcPlasma: string | null;
  medianOverTc: string | null;
  analyte: string;
  anomaly: string | null;
  undrawable: string[];
  reviewNote: string | null;
  printed: Record<string, string>;
};

/**
 * `numeric` columns come back as strings, and the string is not the one that
 * was written: 0.08 is stored at scale 6 and read back as '0.080000'. Compare
 * as numbers, never as text.
 */
export function sameNumber(stored: string | null, next: number | null): boolean {
  if (stored === null) return next === null;
  if (next === null) return false;
  return Number(stored) === next;
}

/**
 * Compare two `printed` maps by content, not by serialization.
 *
 * `printed` is `jsonb`, and Postgres does not keep a jsonb object's keys in the
 * order they were written — it normalizes them (shortest key first, then
 * bytewise). `JSON.stringify` is order-sensitive, so stringifying both sides
 * calls every row whose `printed` holds more than one key changed, on every
 * run, forever: the seeder rewrites identical values and its own Updated/Same
 * tally stops meaning "this re-run touched something".
 *
 * Arrays are deliberately not routed through here. `undrawable` is an array,
 * jsonb preserves array order, and there the order is part of the value.
 */
export function samePrinted(
  stored: Record<string, string> | null | undefined,
  next: Record<string, string> | undefined,
): boolean {
  const a = stored ?? {};
  const b = next ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Analytes the dataset claims that the cohort does not actually hold.
 *
 * `committedDrugIds` must come from a read taken AFTER the seeding transaction
 * commits — see the call site. Entries whose CID resolved to no drug at all are
 * excluded: those are reported separately as `missing` (--no-create-drugs), and
 * listing them here would describe the same gap twice.
 */
export function findAbsentAnalytes(
  entries: readonly PmConcentrationRow[],
  drugIdByCid: ReadonlyMap<number, number>,
  committedDrugIds: ReadonlySet<number>,
): string[] {
  return entries
    .filter((row) => {
      const drugId = drugIdByCid.get(row.pubchemCid);
      return drugId != null && !committedDrugIds.has(drugId);
    })
    .map((row) => `${row.analyte} (CID ${row.pubchemCid})`);
}

/** Whether the stored distribution already says exactly what the dataset says. */
export function storedRowMatches(
  stored: StoredRow,
  row: PmConcentrationRow,
): boolean {
  return (
    stored.n === row.n &&
    stored.analyte === row.analyte &&
    sameNumber(stored.loq, row.loq) &&
    sameNumber(stored.mean, row.mean) &&
    sameNumber(stored.median, row.median) &&
    sameNumber(stored.p90, row.p90) &&
    sameNumber(stored.p95, row.p95) &&
    sameNumber(stored.p975, row.p975) &&
    sameNumber(stored.tcPlasma, row.tcPlasma) &&
    sameNumber(stored.medianOverTc, row.medianOverTc) &&
    stored.anomaly === (row.anomaly ?? null) &&
    stored.reviewNote === (row.reviewNote ?? null) &&
    JSON.stringify(stored.undrawable ?? []) ===
      JSON.stringify(row.undrawable ?? []) &&
    samePrinted(stored.printed, row.printed)
  );
}
