/**
 * Published concentration/time observations, not simulated expectations.
 *
 * Wang et al. (2022), Table 4, PDF page 47. The table and the complete methods
 * were checked against the publisher's open-access PDF on 2026-11-05:
 * https://link.springer.com/content/pdf/10.1007/s40268-021-00375-y.pdf
 * Values are transcribed means and SDs; connecting them is only a visual guide.
 * Predose dashes are missing values, not zero concentrations. Oxazepam was not
 * detected and its glucuronide is a different measurand: neither is substituted
 * for an oxazepam concentration. The study did not measure urinary creatinine.
 */
import type { PatternMatrix, PatternMeasurandMode } from '../../types/patternCase.js';

export interface StudyConcentrationCurve {
  id: string;
  analyte: { pubchemCid: number };
  matrix: PatternMatrix;
  unit: 'ng/mL';
  measurandMode: 'direct';
  normalization: 'raw';
  administeredDrug: { pubchemCid: number };
  doseMg: number;
  route: 'oral';
  participantCount: number;
  statistic: 'arithmetic_mean';
  dispersion: 'sd';
  citation: {
    title: string;
    authors: string;
    year: number;
    doi: string;
    url: string;
    table: number;
  };
  points: ReadonlyArray<{ timeHours: number; mean: number; sd: number }>;
}

const WANG_2022 = {
  title: 'Pharmacokinetics of Diazepam and Its Metabolites in Urine of Chinese Participants',
  authors: 'Wang et al.',
  year: 2022,
  doi: '10.1007/s40268-021-00375-y',
  url: 'https://doi.org/10.1007/s40268-021-00375-y',
  table: 4,
};

const COMMON = {
  matrix: 'urine' as const,
  unit: 'ng/mL' as const,
  measurandMode: 'direct' as const,
  normalization: 'raw' as const,
  administeredDrug: { pubchemCid: 3016 },
  doseMg: 5,
  route: 'oral' as const,
  participantCount: 28,
  statistic: 'arithmetic_mean' as const,
  dispersion: 'sd' as const,
  citation: WANG_2022,
};

/** A sparse published series is kept sparse; no fitted or extrapolated points. */
export const STUDY_CONCENTRATION_CURVES: readonly StudyConcentrationCurve[] = [
  {
    ...COMMON,
    id: 'wang-2022-urine-diazepam',
    analyte: { pubchemCid: 3016 },
    points: [
      { timeHours: 1, mean: 2.30, sd: 1.36 },
      { timeHours: 2, mean: 1.27, sd: 0.74 },
      { timeHours: 4, mean: 0.96, sd: 0.54 },
      { timeHours: 8, mean: 0.67, sd: 0.33 },
      { timeHours: 12, mean: 0.68, sd: 0.25 },
      { timeHours: 24, mean: 0.46, sd: 0.26 },
      { timeHours: 48, mean: 0.42, sd: 0.25 },
      { timeHours: 72, mean: 0.35, sd: 0.20 },
      { timeHours: 144, mean: 0.16, sd: 0.08 },
      { timeHours: 288, mean: 0.07, sd: 0.05 },
      { timeHours: 360, mean: 0.06, sd: 0.04 },
    ],
  },
  {
    ...COMMON,
    id: 'wang-2022-urine-nordiazepam',
    analyte: { pubchemCid: 2997 },
    points: [
      // 0.04 ± 0.26 is the published entry; do not silently "correct" its SD.
      { timeHours: 1, mean: 0.04, sd: 0.26 },
      { timeHours: 2, mean: 0.35, sd: 0.28 },
      { timeHours: 4, mean: 0.27, sd: 0.11 },
      { timeHours: 8, mean: 0.38, sd: 0.22 },
      { timeHours: 12, mean: 0.45, sd: 0.27 },
      { timeHours: 24, mean: 0.49, sd: 0.24 },
      { timeHours: 48, mean: 0.71, sd: 0.36 },
      { timeHours: 72, mean: 0.96, sd: 0.47 },
      { timeHours: 144, mean: 0.81, sd: 0.33 },
      { timeHours: 288, mean: 0.52, sd: 0.25 },
      { timeHours: 360, mean: 0.51, sd: 0.27 },
    ],
  },
];

export interface StudyCurveMatch {
  pubchemCid: number;
  matrix?: PatternMatrix;
  measurandMode?: PatternMeasurandMode;
  normalization: 'raw' | 'creatinine';
  /** Living healthy volunteers cannot supply a postmortem reference curve. */
  postmortem?: boolean;
  /** When stated, a hydrolysis protocol must be compatible with direct assay. */
  hydrolysis?: string;
}

export function eligibleStudyCurves(input: StudyCurveMatch): readonly StudyConcentrationCurve[] {
  if (
    input.normalization !== 'raw' ||
    input.postmortem ||
    !['direct', 'free'].includes(input.measurandMode ?? 'unknown') ||
    (input.hydrolysis !== undefined && !['not_stated', 'none'].includes(input.hydrolysis))
  ) return [];
  return STUDY_CONCENTRATION_CURVES.filter((curve) =>
    curve.analyte.pubchemCid === input.pubchemCid && curve.matrix === input.matrix,
  );
}
