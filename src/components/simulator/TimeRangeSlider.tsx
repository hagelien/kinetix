import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { hoursToClockTime, parseClockTime } from '@/lib/timeFormat';
import type { TimeFormat } from '@/types/simulator';

interface TimeRangeSliderProps {
  /** Earlier (lower) value in hours, undefined when not yet set. */
  startHours: number | undefined;
  /** Later (higher) value in hours, undefined when not yet set. */
  endHours: number | undefined;
  onChange: (start: number | undefined, end: number | undefined) => void;
  timeFormat: TimeFormat;
  referenceTime: string;
}

const STEP_HOURS = 0.25;
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 24;
/**
 * Clock-mode bound: any value < 24 round-trips correctly through
 * `clockToHours` (it adds a full day when the diff goes negative), so
 * 23.75 h is the largest value the slider can commit without colliding
 * with the wraparound bug at exactly 24 h (`hoursToClockTime(24, "00:00")
 * === "00:00"` collapses to 0 h on the next TimeField edit) (#315 review).
 *
 * We intentionally don't tie this to the reference time. A previous
 * attempt capped at `24 - refHours - STEP` to avoid the same-day-wrap
 * display, but that broke common overnight scenarios — and the wrap
 * is only a *display* concern; the underlying value is correct, and the
 * slider's range header carries a "+Nd" marker. The TimeField input is
 * the only surface that doesn't show the day offset, but it can still
 * round-trip correctly because clockToHours adds the day back.
 */
const CLOCK_MODE_MAX = DEFAULT_MAX - STEP_HOURS;
/** Headroom (hours) added beyond a manually-entered out-of-window endpoint
 *  so the slider thumb is never pinned to the track edge (#315 review). */
const OUT_OF_WINDOW_HEADROOM = 6;

/**
 * Dual-thumb slider for the simulator's start/end time inputs (#307).
 * Two stacked native range inputs avoid pulling in a slider dependency.
 *
 * Pointer-events handoff (#315 review): the input elements themselves
 * carry `pointer-events: none` so the second input doesn't shadow the
 * first across the track and steal every click. The thumb pseudo-
 * elements re-enable pointer events, so each thumb is independently
 * draggable. Keyboard arrow keys still work because focus and key
 * handling don't depend on pointer-events.
 *
 * The displayed range starts at 0–24 h and grows when either input
 * sits outside that window — handy for multi-day intake scenarios.
 */
export function TimeRangeSlider({
  startHours,
  endHours,
  onChange,
  timeFormat,
  referenceTime,
}: TimeRangeSliderProps) {
  const { t } = useTranslation();
  // In clock mode the slider stops just before 24 h (CLOCK_MODE_MAX =
  // 23.75) so dragging can never commit exactly 24 h, the one value
  // that round-trips incorrectly through hoursToClockTime/clockToHours
  // ("00:00" reference: 24 h → "00:00" → 0 h). Decimal-hours mode keeps
  // the full 0–24 default. Manually-entered endpoints past the bound
  // still get headroom (below).
  const defaultBound = timeFormat === 'clock' ? CLOCK_MODE_MAX : DEFAULT_MAX;
  const start = startHours ?? DEFAULT_MIN;
  const end = endHours ?? defaultBound;
  // Add headroom whenever a manually-entered endpoint sits outside the
  // default window so the thumb has somewhere to drag to. Without this,
  // entering `endHours = 30` would produce `max = 30` and pin the end
  // thumb against the right edge (#315 review).
  const lowest = Math.min(start, end);
  const highest = Math.max(start, end);
  const min = lowest < DEFAULT_MIN ? lowest - OUT_OF_WINDOW_HEADROOM : DEFAULT_MIN;
  const max = highest > defaultBound ? highest + OUT_OF_WINDOW_HEADROOM : defaultBound;
  const className = `time-range-slider-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  function format(hours: number): string {
    if (timeFormat !== 'clock') return `${hours.toFixed(2)} h`;
    const clock = hoursToClockTime(hours, referenceTime);
    // hoursToClockTime wraps modulo 24, so a 23.75 h end with a 09:00
    // reference renders as "08:45" — earlier than the start label and
    // visually misleading even though the underlying value round-trips
    // correctly through clockToHours. Append "+1d" / "+Nd" for any
    // endpoint that crosses midnight relative to the reference so the
    // slider header stays unambiguous (#315 review).
    const ref = parseClockTime(referenceTime);
    if (!ref) return clock;
    const totalMinutes = ref.hour * 60 + ref.minute + Math.round(hours * 60);
    const dayOffset = Math.floor(totalMinutes / (24 * 60));
    return dayOffset > 0 ? `${clock} +${dayOffset}d` : clock;
  }

  // When the opposite endpoint hasn't been entered yet, the slider renders
  // the default (0/24 h) for it. Commit that default through onChange the
  // moment the user actually uses the slider so the form doesn't end up
  // half-filled while visibly displaying both endpoints (#315 review).
  function handleStart(next: number) {
    onChange(Math.min(next, end), end);
  }

  function handleEnd(next: number) {
    onChange(start, Math.max(next, start));
  }

  const span = max - min;
  const startPct = span > 0 ? ((start - min) / span) * 100 : 0;
  const endPct = span > 0 ? ((end - min) / span) * 100 : 100;

  return (
    <div className="col-span-2 flex flex-col gap-1 pt-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('simulator.timeSlider.label')}</span>
        <span className="tabular-nums">
          {format(start)} – {format(end)}
        </span>
      </div>
      <style>{`
        .${className} { position: relative; height: 1.5rem; }
        .${className} .time-range-track {
          position: absolute; left: 0; right: 0; top: 50%;
          height: 4px; transform: translateY(-50%);
          border-radius: 9999px; background: hsl(var(--muted));
        }
        .${className} .time-range-fill {
          position: absolute; top: 50%; height: 4px;
          transform: translateY(-50%);
          border-radius: 9999px; background: hsl(var(--primary));
        }
        .${className} input[type="range"] {
          position: absolute; inset: 0; width: 100%;
          appearance: none; -webkit-appearance: none;
          background: transparent; pointer-events: none;
          margin: 0;
        }
        .${className} input[type="range"]:focus { outline: none; }
        .${className} input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          pointer-events: auto;
          height: 16px; width: 16px; border-radius: 9999px;
          background: hsl(var(--primary));
          border: 2px solid hsl(var(--background));
          cursor: pointer;
        }
        .${className} input[type="range"]::-moz-range-thumb {
          pointer-events: auto;
          height: 16px; width: 16px; border-radius: 9999px;
          background: hsl(var(--primary));
          border: 2px solid hsl(var(--background));
          cursor: pointer;
        }
        .${className} input[type="range"]:focus-visible::-webkit-slider-thumb {
          box-shadow: 0 0 0 3px hsl(var(--ring) / 0.4);
        }
        .${className} input[type="range"]:focus-visible::-moz-range-thumb {
          box-shadow: 0 0 0 3px hsl(var(--ring) / 0.4);
        }
      `}</style>
      <div className={className}>
        <div className="time-range-track" />
        <div
          className="time-range-fill"
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={STEP_HOURS}
          value={start}
          onChange={(e) => handleStart(Number(e.target.value))}
          aria-label={t('simulator.timeSlider.ariaStart') as string}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={STEP_HOURS}
          value={end}
          onChange={(e) => handleEnd(Number(e.target.value))}
          aria-label={t('simulator.timeSlider.ariaEnd') as string}
        />
      </div>
    </div>
  );
}
