/**
 * Phase 1 core: the policy engine.
 *
 * The engine's contract is narrow but load-bearing: matchers AND their fields,
 * a risk matcher is a floor, evaluation order is fixed, every applicable
 * requirement is evaluated even after one fails, and rule ids are stable. Host
 * code maps the *first* unmet requirement onto its own vocabulary, so the
 * ordering rules below are behaviour, not presentation.
 */
import { describe, expect, it } from 'vitest';
import {
  humanApproval,
  independentApprovals,
  matchesRule,
  noDisputingAssessments,
  policy,
  riskProfile,
} from 'assurance-core';
import type { PolicyContext, PolicyRule, Requirement } from 'assurance-core';
import {
  AGENT_AUTHOR,
  HUMAN_AUTHOR,
  makeContext,
} from '../support/policy-context.js';

/** A requirement with a caller-chosen verdict, for order/selection assertions. */
function marker(id: string, met: boolean): Requirement {
  return {
    id,
    params: {},
    describe: () => id,
    evaluate: () => ({ requirementId: id, met, description: id }),
  };
}

describe('matchesRule', () => {
  const context = makeContext({
    targetType: 'param_entry',
    risk: riskProfile('medium', ['calculation_driving']),
    flags: ['shadow_mode'],
  });

  it('treats a null or empty matcher as always applying', () => {
    expect(matchesRule(null, context)).toBe(true);
    expect(matchesRule({}, context)).toBe(true);
  });

  it('ANDs every present field', () => {
    expect(
      matchesRule({ targetType: 'param_entry', risk: 'medium' }, context),
    ).toBe(true);
    expect(
      matchesRule({ targetType: 'param_entry', risk: 'high' }, context),
    ).toBe(false);
  });

  it('accepts a single value or a list for authorKind and targetType', () => {
    expect(matchesRule({ authorKind: 'agent' }, context)).toBe(true);
    expect(matchesRule({ authorKind: ['human', 'agent'] }, context)).toBe(true);
    expect(matchesRule({ authorKind: ['human', 'system'] }, context)).toBe(false);
    expect(matchesRule({ targetType: ['wiki_fact', 'param_entry'] }, context)).toBe(
      true,
    );
  });

  it('treats risk as a floor', () => {
    expect(matchesRule({ risk: 'low' }, context)).toBe(true);
    expect(matchesRule({ risk: 'medium' }, context)).toBe(true);
    expect(matchesRule({ risk: 'high' }, context)).toBe(false);
  });

  it('does not match everything on an unknown risk level', () => {
    // A typo'd level must fail closed, not turn the rule into a no-op condition.
    expect(matchesRule({ risk: 'critical' as never }, context)).toBe(false);
  });

  it('requires every listed tag and flag, not just one', () => {
    expect(matchesRule({ riskTags: ['calculation_driving'] }, context)).toBe(true);
    expect(
      matchesRule({ riskTags: ['calculation_driving', 'entry_backed'] }, context),
    ).toBe(false);
    expect(matchesRule({ flags: ['shadow_mode'] }, context)).toBe(true);
    expect(matchesRule({ flags: ['shadow_mode', 'other'] }, context)).toBe(false);
  });
});

describe('policy builder', () => {
  it('rejects a duplicate rule id', () => {
    // Ids reach persisted decision records; two rules answering to one id would
    // make those records ambiguous.
    expect(() =>
      policy('p', 'v1')
        .rule({ id: 'a', require: [] })
        .rule({ id: 'a', require: [] }),
    ).toThrow(/duplicate rule id 'a'/);
  });

  it('rejects a fallback that collides with a rule id', () => {
    expect(() =>
      policy('p', 'v1')
        .rule({ id: 'a', require: [] })
        .otherwise({ id: 'a', require: [] }),
    ).toThrow(/duplicate rule id 'a'/);
  });

  it('treats an empty matcher exactly like an omitted one', () => {
    // Codex P2: `when: {}` used to count as a matched CONDITIONAL rule, which
    // suppressed every `.otherwise()` rule — while omitting `when`, documented
    // as equivalent, did not. That dropped the fallback's requirements, the
    // fail-open direction.
    const build = (when?: Record<string, never>) =>
      policy('p', 'v1')
        .rule({ id: 'always', when, require: [marker('always.1', true)] })
        .otherwise({ id: 'fallback', require: [marker('fallback.1', false)] })
        .build();

    const omitted = build().evaluate(makeContext());
    const empty = build({}).evaluate(makeContext());
    expect(empty.matchedRuleIds).toEqual(omitted.matchedRuleIds);
    expect(empty.matchedRuleIds).toEqual(['always', 'fallback']);
    expect(empty.allowed).toBe(false);
  });

  it('treats a vacuous tag or flag list as no constraint at all', () => {
    // `riskTags: []` is "every tag in []", which is vacuously true — so it is
    // not a conditional match and must not suppress the fallback either.
    const set = policy('p', 'v1')
      .rule({ id: 'vacuous', when: { riskTags: [], flags: [] }, require: [] })
      .otherwise({ id: 'fallback', require: [marker('fallback.1', false)] })
      .build();
    expect(set.rules[0]!.when).toBeNull();
    expect(set.evaluate(makeContext()).matchedRuleIds).toEqual([
      'vacuous',
      'fallback',
    ]);
  });

  it('keeps an empty authorKind list as a never-match, not a no-constraint', () => {
    // The mirror case: "the kind is one of []" can never hold. Normalising it
    // to "always" would turn a rule that matches nothing into one that matches
    // everything — the opposite of what its author wrote.
    const set = policy('p', 'v1')
      .rule({ id: 'never', when: { authorKind: [] }, require: [marker('never.1', false)] })
      .otherwise({ id: 'fallback', require: [marker('fallback.1', true)] })
      .build();
    expect(set.rules[0]!.when).not.toBeNull();
    const decision = set.evaluate(makeContext());
    expect(decision.matchedRuleIds).toEqual(['fallback']);
    expect(decision.allowed).toBe(true);
  });

  it('describes itself as serialisable data', () => {
    const set = policy('p', 'v2')
      .rule({ id: 'base', require: [independentApprovals(2)] })
      .rule({ id: 'human', when: { authorKind: 'human' }, require: [humanApproval()] })
      .build();
    expect(set.id).toBe('p');
    expect(set.version).toBe('v2');
    expect(set.describe()).toEqual([
      {
        ruleId: 'base',
        when: null,
        isFallback: false,
        requirements: [
          {
            id: 'assurance.independentApprovals',
            description: 'at least 2 independent approval(s)',
            params: { count: 2 },
          },
        ],
      },
      {
        ruleId: 'human',
        when: { authorKind: 'human' },
        isFallback: false,
        requirements: [
          {
            id: 'assurance.humanApproval',
            description: 'at least one approval from a human',
            params: {},
          },
        ],
      },
    ]);
  });
});

describe('a built policy is immutable', () => {
  // Codex P2: a versioned policy whose rule graph can still be mutated would
  // let a consumer change what it requires while persisted decision records
  // still name the old version — the record would explain a rule that is no
  // longer the one that ran.
  function buildSet() {
    return policy('p', 'v1')
      .rule({ id: 'base', require: [marker('base.1', true)] })
      .rule({ id: 'high', when: { risk: 'high' }, require: [marker('high.1', false)] })
      .build();
  }

  it('refuses a spliced-in rule', () => {
    const set = buildSet();
    expect(() => {
      (set.rules as PolicyRule[]).push({
        id: 'injected',
        when: null,
        requirements: [],
        isFallback: false,
      });
    }).toThrow();
    expect(set.evaluate(makeContext()).matchedRuleIds).toEqual(['base']);
  });

  it('refuses a requirement appended to an existing rule', () => {
    const set = buildSet();
    expect(() => {
      (set.rules[0]!.requirements as Requirement[]).push(marker('smuggled', false));
    }).toThrow();
    expect(set.evaluate(makeContext()).allowed).toBe(true);
  });

  it('does not alias the caller’s matcher object', () => {
    const when = { risk: 'high' as const };
    const set = policy('p', 'v1')
      .rule({ id: 'high', when, require: [marker('high.1', false)] })
      .build();
    // Loosening the caller's own object after build() must not loosen the
    // policy that was built from it.
    (when as { risk: string }).risk = 'low';
    const decision = set.evaluate(makeContext({ risk: riskProfile('low') }));
    expect(decision.matchedRuleIds).toEqual([]);
    expect(decision.allowed).toBe(true);
  });

  it('does not alias a matcher’s nested tag list', () => {
    const riskTags = ['calculation_driving'];
    const set = policy('p', 'v1')
      .rule({ id: 'tagged', when: { riskTags }, require: [marker('tagged.1', false)] })
      .build();
    riskTags.push('anything_else');
    // Still keyed on the single tag the rule was declared with.
    expect(
      set.evaluate(makeContext({ risk: riskProfile('low', ['calculation_driving']) }))
        .matchedRuleIds,
    ).toEqual(['tagged']);
  });

  it('is unaffected by further builder calls after build()', () => {
    const builder = policy('p', 'v1').rule({ id: 'base', require: [marker('base.1', true)] });
    const set = builder.build();
    builder.rule({ id: 'late', require: [marker('late.1', false)] });
    expect(set.rules.map((r) => r.id)).toEqual(['base']);
    expect(set.evaluate(makeContext()).allowed).toBe(true);
  });
});

describe('evaluation', () => {
  const set = policy('p', 'v1')
    .rule({ id: 'base', require: [marker('base.1', false), marker('base.2', true)] })
    .rule({ id: 'human', when: { authorKind: 'human' }, require: [marker('human.1', false)] })
    .rule({ id: 'high', when: { risk: 'high' }, require: [marker('high.1', false)] })
    .otherwise({ id: 'fallback', require: [marker('fallback.1', false)] })
    .build();

  it('evaluates unconditional rules first, then matching conditional ones', () => {
    const decision = set.evaluate(
      makeContext({ author: HUMAN_AUTHOR, risk: riskProfile('high') }),
    );
    expect(decision.matchedRuleIds).toEqual(['base', 'human', 'high']);
    expect(decision.outcomes.map((o) => o.requirementId)).toEqual([
      'base.1',
      'base.2',
      'human.1',
      'high.1',
    ]);
  });

  it('applies the fallback only when no conditional rule matched', () => {
    const noMatch = set.evaluate(
      makeContext({ author: AGENT_AUTHOR, risk: riskProfile('low') }),
    );
    expect(noMatch.matchedRuleIds).toEqual(['base', 'fallback']);

    const matched = set.evaluate(
      makeContext({ author: AGENT_AUTHOR, risk: riskProfile('high') }),
    );
    expect(matched.matchedRuleIds).toEqual(['base', 'high']);
  });

  it('does not let an unconditional rule suppress the fallback', () => {
    // Otherwise `otherwise` would be unreachable in any policy with a baseline
    // — which is every policy worth writing.
    const decision = set.evaluate(makeContext({ author: AGENT_AUTHOR }));
    expect(decision.matchedRuleIds).toContain('base');
    expect(decision.matchedRuleIds).toContain('fallback');
  });

  it('evaluates every applicable requirement rather than stopping at the first failure', () => {
    const decision = set.evaluate(
      makeContext({ author: HUMAN_AUTHOR, risk: riskProfile('high') }),
    );
    // A proposal held for three reasons should be able to say all three.
    expect(decision.unmet.map((o) => o.requirementId)).toEqual([
      'base.1',
      'human.1',
      'high.1',
    ]);
  });

  it('tags every outcome with the rule that contributed it', () => {
    const decision = set.evaluate(
      makeContext({ author: HUMAN_AUTHOR, risk: riskProfile('high') }),
    );
    expect(decision.outcomes.map((o) => o.ruleId)).toEqual([
      'base',
      'base',
      'human',
      'high',
    ]);
  });

  it('allows only when nothing is unmet', () => {
    const allGood = policy('p', 'v1')
      .rule({ id: 'base', require: [marker('a', true), marker('b', true)] })
      .build();
    expect(allGood.evaluate(makeContext()).allowed).toBe(true);

    const oneBad = policy('p', 'v1')
      .rule({ id: 'base', require: [marker('a', true), marker('b', false)] })
      .build();
    expect(oneBad.evaluate(makeContext()).allowed).toBe(false);
  });

  it('is vacuously allowed when a policy declares no requirements', () => {
    const empty = policy('p', 'v1').build();
    const decision = empty.evaluate(makeContext());
    expect(decision.allowed).toBe(true);
    expect(decision.outcomes).toEqual([]);
  });

  it('records the policy id and version on the decision', () => {
    const decision = set.evaluate(makeContext());
    expect(decision.policyId).toBe('p');
    expect(decision.policyVersion).toBe('v1');
  });

  it('is deterministic across repeated evaluation', () => {
    const context = makeContext({ author: HUMAN_AUTHOR, risk: riskProfile('high') });
    expect(set.evaluate(context)).toEqual(set.evaluate(context));
  });

  it('does not read the author’s own capabilities', () => {
    // The gate must not be swayed by what the submitter holds; only by what
    // reviewers recorded.
    const base: PolicyContext = makeContext();
    const privileged: PolicyContext = makeContext({
      author: {
        ...AGENT_AUTHOR,
        capabilities: ['review.edit.decide', 'admin'],
        assuranceCapabilities: ['model_tier:flagship'],
      },
    });
    expect(set.evaluate(privileged).unmet.map((o) => o.requirementId)).toEqual(
      set.evaluate(base).unmet.map((o) => o.requirementId),
    );
  });
});
