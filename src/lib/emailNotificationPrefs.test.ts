import { describe, expect, it } from 'vitest';
import {
  digestDue,
  digestPeriodStart,
  enabledAudiences,
  resolveEmailPrefs,
} from './emailNotificationPrefs';

describe('resolveEmailPrefs', () => {
  it('turns every category off by default', () => {
    expect(resolveEmailPrefs(null)).toEqual({
      feedback: false,
      reviewer: false,
      frequency: 'daily',
      locale: 'nb',
    });
    expect(enabledAudiences(resolveEmailPrefs({}))).toEqual([]);
  });

  it('reads the legacy review toggle as feedback email unless overridden', () => {
    expect(resolveEmailPrefs({ emailWhenPendingEditReviewed: true }).feedback).toBe(true);
    expect(
      resolveEmailPrefs({ emailWhenPendingEditReviewed: true, emailOnFeedback: false })
        .feedback,
    ).toBe(false);
  });

  it('maps opt-ins to audiences and ignores unknown frequency and locale', () => {
    const prefs = resolveEmailPrefs({
      emailOnFeedback: true,
      emailAsReviewer: true,
      emailFrequency: 'hourly' as never,
      emailLocale: 'de' as never,
    });
    expect(enabledAudiences(prefs)).toEqual(['author', 'reviewer']);
    expect(prefs.frequency).toBe('daily');
    expect(prefs.locale).toBe('nb');
  });
});

describe('digestPeriodStart', () => {
  const at = (iso: string) => new Date(iso);

  it('daily: today at the 05:00 Oslo run once past it, yesterday before it (summer, 03:00 UTC)', () => {
    expect(digestPeriodStart('daily', at('2026-09-30T10:00:00Z'))).toEqual(
      at('2026-09-30T03:00:00Z'),
    );
    expect(digestPeriodStart('daily', at('2026-09-30T02:59:00Z'))).toEqual(
      at('2026-09-29T03:00:00Z'),
    );
  });

  it('daily: follows the winter run at 04:00 UTC, so 04:00-05:00 Oslo belongs to the previous period', () => {
    expect(digestPeriodStart('daily', at('2026-12-10T03:30:00Z'))).toEqual(
      at('2026-12-09T04:00:00Z'),
    );
    expect(digestPeriodStart('daily', at('2026-12-10T04:00:00Z'))).toEqual(
      at('2026-12-10T04:00:00Z'),
    );
  });

  it('daily: switches at the DST changes (2026-03-29 and 2026-10-25)', () => {
    expect(digestPeriodStart('daily', at('2026-03-29T05:00:00Z'))).toEqual(
      at('2026-03-29T03:00:00Z'),
    );
    expect(digestPeriodStart('daily', at('2026-03-28T12:00:00Z'))).toEqual(
      at('2026-03-28T04:00:00Z'),
    );
    expect(digestPeriodStart('daily', at('2026-10-25T12:00:00Z'))).toEqual(
      at('2026-10-25T04:00:00Z'),
    );
  });

  it('weekly: the most recent Monday run', () => {
    // 2026-09-28 is a Monday.
    expect(digestPeriodStart('weekly', at('2026-10-01T12:00:00Z'))).toEqual(
      at('2026-09-28T03:00:00Z'),
    );
    expect(digestPeriodStart('weekly', at('2026-09-28T02:00:00Z'))).toEqual(
      at('2026-09-21T03:00:00Z'),
    );
    // 2026-12-07 is a Monday, winter.
    expect(digestPeriodStart('weekly', at('2026-12-07T03:30:00Z'))).toEqual(
      at('2026-11-30T04:00:00Z'),
    );
  });

  it('monthly: the 1st run, across a year boundary too', () => {
    expect(digestPeriodStart('monthly', at('2026-09-15T00:00:00Z'))).toEqual(
      at('2026-09-01T03:00:00Z'),
    );
    expect(digestPeriodStart('monthly', at('2027-01-01T02:00:00Z'))).toEqual(
      at('2026-12-01T04:00:00Z'),
    );
  });
});

describe('digestDue', () => {
  const now = new Date('2026-09-30T06:10:00Z');

  it('is due once per period', () => {
    expect(digestDue('daily', new Date('2026-09-29T06:05:00Z'), now)).toBe(true);
    expect(digestDue('daily', new Date('2026-09-30T06:01:00Z'), now)).toBe(false);
  });

  it('waits for the next slot after the user opts in mid-period', () => {
    // Opted in at 10:00 yesterday: the baseline is after yesterday's slot,
    // but before today's, so this morning's summary is due.
    expect(digestDue('daily', new Date('2026-09-29T10:00:00Z'), now)).toBe(true);
    // Opted in a minute ago: nothing until tomorrow.
    expect(digestDue('daily', new Date('2026-09-30T06:09:00Z'), now)).toBe(false);
  });

  it('in winter, a change at 04:30 Oslo does not postpone the 05:00 run', () => {
    // 03:30 UTC is 04:30 Oslo; the run is at 04:00 UTC (05:00 Oslo).
    const changedAt = new Date('2026-12-10T03:30:00Z');
    expect(digestDue('daily', changedAt, new Date('2026-12-10T04:05:00Z'))).toBe(true);
  });

  it('treats a user with no baseline as due', () => {
    expect(digestDue('weekly', null, now)).toBe(true);
  });
});
