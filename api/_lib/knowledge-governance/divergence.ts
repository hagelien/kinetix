/**
 * The unified divergence record and the cutover-blocking conditions (§17 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * §17 opens with the reason this exists:
 *
 *   > A strangler migration is unsafe if divergences are visible only after a
 *   > user complains.
 *
 * Phases 4-6 each grew their own divergence shape — the reconciliation
 * scanner's `Divergence`, the queue differ's `legacyOnly`/`packetMismatches`,
 * the policy comparator's `PolicyDivergence`. Each is right for its own
 * comparison and none of them is comparable to the others, so "is this target
 * type safe to advance?" could not be answered without reading three reports in
 * three vocabularies and reconciling them by hand.
 *
 * This is §17.1's single record they all normalise into, and §17.2's six
 * conditions that must block a cutover outright.
 *
 * ## Why the critical list is separate from `severity`
 *
 * Severity is a judgment about one observation. §17.2 is a list of *specific
 * failures* — six of them, named — that block cutover no matter how they were
 * scored, how few there are, or how confident the thing that reported them was.
 * Deriving them from a severity field would mean a mis-scored observation could
 * quietly stop blocking; matching them by category and detail means the block
 * survives someone deciding a particular case "looks like a warning".
 */

/** §17.1. */
export type DivergenceCategory =
  | 'queue_eligibility'
  | 'review_packet'
  | 'policy_decision'
  | 'assurance_projection'
  | 'state_projection'
  | 'payload_fingerprint'
  | 'apply_result';

export type DivergenceSeverityLevel = 'info' | 'warning' | 'critical';

/** §17.1's structured record, as the plan writes it. */
export interface GovernanceDivergence {
  readonly targetType: string;
  readonly legacySubjectId: string;
  readonly genericSubjectId?: string;
  readonly category: DivergenceCategory;
  readonly legacyValue: unknown;
  readonly genericValue: unknown;
  readonly severity: DivergenceSeverityLevel;
  readonly createdAt: string;
  /**
   * Which §17.2 condition this is, when it is one. Not in the plan's sketch,
   * and added because "critical" alone does not tell an operator *which* of the
   * six things went wrong — and those six need different responses.
   */
  readonly criticalReason?: CriticalReason;
  /** Human-readable, for the report and the log line. */
  readonly detail?: string;
}

/** The six conditions of §17.2, named so a report can say which one fired. */
export type CriticalReason =
  | 'generic_would_apply_legacy_holds'
  | 'generic_loses_open_dispute'
  | 'generic_miscounts_implicit_approval'
  | 'generic_treats_non_flagship_as_flagship'
  | 'generic_assessment_on_stale_version'
  | 'generic_omits_required_human_expert';

export const CRITICAL_REASONS: readonly CriticalReason[] = [
  'generic_would_apply_legacy_holds',
  'generic_loses_open_dispute',
  'generic_miscounts_implicit_approval',
  'generic_treats_non_flagship_as_flagship',
  'generic_assessment_on_stale_version',
  'generic_omits_required_human_expert',
];

/** One-line explanation of each, for the report. */
export const CRITICAL_REASON_TEXT: Readonly<Record<CriticalReason, string>> = {
  generic_would_apply_legacy_holds:
    'the generic engine would publish something the legacy gate holds',
  generic_loses_open_dispute:
    'an open dispute is visible to the legacy gate and not to the generic one',
  generic_miscounts_implicit_approval:
    'a self or implicit approval is counted toward the independent quorum',
  generic_treats_non_flagship_as_flagship:
    'a mid-tier or unclassified verifier satisfies the flagship requirement',
  generic_assessment_on_stale_version:
    'an assessment is counted against a payload it did not judge',
  generic_omits_required_human_expert:
    'a target needing a qualified human is publishable without one',
};

export function divergence(
  args: Omit<GovernanceDivergence, 'createdAt'> & { createdAt?: string },
): GovernanceDivergence {
  return {
    ...args,
    // Severity and criticality are kept consistent here rather than trusted
    // from the caller: a record naming a §17.2 condition is critical by
    // definition, and letting one be filed as a warning is exactly how a
    // blocking condition stops blocking.
    severity: args.criticalReason ? 'critical' : args.severity,
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
}

/** Every record that blocks cutover. */
export function criticalDivergences(
  records: readonly GovernanceDivergence[],
): GovernanceDivergence[] {
  return records.filter(
    (r) => r.criticalReason !== undefined || r.severity === 'critical',
  );
}

/**
 * Whether a target type may be advanced, per §17.2.
 *
 * "Immediately block target-type cutover" — so one is enough, and the count is
 * not a threshold anyone gets to tune.
 */
export function blocksCutover(
  records: readonly GovernanceDivergence[],
  targetType: string,
): boolean {
  return criticalDivergences(records).some((r) => r.targetType === targetType);
}

/**
 * Normalise a reconciliation finding.
 *
 * `missing_publication` is the one that maps to a §17.2 condition: a legacy row
 * that applied with no generic publication event means the two sides disagree
 * about whether something was published, which is the `apply_result` category
 * at its most consequential.
 */
export function fromReconciliation(finding: {
  kind: string;
  targetType: string;
  legacyId?: number;
  genericId?: number;
  detail: string;
}): GovernanceDivergence {
  const category: DivergenceCategory =
    finding.kind === 'fingerprint_mismatch'
      ? 'payload_fingerprint'
      : finding.kind === 'state_mismatch'
        ? 'state_projection'
        : finding.kind === 'missing_publication'
          ? 'apply_result'
          : 'assurance_projection';
  return divergence({
    targetType: finding.targetType,
    legacySubjectId: String(finding.legacyId ?? ''),
    genericSubjectId: finding.genericId ? String(finding.genericId) : undefined,
    category,
    legacyValue: finding.kind,
    genericValue: null,
    // A reconciliation finding means the mirror and the legacy tables disagree.
    // That is not itself one of §17.2's six, but it invalidates the evidence
    // every other comparison rests on, so it is never merely informational.
    severity: 'warning',
    detail: finding.detail,
  });
}

/** Normalise a policy comparison. */
export function fromPolicyComparison(args: {
  targetType: string;
  legacySubjectId: string;
  genericSubjectId?: string;
  legacyOutcome: 'apply' | 'hold';
  genericOutcome: 'apply' | 'hold';
  reasons: readonly string[];
}): GovernanceDivergence | null {
  if (args.legacyOutcome === args.genericOutcome) return null;
  const permissive =
    args.genericOutcome === 'apply' && args.legacyOutcome === 'hold';
  return divergence({
    targetType: args.targetType,
    legacySubjectId: args.legacySubjectId,
    genericSubjectId: args.genericSubjectId,
    category: 'policy_decision',
    legacyValue: args.legacyOutcome,
    genericValue: args.genericOutcome,
    severity: permissive ? 'critical' : 'warning',
    criticalReason: permissive ? 'generic_would_apply_legacy_holds' : undefined,
    detail: permissive
      ? CRITICAL_REASON_TEXT.generic_would_apply_legacy_holds
      : `the generic policy holds (${args.reasons.join(', ') || 'no reason recorded'}) ` +
        'where the legacy gate applies; safe, but it creates review backlog',
  });
}

/** Normalise a queue comparison. */
export function fromQueueComparison(args: {
  targetType: string;
  legacyOnly: ReadonlyArray<{ key: string; reason: string }>;
  genericOnly: readonly string[];
  packetMismatches: ReadonlyArray<{
    key: string;
    legacyFingerprint: string;
    genericFingerprint: string;
  }>;
}): GovernanceDivergence[] {
  const out: GovernanceDivergence[] = [];
  for (const item of args.legacyOnly) {
    out.push(
      divergence({
        targetType: args.targetType,
        legacySubjectId: item.key,
        category: 'queue_eligibility',
        legacyValue: 'served',
        genericValue: item.reason,
        // The generic queue withholding work is conservative: a reviewer sees
        // less, nothing publishes wrongly.
        severity: 'warning',
        detail: `legacy served ${item.key}; the generic selector dropped it as ${item.reason}`,
      }),
    );
  }
  for (const key of args.genericOnly) {
    out.push(
      divergence({
        targetType: args.targetType,
        legacySubjectId: key,
        category: 'queue_eligibility',
        legacyValue: 'withheld',
        genericValue: 'served',
        // The other direction is not symmetric. The legacy queue withholds a
        // row for a reason — the caller authored it, already judged it, or may
        // not see it — so the generic queue offering one legacy withheld is a
        // candidate independence failure, not merely a difference.
        severity: 'critical',
        detail: `the generic selector served ${key}, which the legacy queue withheld`,
      }),
    );
  }
  for (const mismatch of args.packetMismatches) {
    out.push(
      divergence({
        targetType: args.targetType,
        legacySubjectId: mismatch.key,
        category: 'review_packet',
        legacyValue: mismatch.legacyFingerprint,
        genericValue: mismatch.genericFingerprint,
        severity: 'warning',
        detail: `both queues served ${mismatch.key} with different review packets`,
      }),
    );
  }
  return out;
}

/** One structured log line per record, for §17.3's "structured logging". */
export function logDivergence(record: GovernanceDivergence): void {
  const line = JSON.stringify({ kgDivergence: record });
  if (record.severity === 'critical') console.error(line);
  else if (record.severity === 'warning') console.warn(line);
  else console.info(line);
}
