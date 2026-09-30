/**
 * Backfill into the generic schema (Phase 3, "Backfill" of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * The plan is deliberately narrow about what may be created: the Kinetix space,
 * target identities *as needed*, and current-state legacy snapshots carrying
 * explicit incomplete-history provenance. Nothing here walks the whole database.
 *
 * ## Why the snapshots say they are snapshots
 *
 * §6 forbids fabricating historical fidelity, and Kinetix genuinely cannot
 * supply it: `agent_verifications` upserts on
 * `(agent_id, target_type, target_id)`, so when an agent changed its verdict the
 * earlier judgment was overwritten and is gone. There is no sequence to import,
 * only a final state.
 *
 * So every imported assessment is stamped `origin: 'legacy_snapshot'` with
 * `historicalCompleteness: 'current_state_only'`, and imported rows never claim
 * a supersession chain — inferring that "this approval replaced an earlier
 * dispute" from a row that no longer exists would be inventing the exact
 * history the append-only model was built to stop guessing at. Reporting code
 * can then separate reconstructed state from native history by looking at the
 * record rather than at a cutover timestamp.
 *
 * The judgment time is carried over from the legacy row: when the verdict was
 * cast is a fact Kinetix does still have. What it does not have is what came
 * before. The time taken is `updated_at` — the upsert keeps `created_at` from
 * the first judgment, so on a row an agent revised, `created_at` dates a verdict
 * that is gone. Both are recorded in the provenance, where the difference is
 * exactly the incompleteness being declared.
 *
 * These snapshots are recorded against the **target**, not against a proposal
 * version, and their provenance says `versionBinding: 'unestablished'` so a
 * reader cannot mistake one for evidence about a particular payload (§8.3).
 * Establishing which version a historical verdict judged is the historical
 * importer's job (`historical-import.ts`), and it can only do it where the
 * source row proves it.
 *
 * Every function here is idempotent. Re-running the backfill writes nothing
 * new — proven by `tests/governance/store/backfill.test.ts`, which runs it
 * twice and compares row counts.
 */

import { and, eq } from 'drizzle-orm';
import { getDb, inTransaction, isInPoolTransaction } from '../db.js';
import {
  AUTHOR_INDEPENDENCE_GROUP,
  canonicalSnapshot,
} from './store/capability-snapshot.js';
import { tierCapabilities } from './kinetix-compat.js';
import { agentVerifications, agents } from '../../../db/schema.js';
import { KINETIX_SPACE } from './actor-context.js';
import { recordAuditEvent } from './store/audit.js';
import { recordAssessment } from './store/assessments.js';
import { ensureSpace, ensureTarget } from './store/spaces.js';
import { findByLegacy, linkLegacyRecord } from './store/legacy-links.js';
import {
  legacyProvenance,
  type GovernanceDb,
  type SpaceRecord,
  type TargetRecord,
} from './store/interface.js';
import type { TargetRef } from 'assurance-core';

/** The policy set Kinetix's space evaluates under (Phase 1). */
export const KINETIX_POLICY_VERSION = 'kinetix-consensus@v1';

/**
 * Create the Kinetix space if it is missing.
 *
 * The one row the whole generic schema needs before anything else can exist,
 * and the only thing this module creates unconditionally.
 */
export async function ensureKinetixSpace(
  db: GovernanceDb = getDb(),
): Promise<SpaceRecord> {
  return ensureSpace(db, {
    slug: KINETIX_SPACE,
    name: 'Kinetix',
    activePolicyVersion: KINETIX_POLICY_VERSION,
  });
}

/**
 * The generic target key for one Kinetix verification target.
 *
 * `<type>:<id>` rather than the plan's richer examples
 * (`drug:123:param:halfLife`): Kinetix's unit of review is the row, and its id
 * is what every verdict, queue item and dispute already names. A composite key
 * would have to be derived from the row's contents, which makes it change when
 * the row changes — and a target identity that moves is not an identity.
 */
export function kinetixTargetKey(ref: Pick<TargetRef, 'type' | 'id'>): string {
  return `${ref.type}:${ref.id}`;
}

/** Create the target identity for one Kinetix row, on demand. */
export async function ensureKinetixTarget(
  db: GovernanceDb,
  ref: Pick<TargetRef, 'type' | 'id'>,
  space?: SpaceRecord,
): Promise<TargetRecord> {
  const kinetix = space ?? (await ensureKinetixSpace(db));
  return ensureTarget(db, {
    spaceId: kinetix.id,
    targetType: ref.type,
    targetKey: kinetixTargetKey(ref),
  });
}

export interface SnapshotResult {
  readonly targetId: number;
  readonly imported: number;
  readonly skipped: number;
}

/**
 * Import the current effective agent verdicts for one target as assessments.
 *
 * Scoped to a single target on purpose — the plan says not to run a giant
 * speculative backfill, and a per-target import is what the shadow-write phases
 * actually need: mirror what you are about to reason about, nothing else.
 *
 * Implicit rows are imported too, and marked as such in the capability
 * snapshot. They are not peer review — an implicit approve is written by the
 * API when an agent submits its own work — but they exist in the legacy state,
 * and dropping them would make the snapshot disagree with what Kinetix's own
 * tally sees.
 *
 * Idempotent through `kg_legacy_links`: a verdict already linked to an
 * assessment is skipped rather than re-imported, so re-running produces no new
 * rows.
 */
export async function snapshotLegacyVerifications(
  db: GovernanceDb,
  ref: Pick<TargetRef, 'type' | 'id'>,
  opts: { capturedAt?: Date } = {},
): Promise<SnapshotResult> {
  // One unit of work, with the verdicts held across it, for the same two
  // reasons the historical importer states.
  //
  // The clock first: `capturedAt` was read before the rows were, so a verdict
  // recast in between was recorded with a `sourceJudgedAt` later than the
  // `capturedAt` beside it — a snapshot claiming to have observed a judgment
  // before it existed. And the link second: a recast after the read leaves the
  // obsolete verdict linked, and a link is what every later reader takes for
  // "this legacy row is mirrored", so nothing comes back for it.
  //
  // The handle argument still means what it meant: a caller inside a
  // transaction passes its own, and that is what gets used. `inTransaction`
  // joins that transaction rather than opening a second one. A caller that is
  // not transactional has no handle worth honouring here — the lock needs a
  // transaction to live in — so it gets the handle of the one opened for it.
  //
  // Asked *before* entering, deliberately: inside the callback
  // `isInPoolTransaction()` is true either way, so testing it there would
  // always pick the argument — including when the argument is the base
  // connection and the transaction is somewhere else entirely. On the
  // single-connection test harness that is not a subtle mistake, it is a hang.
  const joined = isInPoolTransaction();
  return inTransaction(async () => {
    const tx = joined ? db : getDb();
    const capturedIds = await lockLegacyVerdictsForTarget(tx, ref);
    const capturedAt = opts.capturedAt ?? new Date();
    return snapshotUnderLock(tx, ref, capturedAt, capturedIds);
  });
}

/**
 * Hold every verdict on one target for the life of the transaction, and say
 * which ones they were.
 *
 * `FOR UPDATE` holds the rows that exist, not the predicate, so a verdict
 * inserted afterwards is not excluded — and would otherwise be read below and
 * filed under a `capturedAt` that predates it. The returned ids are the set
 * this snapshot describes; a later arrival has no link, so reconciliation
 * reports it until something mirrors it.
 */
async function lockLegacyVerdictsForTarget(
  db: GovernanceDb,
  ref: Pick<TargetRef, 'type' | 'id'>,
): Promise<readonly number[]> {
  // `OF agentVerifications`: `recordVerification` takes `FOR UPDATE` on the
  // agents row inside its upsert, so locking a joined agents row here would
  // take the two in the opposite order and deadlock instead of queueing.
  const rows = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, ref.type),
        eq(agentVerifications.targetId, Number(ref.id)),
      ),
    )
    .for('update', { of: agentVerifications });
  return rows.map((r) => r.id);
}

async function snapshotUnderLock(
  db: GovernanceDb,
  ref: Pick<TargetRef, 'type' | 'id'>,
  capturedAt: Date,
  capturedIds: readonly number[],
): Promise<SnapshotResult> {
  const space = await ensureKinetixSpace(db);
  const target = await ensureKinetixTarget(db, ref, space);

  const rows = await db
    .select({
      id: agentVerifications.id,
      agentId: agentVerifications.agentId,
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
        eq(agentVerifications.targetType, ref.type),
        eq(agentVerifications.targetId, Number(ref.id)),
      ),
    );

  const captured = new Set(capturedIds);
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    // Only what was held when the clock was read; see the lock helper above.
    if (!captured.has(row.id)) continue;
    const existing = await findByLegacy(db, 'agent_verification', row.id);
    if (existing) {
      skipped += 1;
      continue;
    }
    const assessment = await recordAssessment(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      actorRef: `user:${row.agentUserId}`,
      actorKind: 'agent',
      verdict: row.verdict as 'approve' | 'dispute' | 'abstain',
      rationaleMd: row.rationaleMd || null,
      // The implicit marker in the column the generic schema has for it,
      // rather than a second copy inside the snapshot.
      ...(row.isImplicit ? { independenceGroup: AUTHOR_INDEPENDENCE_GROUP } : {}),
      capabilitySnapshot: canonicalSnapshot({
        // The server-owned tier as it stood when the verdict was admitted —
        // migration 0113's column, not the agent's current tier. It becomes
        // the capability a gate reads, which is the one the live path derives,
        // so a backfilled row and a native one qualify identically.
        assuranceCapabilities: tierCapabilities(row.verifierTier),
        host: {
          agentSlug: row.agentSlug,
          provenance: {
            ...legacyProvenance(capturedAt, {
              type: 'agent_verification',
              id: row.id,
            }),
            // Target-level by construction: this import reads verdicts by
            // `(target_type, target_id)` and never establishes which proposal
            // *version* each one judged, so saying so on the record is what
            // stops a later reader treating one as version-bound evidence. The
            // historical importer is the path that can establish a binding, and
            // it stamps `established` when it does.
            versionBinding: 'unestablished',
            versionBindingReason: 'target_level_snapshot',
            boundVersionId: null,
            sourceJudgedAt: (row.updatedAt ?? row.createdAt).toISOString(),
            sourceFirstJudgedAt: row.createdAt.toISOString(),
          },
        },
      }),
      // Self-reported, audit-only (§2.3).
      modelMetadata: row.model ? { model: row.model } : null,
      // Deliberately null: §6.4 forbids inferring that a current approval
      // replaced an earlier dispute when that history no longer exists.
      supersedesAssessmentId: null,
      // When the surviving verdict was cast — a fact Kinetix still holds, and
      // the column default would replace it with the import time, renumbering
      // the audit chronology so that every historical judgment appeared to have
      // been made the day the backfill ran.
      //
      // `updated_at`, not `created_at`: `recordVerification` upserts, keeping
      // the first judgment's `created_at` while moving `updated_at`. On a row
      // the agent changed its mind about, `created_at` belongs to a verdict that
      // no longer exists. Both go into the provenance above; this column carries
      // the one the row actually holds.
      at: row.updatedAt ?? row.createdAt,
    });
    await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: assessment.id,
      legacyType: 'agent_verification',
      legacyId: row.id,
    });
    imported += 1;
  }

  // Only when something was actually imported. An audit row per no-op re-run
  // would make the audit log grow every time the backfill is re-checked, and
  // would break the property the exit gate asks for: a second run writes
  // nothing.
  if (imported > 0) {
    await recordAuditEvent(db, {
      spaceId: space.id,
      eventType: 'legacy_snapshot_imported',
      subjectType: 'target',
      subjectId: target.id,
      payload: {
        ...legacyProvenance(capturedAt),
        legacyTargetType: ref.type,
        legacyTargetId: Number(ref.id),
        imported,
        skipped,
      },
    });
  }

  return { targetId: target.id, imported, skipped };
}
