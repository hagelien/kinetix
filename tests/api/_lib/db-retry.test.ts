import { describe, expect, it, vi } from 'vitest';
import {
  isDatabaseUnavailableError,
  isRetryableDbError,
  withDbRetry,
} from '../../../api/_lib/db.ts';

/** Build an error shaped like the neon-http driver's NeonDbError. */
function neonError(message: string, code?: string): Error {
  const err = new Error(message);
  err.name = 'NeonDbError';
  if (code !== undefined) (err as Error & { code?: string }).code = code;
  return err;
}

describe('isRetryableDbError', () => {
  it('retries NeonDbError with no SQLSTATE (HTTP/connection-level blip)', () => {
    expect(isRetryableDbError(neonError('Error connecting to database'))).toBe(
      true,
    );
  });

  it('retries transient SQLSTATE classes', () => {
    expect(isRetryableDbError(neonError('connection failure', '08006'))).toBe(
      true,
    );
    expect(isRetryableDbError(neonError('too many connections', '53300'))).toBe(
      true,
    );
    expect(isRetryableDbError(neonError('admin shutdown', '57P01'))).toBe(true);
    expect(isRetryableDbError(neonError('serialization', '40001'))).toBe(true);
  });

  it('does not retry deterministic SQL errors', () => {
    expect(isRetryableDbError(neonError('undefined table', '42P01'))).toBe(
      false,
    );
    expect(isRetryableDbError(neonError('unique violation', '23505'))).toBe(
      false,
    );
  });

  it('ignores errors that are not NeonDbError', () => {
    expect(isRetryableDbError(new Error('boom'))).toBe(false);
    expect(isRetryableDbError('boom')).toBe(false);
    expect(isRetryableDbError(undefined)).toBe(false);
  });
});

describe('isDatabaseUnavailableError', () => {
  it('flags a Neon bad-password failure (28P01 — the production outage)', () => {
    // The exact error the neon-http driver raised when DATABASE_URL's
    // credentials stopped authenticating: 400 branch → message + code copied
    // from the PG error body.
    expect(
      isDatabaseUnavailableError(
        neonError("password authentication failed for user 'neondb_owner'", '28P01'),
      ),
    ).toBe(true);
  });

  it('flags connection, resource, and operator-intervention outages', () => {
    expect(isDatabaseUnavailableError(neonError('connection failure', '08006'))).toBe(true);
    expect(isDatabaseUnavailableError(neonError('too many connections', '53300'))).toBe(true);
    expect(isDatabaseUnavailableError(neonError('admin shutdown', '57P01'))).toBe(true);
  });

  it('flags a NeonDbError with no SQLSTATE (HTTP/driver-level failure to reach Neon)', () => {
    expect(
      isDatabaseUnavailableError(neonError('Error connecting to database: fetch failed')),
    ).toBe(true);
  });

  it('does NOT flag deterministic application SQL errors', () => {
    // These are code bugs — they must stay 500s and keep filing auto-fix issues.
    expect(isDatabaseUnavailableError(neonError('undefined table', '42P01'))).toBe(false);
    expect(isDatabaseUnavailableError(neonError('unique violation', '23505'))).toBe(false);
    expect(isDatabaseUnavailableError(neonError('invalid input syntax', '22P02'))).toBe(false);
  });

  it('ignores non-NeonDbError values', () => {
    expect(isDatabaseUnavailableError(new Error('boom'))).toBe(false);
    expect(isDatabaseUnavailableError('boom')).toBe(false);
    expect(isDatabaseUnavailableError(undefined)).toBe(false);
  });

  it('does not retry a bad-password error even though it is unavailable', () => {
    // Class 28 is unavailable but not retryable — a wrong password fails
    // identically on every attempt, so retrying only adds latency.
    const authErr = neonError('password authentication failed', '28P01');
    expect(isDatabaseUnavailableError(authErr)).toBe(true);
    expect(isRetryableDbError(authErr)).toBe(false);
  });
});

describe('withDbRetry', () => {
  it('returns the result without retrying on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withDbRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(neonError('cold start'))
      .mockResolvedValue('ok');
    await expect(withDbRetry(fn, { baseDelayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a deterministic error', async () => {
    const fn = vi.fn().mockRejectedValue(neonError('undefined table', '42P01'));
    await expect(withDbRetry(fn, { baseDelayMs: 0 })).rejects.toThrow(
      'undefined table',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(neonError('still cold'));
    await expect(
      withDbRetry(fn, { attempts: 3, baseDelayMs: 0 }),
    ).rejects.toThrow('still cold');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
