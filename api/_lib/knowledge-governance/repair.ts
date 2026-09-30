/**
 * Level 4 data repair (§22 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * §22's rollback playbook has four levels. Three of them existed: retreat the
 * migration state, engage the kill switch, revert the commit. The fourth did
 * not:
 *
 *   > **Level 4: data repair.** Use `kg_legacy_links` and reconciliation
 *   > tooling to rebuild generic mirrors from legacy state.
 *   >
 *   > Do not delete generic history as part of rollback. Mark erroneous generic
 *   > records superseded/invalid where necessary.
 *
 * The reconciliation scanner *detects* divergence and has since Phase 4.
 * Nothing repaired it. This closes that.
 *
 * ## The rule that shapes the whole module
 *
 * **Nothing here deletes.** §22 says so outright, and the reason is stronger
 * than the instruction: the generic tables are an append-only audit, and a
 * repair path that could delete would be a repair path someone could use to
 * remove an inconvenient assessment. So the only operations available are
 * *re-mirroring what is missing* and *recording an audit event about what
 * cannot be repaired*.
 *
 * That means repair is deliberately incomplete by design, and says which
 * findings it cannot address rather than pretending to have fixed them:
 *
 *   - `missing_proposal` and `missing_assessment` — repairable. Legacy is the
 *     source of truth during the migration, so the mirror is rebuilt from it.
 *   - `orphaned_proposal` — **not** repairable. The legacy row is gone and the
 *     generic proposal outlives it, which is the correct outcome: an immutable
 *     record of a review that happened does not stop having happened because
 *     someone deleted the row it mirrored.
 *   - `fingerprint_mismatch` and `state_mismatch` — **not** repairable here.
 *     Both mean the mirror and legacy disagree about content or state, and
 *     re-mirroring would overwrite the generic side with the legacy one without
 *     anyone deciding that was right. They are reported for a human.
 *   - `missing_publication` — not repairable: a publication event is a
 *     statement that something was published *by this engine*, and
 *     manufacturing one after the fact would be inventing history.
 */

import { getDb } from '../db.js';
import { KINETIX_SPACE } from './actor-context.js';
import { ensureKinetixSpace } from './backfill.js';
import { mirrorAssessment, mirrorProposalVersion } from './mirror.js';
import { reconcile, type Divergence, type DivergenceClass } from './reconciliation.js';
import { recordAuditEvent } from './store/audit.js';
import type { GovernanceDb } from './store/interface.js';

/** Divergence classes this module can rebuild from legacy state. */
export const REPAIRABLE: readonly DivergenceClass[] = [
  'missing_proposal',
  'missing_assessment',
];

/**
 * Why a finding was left alone. Reported rather than silently skipped, because
 * "repair ran and there are still findings" needs to distinguish "it failed"
 * from "it was never going to touch that".
 */
export type UnrepairableReason =
  | 'legacy_row_gone'
  | 'needs_human_decision'
  | 'would_invent_history';

export const UNREPAIRABLE: Readonly<Record<string, UnrepairableReason>> = {
  orphaned_proposal: 'legacy_row_gone',
  fingerprint_mismatch: 'needs_human_decision',
  state_mismatch: 'needs_human_decision',
  missing_publication: 'would_invent_history',
};

export interface RepairOutcome {
  readonly finding: Divergence;
  readonly repaired: boolean;
  /** Set when `repaired` is false. */
  readonly reason?: UnrepairableReason | 'mirror_failed';
  readonly detail?: string;
}

export interface RepairReport {
  readonly examined: number;
  readonly repaired: number;
  readonly outcomes: readonly RepairOutcome[];
  /** Findings this module will never address, grouped by why. */
  readonly unrepairable: Readonly<Record<UnrepairableReason, number>>;
  readonly dryRun: boolean;
  /**
   * True when the scan behind this repair reached the end of the tables.
   *
   * Repair is deliberately bounded — an incident responder fixes a batch and
   * looks again — so `false` is a normal outcome here rather than a fault. It
   * is reported because "0 remaining" after a partial scan is not the same
   * statement as "0 remaining", and an operator deciding whether they are done
   * needs to know which one they are holding.
   */
  readonly scanComplete: boolean;
}

/**
 * Rebuild what can be rebuilt.
 *
 * `dryRun` defaults to **true**. A repair tool that writes by default is one
 * someone runs to "have a look" and then has to explain — and the whole point
 * of Level 4 is that it is used in the middle of an incident, by someone who is
 * already having a bad day.
 */
export async function repairMirrors(
  opts: {
    db?: GovernanceDb;
    space?: string;
    limit?: number;
    dryRun?: boolean;
    /** Restrict to one legacy target type. */
    targetType?: string;
  } = {},
): Promise<RepairReport> {
  const db = opts.db ?? getDb();
  const dryRun = opts.dryRun ?? true;
  // Bounded on purpose: repair acts, and an unbounded write loop during an
  // incident is how a bad hour becomes a bad week. The bound is reported.
  const report = await reconcile(db, { limit: opts.limit ?? 500 });

  const findings = opts.targetType
    ? report.divergences.filter((d) => d.targetType === opts.targetType)
    : report.divergences;

  const outcomes: RepairOutcome[] = [];
  const unrepairable: Record<UnrepairableReason, number> = {
    legacy_row_gone: 0,
    needs_human_decision: 0,
    would_invent_history: 0,
  };

  for (const finding of findings) {
    const blocked = UNREPAIRABLE[finding.kind];
    if (blocked) {
      unrepairable[blocked] += 1;
      outcomes.push({ finding, repaired: false, reason: blocked });
      continue;
    }
    if (!REPAIRABLE.includes(finding.kind)) {
      // A divergence class added later, with no repair rule written for it.
      // Reported rather than assumed harmless: the safe default for an unknown
      // finding is to leave it and say so.
      outcomes.push({
        finding,
        repaired: false,
        reason: 'needs_human_decision',
        detail: `no repair rule for '${finding.kind}'`,
      });
      unrepairable.needs_human_decision += 1;
      continue;
    }
    if (dryRun) {
      outcomes.push({ finding, repaired: false, detail: 'dry run' });
      continue;
    }
    outcomes.push(await repairOne(db, finding));
  }

  const repaired = outcomes.filter((o) => o.repaired).length;
  if (!dryRun && repaired > 0) {
    const space = await ensureKinetixSpace(db);
    await recordAuditEvent(db, {
      spaceId: space.id,
      eventType: 'mirror_repair_run',
      subjectType: 'space',
      subjectId: space.id,
      payload: {
        examined: findings.length,
        repaired,
        unrepairable,
        targetType: opts.targetType ?? null,
      },
    }).catch(() => {
      // Best-effort: a repair that worked must not be reported as failed
      // because its audit line did not land.
    });
  }

  return {
    examined: findings.length,
    repaired,
    outcomes,
    unrepairable,
    dryRun,
    scanComplete: !report.truncated,
  };
}

/**
 * Re-mirror one finding.
 *
 * Delegates to the same mirror functions the live seams use rather than
 * writing rows directly. A repair path with its own inserts is a second writer
 * that can drift from the first, and the divergence it would then produce is
 * exactly what it exists to fix.
 */
async function repairOne(
  db: GovernanceDb,
  finding: Divergence,
): Promise<RepairOutcome> {
  if (finding.legacyId === undefined) {
    return {
      finding,
      repaired: false,
      reason: 'needs_human_decision',
      detail: 'finding names no legacy row to rebuild from',
    };
  }

  if (finding.kind === 'missing_proposal') {
    const outcome = await mirrorProposalVersion({
      targetType: finding.targetType,
      targetId: finding.legacyId,
      legacyPendingEditId:
        finding.targetType === 'pending_edit' ? finding.legacyId : null,
    });
    return outcome.mirrored
      ? { finding, repaired: true }
      : {
          finding,
          repaired: false,
          reason: 'mirror_failed',
          detail: outcome.error ?? outcome.skipped ?? 'mirror declined',
        };
  }

  // missing_assessment: the finding names the verdict row; everything the
  // mirror needs comes from it.
  const verdict = await legacyVerdict(db, finding.legacyId);
  if (!verdict) {
    return {
      finding,
      repaired: false,
      reason: 'legacy_row_gone',
      detail: `agent_verification ${finding.legacyId} no longer exists`,
    };
  }
  const outcome = await mirrorAssessment({
    targetType: verdict.targetType,
    targetId: verdict.targetId,
    legacyVerificationId: verdict.id,
    actorRef: `user:${verdict.agentUserId}`,
    verdict: verdict.verdict,
    rationaleMd: verdict.rationaleMd,
    model: verdict.model,
    isImplicit: verdict.isImplicit,
  });
  return outcome.mirrored
    ? { finding, repaired: true }
    : {
        finding,
        repaired: false,
        reason: 'mirror_failed',
        detail: outcome.error ?? outcome.skipped ?? 'mirror declined',
      };
}

async function legacyVerdict(db: GovernanceDb, id: number) {
  const { agentVerifications, agents } = await import('../../../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [row] = await db
    .select({
      id: agentVerifications.id,
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
      verdict: agentVerifications.verdict,
      rationaleMd: agentVerifications.rationaleMd,
      model: agentVerifications.model,
      isImplicit: agentVerifications.isImplicit,
      agentUserId: agents.userId,
    })
    .from(agentVerifications)
    .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(eq(agentVerifications.id, id))
    .limit(1);
  return row
    ? { ...row, verdict: row.verdict as 'approve' | 'dispute' | 'abstain' }
    : null;
}

/** One-line summary, for an operator running this during an incident. */
export function describeRepair(report: RepairReport): string {
  const lines = [
    report.dryRun
      ? `mirror repair (DRY RUN) — ${report.examined} finding(s) examined`
      : `mirror repair — ${report.repaired}/${report.examined} rebuilt`,
  ];
  for (const [reason, count] of Object.entries(report.unrepairable)) {
    if (count > 0) lines.push(`  ${count} left alone: ${reason}`);
  }
  if (report.dryRun && report.examined > 0) {
    lines.push('  re-run with dryRun: false to rebuild');
  }
  // Reported on every summary, not only when it is false. `scanComplete` is the
  // difference between "there is nothing left" and "there is nothing left in
  // the window I looked at", and an operator who cannot see which one they are
  // holding will read the first from a line that meant the second.
  lines.push(
    report.scanComplete
      ? '  scan complete: yes — the scan behind this repair reached the end of the tables'
      : '  scan complete: NO — bounded scan; remaining counts are a floor, re-run to continue',
  );
  return lines.join('\n');
}

export { KINETIX_SPACE };
