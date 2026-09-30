/**
 * Loader + validator for a postmortem concentration distribution dataset.
 *
 * A dataset is a plain JSON transcription of a source table, kept separate
 * from the write logic in `scripts/seed-pm-concentrations.ts` so the numbers
 * stay reviewable as data — the same split as the PM/AM ratio dataset.
 *
 * The file itself is NOT in this repository. The first cohort is unpublished
 * material, so its transcription is kept outside the repo and the operator
 * passes its path explicitly; there is deliberately no default path to fall
 * back on. The format is exercised by the synthetic fixture in
 * `tests/fixtures/pm-concentrations-synthetic.json`.
 *
 * The validation here is doing real work, not shape-checking. A transcribed
 * order-statistics table has exactly one internal consistency rule
 * (median ≤ p90 ≤ p95 ≤ p97.5), and it is the only automatic check that can
 * catch a mistyped digit in a column of hundreds of numbers nobody will read
 * twice. So a violation is an ERROR, and a row the source really prints out of
 * order has to say so out loud — in the row, in Norwegian, next to the number
 * it is about.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PM_STATISTIC_IDS } from '../../src/lib/pmConcentrations';

const sourceSchema = z.object({
  /** Stable slug; the seeder's upsert target and the API's source key. */
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'key must be a lowercase slug'),
  type: z.enum(['presentation', 'article', 'report']),
  /** Rendered verbatim beside the numbers. */
  citation: z.string().min(1),
  shortLabel: z.string().min(1).max(40),
  title: z.string().min(1),
  authors: z.array(z.string().min(1)).min(1),
  venue: z.string().min(1),
  year: z.number().int(),
  published: z.boolean(),
});

const studySchema = z.object({
  /** The source table's own heading, shown to the reader unchanged. */
  heading: z.string().min(1),
  matrix: z.string().min(1).max(40),
  unit: z.string().min(1).max(20),
  design: z.string().min(1),
  tcColumn: z.string().min(1),
});

const statisticId = z.enum(PM_STATISTIC_IDS);

const rowSchema = z
  .object({
    /** Analyte name exactly as the source table prints it. */
    analyte: z.string().min(1).max(200),
    /**
     * Match key against `drugs.pubchem_cid`. A CID is language-independent, so
     * the source's English analyte names map onto Norwegian-named drug rows
     * without a translation table.
     */
    pubchemCid: z.number().int().positive(),
    /**
     * PubChem's own Title for `pubchemCid`, recorded at transcription time so
     * the CID↔analyte mapping is auditable in review without a network call.
     * Differs from `analyte` wherever the source's name is not PubChem's
     * preferred one (e.g. Paracetamol/Acetaminophen, Pethidine/Meperidine).
     */
    pubchemName: z.string().min(1),
    /**
     * Name to create the substance under, when PubChem's Title is a systematic
     * name no reader would recognise (some alkaloids and metabolites are titled
     * only by their IUPAC-style name). Defaults to `pubchemName`, which stays as recorded either way so the
     * CID↔analyte audit trail is not rewritten for presentation.
     */
    displayName: z.string().min(1).optional(),
    /** Used ONLY when the seeder has to create the substance. */
    molecularWeight: z.number().positive(),
    n: z.number().int().positive(),
    // Non-negative rather than positive: a value printed as 0.00 is a real
    // reading rounded to the table's two decimals (a mean below 0.005 mg/L
    // beside a non-zero median), not a missing one. It is transcribed as printed and
    // withheld from the chart via `undrawable` — see the ladder check below.
    loq: z.number().nonnegative().nullable(),
    mean: z.number().nonnegative().nullable(),
    median: z.number().nonnegative().nullable(),
    p90: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable(),
    p975: z.number().nonnegative().nullable(),
    /** The SOURCE's therapeutic plasma concentration, not Kinetix's. */
    tcPlasma: z.number().positive().nullable(),
    /** median(PM)/TC exactly as printed, not recomputed from the columns. */
    medianOverTc: z.number().positive().nullable(),
    /** A defect in the printed table, described rather than corrected. */
    anomaly: z.string().min(1).optional(),
    /** Statistics the anomaly makes unsafe to draw. */
    undrawable: z.array(statisticId).optional(),
    /** An open question about which analyte the row maps to. */
    reviewNote: z.string().min(1).optional(),
    /**
     * The exact string the source prints, for values a JS number cannot
     * reproduce — a percentile printed `0.20` parses to `0.2`.
     *
     * Trailing zeros are a statement about significant figures, and this table
     * is quoted in forensic work, so dropping them silently changes what the
     * source said about its own precision. Carried only where the two differ,
     * so the file stays readable.
     */
    printed: z.record(z.string(), z.string().min(1)).optional(),
  })
  .superRefine((row, ctx) => {
    const ladder: [string, number | null][] = [
      ['median', row.median],
      ['p90', row.p90],
      ['p95', row.p95],
      ['p975', row.p975],
    ];
    const present = ladder.filter((entry): entry is [string, number] =>
      entry[1] != null,
    );
    for (let i = 1; i < present.length; i++) {
      const [prevKey, prev] = present[i - 1]!;
      const [key, value] = present[i]!;
      if (prev <= value) continue;
      // Out of order. Tolerated ONLY when the row says so AND withholds one of
      // the two statistics that actually disagree — not merely some statistic.
      // A row declaring `undrawable: ['mean']` says nothing about a reversed
      // p90/p95 pair, and accepting it would let the exact mistyped forensic
      // reference line this check exists to stop through the gate wearing an
      // unrelated excuse.
      const withheld = row.undrawable ?? [];
      if (
        row.anomaly &&
        (withheld.includes(prevKey as (typeof PM_STATISTIC_IDS)[number]) ||
          withheld.includes(key as (typeof PM_STATISTIC_IDS)[number]))
      ) {
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${row.analyte}: ${prevKey} (${prev}) exceeds ${key} (${value}). ` +
          'If the source really prints it that way, set `anomaly` explaining ' +
          `it and list ${prevKey} or ${key} in \`undrawable\`.`,
      });
    }
    if (row.undrawable?.length && !row.anomaly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${row.analyte}: \`undrawable\` needs an \`anomaly\` saying why.`,
      });
    }
    for (const stat of row.undrawable ?? []) {
      if (row[stat] != null) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${row.analyte}: \`undrawable\` names ${stat}, which has no value.`,
      });
    }
    // Every printed form must belong to a value this row actually has, and
    // must parse back to it — otherwise the display string and the number it
    // decorates could drift apart, which is worse than not carrying it.
    for (const [key, text] of Object.entries(row.printed ?? {})) {
      const value = (row as Record<string, unknown>)[key];
      if (typeof value !== 'number') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${row.analyte}: \`printed.${key}\` has no numeric value.`,
        });
        continue;
      }
      if (Number(text) !== value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `${row.analyte}: \`printed.${key}\` is "${text}" but the value is ${value}.`,
        });
      }
    }
    // A zero is a rounded reading, never a measurement of nothing. It must be
    // declared, both so the reader learns why the table shows 0,00 and so the
    // value cannot quietly become a chart line at the axis floor.
    for (const stat of PM_STATISTIC_IDS) {
      if (row[stat] !== 0) continue;
      if (row.anomaly && row.undrawable?.includes(stat)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${row.analyte}: ${stat} is 0. A printed 0 is a rounded reading — ` +
          'set `anomaly` explaining it and list the statistic in `undrawable`.',
      });
    }
  });

const datasetSchema = z.object({
  $schema: z.literal('kinetix-pm-concentration-dataset-v1'),
  source: sourceSchema,
  study: studySchema,
  caveats: z.array(z.string().min(1)).min(1),
  entries: z.array(rowSchema).min(1),
});

export type PmConcentrationDataset = z.infer<typeof datasetSchema>;
export type PmConcentrationRow = z.infer<typeof rowSchema>;

/** Parse and validate an already-read dataset object. Throws on any defect. */
export function parsePmConcentrationDataset(
  raw: unknown,
): PmConcentrationDataset {
  const dataset = datasetSchema.parse(raw);
  const cids = new Set<number>();
  const analytes = new Set<string>();
  for (const row of dataset.entries) {
    if (cids.has(row.pubchemCid)) {
      throw new Error(
        `Duplicate pubchemCid ${row.pubchemCid} (${row.analyte}) — one row per analyte per cohort`,
      );
    }
    cids.add(row.pubchemCid);
    const key = row.analyte.toLowerCase();
    if (analytes.has(key)) {
      throw new Error(`Duplicate analyte name "${row.analyte}"`);
    }
    analytes.add(key);
  }
  return dataset;
}

/**
 * Read + validate a dataset file at an explicit path.
 *
 * There is no default: the dataset is kept outside the repository, so a
 * missing path is an operator error to report, not a location to guess.
 */
export function loadPmConcentrationDataset(
  path: string,
): PmConcentrationDataset {
  if (!path) {
    throw new Error(
      'No PM concentration dataset file given. The dataset is kept outside ' +
        'the repository; pass its path explicitly.',
    );
  }
  return parsePmConcentrationDataset(JSON.parse(readFileSync(path, 'utf8')));
}
