import { describe, expect, it } from 'vitest';
import {
  classifyAdjudicationCase,
  disputeOriginOf,
  REPEATED_CORRECTION_LOOP_MIN,
  type DetectorDispute,
  type DetectorVerdict,
} from '../../api/_lib/adjudication/detector';

let nextId = 1;
function verdict(
  verdict: string,
  tier: string | null,
  extra: Partial<DetectorVerdict> = {},
): DetectorVerdict {
  const id = nextId++;
  return {
    id,
    agentId: 100 + id,
    verdict,
    rationaleMd: `rationale ${id}`,
    evidenceRefs: [],
    verifierTier: tier,
    model: null,
    isImplicit: false,
    recordedAt: new Date('2026-10-01T00:00:00Z'),
    ...extra,
  };
}
function dispute(source: string): DetectorDispute {
  return {
    id: nextId++,
    source,
    createdBy: 9,
    reasonMd: 'reason',
    evidenceRefs: [],
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}
const none = { openDisputes: [], decidedDisputeCount: 0 };

describe('T3 detector', () => {
  it('opens nothing before blind T2 has spoken', () => {
    expect(
      classifyAdjudicationCase({
        ...none,
        verdicts: [verdict('dispute', 'mid'), verdict('approve', 'mid')],
        openDisputes: [dispute('agent')],
        decidedDisputeCount: 5,
      }),
    ).toBeNull();
  });

  it('ignores an implicit flagship approval: it is not a T2 verdict', () => {
    expect(
      classifyAdjudicationCase({
        ...none,
        verdicts: [
          verdict('dispute', 'mid'),
          verdict('approve', 'flagship', { isImplicit: true }),
        ],
      }),
    ).toBeNull();
  });

  it('fires t1_t2_disagreement on a live T1 dispute against a T2 approval, and nothing else', () => {
    const t1 = verdict('dispute', 'mid');
    const t2 = verdict('approve', 'flagship');
    const r = classifyAdjudicationCase({ ...none, verdicts: [t1, t2] });
    expect(r?.triggers).toEqual(['t1_t2_disagreement']);
    expect(r?.t2VerificationId).toBe(t2.id);
    expect(r?.t2Snapshot.map((v) => v.verificationId)).toEqual([t2.id]);
    expect(r?.t1Snapshot.verdicts.map((v) => v.verificationId)).toEqual([t1.id]);
    expect(r?.disputeOrigin).toBe('agent');
  });

  it('treats a dispute withdrawn in the control phase (stored as abstain) as not live', () => {
    expect(
      classifyAdjudicationCase({
        ...none,
        verdicts: [verdict('abstain', 'mid'), verdict('approve', 'flagship')],
      }),
    ).toBeNull();
  });

  it('does not open on a T2 dispute the lower tier approved: T2 found the problem', () => {
    expect(
      classifyAdjudicationCase({
        ...none,
        verdicts: [verdict('approve', 'mid'), verdict('dispute', 'flagship')],
      }),
    ).toBeNull();
  });

  it('fires flagship_disagreement on two flagship verdicts that disagree, and nothing else', () => {
    const r = classifyAdjudicationCase({
      ...none,
      verdicts: [verdict('approve', 'flagship'), verdict('dispute', 'flagship')],
    });
    expect(r?.triggers).toEqual(['flagship_disagreement']);
    expect(r?.t2Snapshot).toHaveLength(2);
  });

  it('fires repeated_correction_loop at the threshold with a live disagreement, as a lower bound', () => {
    const verdicts = [verdict('abstain', 'mid'), verdict('approve', 'flagship')];
    const r = classifyAdjudicationCase({
      verdicts,
      openDisputes: [dispute('agent')],
      decidedDisputeCount: REPEATED_CORRECTION_LOOP_MIN,
    });
    expect(r?.triggers).toEqual(['repeated_correction_loop']);
    expect(r?.triggerDetail.repeated_correction_loop).toEqual({
      decidedDisputes: REPEATED_CORRECTION_LOOP_MIN,
      lowerBound: true,
    });
    // Below the threshold, or settled (nothing live), it does not fire.
    expect(
      classifyAdjudicationCase({
        verdicts,
        openDisputes: [dispute('agent')],
        decidedDisputeCount: REPEATED_CORRECTION_LOOP_MIN - 1,
      }),
    ).toBeNull();
    expect(
      classifyAdjudicationCase({
        verdicts,
        openDisputes: [],
        decidedDisputeCount: REPEATED_CORRECTION_LOOP_MIN + 3,
      }),
    ).toBeNull();
  });

  it('never produces the triggers that have no persisted input yet', () => {
    const r = classifyAdjudicationCase({
      verdicts: [
        verdict('dispute', 'mid'),
        verdict('approve', 'flagship'),
        verdict('dispute', 'flagship'),
      ],
      openDisputes: [dispute('agent')],
      decidedDisputeCount: 9,
    });
    expect(r?.triggers).toEqual([
      't1_t2_disagreement',
      'flagship_disagreement',
      'repeated_correction_loop',
    ]);
    expect(r?.triggers).not.toContain('competing_scope');
    expect(r?.triggers).not.toContain('human_request');
  });

  it('records who raised the open disputes the case rests on', () => {
    expect(disputeOriginOf([])).toBe('agent');
    expect(disputeOriginOf([dispute('agent')])).toBe('agent');
    expect(disputeOriginOf([dispute('human')])).toBe('human');
    expect(disputeOriginOf([dispute('agent'), dispute('human')])).toBe('mixed');
    const r = classifyAdjudicationCase({
      verdicts: [verdict('dispute', 'mid'), verdict('approve', 'flagship')],
      openDisputes: [dispute('human')],
      decidedDisputeCount: 0,
    });
    expect(r?.disputeOrigin).toBe('human');
    expect(r?.t1Snapshot.openDisputes).toHaveLength(1);
  });
});
