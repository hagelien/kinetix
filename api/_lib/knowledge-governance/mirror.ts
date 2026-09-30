/**
 * Stage A shadow mirroring (§12.1, Phase 4).
 *
 * Generic persistence is **observational**. For a successful legacy action the
 * Kinetix transaction completes exactly as it does today, and only then does
 * this module attempt to write the corresponding generic record. The one rule
 * that outranks every other consideration here is §12.1.4 / §12.4:
 *
 *   > Mirror failures do not reject successful Kinetix actions during this
 *   > phase.
 *
 * So every exported entry point is wrapped in `attemptMirror`, which cannot
 * throw and cannot reject. A generic-schema bug in this phase must not be able
 * to take down contribution or moderation — that is the property that makes it
 * safe to run new persistence code against live traffic at all.
 *
 * When a mirror does fail, the failure is not swallowed silently: it becomes a
 * structured repair item in `kg_audit_events` (and a log line if even that
 * write fails), and the reconciliation scanner can reconstruct what is missing
 * from legacy state later. A counter is bumped too, but the counter is the
 * weak record — it lives in one warm serverless instance — and the audit row is
 * the durable one.
 *
 * ## Why the mirror runs after, not inside
 *
 * Mirroring inside the legacy transaction would make `INSERT kg_*` a hard
 * dependency of a valid Kinetix edit, which §12.4 forbids while the generic
 * schema is still experimental. It would also mean a mirror bug rolls back a
 * moderator's approval. Stage C changes this deliberately, with its own
 * cutover, tests and the single-ambient-transaction requirement of §12.3.1 —
 * not by accident here.
 */

import { eq } from 'drizzle-orm';
import {
  AUTHOR_INDEPENDENCE_GROUP,
  canonicalSnapshot,
} from './store/capability-snapshot.js';
import { getDb } from '../db.js';
import { agentVerifications } from '../../../db/schema.js';
import { KINETIX_SPACE, resolveAuthorKind } from './actor-context.js';
import { ensureKinetixSpace, ensureKinetixTarget } from './backfill.js';
import { incrementMetric } from './metrics.js';
import { mirrorsWrites, resolveMigrationMode } from './migration-state.js';
import { findKnowledgeTargetAdapter } from './registry.js';
import { registerKinetixAdapters } from './adapters/kinetix/index.js';
import { recordAuditEvent } from './store/audit.js';
import {
  currentAssessments,
  getAssessment,
  recordAssessment,
  reviseAssessment,
} from './store/assessments.js';
import { assessmentMatches, tierCapabilities } from './kinetix-compat.js';
import { openDispute, recordRuling } from './store/disputes.js';
import {
  STATE_AFTER_PUBLICATION,
  recordPublicationEvent,
} from './store/decisions.js';
import { findByLegacy, linkLegacyRecord } from './store/legacy-links.js';
import {
  getProposal,
  isTerminalProposalState,
  setProposalState,
} from './store/proposals.js';
import { appendVersion, latestVersion } from './store/versions.js';
import {
  ensureProposalIdentity,
  importHistoricalProposal,
  readLegacySnapshot,
  versionBinding,
  withLegacyIdentityLock,
} from './historical-import.js';
import type { GovernanceDb } from './store/interface.js';
import type {
  KgDisputeRulingKind,
  KgPublicationAction,
  KgVerdict,
} from '../../../db/schema.js';

export interface MirrorOutcome {
  readonly mirrored: boolean;
  /** Why nothing was written, when nothing was. */
  readonly skipped?:
    | 'mode'
    | 'no_adapter'
    | 'no_row'
    | 'already_mirrored'
    /**
     * A legacy verdict that was imported as history and cannot be shown to have
     * judged the version now current. Distinct from `already_mirrored`: nothing
     * about this verdict is mirrored *against this version*, and saying so is
     * what stops the skip reading as "converged".
     */
    | 'unbindable_history';
  readonly error?: string;
}

const SKIPPED_BY_MODE: MirrorOutcome = { mirrored: false, skipped: 'mode' };

/**
 * Run a mirror operation so that it cannot affect the caller.
 *
 * Catches everything — including the mode lookup and the repair-item write —
 * and always resolves. A caller may `await` this or not; either way it can
 * neither throw nor reject, so `void attemptMirror(...)` at a legacy seam is
 * safe without a `.catch()` that a later edit might drop.
 */
async function attemptMirror(
  targetType: string,
  operation: string,
  run: (db: GovernanceDb) => Promise<MirrorOutcome>,
): Promise<MirrorOutcome> {
  let db: GovernanceDb;
  try {
    const mode = await resolveMigrationMode(targetType);
    if (!mirrorsWrites(mode)) return SKIPPED_BY_MODE;
    db = getDb();
  } catch (err) {
    // A failure this early is a failure to decide whether to mirror at all.
    // Treat it as "do not mirror" rather than as a mirror failure: nothing was
    // attempted, so nothing is missing, and there is no repair item to file.
    console.warn(
      `[kg-mirror] ${operation}/${targetType}: could not determine mirror mode; skipping: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return SKIPPED_BY_MODE;
  }

  incrementMetric('kg_mirror_attempt_total', targetType);
  try {
    const outcome = await run(db);
    if (outcome.mirrored) incrementMetric('kg_mirror_success_total', targetType);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    incrementMetric('kg_mirror_failure_total', targetType);
    await fileRepairItem(db, targetType, operation, message);
    return { mirrored: false, error: message };
  }
}

/**
 * Record a failed mirror durably, so it can be found and repaired.
 *
 * Best-effort by necessity: if the database is unreachable, the write that
 * records the failure fails for the same reason. The log line is the floor —
 * it is the one thing that still happens when everything else is down.
 */
async function fileRepairItem(
  db: GovernanceDb,
  targetType: string,
  operation: string,
  message: string,
): Promise<void> {
  console.error(`[kg-mirror] ${operation}/${targetType} failed: ${message}`);
  try {
    const space = await ensureKinetixSpace(db);
    await recordAuditEvent(db, {
      spaceId: space.id,
      eventType: 'mirror_failed',
      subjectType: 'target_type',
      subjectId: 0,
      payload: { targetType, operation, message },
    });
  } catch {
    // Already logged above. Nothing further is available.
  }
}

/**
 * Ensure a generic proposal + version exists for one legacy row.
 *
 * The adapter is what knows how to read the row and shape the payload, so this
 * is where Phase 2's boundary starts paying for itself: mirroring gains a new
 * target type by registering an adapter, not by extending a switch here.
 *
 * A new version is appended only when the payload fingerprint actually changed.
 * Re-mirroring an unchanged row is a no-op, which is what makes the hooks safe
 * to call on every write — including the upsert path, where "was this an
 * insert?" is only best-effort knowable — and what makes the whole operation
 * re-runnable by the reconciliation scanner.
 */
async function ensureMirroredVersion(
  targetType: string,
  targetId: number,
  opts: { legacyPendingEditId?: number | null } = {},
): Promise<
  | { ok: true; proposalId: number; versionId: number; created: boolean }
  | { ok: false; skipped: 'no_adapter' | 'no_row' }
> {
  // Registration stays an explicit call rather than an import side effect
  // (Phase 2's rule: pulling in an adapter for its type must not mutate the
  // registry). Doing it here keeps the mirror self-sufficient without a
  // start-up hook the serverless model does not really have.
  registerKinetixAdapters();
  const adapter = findKnowledgeTargetAdapter(KINETIX_SPACE, targetType);
  if (!adapter) return { ok: false, skipped: 'no_adapter' };

  // Everything below runs under the identity lock, and the reads are inside it
  // rather than before it. What this function does is read a legacy row,
  // classify it, and write a conclusion — and a classification made before the
  // lock is a classification about a row that may already have moved.
  //
  // Concretely: read an open row, have a reviewer approve it, then take the
  // lock and create the proposal `pending` anyway, with the payload read before
  // the decision. That is the `state_mismatch` plus `missing_publication` this
  // module was changed to stop producing, recreated by the request path — and
  // it does not heal, because the approval's own publication mirror ran while
  // no link existed and skipped.
  //
  // `withLegacyIdentityLock` joins an ambient transaction rather than opening a
  // second, and the advisory lock and the row lock are both re-entrant within
  // one, so `mirrorAssessment` holding it already is fine.
  return withLegacyIdentityLock(targetType, targetId, async (db) => {
    const ref = { space: KINETIX_SPACE, type: targetType, id: String(targetId) };
    // `includeHidden`: governance history has to be complete regardless of who
    // may read the content. A `wiki_new` proposal never appears in a reviewer
    // queue, but it still happened — and excluding it here would make every one
    // of them a permanent `missing_proposal` finding for the scanner.
    const version = await adapter.loadVersion(ref, { includeHidden: true });
    if (!version) return { ok: false, skipped: 'no_row' };

    const space = await ensureKinetixSpace(db);
    const target = await ensureKinetixTarget(db, ref, space);

    // Read once, under the lock, and used by both branches: first contact needs
    // it to tell an open row from finished history, and the append below needs
    // it to keep the projection level with a row that has moved since.
    const snapshot = await readLegacySnapshot(db, targetType, targetId);

    const existingLink = await findByLegacy(db, targetType, targetId);
    let proposalId: number;
    if (existingLink) {
      proposalId = existingLink.genericId;
    } else {
      // First contact. Which of two things this is depends on the legacy row, and
      // getting it wrong is the bug this branch exists to close: the mirror used
      // to create *every* new proposal `pending`, so the first time it met an
      // already-approved or already-rejected row — a historical backfill, or a
      // row whose earlier mirrors were lost and which has since been moderated —
      // it recorded a decided edit as still awaiting review. Reconciliation then
      // reported a `state_mismatch` and a `missing_publication` forever, because
      // the projection said `pending` while legacy said `approved`.
      //
      // A row that is already closed is not something to observe; it is history
      // to import, with provenance saying so. The importer owns that operation —
      // routing it here rather than only through the operator CLI is what stops
      // the request path from quietly recreating the state the CLI was fixed to
      // stop producing.
      if (snapshot?.closed) {
        const outcome = await importHistoricalProposal({
          legacyType: targetType,
          legacyId: targetId,
        });
        if (outcome.result === 'imported') {
          return {
            ok: true,
            proposalId: outcome.proposalId!,
            versionId: outcome.versionId!,
            created: true,
          };
        }
        // A concurrent writer won, or the source moved under us. Re-read rather
        // than assume either way; if nothing is there, report it as a mirror
        // failure the scanner can find again.
        const link = await findByLegacy(db, targetType, targetId);
        if (!link) return { ok: false, skipped: 'no_row' };
        proposalId = link.genericId;
      } else {
        const identity = await ensureProposalIdentity({
          legacyType: targetType,
          legacyId: targetId,
          spaceId: space.id,
          targetId: target.id,
          authorActorRef: version.authorRef ?? 'unknown',
          // Same rule as the importer, and for the same reason: an author
          // reference exists on every row, so inferring `agent` from its presence
          // labels a person's proposal as an agent's and the policy's
          // `human-authored` rule never fires for it.
          authorKind: await resolveAuthorKind(db, version.authorRef),
          state: snapshot?.genericState ?? 'pending',
          createdAt: new Date(version.createdAt),
          legacyPendingEditId: opts.legacyPendingEditId ?? null,
        });
        proposalId = identity.proposalId;
      }
    }

    const current = await adapter.loadCurrent(ref);
    const fingerprint = await adapter.fingerprint({
      proposal: version.payload,
      current,
    });
    const previous = await latestVersion(db, proposalId);
    if (previous?.payloadFingerprint === fingerprint) {
      return { ok: true, proposalId, versionId: previous.id, created: false };
    }

    const risk = await adapter.classifyRisk({ version, current });
    const appended = await appendVersion(db, {
      proposalId,
      payload: version.payload,
      payloadFingerprint: fingerprint,
      authorActorRef: version.authorRef ?? 'unknown',
      actorKind: await resolveAuthorKind(db, version.authorRef),
      riskProfile: risk,
      // The legacy stale-verdict token, carried so a legacy verdict can be
      // matched back to the generic version it was cast against.
      legacyReviewToken: version.targetVersion,
      submittedAt: new Date(version.createdAt),
    });

    // A new revision on an *open* row moves the projection with it.
    //
    // Appending a version used to leave the state alone, which was invisible
    // while every proposal was created `pending`: the projection was already
    // where a resubmission would put it. It stopped being invisible once a
    // proposal could start life `draft` or `returned` — a returned edit that is
    // revised and resubmitted goes `pending` in legacy while the projection
    // stays `returned`, and that is a `state_mismatch` the repair tool
    // explicitly cannot fix, standing between the migration and its exit gate.
    //
    // Only for a row legacy still holds open. A closed one is owned by whoever
    // closed it — `mirrorPublicationOutcome` for a live decision, the importer
    // for history — and reopening it here is the failure this module exists to
    // prevent.
    if (snapshot && !snapshot.closed && snapshot.genericState !== null) {
      const proposal = await getProposal(db, proposalId);
      if (proposal && proposal.state !== snapshot.genericState) {
        await setProposalState(db, proposalId, snapshot.genericState);
      }
    }
    return { ok: true, proposalId, versionId: appended.id, created: true };
  });
}

/**
 * Mirror a legacy row's current payload as a generic proposal version.
 *
 * Covers Phase 4 work items 1 and 2 in one operation: creating the proposal on
 * first sight and appending a version when the payload has moved. They are one
 * operation because the caller at a legacy seam cannot always tell which case
 * it is in — `recordVerification` upserts, `pending_edits` is revised in place —
 * and a hook that had to know would get it wrong exactly when it matters.
 */
export function mirrorProposalVersion(args: {
  targetType: string;
  targetId: number;
  legacyPendingEditId?: number | null;
}): Promise<MirrorOutcome> {
  return attemptMirror(args.targetType, 'proposal_version', async () => {
    const result = await ensureMirroredVersion(
      args.targetType,
      args.targetId,
      { legacyPendingEditId: args.legacyPendingEditId },
    );
    if (!result.ok) return { mirrored: false, skipped: result.skipped };
    return result.created
      ? { mirrored: true }
      : { mirrored: false, skipped: 'already_mirrored' };
  });
}

/**
 * Mirror an agent verdict as a generic assessment (work item 3).
 *
 * Bound to the proposal *version*, not to the target, whenever a version could
 * be mirrored. That is §8.3: an assessment names the payload it judged, so a
 * later revision cannot inherit it. Falling back to the target would quietly
 * produce the version-blind model the generic schema exists to replace, so the
 * fallback does not exist — no version, no assessment, and the reconciliation
 * scanner reports the gap.
 *
 * `capabilitySnapshot` carries `verifierTier`, the server-owned tier
 * `agent_verifications` snapshotted at verdict time. Re-reading the agent's
 * current tier here would reintroduce exactly the retroactive-reclassification
 * bug migration 0113 fixed.
 */
export function mirrorAssessment(args: {
  targetType: string;
  targetId: number;
  legacyVerificationId: number;
  actorRef: string;
  verdict: KgVerdict;
  rationaleMd?: string | null;
  model?: string | null;
  isImplicit?: boolean;
}): Promise<MirrorOutcome> {
  // The whole operation runs under the identity lock, not just its write. It
  // reads the legacy row, judges it against a generic version and records a
  // conclusion, and those three have to be one atomic view: mirrors are
  // dispatched after the legacy write without being awaited, so a mirror that
  // began before a revision can otherwise arrive after it and conclude about a
  // payload that no longer exists.
  return attemptMirror(args.targetType, 'assessment', async () =>
    withLegacyIdentityLock(args.targetType, args.targetId, async (db) => {
    const version = await ensureMirroredVersion(
      args.targetType,
      args.targetId,
    );
    if (!version.ok) return { mirrored: false, skipped: version.skipped };

    // Read the judgment back off the verdict row rather than taking it from the
    // caller. The tier especially: `recordVerification` stamps `verifier_tier`
    // inside the write, under a `FOR UPDATE` lock on the agents row, precisely
    // so a concurrent downgrade cannot leave a stale `flagship` on the verdict.
    // A tier the caller resolved separately would be that same stale read,
    // reintroduced one layer up. The rest is read here for the same reason in
    // miniature: the row is the thing being mirrored, so it is what the mirror
    // should copy.
    //
    // And held, not merely read. The identity lock covers the pending-edit row
    // and a cooperative advisory key; `recordVerification` upserts on
    // `(agent_id, target_type, target_id)` and takes neither, so two overlapping
    // verdict writes can interleave with this read. Under READ COMMITTED that
    // means capturing an approval, watching a dispute commit, and then writing
    // the approval — the same stale-snapshot defect the importer had, one layer
    // up, and invisible for the same reason: the legacy row stays linked, so
    // reconciliation reports it clean, and the second mirror that would have
    // corrected it is fire-and-forget.
    //
    // `OF agentVerifications` for the reason the importer records: the upsert
    // locks the agents row first, so taking agents here would invert the order
    // and deadlock rather than queue.
    const [verdictRow] = await db
      .select({
        verdict: agentVerifications.verdict,
        verifierTier: agentVerifications.verifierTier,
        rationaleMd: agentVerifications.rationaleMd,
        isImplicit: agentVerifications.isImplicit,
        // When the surviving verdict was written. The upsert moves this and
        // leaves `created_at` alone, which is what lets the branch below tell an
        // imported snapshot from a judgment recast since.
        updatedAt: agentVerifications.updatedAt,
      })
      .from(agentVerifications)
      .where(eq(agentVerifications.id, args.legacyVerificationId))
      .limit(1)
      .for('update', { of: agentVerifications });

    const verdict = (verdictRow?.verdict as KgVerdict | undefined) ?? args.verdict;
    const rationaleMd = verdictRow
      ? verdictRow.rationaleMd || null
      : args.rationaleMd || null;
    const implicit = verdictRow?.isImplicit ?? args.isImplicit ?? false;
    const capabilitySnapshot = canonicalSnapshot({
      assuranceCapabilities: tierCapabilities(verdictRow?.verifierTier),
    });

    const space = await ensureKinetixSpace(db);
    const existing = await findByLegacy(
      db,
      'agent_verification',
      args.legacyVerificationId,
    );

    if (existing) {
      // First, the case where the link names an assessment about a *different*
      // subject: a judgment imported as history, which the historical importer
      // records against the target when it cannot establish which version was
      // reviewed (§8.3), or one bound to an older version.
      //
      // Two opposite mistakes are available here, and the link alone
      // distinguishes neither, because `agent_verifications` upserts: one
      // legacy id covers both "the snapshot we imported" and "a verdict the
      // agent has since recast".
      //
      //   * Treating it as this version's assessment would promote a stale
      //     approval onto today's payload — exactly what the importer refused
      //     to do — and silently, since the supersede branch below reads only
      //     version-bound rows, finds none, and inserts a fresh one.
      //   * Treating the link as permanent proof would strand the row the other
      //     way: a `returned` edit imported as history, then resubmitted and
      //     genuinely re-judged, keeps the same legacy id, so every later
      //     verdict would be skipped and the generic side could never converge.
      //
      // What separates them is not recency. "Newer than the import" only says
      // the verdict moved at some point since; it says nothing about *which*
      // payload it judged, and the two come apart as soon as the row is revised
      // again with no further verdict — the recast approval is still newer than
      // the snapshot, and binding on that alone attaches it to a version its
      // author never saw. That is the promotion this branch exists to prevent,
      // arrived at by a different route.
      //
      // The question is the one the importer already asks, so it gets the same
      // answer from the same rule: a historical verdict may be bound only where
      // the source *proves* it judged the current revision — the row is still
      // open, and the surviving judgment is no older than the revision under
      // review. Anything else stays history, reported as unbindable rather than
      // as converged.
      const linked = await getAssessment(db, existing.genericId);
      const linkedElsewhere =
        linked !== null &&
        (linked.subjectType !== 'proposal_version' ||
          linked.subjectId !== version.versionId);
      if (linkedElsewhere) {
        const judgedAt = verdictRow?.updatedAt ?? null;
        const bindable =
          judgedAt !== null &&
          (await judgedThisVersion(db, {
            targetType: args.targetType,
            targetId: args.targetId,
            proposalId: version.proposalId,
            versionId: version.versionId,
            judgedAt,
          }));
        if (!bindable) return { mirrored: false, skipped: 'unbindable_history' };
      }

      // A link is NOT proof that the current verdict was mirrored.
      //
      // `recordVerification` upserts on `(agent_id, target_type, target_id)`,
      // so a reviewer that changes its mind rewrites the same row and keeps the
      // same legacy id. Treating any existing link as "already mirrored" left
      // the original assessment standing, and `linkageIsComplete` compares row
      // counts — one stale generic row still matches one legacy row — so under
      // `generic_read` an approve-to-dispute correction went on being served
      // from the withdrawn approval. That is the migration loosening a gate,
      // which §1.7 forbids in that direction specifically.
      //
      // So: compare, then supersede. `reviseAssessment` finds the actor's
      // current row for this version and points the new one at it, which is the
      // append-only way to record a change of mind (§5.7).
      const current =
        (
          await currentAssessments(db, {
            subjectType: 'proposal_version',
            subjectId: version.versionId,
          })
        ).find((a) => a.actorRef === args.actorRef) ?? null;

      const incoming = {
        verdict,
        rationaleMd,
        capabilitySnapshot: {
          modelTier: verdictRow?.verifierTier ?? null,
          isImplicit: implicit,
        },
      };
      if (current && assessmentMatches(current, incoming)) {
        return { mirrored: false, skipped: 'already_mirrored' };
      }

      await reviseAssessment(db, {
        spaceId: space.id,
        subjectType: 'proposal_version',
        subjectId: version.versionId,
        actorRef: args.actorRef,
        actorKind: 'agent',
        verdict,
        rationaleMd,
        capabilitySnapshot,
        // The canonical marker, in the column the generic schema has for it,
        // rather than a second copy inside the snapshot.
        ...(implicit ? { independenceGroup: AUTHOR_INDEPENDENCE_GROUP } : {}),
        modelMetadata: args.model ? { model: args.model } : null,
      });
      // Deliberately no second `linkLegacyRecord`: the store refuses two
      // generic records claiming one legacy row, and it is right to. The link
      // answers "was this legacy row ever mirrored?", which is still yes; the
      // supersession chain answers "what does it say now?".
      return { mirrored: true };
    }

    const assessment = await recordAssessment(db, {
      spaceId: space.id,
      subjectType: 'proposal_version',
      subjectId: version.versionId,
      actorRef: args.actorRef,
      actorKind: 'agent',
      verdict,
      rationaleMd,
      capabilitySnapshot,
      ...(implicit ? { independenceGroup: AUTHOR_INDEPENDENCE_GROUP } : {}),
      // Self-reported, audit-only (§2.3).
      modelMetadata: args.model ? { model: args.model } : null,
    });
    await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: assessment.id,
      legacyType: 'agent_verification',
      legacyId: args.legacyVerificationId,
    });
    return { mirrored: true };
    }),
  );
}


/**
 * Whether a verdict can be shown to have judged the version now current.
 *
 * `pending_edit` has a legacy lifecycle, and it is the authority for its own
 * rows: `versionBinding` reads the source's status and submission time
 * directly. Every other adapter — `paper_review`, `wiki_revision`,
 * `drug_parameter_revision`, `drug_discussion` — has no `pending_edits` row at
 * all, and `readLegacySnapshot` returns `null` for them.
 *
 * Asking only the legacy question therefore answered "unbindable" for those
 * types unconditionally, and permanently: a verdict `snapshotLegacyVerifications`
 * had linked target-level could never be re-bound after a recast, while
 * reconciliation went on accepting the link, so the generic side stayed stuck
 * on the historical judgment with nothing reporting it. That is the same
 * silence the version-binding rule exists to prevent, reached by having no rule
 * to apply rather than by applying a lax one.
 *
 * So the generic record answers where the legacy one cannot, and it is asked
 * the same two questions: is the proposal still open, and is the surviving
 * judgment no older than the revision under review. The version's own
 * `submittedAt` is that revision's time — it is what `appendVersion` records
 * from the source — and a terminal proposal is closed by definition.
 */
async function judgedThisVersion(
  db: GovernanceDb,
  args: {
    targetType: string;
    targetId: number;
    proposalId: number;
    versionId: number;
    judgedAt: Date;
  },
): Promise<boolean> {
  const snapshot = await readLegacySnapshot(db, args.targetType, args.targetId);
  if (snapshot !== null) {
    return versionBinding(snapshot, args.judgedAt) === 'established';
  }
  const proposal = await getProposal(db, args.proposalId);
  if (!proposal || isTerminalProposalState(proposal.state)) return false;
  const version = await latestVersion(db, args.proposalId);
  if (!version || version.id !== args.versionId) return false;
  const revisedAt = version.submittedAt ?? version.createdAt;
  return args.judgedAt.getTime() >= revisedAt.getTime();
}

/**
 * Mirror a human approval stamp as an assessment (work item 4).
 *
 * `approvals` rows are the human half of Kinetix's assurance: a moderator or
 * editor endorsing a revision. They are not agent verdicts and do not live in
 * `agent_verifications`, so nothing else in this module would ever see them —
 * and a generic assurance profile built without them under-reports the
 * verification level of every value a person has signed off. A badge that
 * under-reports review tells a reader a verified value is unverified, which is
 * worse than no badge.
 *
 * Recorded with `actorKind: 'human'`, which is what
 * `projectKinetixVerificationLevel` reads to decide `hasHumanApprover`.
 */
export function mirrorHumanApproval(args: {
  targetType: string;
  targetId: number;
  legacyApprovalId: number;
  actorRef: string;
}): Promise<MirrorOutcome> {
  return attemptMirror(args.targetType, 'human_approval', async (db) => {
    const existing = await findByLegacy(db, 'approval', args.legacyApprovalId);
    if (existing) return { mirrored: false, skipped: 'already_mirrored' };

    const version = await ensureMirroredVersion(
      args.targetType,
      args.targetId,
    );
    if (!version.ok) return { mirrored: false, skipped: version.skipped };

    const space = await ensureKinetixSpace(db);
    const assessment = await recordAssessment(db, {
      spaceId: space.id,
      subjectType: 'proposal_version',
      subjectId: version.versionId,
      actorRef: args.actorRef,
      actorKind: 'human',
      verdict: 'approve',
      // A stamp carries no rationale and no model. It is an endorsement, not a
      // review with reasoning attached, and recording an empty one as though it
      // had reasoning would overstate what happened.
      capabilitySnapshot: canonicalSnapshot({ host: { source: 'approval_stamp' } }),
    });
    await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: assessment.id,
      legacyType: 'approval',
      legacyId: args.legacyApprovalId,
    });
    return { mirrored: true };
  });
}

/** Mirror a legacy dispute (work item 5). */
export function mirrorDispute(args: {
  targetType: string;
  targetId: number;
  legacyDisputeId: number;
  openedByActorRef: string;
  openedByKind: string;
  reasonMd?: string | null;
}): Promise<MirrorOutcome> {
  return attemptMirror(args.targetType, 'dispute', async (db) => {
    const existing = await findByLegacy(db, 'dispute', args.legacyDisputeId);
    if (existing) return { mirrored: false, skipped: 'already_mirrored' };

    const version = await ensureMirroredVersion(
      args.targetType,
      args.targetId,
    );
    if (!version.ok) return { mirrored: false, skipped: version.skipped };

    const space = await ensureKinetixSpace(db);
    const dispute = await openDispute(db, {
      spaceId: space.id,
      subjectType: 'proposal_version',
      subjectId: version.versionId,
      openedByActorRef: args.openedByActorRef,
      openedByKind: args.openedByKind,
      reasonMd: args.reasonMd ?? null,
    });
    await linkLegacyRecord(db, {
      genericType: 'dispute',
      genericId: dispute.id,
      legacyType: 'dispute',
      legacyId: args.legacyDisputeId,
    });
    return { mirrored: true };
  });
}

/**
 * Mirror a dispute ruling (work item 5).
 *
 * Requires the dispute itself to have been mirrored: a ruling with no dispute
 * to attach to is not something to invent one for. If the dispute mirror was
 * lost, the scanner reports it and the repair creates both in order.
 */
export function mirrorDisputeRuling(args: {
  targetType: string;
  legacyDisputeId: number;
  ruling: KgDisputeRulingKind;
  actorRef: string;
  rationaleMd?: string | null;
}): Promise<MirrorOutcome> {
  return attemptMirror(args.targetType, 'dispute_ruling', async (db) => {
    const link = await findByLegacy(db, 'dispute', args.legacyDisputeId);
    if (!link) return { mirrored: false, skipped: 'no_row' };
    await recordRuling(db, {
      disputeId: link.genericId,
      ruling: args.ruling,
      actorRef: args.actorRef,
      rationaleMd: args.rationaleMd ?? null,
    });
    return { mirrored: true };
  });
}

/**
 * Mirror what ultimately happened to a proposal (work item 6).
 *
 * Recorded against the version that was current when the outcome occurred, so
 * "which payload was applied?" is answerable from the record rather than by
 * assuming the newest one.
 */
export function mirrorPublicationOutcome(args: {
  targetType: string;
  targetId: number;
  action: KgPublicationAction;
  actorRef: string;
  appliedRevisionRef?: string | null;
}): Promise<MirrorOutcome> {
  return attemptMirror(args.targetType, 'publication', async (db) => {
    const link = await findByLegacy(db, args.targetType, args.targetId);
    if (!link) return { mirrored: false, skipped: 'no_row' };
    const version = await latestVersion(db, link.genericId);
    if (!version) return { mirrored: false, skipped: 'no_row' };
    await recordPublicationEvent(db, {
      proposalVersionId: version.id,
      action: args.action,
      actorRef: args.actorRef,
      appliedRevisionRef: args.appliedRevisionRef ?? null,
    });
    // The event is written first and is what survives; moving the projection
    // is bookkeeping over it. `setProposalState` derives `closed_at` from the
    // state, so an applied or rejected proposal also leaves the open-proposals
    // index here rather than lingering in a queue of things already decided.
    await setProposalState(
      db,
      link.genericId,
      STATE_AFTER_PUBLICATION[args.action],
    );
    return { mirrored: true };
  });
}

/**
 * Fire a mirror without waiting for it.
 *
 * The form the legacy seams use. `attemptMirror` already guarantees the promise
 * never rejects, so there is no floating rejection to handle — but the
 * discarded promise is named here rather than left as a bare expression so the
 * intent ("deliberately not awaited") is visible at every call site.
 */
export function fireAndForgetMirror(operation: Promise<MirrorOutcome>): void {
  void operation;
}
