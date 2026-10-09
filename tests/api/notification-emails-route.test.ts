import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock('../../api/_lib/notificationEmails.js', () => ({
  runNotificationEmails: runMock,
}));

import handler, { cronAuthorized, isOsloRunHour } from '../../api/notification-emails';

function call(method: string, authorization?: string) {
  const req = {
    method,
    headers: authorization ? { authorization } : {},
  } as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    writeHead: vi.fn((s: number) => {
      status = s;
      return res;
    }),
    end: vi.fn((chunk?: string) => {
      body = chunk ?? '';
    }),
  } as unknown as ServerResponse;
  return handler(req, res).then(() => ({
    status: status || (res as { statusCode: number }).statusCode,
    body: body ? JSON.parse(body) : null,
  }));
}

describe('cronAuthorized', () => {
  it('accepts exactly the bearer token for the secret', () => {
    expect(cronAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(cronAuthorized('Bearer wrong', 's3cret')).toBe(false);
    expect(cronAuthorized('s3cret', 's3cret')).toBe(false);
    expect(cronAuthorized(undefined, 's3cret')).toBe(false);
    expect(cronAuthorized(['Bearer s3cret'], 's3cret')).toBe(false);
  });
});

describe('isOsloRunHour', () => {
  it('is 05:00 in Norway: 03:00 UTC in summer, 04:00 UTC in winter', () => {
    expect(isOsloRunHour(new Date('2026-07-01T03:00:00Z'))).toBe(true);
    expect(isOsloRunHour(new Date('2026-07-01T04:00:00Z'))).toBe(false);
    expect(isOsloRunHour(new Date('2026-12-01T04:00:00Z'))).toBe(true);
    expect(isOsloRunHour(new Date('2026-12-01T03:00:00Z'))).toBe(false);
  });
});

describe('GET /api/notification-emails', () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    // 05:00 in Oslo (CEST): the run hour.
    vi.setSystemTime(new Date('2026-10-09T03:00:00Z'));
    process.env.CRON_SECRET = 's3cret';
    runMock.mockResolvedValue({
      escalated: 0,
      emailsSent: 2,
      notificationsEmailed: 3,
      failed: 0,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('fails closed with 503 while CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const r = await call('GET', 'Bearer ');
    expect(r.status).toBe(503);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('refuses a missing or wrong bearer token', async () => {
    expect((await call('GET')).status).toBe(401);
    expect((await call('GET', 'Bearer nope')).status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('refuses anything but GET', async () => {
    expect((await call('POST', 'Bearer s3cret')).status).toBe(405);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('runs delivery for the cron and reports the result', async () => {
    const r = await call('GET', 'Bearer s3cret');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ emailsSent: 2, notificationsEmailed: 3 });
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('skips the other half of the UTC pair without running delivery', async () => {
    // 06:00 in Oslo (CEST): the 04:00 UTC firing in summer.
    vi.setSystemTime(new Date('2026-10-09T04:00:00Z'));
    const r = await call('GET', 'Bearer s3cret');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ skipped: 'not_run_hour' });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('reports a run with refused emails as 502 so the cron shows it failed', async () => {
    runMock.mockResolvedValue({
      escalated: 0,
      emailsSent: 0,
      notificationsEmailed: 0,
      failed: 1,
    });
    expect((await call('GET', 'Bearer s3cret')).status).toBe(502);
  });
});
