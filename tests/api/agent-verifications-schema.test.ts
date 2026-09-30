import { describe, expect, it } from 'vitest';
import {
  AGENT_VERIFICATION_TARGET_TYPES,
  AGENT_VERIFICATION_VERDICTS,
  agentVerificationTargetTypeSchema,
  agentVerificationVerdictSchema,
  createAgentVerificationSchema,
} from '../../api/_lib/schemas';

describe('agent verification enums', () => {
  it('lists the five target types including pending_edit', () => {
    expect(new Set(AGENT_VERIFICATION_TARGET_TYPES)).toEqual(
      new Set([
        'wiki_revision',
        'drug_parameter_revision',
        'drug_discussion',
        'paper_review',
        'pending_edit',
      ]),
    );
  });

  it('rejects unknown target types and verdicts', () => {
    expect(
      agentVerificationTargetTypeSchema.safeParse('wiki_revision').success,
    ).toBe(true);
    expect(
      agentVerificationTargetTypeSchema.safeParse('drug_row').success,
    ).toBe(false);
    expect(agentVerificationVerdictSchema.safeParse('approve').success).toBe(
      true,
    );
    expect(agentVerificationVerdictSchema.safeParse('thumbs_up').success).toBe(
      false,
    );
  });

  it('exposes the verdict enum', () => {
    expect(AGENT_VERIFICATION_VERDICTS).toEqual([
      'approve',
      'dispute',
      'abstain',
    ]);
  });
});

describe('createAgentVerificationSchema', () => {
  const base = {
    targetType: 'drug_parameter_revision' as const,
    targetId: 42,
    targetVersion: '2026-06-03T01:25:47.000Z',
    verdict: 'approve' as const,
    rationaleMd: '',
  };

  it('accepts an explicit approve without rationale', () => {
    const r = createAgentVerificationSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('accepts the pending_edit version token (ISO|status)', () => {
    // Schema is intentionally permissive on shape — the exact string is
    // compared for equality against verificationTargetVersion() in the POST
    // handler. pending_edit folds row status in (ISO|<status>) so the
    // schema must not reject that envelope.
    const r = createAgentVerificationSchema.safeParse({
      ...base,
      targetType: 'pending_edit',
      targetVersion: '2026-06-03T01:25:47.000Z|pending',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty or oversized targetVersion strings', () => {
    expect(
      createAgentVerificationSchema.safeParse({ ...base, targetVersion: '' })
        .success,
    ).toBe(false);
    expect(
      createAgentVerificationSchema.safeParse({
        ...base,
        targetVersion: 'x'.repeat(81),
      }).success,
    ).toBe(false);
  });

  it('requires ≥20 chars rationale on dispute', () => {
    const short = createAgentVerificationSchema.safeParse({
      ...base,
      verdict: 'dispute',
      rationaleMd: 'too short',
    });
    expect(short.success).toBe(false);

    const ok = createAgentVerificationSchema.safeParse({
      ...base,
      verdict: 'dispute',
      rationaleMd: 'Half-life of 8h conflicts with Karch (2008) Table 3.2.',
      disputedClaim: 'Elimination half-life 8 h',
    });
    expect(ok.success).toBe(true);
  });

  it('requires a quoted disputedClaim on dispute (#1357)', () => {
    const rationaleMd = 'Half-life of 8h conflicts with Karch (2008) Table 3.2.';
    expect(
      createAgentVerificationSchema.safeParse({ ...base, verdict: 'dispute', rationaleMd })
        .success,
    ).toBe(false);
    // A bare number is not a claim.
    expect(
      createAgentVerificationSchema.safeParse({
        ...base,
        verdict: 'dispute',
        rationaleMd,
        disputedClaim: '  8.17  ',
      }).success,
    ).toBe(false);
  });

  it('rejects disputedClaim on a non-dispute verdict', () => {
    expect(
      createAgentVerificationSchema.safeParse({
        ...base,
        verdict: 'approve',
        disputedClaim: 'Elimination half-life 8 h',
      }).success,
    ).toBe(false);
  });

  it('requires ≥20 chars rationale on abstain', () => {
    const r = createAgentVerificationSchema.safeParse({
      ...base,
      verdict: 'abstain',
      rationaleMd: 'unclear',
    });
    expect(r.success).toBe(false);
  });

  it('rejects evidence refs with neither citationId nor quote nor url', () => {
    const r = createAgentVerificationSchema.safeParse({
      ...base,
      evidenceRefs: [{}],
    });
    expect(r.success).toBe(false);
  });

  it('accepts evidence refs with any one of citationId/quote/url', () => {
    expect(
      createAgentVerificationSchema.safeParse({
        ...base,
        evidenceRefs: [{ citationId: 7 }],
      }).success,
    ).toBe(true);
    expect(
      createAgentVerificationSchema.safeParse({
        ...base,
        evidenceRefs: [{ quote: 'Mean t½ 14h' }],
      }).success,
    ).toBe(true);
    expect(
      createAgentVerificationSchema.safeParse({
        ...base,
        evidenceRefs: [{ url: 'https://example.org/paper' }],
      }).success,
    ).toBe(true);
  });

  it('caps evidenceRefs at 20 entries', () => {
    const refs = Array.from({ length: 21 }, () => ({ citationId: 1 }));
    const r = createAgentVerificationSchema.safeParse({
      ...base,
      evidenceRefs: refs,
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown extra keys (strict)', () => {
    const r = createAgentVerificationSchema.safeParse({
      ...base,
      foo: 'bar',
    });
    expect(r.success).toBe(false);
  });
});
