/**
 * Loader + validator for the PM/AM (postmortem/antemortem) drug concentration
 * ratio dataset transcribed from Table I of:
 *
 *   Mantinieks D, Gerostamoulos D, Glowacki L, Di Rago M, Schumann J,
 *   Woodford NW, Drummer OH. "Postmortem Drug Redistribution: A Compilation of
 *   Postmortem/Antemortem Drug Concentration Ratios."
 *   J Anal Toxicol 2021;45(4):368-377. doi:10.1093/jat/bkaa107
 *
 * The transcription lives in `resources/pm-am-ratios-mantinieks-2021.json` so
 * the numbers stay reviewable as plain data, separate from the write logic in
 * `scripts/seed-pm-am-ratios.ts`.
 *
 * Every row becomes ONE `parameter_entries` row for the `pmAmRatio` parameter:
 * the paper's median PM/AM ratio as the entry's central estimate, its reported
 * range as the bounds, and its case count as `n`. The study context that does
 * not fit a numeric column — drug class, the two time intervals, the p-value,
 * and the drug-specific caveats — goes into the entry's `comments`, which is
 * where a matrix-independent parameter records its context (`matrix` and
 * `scenario` are rejected for `pmAmRatio` by design).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  parameterEntryInputSchema,
  type ParameterEntryInput,
} from '../../src/lib/parameterEntries';
import {
  validateDoseContext,
  type CentralStatistic,
  type IntervalKind,
} from '../../src/lib/entryDoseContext';

export const DATASET_PATH = resolve(
  process.cwd(),
  'resources/pm-am-ratios-mantinieks-2021.json',
);

/** The drug parameter every row of this dataset backs. */
export const PM_AM_PARAMETER = 'pmAmRatio' as const;

/** `parameter_entries.unit` for a dimensionless ratio (registry `allowedUnits`). */
export const PM_AM_UNIT = 'ratio' as const;

const sourceSchema = z.object({
  type: z.literal('doi'),
  identifier: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string().min(1)).min(1),
  journal: z.string().min(1),
  year: z.number().int(),
  volume: z.string().min(1),
  issue: z.string().min(1),
  pages: z.string().min(1),
  url: z.string().url(),
});

const studySchema = z.object({
  design: z.string().min(1),
  cases: z.number().int().positive(),
  pmMatrix: z.string().min(1),
  amMatrix: z.string().min(1),
  medianT1Hours: z.number().positive(),
  medianT2Hours: z.number().positive(),
  inclusionRule: z.string().min(1),
  statistics: z.string().min(1),
  notReported: z.string().min(1),
});

const rowSchema = z
  .object({
    /** Analyte name exactly as Table I prints it. */
    drug: z.string().min(1),
    /**
     * Match key against `drugs.pubchem_cid`. A CID is language-independent, so
     * the English table maps onto the Norwegian-named drug rows without a
     * name-translation table.
     */
    pubchemCid: z.number().int().positive(),
    /**
     * PubChem's own Title for `pubchemCid`, recorded at transcription time so
     * the CID↔analyte mapping is auditable in review without a network call.
     * This is not a lookup key — it caught one transposed CID that resolved to
     * an unrelated peptide. Differs from `drug` where the paper's analyte name
     * is not PubChem's preferred one (Methylamphetamine/Methamphetamine,
     * Paracetamol/Acetaminophen, Desmethylvenlafaxine/Desvenlafaxine).
     */
    pubchemName: z.string().min(1),
    class: z.string().min(1),
    /** Paired AM/PM cases contributing to this row. */
    n: z.number().int().positive(),
    /** Median hours from AM specimen collection to death. */
    t1Hours: z.number().nonnegative(),
    /** Median hours from death to PM femoral blood collection. */
    t2Hours: z.number().nonnegative(),
    median: z.number().positive(),
    low: z.number().positive(),
    high: z.number().positive(),
    pValue: z.string().min(1),
    significant: z.boolean(),
    note: z.string().min(1).optional(),
  })
  .refine((r) => r.low <= r.median && r.median <= r.high, {
    message: 'median must lie within low..high',
  });

const datasetSchema = z.object({
  $schema: z.literal('kinetix-pm-am-ratio-dataset-v1'),
  source: sourceSchema,
  study: studySchema,
  caveats: z.array(z.string().min(1)).min(1),
  entries: z.array(rowSchema).min(1),
});

export type PmAmDataset = z.infer<typeof datasetSchema>;
export type PmAmRow = z.infer<typeof rowSchema>;

/** Parse and validate an already-read dataset object. Throws on any defect. */
export function parsePmAmDataset(raw: unknown): PmAmDataset {
  const dataset = datasetSchema.parse(raw);
  const seen = new Set<number>();
  for (const row of dataset.entries) {
    if (seen.has(row.pubchemCid)) {
      throw new Error(
        `Duplicate pubchemCid ${row.pubchemCid} (${row.drug}) — one row per analyte`,
      );
    }
    seen.add(row.pubchemCid);
  }
  return dataset;
}

/** Read + validate the committed dataset file. */
export function loadPmAmDataset(path: string = DATASET_PATH): PmAmDataset {
  return parsePmAmDataset(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Human-readable study context for one row, stored on the entry.
 *
 * Deliberately self-contained: an entry's comment is what a reader sees next to
 * the number in the parameter's entry list, and a PM/AM ratio is easy to
 * misread as a back-calculation factor. So the note carries the sampling
 * design, the two elapsed-time medians it is conditional on, the significance
 * test result, and any drug-specific caveat from the paper.
 *
 * Written in Norwegian, like every other reader-facing string Kinetix stores —
 * the dataset's `class` and `note` fields are Norwegian for the same reason.
 * Only the study's own institution name and the identifiers (AM/PM, CID,
 * drug names) stay as they are.
 */
export function buildEntryComments(row: PmAmRow): string {
  const parts = [
    `${row.class}. Median PM/AM-ratio fra ${row.n} parvise saker: antemortem klinisk prøve mot postmortalt femoralblod tatt ved innkomst til rettsmedisinsk avdeling (Victorian Institute of Forensic Medicine, 2009-2017).`,
    `Median tid fra AM-prøve til død ${row.t1Hours} t; median tid fra død til postmortal prøvetaking ${row.t2Hours} t.`,
    row.significant
      ? `Forskjellen mellom parvise AM- og PM-konsentrasjoner er statistisk signifikant (P ${row.pValue}).`
      : `Ingen statistisk signifikant forskjell mellom parvise AM- og PM-konsentrasjoner (P ${row.pValue}).`,
  ];
  if (row.note) parts.push(row.note);
  parts.push(
    `Parvise prøver, ikke ett prøvested tatt to ganger: antemortem-prøven er en rutinemessig sykehusprøve fra uoppgitt sted (omtrent 35 % plasma eller serum framfor fullblod), så forskjeller i prøvested og matriks ligger innbakt i ratioen sammen med den postmortale endringen. Bare en indikator på populasjonsnivå — ikke en faktor for å regne tilbake til en antemortem konsentrasjon.`,
  );
  const comments = parts.join(' ');
  // The column accepts 2000 characters; the schema rejects more, so fail here
  // with the offending drug rather than at the write boundary.
  if (comments.length > 2000) {
    throw new Error(`Comment for ${row.drug} exceeds 2000 characters`);
  }
  return comments;
}

/**
 * Build the validated `parameter_entries` payload for one row. `drugId` and
 * `citationId` are resolved by the caller against the live database.
 */
export function toParameterEntryInput(
  row: PmAmRow,
  drugId: number,
  citationId: number,
): ParameterEntryInput {
  return parameterEntryInputSchema.parse({
    drugId,
    parameter: PM_AM_PARAMETER,
    low: row.low,
    high: row.high,
    median: row.median,
    unit: PM_AM_UNIT,
    n: row.n,
    comments: buildEntryComments(row),
    citationId,
  });
}

/** The fields of a stored `parameter_entries` row the seeder maintains. */
export interface StoredEntryFields {
  /** `numeric` columns come back from the driver as strings. */
  low: string | null;
  high: string | null;
  median: string | null;
  /**
   * The reported statistic a curator may have added since (migration 0135).
   * Once labelled, the reading's centre lives in `centralValue` and `median`
   * is NULL.
   */
  centralValue: string | null;
  centralStatistic: string | null;
  intervalKind: string | null;
  unit: string;
  n: number | null;
  comments: string | null;
}

function sameNumber(stored: string | null, next: number | undefined): boolean {
  if (stored === null) return next === undefined;
  if (next === undefined) return false;
  return Number(stored) === next;
}

/**
 * Whether a stored entry already says exactly what the dataset says.
 *
 * The seeder identifies its row by SOURCE OBSERVATION — (drug, parameter,
 * citation) — and uses this only to decide update-vs-skip. It deliberately does
 * NOT reuse `entryDuplicateExists`, which keys on the value: a corrected bound
 * would there look like a new independent study and insert a second row (double-
 * weighting one paper), while a corrected `n` or comment matches an existing row
 * exactly and would be skipped, stranding a stale sample-size weight.
 */
export function storedEntryMatches(
  stored: StoredEntryFields,
  input: Pick<
    ParameterEntryInput,
    'low' | 'high' | 'median' | 'unit' | 'n' | 'comments'
  >,
): boolean {
  return (
    sameNumber(stored.low, input.low) &&
    sameNumber(stored.high, input.high) &&
    // The dataset's median is the reading's centre, wherever it is stored: a
    // curator labelling the row moves it to `centralValue`, which says what
    // the number is without changing it — not a correction to undo.
    sameNumber(stored.median ?? stored.centralValue, input.median) &&
    stored.unit === input.unit &&
    stored.n === (input.n ?? null) &&
    stored.comments === (input.comments ?? null)
  );
}

/** The reading an update writes: the dataset's numbers, and any curated labels. */
export interface SeededReading {
  low?: number;
  high?: number;
  median?: number;
  centralValue?: number;
  centralStatistic?: CentralStatistic;
  intervalKind?: IntervalKind;
}

/**
 * The reading to write when the dataset corrects a stored row's numbers.
 *
 * An update states the whole reading, so writing only low/high/median would
 * clear a statistic a curator added. A labelled row keeps its labels around
 * the corrected numbers — unless they no longer fit them (an SD that is no
 * longer symmetric, say), which is a question for a human, not for the seeder.
 */
export function seededReadingFor(
  stored: StoredEntryFields,
  input: Pick<ParameterEntryInput, 'low' | 'high' | 'median' | 'unit' | 'n'>,
): { ok: true; reading: SeededReading } | { ok: false; reason: string } {
  if (stored.centralStatistic === null) {
    return { ok: true, reading: { low: input.low, high: input.high, median: input.median } };
  }
  const reading: SeededReading = {
    low: input.low,
    high: input.high,
    centralValue: input.median,
    centralStatistic: stored.centralStatistic as CentralStatistic,
    intervalKind: (stored.intervalKind ?? undefined) as IntervalKind | undefined,
  };
  const reason = validateDoseContext(PM_AM_PARAMETER, 'forbidden', {
    ...reading,
    unit: input.unit,
    n: input.n,
  });
  return reason ? { ok: false, reason } : { ok: true, reading };
}
