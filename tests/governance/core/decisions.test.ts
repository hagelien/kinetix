/**
 * Phase 1 core: decision records and input fingerprinting.
 *
 * The fingerprint's only contract is "same governance inputs → same string,
 * different inputs → different string". It is not a security boundary (nothing
 * is authorised by matching one), so these tests check stability and sensitivity
 * rather than collision resistance.
 */
import { describe, expect, it } from 'vitest';
import {
  describeDecision,
  fingerprint,
  fingerprintPolicyContext,
  firstUnmet,
  independentApprovals,
  noDisputingAssessments,
  policy,
  riskProfile,
  stableStringify,
} from 'assurance-core';
import type { PolicyDecision } from 'assurance-core';
import {
  AGENT_AUTHOR,
  DEGRADED_POOL,
  makeContext,
} from '../support/policy-context.js';

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('treats an absent property and an undefined one identically', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('handles primitives and null', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(true)).toBe('true');
  });
});

describe('fingerprint', () => {
  it('is stable across key ordering', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it('is a fixed-width hex string', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ deeply: { nested: [1, 2, 3] } })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is repeatable within a process', () => {
    const value = { a: [1, { b: 'c' }] };
    expect(fingerprint(value)).toBe(fingerprint(value));
  });
});

describe('fingerprintPolicyContext', () => {
  it('is insensitive to flag ordering', () => {
    const a = makeContext({ flags: ['x', 'y'] });
    const b = makeContext({ flags: ['y', 'x'] });
    expect(fingerprintPolicyContext(a)).toBe(fingerprintPolicyContext(b));
  });

  // Codex P2: every array the policy reads by membership is a set. Reordering
  // one cannot change a decision, so it must not change the decision's input
  // fingerprint either — otherwise parity tooling reports differing inputs for
  // an identical governance decision.
  it.each([
    [
      'risk tags',
      makeContext({ risk: riskProfile('high', ['a', 'b']) }),
      makeContext({ risk: riskProfile('high', ['b', 'a']) }),
    ],
    [
      'approval capabilities',
      makeContext({ assurance: { approvalCapabilities: ['x', 'y'] } }),
      makeContext({ assurance: { approvalCapabilities: ['y', 'x'] } }),
    ],
    [
      'human approval capabilities',
      makeContext({ assurance: { humanApprovalCapabilities: ['x', 'y'] } }),
      makeContext({ assurance: { humanApprovalCapabilities: ['y', 'x'] } }),
    ],
    [
      'author capabilities',
      makeContext({
        author: { ...AGENT_AUTHOR, capabilities: ['x', 'y'], assuranceCapabilities: ['p', 'q'] },
      }),
      makeContext({
        author: { ...AGENT_AUTHOR, capabilities: ['y', 'x'], assuranceCapabilities: ['q', 'p'] },
      }),
    ],
  ])('is insensitive to the order of %s', (_field, a, b) => {
    expect(fingerprintPolicyContext(a)).toBe(fingerprintPolicyContext(b));
  });

  it('still distinguishes different set MEMBERS, not just different orders', () => {
    expect(
      fingerprintPolicyContext(makeContext({ risk: riskProfile('high', ['a', 'b']) })),
    ).not.toBe(
      fingerprintPolicyContext(makeContext({ risk: riskProfile('high', ['a', 'c']) })),
    );
  });

  it('keeps evidence requirement order significant', () => {
    // Not a set: the order shows up in evidenceRequirementsSatisfied's outcome
    // detail, so two contexts that explain themselves differently must not hash
    // to the same value.
    const first = { requirementId: 'a', satisfied: false };
    const second = { requirementId: 'b', satisfied: false };
    expect(
      fingerprintPolicyContext(
        makeContext({ assurance: { evidenceRequirementState: [first, second] } }),
      ),
    ).not.toBe(
      fingerprintPolicyContext(
        makeContext({ assurance: { evidenceRequirementState: [second, first] } }),
      ),
    );
  });

  it.each([
    ['risk', makeContext({ risk: riskProfile('high') })],
    ['pool', makeContext({ pool: DEGRADED_POOL })],
    ['assurance', makeContext({ assurance: { independentApprovers: 1 } })],
    ['targetType', makeContext({ targetType: 'wiki_fact' })],
    ['proposalVersionId', makeContext({ proposalVersionId: 'pe:2' })],
    ['flags', makeContext({ flags: ['shadow'] })],
  ])('changes when %s changes', (_field, changed) => {
    expect(fingerprintPolicyContext(changed)).not.toBe(
      fingerprintPolicyContext(makeContext()),
    );
  });
});

describe('decision helpers', () => {
  const set = policy('kinetix-test', 'v1')
    .rule({
      id: 'base',
      require: [noDisputingAssessments(), independentApprovals(2)],
    })
    .build();

  it('describes an allowed decision in one line', () => {
    const decision = set.evaluate(
      makeContext({ assurance: { independentApprovers: 2 } }),
    );
    expect(decision.allowed).toBe(true);
    expect(describeDecision(decision)).toBe('kinetix-test@v1: allowed');
    expect(firstUnmet(decision)).toBeNull();
  });

  it('lists every reason a held decision was held', () => {
    const decision = set.evaluate(
      makeContext({ assurance: { disputingAssessors: 1, independentApprovers: 0 } }),
    );
    const described = describeDecision(decision);
    expect(described).toContain('kinetix-test@v1: held');
    expect(described).toContain('assurance.noDisputingAssessments');
    expect(described).toContain('assurance.independentApprovals');
  });

  it('returns the first unmet requirement in evaluation order', () => {
    const decision = set.evaluate(
      makeContext({ assurance: { disputingAssessors: 1, independentApprovers: 0 } }),
    );
    // Host code maps this one onto its own hold reason, so the order matters.
    expect(firstUnmet(decision)?.requirementId).toBe(
      'assurance.noDisputingAssessments',
    );
  });

  it('carries the input fingerprint onto the decision', () => {
    const context = makeContext();
    const decision: PolicyDecision = set.evaluate(context);
    expect(decision.inputFingerprint).toBe(fingerprintPolicyContext(context));
  });
});
