/**
 * Detection times ("påvisningstider") — the read model behind the module of the
 * same name.
 *
 * There is deliberately NO new storage here. A detection window already has a
 * home in the parameter registry: `bloodDetectionWindow`,
 * `oralFluidDetectionWindow` and `urineDetectionWindow` are ordinary
 * `summarizable` range parameters in hours, so every number this module shows
 * is the pooled aggregate of `parameter_entries` source values, each carrying
 * its own citation. The matrix is encoded in the parameter id rather than in an
 * entry's `matrix` column — these three parameters are not `matrixRelevant`, and
 * an entry for one of them must NOT carry a matrix (see
 * `validateEntryForParameter`). This file only decides which parameters make up
 * "all matrices", and how to read a window out of a summary.
 *
 * The one thing it adds is a *derived* reading of that pooled number: the coarse
 * band a forensic report speaks in ("siste døgnet", "siste uken", "siste par
 * ukene"). The band is computed from the window's upper edge every time it is
 * rendered — it is never stored, never authored and never something a source
 * said, so it cannot drift away from the source values it summarizes.
 */
import type { DrugParameterId } from './drugParameters';
import {
  isAggregateCacheValue,
  type ParameterSummary,
} from './parameterEntryAggregation.js';
import { rangeMax, rangeMin, representativeValue } from './rangeUtils.js';
import type { NumericRange } from '../types';

/** Stable key for one detectable matrix — i18n label and test ids hang off it. */
export type DetectionMatrixKey = 'blood' | 'oralFluid' | 'urine';

export interface DetectionMatrixSpec {
  key: DetectionMatrixKey;
  /** The registry parameter that carries this matrix's window, in hours. */
  parameter: DrugParameterId;
}

/**
 * Every matrix Kinetix carries a detection window for, in the order the module
 * shows them: the matrix a sample is most often taken in first, then the two
 * that answer "how far back does this reach".
 *
 * Adding a matrix here means adding the parameter to `DRUG_PARAMETERS` first —
 * this list is a view over the registry, not a second registry. `detectionWindows.test.ts`
 * asserts every entry resolves to a real, entry-backed, hour-valued parameter.
 */
export const DETECTION_MATRICES: readonly DetectionMatrixSpec[] = [
  { key: 'blood', parameter: 'bloodDetectionWindow' },
  { key: 'oralFluid', parameter: 'oralFluidDetectionWindow' },
  { key: 'urine', parameter: 'urineDetectionWindow' },
] as const;

export const DETECTION_WINDOW_PARAMETERS: readonly DrugParameterId[] =
  DETECTION_MATRICES.map((m) => m.parameter);

/**
 * The coarse vocabulary an interpretation is actually written in. A laboratory
 * answers "when was this taken" in bands, not in hours: an 18-hour window and a
 * 22-hour window are the same statement ("the last 24 hours") to the reader,
 * and quoting two different numbers implies a precision the pooled literature
 * does not have.
 */
export type DetectionBand =
  | 'halfDay'
  | 'day'
  | 'days'
  | 'week'
  | 'twoWeeks'
  | 'weeks'
  | 'monthPlus';

/**
 * Upper edge (inclusive, in hours) of each band. Ordered ascending; the first
 * ceiling a window fits under wins. The last band has no ceiling.
 */
const BAND_CEILINGS: readonly { band: DetectionBand; maxHours: number }[] = [
  { band: 'halfDay', maxHours: 12 },
  { band: 'day', maxHours: 24 },
  { band: 'days', maxHours: 96 },
  { band: 'week', maxHours: 168 },
  { band: 'twoWeeks', maxHours: 336 },
  { band: 'weeks', maxHours: 720 },
];

/** Fallback for anything past the last ceiling (≈ a month and beyond). */
const LONGEST_BAND: DetectionBand = 'monthPlus';

export const DETECTION_BANDS: readonly DetectionBand[] = [
  ...BAND_CEILINGS.map((b) => b.band),
  LONGEST_BAND,
];

/**
 * The band a window of `hours` falls in, or null when there is no usable
 * number. Negative and non-finite inputs are rejected rather than clamped: a
 * negative detection time is a data error, and silently reading it as "the last
 * half day" would hide it behind a plausible-looking chip.
 */
export function detectionBandForHours(
  hours: number | null | undefined,
): DetectionBand | null {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
  for (const { band, maxHours } of BAND_CEILINGS) {
    if (hours <= maxHours) return band;
  }
  return LONGEST_BAND;
}

/** One matrix's window for one substance, as the module renders it. */
export interface DetectionWindow {
  key: DetectionMatrixKey;
  parameter: DrugParameterId;
  /** Pooled lower edge, in hours (`summary.min`). */
  lowHours: number | null;
  /** Pooled upper edge, in hours (`summary.max`) — what the band reads. */
  highHours: number | null;
  /** Weighted median of the pooled source values, in hours. */
  representativeHours: number | null;
  band: DetectionBand | null;
  /** Source values recorded for this parameter, poolable or not. */
  entryCount: number;
  /** Source values that made it into the pooled number. */
  pooledCount: number;
  /** Distinct papers behind the pooled number. */
  citationCount: number;
}

const EMPTY_WINDOW = {
  lowHours: null,
  highHours: null,
  representativeHours: null,
  band: null,
  entryCount: 0,
  pooledCount: 0,
  citationCount: 0,
} as const;

/**
 * Read one matrix's window out of a drug's `parameterSummaries`.
 *
 * Always returns a window — a matrix with no source values yet is a real answer
 * ("nothing is recorded here"), and the module says so per matrix rather than
 * dropping the column and leaving the reader to guess whether it was empty or
 * merely not asked about.
 */
export function detectionWindowFor(
  spec: DetectionMatrixSpec,
  summaries: Record<string, ParameterSummary> | null | undefined,
): DetectionWindow {
  const summary = summaries?.[spec.parameter];
  if (!summary) return { key: spec.key, parameter: spec.parameter, ...EMPTY_WINDOW };

  // The band reads the far edge of the window: a detection time is "how long
  // after intake can this still be found", so the longest pooled reading is the
  // statement, not the median. Fall back down the chain when the pool is thin
  // enough that only a central estimate survived.
  const highHours = summary.max ?? null;
  const bandInput = highHours ?? summary.representative ?? summary.min ?? null;

  return {
    key: spec.key,
    parameter: spec.parameter,
    lowHours: summary.min ?? null,
    highHours,
    representativeHours: summary.representative ?? null,
    band: detectionBandForHours(bandInput),
    entryCount: summary.entryCount,
    pooledCount: summary.pooledCount,
    citationCount: (summary.contributingCitationIds ?? []).length,
  };
}

/** Every matrix's window for one substance, in display order. */
export function detectionWindowsFor(
  summaries: Record<string, ParameterSummary> | null | undefined,
): DetectionWindow[] {
  return DETECTION_MATRICES.map((spec) => detectionWindowFor(spec, summaries));
}

/** True when the window has at least one source value to show. */
export function hasDetectionData(window: DetectionWindow): boolean {
  return window.entryCount > 0;
}

/** True when any matrix has a source value — drives the module's empty state. */
export function hasAnyDetectionData(windows: readonly DetectionWindow[]): boolean {
  return windows.some(hasDetectionData);
}

/** Just the band for one matrix — what a side-by-side listing needs. */
export interface DetectionBandReading {
  key: DetectionMatrixKey;
  parameter: DrugParameterId;
  band: DetectionBand | null;
}

/**
 * Band a matrix straight from a drug row's cached parameter values, for callers
 * reading many substances at once (the metabolite listing) where a
 * `ParameterSummary` per substance would mean one request each.
 *
 * `drug_parameters.value` is the recomputed cache of the very same source
 * values a summary pools, so the band is the same statement — but ONLY when the
 * row carries the `derivedFromEntries` marker. A value predating the entry store
 * (migration 0078's grandfathered rows) is displayed elsewhere as a legacy
 * reading with its provenance visible; banded here it would enter a table that
 * says nothing about where it came from, so it is left unbanded instead.
 *
 * A value in some other unit is refused for the same reason: silently banding
 * hours-worth of arithmetic over a number that is not hours would be worse than
 * showing nothing.
 */
export function detectionBandsFromCachedValues(
  record: Record<string, unknown> | null | undefined,
): DetectionBandReading[] {
  return DETECTION_MATRICES.map(({ key, parameter }) => {
    const value = record?.[parameter];
    if (!isAggregateCacheValue(value)) return { key, parameter, band: null };
    const range = value as NumericRange;
    if (range.unit && range.unit !== 'h') return { key, parameter, band: null };
    const hours = rangeMax(range) ?? representativeValue(range) ?? rangeMin(range);
    return { key, parameter, band: detectionBandForHours(hours) };
  });
}

export type DetectionSpanUnit = 'hours' | 'days' | 'weeks';

/**
 * A window expressed in one unit the whole span shares. Hours are what the
 * registry stores, but "168–720 h" is not how anyone reads a detection time —
 * and converting each edge independently would print "24 h–3 weeks", which
 * invites the reader to compare two scales in their head.
 */
export interface DetectionSpan {
  unit: DetectionSpanUnit;
  low: number | null;
  high: number | null;
  representative: number | null;
}

const HOURS_PER_DAY = 24;
const HOURS_PER_WEEK = 168;

/** Unit for the whole span, chosen from its longest edge. */
function spanUnitForHours(hours: number): DetectionSpanUnit {
  if (hours >= 2 * HOURS_PER_WEEK) return 'weeks';
  if (hours >= 2 * HOURS_PER_DAY) return 'days';
  return 'hours';
}

function convertHours(
  hours: number | null,
  unit: DetectionSpanUnit,
): number | null {
  if (hours == null) return null;
  if (unit === 'weeks') return hours / HOURS_PER_WEEK;
  if (unit === 'days') return hours / HOURS_PER_DAY;
  return hours;
}

/**
 * Re-express a window in a single readable unit, or null when it carries no
 * number at all. The caller formats and labels the values — this stays free of
 * i18n so it can be unit-tested as arithmetic.
 */
export function detectionSpan(window: DetectionWindow): DetectionSpan | null {
  const longest =
    window.highHours ?? window.representativeHours ?? window.lowHours ?? null;
  if (longest == null) return null;
  const unit = spanUnitForHours(longest);
  return {
    unit,
    low: convertHours(window.lowHours, unit),
    high: convertHours(window.highHours, unit),
    representative: convertHours(window.representativeHours, unit),
  };
}
