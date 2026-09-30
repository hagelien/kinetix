/**
 * The operational parity report (§17.3 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * §17.3 lists ten things that must be visible, and is explicit about the form:
 * *"An admin-only page can come later. Initially a CLI/report and structured
 * logging are sufficient."* So this is a function returning a structure and a
 * renderer producing text — no route, no page.
 *
 * The ten, and where each comes from:
 *
 * | § 17.3 item | Source |
 * | --- | --- |
 * | migration mode by target type | `kg_migration_state` |
 * | mirror success rate | the Phase 4 metrics |
 * | unresolved reconciliation items | the Phase 4 scanner |
 * | queue parity | the Phase 5 differ, when a comparison has been run |
 * | policy parity | shadow decisions vs their legacy outcome |
 * | generic-vs-legacy latency | the Phase 5 queue timings |
 * | fallback count | the Phase 7/8 fallback metric |
 * | generic errors by service | the mirror failure metrics |
 * | force-legacy status | the environment kill switch |
 * | high-risk proposal holds by reason | authoritative and shadow holds, grouped |
 *
 * ## What the report refuses to do
 *
 * It does not compute a single health number. Every attempt to reduce ten
 * signals to one loses the distinction that matters here — a system with
 * perfect queue parity and one permissive policy divergence is not 90% healthy,
 * it is blocked — and §17.2 is a list of things that block outright rather than
 * contribute to a score.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db.js';
import { kgPolicyDecisions } from '../../../db/governance-schema.js';
import { KINETIX_SPACE } from './actor-context.js';
import { ensureKinetixSpace } from './backfill.js';
import {
  forceLegacyEnabled,
  listMigrationState,
} from './migration-state.js';
import { snapshotMetrics, type MirrorMetric } from './metrics.js';
import { reconcileAll } from './reconciliation.js';
import {
  criticalDivergences,
  fromReconciliation,
  type GovernanceDivergence,
} from './divergence.js';
import type { GovernanceDb } from './store/interface.js';
import type { KgMigrationMode } from '../../../db/governance-schema.js';

export interface ParityReport {
  readonly generatedAt: string;
  readonly space: string;
  /** §17.3: force-legacy status. First, because it overrides everything else. */
  readonly forceLegacy: boolean;
  readonly modes: ReadonlyArray<{ targetType: string; mode: KgMigrationMode }>;
  readonly mirror: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    /** `null` when nothing has been attempted — not 1, and not 0. */
    readonly successRate: number | null;
  };
  readonly reconciliation: {
    readonly unresolved: number;
    readonly byKind: Readonly<Record<string, number>>;
    /**
     * True when the scanner read every row.
     *
     * `unresolved: 0` means two different things depending on this, and only
     * one of them is good news. A report that omitted it would state the
     * weaker claim in the words of the stronger one.
     */
    readonly complete: boolean;
  };
  readonly policy: {
    readonly shadowDecisions: number;
    readonly holds: number;
    readonly applies: number;
    /** §17.3: high-risk holds by reason. */
    readonly holdsByReason: Readonly<Record<string, number>>;
  };
  /**
   * §17.3's fallback count, split because the two mean different things: a read
   * falling back means a badge served a legacy number, while a publication
   * falling back means the legacy gate decided.
   */
  readonly fallbacks: {
    readonly read: number;
    readonly publication: number;
    readonly readByReason: Readonly<Record<string, number>>;
    readonly publicationByReason: Readonly<Record<string, number>>;
  };
  readonly errorsByService: Readonly<Record<string, number>>;
  /** Every divergence the report gathered, normalised (§17.1). */
  readonly divergences: readonly GovernanceDivergence[];
  /** The subset that blocks cutover (§17.2). */
  readonly blocking: readonly GovernanceDivergence[];
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/**
 * Gather the report.
 *
 * Queue parity and latency are absent unless a comparison has been run in this
 * process: the Phase 5 differ compares against what the *live route actually
 * served*, so it needs a request to compare, and inventing a number here would
 * report a comparison nobody made.
 */
export async function parityReport(
  opts: { db?: GovernanceDb; space?: string; limit?: number } = {},
): Promise<ParityReport> {
  const db = opts.db ?? getDb();
  const space = opts.space ?? KINETIX_SPACE;
  const spaceRow = await ensureKinetixSpace(db);

  const modes = (await listMigrationState(db, space)).map((m) => ({
    targetType: m.targetType,
    mode: m.mode,
  }));

  const metrics = snapshotMetrics();
  // Metric names are read from the registry rather than written out here. A
  // report that reads a metric nobody publishes reports a confident zero, which
  // is the same failure as reporting a success rate of 1 for an empty
  // denominator — it looks like health and means "unknown".
  const sumOf = (metric: MirrorMetric) =>
    Object.values(metrics[metric] ?? {}).reduce((a, b) => a + b, 0);
  const attempted = sumOf('kg_mirror_attempt_total');
  const succeeded = sumOf('kg_mirror_success_total');
  const failed = sumOf('kg_mirror_failure_total');

  const report = await reconcileAll(db, { limit: opts.limit ?? 500, space });
  const divergences = report.divergences.map(fromReconciliation);

  const decisions = await db
    .select({
      decision: kgPolicyDecisions.decision,
      unsatisfied: kgPolicyDecisions.unsatisfiedRequirements,
    })
    .from(kgPolicyDecisions)
    .where(
      and(
        eq(kgPolicyDecisions.spaceId, spaceRow.id),
        eq(kgPolicyDecisions.evaluationMode, 'shadow'),
      ),
    );

  const holdReasons: string[] = [];
  for (const row of decisions) {
    if (row.decision !== 'hold') continue;
    const unmet = Array.isArray(row.unsatisfied) ? row.unsatisfied : [];
    for (const item of unmet) {
      const id = (item as { requirementId?: unknown }).requirementId;
      if (typeof id === 'string') holdReasons.push(id);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    space,
    forceLegacy: forceLegacyEnabled(),
    modes,
    mirror: {
      attempted,
      succeeded,
      failed,
      // Null rather than 1: "nothing has been mirrored" and "everything
      // mirrored successfully" are different states, and a rate of 1 for an
      // empty denominator reports the second when the first is true.
      successRate: attempted === 0 ? null : succeeded / attempted,
    },
    reconciliation: {
      unresolved: report.divergences.length,
      byKind: countBy(report.divergences.map((d) => d.kind)),
      complete: report.complete,
    },
    policy: {
      shadowDecisions: decisions.length,
      holds: decisions.filter((d) => d.decision === 'hold').length,
      applies: decisions.filter((d) => d.decision === 'apply').length,
      holdsByReason: countBy(holdReasons),
    },
    fallbacks: {
      read: sumOf('kg_read_fallback_total'),
      publication: sumOf('kg_publication_fallback_total'),
      // Kept by reason, not just totalled: "it fell back 40 times" is not
      // actionable, and "40 times because nothing was mirrored" points
      // straight at the mirror.
      readByReason: metrics['kg_read_fallback_total'] ?? {},
      publicationByReason: metrics['kg_publication_fallback_total'] ?? {},
    },
    errorsByService: metrics['kg_mirror_failure_total'] ?? {},
    divergences,
    blocking: criticalDivergences(divergences),
  };
}

/** Render the report as text, for a CLI or a log. */
export function describeParityReport(report: ParityReport): string {
  const lines: string[] = [
    `knowledge-governance parity report — ${report.space} @ ${report.generatedAt}`,
    '',
    `force-legacy kill switch: ${report.forceLegacy ? 'ENGAGED' : 'off'}`,
  ];

  lines.push('', 'migration mode by target type:');
  if (report.modes.length === 0) {
    lines.push('  (none configured — every target is legacy_only)');
  }
  for (const mode of report.modes) {
    lines.push(`  ${mode.targetType.padEnd(32)} ${mode.mode}`);
  }

  const rate = report.mirror.successRate;
  lines.push(
    '',
    `mirror: ${report.mirror.succeeded}/${report.mirror.attempted} succeeded` +
      (rate === null ? ' (nothing attempted)' : ` (${(rate * 100).toFixed(1)}%)`),
    `fallbacks to legacy: ${report.fallbacks.read} read, ` +
      `${report.fallbacks.publication} publication`,
  );

  for (const [label, counts] of [
    ['read', report.fallbacks.readByReason],
    ['publication', report.fallbacks.publicationByReason],
  ] as const) {
    for (const [reason, count] of Object.entries(counts)) {
      if (count > 0) lines.push(`  ${label}/${reason.padEnd(26)} ${count}`);
    }
  }

  lines.push('', `unresolved reconciliation items: ${report.reconciliation.unresolved}`);
  for (const [kind, count] of Object.entries(report.reconciliation.byKind)) {
    if (count > 0) lines.push(`  ${kind.padEnd(24)} ${count}`);
  }

  lines.push(
    '',
    `shadow policy decisions: ${report.policy.shadowDecisions} ` +
      `(${report.policy.applies} apply, ${report.policy.holds} hold)`,
  );
  for (const [reason, count] of Object.entries(report.policy.holdsByReason)) {
    lines.push(`  ${reason.padEnd(40)} ${count}`);
  }

  const errors = Object.entries(report.errorsByService).filter(([, n]) => n > 0);
  if (errors.length > 0) {
    lines.push('', 'generic errors by service:');
    for (const [service, count] of errors) {
      lines.push(`  ${service.padEnd(32)} ${count}`);
    }
  }

  lines.push('');
  if (report.blocking.length === 0) {
    lines.push('no cutover-blocking divergences (§17.2)');
  } else {
    lines.push(`CUTOVER BLOCKED — ${report.blocking.length} critical divergence(s):`);
    for (const item of report.blocking) {
      lines.push(
        `  [${item.category}] ${item.targetType}#${item.legacySubjectId}: ` +
          `${item.detail ?? item.criticalReason ?? 'critical'}`,
      );
    }
  }

  // Deliberately no summary score. A system with perfect queue parity and one
  // permissive policy divergence is not 90% healthy; it is blocked.
  return lines.join('\n');
}

/** Shadow decision counts per target type, for an operator watching a window fill. */
export async function shadowDecisionsByMode(
  db: GovernanceDb = getDb(),
): Promise<Record<string, number>> {
  const space = await ensureKinetixSpace(db);
  const rows = await db
    .select({
      mode: kgPolicyDecisions.evaluationMode,
      total: sql<number>`count(*)::int`,
    })
    .from(kgPolicyDecisions)
    .where(eq(kgPolicyDecisions.spaceId, space.id))
    .groupBy(kgPolicyDecisions.evaluationMode);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.mode] = row.total;
  return out;
}
