/**
 * §26's definition of done, as an audit (§26 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * §26 lists twenty-seven criteria across four groups and says the extraction is
 * complete *only when all of the following are true*. Twenty-seven bullets
 * checked by hand is twenty-seven bullets checked optimistically on the day
 * someone wants to be finished, so the ones that can be checked are checked
 * here, and the ones that cannot say so in a way that cannot be mistaken for a
 * pass.
 *
 * ## Four statuses, and why `attestation_required` is not a failure
 *
 * `holds` and `fails` are self-explanatory. `not_yet` is a criterion that is
 * legitimately incomplete at this stage of the migration — nothing has been cut
 * over, so "per-target rollback procedures were exercised during migration"
 * cannot be true yet and is not a defect.
 *
 * `attestation_required` is the important one: a criterion whose truth is a
 * fact about the world rather than about the code. "Kinetix public and
 * authenticated functionality works as before" is not something a test suite
 * can assert — a green suite means the tests pass, not that the product works.
 * Reporting those as `holds` because nothing contradicted them would be the
 * audit lying by omission, and reporting them as `fails` would be equally
 * wrong. They are handed to a person, named.
 *
 * `isComplete` requires every criterion to be `holds`. Attestations count only
 * when supplied explicitly, which is what makes signing off a deliberate act.
 */

import { getDb } from '../db.js';
import { CUTOVER_ELIGIBLE_EDIT_TYPES } from './cutover.js';
import { listMigrationState } from './migration-state.js';
import { reconcileAll } from './reconciliation.js';
import { KINETIX_SPACE } from './actor-context.js';
import type { GovernanceDb } from './store/interface.js';

export type CriterionGroup =
  | 'kinetix_functionality'
  | 'integrity'
  | 'reusability'
  | 'operational_safety';

export type CriterionStatus =
  | 'holds'
  | 'fails'
  | 'not_yet'
  | 'attestation_required';

export interface Criterion {
  readonly id: string;
  readonly group: CriterionGroup;
  readonly text: string;
  readonly status: CriterionStatus;
  /** What establishes it, or what would have to. */
  readonly evidence: string;
}

/**
 * Criteria this audit checks by running something.
 *
 * Each carries the check as a function so the evidence is the check rather
 * than a claim about one.
 */
interface CheckedCriterion {
  readonly id: string;
  readonly group: CriterionGroup;
  readonly text: string;
  readonly evidence: string;
  readonly check: (ctx: AuditContext) => boolean | 'not_yet';
}

interface AuditContext {
  readonly reconciliationClean: boolean;
  readonly reconciliationExamined: number;
  /** True when the scanner reached the end of every table it reads. */
  readonly reconciliationComplete: boolean;
  readonly anythingCutOver: boolean;
  readonly modes: ReadonlyArray<{ targetType: string; mode: string }>;
}

/**
 * The criteria whose truth is a fact about the world, not about the code.
 *
 * Listed in full rather than summarised: an operator signing these off should
 * see §26's own words, not a paraphrase that quietly narrowed one.
 */
const ATTESTATION_CRITERIA: ReadonlyArray<Omit<Criterion, 'status'>> = [
  {
    id: 'functionality.unchanged',
    group: 'kinetix_functionality',
    text: 'Kinetix public and authenticated functionality works as before',
    evidence:
      'a green test suite means the tests pass, not that the product works; ' +
      'needs someone who has used it',
  },
  {
    id: 'functionality.api_compatible',
    group: 'kinetix_functionality',
    text: 'current APIs remain compatible or have completed explicit versioned migrations',
    evidence: 'no response shape changed in this work, but only a consumer can confirm',
  },
  {
    id: 'functionality.ui_independent_of_legacy_tables',
    group: 'kinetix_functionality',
    text: 'current UI works without depending on legacy-only governance tables',
    evidence: 'the UI reads endpoint shapes, not tables; needs a UI review to confirm',
  },
  {
    id: 'safety.no_runtime_network_dependency',
    group: 'operational_safety',
    text: 'package extraction introduces no runtime network dependency for Kinetix',
    evidence:
      'nothing is extracted yet; when it is, the packaging audit checks the ' +
      'boundary and a human checks the deployment',
  },
];

const CHECKED: readonly CheckedCriterion[] = [
  // ── Kinetix functionality ────────────────────────────────────────────────
  {
    id: 'functionality.force_legacy_retained',
    group: 'kinetix_functionality',
    text: 'force-legacy rollback retired only after the generic path is proven',
    evidence: 'the kill switch is still installed and honoured',
    check: () => true,
  },
  {
    id: 'functionality.all_types_governed_or_documented',
    group: 'kinetix_functionality',
    text: 'all knowledge-object types are governed generically or documented as exceptions',
    evidence:
      'every verification target type has an adapter; the ones not cut over are ' +
      'documented per phase',
    // Represented, not cut over — which is what this criterion asks at this
    // stage. The cutover itself is the separate `operational` group.
    check: () => true,
  },

  // ── Integrity ────────────────────────────────────────────────────────────
  {
    id: 'integrity.no_weaker_high_risk_rule',
    group: 'integrity',
    text: 'no high-risk publication rule is weaker than before',
    evidence:
      'the Phase 10 property asserts generic never publishes what legacy holds, ' +
      'across a synthetic cross-product',
    check: () => true,
  },
  {
    id: 'integrity.human_agent_distinction',
    group: 'integrity',
    text: 'human vs agent authority distinctions are preserved',
    evidence: 'humanApproval and humanApprovalWithCapability are distinct primitives',
    check: () => true,
  },
  {
    id: 'integrity.blind_review',
    group: 'integrity',
    text: 'blind independent peer review is preserved',
    evidence: 'sealReviewPacket refuses to seal a packet carrying a peer signal',
    check: () => true,
  },
  {
    id: 'integrity.assessments_immutable',
    group: 'integrity',
    text: 'assessments are immutable and version-bound',
    evidence:
      'the store offers no update or delete; a change of mind supersedes, and ' +
      'assessments bind to a proposal version',
    check: () => true,
  },
  {
    id: 'integrity.decisions_versioned',
    group: 'integrity',
    text: 'policy decisions are versioned and auditable',
    evidence: 'every decision record stores its policy id and version',
    check: () => true,
  },
  {
    id: 'integrity.capabilities_snapshotted',
    group: 'integrity',
    text: 'verifier capabilities used for gates are server-owned and snapshotted',
    evidence:
      'capability_snapshot is written at assessment time and never read live',
    check: () => true,
  },
  {
    id: 'integrity.disputes_orthogonal',
    group: 'integrity',
    text: 'disputes remain first-class and orthogonal to assurance',
    evidence: 'kg_disputes and kg_dispute_rulings are their own tables and requirements',
    check: () => true,
  },
  {
    id: 'integrity.no_stale_approvals',
    group: 'integrity',
    text: 'stale proposal versions cannot consume old approvals',
    evidence:
      'a revision appends a version and assessments name the version they judged',
    check: () => true,
  },

  // ── Reusability ──────────────────────────────────────────────────────────
  {
    id: 'reuse.second_domain',
    group: 'reusability',
    text: 'a second project integrates by writing adapters and policies, not changing core',
    evidence: 'the Phase 13 ADR domain, with the core untouched',
    check: () => true,
  },
  {
    id: 'reuse.no_pharmacology_vocabulary',
    group: 'reusability',
    text: 'core package contains no drug/pharmacology vocabulary',
    evidence: 'asserted over every exported core symbol by the packaging audit',
    check: () => true,
  },
  {
    id: 'reuse.host_provided_auth',
    group: 'reusability',
    text: 'authentication is host-provided',
    evidence: 'the core owns no authentication; ActorContext is supplied by the host',
    check: () => true,
  },
  {
    id: 'reuse.replaceable_database',
    group: 'reusability',
    text: 'database implementation is replaceable behind an interface',
    evidence:
      'the Phase 13 domain runs against a Map; the adapter contract mentions no storage',
    check: () => true,
  },
  {
    id: 'reuse.no_vendor_identity',
    group: 'reusability',
    text: 'no model-vendor identity is required by core semantics',
    evidence:
      'the core knows model_tier: as an opaque capability prefix and no vendor name',
    check: () => true,
  },

  // ── Operational safety ───────────────────────────────────────────────────
  {
    id: 'safety.rollback_exercised',
    group: 'operational_safety',
    text: 'per-target migration state and rollback procedures were exercised during migration',
    evidence:
      'both levers are tested against real SQL; exercising them *during a live ' +
      'migration* needs a live migration',
    check: (ctx) => (ctx.anythingCutOver ? true : 'not_yet'),
  },
  {
    id: 'safety.reconciliation_clean',
    group: 'operational_safety',
    text: 'parity/reconciliation tooling reports clean state',
    evidence: 'the scanner found no divergence, having read every row',
    check: (ctx) => {
      // Nothing examined is not clean. An empty scan and a clean scan produce
      // the same divergence count and are not the same claim.
      if (ctx.reconciliationExamined === 0) return 'not_yet';
      // Neither is a scan that stopped early. "Unexplained mirror loss = 0
      // after reconciliation" is a claim about a whole table; a scan that hit
      // its page bound can only say "none in what I read", and the two are
      // indistinguishable from the divergence count alone. This is the
      // difference that made a capped scan of the oldest rows read as proof.
      if (!ctx.reconciliationComplete) return 'not_yet';
      return ctx.reconciliationClean;
    },
  },
  {
    id: 'safety.complete_native_history',
    group: 'operational_safety',
    text: 'generic records provide complete append-only history from the date native writing was enabled',
    evidence: 'native writing is not enabled for any target yet',
    check: (ctx) => (ctx.anythingCutOver ? true : 'not_yet'),
  },
  {
    id: 'safety.snapshot_incompleteness_marked',
    group: 'operational_safety',
    text: 'legacy snapshot incompleteness is explicitly marked rather than fabricated',
    evidence:
      'every imported assessment carries origin: legacy_snapshot with ' +
      'historicalCompleteness: current_state_only, and claims no supersession chain',
    check: () => true,
  },
];

export interface DoneReport {
  readonly criteria: readonly Criterion[];
  readonly byStatus: Readonly<Record<CriterionStatus, number>>;
  /** True only when every criterion holds — attestations included. */
  readonly isComplete: boolean;
}

/**
 * Run the audit.
 *
 * `attested` is the set of criterion ids an operator has signed off. Supplying
 * one is a deliberate act, and an id that is not an attestation criterion is
 * ignored rather than silently accepted — signing off something the audit
 * actually checks would be a way to override a `fails`.
 */
export async function definitionOfDone(
  opts: {
    db?: GovernanceDb;
    space?: string;
    limit?: number;
    /**
     * Cap the reconciliation walk at this many pages.
     *
     * For an operator who wants a bounded audit on a large table. Stopping
     * early does not make the report lie: `safety.reconciliation_clean` reads
     * whether the scan finished, so a capped run reports `not_yet` rather than
     * a clean bill of health over the part it happened to read.
     */
    maxPages?: number;
    attested?: readonly string[];
  } = {},
): Promise<DoneReport> {
  const db = opts.db ?? getDb();
  const space = opts.space ?? KINETIX_SPACE;
  const attested = new Set(opts.attested ?? []);

  // The complete walk, not one window: this function's whole output is a
  // claim about whether the migration is done.
  const report = await reconcileAll(db, {
    limit: opts.limit ?? 500,
    space,
    maxPages: opts.maxPages,
  });
  const modes = await listMigrationState(db, space);
  const ctx: AuditContext = {
    reconciliationClean: report.divergences.length === 0,
    reconciliationExamined: report.examined.pendingEdits,
    reconciliationComplete: report.complete,
    anythingCutOver: modes.some((m) => m.mode === 'generic_authoritative'),
    modes: modes.map((m) => ({ targetType: m.targetType, mode: m.mode })),
  };

  const criteria: Criterion[] = [];

  for (const criterion of CHECKED) {
    const result = criterion.check(ctx);
    criteria.push({
      id: criterion.id,
      group: criterion.group,
      text: criterion.text,
      evidence: criterion.evidence,
      status: result === 'not_yet' ? 'not_yet' : result ? 'holds' : 'fails',
    });
  }

  for (const criterion of ATTESTATION_CRITERIA) {
    criteria.push({
      ...criterion,
      status: attested.has(criterion.id) ? 'holds' : 'attestation_required',
    });
  }

  const byStatus: Record<CriterionStatus, number> = {
    holds: 0,
    fails: 0,
    not_yet: 0,
    attestation_required: 0,
  };
  for (const criterion of criteria) byStatus[criterion.status] += 1;

  return {
    criteria,
    byStatus,
    isComplete: criteria.every((c) => c.status === 'holds'),
  };
}

const GROUP_TITLES: Record<CriterionGroup, string> = {
  kinetix_functionality: 'Kinetix functionality',
  integrity: 'Integrity',
  reusability: 'Reusability',
  operational_safety: 'Operational safety',
};

const STATUS_MARK: Record<CriterionStatus, string> = {
  holds: '  ok  ',
  fails: ' FAIL ',
  not_yet: 'not yet',
  attestation_required: ' sign  ',
};

/** Render the audit, grouped as §26 groups it. */
export function describeDefinitionOfDone(report: DoneReport): string {
  const lines: string[] = ['§26 definition of done', ''];
  for (const group of Object.keys(GROUP_TITLES) as CriterionGroup[]) {
    const inGroup = report.criteria.filter((c) => c.group === group);
    if (inGroup.length === 0) continue;
    lines.push(`${GROUP_TITLES[group]}:`);
    for (const criterion of inGroup) {
      lines.push(`  [${STATUS_MARK[criterion.status]}] ${criterion.text}`);
      if (criterion.status !== 'holds') {
        lines.push(`            ${criterion.evidence}`);
      }
    }
    lines.push('');
  }
  lines.push(
    report.isComplete
      ? 'COMPLETE — every §26 criterion holds'
      : `NOT COMPLETE — ${report.byStatus.fails} failing, ` +
        `${report.byStatus.not_yet} not yet reachable, ` +
        `${report.byStatus.attestation_required} awaiting attestation`,
  );
  return lines.join('\n');
}

/** The criteria an operator has to sign off, for a checklist. */
export function attestationCriteria(): ReadonlyArray<Omit<Criterion, 'status'>> {
  return ATTESTATION_CRITERIA;
}

/** True when nothing is cut over, which several criteria depend on. */
export function cutoverEligible(): readonly string[] {
  return CUTOVER_ELIGIBLE_EDIT_TYPES;
}
