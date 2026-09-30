/**
 * SM-2-lite spaced-repetition scheduler for Kinetix Learn review.
 *
 * Pure and integer-only: ease is carried ×100 (250 = 2.50) so the rollup row
 * stores plain integers. A "pass" (quality ≥ 3, derived from the attempt score)
 * advances the interval 1 → 6 → round(prevInterval × ease); a "fail" resets the
 * repetition count and interval. Ease is floored at 1.30 (130).
 */

export interface ReviewState {
  reps: number;
  easeX100: number;
  intervalDays: number;
}

export interface ScheduledReview extends ReviewState {
  nextReviewAt: Date;
}

const MIN_EASE_X100 = 130;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Map an assessment score (0–100) to an SM-2 recall quality (0–5). */
export function scoreToQuality(scorePct: number): number {
  if (scorePct >= 90) return 5;
  if (scorePct >= 80) return 4;
  if (scorePct >= 60) return 3;
  if (scorePct >= 40) return 2;
  if (scorePct >= 20) return 1;
  return 0;
}

/**
 * Compute the next review schedule from the previous state and the score just
 * achieved. `now` defaults to the current time; `nextReviewAt = now + interval`.
 */
export function scheduleNextReview(
  prev: ReviewState,
  scorePct: number,
  now: Date = new Date(),
): ScheduledReview {
  const quality = scoreToQuality(scorePct);
  const passed = quality >= 3;

  let { reps, easeX100, intervalDays } = prev;

  if (!passed) {
    reps = 0;
    intervalDays = 1;
  } else {
    // SM-2 ease update, in ×100 units, applied on successful recall.
    const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
    easeX100 = Math.max(MIN_EASE_X100, easeX100 + Math.round(delta * 100));

    reps += 1;
    if (reps === 1) intervalDays = 1;
    else if (reps === 2) intervalDays = 6;
    else intervalDays = Math.round((intervalDays * easeX100) / 100);
  }

  return {
    reps,
    easeX100,
    intervalDays,
    nextReviewAt: new Date(now.getTime() + intervalDays * DAY_MS),
  };
}
