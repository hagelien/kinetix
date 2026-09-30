/**
 * Drug interaction tracker.
 *   POST ?drugId=   body: { eventType: 'view' | 'wiki_open' | 'simulator_open' | 'edit' }
 *
 * Anonymous events are rate-limited per ipHash (1 minute window).
 * Authenticated events are rate-limited per userId (same window) to prevent
 * unbounded drugInteractions inserts and popularityScore manipulation.
 */
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';
import { parseAndValidate } from './_lib/validate.js';
import { trackInteractionSchema } from './_lib/schemas.js';
import { drugs, drugInteractions } from '../db/schema.js';

// In-memory rate limiter (per serverless instance; good enough to stop
// accidental spamming from a single client).
const RATE_LIMIT_WINDOW_MS = 60_000;
const recentTracks = new Map<string, number>();

function hashIp(req: IncomingMessage): string {
  // Derive the hash from getClientAddressKey() so analytics uses the same
  // trusted IP source as rate-limit.ts (x-real-ip only; X-Forwarded-For is
  // client-controlled and must not be used — see rate-limit.ts for rationale).
  return createHash('sha256')
    .update(getClientAddressKey(req))
    .digest('hex')
    .slice(0, 32);
}

function shouldRateLimit(key: string): boolean {
  const now = Date.now();
  // Opportunistically purge expired entries
  if (recentTracks.size > 1024) {
    for (const [k, t] of recentTracks) {
      if (now - t > RATE_LIMIT_WINDOW_MS) recentTracks.delete(k);
    }
  }
  const last = recentTracks.get(key);
  if (last && now - last < RATE_LIMIT_WINDOW_MS) return true;
  recentTracks.set(key, now);
  return false;
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    if (req.method !== 'POST') {
      error(res, 405, 'Method not allowed');
      return;
    }

    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const drugId = Number(url.searchParams.get('drugId'));
    if (!Number.isInteger(drugId) || drugId <= 0) {
      error(res, 400, 'Missing or invalid drugId');
      return;
    }

    const parsed = await parseAndValidate(req, trackInteractionSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }

    const { eventType } = parsed.data;
    const auth = await getUserFromRequest(req);
    const ipHash = hashIp(req);

    if (eventType === 'edit' && !auth) {
      error(res, 401, 'Authentication required for edit events');
      return;
    }

    if (auth) {
      // Rate-limit authenticated users per (drugId, userId) to prevent
      // unbounded popularityScore inflation and drugInteractions table growth.
      const rl = consumeRateLimit(
        'drug-track-user',
        `${drugId}:${auth.userId}`,
        1,
        RATE_LIMIT_WINDOW_MS,
      );
      if (rl.limited) {
        json(res, 200, { tracked: false, reason: 'rate-limited' });
        return;
      }
    } else {
      const key = `${drugId}:${ipHash}`;
      if (shouldRateLimit(key)) {
        json(res, 200, { tracked: false, reason: 'rate-limited' });
        return;
      }
    }

    const db = getDb();

    // batch() sends both statements in a single Neon HTTP request instead of
    // two concurrent requests, halving connection overhead on this hot path.
    await db.batch([
      db.insert(drugInteractions).values({
        drugId,
        userId: auth?.userId ?? null,
        eventType,
        ipHash,
      }),
      db
        .update(drugs)
        .set({ popularityScore: sql`${drugs.popularityScore} + 1` })
        .where(eq(drugs.id, drugId)),
    ]);

    res.statusCode = 204;
    res.end();
  },
);
