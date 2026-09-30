import { describe, expect, it, vi } from 'vitest';

// Importing the script pulls in api/_lib/db.js transitively; mock it so the
// import never attempts a real connection. The pure functions under test do not
// touch the DB.
vi.mock('../../api/_lib/db.js', () => ({ getDb: vi.fn() }));

import {
  computeAgentCostMetrics,
  computeProducerMetrics,
  computeRunUsageMetrics,
  earliestRunStart,
  priceRun,
  rateCardEntryFor,
  computeVerifierTierMetrics,
  editOutcomeFromStatus,
  projectCosts,
  resolveEditOutcome,
  resolveVerifierTier,
  type ProducerRecord,
  type RunUsageRecord,
  type VerifierVerdictRecord,
} from '../../scripts/benchmark-agent-tiers.ts';

describe('editOutcomeFromStatus', () => {
  it('maps statuses to outcomes, unknown → pending', () => {
    expect(editOutcomeFromStatus('approved')).toBe('approved');
    expect(editOutcomeFromStatus('rejected')).toBe('rejected');
    expect(editOutcomeFromStatus('returned')).toBe('returned');
    expect(editOutcomeFromStatus('pending')).toBe('pending');
    expect(editOutcomeFromStatus('something-else')).toBe('pending');
  });
});

describe('resolveEditOutcome', () => {
  // args: (status, reviewerIsAgent, reviewerIsSubmitter)
  it('marks agent approvals as agent_applied', () => {
    expect(resolveEditOutcome('approved', true, false)).toBe('agent_applied');
    expect(resolveEditOutcome('approved', false, false)).toBe('approved');
  });

  it('is a withdrawal whenever the reviewer IS the submitter (agent OR human)', () => {
    // agent self-withdrawal
    expect(resolveEditOutcome('rejected', true, true)).toBe('self_withdrawn');
    // HUMAN self-withdrawal — reviewer is not an agent, but still the submitter
    expect(resolveEditOutcome('rejected', false, true)).toBe('self_withdrawn');
    // an editor-tier agent rejecting ANOTHER agent's edit is a genuine rejection
    expect(resolveEditOutcome('rejected', true, false)).toBe('rejected');
    // a human moderator rejecting someone else's edit is a genuine rejection
    expect(resolveEditOutcome('rejected', false, false)).toBe('rejected');
  });

  it('passes non-decided statuses through', () => {
    expect(resolveEditOutcome('pending', true, true)).toBe('pending');
    expect(resolveEditOutcome('returned', false, false)).toBe('returned');
  });
});

describe('computeVerifierTierMetrics', () => {
  it('scores each tier against human ground truth and excludes implicit + agent-applied', () => {
    const records: VerifierVerdictRecord[] = [
      // mid tier: one false-approve (approved a human-rejected edit), one true.
      { verifierTier: 'mid', verdict: 'approve', isImplicit: false, editOutcome: 'rejected' },
      { verifierTier: 'mid', verdict: 'approve', isImplicit: false, editOutcome: 'approved' },
      // A consensus self-apply: this approval caused publication, so it is
      // neither a true nor a false approve — excluded from the denominator.
      { verifierTier: 'mid', verdict: 'approve', isImplicit: false, editOutcome: 'agent_applied' },
      // flagship: one true-approve, one caught dispute.
      { verifierTier: 'flagship', verdict: 'approve', isImplicit: false, editOutcome: 'approved' },
      { verifierTier: 'flagship', verdict: 'dispute', isImplicit: false, editOutcome: 'rejected' },
      // implicit rows never count.
      { verifierTier: 'flagship', verdict: 'approve', isImplicit: true, editOutcome: 'approved' },
    ];
    const out = computeVerifierTierMetrics(records);
    const mid = out.find((m) => m.tier === 'mid')!;
    const flag = out.find((m) => m.tier === 'flagship')!;

    expect(mid.verdicts).toBe(3); // agent_applied approval still a verdict...
    expect(mid.falseApprove).toBe(1);
    expect(mid.trueApprove).toBe(1);
    expect(mid.falseApproveRate).toBeCloseTo(0.5); // ...but not in the denominator

    expect(flag.verdicts).toBe(2);
    expect(flag.falseApprove).toBe(0);
    expect(flag.trueDispute).toBe(1);
    expect(flag.falseApproveRate).toBe(0); // one decided approval, zero false
  });

  it('reports null falseApproveRate when a tier has no decided approvals', () => {
    const out = computeVerifierTierMetrics([
      { verifierTier: 'mid', verdict: 'abstain', isImplicit: false, editOutcome: 'pending' },
    ]);
    expect(out[0]?.falseApproveRate).toBeNull();
  });

  it('attributes ONLY by the trusted snapshot; a NULL snapshot is unknown', () => {
    const out = computeVerifierTierMetrics([
      { verifierTier: 'flagship', verdict: 'approve', isImplicit: false, editOutcome: 'approved' },
      { verifierTier: 'mid', verdict: 'approve', isImplicit: false, editOutcome: 'approved' },
      // NULL snapshot — legacy OR an unclassified agent. Never model-classified,
      // so it can't be spoofed into a real tier; it sits in `unknown`.
      { verifierTier: null, verdict: 'approve', isImplicit: false, editOutcome: 'approved' },
    ]);
    expect(out.find((m) => m.tier === 'flagship')?.verdicts).toBe(1);
    expect(out.find((m) => m.tier === 'mid')?.verdicts).toBe(1);
    expect(out.find((m) => m.tier === 'unknown')?.verdicts).toBe(1);
  });
});

describe('resolveVerifierTier', () => {
  it('returns the snapshot tier, and unknown for NULL or any other value', () => {
    expect(resolveVerifierTier('flagship')).toBe('flagship');
    expect(resolveVerifierTier('mid')).toBe('mid');
    expect(resolveVerifierTier('light')).toBe('light');
    expect(resolveVerifierTier(null)).toBe('unknown');
    expect(resolveVerifierTier('garbage')).toBe('unknown');
  });
});

describe('computeProducerMetrics', () => {
  it('computes rejection/return rates over HUMAN-decided edits only', () => {
    const records: ProducerRecord[] = [
      { agentSlug: 'kinetix-agent', outcome: 'approved' },
      { agentSlug: 'kinetix-agent', outcome: 'approved' },
      { agentSlug: 'kinetix-agent', outcome: 'rejected' },
      { agentSlug: 'kinetix-agent', outcome: 'returned' },
      { agentSlug: 'kinetix-agent', outcome: 'pending' }, // not decided
      // Published by consensus — bucketed separately, out of the rate denominator.
      { agentSlug: 'kinetix-agent', outcome: 'agent_applied' },
      { agentSlug: 'kinetix-agent', outcome: 'agent_applied' },
      // Self-withdrawn — must NOT count as a human rejection.
      { agentSlug: 'kinetix-agent', outcome: 'self_withdrawn' },
    ];
    const [m] = computeProducerMetrics(records);
    expect(m?.submitted).toBe(8);
    expect(m?.agentApplied).toBe(2);
    expect(m?.selfWithdrawn).toBe(1);
    // Denominator is the 4 human-decided edits — not the consensus applies and
    // not the self-withdrawal.
    expect(m?.rejectionRate).toBeCloseTo(1 / 4);
    expect(m?.returnRate).toBeCloseTo(1 / 4);
  });
});

describe('projectCosts', () => {
  it('computes per-config cost/action from price and est tokens', () => {
    const [c] = projectCosts({
      'sonnet-5-high': {
        inputPerMTok: 3,
        outputPerMTok: 15,
        estInputTokensPerAction: 200_000,
        estOutputTokensPerAction: 20_000,
      },
    });
    // 0.2M * $3 + 0.02M * $15 = 0.6 + 0.3 = $0.90/action
    expect(c?.costPerAction).toBeCloseTo(0.9);
    // Deliberately no per-config cost-per-accepted-action (see the finding).
    expect(c).not.toHaveProperty('costPerAcceptedAction');
  });
});

describe('measured run usage', () => {
  const rateCard = {
    sonnet: { inputPerMTok: 3, outputPerMTok: 15, models: ['sonnet-5'] },
    opus: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      models: ['OPUS-5'],
    },
  };
  const run = (over: Partial<RunUsageRecord>): RunUsageRecord => ({
    agentSlug: 'claude-sonnet-5',
    modelTier: 'mid',
    workflow: 'producer',
    model: 'claude-sonnet-5',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelUsage: null,
    // A one-hour run on 2026-10-02 that logged its usage at the end.
    startedAt: new Date('2026-10-02T00:00:00Z'),
    durationMs: 3_600_000,
    createdAt: new Date('2026-10-02T01:00:00Z'),
    ...over,
  });
  const out = (agentSlug: string, iso: string, n = 1) =>
    Array.from({ length: n }, () => ({ agentSlug, at: new Date(iso) }));

  it('prices a run from the entry whose models match, with default cache ratios', () => {
    // 1M input × $3 + 0.1M output × $15 + 1M cache read × $0.30 + 1M write × $3.75
    expect(
      priceRun(run({ cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }), rateCard),
    ).toBeCloseTo(3 + 1.5 + 0.3 + 3.75);
    // case-insensitive substring match, explicit cache prices
    expect(
      priceRun(run({ model: 'claude-opus-5', cacheReadTokens: 2_000_000 }), rateCard),
    ).toBeCloseTo(5 + 2.5 + 1);
  });

  it('prices each model share at its own rate (subagents)', () => {
    const counts = (input: number, output: number) => ({
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    // Sonnet main (1M in, 0.1M out) + Opus subagent (1M in): not all at Sonnet.
    expect(
      priceRun(
        run({
          inputTokens: 2_000_000,
          modelUsage: {
            'claude-sonnet-5': counts(1_000_000, 100_000),
            'claude-opus-5': counts(1_000_000, 0),
          },
        }),
        rateCard,
      ),
    ).toBeCloseTo(3 + 1.5 + 5);
    // One unpriceable share makes the whole run unpriced, not partly priced.
    expect(
      priceRun(
        run({
          modelUsage: {
            'claude-sonnet-5': counts(1_000_000, 0),
            'claude-haiku-4-5': counts(1_000_000, 0),
          },
        }),
        rateCard,
      ),
    ).toBeNull();
  });

  it('prices by the most specific pattern whatever the rate-card order', () => {
    const broadFirst = {
      gpt5: { inputPerMTok: 1, outputPerMTok: 1, models: ['gpt-5'] },
      sol: { inputPerMTok: 9, outputPerMTok: 9, models: ['gpt-5.6-sol'] },
    };
    expect(rateCardEntryFor('gpt-5.6-sol', broadFirst)?.inputPerMTok).toBe(9);
    expect(rateCardEntryFor('gpt-5.5', broadFirst)?.inputPerMTok).toBe(1);
    // Two entries tying on the longest match are ambiguous: unpriced.
    const tie = {
      a: { inputPerMTok: 1, outputPerMTok: 1, models: ['sonnet-5'] },
      b: { inputPerMTok: 2, outputPerMTok: 2, models: ['sonnet-5'] },
    };
    expect(rateCardEntryFor('claude-sonnet-5', tie)).toBeNull();
    expect(priceRun(run({}), tie)).toBeNull();
  });

  it('never guesses a price for an unmatched or missing model', () => {
    expect(priceRun(run({ model: 'gpt-5.6-terra' }), rateCard)).toBeNull();
    expect(priceRun(run({ model: null }), rateCard)).toBeNull();
    expect(priceRun(run({}), null)).toBeNull();
  });

  it('groups by server tier snapshot × workflow; NULL tier is unknown', () => {
    const metrics = computeRunUsageMetrics(
      [
        run({ cacheReadTokens: 3_000_000 }),
        run({ model: 'gpt-5.6-terra' }),
        run({ modelTier: 'flagship', workflow: 'escalation', model: 'claude-opus-5' }),
        run({ modelTier: null, model: 'claude-opus-5' }),
      ],
      rateCard,
    );
    const mid = metrics.find((m) => m.tier === 'mid')!;
    expect(mid).toMatchObject({ workflow: 'producer', runs: 2, pricedRuns: 1 });
    expect(mid.cacheReadShare).toBeCloseTo(3 / 5);
    expect(mid.cost).toBeCloseTo(3 + 1.5 + 0.9);
    expect(mid.costPerRun).toBeCloseTo(5.4);
    expect(metrics.find((m) => m.tier === 'flagship')).toMatchObject({
      workflow: 'escalation',
      runs: 1,
    });
    // A self-reported opus model does not lift an unclassified run into flagship.
    expect(metrics.find((m) => m.tier === 'unknown')).toMatchObject({ runs: 1 });
  });

  it('computes cost per accepted edit and per verdict only when fully priced', () => {
    const metrics = computeAgentCostMetrics(
      [
        run({}),
        run({}),
        run({ agentSlug: 'gpt-5-6-terra', model: 'gpt-5.6-terra' }),
        run({ agentSlug: 'claude-opus-5', modelTier: 'flagship', model: 'claude-opus-5' }),
      ],
      rateCard,
      [
        ...out('claude-sonnet-5', '2026-10-02T00:30:00Z', 3),
        ...out('gpt-5-6-terra', '2026-10-02T00:30:00Z', 4),
      ],
      out('claude-opus-5', '2026-10-02T00:30:00Z', 5),
    );
    const sonnet = metrics.find((m) => m.agentSlug === 'claude-sonnet-5')!;
    expect(sonnet).toMatchObject({ runs: 2, acceptedEdits: 3, tier: 'mid' });
    expect(sonnet.costPerAcceptedEdit).toBeCloseTo((2 * 4.5) / 3);
    const terra = metrics.find((m) => m.agentSlug === 'gpt-5-6-terra')!;
    expect(terra.cost).toBeNull();
    expect(terra.costPerAcceptedEdit).toBeNull();
    const opus = metrics.find((m) => m.agentSlug === 'claude-opus-5')!;
    expect(opus.costPerAcceptedEdit).toBeNull(); // no edits
    expect(opus.costPerVerdict).toBeCloseTo(7.5 / 5);
  });

  it('counts the outputs made during a logged run, including the first one', () => {
    const [sonnet] = computeAgentCostMetrics(
      [run({})],
      rateCard,
      [
        // Before telemetry: its cost is not in the numerator.
        ...out('claude-sonnet-5', '2026-09-01T00:00:00Z', 9),
        // During the first logged run — before its usage row was written.
        ...out('claude-sonnet-5', '2026-10-02T00:10:00Z', 2),
      ],
      [],
    );
    expect(sonnet).toMatchObject({ acceptedEdits: 2, unplacedRuns: 0 });
    expect(sonnet!.costPerAcceptedEdit).toBeCloseTo(4.5 / 2);
  });

  it('leaves out outputs of a run whose usage log failed', () => {
    const [sonnet] = computeAgentCostMetrics(
      [
        run({}),
        run({
          startedAt: new Date('2026-10-02T04:00:00Z'),
          createdAt: new Date('2026-10-02T05:00:00Z'),
        }),
      ],
      rateCard,
      [
        ...out('claude-sonnet-5', '2026-10-02T00:30:00Z', 1),
        // 02:00–03:00 was a run whose log failed: no cost, so no output.
        ...out('claude-sonnet-5', '2026-10-02T02:30:00Z', 5),
        ...out('claude-sonnet-5', '2026-10-02T04:30:00Z', 1),
      ],
      [],
    );
    expect(sonnet!.acceptedEdits).toBe(2);
    expect(sonnet!.costPerAcceptedEdit).toBeCloseTo((2 * 4.5) / 2);
  });

  it('extends a re-logged run to its refreshed duration and drops unplaceable runs from the ratio', () => {
    const [sonnet] = computeAgentCostMetrics(
      [
        // Re-logged later in the session: createdAt kept, duration refreshed.
        run({ durationMs: 2 * 3_600_000 }),
        run({ startedAt: null }),
      ],
      rateCard,
      out('claude-sonnet-5', '2026-10-02T01:30:00Z', 1),
      [],
    );
    expect(sonnet).toMatchObject({ acceptedEdits: 1, unplacedRuns: 1 });
    // Only the placed run's cost is divided by the output it produced.
    expect(sonnet!.costPerAcceptedEdit).toBeCloseTo(4.5);
    expect(sonnet!.cost).toBeCloseTo(9);
  });

  it('splits an identity reclassified mid-window into one row per tier', () => {
    const metrics = computeAgentCostMetrics(
      [
        run({}),
        run({
          modelTier: 'flagship',
          model: 'claude-opus-5',
          startedAt: new Date('2026-10-03T00:00:00Z'),
          createdAt: new Date('2026-10-03T01:00:00Z'),
        }),
      ],
      rateCard,
      [
        ...out('claude-sonnet-5', '2026-10-02T00:30:00Z', 3),
        ...out('claude-sonnet-5', '2026-10-03T00:30:00Z', 1),
      ],
      [],
    );
    expect(metrics).toHaveLength(2);
    const mid = metrics.find((m) => m.tier === 'mid')!;
    const flagship = metrics.find((m) => m.tier === 'flagship')!;
    // Each tier carries only its own runs, cost and outputs.
    expect(mid).toMatchObject({ runs: 1, acceptedEdits: 3 });
    expect(mid.costPerAcceptedEdit).toBeCloseTo(4.5 / 3);
    expect(flagship).toMatchObject({ runs: 1, acceptedEdits: 1 });
    expect(flagship.costPerAcceptedEdit).toBeCloseTo(7.5);
  });

  it('reads outputs from the start of a run already under way at --since', () => {
    // --since 00:30 selects this run (logged 01:00) although it began at 00:00;
    // its outputs must be read from 00:00, not from the cutoff.
    expect(earliestRunStart([run({})])).toEqual(
      new Date('2026-10-02T00:00:00Z'),
    );
    expect(
      earliestRunStart([
        run({}),
        run({ startedAt: null, createdAt: new Date('2026-10-01T12:00:00Z') }),
      ]),
    ).toEqual(new Date('2026-10-01T12:00:00Z'));
    expect(earliestRunStart([])).toBeNull();
  });

  it('keeps projections for entries with estimates and skips measured-only entries', () => {
    expect(
      projectCosts({
        measuredOnly: { inputPerMTok: 3, outputPerMTok: 15, models: ['sonnet'] },
      }),
    ).toEqual([]);
  });
});
