/**
 * Time format utilities for clock time (HH:MM) <-> decimal hours conversion.
 */

/** Parse a "HH:MM" string into { hour, minute } or null if invalid. */
export function parseClockTime(str: string): { hour: number; minute: number } | null {
  const match = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Convert a clock time string to decimal hours relative to a reference time string.
 *  Handles crossing midnight (e.g., ref=23:00, clock=01:00 -> 2 hours). */
export function clockToHours(clockStr: string, referenceStr: string): number | null {
  const clock = parseClockTime(clockStr);
  const ref = parseClockTime(referenceStr);
  if (!clock || !ref) return null;

  const clockMinutes = clock.hour * 60 + clock.minute;
  const refMinutes = ref.hour * 60 + ref.minute;

  let diff = clockMinutes - refMinutes;
  // If negative, assume next day (crossed midnight)
  if (diff < 0) diff += 24 * 60;

  return diff / 60;
}

/** Convert decimal hours + reference time to a clock time string "HH:MM". */
export function hoursToClockTime(hours: number, referenceStr: string): string {
  const ref = parseClockTime(referenceStr);
  if (!ref) return formatHoursAsHHMM(hours);

  const totalMinutes = ref.hour * 60 + ref.minute + Math.round(hours * 60);
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Format decimal hours as "HH:MM" elapsed time (not clock time). */
export function formatHoursAsHHMM(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '00:00';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Validate if a string is a valid HH:MM format. */
export function isValidClockTime(str: string): boolean {
  return parseClockTime(str) !== null;
}

/**
 * Best-effort coercion of compact clock-time entries to canonical "HH:MM".
 * Accepts:
 *   - "HH:MM" / "H:MM" — passthrough (zero-pads the hour for the 1-digit case)
 *   - "HHMM"           — 4 digits, e.g. "0200" → "02:00"
 *   - "HMM"            — 3 digits, e.g. "930"  → "09:30"
 *   - "H" / "HH"       — 1–2 digits read as a whole hour, e.g. "2" → "02:00"
 *   - whitespace around the value is trimmed
 * Returns the canonical "HH:MM" string when coercion produced a valid time
 * (00:00–23:59); returns the trimmed input unchanged when it cannot be
 * coerced, so the caller's existing validation surfaces the error.
 */
export function coerceClockTime(str: string): string {
  const trimmed = str.trim();
  if (trimmed === '') return trimmed;
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (colonMatch) {
    const h = parseInt(colonMatch[1]!, 10);
    const m = parseInt(colonMatch[2]!, 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    return trimmed;
  }
  if (/^\d{3,4}$/.test(trimmed)) {
    const padded = trimmed.padStart(4, '0');
    const h = parseInt(padded.slice(0, 2), 10);
    const m = parseInt(padded.slice(2), 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  // A bare 1–2 digit entry is read as a whole hour: "2" → "02:00", "23" → "23:00".
  if (/^\d{1,2}$/.test(trimmed)) {
    const h = parseInt(trimmed, 10);
    if (h >= 0 && h <= 23) {
      return `${String(h).padStart(2, '0')}:00`;
    }
  }
  return trimmed;
}
