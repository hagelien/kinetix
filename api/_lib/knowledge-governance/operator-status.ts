/**
 * The operator's read-only view of the migration — Step A of
 * docs/plans/2026-09-05-assurance-transition-continuation.md §6.
 *
 * Step A says: before further authoritative work, run the migration/report
 * tooling against the intended environment and read the current modes, the
 * `wiki_fact` dossier, reconciliation, queue parity, policy parity, the
 * fallback counters and the §26 audit — and *do not use a dated plan document
 * as a substitute for these runtime facts*. Every one of those reports already
 * existed; what did not exist was one place that ran them together, so an
 * operator answering "where are we?" had to know seven module names and the
 * order to call them in. This module is that one place and nothing more: it
 * composes the existing reports and renders them. It computes no verdict of
 * its own — a second readiness rule beside `assessReadiness` would be a second
 * thing to keep honest.
 *
 * ## Strictly read-only
 *
 * Nothing here writes migration state, and nothing here can: this module does
 * not import `setMigrationMode`, and `tests/governance/observability/
 * operator-status.test.ts` asserts that stays true. Two of the reports it
 * composes (`parityReport`, `shadowDecisionsByMode`) *ensure* the Kinetix space
 * row before reading, which is an insert when the row is absent. Against an
 * environment where nothing has ever been mirrored that would be a diagnostic
 * leaving a footprint, so those two are skipped — reported as `null`, with the
 * reason — whenever the space row does not already exist. Where it does, the
 * ensure is an `ON CONFLICT DO NOTHING` no-op.
 *
 * ## Queue parity is per agent, and optional
 *
 * The queue comparison (`queue/compare.ts`) compares what the *route serves*
 * against the generic selector, and the route serves a batch to one agent at a
 * time, so there is no agent-free answer. When asked, this runs the real
 * legacy selection (`selectLegacyQueue`, the same function the handler calls)
 * for each requested agent and hands that batch to the comparator. It is not
 * run by default: it reads and hydrates a full served batch per agent, which
 * on a large backlog is the most expensive read this file can issue.
 *
 * ## The counters are per process
 *
 * The mirror/fallback/error counters in `metrics.ts` live in the process that
 * served the requests. A CLI is a fresh process and will always read them as
 * zero; that is reported as `counters: 'not_observable_from_this_process'`
 * rather than as zero fallbacks, because those are different claims.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { agents } from '../../../db/schema.js';
import { resolveActiveAgent } from '../agent-verifications.js';
import {
  ALL_TYPES as LEGACY_QUEUE_TYPES,
  MAX_LIMIT as LEGACY_QUEUE_MAX_LIMIT,
  selectLegacyQueue,
} from '../../agent-verifications-queue.js';
import { KINETIX_SPACE } from './actor-context.js';
import {
  CUTOVER_ELIGIBLE_EDIT_TYPES,
  applyAuthorityKey,
  resolveApplyAuthority,
  type ApplyAuthority,
} from './cutover.js';
import {
  definitionOfDone,
  describeDefinitionOfDone,
  type DoneReport,
} from './definition-of-done.js';
import {
  assessReadiness,
  describeDossier,
  surveyEditTypes,
  type ReadinessVerdict,
} from './dossier.js';
import {
  FORCE_LEGACY_ENV,
  forceLegacyEnabled,
  listMigrationState,
  resolveMigrationMode,
} from './migration-state.js';
import {
  compareQueues,
  describeComparison,
  type QueueComparison,
} from './queue/compare.js';
import { GENERIC_QUEUE_TYPES } from './queue/generic-queue.js';
import {
  describeParityReport,
  parityReport,
  shadowDecisionsByMode,
  type ParityReport,
} from './report.js';
import { findSpace } from './store/spaces.js';
import type { GovernanceDb } from './store/interface.js';
import type { KgMigrationMode } from '../../../db/schema.js';

export interface OperatorStatusOptions {
  readonly db?: GovernanceDb;
  /** The edit type whose dossier is built. Defaults to `wiki_fact`. */
  readonly editType?: string;
  /** Also build a dossier for every edit type present in `pending_edits`. */
  readonly survey?: boolean;
  /** Reconciliation page size. */
  readonly limit?: number;
  /** Cap on reconciliation pages; the reports say so when it truncates. */
  readonly maxPages?: number;
  /**
   * Agents to run the queue comparison for: explicit `agents.id`s, or `'all'`
   * for every active agent. Omitted means the comparison is not run.
   */
  readonly queueAgents?: readonly number[] | 'all';
  /**
   * Batch size to compare at. Clamped to the endpoint's own maximum: this
   * reports on what the route serves, and the route will not serve more than
   * that however large a number reaches it.
   */
  readonly queueLimit?: number;
  readonly queueMinAgeMinutes?: number;
  readonly now?: Date;
}

export interface QueueParityObservation {
  readonly agentId: number;
  readonly agentSlug: string;
  readonly agentUserId: number;
  readonly selfReviewEnabled: boolean;
  readonly legacyServed: number;
  readonly genericSelected: number;
  /** The batch size compared, after the endpoint's clamp. */
  readonly limit: number;
  readonly comparison: QueueComparison;
}

export interface OperatorStatus {
  readonly generatedAt: string;
  readonly space: string;
  /** False means nothing has ever been mirrored here: every mode is legacy_only. */
  readonly spaceExists: boolean;
  readonly forceLegacy: boolean;
  readonly eligibleEditTypes: readonly string[];
  /** `kg_migration_state` as stored. Absent rows are not listed. */
  readonly storedModes: ReadonlyArray<{
    targetType: string;
    mode: KgMigrationMode;
    updatedAt: string;
  }>;
  /**
   * What the runtime actually resolves for every key that matters, absent rows
   * and the kill switch included — this is the answer the request path gets.
   */
  readonly resolvedModes: ReadonlyArray<{ key: string; mode: KgMigrationMode }>;
  readonly applyAuthority: readonly ApplyAuthority[];
  readonly readiness: ReadinessVerdict;
  readonly survey: readonly ReadinessVerdict[] | null;
  readonly parity: ParityReport | null;
  readonly shadowDecisionsByMode: Readonly<Record<string, number>> | null;
  /** Why `parity` and `shadowDecisionsByMode` are null, when they are. */
  readonly parityUnavailableReason: string | null;
  readonly counters: 'not_observable_from_this_process';
  readonly queueParity: readonly QueueParityObservation[] | null;
  readonly definitionOfDone: DoneReport;
}

/** The migration-state keys the request path consults, coarse and fine. */
export function operatorStatusKeys(): readonly string[] {
  return [
    ...GENERIC_QUEUE_TYPES,
    ...CUTOVER_ELIGIBLE_EDIT_TYPES.map(applyAuthorityKey),
  ];
}

async function activeAgents(
  db: GovernanceDb,
  selection: readonly number[] | 'all',
): Promise<
  Array<{ id: number; userId: number; slug: string; selfReviewEnabled: boolean }>
> {
  const rows =
    selection === 'all'
      ? await db
          .select({ id: agents.id, userId: agents.userId })
          .from(agents)
          .where(eq(agents.status, 'active'))
          .orderBy(agents.id)
      : await Promise.all(
          selection.map(async (id) => {
            const [row] = await db
              .select({ id: agents.id, userId: agents.userId })
              .from(agents)
              .where(eq(agents.id, id))
              .limit(1);
            if (!row) throw new Error(`no agent with id ${id}`);
            return row;
          }),
        );
  const out: Array<{
    id: number;
    userId: number;
    slug: string;
    selfReviewEnabled: boolean;
  }> = [];
  for (const row of rows) {
    // The same gate the route applies (active row, agent-capable role), so
    // the comparison is for an agent the route would actually serve.
    const agent = await resolveActiveAgent(row.userId);
    if (agent) out.push(agent);
  }
  return out;
}

async function queueParityFor(
  db: GovernanceDb,
  opts: OperatorStatusOptions,
): Promise<QueueParityObservation[]> {
  // The handler's own normalisation, applied to the same input. Comparing a
  // batch larger than the endpoint will ever serve would report differences no
  // agent can observe, which is the opposite of what this comparison is for.
  const limit = Math.min(
    LEGACY_QUEUE_MAX_LIMIT,
    Math.max(1, opts.queueLimit ?? LEGACY_QUEUE_MAX_LIMIT),
  );
  const minAgeMinutes = opts.queueMinAgeMinutes ?? 5;
  const now = opts.now ?? new Date();
  const ageCutoff = new Date(now.getTime() - minAgeMinutes * 60_000);
  const out: QueueParityObservation[] = [];
  for (const agent of await activeAgents(db, opts.queueAgents ?? [])) {
    const legacy = await selectLegacyQueue({
      types: [...LEGACY_QUEUE_TYPES],
      ageCutoff,
      agentId: agent.id,
      agentUserId: agent.userId,
      selfReviewEnabled: agent.selfReviewEnabled,
      limit,
    });
    const comparison = await compareQueues(legacy, {
      agentId: agent.id,
      agentUserId: agent.userId,
      selfReviewEnabled: agent.selfReviewEnabled,
      limit,
      minAgeMinutes,
      now,
    });
    const { generic, ...rest } = comparison;
    out.push({
      agentId: agent.id,
      agentSlug: agent.slug,
      agentUserId: agent.userId,
      selfReviewEnabled: agent.selfReviewEnabled,
      legacyServed: legacy.length,
      genericSelected: generic.items.length,
      limit,
      comparison: rest,
    });
  }
  return out;
}

/** Gather every Step A report. Reads only; see the header. */
export async function gatherOperatorStatus(
  opts: OperatorStatusOptions = {},
): Promise<OperatorStatus> {
  const db = opts.db ?? getDb();
  const editType = opts.editType ?? 'wiki_fact';
  const space = KINETIX_SPACE;
  const spaceRow = await findSpace(db, space);

  const storedModes = (await listMigrationState(db, space)).map((m) => ({
    targetType: m.targetType,
    mode: m.mode,
    updatedAt: m.updatedAt.toISOString(),
  }));

  const resolvedModes: Array<{ key: string; mode: KgMigrationMode }> = [];
  for (const key of operatorStatusKeys()) {
    resolvedModes.push({ key, mode: await resolveMigrationMode(key, { db }) });
  }
  const applyAuthority: ApplyAuthority[] = [];
  for (const type of CUTOVER_ELIGIBLE_EDIT_TYPES) {
    applyAuthority.push(await resolveApplyAuthority(type, { db }));
  }

  const scan = { db, limit: opts.limit, maxPages: opts.maxPages };
  const readiness = await assessReadiness(editType, scan);
  const survey = opts.survey
    ? await surveyEditTypes({ db, limit: opts.limit })
    : null;

  let parity: ParityReport | null = null;
  let shadow: Record<string, number> | null = null;
  let parityUnavailableReason: string | null = null;
  if (spaceRow) {
    parity = await parityReport({ db, space, limit: opts.limit });
    shadow = await shadowDecisionsByMode(db);
  } else {
    parityUnavailableReason =
      `no '${space}' space row exists, so nothing has been mirrored here; the parity ` +
      'report and shadow-decision counts would have to create the row to read it, ' +
      'and a read-only diagnostic does not';
  }

  const queueParity = opts.queueAgents ? await queueParityFor(db, opts) : null;

  const definition = await definitionOfDone({
    db,
    space,
    limit: opts.limit,
    maxPages: opts.maxPages,
  });

  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    space,
    spaceExists: spaceRow !== null,
    forceLegacy: forceLegacyEnabled(),
    eligibleEditTypes: CUTOVER_ELIGIBLE_EDIT_TYPES,
    storedModes,
    resolvedModes,
    applyAuthority,
    readiness,
    survey,
    parity,
    shadowDecisionsByMode: shadow,
    parityUnavailableReason,
    counters: 'not_observable_from_this_process',
    queueParity,
    definitionOfDone: definition,
  };
}

function describeQueueParity(observations: readonly QueueParityObservation[]): string[] {
  const lines: string[] = [];
  if (observations.length === 0) {
    lines.push('  (no active agent matched the selection)');
    return lines;
  }
  for (const o of observations) {
    lines.push(
      `  agent #${o.agentId} (${o.agentSlug}, user ${o.agentUserId}` +
        `${o.selfReviewEnabled ? ', self-review' : ''}): ` +
        `legacy served ${o.legacyServed}, generic selected ${o.genericSelected} ` +
        `(limit ${o.limit})`,
    );
    lines.push(`    ${describeComparison(o.comparison)}`);
    if (o.comparison.truncated.length > 0) {
      lines.push(
        `    NOT A PARITY VERDICT: the generic scan hit its candidate cap for ` +
          `${o.comparison.truncated.join(', ')}; the findings below include rows it never reached`,
      );
    }
    for (const item of o.comparison.legacyOnly) {
      lines.push(`    legacy-only   ${item.key} (${item.reason})`);
    }
    for (const key of o.comparison.genericOnly) {
      lines.push(`    generic-only  ${key}`);
    }
    for (const m of o.comparison.packetMismatches) {
      lines.push(
        `    packet        ${m.key}: legacy ${m.legacyFingerprint.slice(0, 12)} ` +
          `generic ${m.genericFingerprint.slice(0, 12)}`,
      );
    }
  }
  return lines;
}

/** Render the whole status as text, section by section, for a terminal. */
export function describeOperatorStatus(status: OperatorStatus): string {
  const lines: string[] = [
    `knowledge-governance operator status — ${status.space} @ ${status.generatedAt}`,
    '',
    `${FORCE_LEGACY_ENV}: ${status.forceLegacy ? 'ENGAGED (every target resolves legacy_only)' : 'off'}`,
    `space row present: ${status.spaceExists ? 'yes' : 'no (nothing mirrored yet)'}`,
    `cutover-eligible edit types in this build: ${status.eligibleEditTypes.join(', ') || '(none)'}`,
    '',
    'stored migration state (kg_migration_state):',
  ];
  if (status.storedModes.length === 0) {
    lines.push('  (no rows — every target is legacy_only)');
  }
  for (const m of status.storedModes) {
    lines.push(`  ${m.targetType.padEnd(32)} ${m.mode.padEnd(28)} since ${m.updatedAt}`);
  }

  lines.push('', 'resolved at runtime (absent rows and the kill switch applied):');
  for (const m of status.resolvedModes) {
    lines.push(`  ${m.key.padEnd(32)} ${m.mode}`);
  }
  lines.push('', 'apply authority:');
  for (const a of status.applyAuthority) {
    lines.push(
      `  ${a.key.padEnd(32)} ${a.authoritative ? 'GENERIC decides' : `legacy decides (withheld: ${a.withheld})`}`,
    );
  }

  lines.push('', `dossier for '${status.readiness.dossier.editType}':`);
  lines.push(describeDossier(status.readiness));
  for (const o of status.readiness.dossier.policy.severity1) {
    lines.push(
      `    severity-1 pending_edit#${o.pendingEditId}: legacy=${o.legacyOutcome} ` +
        `generic=${o.genericOutcome} (${o.reasons.join(', ') || 'no reason recorded'})`,
    );
  }
  for (const o of status.readiness.dossier.policy.conservative) {
    lines.push(
      `    conservative pending_edit#${o.pendingEditId}: legacy=${o.legacyOutcome} ` +
        `generic=${o.genericOutcome} (${o.reasons.join(', ') || 'no reason recorded'})`,
    );
  }
  for (const d of status.readiness.dossier.reconciliation.divergences) {
    lines.push(
      `    reconciliation ${d.kind} ${d.targetType}` +
        `${d.legacyId !== undefined ? `#${d.legacyId}` : ''}: ${d.detail}`,
    );
  }

  if (status.survey) {
    lines.push('', 'survey of every edit type present:');
    for (const verdict of status.survey) {
      lines.push(describeDossier(verdict));
    }
  }

  lines.push('');
  if (status.parity) {
    lines.push(describeParityReport(status.parity));
    lines.push(
      '',
      'note: mirror/fallback/error counters above are per process; this process ' +
        'served no requests, so they read zero here regardless of production',
    );
    lines.push('', 'policy decisions by evaluation mode:');
    const modes = Object.entries(status.shadowDecisionsByMode ?? {});
    if (modes.length === 0) lines.push('  (none recorded)');
    for (const [mode, count] of modes) lines.push(`  ${mode.padEnd(24)} ${count}`);
  } else {
    lines.push(`parity report: unavailable — ${status.parityUnavailableReason}`);
  }

  lines.push('', 'queue parity (legacy served batch vs generic selector):');
  if (status.queueParity === null) {
    lines.push('  not run (pass --queue-agent=<id>|all)');
  } else {
    lines.push(...describeQueueParity(status.queueParity));
  }

  lines.push('', describeDefinitionOfDone(status.definitionOfDone));
  return lines.join('\n');
}
