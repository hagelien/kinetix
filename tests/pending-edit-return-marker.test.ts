/**
 * The comment-only return marker holds agent consensus until the author
 * revises (issue #1357), and never counts as a change to the proposal.
 */
import { describe, expect, it } from 'vitest';
import {
  pendingEditPayloadFingerprint,
  returnStandsUnrevised,
} from '../api/_lib/pending-edit-review-token';

describe('returnStandsUnrevised', () => {
  it('holds after a return with no revision since', () => {
    expect(returnStandsUnrevised({ returnedAt: '2026-09-23T10:00:00Z' })).toBe(true);
    expect(
      returnStandsUnrevised({
        returnedAt: '2026-09-23T10:00:00Z',
        revisedAt: '2026-09-22T10:00:00Z',
      }),
    ).toBe(true);
  });

  it('clears once the author revises after the return', () => {
    expect(
      returnStandsUnrevised({
        returnedAt: '2026-09-23T10:00:00Z',
        revisedAt: '2026-09-23T11:00:00Z',
      }),
    ).toBe(false);
  });

  it('is off without a marker, and fails closed on a malformed one', () => {
    expect(returnStandsUnrevised(null)).toBe(false);
    expect(returnStandsUnrevised({ revisedAt: '2026-09-23T11:00:00Z' })).toBe(false);
    expect(returnStandsUnrevised({ returnedAt: 'not a date' })).toBe(true);
  });

  it('is not part of the proposal fingerprint', () => {
    const base = { proposedValue: { v: 1 }, referenceId: null, referenceIds: null };
    expect(
      pendingEditPayloadFingerprint({ ...base, proposedMeta: { editSummary: 'x' } }),
    ).toBe(
      pendingEditPayloadFingerprint({
        ...base,
        proposedMeta: { editSummary: 'x', returnedAt: '2026-09-23T10:00:00Z' },
      }),
    );
  });
});
