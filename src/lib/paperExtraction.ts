/**
 * Lifecycle of a paper fact-extraction job (`paper_extraction_jobs`).
 *
 * An editor/admin uploads a full-text paper and enqueues it; a scheduled agent
 * claims one job per run, reads the stored PDF, and files the paper's atomic
 * facts as `wiki_fact` pending edits on the monographs and wiki pages they
 * belong to, and its drug parameter values as `param_entry` pending edits.
 *
 * ```
 *                    claim                 complete
 *   queued ──────────────────▶ claimed ──────────────▶ completed  (terminal)
 *      ▲                        │  │
 *      │  release / reclaim     │  │  fail
 *      └────────────────────────┘  └────────────────▶ failed
 *      ▲                                                 │
 *      └─────────────────── requeue ─────────────────────┘
 *      │
 *      └── cancel ──▶ cancelled  (terminal until requeued)
 * ```
 *
 * `claimed` is the only state that can go stale: the agent runs in a cloud
 * Routine that can die mid-cycle (timeout, crashed run, revoked token), and a
 * job stuck in `claimed` forever would silently drain the queue of exactly the
 * papers that are hardest to read. A claim older than `STALE_CLAIM_MS` is
 * therefore reclaimable by the next run — which is also why `attempts` is
 * bounded: without a cap, a paper that reliably kills the agent would be
 * re-claimed every cycle and starve every other paper behind it.
 *
 * Shared by the API layer and the React queue view so the state names, the
 * terminal set, and the retry budget stay in one place.
 */

export const PAPER_EXTRACTION_STATUSES = [
  'queued',
  'claimed',
  'completed',
  'failed',
  'cancelled',
] as const;

export type PaperExtractionStatus =
  (typeof PAPER_EXTRACTION_STATUSES)[number];

export function isPaperExtractionStatus(
  value: unknown,
): value is PaperExtractionStatus {
  return (
    typeof value === 'string' &&
    (PAPER_EXTRACTION_STATUSES as readonly string[]).includes(value)
  );
}

/** States a job can still be worked from — the "open queue". */
export const OPEN_PAPER_EXTRACTION_STATUSES: readonly PaperExtractionStatus[] =
  ['queued', 'claimed'];

export function isOpenPaperExtractionStatus(
  status: PaperExtractionStatus,
): boolean {
  return OPEN_PAPER_EXTRACTION_STATUSES.includes(status);
}

/**
 * How long a claim is honored before another run may take the job back. Sized
 * well above a normal cycle (a full-text read plus several fact submissions
 * runs minutes, not tens of minutes) so a slow-but-alive run is never robbed
 * of its job, and well under a typical hourly schedule so a dead run costs at
 * most one cycle of latency.
 */
export const STALE_CLAIM_MS = 45 * 60 * 1000;

/**
 * Claims a single job may accumulate before it is parked as `failed`. Three
 * gives a transient failure (a Blob hiccup, a timed-out fetch) two free
 * retries while stopping a genuinely unreadable paper from monopolizing the
 * queue. An editor can always `requeue` a parked job after fixing the upload.
 */
export const MAX_PAPER_EXTRACTION_ATTEMPTS = 3;

/** Actions callers may take on a job, and the states each is legal from. */
export const PAPER_EXTRACTION_ACTIONS = [
  'complete',
  'fail',
  'release',
  'cancel',
  'requeue',
] as const;

export type PaperExtractionAction =
  (typeof PAPER_EXTRACTION_ACTIONS)[number];

export function isPaperExtractionAction(
  value: unknown,
): value is PaperExtractionAction {
  return (
    typeof value === 'string' &&
    (PAPER_EXTRACTION_ACTIONS as readonly string[]).includes(value)
  );
}

const ACTION_SOURCES: Record<
  PaperExtractionAction,
  readonly PaperExtractionStatus[]
> = {
  // The three run outcomes are only legal from a live claim — an agent
  // reporting on a job it does not hold is reporting on someone else's work.
  complete: ['claimed'],
  fail: ['claimed'],
  release: ['claimed'],
  // Editor controls. Cancelling a claimed job is allowed on purpose: it is the
  // kill switch for a run that is chewing on a paper it should not have.
  cancel: ['queued', 'claimed'],
  requeue: ['completed', 'failed', 'cancelled'],
};

const ACTION_RESULT: Record<PaperExtractionAction, PaperExtractionStatus> = {
  complete: 'completed',
  fail: 'failed',
  release: 'queued',
  cancel: 'cancelled',
  requeue: 'queued',
};

/** True when `action` is legal from `from`. */
export function canApplyPaperExtractionAction(
  from: PaperExtractionStatus,
  action: PaperExtractionAction,
): boolean {
  return ACTION_SOURCES[action].includes(from);
}

/** The status `action` moves a job into. */
export function paperExtractionActionResult(
  action: PaperExtractionAction,
): PaperExtractionStatus {
  return ACTION_RESULT[action];
}

/** Actions that only the agent holding the claim may take. */
export function isClaimHolderAction(action: PaperExtractionAction): boolean {
  return action === 'complete' || action === 'fail' || action === 'release';
}

/**
 * True when a `claimed` job's claim has gone stale and may be taken over.
 * `claimedAt` of `null` on a claimed row is treated as stale — a claim with no
 * timestamp can never expire on its own, so the conservative reading is the
 * one that keeps the queue moving.
 */
export function isStaleClaim(
  claimedAt: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!claimedAt) return true;
  const at =
    claimedAt instanceof Date ? claimedAt.getTime() : Date.parse(claimedAt);
  if (Number.isNaN(at)) return true;
  return now - at >= STALE_CLAIM_MS;
}
