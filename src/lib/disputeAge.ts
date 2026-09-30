/**
 * Presentation-only aging tier for an open dispute, derived purely from
 * `createdAt` at render/build time — the `disputes` table carries no
 * aging/severity column (see #1233) and none is added by this module.
 *
 * There is no existing "time in queue" SLA concept in this repo to anchor
 * to: `docs/REVIEW_POLICY.md` has no day-scale threshold, and the only
 * comparable constant, paper-extraction's `STALE_CLAIM_MS`, measures a dead
 * agent claim in minutes, not a human moderation backlog in days — a
 * different problem at a different order of magnitude. So the bands below
 * are a defensible, explained default rather than a value pulled from
 * elsewhere in the codebase: a contested item is unremarkable for a couple
 * of days, starts reading as neglected by the end of a work week, and is
 * overdue for triage past a full week unattended.
 */
export type DisputeAgeTier = 'fresh' | 'aging' | 'overdue';

/** Below this age, a dispute is freshly opened. */
export const DISPUTE_AGING_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
/** At or above this age, a dispute is overdue for a moderator's attention. */
export const DISPUTE_OVERDUE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Classify a dispute's age. `now` defaults to the current time but is
 * accepted explicitly so callers (and tests) can pin it, since this must
 * stay a pure, framework-free function.
 */
export function disputeAgeTier(
  createdAt: string | Date,
  now: Date = new Date(),
): DisputeAgeTier {
  const created =
    createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ageMs = now.getTime() - created.getTime();
  if (ageMs >= DISPUTE_OVERDUE_THRESHOLD_MS) return 'overdue';
  if (ageMs >= DISPUTE_AGING_THRESHOLD_MS) return 'aging';
  return 'fresh';
}
