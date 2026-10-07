import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  REFERENCE_MATRIX_LABEL_KEYS,
  type ReferenceMatrix,
} from '@/lib/referenceConcentrations';
import { convertParameterDisplayValue, formatUnitSuffix } from '@/lib/parameterUnits';
import {
  isDrugParameterId,
  parameterIsAlreadyLogarithmic,
} from '@/lib/drugParameters';
import {
  BLOOD_MATRICES,
  bloodRatioScalar,
  formatSummaryValue,
  type EntrySummaryPoint,
  type ParameterSummary,
} from '@/lib/parameterEntryAggregation';
import type { NumericRange } from '@/types';

/**
 * Forest plot of a parameter's source values. One row per SOURCE entry (an
 * interval low–high with a marker at its representative), colored by biological
 * matrix, plus a pooled diamond at the weighted median spanning the IQR. Drawing
 * per-source — not a per-matrix envelope — avoids implying evidence across gaps
 * between studies. A log value axis (PK spans decades); censored thresholds are
 * drawn open-ended toward the unmeasured side. A toggle overlays all sources on
 * one band (density view). Values arrive already matrix-/unit-normalized, and
 * are re-expressed here for display only: into the reader's preferred unit
 * (`displayUnit`) and, for a matrix-dependent parameter, into the chosen matrix
 * frame via the drug's blood:plasma ratio.
 */
export interface ParameterForestPlotProps {
  summary: ParameterSummary;
  /**
   * The parameter being plotted. Used only to ask the registry whether its
   * values are already logarithms; omit it and the axis falls back to the
   * dimensionless-unit heuristic below.
   */
  parameter?: string;
  /**
   * Unit to draw the axis and labels in — the reader's preferred concentration
   * unit. Ignored when the summary's own unit cannot be converted into it (a
   * molar target with no molecular weight, a non-concentration parameter), so a
   * caller can pass it unconditionally.
   */
  displayUnit?: string | null;
  /** Drug molecular weight, for mass↔molar conversion into `displayUnit`. */
  molecularWeight?: number | null;
  /**
   * The drug's blood:plasma ratio. Enables the matrix-frame control: the pooled
   * frame is whole blood, and serum/plasma equivalents are that divided by the
   * ratio. Omit (or leave null) and the plot stays in the whole-blood frame.
   */
  bloodPlasmaRatio?: NumericRange | number | null;
  /**
   * Entry id highlighted from outside (the reader is hovering that source's row
   * in the list). Its marker is emphasized and the others are dimmed.
   */
  highlightedEntryId?: number | null;
  /** Reports the entry id under the pointer, so the list can highlight its row. */
  onHighlightEntry?: (entryId: number | null) => void;
  /**
   * The matrix frame to draw in. Pass it (with `onFrameChange`) when something
   * outside the plot must follow the same frame — the dialog does, so its pooled
   * headline cannot end up quoting a different number than the pooled diamond.
   * Left out, the plot keeps the selection to itself.
   */
  frame?: MatrixFrame;
  onFrameChange?: (frame: MatrixFrame) => void;
}

const WIDTH = 640;
const LABEL_W = 72;
const PAD_R = 16;
const ROW_H = 22;
const AXIS_H = 28;
const TOP = 8;

/**
 * How much of the axis is left empty on each side of the data. Without it the
 * extreme sources sit exactly on the frame, which reads as "the axis stops
 * because the evidence stops" rather than as two ordinary values.
 */
const PAD_FRACTION = 0.06;

/**
 * Floor on the plotted spread, as a fraction of the values' own magnitude
 * (linear axis) or as a min/max ratio (log axis).
 *
 * Fitting the axis tightly to min..max means the domain shrinks with the
 * evidence: four pKa sources at 9.9, 10, 10.1 filled the full width and read as
 * a wide disagreement, when they agree to within 1%. Below this floor the axis
 * stops zooming, so a tight cluster is DRAWN as a tight cluster.
 */
const MIN_LINEAR_SPAN_FRACTION = 0.2;
const MIN_LOG_RATIO = 1.6;

/** Matrix frames a matrix-dependent parameter can be re-expressed in. */
export const MATRIX_FRAMES = ['whole_blood', 'serum', 'plasma'] as const;
export type MatrixFrame = (typeof MATRIX_FRAMES)[number];

function matrixColor(matrix: string | null): string {
  // A null matrix is NOT the coded 'other' matrix: either the parameter has no
  // matrix dimension at all (half-life, logP, pKa) or the source didn't state
  // one. Give it its own neutral ink so it is never read as "other".
  return matrix
    ? `var(--matrix-${matrix}, var(--matrix-other))`
    : 'var(--matrix-none, var(--matrix-other))';
}

/**
 * Every plotted number, already in display units. Each source carries its own
 * factor because the matrix frame applies per point — see `frameScaleFor`.
 */
function collectValues(
  summary: ParameterSummary,
  pooledScale: number,
  scaleOf: (matrix: ReferenceMatrix | null) => number,
): number[] {
  const vals: number[] = [];
  const push = (v: number | null | undefined, scale: number) => {
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v * scale);
  };
  push(summary.iqrLow, pooledScale);
  push(summary.iqrHigh, pooledScale);
  push(summary.representative, pooledScale);
  for (const p of summary.points) {
    const scale = scaleOf(p.matrix);
    push(p.low, scale);
    push(p.high, scale);
    push(p.representative, scale);
  }
  return vals;
}

/**
 * Padded linear axis domain: at least MIN_LINEAR_SPAN_FRACTION of the data's own
 * magnitude wide, then PAD_FRACTION of breathing room on each side. A
 * non-negative data set never gets a negative axis — the lower bound clamps at
 * zero instead, which only costs the left-hand padding.
 */
export function linearAxisDomain(min: number, max: number): [number, number] {
  const center = (min + max) / 2;
  const dataSpan = max - min;
  const floor = Math.abs(center) * MIN_LINEAR_SPAN_FRACTION;
  const span = Math.max(dataSpan, floor) || Math.abs(center) || 1;
  // Grow symmetrically around the data when the floor bites, then pad.
  const grow = Math.max(0, span - dataSpan) / 2;
  const pad = span * PAD_FRACTION;
  const lo = min - grow - pad;
  return [min >= 0 && lo < 0 ? 0 : lo, max + grow + pad];
}

/** The same, in log space: a min/max ratio floor of MIN_LOG_RATIO, then padding. */
export function logAxisDomain(min: number, max: number): [number, number] {
  const lo = Math.log10(min);
  const hi = Math.log10(max);
  const center = (lo + hi) / 2;
  const span = Math.max(hi - lo, Math.log10(MIN_LOG_RATIO));
  const pad = span * PAD_FRACTION;
  return [10 ** (center - span / 2 - pad), 10 ** (center + span / 2 + pad)];
}

/**
 * Ticks for a log axis. Decades alone are too sparse once the domain covers less
 * than a couple of them (a 6.8–17 h half-life axis got a single "10"), so the
 * mantissa set thickens as the span narrows.
 */
function niceLogTicks(min: number, max: number): number[] {
  const decades = Math.log10(max / min);
  const mantissas =
    decades > 2 ? [1] : decades > 0.7 ? [1, 2, 5] : [1, 1.5, 2, 3, 5, 7];
  const ticks: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of mantissas) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) ticks.push(Number(v.toPrecision(12)));
    }
  }
  // A very narrow domain can contain no round mantissa at all; a linear tick set
  // still labels it correctly, since ticks carry no scale of their own — only
  // the positions computed from them do.
  return ticks.length > 0 ? ticks : niceLinearTicks(min, max);
}

/** Evenly spaced ticks on a 1/2/5 × 10^k step, for the linear axis. */
function niceLinearTicks(min: number, max: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const rawStep = span / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 2; v += step) {
    // Re-round: repeated addition of a fractional step accumulates float dust
    // (0.30000000000000004) that would show up in the tick labels.
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

function pointRepresentative(p: EntrySummaryPoint): number | null {
  return p.representative ?? p.high ?? p.low;
}

export function ParameterForestPlot({
  summary,
  parameter,
  displayUnit,
  molecularWeight,
  bloodPlasmaRatio,
  highlightedEntryId,
  onHighlightEntry,
  frame: frameProp,
  onFrameChange,
}: ParameterForestPlotProps) {
  const { t } = useTranslation();
  const [stacked, setStacked] = useState(false);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    label: string | null;
    detail: string;
  } | null>(null);
  // Whole blood is the frame the aggregate pools in, so it is the default view.
  // Controlled when the parent passes `frame`, self-managed otherwise.
  const [ownFrame, setOwnFrame] = useState<MatrixFrame>('whole_blood');
  const frame = frameProp ?? ownFrame;
  const setFrame = (next: MatrixFrame) => {
    setOwnFrame(next);
    onFrameChange?.(next);
  };

  // Whether matrix is a dimension of this parameter at all. The aggregate only
  // normalizes to whole blood when it is, so the flag doubles as the answer to
  // "does a null matrix here mean unstated, or not applicable?".
  const matrixDimension = summary.normalizedToWholeBlood === true;
  const ratio = bloodPlasmaRatio != null ? bloodRatioScalar(bloodPlasmaRatio) : null;
  const canReframe = matrixDimension && ratio != null;
  const activeFrame: MatrixFrame = canReframe ? frame : 'whole_blood';

  // Display-only rescaling, as ONE positive factor: unit conversion × matrix
  // frame. Both are pure linear factors, so plotting scale × value keeps every
  // ordering, ratio and log position intact. Guarded to concentration-like
  // parameters by construction: a dimensionless parameter (logP, pKa) converts
  // to nothing but itself, and only a matrix-dependent one can be reframed —
  // so an already-logarithmic axis is never silently rescaled.
  const unitFactor = useMemo(() => {
    if (!displayUnit || displayUnit === summary.unit) return 1;
    const f = convertParameterDisplayValue(
      1,
      summary.unit,
      displayUnit,
      molecularWeight ?? null,
    );
    return f != null && Number.isFinite(f) && f > 0 ? f : null;
  }, [displayUnit, summary.unit, molecularWeight]);
  const activeUnit = unitFactor == null ? summary.unit : (displayUnit ?? summary.unit);
  const unitScale = unitFactor ?? 1;
  // blood = ratio × plasma, so a serum/plasma equivalent divides back out.
  const frameFactor = activeFrame === 'whole_blood' || ratio == null ? 1 : 1 / ratio;
  /**
   * The frame factor is a BLOOD relation and applies only to blood matrices.
   * Aggregation deliberately leaves urine, vitreous, hair and 'other' entries
   * unnormalized — they have no blood:plasma relation — so scaling them by the
   * ratio would invent a "serum-equivalent urine value" that no source reports.
   * They stay at their reported magnitude in every frame, exactly as they do in
   * the whole-blood one; the caption says so.
   */
  const frameScaleFor = (matrix: ReferenceMatrix | null): number =>
    matrix != null && BLOOD_MATRICES.includes(matrix) ? frameFactor : 1;
  const scaleFor = (matrix: ReferenceMatrix | null): number =>
    unitScale * frameScaleFor(matrix);
  // The pool only ever contains blood matrices when the parameter is
  // matrix-dependent (aggregateEntries excludes the rest), so the pooled
  // marker always carries the frame factor.
  const pooledScale = unitScale * frameFactor;

  const unitSuffix = formatUnitSuffix(activeUnit);
  const titleText = activeUnit
    ? t('parameterEntries.forestPlot.title', { unit: activeUnit })
    : t('parameterEntries.forestPlot.titleNoUnit');

  const values = useMemo(
    () => collectValues(summary, pooledScale, scaleFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scaleFor is
    // rebuilt every render; its two inputs are the dependencies that matter.
    [summary, pooledScale, unitScale, frameFactor],
  );
  // A log axis suits most PK quantities — they span decades — but two cases must
  // stay linear:
  //   1. the parameter is ALREADY a logarithm (logP, logD, pKa). A log axis
  //      would transform it a second time and flatten the real spread between
  //      sources. Asked of the registry; the dimensionless unit is the fallback
  //      signal when no parameter id is supplied, since those are exactly the
  //      log-valued parameters today.
  //   2. any value is zero or negative, which a log axis cannot place at all.
  const alreadyLog =
    parameter && isDrugParameterId(parameter)
      ? parameterIsAlreadyLogarithmic(parameter)
      : summary.unit === '';
  const useLog = !alreadyLog && values.length > 0 && Math.min(...values) > 0;

  // Unmounting clears the highlight the list is mirroring, so switching views or
  // closing the plot can't strand a highlighted row. Read through a ref: an
  // inline parent callback changes identity every render, and depending on it
  // directly would clear the highlight on the very render that set it.
  const highlightCb = useRef(onHighlightEntry);
  highlightCb.current = onHighlightEntry;
  useEffect(() => () => highlightCb.current?.(null), []);

  if (values.length === 0) {
    // A log axis can't place zeros, but an all-zero summary still has data.
    const rep = summary.representative;
    if (rep != null && Number.isFinite(rep)) {
      return (
        <p className="text-xs text-muted-foreground">
          {t('parameterEntries.forestPlot.pooled')}:{' '}
          {formatSummaryValue(rep * pooledScale)}
          {unitSuffix}
        </p>
      );
    }
    return (
      <p className="text-xs text-muted-foreground">
        {t('parameterEntries.forestPlot.noData')}
      </p>
    );
  }

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const plotW = WIDTH - LABEL_W - PAD_R;
  const [domainMin, domainMax] = useLog
    ? logAxisDomain(dataMin, dataMax === dataMin ? dataMin : dataMax)
    : linearAxisDomain(dataMin, dataMax);
  const logMin = Math.log10(domainMin);
  const logMax = Math.log10(domainMax);
  /** Place a value that is already in display units (frame + unit applied). */
  const xOf = (v: number): number => {
    const frac = useLog
      ? v > 0
        ? (Math.log10(v) - logMin) / (logMax - logMin || 1)
        : 0
      : (v - domainMin) / (domainMax - domainMin || 1);
    return LABEL_W + Math.max(0, Math.min(1, frac)) * plotW;
  };

  // On a log axis a non-positive value cannot be placed (xOf would collapse it
  // onto the smallest tick), so plot only sources with a positive bound; the
  // rest are disclosed in the "not shown" note below. On a linear axis every
  // numeric source is placeable — the note then only covers sources with no
  // convertible value at all (e.g. a molar entry on a drug with no MW).
  const isPlottable = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && (!useLog || v > 0);
  const points = summary.points.filter(
    (p) =>
      isPlottable(p.low) || isPlottable(p.high) || isPlottable(p.representative),
  );
  const hasPooled = summary.representative != null;
  const rowCount = (stacked ? 1 : points.length) + (hasPooled ? 1 : 0);
  const height = TOP + rowCount * ROW_H + AXIS_H;
  const ticks = useLog
    ? niceLogTicks(domainMin, domainMax)
    : niceLinearTicks(domainMin, domainMax);
  const fmt = formatSummaryValue;
  const axisY = TOP + (stacked ? 1 : points.length) * ROW_H + (hasPooled ? ROW_H : 0);

  // Only real, stated matrices earn a legend entry; a parameter with no matrix
  // dimension (half-life, logP, pKa) has one series and needs no key at all.
  const matricesPresent = [
    ...new Set(points.map((p) => p.matrix).filter((m): m is ReferenceMatrix => !!m)),
  ];
  // When the frame is whole-blood-normalized, a serum/plasma marker sits at its
  // whole-blood equivalent, not the raw source reading. Flag it so tooltips and
  // a caption say so (the per-source list below shows the raw values).
  const hasNonBloodPoints = points.some(
    (p) => p.matrix == null || !BLOOD_MATRICES.includes(p.matrix),
  );
  const showsScaledMatrix =
    matrixDimension &&
    activeFrame === 'whole_blood' &&
    matricesPresent.some((m) => m === 'serum' || m === 'plasma');

  function matrixLabel(matrix: string | null): string | null {
    if (matrix) {
      return t(
        REFERENCE_MATRIX_LABEL_KEYS[matrix as ReferenceMatrix] ??
          'parameterEntries.forestPlot.otherMatrix',
      );
    }
    // Nothing to say for a parameter with no matrix dimension; when there IS
    // one, an entry that omitted it is "unspecified" — never "other", which is
    // a matrix a source can be coded as deliberately.
    return matrixDimension
      ? t('parameterEntries.forestPlot.unspecifiedMatrix')
      : null;
  }

  const highlight = highlightedEntryId ?? null;
  const dimmedOpacity = (entryId: number | null | undefined): number =>
    highlight != null && entryId != null && entryId !== highlight ? 0.3 : 1;
  const isHighlighted = (entryId: number | null | undefined): boolean =>
    highlight != null && entryId != null && entryId === highlight;

  return (
    <figure className="mt-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-xs font-medium text-muted-foreground">
          {titleText}
        </figcaption>
        <div className="flex items-center gap-2">
          {canReframe && (
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {t('parameterEntries.forestPlot.frameLabel')}
              <select
                value={frame}
                onChange={(e) => setFrame(e.target.value as MatrixFrame)}
                className="rounded border border-border bg-background px-1 py-0.5 text-[11px]"
              >
                {MATRIX_FRAMES.map((m) => (
                  <option key={m} value={m}>
                    {t(REFERENCE_MATRIX_LABEL_KEYS[m])}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => setStacked((s) => !s)}
            className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
          >
            {stacked
              ? t('parameterEntries.forestPlot.forestView')
              : t('parameterEntries.forestPlot.stackedView')}
          </button>
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          className="w-full"
          role="img"
          aria-label={titleText}
          style={{ maxWidth: '100%' }}
          onMouseLeave={() => {
            setHover(null);
            onHighlightEntry?.(null);
          }}
        >
          {ticks.map((tv) => (
            <g key={tv}>
              <line
                x1={xOf(tv)}
                x2={xOf(tv)}
                y1={TOP}
                y2={axisY}
                stroke="hsl(var(--border))"
                strokeWidth={1}
              />
              <text
                x={xOf(tv)}
                y={axisY + 14}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={10}
              >
                {fmt(tv)}
              </text>
            </g>
          ))}
          <text
            x={WIDTH - PAD_R}
            y={axisY + 26}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize={10}
          >
            {activeUnit}
          </text>

          {/* One row per source */}
          {points.map((p, i) => {
            const y = stacked ? TOP + ROW_H / 2 : TOP + i * ROW_H + ROW_H / 2;
            const color = matrixColor(p.matrix);
            const rep = pointRepresentative(p);
            const scale = scaleFor(p.matrix);
            const repX = rep != null ? xOf(rep * scale) : null;
            const label = matrixLabel(p.matrix);
            // A lone bound (only low or only high, no median/qualifier) is a
            // one-sided "≥ / ≤" threshold — aggregation leaves its representative
            // null. Draw it like a censored threshold (open-ended toward the
            // unmeasured side), never as an exact point circle at the bound.
            const impliedQualifier =
              !p.qualifier && p.representative == null
                ? p.low != null && p.high == null
                  ? '≥'
                  : p.high != null && p.low == null
                    ? '≤'
                    : null
                : null;
            const effectiveQualifier = p.qualifier ?? impliedQualifier;
            const valueText = effectiveQualifier
              ? `${effectiveQualifier} ${fmt(rep == null ? null : rep * scale)}`
              : p.low != null && p.high != null
                ? `${fmt(p.low * scale)}–${fmt(p.high * scale)}`
                : fmt(rep == null ? null : rep * scale);
            // A serum/plasma marker is plotted at the frame's equivalent, not
            // the raw source reading; say so in the tooltip so the value isn't
            // misread as the number that source reported.
            // Only a blood matrix is ever restated in another frame; a urine
            // or hair value is plotted exactly as reported (see frameScaleFor),
            // so it must not be labelled as an equivalent of anything.
            const reframed =
              matrixDimension &&
              p.matrix != null &&
              BLOOD_MATRICES.includes(p.matrix) &&
              p.matrix !== activeFrame;
            const frameNote = reframed
              ? ` (${t('parameterEntries.forestPlot.frameShort', {
                  matrix: t(REFERENCE_MATRIX_LABEL_KEYS[activeFrame]),
                })})`
              : '';
            const detail = label
              ? `${label} · ${valueText}${unitSuffix}${frameNote}`
              : `${valueText}${unitSuffix}${frameNote}`;
            const onEnter = (e: React.MouseEvent) => {
              setHover({ x: e.nativeEvent.offsetX, y, label, detail });
              onHighlightEntry?.(p.entryId ?? null);
            };
            const opacity = dimmedOpacity(p.entryId);
            const lit = isHighlighted(p.entryId);

            const lo = p.low != null ? xOf(p.low * scale) : repX;
            const hi = p.high != null ? xOf(p.high * scale) : repX;
            return (
              <g key={p.entryId ?? i} onMouseEnter={onEnter} opacity={opacity}>
                {/* Full-width hit band: hovering anywhere on a source's row
                    highlights it, so pairing a marker with its list row does
                    not depend on hitting a 4px circle. */}
                {!stacked && (
                  <rect
                    x={LABEL_W}
                    y={y - ROW_H / 2}
                    width={plotW}
                    height={ROW_H}
                    fill={lit ? 'hsl(var(--muted))' : 'transparent'}
                  />
                )}
                {effectiveQualifier && repX != null ? (
                  // Censored threshold or lone bound: open-ended toward the
                  // unmeasured side with a cap tick at the bound.
                  <>
                    <line
                      x1={repX}
                      x2={
                        effectiveQualifier === '<' || effectiveQualifier === '≤'
                          ? LABEL_W
                          : WIDTH - PAD_R
                      }
                      y1={y}
                      y2={y}
                      stroke={color}
                      strokeWidth={lit ? 3 : 2}
                      strokeDasharray="3 2"
                      opacity={stacked ? 0.5 : 0.9}
                    />
                    <line
                      x1={repX}
                      x2={repX}
                      y1={y - 5}
                      y2={y + 5}
                      stroke={color}
                      strokeWidth={lit ? 3 : 2}
                    />
                  </>
                ) : (
                  <>
                    {lo != null && hi != null && Math.abs(hi - lo) >= 1 && (
                      <rect
                        x={Math.min(lo, hi)}
                        y={y - (stacked ? 5 : 2.5)}
                        width={Math.max(2, Math.abs(hi - lo))}
                        height={stacked ? 10 : 5}
                        rx={2.5}
                        fill={color}
                        fillOpacity={stacked ? 0.35 : 0.8}
                        stroke={color}
                        strokeWidth={1}
                      />
                    )}
                    {repX != null && (
                      <circle
                        cx={repX}
                        cy={y}
                        r={lit ? 6 : 4}
                        fill={color}
                        stroke={lit ? 'hsl(var(--foreground))' : 'hsl(var(--card))'}
                        strokeWidth={1.5}
                      />
                    )}
                  </>
                )}
                <title>{detail}</title>
              </g>
            );
          })}

          {/* Pooled diamond (weighted median + IQR) */}
          {hasPooled &&
            (() => {
              const y =
                TOP + (stacked ? 1 : points.length) * ROW_H + ROW_H / 2;
              const rep = xOf(summary.representative! * pooledScale);
              const loX =
                summary.iqrLow != null ? xOf(summary.iqrLow * pooledScale) : rep;
              const hiX =
                summary.iqrHigh != null ? xOf(summary.iqrHigh * pooledScale) : rep;
              const left = Math.min(loX, hiX);
              const right = Math.max(loX, hiX);
              const detail = `${fmt(summary.representative! * pooledScale)}${unitSuffix} · IQR ${fmt(
                summary.iqrLow == null ? null : summary.iqrLow * pooledScale,
              )}–${fmt(
                summary.iqrHigh == null ? null : summary.iqrHigh * pooledScale,
              )} · ${summary.pooledCount}`;
              return (
                <g
                  onMouseEnter={(e) => {
                    setHover({
                      x: e.nativeEvent.offsetX,
                      y,
                      label: t('parameterEntries.forestPlot.pooled'),
                      detail,
                    });
                    onHighlightEntry?.(null);
                  }}
                >
                  <text
                    x={LABEL_W - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-foreground font-medium"
                    fontSize={11}
                  >
                    {t('parameterEntries.forestPlot.pooled')}
                  </text>
                  {/* IQR as a bar, median as a fixed-size diamond on top of it.
                      Stretching the diamond itself across the IQR collapsed it
                      into a wedge whenever the median sat at one end (a common
                      outcome of a weighted median over few sources) — which read
                      as an arrow pointing somewhere rather than as a spread. */}
                  {right - left > 2 && (
                    <rect
                      x={left}
                      y={y - 2.5}
                      width={right - left}
                      height={5}
                      rx={2.5}
                      fill="hsl(var(--primary))"
                      fillOpacity={0.35}
                    />
                  )}
                  <polygon
                    points={`${rep - 6},${y} ${rep},${y - 7} ${rep + 6},${y} ${rep},${y + 7}`}
                    fill="hsl(var(--primary))"
                    stroke="hsl(var(--primary))"
                  />
                  <title>{`${t('parameterEntries.forestPlot.pooled')}: ${detail}`}</title>
                </g>
              );
            })()}

          <line
            x1={LABEL_W}
            x2={WIDTH - PAD_R}
            y1={axisY}
            y2={axisY}
            stroke="hsl(var(--border))"
            strokeWidth={1}
          />
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow"
            style={{
              left: `${(hover.x / WIDTH) * 100}%`,
              top: `${(hover.y / height) * 100}%`,
              transform: 'translate(-50%, -120%)',
            }}
          >
            {hover.label && <div className="font-medium">{hover.label}</div>}
            <div className="text-muted-foreground">{hover.detail}</div>
          </div>
        )}
      </div>

      {/* Some sources may not be convertible to the summary frame (e.g. a molar
          entry on a drug with no molecular weight); they count toward entryCount
          but cannot be plotted. Disclose the count so the chart isn't read as a
          complete evidence set. */}
      {summary.entryCount > points.length && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('parameterEntries.forestPlot.omitted', {
            count: summary.entryCount - points.length,
          })}
        </p>
      )}

      {showsScaledMatrix && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('parameterEntries.forestPlot.wholeBloodFrame')}
        </p>
      )}

      {canReframe && activeFrame !== 'whole_blood' && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('parameterEntries.forestPlot.frameNote', {
            matrix: t(REFERENCE_MATRIX_LABEL_KEYS[activeFrame]),
            ratio: formatSummaryValue(ratio),
          })}
          {/* Urine, vitreous, hair and 'other' have no blood:plasma relation to
              convert through, so they are left at their reported magnitude —
              say so rather than let the frame's name cover them too. */}
          {hasNonBloodPoints
            ? ` ${t('parameterEntries.forestPlot.frameNoteNonBlood')}`
            : ''}
        </p>
      )}

      {/* Legend — matrices present */}
      {matricesPresent.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {matricesPresent.map((m) => (
            <li
              key={m}
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: matrixColor(m) }}
              />
              {matrixLabel(m)}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export default ParameterForestPlot;
