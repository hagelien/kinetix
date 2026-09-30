import { describe, expect, it } from 'vitest';
import {
  MAX_PAPER_EXTRACTION_ATTEMPTS,
  PAPER_EXTRACTION_ACTIONS,
  PAPER_EXTRACTION_STATUSES,
  STALE_CLAIM_MS,
  canApplyPaperExtractionAction,
  isClaimHolderAction,
  isOpenPaperExtractionStatus,
  isPaperExtractionAction,
  isPaperExtractionStatus,
  isStaleClaim,
  paperExtractionActionResult,
} from '@/lib/paperExtraction';

describe('paper extraction state machine', () => {
  it('only lets a run report on a job it is actually holding', () => {
    for (const action of ['complete', 'fail', 'release'] as const) {
      expect(canApplyPaperExtractionAction('claimed', action)).toBe(true);
      // A queued job has no run attached, so there is no result to report.
      expect(canApplyPaperExtractionAction('queued', action)).toBe(false);
      expect(canApplyPaperExtractionAction('completed', action)).toBe(false);
    }
  });

  it('lets an editor cancel a job that is already being extracted', () => {
    // This is the narrow kill switch for a single paper the editor decides
    // should not be processed after all — it has to work mid-run.
    expect(canApplyPaperExtractionAction('claimed', 'cancel')).toBe(true);
    expect(canApplyPaperExtractionAction('queued', 'cancel')).toBe(true);
    expect(canApplyPaperExtractionAction('completed', 'cancel')).toBe(false);
  });

  it('allows requeue only from a settled state', () => {
    expect(canApplyPaperExtractionAction('failed', 'requeue')).toBe(true);
    expect(canApplyPaperExtractionAction('cancelled', 'requeue')).toBe(true);
    expect(canApplyPaperExtractionAction('completed', 'requeue')).toBe(true);
    // Requeueing something already in the queue would be a no-op at best and
    // a claim-stealing race at worst.
    expect(canApplyPaperExtractionAction('queued', 'requeue')).toBe(false);
    expect(canApplyPaperExtractionAction('claimed', 'requeue')).toBe(false);
  });

  it('maps each action to the status it lands in', () => {
    expect(paperExtractionActionResult('complete')).toBe('completed');
    expect(paperExtractionActionResult('fail')).toBe('failed');
    expect(paperExtractionActionResult('release')).toBe('queued');
    expect(paperExtractionActionResult('cancel')).toBe('cancelled');
    expect(paperExtractionActionResult('requeue')).toBe('queued');
  });

  it('separates run outcomes from editor controls', () => {
    expect(isClaimHolderAction('complete')).toBe(true);
    expect(isClaimHolderAction('fail')).toBe(true);
    expect(isClaimHolderAction('release')).toBe(true);
    expect(isClaimHolderAction('cancel')).toBe(false);
    expect(isClaimHolderAction('requeue')).toBe(false);
  });

  it('treats queued and claimed as the open queue', () => {
    expect(isOpenPaperExtractionStatus('queued')).toBe(true);
    expect(isOpenPaperExtractionStatus('claimed')).toBe(true);
    expect(isOpenPaperExtractionStatus('completed')).toBe(false);
    expect(isOpenPaperExtractionStatus('failed')).toBe(false);
    expect(isOpenPaperExtractionStatus('cancelled')).toBe(false);
  });

  it('recognizes its own values and rejects strays', () => {
    for (const status of PAPER_EXTRACTION_STATUSES) {
      expect(isPaperExtractionStatus(status)).toBe(true);
    }
    for (const action of PAPER_EXTRACTION_ACTIONS) {
      expect(isPaperExtractionAction(action)).toBe(true);
    }
    expect(isPaperExtractionStatus('open')).toBe(false);
    expect(isPaperExtractionStatus(null)).toBe(false);
    expect(isPaperExtractionAction('delete')).toBe(false);
  });
});

describe('stale claim detection', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');

  it('honors a claim inside the window', () => {
    const fresh = new Date(now - STALE_CLAIM_MS + 60_000);
    expect(isStaleClaim(fresh, now)).toBe(false);
  });

  it('releases a claim once the window has passed', () => {
    const old = new Date(now - STALE_CLAIM_MS - 1);
    expect(isStaleClaim(old, now)).toBe(true);
  });

  it('treats a missing or unparseable timestamp as stale', () => {
    // A claim with no timestamp can never expire on its own, so the
    // conservative reading is the one that keeps the queue moving.
    expect(isStaleClaim(null, now)).toBe(true);
    expect(isStaleClaim(undefined, now)).toBe(true);
    expect(isStaleClaim('not a date', now)).toBe(true);
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(isStaleClaim(new Date(now - 1000).toISOString(), now)).toBe(false);
  });
});

describe('retry budget', () => {
  it('leaves room for transient failures without allowing a retry loop', () => {
    // Three claims = two free retries after the first attempt. Any lower and
    // a Blob hiccup parks a good paper; any higher and a paper that reliably
    // kills the agent starves everything behind it for hours.
    expect(MAX_PAPER_EXTRACTION_ATTEMPTS).toBe(3);
  });

  it('sizes the claim window between a long run and a scheduling cycle', () => {
    expect(STALE_CLAIM_MS).toBeGreaterThan(10 * 60 * 1000);
    expect(STALE_CLAIM_MS).toBeLessThan(60 * 60 * 1000);
  });
});
