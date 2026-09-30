/**
 * The migration dossier (Phase 9 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 9 is "repeat Phase 8 one target at a time", and for each target type it
 * requires a dossier: legacy contract tests, adapter tests, queue parity,
 * policy parity, mirror/reconciliation reports, known edge cases, a rollback
 * procedure, and approval to advance. It also says, in as many words, not to
 * bundle unrelated cutovers into one PR.
 *
 * So this module is not a cutover. It is the thing each cutover PR runs to
 * produce its evidence, and — more importantly — the thing that says **no**.
 * Four of those eight dossier items are machine-checkable from live state, and
 * a checklist a human fills in by hand is a checklist that gets filled in by
 * hand on the day someone is in a hurry.
 *
 * ## What it refuses on
 *
 * `assessReadiness` returns `ready: false` for any of:
 *
 *   - a **severity-1 policy divergence** — the generic engine would publish
 *     something the legacy gate holds. §1.7 permits this migration to tighten
 *     Kinetix and never to relax it, so one of these is disqualifying on its
 *     own, no matter how many clean rows sit beside it.
 *   - **any reconciliation divergence** for the target — the mirror and the
 *     legacy tables disagree, so the evidence the rest of the dossier rests on
 *     is not trustworthy.
 *   - **incomplete mirror coverage** — a target type where some rows were never
 *     mirrored cannot be judged from the rows that were. That is survivorship
 *     bias with a publication decision on the end of it.
 *   - **no observations at all** — a target type nothing has exercised has not
 *     been shown to be safe; it has been shown to be untested. This is the case
 *     that would otherwise read as a clean sweep.
 *
 * The last one is why `observed` is reported separately from `divergences`.
 * Zero divergences out of zero observations and zero out of four hundred are
 * the same number and not the same evidence.
 *
 * Nothing here writes. It reads live state and reports; advancing the state
 * remains a deliberate admin action (§11.4).
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { pendingEdits } from '../../../db/schema.js';
import { CUTOVER_ELIGIBLE_EDIT_TYPES, applyAuthorityKey } from './cutover.js';
import { resolveMigrationMode } from './migration-state.js';
import {
  classifyDivergence,
  collectConsensusFacts,
  evaluateShadowPolicy,
  type DivergenceSeverity,
} from './policy-shadow.js';
import { reconcileAll, type Divergence } from './reconciliation.js';
import { findByLegacy } from './store/legacy-links.js';
import type { GovernanceDb } from './store/interface.js';
import type { KgMigrationMode } from '../../../db/schema.js';

/** One pending edit's policy comparison, as the dossier records it. */
export interface PolicyObservation {
  readonly pendingEditId: number;
  readonly severity: DivergenceSeverity;
  readonly legacyOutcome: 'apply' | 'hold';
  readonly genericOutcome: 'apply' | 'hold';
  readonly reasons: readonly string[];
}

export interface MirrorCoverage {
  readonly rows: number;
  readonly mirrored: number;
  /** `rows === 0` reports 1: nothing is missing, and nothing is proven either. */
  readonly ratio: number;
}

export interface MigrationDossier {
  readonly editType: string;
  readonly authorityKey: string;
  readonly currentMode: KgMigrationMode;
  readonly eligible: boolean;
  readonly coverage: MirrorCoverage;
  readonly policy: {
    readonly observed: number;
    readonly severity1: readonly PolicyObservation[];
    readonly conservative: readonly PolicyObservation[];
  };
  readonly reconciliation: {
    readonly divergences: readonly Divergence[];
    readonly examined: number;
    /** True when the scanner read every row, not just its first page. */
    readonly complete: boolean;
  };
}

export interface ReadinessVerdict {
  readonly ready: boolean;
  /** Every reason it is not ready, so one pass fixes all of them. */
  readonly blockers: readonly string[];
  readonly dossier: MigrationDossier;
}

/**
 * The legacy gate's own answer for one pending edit, derived from the same
 * facts the generic engine saw.
 *
 * Deliberately re-derived from `ConsensusFacts` rather than by calling
 * `applyOnAgentConsensus`: that function *applies*, and a dossier that
 * published rows in order to report on them would be worse than no dossier.
 */
function legacyOutcomeFromFacts(
  facts: Awaited<ReturnType<typeof collectConsensusFacts>>,
): 'apply' | 'hold' {
  if (!facts) return 'hold';
  if (facts.editType === 'clinical_case') return 'hold';
  if (!facts.submitterIsAgent) return 'hold';
  if (facts.hasOpenHumanDispute) return 'hold';
  if (facts.summary.disputeCount > 0) return 'hold';
  if (facts.summary.approveCount < facts.quorum) return 'hold';
  if (facts.highRisk) {
    if (facts.summary.approveCount < 2) return 'hold';
    if ((facts.summary.approveTier2Count ?? 0) < 1) return 'hold';
  }
  // The payload precondition: a calculation-driving value nobody quoted does
  // not publish unattended, whatever the tally says. Modelled here for the same
  // reason every other legacy refusal is — this function IS the legacy gate as
  // far as the dossier is concerned, and a precondition it does not know about
  // is one the cutover comparison silently forgives.
  if (facts.lacksSourceQuote) return 'hold';
  return 'apply';
}

/** Gather the machine-checkable half of a target type's dossier. */
export async function buildDossier(
  editType: string,
  opts: { db?: GovernanceDb; limit?: number; maxPages?: number } = {},
): Promise<MigrationDossier> {
  const db = opts.db ?? getDb();
  const limit = opts.limit ?? 500;

  const [currentMode, rows] = await Promise.all([
    resolveMigrationMode(applyAuthorityKey(editType), { db }),
    db
      .select({ id: pendingEdits.id, status: pendingEdits.status })
      .from(pendingEdits)
      .where(eq(pendingEdits.editType, editType))
      .limit(limit),
  ]);

  let mirrored = 0;
  const policyObservations: PolicyObservation[] = [];
  for (const row of rows) {
    if (await findByLegacy(db, 'pending_edit', row.id)) mirrored += 1;
    // Only rows still open are comparable: a decided edit's legacy outcome is
    // history, and re-deriving it from today's tally would compare the engine
    // against a gate that already ran under different facts.
    if (row.status !== 'pending') continue;
    const facts = await collectConsensusFacts(row.id);
    if (!facts) continue;
    const evaluation = evaluateShadowPolicy(facts);
    const divergence = classifyDivergence({
      legacyOutcome: legacyOutcomeFromFacts(facts),
      evaluation,
    });
    policyObservations.push({
      pendingEditId: row.id,
      severity: divergence.severity,
      legacyOutcome: divergence.legacyOutcome,
      genericOutcome: divergence.genericOutcome,
      reasons: divergence.reasons,
    });
  }

  // The complete walk. A dossier is the evidence an operator advances a target
  // on, and a single window cannot support "no divergences" — it can only say
  // "none in the oldest `limit` rows", which is a different and much weaker
  // claim that reads identically.
  const report = await reconcileAll(db, { limit, maxPages: opts.maxPages });
  const relevant = report.divergences.filter((d) => d.targetType === 'pending_edit');

  return {
    editType,
    authorityKey: applyAuthorityKey(editType),
    currentMode,
    eligible: CUTOVER_ELIGIBLE_EDIT_TYPES.includes(editType),
    coverage: {
      rows: rows.length,
      mirrored,
      ratio: rows.length === 0 ? 1 : mirrored / rows.length,
    },
    policy: {
      observed: policyObservations.length,
      severity1: policyObservations.filter((o) => o.severity === 'severity_1'),
      conservative: policyObservations.filter((o) => o.severity === 'conservative'),
    },
    reconciliation: {
      divergences: relevant,
      examined: report.examined.pendingEdits,
      complete: report.complete,
    },
  };
}

/**
 * Whether this target type may be advanced to `generic_authoritative`.
 *
 * Advisory by construction: it reads and reports, and the advance itself stays
 * a deliberate admin action (§11.4). What it removes is the possibility of
 * making that decision without having looked.
 */
export async function assessReadiness(
  editType: string,
  opts: { db?: GovernanceDb; limit?: number; maxPages?: number } = {},
): Promise<ReadinessVerdict> {
  const dossier = await buildDossier(editType, opts);
  const blockers = readinessBlockers(dossier);
  return { ready: blockers.length === 0, blockers, dossier };
}

/**
 * The blocking reasons a dossier carries, as a pure function of the dossier.
 *
 * Split out from `assessReadiness` so the rules can be exercised against a
 * constructed dossier rather than one a database happened to produce. Several
 * of them describe states that are hard to reach on purpose — a truncated
 * reconciliation scan needs a table larger than the page bound — and a rule
 * that can only be tested by first building the world it describes tends not
 * to be tested at all.
 */
export function readinessBlockers(dossier: MigrationDossier): string[] {
  const blockers: string[] = [];

  if (!dossier.eligible) {
    blockers.push(
      `'${dossier.editType}' is not in CUTOVER_ELIGIBLE_EDIT_TYPES; advancing it needs a reviewed code change`,
    );
  }
  if (dossier.policy.severity1.length > 0) {
    blockers.push(
      `${dossier.policy.severity1.length} severity-1 policy divergence(s): the generic engine would ` +
        'publish what the legacy gate holds, which §1.7 forbids in this direction',
    );
  }
  if (dossier.reconciliation.divergences.length > 0) {
    blockers.push(
      `${dossier.reconciliation.divergences.length} unresolved reconciliation divergence(s); the ` +
        'mirror and the legacy tables disagree, so the rest of this dossier is not trustworthy',
    );
  }
  if (!dossier.reconciliation.complete) {
    // A clean-but-truncated scan is the most dangerous state this dossier can
    // be in: it looks exactly like a clean complete one, and it is the state a
    // growing table reaches on its own without anyone changing anything.
    blockers.push(
      'the reconciliation scan stopped before the end of the table; zero divergences over an ' +
        'unfinished scan is not evidence of zero divergences',
    );
  }
  if (dossier.coverage.ratio < 1) {
    blockers.push(
      `mirror coverage is ${dossier.coverage.mirrored}/${dossier.coverage.rows}; a target type ` +
        'cannot be judged from only the rows that happened to mirror',
    );
  }
  if (dossier.policy.observed === 0) {
    blockers.push(
      'no open rows of this type were observed; that is untested rather than safe',
    );
  }

  return blockers;
}

/** Human-readable dossier summary, for a PR body or an operator's terminal. */
export function describeDossier(verdict: ReadinessVerdict): string {
  const { dossier } = verdict;
  const lines = [
    `${dossier.editType} (${dossier.authorityKey}) — currently ${dossier.currentMode}`,
    `  eligible in this build: ${dossier.eligible ? 'yes' : 'no'}`,
    `  mirror coverage:        ${dossier.coverage.mirrored}/${dossier.coverage.rows}`,
    `  policy observations:    ${dossier.policy.observed} ` +
      `(${dossier.policy.severity1.length} severity-1, ${dossier.policy.conservative.length} conservative)`,
    `  reconciliation:         ${dossier.reconciliation.divergences.length} divergence(s) ` +
      `over ${dossier.reconciliation.examined} examined` +
      (dossier.reconciliation.complete ? '' : ' (SCAN INCOMPLETE)'),
    verdict.ready
      ? '  VERDICT: ready to advance'
      : '  VERDICT: not ready',
  ];
  for (const blocker of verdict.blockers) lines.push(`    - ${blocker}`);
  return lines.join('\n');
}

/** Dossiers for every edit type currently present in `pending_edits`. */
export async function surveyEditTypes(
  opts: { db?: GovernanceDb; limit?: number } = {},
): Promise<ReadinessVerdict[]> {
  const db = opts.db ?? getDb();
  const rows = await db
    .selectDistinct({ editType: pendingEdits.editType })
    .from(pendingEdits);
  const out: ReadinessVerdict[] = [];
  for (const row of rows.sort((a, b) => a.editType.localeCompare(b.editType))) {
    out.push(await assessReadiness(row.editType, { db, limit: opts.limit }));
  }
  return out;
}
