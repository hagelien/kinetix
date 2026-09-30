import { describe, expect, it } from 'vitest';
import {
  scheduleNextReview,
  scoreToQuality,
} from '../../api/_lib/learn-scheduler.ts';

const FRESH = { reps: 0, easeX100: 250, intervalDays: 0 };
const NOW = new Date('2026-06-23T00:00:00.000Z');

describe('scoreToQuality', () => {
  it('maps scores to SM-2 quality bands', () => {
    expect(scoreToQuality(95)).toBe(5);
    expect(scoreToQuality(85)).toBe(4);
    expect(scoreToQuality(60)).toBe(3);
    expect(scoreToQuality(40)).toBe(2);
    expect(scoreToQuality(0)).toBe(0);
  });
});

describe('scheduleNextReview', () => {
  it('first pass sets interval 1 and reps 1', () => {
    const r = scheduleNextReview(FRESH, 95, NOW);
    expect(r.reps).toBe(1);
    expect(r.intervalDays).toBe(1);
    expect(r.nextReviewAt.toISOString()).toBe('2026-06-24T00:00:00.000Z');
  });

  it('second pass sets interval 6', () => {
    const first = scheduleNextReview(FRESH, 95, NOW);
    const second = scheduleNextReview(first, 95, NOW);
    expect(second.reps).toBe(2);
    expect(second.intervalDays).toBe(6);
  });

  it('third pass multiplies interval by ease', () => {
    const first = scheduleNextReview(FRESH, 95, NOW);
    const second = scheduleNextReview(first, 95, NOW);
    const third = scheduleNextReview(second, 95, NOW);
    expect(third.reps).toBe(3);
    expect(third.intervalDays).toBe(Math.round((6 * third.easeX100) / 100));
    expect(third.intervalDays).toBeGreaterThan(6);
  });

  it('a fail resets reps to 0 and interval to 1', () => {
    const first = scheduleNextReview(FRESH, 95, NOW);
    const failed = scheduleNextReview(first, 10, NOW);
    expect(failed.reps).toBe(0);
    expect(failed.intervalDays).toBe(1);
  });

  it('never drops ease below 1.30 (130)', () => {
    let state = { reps: 5, easeX100: 140, intervalDays: 30 };
    // Repeated barely-passing (quality 3) recalls push ease down by 14 each.
    for (let i = 0; i < 5; i += 1) state = scheduleNextReview(state, 60, NOW);
    expect(state.easeX100).toBeGreaterThanOrEqual(130);
  });
});
