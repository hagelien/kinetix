/**
 * The high-risk evidence gate (Phase 10 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Calculation-driving parameters — `parameter` and `param_entry` — are the last
 * things this migration should touch and the ones where a mistake is a wrong
 * dose rather than a wrong word. Phase 10 puts ten prerequisites and a
 * quantified evidence gate in front of them.
 *
 * This module encodes that gate. It advances nothing, and it is deliberately
 * *harder* to satisfy than Phase 9's dossier rather than being a copy of it:
 *
 *   - **volume**: at least 1,000 shadow decision opportunities, or 30 days of
 *     production comparison, whichever comes later;
 *   - **zero permissive divergences**, unexplained or otherwise. Phase 9 already
 *     refuses on severity-1; here the count must be zero over the *whole
 *     recorded history*, not just over the rows open today;
 *   - **the mechanical prerequisites**, each mapped to the test that proves it.
 *
 * ## Three of the ten cannot be checked from here, and say so
 *
 * Prerequisites 1 (append-only history running reliably in production), 2's
 * production half, and 10 (a rollback drill) are statements about operating the
 * system, not about its code. `OPERATIONAL_PREREQUISITES` names them, and
 * `assessHighRiskReadiness` reports them as unverifiable rather than as met.
 *
 * A gate that quietly counted an operational prerequisite as satisfied because
 * it had no way to check it would be worse than no gate: it would produce a
 * green verdict that reads as evidence.
 *
 * ## Low volume does not lower the bar
 *
 * The plan is explicit — "Do not weaken the correctness criterion merely to
 * reach a date" — and equally explicit about the substitute: if volume is low,
 * supplement with replay/property testing across historical and synthetic edge
 * cases. `tests/governance/cutover/high-risk-replay.test.ts` is that
 * supplement, and `PROPERTY_COVERAGE` maps each prerequisite it discharges.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db.js';
import { kgPolicyDecisions } from '../../../db/schema.js';
import { ensureKinetixSpace } from './backfill.js';
import { assessReadiness, type ReadinessVerdict } from './dossier.js';
import type { GovernanceDb } from './store/interface.js';

/** The edit types this gate governs (§13 Tier D). */
export const HIGH_RISK_EDIT_TYPES: readonly string[] = ['parameter', 'param_entry'];

export function isHighRiskEditType(editType: string): boolean {
  return HIGH_RISK_EDIT_TYPES.includes(editType);
}

/** §10's quantified gate. */
export const MIN_SHADOW_OPPORTUNITIES = 1000;
export const MIN_OBSERVATION_DAYS = 30;

/**
 * Prerequisites that are statements about running the system, not about its
 * code. Reported as unverifiable, never as met.
 */
export const OPERATIONAL_PREREQUISITES: readonly string[] = [
  'append-only assessment history has been running reliably in production',
  'a high-risk rollback drill has been performed',
];

/**
 * Prerequisites discharged by tests, and the file that discharges each.
 *
 * Keeping the mapping in code rather than in a document is the point: a
 * prerequisite whose test is deleted should stop being listed as covered.
 */
export const PROPERTY_COVERAGE: Readonly<Record<string, string>> = {
  'flagship capability snapshot survives downgrade/revocation races':
    'tests/governance/cutover/high-risk-replay.test.ts',
  'full quorum vs degraded quorum behaviour matches current Kinetix':
    'tests/governance/cutover/high-risk-replay.test.ts',
  'open-dispute blocking matches current Kinetix':
    'tests/governance/cutover/high-risk-replay.test.ts',
  'reference/evidence gate parity is established':
    'tests/governance/policy/apply-gate-parity.test.ts',
  'param-entry conflict and applicability locks are adapter-covered':
    'tests/governance/transaction/',
  'recomputation side effects are transactionally safe':
    'tests/governance/transaction/',
  'parameter summary/revision writes remain identical':
    'tests/governance/legacy-contract/',
};

export interface ShadowEvidence {
  /** Shadow decisions recorded for this space, all time. */
  readonly opportunities: number;
  /** How many of them concluded `apply`. */
  readonly permissive: number;
  /** Days between the first and last recorded shadow decision. */
  readonly observationDays: number;
}

export interface HighRiskVerdict {
  readonly editType: string;
  /**
   * True when every check this module *can* make has passed.
   *
   * Deliberately not called `ready`. Two of §10's ten prerequisites are
   * statements about operating the system that no code here can verify, so a
   * field named `ready` would be read as a go signal by the one caller in a
   * hurry. Passing the machine checks is a precondition for the conversation,
   * not the end of it.
   */
  readonly machineChecksPassed: boolean;
  readonly blockers: readonly string[];
  /** Prerequisites nothing here can check. Never counted as satisfied. */
  readonly unverifiable: readonly string[];
  readonly evidence: ShadowEvidence;
  /** The Phase 9 dossier, which this gate sits on top of rather than replaces. */
  readonly dossier: ReadinessVerdict;
}

/**
 * Count the shadow decisions recorded so far, and how long they span.
 *
 * Counts decisions rather than pending edits: the gate is about how many times
 * the two engines have been compared, and one long-lived edit re-evaluated
 * fifty times is fifty comparisons, while fifty edits nobody ever evaluated is
 * none.
 */
export async function collectShadowEvidence(
  db: GovernanceDb = getDb(),
): Promise<ShadowEvidence> {
  const space = await ensureKinetixSpace(db);
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      permissive: sql<number>`count(*) filter (where ${kgPolicyDecisions.decision} = 'apply')::int`,
      first: sql<Date | null>`min(${kgPolicyDecisions.evaluatedAt})`,
      last: sql<Date | null>`max(${kgPolicyDecisions.evaluatedAt})`,
    })
    .from(kgPolicyDecisions)
    .where(
      and(
        eq(kgPolicyDecisions.spaceId, space.id),
        eq(kgPolicyDecisions.evaluationMode, 'shadow'),
      ),
    );

  const first = row?.first ? new Date(row.first) : null;
  const last = row?.last ? new Date(row.last) : null;
  const observationDays =
    first && last ? (last.getTime() - first.getTime()) / 86_400_000 : 0;

  return {
    opportunities: row?.total ?? 0,
    permissive: row?.permissive ?? 0,
    observationDays,
  };
}

/**
 * Whether a calculation-driving target may be advanced.
 *
 * Builds on Phase 9's dossier rather than replacing it: everything that blocks
 * a low-risk cutover blocks a high-risk one too, and these are additional.
 */
export async function assessHighRiskReadiness(
  editType: string,
  opts: { db?: GovernanceDb; limit?: number } = {},
): Promise<HighRiskVerdict> {
  const db = opts.db ?? getDb();
  const dossier = await assessReadiness(editType, opts);
  const evidence = await collectShadowEvidence(db);
  const blockers: string[] = [...dossier.blockers];

  if (!isHighRiskEditType(editType)) {
    blockers.push(
      `'${editType}' is not a calculation-driving type; use assessReadiness (Phase 9) instead`,
    );
  }

  // "the longer of" — both conditions, not either. A thousand decisions in a
  // single afternoon has not observed a month of the system's behaviour, and a
  // month with four decisions in it has not observed the policy.
  if (evidence.opportunities < MIN_SHADOW_OPPORTUNITIES) {
    blockers.push(
      `only ${evidence.opportunities} shadow decision opportunities; §10 requires ` +
        `${MIN_SHADOW_OPPORTUNITIES}, or replay/property coverage standing in for volume ` +
        'that does not exist yet',
    );
  }
  if (evidence.observationDays < MIN_OBSERVATION_DAYS) {
    blockers.push(
      `shadow decisions span ${evidence.observationDays.toFixed(1)} days; §10 requires ` +
        `${MIN_OBSERVATION_DAYS}`,
    );
  }

  // Phase 9 refuses on a severity-1 divergence among the rows open *today*.
  // This is the stronger statement the plan asks for at Tier D: zero cases in
  // the whole recorded history where the generic engine would have published.
  // A permissive shadow decision is not automatically wrong — legacy may have
  // published too — but at this tier each one has to be accounted for by hand
  // before the count can be called zero.
  if (evidence.permissive > 0) {
    blockers.push(
      `${evidence.permissive} shadow decision(s) concluded 'apply'; each must be shown to ` +
        'match what legacy did before this tier advances (§10: zero unexplained permissive ' +
        'divergences)',
    );
  }

  return {
    editType,
    machineChecksPassed: blockers.length === 0,
    blockers,
    unverifiable: OPERATIONAL_PREREQUISITES,
    evidence,
    dossier,
  };
}

/** Render the verdict, including what only an operator can attest to. */
export function describeHighRiskVerdict(verdict: HighRiskVerdict): string {
  const lines = [
    `${verdict.editType} — high-risk cutover gate (§10)`,
    `  shadow opportunities: ${verdict.evidence.opportunities} / ${MIN_SHADOW_OPPORTUNITIES}`,
    `  observation window:   ${verdict.evidence.observationDays.toFixed(1)} / ${MIN_OBSERVATION_DAYS} days`,
    `  permissive decisions: ${verdict.evidence.permissive} (must be 0, or each accounted for)`,
    `  machine-checkable blockers: ${verdict.blockers.length}`,
  ];
  for (const blocker of verdict.blockers) lines.push(`    - ${blocker}`);
  lines.push('  requires human attestation (not checkable from here):');
  for (const item of verdict.unverifiable) lines.push(`    - ${item}`);
  lines.push(
    verdict.machineChecksPassed
      ? '  VERDICT: machine checks pass — an operator must still attest to the above'
      : '  VERDICT: machine checks fail — not a candidate for cutover',
  );
  return lines.join('\n');
}

/**
 * Shadow decisions recorded since a cutoff, for an operator checking whether
 * the window has actually accumulated rather than stalled.
 */
export async function shadowDecisionsSince(
  since: Date,
  db: GovernanceDb = getDb(),
): Promise<number> {
  const space = await ensureKinetixSpace(db);
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(kgPolicyDecisions)
    .where(
      and(
        eq(kgPolicyDecisions.spaceId, space.id),
        eq(kgPolicyDecisions.evaluationMode, 'shadow'),
        gte(kgPolicyDecisions.evaluatedAt, since),
      ),
    );
  return row?.total ?? 0;
}
