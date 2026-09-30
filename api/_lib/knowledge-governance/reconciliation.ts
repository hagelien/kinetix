/**
 * The reconciliation scanner (§12.2, Phase 4 work item 8).
 *
 * Shadow mirroring is allowed to fail — §12.1 requires that a mirror failure
 * never rejects a valid Kinetix action — so something has to find what the
 * mirroring missed. This is that something, and it is what the Phase 4 exit
 * gate is actually measured with: "unexplained mirror loss = 0 after
 * reconciliation" is a claim about what this scanner reports, not about what a
 * counter in a warm serverless instance happened to observe.
 *
 * It is deterministic and read-only. Every finding is derived by comparing
 * legacy state to generic state; nothing is inferred from a heuristic, and
 * nothing is repaired here. Repair is a separate, deliberate action — a scanner
 * that silently fixed what it found would destroy the evidence that mirroring
 * is unreliable, which is the one thing the gate needs to see.
 *
 * §12.2 names six divergence classes and all six are implemented:
 *
 *   1. `missing_proposal`     legacy pending edits with no generic proposal
 *   2. `missing_assessment`   legacy verdicts with no mirrored assessment
 *   3. `orphaned_proposal`    generic proposals whose legacy row is gone
 *   4. `fingerprint_mismatch` the payload moved without a new version
 *   5. `state_mismatch`       the projection disagrees with legacy status
 *   6. `missing_publication`  an applied edit with no publication event
 */

import { and, eq, gt, inArray } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  kgLegacyLinks,
  kgProposals,
  pendingEdits,
} from '../../../db/schema.js';
import { KINETIX_SPACE } from './actor-context.js';
import { incrementMetric } from './metrics.js';
import { findKnowledgeTargetAdapter } from './registry.js';
import { registerKinetixAdapters } from './adapters/kinetix/index.js';
import { findSpace } from './store/spaces.js';
import { latestVersion } from './store/versions.js';
import { listPublicationEvents } from './store/decisions.js';
import {
  importedAsAlreadyApplied,
  projectLegacyState,
} from './historical-import.js';
import type { GovernanceDb } from './store/interface.js';

export type DivergenceClass =
  | 'missing_proposal'
  | 'missing_assessment'
  | 'orphaned_proposal'
  | 'fingerprint_mismatch'
  | 'state_mismatch'
  | 'missing_publication';

export interface Divergence {
  readonly kind: DivergenceClass;
  readonly targetType: string;
  /** The legacy row's id, when the finding is about one. */
  readonly legacyId?: number;
  /** The generic row's id, when the finding is about one. */
  readonly genericId?: number;
  readonly detail: string;
}

/**
 * Where a scan stopped, so the next one can start after it.
 *
 * Each field is the highest id examined by its scan. Absent means "start from
 * the beginning", which is what a first page wants.
 */
export interface ReconciliationCursor {
  readonly pendingEditId?: number;
  readonly verificationId?: number;
  readonly proposalId?: number;
}

export interface ReconciliationReport {
  readonly divergences: readonly Divergence[];
  readonly counts: Readonly<Record<DivergenceClass, number>>;
  /** How many legacy rows of each kind were examined, so a clean report is legible. */
  readonly examined: Readonly<{ pendingEdits: number; verifications: number; proposals: number }>;
  /**
   * True when at least one scan filled its limit, so there may be more rows it
   * never looked at.
   *
   * This is the difference between "found nothing" and "found nothing here",
   * and the exit gate depends on it: a scan that covered the oldest 500 rows of
   * a 50,000-row table and reported zero divergences reads exactly like a scan
   * that covered everything, and the gate would call the migration lossless on
   * the strength of it.
   */
  readonly truncated: boolean;
  /** Where to resume, or `null` when the scan reached the end of every table. */
  readonly nextCursor: ReconciliationCursor | null;
}

function emptyCounts(): Record<DivergenceClass, number> {
  return {
    missing_proposal: 0,
    missing_assessment: 0,
    orphaned_proposal: 0,
    fingerprint_mismatch: 0,
    state_mismatch: 0,
    missing_publication: 0,
  };
}

// How a legacy row should show up in the generic projection (`draft`→`draft`,
// `approved`→`applied`, and so on; `returned` is deliberately not terminal on
// either side, because a returned edit is expected to come back). It is a
// function of the row rather than of `status` alone — a submitter's withdrawal
// is stored as `rejected` too, and only `reviewed_by === submitted_by` tells
// the two apart. The projection lives with the historical importer, which has
// to apply the same rule when it writes the records this scanner then checks:
// a rule one side applies and the other does not is a `state_mismatch` on every
// row it touches.

/**
 * Scan for every divergence class.
 *
 * `limit` bounds each query so the scanner can run against production
 * read-only data without reading the whole table. When it truncates it says so
 * in `examined`, because a report that silently covered the first 500 rows and
 * found nothing reads exactly like a report that covered everything and found
 * nothing.
 */
export async function reconcile(
  db: GovernanceDb,
  opts: { limit?: number; space?: string; after?: ReconciliationCursor } = {},
): Promise<ReconciliationReport> {
  registerKinetixAdapters();
  const limit = opts.limit ?? 500;
  const spaceSlug = opts.space ?? KINETIX_SPACE;
  const after = opts.after;
  const divergences: Divergence[] = [];
  const counts = emptyCounts();

  const add = (d: Divergence) => {
    divergences.push(d);
    counts[d.kind] += 1;
  };

  const space = await findSpace(db, spaceSlug);
  if (!space) {
    // No space means nothing was ever mirrored, which is a valid state (the
    // migration has not been turned on). Reporting every legacy row as missing
    // would be noise, not a finding.
    return {
      divergences: [],
      counts,
      examined: { pendingEdits: 0, verifications: 0, proposals: 0 },
      truncated: false,
      nextCursor: null,
    };
  }

  // ── 1. Legacy pending edits with no generic proposal ────────────────────
  const edits = await db
    .select({
      id: pendingEdits.id,
      status: pendingEdits.status,
    })
    .from(pendingEdits)
    .where(
      after?.pendingEditId === undefined
        ? undefined
        : gt(pendingEdits.id, after.pendingEditId),
    )
    .orderBy(pendingEdits.id)
    .limit(limit);

  const editLinks = edits.length
    ? await db
        .select({
          legacyId: kgLegacyLinks.legacyId,
          genericId: kgLegacyLinks.genericId,
        })
        .from(kgLegacyLinks)
        .where(
          and(
            eq(kgLegacyLinks.legacyType, 'pending_edit'),
            inArray(
              kgLegacyLinks.legacyId,
              edits.map((e) => e.id),
            ),
          ),
        )
    : [];
  const proposalByEdit = new Map(editLinks.map((l) => [l.legacyId, l.genericId]));

  for (const edit of edits) {
    if (!proposalByEdit.has(edit.id)) {
      add({
        kind: 'missing_proposal',
        targetType: 'pending_edit',
        legacyId: edit.id,
        detail: `pending_edit#${edit.id} (status=${edit.status}) has no generic proposal`,
      });
    }
  }

  // ── 2. Legacy verdicts with no mirrored assessment ──────────────────────
  const verdicts = await db
    .select({
      id: agentVerifications.id,
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
      agentSlug: agents.slug,
    })
    .from(agentVerifications)
    .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(
      after?.verificationId === undefined
        ? undefined
        : gt(agentVerifications.id, after.verificationId),
    )
    .orderBy(agentVerifications.id)
    .limit(limit);

  const verdictLinks = verdicts.length
    ? await db
        .select({ legacyId: kgLegacyLinks.legacyId })
        .from(kgLegacyLinks)
        .where(
          and(
            eq(kgLegacyLinks.legacyType, 'agent_verification'),
            inArray(
              kgLegacyLinks.legacyId,
              verdicts.map((v) => v.id),
            ),
          ),
        )
    : [];
  const mirroredVerdicts = new Set(verdictLinks.map((l) => l.legacyId));

  for (const verdict of verdicts) {
    // Only target types that have an adapter can be mirrored at all; reporting
    // the others would be reporting a decision, not a loss.
    if (!findKnowledgeTargetAdapter(spaceSlug, verdict.targetType)) continue;
    if (!mirroredVerdicts.has(verdict.id)) {
      add({
        kind: 'missing_assessment',
        targetType: verdict.targetType,
        legacyId: verdict.id,
        detail:
          `agent_verification#${verdict.id} by ${verdict.agentSlug} on ` +
          `${verdict.targetType}#${verdict.targetId} has no mirrored assessment`,
      });
    }
  }

  // ── 3-6. Generic proposals checked back against legacy ──────────────────
  const proposals = await db
    .select({
      id: kgProposals.id,
      state: kgProposals.state,
      closedAt: kgProposals.closedAt,
      legacyPendingEditId: kgProposals.legacyPendingEditId,
    })
    .from(kgProposals)
    .where(
      after?.proposalId === undefined
        ? eq(kgProposals.spaceId, space.id)
        : and(eq(kgProposals.spaceId, space.id), gt(kgProposals.id, after.proposalId)),
    )
    .orderBy(kgProposals.id)
    .limit(limit);

  const proposalLinks = proposals.length
    ? await db
        .select({
          genericId: kgLegacyLinks.genericId,
          legacyType: kgLegacyLinks.legacyType,
          legacyId: kgLegacyLinks.legacyId,
        })
        .from(kgLegacyLinks)
        .where(
          and(
            eq(kgLegacyLinks.genericType, 'proposal'),
            inArray(
              kgLegacyLinks.genericId,
              proposals.map((p) => p.id),
            ),
          ),
        )
    : [];
  const linkByProposal = new Map(proposalLinks.map((l) => [l.genericId, l]));

  for (const proposal of proposals) {
    const link = linkByProposal.get(proposal.id);
    if (!link) {
      add({
        kind: 'orphaned_proposal',
        targetType: 'unknown',
        genericId: proposal.id,
        detail: `kg_proposal#${proposal.id} has no legacy link`,
      });
      continue;
    }

    const adapter = findKnowledgeTargetAdapter(spaceSlug, link.legacyType);
    if (!adapter) continue;
    const ref = {
      space: spaceSlug,
      type: link.legacyType,
      id: String(link.legacyId),
    };
    // `includeHidden`, matching the mirror: this asks "does the legacy row
    // still exist", not "may a reviewer see it". Without it every mirrored
    // `wiki_new` proposal would be reported as orphaned.
    const version = await adapter.loadVersion(ref, { includeHidden: true });

    // ── 3. the legacy row is gone ──
    if (!version) {
      add({
        kind: 'orphaned_proposal',
        targetType: link.legacyType,
        genericId: proposal.id,
        legacyId: link.legacyId,
        detail:
          `kg_proposal#${proposal.id} points at ${link.legacyType}#${link.legacyId}, ` +
          'which no longer exists or is no longer visible',
      });
      continue;
    }

    const mirroredVersion = await latestVersion(db, proposal.id);
    if (!mirroredVersion) {
      add({
        kind: 'missing_proposal',
        targetType: link.legacyType,
        genericId: proposal.id,
        legacyId: link.legacyId,
        detail: `kg_proposal#${proposal.id} has no versions`,
      });
      continue;
    }

    // ── 4. the payload moved without a new version ──
    //
    // Only while the proposal is still open. This class exists to catch a
    // *silently lost mirror of something still under review*: the row is
    // linked, the projection looks fine, but what a reviewer would be handed
    // today is not what the newest mirrored version says.
    //
    // Once a proposal is closed that comparison stops meaning anything. The
    // Kinetix payload includes the row's moderation status — deliberately, and
    // the legacy stale-verdict token folds it in for the same reason — so
    // approving an edit necessarily changes its fingerprint. Reporting that as
    // a lost mirror would mark every applied edit permanently divergent, and
    // "unexplained mirror loss = 0" could never be reached. The version that
    // was reviewed is the one the publication event names, and it is a
    // historical record, not a stale copy of a live row.
    const current = await adapter.loadCurrent(ref);
    const fingerprint = await adapter.fingerprint({
      proposal: version.payload,
      current,
    });
    if (proposal.closedAt === null && fingerprint !== mirroredVersion.payloadFingerprint) {
      incrementMetric('kg_payload_fingerprint_mismatch_total', link.legacyType);
      add({
        kind: 'fingerprint_mismatch',
        targetType: link.legacyType,
        genericId: proposal.id,
        legacyId: link.legacyId,
        detail:
          `${link.legacyType}#${link.legacyId} now fingerprints ${fingerprint}, ` +
          `but the newest mirrored version is ${mirroredVersion.payloadFingerprint}`,
      });
    }

    if (link.legacyType !== 'pending_edit') continue;

    const [legacyEdit] = await db
      .select({
        status: pendingEdits.status,
        reviewedBy: pendingEdits.reviewedBy,
        submittedBy: pendingEdits.submittedBy,
      })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, link.legacyId))
      .limit(1);
    if (!legacyEdit) continue;

    // ── 5. the projection disagrees with legacy status ──
    const expected = projectLegacyState(legacyEdit);
    if (expected && proposal.state !== expected) {
      incrementMetric('kg_state_projection_mismatch_total', link.legacyType);
      add({
        kind: 'state_mismatch',
        targetType: link.legacyType,
        genericId: proposal.id,
        legacyId: link.legacyId,
        detail:
          `pending_edit#${link.legacyId} is '${legacyEdit.status}' but ` +
          `kg_proposal#${proposal.id} projects '${proposal.state}' (expected '${expected}')`,
      });
    }

    // ── 6. an applied edit with no publication event ──
    //
    // With one narrow exception: a version that was **explicitly imported as
    // already applied** reconciles against its recorded legacy outcome without
    // one. A publication event asserts that this engine published something,
    // and for an edit approved years before the generic tables existed that
    // assertion would be false — which is why repair refuses to manufacture one
    // and why the exception is an *acceptance of recorded evidence* rather than
    // a fabrication of the event.
    //
    // `importedAsAlreadyApplied` is what keeps it narrow. It demands a
    // well-formed import record naming this exact version and this exact legacy
    // row, captured as a closed `approved` outcome, whose captured state and
    // stale-verdict token still match what legacy says now. Missing, malformed,
    // mismatched or stale provenance all leave the finding standing, as do a
    // native record, a later version of an imported proposal, and a proposal
    // imported open and published afterwards.
    if (legacyEdit.status === 'approved') {
      const events = await listPublicationEvents(db, mirroredVersion.id);
      if (!events.some((e) => e.action === 'applied')) {
        const historical = await importedAsAlreadyApplied(db, {
          versionId: mirroredVersion.id,
          legacyType: link.legacyType,
          legacyId: link.legacyId,
          legacyStatus: legacyEdit.status,
          versionToken: mirroredVersion.legacyReviewToken,
          // What the row projects *now*, read a few lines above. A record whose
          // captured token no longer matches describes a revision that has been
          // replaced, and stops being evidence about this one.
          sourceToken: version.targetVersion,
        });
        if (!historical.ok) {
          add({
            kind: 'missing_publication',
            targetType: link.legacyType,
            genericId: proposal.id,
            legacyId: link.legacyId,
            detail:
              `pending_edit#${link.legacyId} was approved but its mirrored version ` +
              `has no 'applied' publication event (${historical.reason})`,
          });
        }
      }
    }
  }

  // Broken down by divergence class rather than by target type: "what kind of
  // loss is happening" is the question the exit gate asks, and the target type
  // is already on every individual finding.
  for (const kind of Object.keys(counts) as DivergenceClass[]) {
    if (counts[kind] > 0) {
      incrementMetric('kg_reconciliation_missing_total', kind, counts[kind]);
    }
  }

  // A scan that filled its limit may have left rows behind it. Reported per
  // scan and then OR'd, because any one of the three being short is enough to
  // make "zero divergences" a statement about a window rather than a table.
  const truncated =
    edits.length === limit ||
    verdicts.length === limit ||
    proposals.length === limit;

  return {
    divergences,
    counts,
    examined: {
      pendingEdits: edits.length,
      verifications: verdicts.length,
      proposals: proposals.length,
    },
    truncated,
    nextCursor: truncated
      ? {
          // Carry the previous cursor forward for a scan that already finished:
          // resuming it from `undefined` would restart it at row one and loop.
          pendingEditId: edits.at(-1)?.id ?? after?.pendingEditId,
          verificationId: verdicts.at(-1)?.id ?? after?.verificationId,
          proposalId: proposals.at(-1)?.id ?? after?.proposalId,
        }
      : null,
  };
}

/** The default page size for {@link reconcileAll}. */
export const RECONCILE_PAGE_SIZE = 500;

/**
 * How many pages {@link reconcileAll} will walk before giving up.
 *
 * A bound rather than an unbounded loop: this runs against production, and a
 * scanner that walked a table forever because something kept appending to it
 * would be an outage rather than an audit. At the default page size this covers
 * 100,000 rows of each kind, and stopping short is reported rather than
 * silently accepted.
 */
export const RECONCILE_MAX_PAGES = 200;

export interface FullReconciliationReport extends ReconciliationReport {
  /** How many pages were walked. */
  readonly pages: number;
  /**
   * True when every table was read to its end.
   *
   * `false` means the page bound was hit, and the divergence counts below are
   * a floor rather than a total. The Phase 4 exit gate — "unexplained mirror
   * loss = 0 after reconciliation" — is a claim that cannot be made from an
   * incomplete scan, so the gate reads this before it reads the counts.
   */
  readonly complete: boolean;
}

/**
 * Walk every page and merge the findings.
 *
 * `reconcile` is one window by design: it exists so an operator can look at a
 * bounded slice cheaply. But the exit gate is not an operator glancing at a
 * slice — it is a claim about a whole table, and the single-window form cannot
 * support it. Anything that gates on "no divergences" uses this.
 */
export async function reconcileAll(
  db: GovernanceDb,
  opts: { limit?: number; space?: string; maxPages?: number } = {},
): Promise<FullReconciliationReport> {
  const limit = opts.limit ?? RECONCILE_PAGE_SIZE;
  const maxPages = opts.maxPages ?? RECONCILE_MAX_PAGES;

  const divergences: Divergence[] = [];
  const counts = emptyCounts();
  const examined = { pendingEdits: 0, verifications: 0, proposals: 0 };
  let cursor: ReconciliationCursor | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const page = await reconcile(db, {
      limit,
      space: opts.space,
      after: cursor,
    });
    pages += 1;
    divergences.push(...page.divergences);
    for (const kind of Object.keys(counts) as DivergenceClass[]) {
      counts[kind] += page.counts[kind];
    }
    examined.pendingEdits += page.examined.pendingEdits;
    examined.verifications += page.examined.verifications;
    examined.proposals += page.examined.proposals;
    truncated = page.truncated;
    cursor = page.nextCursor ?? undefined;
  } while (truncated && pages < maxPages);

  return {
    divergences,
    counts,
    examined,
    truncated,
    nextCursor: cursor ?? null,
    pages,
    // Complete means the last page was short — every table ran out — rather
    // than that the page bound stopped us.
    complete: !truncated,
  };
}

/** Human-readable summary, for a CI log or an operator. */
export function describeReport(report: ReconciliationReport): string {
  const total = report.divergences.length;
  if (total === 0) {
    return (
      'kg reconciliation: clean ' +
      `(${report.examined.pendingEdits} pending edits, ` +
      `${report.examined.verifications} verdicts, ` +
      `${report.examined.proposals} proposals examined)`
    );
  }
  const byKind = Object.entries(report.counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind}=${n}`)
    .join(' ');
  return `kg reconciliation: ${total} divergence(s) — ${byKind}`;
}
