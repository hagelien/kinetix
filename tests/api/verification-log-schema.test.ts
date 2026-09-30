import { describe, expect, it } from 'vitest';
import { createVerificationLogSchema } from '../../api/_lib/schemas';

describe('createVerificationLogSchema', () => {
  it('accepts a minimal parameter row', () => {
    const r = createVerificationLogSchema.safeParse({
      targetType: 'parameter',
      targetId: 42,
      parameter: 'half_life',
      sourcesConsultedCount: 3,
      concordance: 'strong',
      outcome: 'submitted_pending',
      agentNotes: 'Revised diazepam half-life; 3 primary PK sources.',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a rejection_review row carrying the full merged ledger', () => {
    // §2.A pre-cycle learning writes the ENTIRE cumulative cross-agent lessons
    // ledger into agentNotes — not a one-line summary. A fully-populated
    // ~12-rule ledger with concrete, drug-specific rules exceeds the old
    // 2000-char cap; if the schema rejects it the write returns 400 and §8
    // halts the whole cycle (a deadlock, since the watermark never advances).
    const rule =
      'Require >=3 independent primary PK sources before submitting or ' +
      'revising a half-life, clearance, or Vd value for opioids and ' +
      'benzodiazepines; label-only or review-derived values are insufficient ' +
      'and get rejected as insufficient_sources.';
    const ledger = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${rule}`).join(
      ' ',
    );
    expect(ledger.length).toBeGreaterThan(2000);

    const r = createVerificationLogSchema.safeParse({
      targetType: 'rejection_review',
      outcome: 'no_change',
      sourcesConsultedCount: 0,
      agentNotes: ledger,
    });
    expect(r.success).toBe(true);
  });

  it('still rejects a runaway agentNotes payload', () => {
    const r = createVerificationLogSchema.safeParse({
      targetType: 'rejection_review',
      outcome: 'no_change',
      agentNotes: 'x'.repeat(20001),
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown target type', () => {
    expect(
      createVerificationLogSchema.safeParse({
        targetType: 'not_a_type',
        outcome: 'no_change',
      }).success,
    ).toBe(false);
  });

  describe('absent parameter rows must be able to suppress the gap', () => {
    /**
     * An `absent` parameter verification is the only log row with a
     * consequence: the gap queue skips the pair for ABSENT_RECHECK_DAYS by
     * matching `target_id` and `parameter`. A row missing either — or naming a
     * parameter the registry does not have — matches nothing, so the agent
     * gets a 200, believes it recorded "no literature exists", and the same
     * gap comes back next cycle. That is the benzoylecgonine bug re-entering
     * through the mechanism built to fix it, wearing a successful audit trail.
     */
    const base = {
      targetType: 'parameter' as const,
      concordance: 'absent' as const,
      outcome: 'no_change' as const,
      sourcesConsultedCount: 8,
    };

    it('accepts one that names the drug and a registry parameter', () => {
      const r = createVerificationLogSchema.safeParse({
        ...base,
        targetId: 42,
        parameter: 'bioavailability',
      });
      expect(r.success).toBe(true);
    });

    it('rejects one with no targetId', () => {
      const r = createVerificationLogSchema.safeParse({
        ...base,
        parameter: 'bioavailability',
      });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['targetId']);
    });

    it('rejects one with no parameter', () => {
      const r = createVerificationLogSchema.safeParse({
        ...base,
        targetId: 42,
      });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['parameter']);
    });

    it('accepts a coverage area, which the queue suppresses the same way', () => {
      // `metabolism` and `pharmacodynamics` are work targets without parameter
      // ids, and the queue's coverage lane runs them through the same
      // absent-cooldown predicate. Refusing them here would leave the one
      // state that suppresses an exhausted search unwritable for exactly the
      // two areas whose searches are longest — the loop again, on the lane
      // added to close it.
      for (const parameter of ['metabolism', 'pharmacodynamics']) {
        const r = createVerificationLogSchema.safeParse({
          ...base,
          targetId: 42,
          parameter,
        });
        expect(r.success, parameter).toBe(true);
      }
    });

    it('rejects a misspelled parameter, which would match nothing', () => {
      // The failure this catches is silent: 'half_life' is well-formed, passes
      // the max(60) string check, and never equals a registry id. Widening the
      // accepted set to the coverage areas must not widen it to everything —
      // 'metabolisme' is the Norwegian label, not the id.
      for (const parameter of ['half_life', 'metabolisme', 'Metabolism']) {
        const r = createVerificationLogSchema.safeParse({
          ...base,
          targetId: 42,
          parameter,
        });
        expect(r.success, parameter).toBe(false);
      }
    });

    it('leaves non-absent parameter rows alone', () => {
      // Only the absent row drives suppression. Constraining the others would
      // be a behaviour change dressed as validation — and the strong-concordance
      // row above already logs a non-registry parameter name.
      const r = createVerificationLogSchema.safeParse({
        targetType: 'parameter',
        concordance: 'weak',
        outcome: 'commented_only',
      });
      expect(r.success).toBe(true);
    });
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      createVerificationLogSchema.safeParse({
        targetType: 'rejection_review',
        outcome: 'no_change',
        bogus: true,
      }).success,
    ).toBe(false);
  });
});
