import { describe, expect, it } from 'vitest';
import {
  buildEventEmail,
  buildSummaryEmail,
  notificationTitle,
  type NotificationRowForEmail,
} from '../../api/_lib/notificationEmails';
import { emailSettingsTransition } from '../../api/preferences';

function row(over: Partial<NotificationRowForEmail>): NotificationRowForEmail {
  return {
    id: 1,
    type: 'edit_approved',
    title: 'Your edit was approved',
    bodyMd: null,
    url: '/review?id=5',
    audience: 'author',
    createdAt: new Date('2026-09-28T10:00:00Z'),
    ...over,
  };
}

describe('notificationTitle', () => {
  it('localizes known types and recovers a dispute outcome', () => {
    expect(notificationTitle(row({}), 'nb')).toBe('Endringen din ble godkjent');
    expect(
      notificationTitle(row({ type: 'dispute_resolved', title: 'Dispute upheld' }), 'en'),
    ).toBe('A dispute was upheld');
  });

  it('falls back to the stored title for an unknown type', () => {
    expect(notificationTitle(row({ type: 'something_new', title: 'Raw' }), 'nb')).toBe(
      'Raw',
    );
  });
});

describe('buildEventEmail', () => {
  it('links the event absolutely, escapes the body and links the settings', () => {
    const email = buildEventEmail(
      row({ type: 'comment_reply', bodyMd: '<b>nice</b> point', url: '/wiki/x' }),
      'https://kinetix.no/',
      'en',
    );
    expect(email.subject).toBe('New reply to your comment');
    expect(email.html).toContain('https://kinetix.no/wiki/x');
    expect(email.html).toContain('&lt;b&gt;nice&lt;/b&gt;');
    expect(email.html).not.toContain('<b>nice</b>');
    expect(email.text).toContain('https://kinetix.no/preferences');
  });
});

describe('buildSummaryEmail', () => {
  it('groups by audience and shows the open-dispute backlog to reviewers', () => {
    const email = buildSummaryEmail({
      rows: [
        row({ id: 1 }),
        row({ id: 2, type: 'dispute_opened', title: 'Dispute opened', audience: 'reviewer' }),
      ],
      frequency: 'weekly',
      appUrl: 'https://kinetix.no',
      locale: 'en',
      backlog: { open: 3, oldestDays: 9 },
    });
    expect(email.subject).toBe('Kinetix: 2 new notifications (weekly summary)');
    const feedback = email.text.indexOf('Feedback on your contributions');
    const queue = email.text.indexOf('Review queue');
    expect(feedback).toBeGreaterThanOrEqual(0);
    expect(queue).toBeGreaterThan(feedback);
    expect(email.text).toContain('3 disputes are open right now; the oldest for 9 days.');
  });

  it('writes Norwegian when the user saved their settings in Norwegian', () => {
    const email = buildSummaryEmail({
      rows: [row({})],
      frequency: 'daily',
      appUrl: 'https://kinetix.no',
      locale: 'nb',
      backlog: null,
    });
    expect(email.subject).toBe('Kinetix: 1 ny hendelse (daglig oppsummering)');
    expect(email.text).not.toContain('Vurderingskøen');
  });
});

describe('emailSettingsTransition', () => {
  it('reports audiences switched on and restarts the summary clock', () => {
    expect(
      emailSettingsTransition(null, { emailOnFeedback: true, emailFrequency: 'daily' }),
    ).toEqual({ newlyEnabledAudiences: ['author'], resetDigestClock: true });
  });

  it('restarts the clock on a frequency change while email is on', () => {
    expect(
      emailSettingsTransition(
        { emailOnFeedback: true, emailFrequency: 'daily' },
        { emailOnFeedback: true, emailFrequency: 'weekly' },
      ),
    ).toEqual({ newlyEnabledAudiences: [], resetDigestClock: true });
  });

  it('changes nothing when email stays off or is switched off', () => {
    expect(
      emailSettingsTransition({ emailOnFeedback: true }, { emailOnFeedback: false }),
    ).toEqual({ newlyEnabledAudiences: [], resetDigestClock: false });
    expect(emailSettingsTransition(null, { emailFrequency: 'weekly' })).toEqual({
      newlyEnabledAudiences: [],
      resetDigestClock: false,
    });
  });
});
