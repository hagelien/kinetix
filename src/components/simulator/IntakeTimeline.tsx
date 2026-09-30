import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EthanolIntake } from '@/lib/ethanolEngine';
import { hoursToClockTime } from '@/lib/timeFormat';

interface Props {
  intakes: EthanolIntake[];
  fromHour: number;
  toHour: number;
  referenceTime: string;
  onUpdate: (id: string, updates: Partial<EthanolIntake>) => void;
  onAdd: (timeHour: number) => void;
  onRemove: (id: string) => void;
  onFocus?: (id: string) => void;
}

const PILL_HEIGHT = 28;
const STRIP_HEIGHT = 64;
const PILL_PX_WIDTH = 64;

/**
 * Horizontal strip showing each intake as a pill that can be dragged along the
 * time axis. Uses raw pointer events (no external drag library, per spec
 * architecture). Keyboard: arrow keys nudge, Delete removes, Enter selects.
 */
export function IntakeTimeline({
  intakes,
  fromHour,
  toHour,
  referenceTime,
  onUpdate,
  onAdd,
  onRemove,
  onFocus,
}: Props) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  // Track the live drag position locally so we can commit a single update on
  // pointerup — otherwise every pointer-move would push a new undo entry and
  // a single drag gesture could exhaust the 50-step history.
  const [dragging, setDragging] = useState<
    { id: string; pointerId: number; hour: number } | null
  >(null);

  const hoursSpan = toHour - fromHour;

  const xFromHour = useCallback(
    (hour: number): number => {
      const strip = stripRef.current;
      if (!strip) return 0;
      const w = strip.clientWidth;
      return ((hour - fromHour) / hoursSpan) * w;
    },
    [fromHour, hoursSpan],
  );

  const hourFromClientX = useCallback(
    (clientX: number): number => {
      const strip = stripRef.current;
      if (!strip) return 0;
      const rect = strip.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return fromHour + ratio * hoursSpan;
    },
    [fromHour, hoursSpan],
  );

  const snap = useCallback((hour: number) => Math.round(hour * 4) / 4, []);

  const onPointerDown = (e: React.PointerEvent, id: string, currentHour: number) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging({ id, pointerId: e.pointerId, hour: currentHour });
    onFocus?.(id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const hour = snap(hourFromClientX(e.clientX));
    if (hour === dragging.hour) return;
    setDragging({ ...dragging, hour });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(dragging.pointerId);
    } catch {
      // already released — ignore
    }
    // Commit the final drag position once — a single undo entry per gesture.
    const committed = intakes.find((i) => i.id === dragging.id);
    if (committed && committed.timeHour !== dragging.hour) {
      onUpdate(dragging.id, { timeHour: dragging.hour });
    }
    setDragging(null);
  };

  const onStripClick = (e: React.MouseEvent) => {
    // Only fire on the bare strip, not on a pill.
    if (e.target !== stripRef.current) return;
    const hour = snap(hourFromClientX(e.clientX));
    onAdd(hour);
  };

  const onPillKey = (e: React.KeyboardEvent, intake: EthanolIntake) => {
    const step = e.shiftKey ? 1 : 0.25;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onUpdate(intake.id, { timeHour: intake.timeHour - step });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onUpdate(intake.id, { timeHour: intake.timeHour + step });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove(intake.id);
    }
  };

  // Tick marks every hour within the span.
  const ticks: number[] = [];
  const firstTick = Math.ceil(fromHour);
  const lastTick = Math.floor(toHour);
  for (let h = firstTick; h <= lastTick; h++) ticks.push(h);

  return (
    <div className="space-y-1">
      <div
        ref={stripRef}
        role="group"
        aria-label={t('simulator.intakeTimeline.aria')}
        className="relative w-full rounded-md border border-dashed border-input bg-background cursor-crosshair select-none"
        style={{ height: STRIP_HEIGHT }}
        onClick={onStripClick}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Axis ticks */}
        <div className="absolute inset-x-0 bottom-0 h-5 pointer-events-none">
          {ticks.map((h) => (
            <div
              key={h}
              className="absolute text-[10px] text-muted-foreground"
              style={{ left: `${((h - fromHour) / hoursSpan) * 100}%`, transform: 'translateX(-50%)' }}
            >
              <div className="mx-auto w-px h-2 bg-border" />
              <span>{hoursToClockTime(h, referenceTime)}</span>
            </div>
          ))}
        </div>

        {/* Reference line at t=0 */}
        {fromHour <= 0 && toHour >= 0 && (
          <div
            className="absolute top-0 bottom-5 border-l border-orange-300 pointer-events-none"
            style={{ left: `${((0 - fromHour) / hoursSpan) * 100}%` }}
          />
        )}

        {/* Pills */}
        {intakes.map((intake, idx) => {
          const active = dragging?.id === intake.id;
          const displayHour = active ? dragging!.hour : intake.timeHour;
          const left = xFromHour(displayHour);
          return (
            <button
              key={intake.id}
              type="button"
              role="slider"
              aria-label={t('simulator.intakeTimeline.pillAria', {
                n: idx + 1,
                time: hoursToClockTime(displayHour, referenceTime),
                grams: intake.ethanolGrams,
              })}
              aria-valuemin={fromHour}
              aria-valuemax={toHour}
              aria-valuenow={displayHour}
              aria-valuetext={`${displayHour.toFixed(2)} h`}
              data-testid={`timeline-pill-${idx}`}
              className={
                (active
                  ? 'ring-2 ring-orange-500 shadow-lg '
                  : 'ring-1 ring-border ') +
                'absolute top-1 rounded-full bg-orange-500 text-white text-[11px] tabular-nums px-2 ' +
                'cursor-grab active:cursor-grabbing touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400'
              }
              style={{
                left: `${left - PILL_PX_WIDTH / 2}px`,
                width: PILL_PX_WIDTH,
                height: PILL_HEIGHT,
                lineHeight: `${PILL_HEIGHT}px`,
              }}
              onPointerDown={(e) => onPointerDown(e, intake.id, intake.timeHour)}
              onKeyDown={(e) => onPillKey(e, intake)}
              onClick={(e) => e.stopPropagation()}
            >
              {intake.ethanolGrams} g
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t('simulator.intakeTimeline.help')}
      </div>
    </div>
  );
}
