/**
 * §16.3 — the eight property invariants, as generated properties.
 *
 * The parity matrices next door prove agreement on the cases somebody thought
 * to write down. These prove statements that must hold across the whole input
 * space, which is a different claim and catches a different bug: a matrix
 * cannot tell you that *no* combination of agent approvals publishes an
 * unattributed proposal, only that the four you enumerated did not.
 *
 * Everything here is pure. No database, no harness — the policy engine is
 * synchronous by construction (§7.1), which is exactly what makes generated
 * testing cheap enough to run a thousand cases per invariant.
 *
 * Two invariants in the plan's list are only half-provable here and say so
 * where they appear: "changing proposal payload must invalidate all old-version
 * publication eligibility" rests on a fingerprint property below plus the
 * version-binding end-to-end scenario in `../e2e/scenarios.test.ts`, and
 * "adding an approval must never reduce assurance" holds for a *new* approver
 * and deliberately does not hold for a reviewer revising its own verdict.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSURANCE_PROFILE,
  modelTierCapability,
  reviewerPoolState,
  riskProfile,
  tallyAssurance,
} from 'assurance-core';
import type {
  Assessment,
  AssuranceProfile,
  PolicyContext,
} from 'assurance-core';
import {
  KINETIX_APPLY_POLICY,
  KINETIX_CLINICAL_CASE_TAG,
  KINETIX_CLINICAL_EXPERT_CAPABILITY,
  KINETIX_DESIGN_TARGET_QUORUM,
  KINETIX_FLAGSHIP_CAPABILITY,
  KINETIX_POLICY,
} from '../../../src/lib/assurance/policy.js';
import { payloadFingerprint } from '../../../api/_lib/knowledge-governance/adapters/kinetix/support.js';
import { AGENT_AUTHOR, HUMAN_AUTHOR, makeContext } from '../support/policy-context.js';

/** Enough cases to be worth calling a property; small enough to stay fast. */
const RUNS = { numRuns: 500 } as const;

const MID_TIER_CAPABILITY = modelTierCapability('mid');

const CAPABILITY_POOL = [
  KINETIX_FLAGSHIP_CAPABILITY,
  MID_TIER_CAPABILITY,
  KINETIX_CLINICAL_EXPERT_CAPABILITY,
] as const;

const arbCapabilities = fc.subarray([...CAPABILITY_POOL]);

const arbAssessment = (
  refs: readonly string[],
): fc.Arbitrary<Assessment> =>
  fc.record({
    assessorRef: fc.constantFrom(...refs),
    assessorKind: fc.constantFrom<'human' | 'agent'>('human', 'agent'),
    verdict: fc.constantFrom<'approve' | 'dispute' | 'abstain'>(
      'approve',
      'dispute',
      'abstain',
    ),
    implicit: fc.boolean(),
    assuranceCapabilities: arbCapabilities,
  });

const REVIEWER_REFS = ['user:11', 'user:12', 'user:13', 'user:14'] as const;

const arbAssessments = fc.array(arbAssessment(REVIEWER_REFS), { maxLength: 8 });

const arbPool = fc
  .record({
    poolSize: fc.integer({ min: 1, max: 5 }),
    authorIsEligibleVerifier: fc.boolean(),
  })
  .map((args) =>
    reviewerPoolState({ ...args, designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM }),
  );

const arbRiskTags = fc.subarray([KINETIX_CLINICAL_CASE_TAG, 'calculation_driving']);

/**
 * A whole context, with the assurance profile *tallied from generated
 * assessments* rather than invented field by field.
 *
 * That distinction matters: independent field generation produces states no
 * tally can ever produce — six human approvals out of two explicit approvals —
 * and an invariant that only holds on impossible inputs proves nothing about
 * production. Every context here is one some sequence of reviewers could
 * actually have created.
 */
const arbContext: fc.Arbitrary<PolicyContext> = fc
  .record({
    assessments: arbAssessments,
    authorIsHuman: fc.boolean(),
    riskLevel: fc.constantFrom<'low' | 'medium' | 'high'>('low', 'medium', 'high'),
    riskTags: arbRiskTags,
    pool: arbPool,
    disputesOpen: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ assessments, authorIsHuman, riskLevel, riskTags, pool, disputesOpen }) =>
    makeContext({
      author: authorIsHuman ? HUMAN_AUTHOR : AGENT_AUTHOR,
      risk: riskProfile(riskLevel, riskTags),
      assurance: { ...tallyAssurance(assessments), disputesOpen },
      pool,
    }),
  );

function allowedBy(policy: typeof KINETIX_POLICY, context: PolicyContext): boolean {
  return policy.evaluate(context).allowed;
}

/** Strip every assurance capability, leaving the counts intact. */
function withUnknownCapabilities(context: PolicyContext): PolicyContext {
  return {
    ...context,
    assurance: {
      ...context.assurance,
      approvalCapabilities: [],
      humanApprovalCapabilities: [],
    },
  };
}

function withoutCapability(
  context: PolicyContext,
  capability: string,
): PolicyContext {
  return {
    ...context,
    assurance: {
      ...context.assurance,
      approvalCapabilities: context.assurance.approvalCapabilities.filter(
        (c) => c !== capability,
      ),
      humanApprovalCapabilities: context.assurance.humanApprovalCapabilities.filter(
        (c) => c !== capability,
      ),
    },
  };
}

describe('the generated space itself', () => {
  it('reaches both outcomes, so every implication below has real antecedents', () => {
    // Three of the invariants are stated as implications ("allowed after
    // implies allowed before"). An implication over a space where nothing is
    // ever allowed is true and proves nothing, which is the same
    // absence-reads-as-a-pass failure the parity report had. So: sample the
    // space once and assert it contains both.
    const samples = fc.sample(arbContext, 400);
    const allowed = samples.filter((c) => allowedBy(KINETIX_APPLY_POLICY, c));
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.length).toBeLessThan(samples.length);
  });

  it('reaches high-risk contexts that a flagship approval actually unblocks', () => {
    // Same check for invariant 3 specifically: removing the flagship
    // capability must have something to remove somewhere in the space.
    //
    // Sampled far wider than the sibling above, because forcing every context
    // to high risk makes the allowed ones RARE rather than merely a minority:
    // measured over 120 000 draws, 1.02 % of high-risk contexts are allowed, so
    // a 400-draw sample came up empty — and failed this assertion — on ~1.7 %
    // of runs, which is how it failed CI on an unrelated PR. The rate is a
    // property of the space (high risk needs the flagship capability AND the
    // quorum AND no open dispute), not a bug, so the fix is enough draws for
    // "reaches" to mean it: at 20 000 an empty sample is a 1-in-10^88 event.
    const samples = fc.sample(arbContext, 20_000).map((c) => ({
      ...c,
      risk: riskProfile('high', c.risk.tags),
    }));
    expect(
      samples.filter((c) => allowedBy(KINETIX_APPLY_POLICY, c)).length,
    ).toBeGreaterThan(0);
  });
});

describe('1. adding an approval never reduces assurance', () => {
  const COUNTS: readonly (keyof AssuranceProfile)[] = [
    'explicitApprovals',
    'independentApprovers',
    'humanApprovals',
    'agentApprovals',
  ];

  it('holds for every count when a NEW assessor approves', () => {
    fc.assert(
      fc.property(
        arbAssessments,
        fc.constantFrom<'human' | 'agent'>('human', 'agent'),
        arbCapabilities,
        (base, kind, capabilities) => {
          // A ref no generated assessment can carry, so this is an addition
          // rather than a revision. See the next test for why that matters.
          const approval: Assessment = {
            assessorRef: 'user:99',
            assessorKind: kind,
            verdict: 'approve',
            implicit: false,
            assuranceCapabilities: capabilities,
          };
          const before = tallyAssurance(base);
          const after = tallyAssurance([...base, approval]);
          for (const count of COUNTS) {
            expect(after[count] as number).toBeGreaterThanOrEqual(
              before[count] as number,
            );
          }
          // Capabilities are a set union, so they can only grow.
          for (const capability of before.approvalCapabilities) {
            expect(after.approvalCapabilities).toContain(capability);
          }
          // And nothing an approval could do raises the dispute count.
          expect(after.disputingAssessors).toBe(before.disputingAssessors);
        },
      ),
      RUNS,
    );
  });

  it('never turns a held proposal into a published one it should not', () => {
    // The invariant restated where it actually bites: an added approval may
    // flip hold→allow (that is the point of approvals), but it must never flip
    // allow→hold, which would mean approvals were being netted against
    // something.
    fc.assert(
      fc.property(arbContext, (context) => {
        const stronger: PolicyContext = {
          ...context,
          assurance: {
            ...context.assurance,
            explicitApprovals: context.assurance.explicitApprovals + 1,
            independentApprovers: context.assurance.independentApprovers + 1,
            humanApprovals: context.assurance.humanApprovals + 1,
            humanApprovalCapabilities: [
              ...new Set([
                ...context.assurance.humanApprovalCapabilities,
                ...context.assurance.approvalCapabilities,
              ]),
            ].sort(),
          },
        };
        if (allowedBy(KINETIX_APPLY_POLICY, context)) {
          expect(allowedBy(KINETIX_APPLY_POLICY, stronger)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('does NOT hold for a reviewer revising its own verdict, deliberately', () => {
    // Worth pinning rather than leaving as an unstated exception: supersession
    // is not addition. A flagship reviewer that revises its approval down to an
    // abstention removes the capability it was carrying, and a high-risk gate
    // that kept honouring the old one would be honouring a withdrawn opinion.
    const first: Assessment = {
      assessorRef: 'user:11',
      assessorKind: 'agent',
      verdict: 'approve',
      implicit: false,
      assuranceCapabilities: [KINETIX_FLAGSHIP_CAPABILITY],
    };
    const revision: Assessment = { ...first, verdict: 'abstain' };
    expect(tallyAssurance([first]).approvalCapabilities).toEqual([
      KINETIX_FLAGSHIP_CAPABILITY,
    ]);
    expect(tallyAssurance([first, revision]).approvalCapabilities).toEqual([]);
    expect(tallyAssurance([first, revision]).explicitApprovals).toBe(0);
  });
});

describe('2. adding an open dispute never makes a held proposal publishable', () => {
  it('holds every proposal that carries an open dispute (apply policy)', () => {
    fc.assert(
      fc.property(arbContext, fc.integer({ min: 1, max: 3 }), (context, opened) => {
        const disputed: PolicyContext = {
          ...context,
          assurance: { ...context.assurance, disputesOpen: opened },
        };
        expect(allowedBy(KINETIX_APPLY_POLICY, disputed)).toBe(false);
      }),
      RUNS,
    );
  });

  it('holds every proposal that carries a dispute verdict (consensus policy)', () => {
    // `kinetix-consensus` is fed by a tally that has never heard of the
    // unified disputes table, so the mechanism it reads is the dispute
    // *verdict*. Same invariant, stated against the input this policy has.
    fc.assert(
      fc.property(arbContext, fc.integer({ min: 1, max: 3 }), (context, disputing) => {
        const disputed: PolicyContext = {
          ...context,
          assurance: { ...context.assurance, disputingAssessors: disputing },
        };
        expect(allowedBy(KINETIX_POLICY, disputed)).toBe(false);
      }),
      RUNS,
    );
  });
});

describe('3. lowering a verifier capability never eases a high-risk proposal', () => {
  it('allowed-after implies allowed-before, for every high-risk context', () => {
    fc.assert(
      fc.property(arbContext, (base) => {
        const context: PolicyContext = {
          ...base,
          risk: riskProfile('high', base.risk.tags),
        };
        const lowered = withoutCapability(context, KINETIX_FLAGSHIP_CAPABILITY);
        if (allowedBy(KINETIX_APPLY_POLICY, lowered)) {
          expect(allowedBy(KINETIX_APPLY_POLICY, context)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('holds a high-risk proposal outright once no approver is flagship', () => {
    fc.assert(
      fc.property(arbContext, (base) => {
        const lowered = withoutCapability(
          { ...base, risk: riskProfile('high', base.risk.tags) },
          KINETIX_FLAGSHIP_CAPABILITY,
        );
        expect(allowedBy(KINETIX_APPLY_POLICY, lowered)).toBe(false);
      }),
      RUNS,
    );
  });
});

describe('4. known capability → unknown fails safe', () => {
  it('never publishes something that was held with the capability recorded', () => {
    fc.assert(
      fc.property(arbContext, (context) => {
        const unknown = withUnknownCapabilities(context);
        if (allowedBy(KINETIX_APPLY_POLICY, unknown)) {
          expect(allowedBy(KINETIX_APPLY_POLICY, context)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('holds every high-risk and every clinical proposal with no capability recorded', () => {
    // The two gates that read capabilities. An unrecorded tier is the shape a
    // pre-migration verdict row has (`verifier_tier` null), so "unknown" is not
    // hypothetical — it is what history looks like.
    fc.assert(
      fc.property(arbContext, (base) => {
        const highRisk = withUnknownCapabilities({
          ...base,
          risk: riskProfile('high', base.risk.tags),
        });
        expect(allowedBy(KINETIX_APPLY_POLICY, highRisk)).toBe(false);

        const clinical = withUnknownCapabilities({
          ...base,
          risk: riskProfile(base.risk.level, [KINETIX_CLINICAL_CASE_TAG]),
        });
        expect(allowedBy(KINETIX_APPLY_POLICY, clinical)).toBe(false);
      }),
      RUNS,
    );
  });
});

describe('5. changing the payload invalidates the old version', () => {
  /**
   * The pure half of the invariant. The other half — that approvals recorded
   * against version N do not count toward version N+1 — is structural rather
   * than computable, and is proved end to end by scenario 7 in
   * `../e2e/scenarios.test.ts`.
   */
  const arbPayload = fc.dictionary(
    fc.constantFrom('factStatement', 'value', 'unit', 'note'),
    fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
    { maxKeys: 4 },
  );

  it('gives different payloads different fingerprints', () => {
    fc.assert(
      fc.property(arbPayload, arbPayload, arbPayload, (a, b, current) => {
        const same = JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
        const fa = payloadFingerprint(a, current);
        const fb = payloadFingerprint(b, current);
        if (same) expect(fa).toBe(fb);
        else expect(fa).not.toBe(fb);
      }),
      RUNS,
    );
  });

  it('changes when the baseline moves under an unchanged proposal', () => {
    // A revision is not only "the author typed something else". The same
    // proposed value against a different current value is a different change,
    // and a fingerprint that ignored the baseline would let a stale approval
    // survive a concurrent edit to the target.
    fc.assert(
      fc.property(arbPayload, arbPayload, arbPayload, (proposal, x, y) => {
        const same = JSON.stringify(canonical(x)) === JSON.stringify(canonical(y));
        const fx = payloadFingerprint(proposal, x);
        const fy = payloadFingerprint(proposal, y);
        if (same) expect(fx).toBe(fy);
        else expect(fx).not.toBe(fy);
      }),
      RUNS,
    );
  });

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  }
});

// Invariant 6 was "agent approvals alone never publish a human's proposal".
// It was retired with `kinetix-consensus v2` / `kinetix-consensus-apply@v3`,
// when the owner decided a person's proposal publishes on agent consensus under
// the same bar as an agent's. What replaces it is the stronger statement below
// — authorship never moves the bar either way — plus the one authorship that
// still needs a person: a proposal nobody can be named the author of.
describe('6. authorship never changes the bar; an unattributed proposal needs a person', () => {
  const arbAssurance = fc
    .tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 2 }), arbCapabilities)
    .map(([agentApprovals, disputes, capabilities]) => ({
      ...EMPTY_ASSURANCE_PROFILE,
      explicitApprovals: agentApprovals,
      independentApprovers: agentApprovals,
      agentApprovals,
      humanApprovals: 0,
      disputingAssessors: disputes,
      approvalCapabilities: capabilities,
      humanApprovalCapabilities: [],
    }));

  it('holds a person\u2019s proposal to exactly the bar an agent\u2019s meets', () => {
    fc.assert(
      fc.property(
        arbAssurance,
        arbPool,
        fc.constantFrom<'low' | 'medium' | 'high'>('low', 'medium', 'high'),
        fc.boolean(),
        (assurance, pool, riskLevel, clinical) => {
          const risk = riskProfile(riskLevel, clinical ? [KINETIX_CLINICAL_CASE_TAG] : []);
          const human = makeContext({ author: HUMAN_AUTHOR, risk, pool, assurance });
          const agent = makeContext({ author: AGENT_AUTHOR, risk, pool, assurance });
          for (const policySet of [KINETIX_APPLY_POLICY, KINETIX_POLICY]) {
            expect(allowedBy(policySet, human)).toBe(allowedBy(policySet, agent));
          }
        },
      ),
      RUNS,
    );
  });

  it('never publishes an unattributed proposal on agent approvals alone', () => {
    fc.assert(
      fc.property(
        arbAssurance,
        arbPool,
        fc.constantFrom<'low' | 'medium' | 'high'>('low', 'medium', 'high'),
        (assurance, pool, riskLevel) => {
          const context = makeContext({
            author: { ...HUMAN_AUTHOR, kind: 'system' },
            risk: riskProfile(riskLevel),
            pool,
            assurance,
          });
          expect(allowedBy(KINETIX_APPLY_POLICY, context)).toBe(false);
          expect(allowedBy(KINETIX_POLICY, context)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('is not vacuous — agents alone publish a person\u2019s proposal, and one human approval unblocks an unattributed one', () => {
    const pool = reviewerPoolState({
      poolSize: 3,
      designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM,
    });
    const agentsOnly = { explicitApprovals: 2, independentApprovers: 2, agentApprovals: 2 };
    expect(
      allowedBy(KINETIX_APPLY_POLICY, makeContext({ author: HUMAN_AUTHOR, pool, assurance: agentsOnly })),
    ).toBe(true);
    const unattributed = { ...HUMAN_AUTHOR, kind: 'system' as const };
    expect(
      allowedBy(KINETIX_APPLY_POLICY, makeContext({ author: unattributed, pool, assurance: agentsOnly })),
    ).toBe(false);
    expect(
      allowedBy(
        KINETIX_APPLY_POLICY,
        makeContext({
          author: unattributed,
          pool,
          assurance: {
            explicitApprovals: 2,
            independentApprovers: 2,
            agentApprovals: 1,
            humanApprovals: 1,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('7. a degraded quorum never carries a high-risk proposal', () => {
  it('holds every high-risk proposal below the design target', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 }),
        fc.integer({ min: 0, max: KINETIX_DESIGN_TARGET_QUORUM - 1 }),
        arbCapabilities,
        fc.boolean(),
        (poolSize, approvals, capabilities, authorIsEligibleVerifier) => {
          const pool = reviewerPoolState({
            poolSize,
            designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM,
            authorIsEligibleVerifier,
          });
          fc.pre(pool.degraded);
          const context = makeContext({
            author: AGENT_AUTHOR,
            risk: riskProfile('high'),
            pool,
            assurance: {
              explicitApprovals: approvals,
              independentApprovers: approvals,
              agentApprovals: approvals,
              // Even granting the flagship capability outright: the count gate
              // is separate from the tier gate and both must pass.
              approvalCapabilities: [...capabilities, KINETIX_FLAGSHIP_CAPABILITY],
            },
          });
          expect(allowedBy(KINETIX_APPLY_POLICY, context)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('is not vacuous — the same edit publishes once the pool supplies the target', () => {
    const context = makeContext({
      author: AGENT_AUTHOR,
      risk: riskProfile('high'),
      pool: reviewerPoolState({
        poolSize: 3,
        designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM,
      }),
      assurance: {
        explicitApprovals: KINETIX_DESIGN_TARGET_QUORUM,
        independentApprovers: KINETIX_DESIGN_TARGET_QUORUM,
        agentApprovals: KINETIX_DESIGN_TARGET_QUORUM,
        approvalCapabilities: [KINETIX_FLAGSHIP_CAPABILITY],
      },
    });
    expect(allowedBy(KINETIX_APPLY_POLICY, context)).toBe(true);
  });
});

describe('8. evaluation is deterministic for an identical context', () => {
  it('returns an identical decision on re-evaluation', () => {
    fc.assert(
      fc.property(arbContext, (context) => {
        expect(KINETIX_APPLY_POLICY.evaluate(context)).toEqual(
          KINETIX_APPLY_POLICY.evaluate(context),
        );
      }),
      RUNS,
    );
  });

  it('returns an identical decision for a structurally equal but distinct object', () => {
    // Same claim, stronger: nothing is memoised on object identity, and no
    // field order affects the input fingerprint that reaches a decision record.
    fc.assert(
      fc.property(arbContext, (context) => {
        const clone = JSON.parse(JSON.stringify(context)) as PolicyContext;
        const a = KINETIX_APPLY_POLICY.evaluate(context);
        const b = KINETIX_APPLY_POLICY.evaluate(clone);
        expect(b.allowed).toBe(a.allowed);
        expect(b.inputFingerprint).toBe(a.inputFingerprint);
        expect(b.unmet.map((o) => o.requirementId)).toEqual(
          a.unmet.map((o) => o.requirementId),
        );
      }),
      RUNS,
    );
  });

  it('reads no clock and no randomness', () => {
    // Determinism that only holds when nothing else moves is not determinism.
    // Both globals are stubbed to something a policy reading them would have to
    // notice, and the decision must not move.
    const context = makeContext({ risk: riskProfile('high') });
    const before = KINETIX_APPLY_POLICY.evaluate(context);
    const realRandom = Math.random;
    const realNow = Date.now;
    try {
      Math.random = () => 0.999_999;
      Date.now = () => 4_102_444_800_000;
      expect(KINETIX_APPLY_POLICY.evaluate(context)).toEqual(before);
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  });
});
