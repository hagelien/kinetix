import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";

type RateLimitState = {
  hits: number[];
  lastSeenAt: number;
};

type RateLimitResult = {
  limited: boolean;
  retryAfterSeconds: number;
};

const rateLimitStates = new Map<string, RateLimitState>();
const MAX_TRACKED_KEYS = 4096;

function hashKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

function buildStorageKey(bucket: string, key: string): string {
  return `${bucket}:${hashKey(key)}`;
}

function pruneHits(hits: number[], now: number, windowMs: number): number[] {
  const windowStart = now - windowMs;
  let firstLiveIndex = 0;

  while (firstLiveIndex < hits.length) {
    const hit = hits[firstLiveIndex];
    if (hit === undefined || hit > windowStart) {
      break;
    }

    firstLiveIndex += 1;
  }

  return firstLiveIndex === 0 ? hits : hits.slice(firstLiveIndex);
}

function pruneRateLimitStates(now: number): void {
  if (rateLimitStates.size <= MAX_TRACKED_KEYS) {
    return;
  }

  for (const [key, state] of rateLimitStates) {
    if (state.hits.length === 0 || now - state.lastSeenAt > 60 * 60 * 1000) {
      rateLimitStates.delete(key);
    }
  }
}

export function consumeRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const storageKey = buildStorageKey(bucket, key);
  const existing = rateLimitStates.get(storageKey);
  const hits = pruneHits(existing?.hits ?? [], now, windowMs);

  if (hits.length >= limit) {
    const oldestHit = hits[0];
    if (oldestHit === undefined) {
      return {
        limited: false,
        retryAfterSeconds: 0,
      };
    }

    rateLimitStates.set(storageKey, {
      hits,
      lastSeenAt: now,
    });

    return {
      limited: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldestHit + windowMs - now) / 1000),
      ),
    };
  }

  const nextHits = [...hits, now];
  rateLimitStates.set(storageKey, {
    hits: nextHits,
    lastSeenAt: now,
  });
  pruneRateLimitStates(now);

  return {
    limited: false,
    retryAfterSeconds: 0,
  };
}

export function getClientAddressKey(req: IncomingMessage): string {
  // x-real-ip is set exclusively by Vercel's edge infrastructure and cannot
  // be forged via a client-controlled X-Forwarded-For header, making it the
  // reliable key for IP-based rate limiting on this deployment.
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    const value = Array.isArray(realIp) ? realIp[0] : realIp;
    if (value?.trim()) return `ip:${value.trim()}`;
  }

  // Do NOT fall back to X-Forwarded-For: it is client-controlled and an
  // attacker can rotate the header value to bypass per-IP rate limits.
  // Use the actual TCP socket address (reliable in non-Vercel environments
  // such as local development) or a shared sentinel as a last resort.
  return `ip:${req.socket?.remoteAddress ?? "unknown"}`;
}

export function clearRateLimitState(): void {
  rateLimitStates.clear();
}
