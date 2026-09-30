import { describe, expect, it } from 'vitest';
import {
  DISPUTE_AGING_THRESHOLD_MS,
  DISPUTE_OVERDUE_THRESHOLD_MS,
  disputeAgeTier,
} from './disputeAge';

describe('disputeAgeTier', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('is fresh just after creation', () => {
    expect(disputeAgeTier(now.toISOString(), now)).toBe('fresh');
  });

  it('is fresh right up to the aging threshold', () => {
    const createdAt = new Date(now.getTime() - DISPUTE_AGING_THRESHOLD_MS + 1);
    expect(disputeAgeTier(createdAt, now)).toBe('fresh');
  });

  it('is aging exactly at the aging threshold', () => {
    const createdAt = new Date(now.getTime() - DISPUTE_AGING_THRESHOLD_MS);
    expect(disputeAgeTier(createdAt, now)).toBe('aging');
  });

  it('is aging right up to the overdue threshold', () => {
    const createdAt = new Date(
      now.getTime() - DISPUTE_OVERDUE_THRESHOLD_MS + 1,
    );
    expect(disputeAgeTier(createdAt, now)).toBe('aging');
  });

  it('is overdue exactly at the overdue threshold', () => {
    const createdAt = new Date(now.getTime() - DISPUTE_OVERDUE_THRESHOLD_MS);
    expect(disputeAgeTier(createdAt, now)).toBe('overdue');
  });

  it('is overdue well past a week', () => {
    const createdAt = new Date(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
    expect(disputeAgeTier(createdAt, now)).toBe('overdue');
  });

  it('accepts a string createdAt', () => {
    const createdAt = new Date(now.getTime() - 60_000).toISOString();
    expect(disputeAgeTier(createdAt, now)).toBe('fresh');
  });

  it('defaults now to the current time when omitted', () => {
    const createdAt = new Date().toISOString();
    expect(disputeAgeTier(createdAt)).toBe('fresh');
  });
});
