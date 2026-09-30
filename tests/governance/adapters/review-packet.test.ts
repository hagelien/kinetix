/**
 * Phase 2: the sealed review packet (§8.1) and its anti-echo-chamber guard.
 *
 * Blind peer review is the mechanism the extraction exists to generalise, and
 * the invariant that gives it value is negative: a reviewer must not see
 * another reviewer's verdict, or the running tally, before forming their own.
 * The legacy queue holds that line by never selecting the columns. An adapter
 * layer cannot rely on that, so the packet builder enforces it at runtime —
 * these tests are what keep the enforcement honest in both directions.
 */
import { describe, expect, it } from 'vitest';
import {
  ReviewPacketLeakError,
  sealReviewPacket,
} from 'assurance-core';
import type { ProposalVersion } from '../../../api/_lib/knowledge-governance/target-adapter.js';

const VERSION: ProposalVersion = {
  ref: { proposalId: 'pending_edit:7', versionId: 'pending_edit:7@2026-01-01T00:00:00.000Z|pending' },
  target: { space: 'kinetix', type: 'pending_edit', id: '7' },
  payload: {},
  targetVersion: '2026-01-01T00:00:00.000Z|pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  authorRef: 'user:42',
};

describe('sealReviewPacket', () => {
  it('carries the version identity onto the packet', () => {
    const packet = sealReviewPacket({ version: VERSION, proposed: { a: 1 } });
    expect(packet.target).toEqual(VERSION.target);
    expect(packet.proposalVersionId).toBe(VERSION.ref.versionId);
    expect(packet.targetVersion).toBe(VERSION.targetVersion);
    expect(packet.createdAt).toBe(VERSION.createdAt);
    expect(packet.authorRef).toBe('user:42');
  });

  it('defaults every optional section rather than leaving it undefined', () => {
    const packet = sealReviewPacket({ version: VERSION, proposed: {} });
    expect(packet.current).toEqual({});
    expect(packet.evidence).toEqual([]);
    expect(packet.evidenceRequirements).toEqual([]);
    expect(packet.context).toEqual({});
  });

  it('is frozen, so a caller cannot add a field after sealing', () => {
    const packet = sealReviewPacket({ version: VERSION, proposed: {} });
    expect(Object.isFrozen(packet)).toBe(true);
  });

  it.each([
    ['a top-level verdict', { verdict: 'approve' }],
    ['an approval tally', { approvalCount: 2 }],
    ['a nested verification summary', { meta: { verificationSummary: {} } }],
    ['a peer rationale', { peer: { rationale: 'looks fine' } }],
    ['a quorum', { quorum: 2 }],
    ['a hold reason', { holdReason: 'quorum_unmet' }],
    // Codex P1: the guard matched exact names, so an obvious tally under a
    // name nobody had listed sealed cleanly. Any list of exact names loses
    // that race — the thing being guarded against is a name nobody thought of.
    ['a pluralised tally', { approvalCounts: { approve: 2 } }],
    ['a derived tally name', { peerApprovalTotals: { approve: 2 } }],
    ['a camelCase verdict list', { priorVerdictsByAgent: {} }],
    ['a dispute count under another name', { openDisputeTally: 1 }],
    ['an abstention count', { abstainTally: 3 }],
    ['a nested consensus snapshot', { deep: { consensusState: 'met' } }],
  ])('refuses to seal a packet leaking %s', (_label, proposed) => {
    expect(() =>
      sealReviewPacket({ version: VERSION, proposed: proposed as Record<string, unknown> }),
    ).toThrow(ReviewPacketLeakError);
  });

  it('names the offending path so an adapter author knows where to look', () => {
    expect(() =>
      sealReviewPacket({
        version: VERSION,
        proposed: {},
        context: { peers: [{ verdict: 'dispute' }] },
      }),
    ).toThrow(/context\.peers\[0\]\.verdict/);
  });

  it('scans inside arrays and every nested section', () => {
    for (const section of ['current', 'evidence', 'context'] as const) {
      expect(() =>
        sealReviewPacket({
          version: VERSION,
          proposed: {},
          ...(section === 'evidence'
            ? { evidence: [{ kind: 'citation', id: '1', summary: { verdict: 'x' } }] }
            : { [section]: { deep: { approvals: 3 } } }),
        }),
      ).toThrow(ReviewPacketLeakError);
    }
  });

  it('allows the paper-review payload, whose own content reads like a verdict', () => {
    // The object under review IS a review: `reviewMarkdown`, `reviewConfidence`
    // and `readInFull` are the author's submission, not a peer's judgment of
    // it. Withholding them would leave nothing to review.
    expect(() =>
      sealReviewPacket({
        version: VERSION,
        proposed: {
          reviewMarkdown: '# Funn',
          reviewConfidence: 'high',
          overallScore: 4,
          conclusionSupport: 'supported',
          readInFull: true,
        },
        context: { readInFullUnverified: false },
      }),
    ).not.toThrow();
  });

  it.each([
    ['readInFullUnverified', { readInFullUnverified: false }],
    ['conclusionSupport', { conclusionSupport: 'supported' }],
    ['overallScore', { overallScore: 72 }],
    ['factOperation', { factOperation: 'replace' }],
    ['previousContentHtml', { previousContentHtml: '<p>før</p>' }],
    ['editSummary', { editSummary: 'Oppdatert' }],
  ])('still admits the legitimate field %s', (_label, proposed) => {
    // The other half of widening to stems: blunt matching is only acceptable
    // if it does not start rejecting the packet's real content.
    expect(() =>
      sealReviewPacket({ version: VERSION, proposed: proposed as Record<string, unknown> }),
    ).not.toThrow();
  });

  it('does not loop forever on a payload that shares a nested object', () => {
    const shared = { note: 'reused' };
    expect(() =>
      sealReviewPacket({
        version: VERSION,
        proposed: { a: shared, b: shared },
      }),
    ).not.toThrow();
  });
});
