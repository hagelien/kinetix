/**
 * Client for `GET /api/refs-detection-times`.
 *
 * One payload for the whole catalog, so it is fetched once and shared: the
 * detection-times page reads one substance out of it, the substance register
 * renders a column over every row of it, and neither should pay for a request
 * the other already made.
 *
 * Cached per identity, not globally. Kinetix is a single-page app — signing out
 * and signing in as somebody else replaces the auth store without reloading the
 * module — so a cache keyed on nothing would serve a granted member's copy of
 * a restricted guideline to whoever logged in next, without a request the
 * server could refuse. Identity is part of the key, and a change to it clears
 * what the previous identity fetched.
 */
import type {
  RefsUrineDetectionPayload,
  RefsUrineDetectionRow,
} from './refsDetectionTimes';
import {
  EMPTY_REFS_SOURCE,
  buildRefsNameIndex,
  isRefsUrineDetectionPayload,
} from './refsDetectionTimes';

/** The signed-in user's id, or null when signed out. */
export type RefsAccessIdentity = number | null;

/** What a caller with no access — or a failed request — sees. */
export const EMPTY_REFS_PAYLOAD: RefsUrineDetectionPayload = {
  source: EMPTY_REFS_SOURCE,
  preamble: '',
  rows: [],
  gated: true,
};

let cachedIdentity: RefsAccessIdentity | undefined;
let cached: RefsUrineDetectionPayload | null = null;
let inFlight: Promise<RefsUrineDetectionPayload> | null = null;

/** Drop a previous identity's copy. Exported for tests. */
export function resetRefsDetectionCache(): void {
  cachedIdentity = undefined;
  cached = null;
  inFlight = null;
}

/**
 * The guideline table for `identity`, or the empty gated payload.
 *
 * Never rejects. A network failure and a refusal are the same thing to the
 * caller — there is nothing to render either way — and the sections that read
 * this are optional additions to a page that works without them.
 */
export function fetchRefsDetectionTimes(
  identity: RefsAccessIdentity,
): Promise<RefsUrineDetectionPayload> {
  if (cachedIdentity !== identity) {
    // A request already in flight for the previous identity resolves into a
    // slot nobody looks up any more, because the guard below re-checks the
    // identity before storing.
    resetRefsDetectionCache();
    cachedIdentity = identity;
  }
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  const requestIdentity = identity;
  // The call itself goes inside the chain so that a `fetch` that throws
  // synchronously — missing entirely, or returning something that is not a
  // Response — lands in the same `catch` as a network failure. This runs from
  // an effect, where a synchronous throw would take the component down over a
  // section the page works perfectly well without.
  inFlight = Promise.resolve()
    .then(() => fetch('/api/refs-detection-times', { credentials: 'same-origin' }))
    .then(async (res) => {
      if (!res?.ok) return EMPTY_REFS_PAYLOAD;
      const data: unknown = await res.json();
      // Validated whole, not partially: everything downstream trusts the
      // shape, and a 200 that is almost the payload throws inside a render
      // rather than degrading.
      return isRefsUrineDetectionPayload(data) ? data : EMPTY_REFS_PAYLOAD;
    })
    .catch(() => EMPTY_REFS_PAYLOAD)
    .then((payload) => {
      // Signed out (or in as someone else) while the request was open: the
      // answer belongs to the identity that asked for it, and storing it now
      // would hand it to the one that did not.
      if (cachedIdentity !== requestIdentity) return payload;
      inFlight = null;
      // Only an answer the SERVER gave is worth keeping. The empty payload is
      // also what a dropped connection or malformed JSON degrades to, and
      // caching that would leave a member looking at a zero-row guideline for
      // the rest of the session with nothing to retry — the next mount asks
      // again instead. A server-sent `gated: true` is a real answer and caches
      // like any other; it is a different object than this sentinel.
      if (payload !== EMPTY_REFS_PAYLOAD) cached = payload;
      return payload;
    });

  return inFlight;
}

/**
 * Name index over a payload's rows, memoised on the row array.
 *
 * The index is rebuilt only when the rows themselves change — the payload is
 * cached and shared, so every consumer that asks gets the same index rather
 * than walking ~50 rows and their aliases per render.
 */
const indexByRows = new WeakMap<
  readonly RefsUrineDetectionRow[],
  ReturnType<typeof buildRefsNameIndex>
>();

export function refsNameIndexFor(
  rows: readonly RefsUrineDetectionRow[],
): ReturnType<typeof buildRefsNameIndex> {
  const existing = indexByRows.get(rows);
  if (existing) return existing;
  const built = buildRefsNameIndex(rows);
  indexByRows.set(rows, built);
  return built;
}
