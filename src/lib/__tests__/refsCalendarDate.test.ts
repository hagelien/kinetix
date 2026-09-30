/**
 * The guideline's approval date, in a reader west of UTC.
 *
 * `2025-09-01` parsed by `new Date()` is midnight UTC; rendered in a local
 * zone behind UTC it becomes 31 August. The date is on screen precisely so a
 * reader can match it against the controlled document in their hand, so being
 * a day out is not cosmetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCalendarDate } from '@/components/detection/RefsDetectionSection';

const originalTz = process.env.TZ;

describe('formatCalendarDate', () => {
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('keeps the calendar date in a zone behind UTC', () => {
    // The naive reading of this value renders 31.8.2025 here.
    expect(formatCalendarDate('2025-09-01', 'nb-NO')).toBe('1.9.2025');
  });

  it('keeps it in a zone ahead of UTC too', () => {
    process.env.TZ = 'Pacific/Auckland';
    expect(formatCalendarDate('2025-09-01', 'nb-NO')).toBe('1.9.2025');
  });

  it('passes anything that is not an ISO date straight through', () => {
    expect(formatCalendarDate('', 'nb-NO')).toBe('');
    expect(formatCalendarDate('høsten 2025', 'nb-NO')).toBe('høsten 2025');
  });
});
