import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hoursToClockTime } from '@/lib/timeFormat';
import { MODELING_CHART_MARGIN } from '@/lib/modelingChartLayout';
import type { TimeFormat } from '@/types/simulator';

export interface TimelineMarker {
  id: string;
  configId: string;
  eventId: string;
  t: number;
  /** Short text shown on the marker, e.g. "500 mg" or "50 mg/L". */
  label: string;
  /** Owning component colour. */
  color: string;
  kind: 'dose' | 'measurement' | 'query';
}

interface EventTimelineProps {
  markers: TimelineMarker[];
  fromHour: number;
  toHour: number;
  timeFormat: TimeFormat;
  referenceTime: string;
  activeMarkerId?: string | null;
  onMarkerSelect?: (marker: TimelineMarker) => void;
  onMarkerTimeChange?: (marker: TimelineMarker, nextHour: number) => void;
}

const STRIP_HEIGHT = 56;

/**
 * Derive the editable timeline's [from, to] window from the event marker times
 * and visible result times. The window always contains every marker so that a
 * keyboard nudge or drag (which is clamped to this range) can never push a
 * stored event time out of view, and it leaves headroom above the furthest
 * marker so the latest event isn't pinned to the right edge.
 */
export function computeTimelineRange(
  markerTimes: number[],
  resultTimes: number[],
): { from: number; to: number } {
  let min = Infinity;
  let max = -Infinity;
  let markerMax = -Infinity;
  let markerMin = Infinity;
  for (const t of markerTimes) {
    if (!Number.isFinite(t)) continue;
    min = Math.min(min, t);
    max = Math.max(max, t);
    markerMax = Math.max(markerMax, t);
    markerMin = Math.min(markerMin, t);
  }
  for (const t of resultTimes) {
    if (!Number.isFinite(t)) continue;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  // No timed points at all: use a default day-long window.
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { from: 0, to: 24 };
  }
  // Start a little before the first event rather than always at 0 — a late
  // first dose (e.g. 05:27) shouldn't leave hours of empty baseline on the
  // left. Keep a small pad so the earliest marker still has drag headroom, and
  // never start after the first curve point.
  const LEFT_PAD = 0.5;
  const earliest = Number.isFinite(markerMin) ? markerMin : min;
  const from = Math.min(min, earliest - LEFT_PAD);
  // Degenerate span (a single timed point, or all points at the same time):
  // widen to at least a day-long window that still contains the point, so a
  // nudge/drag isn't clamped into an unrelated 0–24 h range.
  if (min === max) {
    max = Math.max(max, from + 24);
  }
  // When the furthest marker defines the right edge (no result extends past
  // it), leave headroom so it isn't pinned to the edge and can be dragged or
  // nudged later in time from the timeline.
  const to = markerMax >= max ? max + Math.max(1, (max - from) * 0.1) : max;
  return { from, to };
}

/**
 * Whole-hour tick positions spanning a [from, to] window. Shared with the
 * chart's x-axis so the timeline strip and the curve above land their ticks on
 * identical times.
 */
export function computeTimelineTicks(
  fromHour: number,
  toHour: number,
): number[] {
  const ticks: number[] = [];
  const firstTick = Math.ceil(fromHour);
  const lastTick = Math.floor(toHour);
  const tickStep = Math.max(1, Math.round((lastTick - firstTick) / 12));
  for (let h = firstTick; h <= lastTick; h += tickStep) ticks.push(h);
  return ticks;
}

/**
 * Strip rendered directly under the chart. It shares the chart's [fromHour,
 * toHour] window so event positions line up with the curve's time axis.
 */
export function EventTimeline({
  markers,
  fromHour,
  toHour,
  timeFormat,
  referenceTime,
  activeMarkerId,
  onMarkerSelect,
  onMarkerTimeChange,
}: EventTimelineProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const span = toHour - fromHour || 1;

  const fmtTime = (h: number) =>
    timeFormat === 'clock'
      ? hoursToClockTime(h, referenceTime)
      : `${h.toFixed(1)} h`;
  const clampHour = (hour: number) =>
    Math.min(toHour, Math.max(fromHour, Math.round(hour * 20) / 20));
  const hourFromClientX = (clientX: number) => {
    if (!Number.isFinite(clientX)) return null;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return clampHour(fromHour + ratio * span);
  };
  const moveMarker = (marker: TimelineMarker, clientX: number) => {
    const next = hourFromClientX(clientX);
    if (next != null) onMarkerTimeChange?.(marker, next);
  };

  const ticks = computeTimelineTicks(fromHour, toHour);

  return (
    <div className="border-t border-border pt-2">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('simulator.events.timelineTitle')}
      </div>
      {/* Inset the track by the chart's plot-area margins so an event marker
          lines up horizontally with the chart's vertical event line above. */}
      <div
        style={{
          paddingLeft: MODELING_CHART_MARGIN.left,
          paddingRight: MODELING_CHART_MARGIN.right,
        }}
      >
        <div
          ref={trackRef}
          data-testid="event-timeline-track"
          className="relative w-full touch-none"
          style={{ height: STRIP_HEIGHT }}
        >
        <div className="absolute inset-x-0 bottom-5 h-px bg-border" />

        {ticks.map((h) => (
          <div
            key={`tick-${h}`}
            className="absolute bottom-0 text-[10px] text-muted-foreground"
            style={{
              left: `${((h - fromHour) / span) * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <div className="mx-auto h-1.5 w-px bg-border" />
            <span>{fmtTime(h)}</span>
          </div>
        ))}

        {markers.map((marker) => {
          const leftPct = Math.min(
            100,
            Math.max(0, ((marker.t - fromHour) / span) * 100),
          );
          const isActive =
            activeMarkerId === marker.id || draggingId === marker.id;
          const timeLabel = fmtTime(marker.t);
          return (
            <div
              key={marker.id}
              role="button"
              tabIndex={0}
              aria-label={t('simulator.events.timelineMarkerAria', {
                label: marker.label,
                time: timeLabel,
              })}
              className={`absolute bottom-5 flex cursor-ew-resize flex-col items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActive
                  ? 'ring-2 ring-ring ring-offset-2 ring-offset-card'
                  : ''
              }`}
              style={{
                left: `${leftPct}%`,
                transform: 'translateX(-50%)',
              }}
              title={`${marker.label} - ${timeLabel}`}
              onClick={() => onMarkerSelect?.(marker)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onMarkerSelect?.(marker);
                  return;
                }
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                  return;
                }
                event.preventDefault();
                const step = event.shiftKey ? 1 : 0.25;
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                onMarkerTimeChange?.(
                  marker,
                  clampHour(marker.t + direction * step),
                );
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setDraggingId(marker.id);
                onMarkerSelect?.(marker);
              }}
              onPointerMove={(event) => {
                if (draggingId === marker.id) {
                  moveMarker(marker, event.clientX);
                }
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                setDraggingId(null);
                onMarkerSelect?.(marker);
              }}
              onPointerCancel={() => setDraggingId(null)}
            >
              <span
                className="max-w-[80px] truncate rounded px-1 text-[10px] font-medium leading-tight text-white"
                style={{ backgroundColor: marker.color }}
              >
                {marker.label}
              </span>
              <span
                className="mt-0.5 h-2.5 w-0.5"
                style={{ backgroundColor: marker.color }}
              />
              <span
                className="h-1.5 w-1.5 rounded-full ring-2 ring-card"
                style={{ backgroundColor: marker.color }}
              />
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
