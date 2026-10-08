/**
 * The live overlay on the derived tier.
 *
 * The committed artifact (`generated-registry.ts`) is a snapshot of what the catalogue built when it
 * was last regenerated. The app also asks the server to build a catalogue drug's model from the
 * database as it stands now (`/api/derived-model`) and hands the answer here; the registry then
 * resolves that drug through the live answer instead of the snapshot:
 *
 *   - a live DEFINITION replaces the snapshot's entry for the analyte, or adds one the snapshot
 *     lacks, and its grade facts replace the snapshot's;
 *   - a live answer of "no model" (`definition: null`) masks the snapshot's entry, so a drug whose
 *     data was withdrawn stops running on what it used to have.
 *
 * The reviewed tier is untouched: the merge primitive still lets an override win any shared analyte,
 * so a live derivation can never displace a reviewed model.
 *
 * Plain data in, plain data held — no fetching here. `kinetics-core` stays portable; the app layer
 * does the network call and the Monte Carlo worker receives the same entries with each run, since a
 * worker has its own copy of this module.
 */
import type { DerivedModelGrade } from './derived-grade.js';
import type { DrugModelDefinition } from './types.js';

export interface LiveDerivedEntry {
  /** The catalogue slug — a derived model's analyte id. */
  analyte: string;
  /** The model the catalogue builds now, or `null` when it builds none. */
  definition: DrugModelDefinition | null;
  /** Grade facts for the definition's assembled routes; `null` with no definition, or when no
   *  route carries a grade (the curve is then withheld as ungradeable). */
  grade: DerivedModelGrade | null;
}

const LIVE = new Map<string, { entry: LiveDerivedEntry; key: string }>();
let generation = 0;

/**
 * Record what the catalogue builds now for one analyte. Returns whether anything changed; an answer
 * identical to the one held is a no-op, so re-sending the same entry with every run does not make
 * the registry rebuild its release.
 */
export function installLiveDerivedEntry(entry: LiveDerivedEntry): boolean {
  if (entry.definition !== null && entry.definition.analyte !== entry.analyte) {
    throw new Error(
      `Live derived entry for "${entry.analyte}" carries a model for "${entry.definition.analyte}"`,
    );
  }
  if (entry.grade !== null && entry.grade.analyte !== entry.analyte) {
    throw new Error(
      `Live derived entry for "${entry.analyte}" carries a grade for "${entry.grade.analyte}"`,
    );
  }
  const key = JSON.stringify(entry);
  if (LIVE.get(entry.analyte)?.key === key) return false;
  LIVE.set(entry.analyte, { entry, key });
  generation += 1;
  return true;
}

/** The live answer held for an analyte, or `undefined` when none has been fetched. */
export function liveDerivedEntry(analyte: string): LiveDerivedEntry | undefined {
  return LIVE.get(analyte)?.entry;
}

/** Every live answer held, in analyte order — what a run hands the worker. */
export function liveDerivedEntries(): LiveDerivedEntry[] {
  return [...LIVE.values()]
    .map((held) => held.entry)
    .sort((a, b) => (a.analyte < b.analyte ? -1 : a.analyte > b.analyte ? 1 : 0));
}

/** Bumped on every change, so the registry knows when its memoised release is stale. */
export function liveDerivedGeneration(): number {
  return generation;
}

/** Drop every live answer (tests, and a consumer that wants the committed snapshot back). */
export function clearLiveDerivedEntries(): void {
  if (LIVE.size === 0) return;
  LIVE.clear();
  generation += 1;
}
