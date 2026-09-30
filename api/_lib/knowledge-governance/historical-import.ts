/**
 * Historical snapshot import (Step B of
 * docs/plans/2026-09-05-assurance-transition-continuation.md).
 *
 * The shadow mirror is a *live* observer: it watches a legacy row move and
 * projects each move as it happens. Pointed at history it is simply wrong.
 * `ensureMirroredVersion` created every new proposal `pending`, so re-mirroring
 * an already-approved 2024 edit produced a generic record claiming that edit is
 * still awaiting review — and reconciliation, correctly, reported a
 * `state_mismatch` plus a `missing_publication` for it. Running the repair
 * apply path over the 1,776 findings on production would therefore have turned
 * missing history into *incorrectly projected* history, which is worse: the
 * first is visibly absent and the second reads as fact.
 *
 * This module is the other operation — importing a **snapshot of an outcome
 * that already happened** — and it is deliberately a different operation rather
 * than a flag on the mirror:
 *
 *   - it preserves the source's own state (`approved → applied`,
 *     `rejected → rejected`) instead of inventing an open review;
 *   - it records, immutably, that the record was imported rather than observed,
 *     what the source said at capture time, and which parts of the history are
 *     unknowable;
 *   - it never fabricates a publication event. Reconciliation is taught to
 *     accept the import record *in place of* one, for exactly the version that
 *     carries it, and for nothing else.
 *
 * ## What "current_state_only" means here
 *
 * Kinetix cannot supply a faithful history. `pending_edits` is revised in place
 * and `agent_verifications` upserts on `(agent_id, target_type, target_id)`, so
 * an earlier payload and an earlier verdict are gone. §6 of the extraction plan
 * forbids pretending otherwise, so an import says on its face that it holds one
 * observation and not a sequence. The two timestamps are kept apart for the
 * same reason: `sourceClosedAt` is the moderation time when legacy recorded one
 * and `null` when it did not, while `closureObservedAt` is only when this
 * importer looked. An import timestamp is not evidence that a publication
 * predates generic observation.
 *
 * ## What it does not do
 *
 * It does not import `approvals` rows (the human stamp mirrored live by
 * `mirrorHumanApproval`), and it does not reconstruct disputes. Neither is a
 * reconciliation class, so neither would be silently reported as clean; both
 * remain live-mirror concerns.
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { getDb, inTransaction, isInPoolTransaction } from '../db.js';
import { lockVerificationSourceRow } from '../agent-verifications.js';
import {
  AUTHOR_INDEPENDENCE_GROUP,
  canonicalSnapshot,
} from './store/capability-snapshot.js';
import { agentVerifications, agents, pendingEdits } from '../../../db/schema.js';
import {
  kgProposals,
  type KgProposalState,
  type KgVerdict,
} from '../../../db/governance-schema.js';
import { KINETIX_SPACE, resolveAuthorKind } from './actor-context.js';
import { ensureKinetixSpace, ensureKinetixTarget } from './backfill.js';
import { mirrorsWrites, resolveMigrationMode } from './migration-state.js';
import { registerKinetixAdapters } from './adapters/kinetix/index.js';
import { findKnowledgeTargetAdapter } from './registry.js';
import { currentAssessments, recordAssessment } from './store/assessments.js';
import { assessmentMatches, tierCapabilities } from './kinetix-compat.js';
import { listAuditEventsOfType, recordAuditEvent } from './store/audit.js';
import {
  STATE_AFTER_PUBLICATION,
  listPublicationEvents,
} from './store/decisions.js';
import { findByLegacy, linkLegacyRecord } from './store/legacy-links.js';
import { createProposal, isTerminalProposalState, setProposalState } from './store/proposals.js';
import { appendVersion, latestVersion } from './store/versions.js';
import { legacyProvenance, type GovernanceDb } from './store/interface.js';

/** The one legacy table this importer knows how to read a lifecycle from. */
export const PENDING_EDIT_LEGACY_TYPE = 'pending_edit';

/** `kg_audit_events.event_type` carrying an import's provenance. */
export const HISTORICAL_IMPORT_EVENT = 'historical_import';

/**
 * How a legacy `pending_edits.status` projects into a generic proposal state.
 *
 * Deliberately the same table the reconciliation scanner compares against —
 * that module imports this one rather than keeping a second copy, because two
 * maps that must agree by hand are two maps that eventually will not.
 */
export const STATE_BY_LEGACY_STATUS: Readonly<Record<string, KgProposalState>> = {
  draft: 'draft',
  pending: 'pending',
  approved: 'applied',
  rejected: 'rejected',
  returned: 'returned',
};

/**
 * Project one legacy row's state, which its `status` alone cannot decide.
 *
 * `rejected` carries two different outcomes. A moderator refusing a proposal
 * writes it, and so does a submitter withdrawing their own — `isOwnCancel` in
 * `api/pending-edits.ts` sets `status: 'rejected'` with `reviewed_by` set to
 * the canceller, who is by definition the submitter. Importing both as
 * `rejected` gives every withdrawal a rejection it never received, recorded in
 * an immutable provenance record, and the generic model has `withdrawn` for
 * exactly this.
 *
 * `reviewed_by === submitted_by` is what separates them, and it is the same
 * fact the cancel path writes rather than an inference about it.
 *
 * Shared with the reconciliation scanner deliberately: a projection the
 * importer applies and the scanner does not is a `state_mismatch` on every
 * withdrawn row.
 */
export function projectLegacyState(row: {
  status: string;
  reviewedBy: number | null;
  submittedBy: number | null;
}): KgProposalState | null {
  const mapped = STATE_BY_LEGACY_STATUS[row.status];
  if (mapped === undefined) return null;
  if (
    mapped === 'rejected' &&
    row.reviewedBy !== null &&
    row.submittedBy !== null &&
    row.reviewedBy === row.submittedBy
  ) {
    return 'withdrawn';
  }
  return mapped;
}

/**
 * The immutable record of one import, written to `kg_audit_events` against the
 * imported version.
 *
 * An audit event rather than a column on `kg_proposal_versions`: the table is
 * already append-only with no update or delete anywhere in the store, which is
 * the property the record needs, and it keeps provenance out of both the domain
 * payload and the policy risk tags — neither of which may carry migration
 * bookkeeping that a policy could then accidentally read.
 */
export interface HistoricalImportProvenance {
  readonly origin: 'legacy_snapshot';
  readonly historicalCompleteness: 'current_state_only';
  /** When this importer read the source row. Not an event time. */
  readonly capturedAt: string;
  readonly legacyType: string;
  readonly legacyId: number;
  /** The source row's state at capture — the evidence the exception rechecks. */
  readonly sourceState: string;
  /** The source row's stale-verdict token at capture. */
  readonly sourceVersionToken: string;
  /** The source's own submission time, which legacy does record. */
  readonly sourceCreatedAt: string;
  /** The original moderation time, or `null` when legacy recorded none. */
  readonly sourceClosedAt: string | null;
  /** When *this import* observed a closure. Never the original event time. */
  readonly closureObservedAt: string | null;
  readonly importedState: KgProposalState;
  readonly proposalId: number;
  readonly proposalVersionId: number;
}

/** Parse a stored payload, returning `null` for anything malformed. */
export function parseHistoricalImportProvenance(
  payload: unknown,
): HistoricalImportProvenance | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.origin !== 'legacy_snapshot') return null;
  if (p.historicalCompleteness !== 'current_state_only') return null;
  if (typeof p.capturedAt !== 'string') return null;
  if (typeof p.legacyType !== 'string') return null;
  if (typeof p.legacyId !== 'number') return null;
  if (typeof p.sourceState !== 'string') return null;
  if (typeof p.sourceVersionToken !== 'string') return null;
  if (typeof p.sourceCreatedAt !== 'string') return null;
  if (typeof p.importedState !== 'string') return null;
  if (typeof p.proposalId !== 'number') return null;
  if (typeof p.proposalVersionId !== 'number') return null;
  const closedAt = p.sourceClosedAt;
  if (closedAt !== null && typeof closedAt !== 'string') return null;
  const observed = p.closureObservedAt;
  if (observed !== null && typeof observed !== 'string') return null;
  return {
    origin: 'legacy_snapshot',
    historicalCompleteness: 'current_state_only',
    capturedAt: p.capturedAt,
    legacyType: p.legacyType,
    legacyId: p.legacyId,
    sourceState: p.sourceState,
    sourceVersionToken: p.sourceVersionToken,
    sourceCreatedAt: p.sourceCreatedAt,
    sourceClosedAt: (closedAt as string | null) ?? null,
    closureObservedAt: (observed as string | null) ?? null,
    importedState: p.importedState as KgProposalState,
    proposalId: p.proposalId,
    proposalVersionId: p.proposalVersionId,
  };
}

/**
 * The import record for one version, or `null` when it was not imported.
 *
 * Scoped to the version rather than the proposal on purpose: the reconciliation
 * exception below must apply to the exact version that was captured as already
 * decided and to no other, so a later version of the same proposal finds
 * nothing here and is held to the ordinary rule.
 */
export async function historicalImportForVersion(
  db: GovernanceDb,
  versionId: number,
): Promise<HistoricalImportProvenance | null> {
  // Queried by event type rather than read out of the recent window. Filtering
  // a newest-first page of *all* this version's events made the answer depend
  // on unrelated volume: fifty later events — `authoritative_publish_failed`
  // retries are recorded against this same subject — would push the import
  // record out of sight, and every reader treats "no record" as "never
  // imported". `rebuildImportedProjection` would return null instead of
  // recovering the outcome, and reconciliation would hold an imported version
  // to the ordinary `missing_publication` rule. The record is immutable and
  // there is at most one; there is no reason to look for it through a window.
  const events = await listAuditEventsOfType(db, {
    subjectType: 'proposal_version',
    subjectId: versionId,
    eventType: HISTORICAL_IMPORT_EVENT,
  });
  for (const event of events) {
    const parsed = parseHistoricalImportProvenance(event.payload);
    // A record that names a different version is not this version's evidence,
    // however it came to be filed here.
    if (parsed && parsed.proposalVersionId === versionId) return parsed;
  }
  return null;
}

/** Why an import record does not excuse a missing publication event. */
export type ImportExceptionRefusal =
  | 'no_import_record'
  | 'malformed_import_record'
  | 'imported_open'
  | 'source_identity_mismatch'
  | 'source_state_changed'
  | 'source_version_changed'
  | 'imported_version_mismatch';

export type ImportExceptionResult =
  | { readonly ok: true; readonly provenance: HistoricalImportProvenance }
  | { readonly ok: false; readonly reason: ImportExceptionRefusal };

/**
 * Whether this exact version was explicitly imported as already applied.
 *
 * The narrow exception §12.2's `missing_publication` class needs, and every
 * clause below is what keeps it narrow. The record must name this version and
 * this legacy row; it must describe the stored version it was written against;
 * the source must *still* say what the record captured, in both its state and
 * its stale-verdict token; and the import must have been of a closed outcome
 * rather than of an open proposal published later. Any of those failing leaves
 * the finding standing — which is the point, because "no evidence" and
 * "evidence that no longer holds" are both reasons to look, not reasons to
 * pass.
 *
 * `versionToken` and `sourceToken` are deliberately two arguments. The first is
 * what the mirrored version recorded and answers "is this record about this
 * row?"; the second is what the source says today and answers "has the row
 * moved since?". Checking only the stored one would compare the import against
 * itself and pass for a legacy row that has since been revised.
 */
export async function importedAsAlreadyApplied(
  db: GovernanceDb,
  args: {
    versionId: number;
    legacyType: string;
    legacyId: number;
    legacyStatus: string;
    /** The token stored on the mirrored version. */
    versionToken: string | null;
    /** The token the source projects right now. */
    sourceToken: string | null;
  },
): Promise<ImportExceptionResult> {
  // By type, for the reason `historicalImportForVersion` records: reading a
  // window of every event on this version and filtering would let unrelated
  // volume answer `no_import_record`, and this function's `false` is what keeps
  // `missing_publication` standing.
  const candidates = await listAuditEventsOfType(db, {
    subjectType: 'proposal_version',
    subjectId: args.versionId,
    eventType: HISTORICAL_IMPORT_EVENT,
  });
  if (candidates.length === 0) return { ok: false, reason: 'no_import_record' };

  const provenance = candidates
    .map((e) => parseHistoricalImportProvenance(e.payload))
    .find((p): p is HistoricalImportProvenance => p !== null);
  if (!provenance) return { ok: false, reason: 'malformed_import_record' };

  if (
    provenance.proposalVersionId !== args.versionId ||
    provenance.legacyType !== args.legacyType ||
    provenance.legacyId !== args.legacyId
  ) {
    return { ok: false, reason: 'source_identity_mismatch' };
  }
  // Imported open and published afterwards: that publication happened while the
  // generic record existed, so the engine should have observed it.
  if (provenance.importedState !== 'applied') {
    return { ok: false, reason: 'imported_open' };
  }
  if (provenance.sourceVersionToken !== (args.versionToken ?? '')) {
    return { ok: false, reason: 'imported_version_mismatch' };
  }
  if (provenance.sourceState !== args.legacyStatus) {
    return { ok: false, reason: 'source_state_changed' };
  }
  if (args.sourceToken !== null && provenance.sourceVersionToken !== args.sourceToken) {
    return { ok: false, reason: 'source_version_changed' };
  }
  return { ok: true, provenance };
}

/** One legacy row's governance-relevant state, as the importer reads it. */
export interface LegacySnapshot {
  readonly legacyType: string;
  readonly legacyId: number;
  readonly sourceState: string;
  /** `null` when the source state has no generic projection. */
  readonly genericState: KgProposalState | null;
  readonly closed: boolean;
  readonly createdAt: Date;
  /** The known original moderation time, or `null` when legacy records none. */
  readonly closedAt: Date | null;
  readonly editType: string;
}

/**
 * Read one legacy row's lifecycle, or `null` when this importer has no rule for
 * that target type.
 *
 * The Kinetix compatibility edge §3 of the handoff asks for: knowing that
 * `pending_edits.status = 'approved'` means a published outcome is host
 * knowledge, not generic Postgres semantics, and a caller that gets `null` back
 * simply keeps its existing behaviour rather than guessing.
 */
export async function readLegacySnapshot(
  db: GovernanceDb,
  legacyType: string,
  legacyId: number,
): Promise<LegacySnapshot | null> {
  if (legacyType !== PENDING_EDIT_LEGACY_TYPE) return null;
  const [row] = await db
    .select({
      status: pendingEdits.status,
      editType: pendingEdits.editType,
      submittedAt: pendingEdits.submittedAt,
      reviewedAt: pendingEdits.reviewedAt,
      reviewedBy: pendingEdits.reviewedBy,
      submittedBy: pendingEdits.submittedBy,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, legacyId))
    .limit(1);
  if (!row) return null;
  const genericState = projectLegacyState(row);
  return {
    legacyType,
    legacyId,
    sourceState: row.status,
    genericState,
    closed: genericState !== null && isTerminalProposalState(genericState),
    createdAt: row.submittedAt,
    closedAt: row.reviewedAt ?? null,
    editType: row.editType,
  };
}

/**
 * Serialize everything that writes generic records for one legacy identity.
 *
 * Transaction-scoped, so it is released by the commit or rollback that ends the
 * import rather than by whichever statement happens to finish last, and taken
 * by the live mirror's first-contact path too — an importer that only locked
 * against other importers would still race the request path it shares a table
 * with.
 */
async function lockLegacyIdentity(
  db: GovernanceDb,
  legacyType: string,
  legacyId: number,
): Promise<void> {
  const key = `kg-governance:${legacyType}:${legacyId}`;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  await lockLegacySourceRow(db, legacyType, legacyId);
}

/**
 * Take a row lock on the legacy row itself, not just the generic identity.
 *
 * The advisory lock above is **cooperative**: it excludes writers that agree to
 * take it, and the legacy request path does not. `PATCH /api/pending-edits`
 * issues a plain `UPDATE pending_edits`, so without this a reviewer can approve
 * an open edit after the importer has read it and before the import commits —
 * and the import then writes a `pending` proposal, and provenance naming the
 * superseded token, for a row that is already decided. That is decided work
 * reopened on the generic side, which is the failure this whole module exists
 * to prevent, arriving through the one door the advisory lock does not cover.
 *
 * `FOR UPDATE` closes it: the legacy `UPDATE` needs the same row lock, so it
 * waits for this transaction to commit or roll back, and the capture, the
 * judgment and the write are mutually exclusive with legacy transitions rather
 * than merely with other importers.
 *
 * Every registered type, not only `pending_edit`. This used to return silently
 * for the rest on the grounds that `readLegacySnapshot` has nothing to say
 * about them — but the lock is not only for the snapshot. `mirrorAssessment`
 * reads the target's payload, then reads the verdict, and concludes about the
 * pair; with no source lock those are two reads at two different points in
 * legacy time. `paper_review` is revised in place — its `targetVersion` is the
 * row's `updated_at`, and a re-review moves it — so a mirror could select the
 * pre-revision version, then read the verdict the agent recast against the
 * revision, and bind the new judgment to the old payload. The legacy link then
 * exists, so reconciliation reports the row clean, and the recast's own mirror
 * is fire-and-forget: lose that dispatch and the current version keeps an
 * assessment nobody ever made for it. Locking the source row makes the payload
 * hold still for the whole operation, which is what the reads assume.
 *
 * The table map is the legacy path's own (`VERIFICATION_SOURCE_TABLES`), not a
 * second copy here: `recordVerification` locks the same rows to make its
 * version check atomic, and two answers to "the row behind this target" would
 * drift apart exactly where they must agree.
 *
 * Order matters and is uniform: the source row first, verdicts second (see
 * {@link lockLegacyVerdicts}), never the reverse.
 */
function lockLegacySourceRow(
  db: GovernanceDb,
  legacyType: string,
  legacyId: number,
): Promise<void> {
  return lockVerificationSourceRow(db, legacyType, legacyId);
}

/**
 * Hold every verdict on one legacy row for the life of the transaction.
 *
 * Separate from {@link lockLegacyIdentity} because the two have different
 * scopes: that one holds the source row and the cooperative advisory key, and
 * `recordVerification` upserts `agent_verifications` without consulting either.
 *
 * `OF agentVerifications` is load-bearing rather than tidy. `recordVerification`
 * takes `FOR UPDATE` on the **agents** row inside its upsert, so it locks agents
 * then verifications; locking a joined agents row here would take the two in the
 * opposite order and make the paths deadlock instead of queue. This statement
 * touches only `agent_verifications` for that reason.
 */
async function lockLegacyVerdicts(
  db: GovernanceDb,
  legacyType: string,
  legacyId: number,
): Promise<readonly number[]> {
  const rows = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, legacyType),
        eq(agentVerifications.targetId, legacyId),
      ),
    )
    .for('update', { of: agentVerifications });
  return rows.map((r) => r.id);
}

/**
 * Run `fn` holding the identity lock, inside a transaction.
 *
 * The lock is transaction-scoped, so it is released by the commit or rollback
 * that ends the work rather than by whichever statement finishes last — which
 * is the only form that can protect a read-then-decide-then-write. A caller
 * that reads legacy state, judges it against a generic version and writes a
 * conclusion has to hold all three together, or it can conclude from a row that
 * has already moved.
 */
export function withLegacyIdentityLock<T>(
  legacyType: string,
  legacyId: number,
  fn: (db: GovernanceDb) => Promise<T>,
): Promise<T> {
  return inTransaction(async () => {
    const db = getDb();
    await lockLegacyIdentity(db, legacyType, legacyId);
    return fn(db);
  });
}

/**
 * Find or create the proposal identity for one legacy row, under the lock.
 *
 * Shared with the live mirror so both writers agree on what "first contact"
 * means. The unique index on `kg_legacy_links (legacy_type, legacy_id)` is
 * still the real guard — an advisory lock is cooperative and a writer that
 * never took it would slip past — so a loser of that race is reported rather
 * than retried into a duplicate.
 */
export async function ensureProposalIdentity(args: {
  legacyType: string;
  legacyId: number;
  spaceId: number;
  targetId: number;
  authorActorRef: string;
  authorKind: string;
  state: KgProposalState;
  createdAt?: Date;
  legacyPendingEditId?: number | null;
}): Promise<{ proposalId: number; created: boolean }> {
  return inTransaction(async () => {
    const db = getDb();
    await lockLegacyIdentity(db, args.legacyType, args.legacyId);
    const existing = await findByLegacy(db, args.legacyType, args.legacyId);
    if (existing) return { proposalId: existing.genericId, created: false };

    const proposal = await createProposal(db, {
      spaceId: args.spaceId,
      targetId: args.targetId,
      authorActorRef: args.authorActorRef,
      authorKind: args.authorKind,
      state: args.state,
      createdAt: args.createdAt,
      legacyPendingEditId: args.legacyPendingEditId ?? null,
    });
    await linkLegacyRecord(db, {
      genericType: 'proposal',
      genericId: proposal.id,
      legacyType: args.legacyType,
      legacyId: args.legacyId,
    });
    return { proposalId: proposal.id, created: true };
  });
}

// ─── Planning ───────────────────────────────────────────────────────────────

/** What the importer would do with one source row. */
export type ImportPlanKind =
  | 'import'
  | 'already_imported'
  | 'already_mirrored'
  | 'no_source_row'
  | 'unmappable_state';

/** Divergence classes a plan can predict will still be open afterwards. */
export type PredictedFinding =
  | 'state_mismatch'
  | 'missing_publication'
  | 'missing_proposal'
  | 'missing_assessment';

export interface AssessmentPlan {
  readonly total: number;
  /** Verdicts this run would bind to the imported version. */
  readonly versionBound: number;
  /** Verdicts this run would retain as history, their version unestablished. */
  readonly unbound: number;
  /** Verdicts already imported by an earlier run. */
  readonly alreadyImported: number;
  /**
   * Verdicts whose generic record exists but no longer matches legacy.
   *
   * Counted apart from `alreadyImported`, which would otherwise put the
   * preview's name to a withdrawn approval still standing as this version's
   * evidence, and apart from `unresolved`, because there *is* a record — so
   * reconciliation reports nothing and predicting `missing_assessment` would be
   * a prediction that does not come true. Repair belongs to `mirrorAssessment`,
   * which compares and revises on the next verdict write; this is the count
   * that says one was lost.
   */
  readonly staleBindings: number;
  /**
   * Verdicts with no generic assessment that this run will **not** write.
   *
   * A row whose proposal already exists is skipped whole, so its unmirrored
   * verdicts stay unmirrored — and reconciliation goes on reporting each as a
   * `missing_assessment`. Counting them under `versionBound` would describe
   * bindings the run is not going to make, which is the shape of preview error
   * that matters most here: work the operator cannot see is work nobody does.
   *
   * The other source is a verdict that committed after an import froze the set
   * it holds: visible to the plan, outside the write. Same accounting, for the
   * same reason — the run does not mirror it, so the plan must not imply it
   * did.
   */
  readonly unresolved: number;
}

export interface ImportPlanItem {
  readonly legacyType: string;
  readonly legacyId: number;
  readonly kind: ImportPlanKind;
  readonly sourceState: string | null;
  readonly sourceVersionToken: string | null;
  /** The generic state this import would leave behind. */
  readonly proposedState: KgProposalState | null;
  readonly closesProposal: boolean;
  readonly assessments: AssessmentPlan;
  /** What reconciliation is expected to still report about this row. */
  readonly predictedFindings: readonly PredictedFinding[];
  readonly detail?: string;
}

/** Why a verdict could not be bound to the version it judged. */
export type VersionBindingReason =
  | 'established'
  | 'source_closed_after_review'
  | 'source_state_unmappable'
  | 'verdict_predates_current_revision';

/**
 * Whether a historical verdict provably judged the version being imported.
 *
 * `agent_verifications` stores no version token — the legacy stale-verdict
 * check compares one supplied by the client at write time and keeps nothing —
 * so binding can only be *established*, never recovered. It is established when
 * the source row is still open (so the token the importer captured is the one
 * reviewers are judging) and the verdict was cast at or after the row's current
 * submission time (so it cannot belong to a revision that has since been
 * replaced).
 *
 * Everything else is retained as target-level history and reported. §8.3 is the
 * reason the fallback is not "attach it anyway": an assessment names the
 * payload it judged, and a stale approval quietly promoted onto today's version
 * is precisely the version-blind model the generic schema replaced.
 */
export function versionBinding(
  snapshot: LegacySnapshot,
  verdictJudgedAt: Date,
): VersionBindingReason {
  if (snapshot.genericState === null) return 'source_state_unmappable';
  if (snapshot.sourceState !== 'pending') return 'source_closed_after_review';
  // `judgedAt`, not `created_at`: the upsert keeps the first judgment's
  // timestamp, so a verdict recast against the current revision would otherwise
  // be read as predating it and filed as unbindable.
  if (verdictJudgedAt.getTime() < snapshot.createdAt.getTime()) {
    return 'verdict_predates_current_revision';
  }
  return 'established';
}

interface LegacyVerdictRow {
  readonly id: number;
  readonly verdict: string;
  readonly rationaleMd: string;
  readonly model: string | null;
  readonly verifierTier: string | null;
  readonly isImplicit: boolean;
  /** When the agent *first* judged this target. Not when it last did. */
  readonly createdAt: Date;
  /** When the surviving judgment was written. See {@link judgedAt}. */
  readonly updatedAt: Date;
  readonly agentUserId: number;
  readonly agentSlug: string;
}

/**
 * When the judgment this row now holds was made.
 *
 * `recordVerification` upserts on `(agent_id, target_type, target_id)` and its
 * `onConflictDoUpdate` keeps `created_at` while moving `updated_at`. So on a row
 * an agent has changed its mind about, `created_at` is the time of a verdict
 * that no longer exists and `updated_at` is the time of the one that does.
 * Importing at `created_at` would date the surviving judgment to the
 * overwritten one — and, worse, would make a freshly recast verdict look like
 * it predates a revision it was actually cast against, so
 * {@link versionBinding} would file it as unbindable history.
 *
 * The first-judgment time is not lost: it goes into the imported record's
 * provenance, where it says what it is.
 */
function judgedAt(row: LegacyVerdictRow): Date {
  return row.updatedAt ?? row.createdAt;
}

/** What an import run would do with one legacy verdict. */
interface VerdictPlan {
  /**
   * `version_bound`    record it against the imported version;
   * `unbound`          record it against the target, its version unestablished;
   * `already_imported` nothing to do;
   * `stale_binding`    a binding exists but no longer says what legacy says.
   */
  readonly action:
    | 'version_bound'
    | 'unbound'
    | 'already_imported'
    | 'stale_binding';
  /** Whether a generic record already claims this legacy verdict. */
  readonly linked: boolean;
}

/**
 * Decide what to do with one verdict — the single rule the preview reads and
 * the import obeys, so a plan is a plan of the program that runs.
 *
 * The subtlety is that a legacy link is **not** proof the verdict was recorded
 * against this version. `snapshotLegacyVerifications` reads verdicts by
 * `(target_type, target_id)` and links a *target-level* assessment, stamped
 * `versionBinding: 'unestablished'` because that path can never establish which
 * revision was judged. Skipping on the link alone therefore left the one path
 * that *can* establish a binding declining to make it: the proposal imports,
 * reconciliation sees the link and reports the row clean, and version-specific
 * policy finds no assessment on the version and holds or falls back. Nothing
 * repairs it later either — `mirrorAssessment` runs only when a verdict is
 * written, and an unchanged historical verdict never triggers one.
 *
 * So a link means "no work" only where the record it names is already this
 * version's, or where the source does not prove the verdict judged this
 * revision. Where it does prove it, the version-bound assessment is written and
 * the target-level history stays exactly where it is — a different subject, not
 * a supersession.
 *
 * `versionId` is null while planning an import whose version does not exist
 * yet; no existing record can be bound to a version that has not been created.
 */
async function planVerdict(
  db: GovernanceDb,
  args: {
    snapshot: LegacySnapshot;
    versionId: number | null;
    row: LegacyVerdictRow;
  },
): Promise<VerdictPlan> {
  const bound = versionBinding(args.snapshot, judgedAt(args.row)) === 'established';
  const existing = await findByLegacy(db, 'agent_verification', args.row.id);
  if (!existing) {
    return { action: bound ? 'version_bound' : 'unbound', linked: false };
  }
  if (!bound) return { action: 'already_imported', linked: true };
  if (args.versionId === null) return { action: 'version_bound', linked: true };
  // Look for the record, not for a link to it. When a target-level snapshot
  // already claims the legacy row, the assessment this import writes against
  // the version deliberately carries no second link — the store refuses two
  // generic records for one legacy row — so the link goes on naming the
  // target-level row and asking only that question reports the binding as work
  // on every rerun.
  //
  // `agent_verifications` upserts on `(agent_id, target_type, target_id)`, so
  // one actor has at most one verdict on this row: an assessment by that actor
  // on this version is that verdict already bound, whether this importer wrote
  // it or the live mirror did. `currentAssessments` rather than all of them,
  // so a superseded record is not mistaken for the standing one.
  const actorRef = `user:${args.row.agentUserId}`;
  const onVersion = (
    await currentAssessments(db, {
      subjectType: 'proposal_version',
      subjectId: args.versionId,
    })
  ).find((a) => a.actorRef === actorRef);
  if (!onVersion) return { action: 'version_bound', linked: true };

  // A binding that exists is not automatically a binding that is current. The
  // verdict can have been recast to a dispute since, with the mirror that would
  // have revised it lost — it is fire-and-forget — leaving the version holding
  // a withdrawn approval. Answering `already_imported` on the actor alone would
  // put the preview's name to that, and reconciliation cannot contradict it:
  // its `missing_assessment` check asks only whether the legacy row is linked.
  //
  // So compare the record with the row, by the same rule the live mirror uses
  // to decide whether a verdict needs revising. Repair is still the mirror's —
  // this is a skipped row, and the importer does not rewrite a linked record —
  // but a plan that cannot say "present and stale" can only say something
  // untrue.
  const current = assessmentMatches(onVersion, {
    verdict: args.row.verdict as KgVerdict,
    rationaleMd: args.row.rationaleMd || null,
    capabilitySnapshot: {
      modelTier: args.row.verifierTier,
      isImplicit: args.row.isImplicit,
    },
  });
  return {
    action: current ? 'already_imported' : 'stale_binding',
    linked: true,
  };
}

/**
 * Read the verdicts on one legacy row, optionally holding them.
 *
 * The source-row lock does not reach these. `pending_edits` and
 * `agent_verifications` are separate tables, and `recordVerification` upserts on
 * `(agent_id, target_type, target_id)` without consulting the edit row at all —
 * so an agent recasting an approval into a dispute is not excluded by the lock
 * that keeps a *moderator* out. Under READ COMMITTED this read returns the
 * verdict committed before it ran, and the recast can commit after: the import
 * then writes an approval legacy no longer holds.
 *
 * That is invisible afterwards, which is what makes it worth locking rather
 * than tolerating. The stale row is linked, and reconciliation's
 * `missing_assessment` check asks only whether a link exists — so nothing
 * reports it, and under `generic_read` the withdrawn approval is what gets
 * served. The recast's own mirror would normally repair it, but it is
 * fire-and-forget: one lost dispatch and the divergence is permanent.
 *
 * `OF agentVerifications` is load-bearing, not tidiness. `recordVerification`
 * takes `FOR UPDATE` on the **agents** row inside its upsert, so it locks agents
 * then verifications; locking the joined `agents` rows here would take those in
 * the opposite order and make the two paths deadlock instead of queue.
 *
 * A `FOR UPDATE` holds the rows that exist, not the predicate, so an insert of
 * a brand-new verdict is not excluded — there is no row to lock. The ids this
 * returns are therefore the verdict set the import describes: a row that
 * appears afterwards is not silently swept in with a `sourceJudgedAt` later
 * than the capture time it would be filed under. Leaving it out costs nothing
 * that stays hidden — it has no link, so reconciliation reports it as
 * `missing_assessment` until the live mirror or a later run picks it up.
 */
async function legacyVerdictsFor(
  db: GovernanceDb,
  legacyType: string,
  legacyId: number,
  opts: { lock?: boolean } = {},
): Promise<LegacyVerdictRow[]> {
  const query = db
    .select({
      id: agentVerifications.id,
      verdict: agentVerifications.verdict,
      rationaleMd: agentVerifications.rationaleMd,
      model: agentVerifications.model,
      verifierTier: agentVerifications.verifierTier,
      isImplicit: agentVerifications.isImplicit,
      createdAt: agentVerifications.createdAt,
      updatedAt: agentVerifications.updatedAt,
      agentUserId: agents.userId,
      agentSlug: agents.slug,
    })
    .from(agentVerifications)
    .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(
      and(
        eq(agentVerifications.targetType, legacyType),
        eq(agentVerifications.targetId, legacyId),
      ),
    )
    .orderBy(asc(agentVerifications.id));
  const rows = opts.lock
    ? await query.for('update', { of: agentVerifications })
    : await query;
  return rows as LegacyVerdictRow[];
}

/**
 * Plan one source row: what would happen, and what would still be wrong.
 *
 * Shared verbatim with apply — apply calls this and then executes exactly the
 * plan it returns — because a preview derived from separate logic is a preview
 * of a different program.
 */
export async function planOne(
  db: GovernanceDb,
  args: {
    legacyType: string;
    legacyId: number;
    space?: string;
    /**
     * The verdicts an import has frozen under its lock, when one is planning
     * work it is about to do.
     *
     * `FOR UPDATE` holds rows and not the predicate, so a verdict inserted
     * after the lock is visible to this read even though the write side will
     * not import it. Left unfiltered the plan claims an assessment the run then
     * does not write: the outcome still reports `imported`, `revisit` stays
     * empty, the CLI exits 0, and reconciliation reports the
     * `missing_assessment` the plan had just said would not exist. Filtered,
     * the verdict is counted as `unresolved` instead of dropped, so the same
     * divergence is predicted rather than merely not claimed.
     *
     * Omitted by the preview, which holds nothing and should describe what is
     * there now.
     */
    verdictIds?: readonly number[];
  },
): Promise<ImportPlanItem> {
  const spaceSlug = args.space ?? KINETIX_SPACE;
  const empty: AssessmentPlan = {
    total: 0,
    versionBound: 0,
    unbound: 0,
    alreadyImported: 0,
    staleBindings: 0,
    unresolved: 0,
  };
  const snapshot = await readLegacySnapshot(db, args.legacyType, args.legacyId);
  if (!snapshot) {
    return {
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      kind: 'no_source_row',
      sourceState: null,
      sourceVersionToken: null,
      proposedState: null,
      closesProposal: false,
      assessments: empty,
      predictedFindings: [],
      detail: 'no legacy row, or no import rule for this target type',
    };
  }

  registerKinetixAdapters();
  const adapter = findKnowledgeTargetAdapter(spaceSlug, args.legacyType);
  const ref = { space: spaceSlug, type: args.legacyType, id: String(args.legacyId) };
  // `includeHidden`, matching the mirror and the scanner: governance history
  // has to be complete regardless of who may read the content.
  const version = adapter
    ? await adapter.loadVersion(ref, { includeHidden: true })
    : null;
  const token = version?.targetVersion ?? null;

  if (snapshot.genericState === null) {
    return {
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      kind: 'unmappable_state',
      sourceState: snapshot.sourceState,
      sourceVersionToken: token,
      proposedState: null,
      closesProposal: false,
      assessments: empty,
      predictedFindings: ['missing_proposal'],
      detail: `legacy status '${snapshot.sourceState}' has no generic projection`,
    };
  }
  if (!adapter || !version) {
    return {
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      kind: 'no_source_row',
      sourceState: snapshot.sourceState,
      sourceVersionToken: token,
      proposedState: null,
      closesProposal: false,
      assessments: empty,
      // The legacy row is there and cannot be imported, so the scanner will go
      // on reporting it as missing. Predicting nothing here would let a preview
      // read clean over rows the import provably cannot cover.
      predictedFindings: ['missing_proposal'],
      detail: adapter
        ? 'the adapter cannot load this row'
        : `no adapter registered for '${args.legacyType}'`,
    };
  }

  // Resolved before the verdicts are classified, not after. A rerun over a row
  // that is already imported has a version, and a verdict already bound to it is
  // finished work — planning against `null` would call it a binding this run
  // will make, the skipped branch would then recast it as `unresolved`, and the
  // CLI would report `LEFT UNMIRRORED` for a row reconciliation calls clean.
  // A preview that invents work is the same failure as one that hides it.
  const link = await findByLegacy(db, args.legacyType, args.legacyId);
  const existingVersion = link ? await latestVersion(db, link.genericId) : null;

  const frozen = args.verdictIds === undefined ? null : new Set(args.verdictIds);
  const visible = await legacyVerdictsFor(db, args.legacyType, args.legacyId);
  const verdicts = visible.filter((row) => frozen === null || frozen.has(row.id));
  // Verdicts this read can see that the caller's lock does not hold: committed
  // after the capture and therefore visible under READ COMMITTED, but outside
  // the set the write side will import. They are not planned as work — the run
  // will not do it — and they are not silently dropped either, because a
  // verdict left unmirrored is a `missing_assessment` the scanner will report
  // whatever else this row does. Counted as unresolved, they say so.
  const excluded = visible.length - verdicts.length;
  let versionBound = 0;
  let unbound = 0;
  let alreadyImported = 0;
  let staleBindings = 0;
  for (const verdict of verdicts) {
    const { action } = await planVerdict(db, {
      snapshot,
      versionId: existingVersion?.id ?? null,
      row: verdict,
    });
    if (action === 'already_imported') alreadyImported += 1;
    else if (action === 'stale_binding') staleBindings += 1;
    else if (action === 'version_bound') versionBound += 1;
    else unbound += 1;
  }
  const unmirrored = versionBound + unbound;

  const base = {
    legacyType: args.legacyType,
    legacyId: args.legacyId,
    sourceState: snapshot.sourceState,
    sourceVersionToken: token,
    proposedState: snapshot.genericState,
    closesProposal: snapshot.closed,
  } as const;

  if (!link) {
    return {
      ...base,
      kind: 'import',
      assessments: {
        total: visible.length,
        versionBound,
        unbound,
        alreadyImported,
        staleBindings,
        unresolved: excluded,
      },
      predictedFindings: excluded > 0 ? ['missing_assessment'] : [],
    };
  }

  // From here the row is skipped, so no verdict of it will be written by this
  // run. The bindings computed above describe an import that is not going to
  // happen; what the operator needs instead is the count that survives.
  const skippedAssessments: AssessmentPlan = {
    total: visible.length,
    versionBound: 0,
    unbound: 0,
    alreadyImported,
    staleBindings,
    unresolved: unmirrored + excluded,
  };

  // Already present. Say which of the two ways it got here, and predict what
  // reconciliation will still say — a preview that reported "nothing to do" for
  // a row it will leave diverging is the failure mode this whole plan exists to
  // avoid.
  const predicted: PredictedFinding[] = [];
  // Every verdict this run leaves unmirrored is a finding the scanner will go
  // on reporting, whatever else is or is not right about the proposal.
  if (unmirrored + excluded > 0) predicted.push('missing_assessment');
  let kind: ImportPlanKind = 'already_mirrored';
  if (existingVersion) {
    const exception = await importedAsAlreadyApplied(db, {
      versionId: existingVersion.id,
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      legacyStatus: snapshot.sourceState,
      versionToken: existingVersion.legacyReviewToken,
      sourceToken: token,
    });
    const record = await historicalImportForVersion(db, existingVersion.id);
    if (record) kind = 'already_imported';
    const projected = await proposalState(db, link.genericId);
    if (projected !== null && projected !== snapshot.genericState) {
      predicted.push('state_mismatch');
    }
    if (snapshot.sourceState === 'approved' && !exception.ok) {
      const events = await publicationActions(db, existingVersion.id);
      if (!events.includes('applied')) predicted.push('missing_publication');
    }
  } else {
    predicted.push('missing_proposal');
  }
  return {
    ...base,
    kind,
    assessments: skippedAssessments,
    predictedFindings: predicted,
    detail:
      kind === 'already_imported'
        ? 'already imported by a previous run'
        : 'a generic proposal already exists for this row',
  };
}

async function proposalState(
  db: GovernanceDb,
  proposalId: number,
): Promise<KgProposalState | null> {
  const [row] = await db
    .select({ state: kgProposals.state })
    .from(kgProposals)
    .where(eq(kgProposals.id, proposalId))
    .limit(1);
  return (row?.state as KgProposalState | undefined) ?? null;
}

async function publicationActions(
  db: GovernanceDb,
  versionId: number,
): Promise<string[]> {
  const events = await listPublicationEvents(db, versionId);
  return events.map((e) => e.action);
}

// ─── Importing one row ──────────────────────────────────────────────────────

export type ImportResult =
  | 'imported'
  | 'skipped'
  | 'stale_capture'
  | 'blocked_by_mode'
  | 'failed';

export interface ImportOutcome {
  readonly plan: ImportPlanItem;
  readonly result: ImportResult;
  readonly proposalId?: number;
  readonly versionId?: number;
  readonly detail?: string;
}

/**
 * Import one legacy row as a historical snapshot, atomically.
 *
 * Everything the import means — the proposal, its version, the legacy links,
 * the projected state, the provenance record and the imported assessments —
 * commits as one unit or not at all. A half-imported proposal is the state that
 * reads as history and is not, and the transaction is what makes that
 * unreachable rather than merely unlikely.
 *
 * The source is re-read **inside** the lock and compared with what the plan
 * captured. A capture that has gone stale is abandoned rather than written: the
 * row moved while we were looking at it, so the outcome we were about to record
 * as history is not the outcome any more.
 */
export async function importHistoricalProposal(args: {
  legacyType: string;
  legacyId: number;
  space?: string;
  capturedAt?: Date;
  /** The plan this import must still agree with, when resuming one. */
  expect?: { sourceState: string; sourceVersionToken: string | null };
}): Promise<ImportOutcome> {
  const spaceSlug = args.space ?? KINETIX_SPACE;
  const ownsTransaction = !isInPoolTransaction();

  const run = inTransaction(async () => {
    const db = getDb();
    await lockLegacyIdentity(db, args.legacyType, args.legacyId);
    // Every row this import will describe is held before the clock is read.
    // The identity lock covers the source row; the verdicts are a separate
    // table and are taken here rather than where they are read, because the
    // stamp below has to come after the last of them.
    const capturedVerdictIds = await lockLegacyVerdicts(
      db,
      args.legacyType,
      args.legacyId,
    );
    // Stamped here, under the locks, rather than once for a whole batch. A
    // batch capture time is assigned before the scan and reused for every row,
    // so a row moderated during a long run is recorded as observed *before* the
    // outcome it describes — `closureObservedAt` earlier than `sourceClosedAt`,
    // in a record whose whole purpose is to say honestly when this importer
    // looked.
    //
    // The same argument reaches the verdicts, which is why the lock above is
    // here and not two hundred lines down at `importAssessments`: a verdict
    // recast between the stamp and the lock would make the import wait, then
    // record that judgment with a `sourceJudgedAt` *later* than the
    // `capturedAt` beside it — an immutable record claiming to have captured a
    // verdict before it existed. Locked first, nothing it describes can move
    // after the clock is read. The explicit override stays, for tests that need
    // a fixed clock.
    const capturedAt = args.capturedAt ?? new Date();

    const plan = await planOne(db, {
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      space: spaceSlug,
      // The same set the write side imports, so the plan cannot describe an
      // assessment this run will not make.
      verdictIds: capturedVerdictIds,
    });

    if (args.expect) {
      const moved =
        args.expect.sourceState !== plan.sourceState ||
        args.expect.sourceVersionToken !== plan.sourceVersionToken;
      if (moved) {
        return {
          plan,
          result: 'stale_capture' as const,
          detail:
            `source moved since capture: '${args.expect.sourceState}' → ` +
            `'${plan.sourceState ?? 'gone'}'`,
        };
      }
    }

    if (plan.kind !== 'import') {
      return { plan, result: 'skipped' as const, detail: plan.detail };
    }

    const snapshot = (await readLegacySnapshot(db, args.legacyType, args.legacyId))!;
    const adapter = findKnowledgeTargetAdapter(spaceSlug, args.legacyType)!;
    const ref = { space: spaceSlug, type: args.legacyType, id: String(args.legacyId) };
    const version = (await adapter.loadVersion(ref, { includeHidden: true }))!;
    const state = snapshot.genericState!;

    const space = await ensureKinetixSpace(db);
    const target = await ensureKinetixTarget(db, ref, space);

    // Resolved from the agents table, never inferred from the reference being
    // present: every `pending_edits` row has a `submitted_by`, so presence
    // proves only that somebody submitted it. See `resolveAuthorKind`.
    const authorKind = await resolveAuthorKind(db, version.authorRef);
    const identity = await ensureProposalIdentity({
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: version.authorRef ?? 'unknown',
      authorKind,
      state,
      // The submission time is a fact legacy still holds; recording the import
      // time instead would renumber the queue's own ordering key.
      createdAt: new Date(version.createdAt),
      legacyPendingEditId:
        args.legacyType === PENDING_EDIT_LEGACY_TYPE ? args.legacyId : null,
    });
    if (!identity.created) {
      // Lost the race with a concurrent writer between planning and locking.
      return {
        plan,
        result: 'skipped' as const,
        detail: 'another writer created this proposal first',
      };
    }

    const current = await adapter.loadCurrent(ref);
    const fingerprint = await adapter.fingerprint({
      proposal: version.payload,
      current,
    });
    const risk = await adapter.classifyRisk({ version, current });
    const appended = await appendVersion(db, {
      proposalId: identity.proposalId,
      payload: version.payload,
      payloadFingerprint: fingerprint,
      authorActorRef: version.authorRef ?? 'unknown',
      actorKind: authorKind,
      riskProfile: risk,
      legacyReviewToken: version.targetVersion,
      submittedAt: new Date(version.createdAt),
    });

    // `createProposal` already wrote the state; this is what derives `closedAt`
    // from it, so a terminal import leaves the open-proposals index instead of
    // sitting in a review queue as work still to do.
    //
    // The closure timestamp is the *known* moderation time when legacy recorded
    // one and the observation time when it did not. The projection needs a
    // value either way; the provenance record below is where the difference is
    // preserved, and it says `sourceClosedAt: null` rather than implying the
    // import time was the event time.
    if (isTerminalProposalState(state)) {
      await setProposalState(db, identity.proposalId, state, snapshot.closedAt ?? capturedAt);
    }

    const provenance: HistoricalImportProvenance = {
      origin: 'legacy_snapshot',
      historicalCompleteness: 'current_state_only',
      capturedAt: capturedAt.toISOString(),
      legacyType: args.legacyType,
      legacyId: args.legacyId,
      sourceState: snapshot.sourceState,
      sourceVersionToken: version.targetVersion,
      sourceCreatedAt: snapshot.createdAt.toISOString(),
      sourceClosedAt: snapshot.closedAt ? snapshot.closedAt.toISOString() : null,
      closureObservedAt: snapshot.closed ? capturedAt.toISOString() : null,
      importedState: state,
      proposalId: identity.proposalId,
      proposalVersionId: appended.id,
    };
    await recordAuditEvent(db, {
      spaceId: space.id,
      eventType: HISTORICAL_IMPORT_EVENT,
      subjectType: 'proposal_version',
      subjectId: appended.id,
      payload: provenance,
    });

    await importAssessments(db, {
      spaceId: space.id,
      targetId: target.id,
      versionId: appended.id,
      snapshot,
      capturedAt,
      capturedVerdictIds,
      sourceVersionToken: version.targetVersion,
    });

    return {
      plan,
      result: 'imported' as const,
      proposalId: identity.proposalId,
      versionId: appended.id,
    };
  });

  // Translate a failure into an outcome **only** when this call owned the
  // transaction that rolled back.
  //
  // `inTransaction` joins an ambient pool transaction rather than opening a
  // second one, and `mirrorAssessment` reaches this path inside one. In that
  // case a throw rolls nothing back by itself: catching it here would turn a
  // half-written import into a resolved `failed` outcome and let the caller's
  // transaction commit the proposal, version, provenance and assessments that
  // were inserted before the error. The all-or-nothing promise this module
  // makes would hold everywhere except the one path that joins a caller.
  //
  // So when we joined, the error escapes, and whoever owns the transaction
  // decides — which for the mirror means `attemptMirror` catching it after the
  // rollback, and filing the repair item that says so.
  return ownsTransaction
    ? run.catch((err) => ({
        plan: {
          legacyType: args.legacyType,
          legacyId: args.legacyId,
          kind: 'import' as const,
          sourceState: null,
          sourceVersionToken: null,
          proposedState: null,
          closesProposal: false,
          assessments: {
            total: 0,
            versionBound: 0,
            unbound: 0,
            alreadyImported: 0,
            staleBindings: 0,
            unresolved: 0,
          },
          predictedFindings: [] as PredictedFinding[],
        },
        result: 'failed' as const,
        detail: err instanceof Error ? err.message : String(err),
      }))
    : run;
}

/**
 * Import the verdicts on one row, conservatively.
 *
 * Three rules, all of them refusals to invent:
 *
 *   - the original judgment time is preserved on insert, so the audit
 *     chronology is not renumbered to the import;
 *   - `supersedesAssessmentId` stays null — `agent_verifications` upserts, so a
 *     current approval that replaced an earlier dispute cannot be distinguished
 *     from a first verdict, and §6.4 forbids guessing;
 *   - a verdict whose exact reviewed version is not established is recorded
 *     against the *target*, not the version, and says so in its provenance. It
 *     is history that happened; it is not evidence about today's payload, and a
 *     version-specific gate never sees it.
 */
async function importAssessments(
  db: GovernanceDb,
  args: {
    spaceId: number;
    targetId: number;
    versionId: number;
    snapshot: LegacySnapshot;
    capturedAt: Date;
    /** The verdicts held when the clock was read; nothing else is imported. */
    capturedVerdictIds: readonly number[];
    sourceVersionToken: string;
  },
): Promise<void> {
  // Held for the life of the import transaction, and narrowed to the set that
  // was held when the capture time was read. `FOR UPDATE` locks rows, not the
  // predicate, so a verdict inserted after the lock would otherwise be read
  // here and filed under a `capturedAt` that predates it.
  const captured = new Set(args.capturedVerdictIds);
  const verdicts = (
    await legacyVerdictsFor(
      db,
      args.snapshot.legacyType,
      args.snapshot.legacyId,
      { lock: true },
    )
  ).filter((row) => captured.has(row.id));
  for (const row of verdicts) {
    const { action, linked } = await planVerdict(db, {
      snapshot: args.snapshot,
      versionId: args.versionId,
      row,
    });
    // `stale_binding` skips too. It cannot arise on this path — the version was
    // created by this import, so nothing can already be bound to it — and if it
    // ever did, writing a second record for the same actor without a
    // supersession link would leave two live judgments rather than repair one.
    // Correcting a stale record is `mirrorAssessment`'s job, which revises.
    if (action === 'already_imported' || action === 'stale_binding') continue;
    const binding = versionBinding(args.snapshot, judgedAt(row));
    const bound = action === 'version_bound';
    const assessment = await recordAssessment(db, {
      spaceId: args.spaceId,
      subjectType: bound ? 'proposal_version' : 'target',
      subjectId: bound ? args.versionId : args.targetId,
      actorRef: `user:${row.agentUserId}`,
      actorKind: 'agent',
      verdict: row.verdict as KgVerdict,
      rationaleMd: row.rationaleMd || null,
      // The implicit marker in the column the generic schema has for it,
      // rather than a second copy inside the snapshot.
      ...(row.isImplicit ? { independenceGroup: AUTHOR_INDEPENDENCE_GROUP } : {}),
      capabilitySnapshot: canonicalSnapshot({
        // The server-owned tier as it stood when the verdict was admitted —
        // migration 0113's column, never the agent's current tier. It becomes
        // the capability a gate reads, the same one the live path derives.
        assuranceCapabilities: tierCapabilities(row.verifierTier),
        host: {
          agentSlug: row.agentSlug,
          provenance: {
            ...legacyProvenance(args.capturedAt, {
              type: 'agent_verification',
              id: row.id,
            }),
            versionBinding: bound ? 'established' : 'unestablished',
            versionBindingReason: binding,
            boundVersionId: bound ? args.versionId : null,
            sourceVersionToken: args.sourceVersionToken,
            // Both times, because they answer different questions and the row
            // holds only one verdict: `sourceJudgedAt` is when the surviving
            // judgment was written, `sourceFirstJudgedAt` when this actor first
            // judged the target. When they differ, an earlier verdict was
            // overwritten and is gone — which is the incompleteness
            // `historicalCompleteness: 'current_state_only'` is claiming.
            sourceJudgedAt: judgedAt(row).toISOString(),
            sourceFirstJudgedAt: row.createdAt.toISOString(),
          },
        },
      }),
      // Self-reported, audit-only (§2.3).
      modelMetadata: row.model ? { model: row.model } : null,
      supersedesAssessmentId: null,
      at: judgedAt(row),
    });
    // No second link when a target-level snapshot already claims this verdict:
    // the store refuses two generic records for one legacy row, and it is right
    // to. The link answers "was this legacy row ever mirrored?", which is still
    // yes; what changed is that the binding it could not establish now exists.
    if (!linked) {
      await linkLegacyRecord(db, {
        genericType: 'assessment',
        genericId: assessment.id,
        legacyType: 'agent_verification',
        legacyId: row.id,
      });
    }
  }
}

/**
 * Recover an imported proposal's outcome from its import record.
 *
 * The projection is a cache over history, and for a native proposal the history
 * is the publication event. An imported one has no such event by design, so a
 * rebuild that only read events would find nothing and leave the proposal open
 * — reopening decided work, which is the exact failure this module exists to
 * prevent. The import record is that proposal's history, and this reads it.
 *
 * But it is not necessarily the *whole* history. A proposal imported while its
 * source was still open can be published afterwards, and that publication is
 * recorded as an ordinary event against this same version. Reading only the
 * import record then reopened work that had genuinely been applied — the same
 * failure this function exists to prevent, arriving from the opposite
 * direction, and worse for being written by the rebuild rather than merely
 * left behind: `setProposalState` derives `closed_at` from the state, so
 * restoring `pending` also clears the closure.
 *
 * So events win where there are any. Every event on this version is later than
 * the import by construction — the import writes the version and the record in
 * one transaction — and replaying to the last of them lands exactly where the
 * live mirror left the state, because both read `STATE_AFTER_PUBLICATION`. The
 * import record is the fallback for the case it was written for: a version
 * whose history is a snapshot and nothing else.
 */
export async function rebuildImportedProjection(
  db: GovernanceDb,
  proposalId: number,
): Promise<KgProposalState | null> {
  const version = await latestVersion(db, proposalId);
  if (!version) return null;
  const record = await historicalImportForVersion(db, version.id);
  if (!record) return null;
  const events = await listPublicationEvents(db, version.id);
  const last = events.at(-1);
  if (last) {
    // The event's own time, not the rebuild's. `setProposalState` derives
    // `closed_at` from the state and defaults it to now, which is right when
    // `mirrorPublicationOutcome` writes it — the event was just recorded — and
    // wrong here: a rebuild months later would restamp the closure with the day
    // the rebuild ran and quietly rewrite the proposal's chronology.
    const state = STATE_AFTER_PUBLICATION[last.action];
    await setProposalState(db, proposalId, state, last.createdAt);
    return state;
  }
  await setProposalState(
    db,
    proposalId,
    record.importedState,
    record.sourceClosedAt
      ? new Date(record.sourceClosedAt)
      : record.closureObservedAt
        ? new Date(record.closureObservedAt)
        : new Date(record.capturedAt),
  );
  return record.importedState;
}

// ─── The batch operation ────────────────────────────────────────────────────

export interface HistoricalImportOptions {
  readonly db?: GovernanceDb;
  readonly space?: string;
  readonly legacyType?: string;
  /** Restrict to one Kinetix `pending_edits.edit_type`. */
  readonly editType?: string;
  /** Upper bound on source rows examined in this run. */
  readonly limit?: number;
  /** Rows read per query while walking to that bound. */
  readonly pageSize?: number;
  /** Resume after this source row id. */
  readonly after?: number;
  readonly dryRun?: boolean;
  readonly capturedAt?: Date;
}

export interface HistoricalImportReport {
  readonly dryRun: boolean;
  readonly legacyType: string;
  readonly editType: string | null;
  readonly mode: string;
  /** True when the migration mode permits generic writes at all. */
  readonly writable: boolean;
  readonly examined: number;
  readonly outcomes: readonly ImportOutcome[];
  readonly planCounts: Readonly<Record<ImportPlanKind, number>>;
  /** Proposed generic state → how many rows would land there. */
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly imported: number;
  readonly failed: number;
  readonly staleCaptures: number;
  readonly assessments: AssessmentPlan;
  readonly predictedFindings: Readonly<Record<PredictedFinding, number>>;
  /**
   * Source rows this run examined and did not import, which a later run must
   * come back to: a stale capture, a failure, or a mode that forbids the write.
   *
   * Reported separately from the cursor, and deliberately not folded into it.
   * `nextCursor` says where the *scan* stopped, so a batch runner walking it
   * moves past everything on this page — including a row that was skipped
   * because it moved mid-capture. Without this list that row is never revisited
   * and a later run reports a complete scan over a population it did not
   * import. Rows legitimately left alone (already imported, already mirrored,
   * no adapter) are not here; there is nothing to come back for.
   */
  readonly revisit: readonly number[];
  /**
   * True only when the walk reached the end of the requested population.
   *
   * A bounded run is normal and is how the import stays resumable; what is not
   * acceptable is a bounded run that reads like a complete one. "0 remaining"
   * after examining the first page is a different statement from "0 remaining",
   * and an operator deciding whether the backfill is finished needs to know
   * which one they are holding.
   */
  readonly scanComplete: boolean;
  /** Where the next run should resume, or `null` when nothing is left. */
  readonly nextCursor: number | null;
}

interface SourceRow {
  readonly id: number;
}

/**
 * Walk the requested population once, in id order, from `after`.
 *
 * Paged rather than one big read, and cursored rather than offset: repeatedly
 * examining the first page is how a "complete" import silently covers 500 of
 * 477 thousand rows, and an offset walk over a table that is still being
 * written to skips rows when earlier ones move.
 */
async function scanSourceRows(
  db: GovernanceDb,
  opts: { editType?: string; after?: number; limit: number; pageSize: number },
): Promise<{ rows: SourceRow[]; scanComplete: boolean; nextCursor: number | null }> {
  const rows: SourceRow[] = [];
  let cursor = opts.after;
  let exhausted = false;

  // A page that comes back exactly full leaves `exhausted` false even when the
  // table happened to end there, so a run can report "not complete" for a
  // population it did in fact finish. That under-claim is the safe direction and
  // costs one more empty page on the next run; the opposite — a bounded scan
  // reporting completion — is the failure this whole field exists to prevent.
  while (rows.length < opts.limit) {
    const page = await db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(
        and(
          cursor === undefined ? undefined : gt(pendingEdits.id, cursor),
          opts.editType ? eq(pendingEdits.editType, opts.editType) : undefined,
        ),
      )
      .orderBy(asc(pendingEdits.id))
      .limit(opts.pageSize);
    rows.push(...page);
    cursor = page.at(-1)?.id ?? cursor;
    if (page.length < opts.pageSize) {
      exhausted = true;
      break;
    }
  }

  if (rows.length > opts.limit) {
    rows.length = opts.limit;
    exhausted = false;
    cursor = rows.at(-1)?.id;
  }
  return {
    rows,
    scanComplete: exhausted,
    nextCursor: exhausted ? null : (cursor ?? null),
  };
}

/**
 * Preview or run the historical import over a bounded, resumable population.
 *
 * `dryRun` defaults to **true**, for the reason `repairMirrors` gives: a tool
 * that writes by default is one someone runs to have a look and then has to
 * explain. The preview is the same planning code the apply path executes, so
 * what it reports is what apply will do rather than a second opinion about it.
 */
export async function importHistoricalSnapshots(
  opts: HistoricalImportOptions = {},
): Promise<HistoricalImportReport> {
  const db = opts.db ?? getDb();
  const legacyType = opts.legacyType ?? PENDING_EDIT_LEGACY_TYPE;
  const dryRun = opts.dryRun ?? true;
  const limit = opts.limit ?? 500;
  const pageSize = Math.min(opts.pageSize ?? 200, Math.max(limit, 1));

  registerKinetixAdapters();
  // The scan walks `pending_edits`, and only that table. Accepting another
  // `--target-type` and scanning it anyway gave every row `no_source_row`, so
  // the command reported a complete scan of the requested population and exited
  // 0 having examined none of it — a clean report for work that never happened,
  // which is the failure this module exists to stop producing.
  if (legacyType !== PENDING_EDIT_LEGACY_TYPE) {
    throw new Error(
      `historical import: no source scan for target type '${legacyType}'; ` +
        `the only importable type is '${PENDING_EDIT_LEGACY_TYPE}'`,
    );
  }
  const mode = await resolveMigrationMode(legacyType, { db, space: opts.space });
  const writable = mirrorsWrites(mode);

  const { rows, scanComplete, nextCursor } = await scanSourceRows(db, {
    editType: opts.editType,
    after: opts.after,
    limit,
    pageSize,
  });

  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    const plan = await planOne(db, {
      legacyType,
      legacyId: row.id,
      space: opts.space,
    });
    if (dryRun || plan.kind !== 'import') {
      outcomes.push({ plan, result: 'skipped', detail: plan.detail });
      continue;
    }
    if (!writable) {
      outcomes.push({
        plan,
        result: 'blocked_by_mode',
        detail: `migration mode '${mode}' does not permit generic writes`,
      });
      continue;
    }
    const outcome = await importHistoricalProposal({
      legacyType,
      legacyId: row.id,
      space: opts.space,
      // Deliberately passed through rather than defaulted here: each row is
      // stamped when its own lock is held, so a long run cannot claim it
      // observed a row before the outcome it is recording.
      capturedAt: opts.capturedAt,
      expect: {
        sourceState: plan.sourceState!,
        sourceVersionToken: plan.sourceVersionToken,
      },
    });
    // A failure rolled its transaction back before it could describe what it
    // was doing, so it carries a placeholder plan. Keep the one this loop
    // already computed: a report that lost the row's source state because the
    // import failed is least legible exactly when it matters most.
    outcomes.push(outcome.result === 'failed' ? { ...outcome, plan } : outcome);
  }

  const planCounts: Record<ImportPlanKind, number> = {
    import: 0,
    already_imported: 0,
    already_mirrored: 0,
    no_source_row: 0,
    unmappable_state: 0,
  };
  const stateCounts: Record<string, number> = {};
  const predictedFindings: Record<PredictedFinding, number> = {
    state_mismatch: 0,
    missing_publication: 0,
    missing_proposal: 0,
    missing_assessment: 0,
  };
  const assessments = {
    total: 0,
    versionBound: 0,
    unbound: 0,
    alreadyImported: 0,
    staleBindings: 0,
    unresolved: 0,
  };

  for (const outcome of outcomes) {
    planCounts[outcome.plan.kind] += 1;
    if (outcome.plan.kind === 'import' && outcome.plan.proposedState) {
      stateCounts[outcome.plan.proposedState] =
        (stateCounts[outcome.plan.proposedState] ?? 0) + 1;
    }
    for (const finding of outcome.plan.predictedFindings) {
      predictedFindings[finding] += 1;
    }
    assessments.total += outcome.plan.assessments.total;
    assessments.versionBound += outcome.plan.assessments.versionBound;
    assessments.unbound += outcome.plan.assessments.unbound;
    assessments.alreadyImported += outcome.plan.assessments.alreadyImported;
    assessments.staleBindings += outcome.plan.assessments.staleBindings;
    assessments.unresolved += outcome.plan.assessments.unresolved;
  }

  return {
    dryRun,
    legacyType,
    editType: opts.editType ?? null,
    mode,
    writable,
    examined: rows.length,
    outcomes,
    planCounts,
    stateCounts,
    imported: outcomes.filter((o) => o.result === 'imported').length,
    failed: outcomes.filter((o) => o.result === 'failed').length,
    staleCaptures: outcomes.filter((o) => o.result === 'stale_capture').length,
    revisit: outcomes
      .filter(
        (o) =>
          o.result === 'stale_capture' ||
          o.result === 'failed' ||
          o.result === 'blocked_by_mode' ||
          // A stale binding is a divergence this run has found and is not
          // fixing: the version holds a judgment the agent has withdrawn, and
          // reconciliation cannot report it because the legacy row is linked.
          // Counting it without listing it here would let the command exit 0
          // over a known obsolete approval, which is the one thing the exit
          // code is for. Repair is still `mirrorAssessment`'s — it revises,
          // this does not rewrite a linked record — so the row is named for a
          // human rather than silently carried.
          o.plan.assessments.staleBindings > 0 ||
          // Any verdict this run leaves unmirrored, on any kind of row.
          //
          // Two ways one arises. On a row the run imported, a verdict that
          // committed after the capture lock froze the set: everything planned
          // was written and a `missing_assessment` is still left behind. On a
          // row that was already mirrored, the run skips the whole row, so
          // every unmirrored verdict of its stays that way.
          //
          // Neither is fixed by exiting 0 over it. The report predicts the
          // divergence in both cases, and a cursor-driven batch that walks past
          // a predicted divergence is the exact failure the exit code exists to
          // stop — the same argument that already lists a stale binding here,
          // and with less excuse, because nothing about these rows is even
          // recorded. Repair is elsewhere (a re-run for the first,
          // `mirrorAssessment` for the second); naming the row is this
          // command's part.
          o.plan.assessments.unresolved > 0 ||
          // A proposal this run predicts will still be missing afterwards.
          //
          // Three plans reach here and all three mean the same thing: the row
          // exists in legacy, the run could not import it, and reconciliation
          // will go on reporting it. An `unmappable_state` (a legacy status
          // added before this importer learned about it), a row whose adapter
          // is missing or cannot load it, and a link with no version behind it.
          //
          // Listed by what the plan predicts rather than by plan *kind*,
          // because enumerating kinds is how the previous two rounds of this
          // bug got in: a new kind, or an old one that starts predicting a gap,
          // is then silently outside the exit code. `state_mismatch` and
          // `missing_publication` on an already-mirrored row are deliberately
          // not here — the importer does not repair those and never claimed to,
          // so there is nothing to come back for.
          o.plan.predictedFindings.includes('missing_proposal') ||
          o.plan.predictedFindings.includes('missing_assessment'),
      )
      .map((o) => o.plan.legacyId),
    assessments,
    predictedFindings,
    scanComplete,
    nextCursor,
  };
}

/** Operator-facing summary. Says what is unknown as loudly as what is known. */
export function describeHistoricalImport(report: HistoricalImportReport): string {
  const lines = [
    report.dryRun
      ? `historical import (PREVIEW) — ${report.examined} source row(s) examined`
      : `historical import — ${report.imported}/${report.planCounts.import} imported ` +
        `of ${report.examined} examined`,
    `  target type:      ${report.legacyType}` +
      (report.editType ? ` (edit_type=${report.editType})` : ''),
    `  migration mode:   ${report.mode}` +
      (report.writable ? '' : ' — generic writes are not permitted; apply would do nothing'),
  ];
  for (const [kind, count] of Object.entries(report.planCounts)) {
    if (count > 0) lines.push(`  ${kind}: ${count}`);
  }
  const states = Object.entries(report.stateCounts)
    .map(([state, n]) => `${state}=${n}`)
    .join(' ');
  if (states) lines.push(`  proposed states:  ${states}`);
  lines.push(
    `  assessments:      ${report.assessments.total} total, ` +
      `${report.assessments.versionBound} version-bound, ` +
      `${report.assessments.unbound} retained as unbound history, ` +
      `${report.assessments.alreadyImported} already imported` +
      (report.assessments.staleBindings > 0
        ? `, ${report.assessments.staleBindings} BOUND BUT STALE`
        : '') +
      (report.assessments.unresolved > 0
        ? `, ${report.assessments.unresolved} LEFT UNMIRRORED on skipped rows`
        : ''),
  );
  const predicted = Object.entries(report.predictedFindings)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind}=${n}`)
    .join(' ');
  lines.push(`  expected findings: ${predicted || 'none'}`);
  if (report.staleCaptures > 0) {
    lines.push(`  ${report.staleCaptures} row(s) moved during capture and were left alone`);
  }
  if (report.failed > 0) lines.push(`  ${report.failed} row(s) FAILED; nothing was written for them`);
  lines.push(
    report.scanComplete
      ? '  scan complete:    yes — the requested population was fully examined'
      : `  scan complete:    NO — bounded run; resume with --after=${report.nextCursor}`,
  );
  // After the scan line, because it qualifies it: the scan can reach the end of
  // the population while leaving rows in it unimported, and the cursor walks
  // past those. Naming them is what stops a batch runner reading "scan
  // complete" as "population imported".
  if (report.revisit.length > 0) {
    lines.push(
      `  NEEDS ATTENTION:  ${report.revisit.length} row(s) not settled by this run — ` +
        `re-run or repair: ${report.revisit.join(', ')}`,
    );
  }
  return lines.join('\n');
}
