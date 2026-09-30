import { describe, expect, it, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  getClientAddressKey,
  consumeRateLimit,
  clearRateLimitState,
} from '../../../api/_lib/rate-limit.ts';

function makeReq(
  headers: Record<string, string | string[]> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

afterEach(() => {
  clearRateLimitState();
});

describe('getClientAddressKey — IP source priority', () => {
  it('uses x-real-ip when present, ignoring x-forwarded-for', () => {
    const req = makeReq({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' });
    expect(getClientAddressKey(req)).toBe('ip:1.2.3.4');
  });

  it('prefers x-real-ip over a spoofed x-forwarded-for chain', () => {
    // Simulates an attacker injecting X-Forwarded-For to bypass rate limiting
    const req = makeReq({
      'x-real-ip': '2.2.2.2',
      'x-forwarded-for': '1.1.1.1, 2.2.2.2',
    });
    expect(getClientAddressKey(req)).toBe('ip:2.2.2.2');
  });

  it('handles x-real-ip supplied as a header array', () => {
    const req = makeReq({ 'x-real-ip': ['3.3.3.3', '4.4.4.4'] });
    expect(getClientAddressKey(req)).toBe('ip:3.3.3.3');
  });

  it('ignores x-forwarded-for and falls back to socket remoteAddress', () => {
    // X-Forwarded-For is client-controlled and must not be used as a rate-limit
    // key — an attacker can rotate it to bypass per-IP limits.
    const req = makeReq({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }, '192.0.2.1');
    expect(getClientAddressKey(req)).toBe('ip:192.0.2.1');
  });

  it('falls back to socket remoteAddress when no IP headers are present', () => {
    const req = makeReq({}, '192.168.0.1');
    expect(getClientAddressKey(req)).toBe('ip:192.168.0.1');
  });

  it('trims whitespace from x-real-ip', () => {
    const req = makeReq({ 'x-real-ip': '  1.1.1.1  ' });
    expect(getClientAddressKey(req)).toBe('ip:1.1.1.1');
  });
});

describe('consumeRateLimit', () => {
  it('allows requests below the limit', () => {
    const result = consumeRateLimit('test', 'key1', 3, 60_000);
    expect(result.limited).toBe(false);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('blocks requests at the limit', () => {
    const now = Date.now();
    consumeRateLimit('test', 'key2', 2, 60_000, now);
    consumeRateLimit('test', 'key2', 2, 60_000, now + 100);
    const result = consumeRateLimit('test', 'key2', 2, 60_000, now + 200);
    expect(result.limited).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows requests again after the window expires', () => {
    const now = Date.now();
    consumeRateLimit('test', 'key3', 1, 1_000, now);
    const stillLimited = consumeRateLimit('test', 'key3', 1, 1_000, now + 500);
    expect(stillLimited.limited).toBe(true);
    const nowAllowed = consumeRateLimit('test', 'key3', 1, 1_000, now + 2_000);
    expect(nowAllowed.limited).toBe(false);
  });

  it('tracks separate buckets independently', () => {
    const now = Date.now();
    consumeRateLimit('bucket-a', 'same-key', 1, 60_000, now);
    const a = consumeRateLimit('bucket-a', 'same-key', 1, 60_000, now + 1);
    const b = consumeRateLimit('bucket-b', 'same-key', 1, 60_000, now + 1);
    expect(a.limited).toBe(true);
    expect(b.limited).toBe(false);
  });
});
