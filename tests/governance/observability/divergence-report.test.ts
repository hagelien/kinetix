/**
 * §17: observability and parity reporting.
 *
 * The section opens with the reason it exists — *"A strangler migration is
 * unsafe if divergences are visible only after a user complains"* — and the
 * tests that matter are the ones where the report refuses to look healthy.
 *
 * Three failure modes are specifically guarded:
 *
 *  1. **A blocking condition scored as a warning.** §17.2 lists six failures
 *     that block cutover outright. If severity were the only signal, a
 *     mis-scored record would quietly stop blocking.
 *  2. **An empty denominator reported as success.** A mirror success rate of 1
 *     over zero attempts reads as "everything worked" and means "nothing ran".
 *  3. **An uninstrumented metric reported as zero.** §17.3 asks for a fallback
 *     count that nothing currently publishes. Reporting 0 would claim the
 *     system never fell back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CRITICAL_REASONS,
  blocksCutover,
  criticalDivergences,
  divergence,
  fromPolicyComparison,
  fromQueueComparison,
  fromReconciliation,
} from '../../../api/_lib/knowledge-governance/divergence.js';
import {
  describeParityReport,
  parityReport,
} from '../../../api/_lib/knowledge-governance/report.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { resetMetricsForTests } from '../../../api/_lib/knowledge-governance/metrics.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
  delete process.env[FORCE_LEGACY_ENV];
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  resetMetricsForTests();
  delete process.env[FORCE_LEGACY_ENV];
});

describe('§17.1 — one record every comparison normalises into', () => {
  it('names all six §17.2 conditions', () => {
    expect(CRITICAL_REASONS).toHaveLength(6);
  });

  it('forces a record naming a §17.2 condition to be critical', () => {
    // The guard against the failure mode this whole classifier exists to stop:
    // a blocking condition filed as a warning stops blocking.
    const record = divergence({
      targetType: 'pending_edit',
      legacySubjectId: '1',
      category: 'policy_decision',
      legacyValue: 'hold',
      genericValue: 'apply',
      severity: 'info',
      criticalReason: 'generic_would_apply_legacy_holds',
    });
    expect(record.severity).toBe('critical');
  });

  it('stamps a timestamp when the caller does not', () => {
    const record = divergence({
      targetType: 'x',
      legacySubjectId: '1',
      category: 'review_packet',
      legacyValue: null,
      genericValue: null,
      severity: 'info',
    });
    expect(Date.parse(record.createdAt)).not.toBeNaN();
  });
});

describe('§17.2 — permissive divergence blocks, conservative does not', () => {
  it('marks a generic apply over a legacy hold critical', () => {
    const record = fromPolicyComparison({
      targetType: 'pending_edit',
      legacySubjectId: '1',
      legacyOutcome: 'hold',
      genericOutcome: 'apply',
      reasons: [],
    })!;
    expect(record.severity).toBe('critical');
    expect(record.criticalReason).toBe('generic_would_apply_legacy_holds');
    expect(blocksCutover([record], 'pending_edit')).toBe(true);
  });

  it('marks the conservative direction a warning', () => {
    // Safe — nothing publishes that should not — but it creates review backlog
    // and has to be explained rather than tolerated silently.
    const record = fromPolicyComparison({
      targetType: 'pending_edit',
      legacySubjectId: '1',
      legacyOutcome: 'apply',
      genericOutcome: 'hold',
      reasons: ['assurance.independentApprovals'],
    })!;
    expect(record.severity).toBe('warning');
    expect(blocksCutover([record], 'pending_edit')).toBe(false);
  });

  it('records nothing when the two agree', () => {
    expect(
      fromPolicyComparison({
        targetType: 'pending_edit',
        legacySubjectId: '1',
        legacyOutcome: 'hold',
        genericOutcome: 'hold',
        reasons: [],
      }),
    ).toBeNull();
  });

  it('blocks only the target type the divergence is about', () => {
    const record = fromPolicyComparison({
      targetType: 'pending_edit',
      legacySubjectId: '1',
      legacyOutcome: 'hold',
      genericOutcome: 'apply',
      reasons: [],
    })!;
    expect(blocksCutover([record], 'wiki_revision')).toBe(false);
  });

  it('blocks on one, with no threshold to tune', () => {
    // §17.2: "Immediately block target-type cutover if…" — one is enough.
    const record = fromPolicyComparison({
      targetType: 'pending_edit',
      legacySubjectId: '1',
      legacyOutcome: 'hold',
      genericOutcome: 'apply',
      reasons: [],
    })!;
    expect(criticalDivergences([record])).toHaveLength(1);
  });
});

describe('§17.2 — the queue directions are not symmetric', () => {
  const comparison = {
    targetType: 'pending_edit',
    legacyOnly: [{ key: 'pending_edit:1', reason: 'already_judged' }],
    genericOnly: ['pending_edit:2'],
    packetMismatches: [
      { key: 'pending_edit:3', legacyFingerprint: 'a', genericFingerprint: 'b' },
    ],
  };

  it('treats generic withholding work as conservative', () => {
    const records = fromQueueComparison(comparison);
    const legacyOnly = records.find((r) => r.legacySubjectId === 'pending_edit:1')!;
    expect(legacyOnly.severity).toBe('warning');
  });

  it('treats generic serving what legacy withheld as critical', () => {
    // The legacy queue withholds a row for a reason — the caller authored it,
    // already judged it, or may not see it — so this is a candidate
    // independence failure rather than merely a difference.
    const records = fromQueueComparison(comparison);
    const genericOnly = records.find((r) => r.legacySubjectId === 'pending_edit:2')!;
    expect(genericOnly.severity).toBe('critical');
    expect(blocksCutover(records, 'pending_edit')).toBe(true);
  });

  it('records a packet mismatch as a review_packet divergence', () => {
    const records = fromQueueComparison(comparison);
    const mismatch = records.find((r) => r.category === 'review_packet')!;
    expect(mismatch.legacyValue).toBe('a');
    expect(mismatch.genericValue).toBe('b');
  });
});

describe('§17.1 — reconciliation findings normalise', () => {
  it.each([
    ['fingerprint_mismatch', 'payload_fingerprint'],
    ['state_mismatch', 'state_projection'],
    ['missing_publication', 'apply_result'],
    ['missing_assessment', 'assurance_projection'],
  ])('maps %s to the %s category', (kind, category) => {
    const record = fromReconciliation({
      kind,
      targetType: 'pending_edit',
      legacyId: 1,
      detail: 'x',
    });
    expect(record.category).toBe(category);
  });

  it('never files a reconciliation finding as merely informational', () => {
    // The mirror and the legacy tables disagreeing invalidates the evidence
    // every other comparison rests on.
    const record = fromReconciliation({
      kind: 'missing_assessment',
      targetType: 'pending_edit',
      legacyId: 1,
      detail: 'x',
    });
    expect(record.severity).not.toBe('info');
  });
});

describe('§17.3 — the report surfaces what it can and admits what it cannot', () => {
  it('reports an empty mirror rate as null, not as success', () => {
    // A success rate of 1 over zero attempts reads as "everything worked" and
    // means "nothing ran".
    return parityReport({ db }).then((report) => {
      expect(report.mirror.attempted).toBe(0);
      expect(report.mirror.successRate).toBeNull();
    });
  });

  it('counts publication fallbacks by reason', async () => {
    // §17.3's fallback count. Both paths were silent until this report went
    // looking for one; the reason label is what makes the number actionable.
    const { publishOnAgentConsensus } = await import(
      '../../../api/_lib/knowledge-governance/publication.js'
    );
    const result = await publishOnAgentConsensus({
      pendingEditId: 4242,
      approverUserId: 1,
    });
    expect(result.outcome).toBe('fell_back');

    const report = await parityReport({ db });
    expect(report.fallbacks.publication).toBe(1);
    expect(report.fallbacks.publicationByReason).toEqual({ no_pending_edit: 1 });
    expect(describeParityReport(report)).toContain('publication/no_pending_edit');
  });

  it('separates read fallbacks from publication ones', async () => {
    // They answer different questions: a read falling back means a badge
    // served a legacy number; a publication falling back means the legacy gate
    // decided.
    const report = await parityReport({ db });
    expect(report.fallbacks).toMatchObject({ read: 0, publication: 0 });
    expect(describeParityReport(report)).toContain('0 read, 0 publication');
  });

  it('surfaces migration mode by target type', async () => {
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    const report = await parityReport({ db });
    expect(report.modes).toContainEqual({
      targetType: 'pending_edit',
      mode: 'shadow',
    });
    expect(describeParityReport(report)).toContain('pending_edit');
  });

  it('surfaces the kill switch first, because it overrides everything', async () => {
    process.env[FORCE_LEGACY_ENV] = '1';
    const report = await parityReport({ db });
    expect(report.forceLegacy).toBe(true);
    expect(describeParityReport(report)).toContain('ENGAGED');
  });

  it('says so plainly when nothing blocks cutover', async () => {
    const report = await parityReport({ db });
    expect(report.blocking).toEqual([]);
    expect(describeParityReport(report)).toContain('no cutover-blocking divergences');
  });

  it('computes no summary health score', async () => {
    // A system with perfect queue parity and one permissive policy divergence
    // is not 90% healthy; it is blocked. Any single number loses that.
    const report = await parityReport({ db });
    expect(report).not.toHaveProperty('score');
    expect(report).not.toHaveProperty('health');
    expect(describeParityReport(report)).not.toMatch(/\b\d+%\s*healthy/i);
  });

  it('names an empty configuration rather than rendering an empty section', async () => {
    const report = await parityReport({ db });
    expect(describeParityReport(report)).toContain('every target is legacy_only');
  });
});
