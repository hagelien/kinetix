import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CornerUpLeft,
  Eye,
  Pencil,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/authStore';
import { useCan } from '@/lib/usePermissions';
import { capabilityForEditType } from '@/lib/permissions';
import { isModelStructureParameter } from '@/lib/drugParameters';
import {
  ApiError,
  cancelPendingEdit,
  reviewPendingEdit,
  updatePendingEdit,
  type PendingEditRow,
} from '@/lib/pendingEditsApi';
import { type AgentConsensusStatus } from '@/lib/agentVerificationsApi';
import {
  fetchDisputesForTarget,
  resolveDispute,
  type DisputeResolution,
  type DisputeRow,
} from '@/lib/disputesApi';
import { VerificationRationaleList } from './VerificationRationaleList';
import { ParameterDiff } from './ParameterDiff';
import { MetabolismDiff } from './MetabolismDiff';
import { ReceptorTargetsDiff } from './ReceptorTargetsDiff';
import { BioEntityDiff } from './BioEntityDiff';
import { RejectDialog } from './RejectDialog';
import { ReturnDialog } from './ReturnDialog';
import { WikiDiff } from './WikiDiff';
import {
  ParameterEntryDiff,
  entryFieldsFromCurrentEntry,
} from './ParameterEntryDiff';
import { WikiFactDiff } from './WikiFactDiff';
import { WikiSectionDiff } from './WikiSectionDiff';
import { PaperReviewDiff } from './PaperReviewDiff';
import { LearningContentDiff } from './LearningContentDiff';
import { UserBadge } from '@/components/ui/UserBadge';
import type { RejectionReason } from '@/lib/rejectionReasons';
import { ReferenceText } from './ReferenceText';

// Map stable server error codes to localized strings, falling back to the
// server's English prose for codes the UI hasn't been taught yet (AGENTS.md
// i18n rule — server messages reaching the UI go through a code at the React
// boundary).
const REVIEW_ERROR_KEYS: Record<string, string> = {
  pending_edit_invalid_parameter: 'review.errors.invalidParameter',
  pending_edit_parameter_reference_required:
    'review.errors.parameterReferenceRequired',
  pending_edit_parameter_value_invalid: 'review.errors.invalidParameterValue',
  pending_edit_review_token_mismatch: 'review.errors.staleApproval',
  pending_edit_update_conflict: 'review.errors.updateConflict',
  param_entry_invalid_payload: 'review.errors.paramEntryInvalidPayload',
  param_entry_invalid_for_parameter:
    'review.errors.paramEntryInvalidForParameter',
  param_entry_target_mismatch: 'review.errors.paramEntryTargetMismatch',
  param_entry_citation_mismatch: 'review.errors.paramEntryCitationMismatch',
  // A nested dose-context drug (administered / interacting) was deleted after
  // the proposal was written (Cmax release B).
  param_entry_drug_missing: 'review.errors.paramEntryDrugMissing',
  param_entry_reference_not_judged:
    'review.errors.paramEntryReferenceNotJudged',
  param_entry_target_missing: 'review.errors.paramEntryTargetMissing',
  param_entry_duplicate: 'review.errors.paramEntryDuplicate',
  // Approval-time applicability refusal: a marker was added, or the substance
  // reclassified, after the edit was queued. Emitted by both the parameter and
  // the param_entry apply paths.
  parameter_not_applicable: 'review.errors.parameterNotApplicable',
  // An authored value queued for a parameter that is now source-value-backed.
  // The submission gate refuses these, so only edits queued before the rule
  // existed reach a reviewer — they are rejected rather than applied.
  parameter_entry_backed: 'review.errors.parameterEntryBacked',
  agent_moderation_of_human_edit_not_allowed:
    'review.errors.agentModerationNotAllowed',
  self_decision_blocked_by_dispute: 'review.errors.selfDecisionDisputed',
  self_approval_blocked_by_upheld_dispute: 'review.errors.selfApprovalUpheld',
  disputes_not_found: 'review.dispute.alreadyClosed',
  disputes_forbidden: 'review.dispute.forbidden',
  // The card mirrors review.edit.decideOwn, so these normally never surface.
  // They still can when the caller's identity decides it rather than their
  // tier — an agent's backing user in a browser session, which useCan cannot
  // see — so give them prose rather than the server's English fallback.
  approval_self_not_allowed: 'review.errors.selfDecisionNotAllowed',
  return_self_not_allowed: 'review.errors.selfDecisionNotAllowed',
  pending_edit_decision_with_payload_change: 'review.errors.decideAfterRevising',
  // An agent resubmitting a calculation-driving proposal with no quote.
  source_quote_required: 'review.errors.sourceQuoteRequired',
};

interface PendingEditCardProps {
  edit: PendingEditRow;
  onReviewed: () => void;
}

/**
 * Dispute verdicts still awaiting a moderator's decision. Falls back to the
 * raw tally on responses predating the field, since reading a missing count as
 * zero would hide a live objection.
 */
function unresolvedDisputeCount(edit: PendingEditRow): number {
  const v = edit.verifications;
  if (!v) return 0;
  return v.unresolvedDisputeCount ?? v.disputeCount;
}

function statusVariant(status: PendingEditRow['status']) {
  if (status === 'approved') return 'default';
  if (status === 'rejected') return 'destructive';
  return 'secondary';
}

function VerificationBadges({
  verifications,
  expanded,
  onToggle,
}: {
  verifications?: PendingEditRow['verifications'];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (!verifications) return null;
  const { approveCount, disputeCount, abstainCount } = verifications;
  if (approveCount === 0 && disputeCount === 0 && abstainCount === 0) {
    return null;
  }
  // A verdict is testimony and cannot be closed, so `disputeCount` never
  // falls. Only the objections still awaiting a decision get the red badge;
  // the ones a moderator has ruled on stay visible — the rationale is still
  // part of the record — but in a neutral one that does not read as "stop".
  const unresolvedDisputes =
    verifications.unresolvedDisputeCount ?? disputeCount;
  const decidedDisputes = Math.max(0, disputeCount - unresolvedDisputes);
  const toggleLabel = t(
    expanded
      ? 'review.verification.hideRationales'
      : 'review.verification.showRationales',
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex flex-wrap items-center gap-1 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={expanded}
      title={toggleLabel}
    >
      {unresolvedDisputes > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-xs font-medium text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {t('review.verification.dispute', { count: unresolvedDisputes })}
        </span>
      ) : null}
      {decidedDisputes > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
          {t('review.verification.disputeDecided', { count: decidedDisputes })}
        </span>
      ) : null}
      {approveCount > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          {t('review.verification.approve', { count: approveCount })}
        </span>
      ) : null}
      {abstainCount > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
          {t('review.verification.abstain', { count: abstainCount })}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Why an edit that agents have approved is still waiting for a human (issue
 * #1357). Several agent approvals and no objection read as "this should have
 * published"; this line says what held it, and — when the hold is a missing
 * flagship approval — which agents' tier setting to check.
 *
 * The status is computed server-side for the whole list response (#1374)
 * rather than fetched by each mounted card, so this is a pure display of
 * whatever `edit.consensusStatus` the list response carried.
 */
function ConsensusHoldNote({
  status,
}: {
  status: AgentConsensusStatus | null | undefined;
}) {
  const { t } = useTranslation();

  if (!status) return null;
  // `quorum_unmet` is the ordinary "waiting for more reviews" state and needs
  // no explanation; the other holds are the ones a moderator cannot see.
  if (
    !status.ready &&
    (status.reason === 'not_pending' ||
      status.reason === 'not_found' ||
      status.reason === 'quorum_unmet')
  ) {
    return null;
  }
  const text = status.ready
    ? t('review.consensus.ready')
    : t(`review.consensus.reason.${status.reason}`);
  const names =
    !status.ready && status.unrankedFlagshipApprovers?.length
      ? t('review.consensus.unrankedFlagship', {
          names: status.unrankedFlagshipApprovers.join(', '),
        })
      : null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      <span className="font-medium">{t('review.consensus.label')}:</span> {text}
      {names ? <> {names}</> : null}
    </p>
  );
}

/**
 * The open disputes standing against this edit, with the controls to rule on
 * them.
 *
 * An open dispute blocks approval — including, and especially, the author's
 * own approval of their own submission (`self_decision_blocked_by_dispute`).
 * The block told the moderator to "resolve the dispute first" while the page
 * offered nothing to resolve it with: the objection was readable only as a
 * verdict rationale behind the badge toggle, and `PATCH /api/disputes` had no
 * caller in the app at all. This panel is that missing half.
 *
 * Ruling on a dispute is deliberately not the same act as deciding the edit.
 * `upheld` records that the objection was right — the moderator then returns
 * or rejects the edit — and `rejected` records that it was overruled, freeing
 * the approve button. Both are written to the dispute's own audit trail, which
 * is what makes "approve over an objection" a recorded decision rather than a
 * quiet one.
 */
function DisputePanel({
  edit,
  onResolved,
}: {
  edit: PendingEditRow;
  onResolved: () => void;
}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const canResolve = useCan('dispute.resolve');
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; rows: DisputeRow[] }
    | { status: 'error' }
  >({ status: 'loading' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // What the row says is contesting this edit right now. Keying the fetch on
  // the id alone would leave a stale panel: /review refreshes in place after a
  // decision, so the card survives with the same id, and an agent that
  // disputes the edit again afterwards would find a panel still showing the
  // rows it emptied — with no controls for the new objection until a full page
  // reload. Refetching whenever the contested-state changes covers both
  // directions.
  const openSignal = `${edit.hasOpenDispute === true}:${unresolvedDisputeCount(
    edit,
  )}`;

  useEffect(() => {
    let cancelled = false;
    fetchDisputesForTarget({ targetType: 'pending_edit', targetId: edit.id })
      .then((res) => {
        if (cancelled) return;
        setState({ status: 'ready', rows: res.disputes });
      })
      .catch(() => {
        if (cancelled) return;
        // A contributor without dispute.queue.read on someone else's card gets
        // a 403 here; the panel simply stays out of the way.
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [edit.id, openSignal]);

  async function handleResolve(id: number, resolution: DisputeResolution) {
    setBusyId(id);
    setError(null);
    try {
      const result = await resolveDispute(id, resolution);
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', rows: prev.rows.filter((r) => r.id !== id) }
          : prev,
      );
      // Upholding normally returns the proposal to its author in the same act.
      // When the server could not — already decided, or the moderator's own
      // submission without `review.edit.decideOwn` — say so, because the row
      // otherwise just loses its dispute badge and looks handled.
      if (result.pendingEditReturned === false) {
        setError(t('review.dispute.upheldReturnSkipped'));
      }
      // Refresh the queue: resolving the last open dispute is what unblocks
      // the approve button, and the row's badges change with it.
      onResolved();
    } catch (err) {
      // Same i18n boundary the review controls use: the server's prose is
      // English, so a recognised code becomes Norwegian and anything else
      // falls back to the localized failure line rather than leaking it.
      const key =
        err instanceof ApiError && err.code
          ? REVIEW_ERROR_KEYS[err.code]
          : null;
      setError(key ? t(key) : t('review.dispute.failed'));
    } finally {
      setBusyId(null);
    }
  }

  // Ruling on the last open objection empties the list, but the panel is also
  // where the outcome of that ruling is reported — including "upheld, but the
  // proposal was NOT returned". Unmounting on `rows.length === 0` swallowed
  // exactly that message: the moderator would watch the dispute disappear and
  // read it as handled, while the edit sat pending with nobody told. So an
  // error keeps the panel mounted even with nothing left to rule on.
  if (state.status !== 'ready') return null;
  if (state.rows.length === 0 && !error) return null;

  return (
    <div className="space-y-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2">
      {state.rows.length > 0 ? (
        <>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            {t('review.dispute.heading', { count: state.rows.length })}
          </div>
          <p className="text-xs text-muted-foreground">
            {canResolve
              ? t('review.dispute.moderatorHint')
              : t('review.dispute.readerHint')}
          </p>
        </>
      ) : null}
      <ul className="space-y-2">
        {state.rows.map((d) => (
          <li
            key={d.id}
            className="space-y-1.5 rounded-md border border-border bg-card p-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {d.author?.name ??
                  d.author?.agentSlug ??
                  t('review.dispute.unknownAuthor')}
              </span>
              <span>
                ·{' '}
                {t(
                  d.source === 'agent'
                    ? 'review.dispute.sourceAgent'
                    : 'review.dispute.sourceHuman',
                )}
              </span>
              <span>· {new Date(d.createdAt).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap leading-snug">
              {d.reasonMd.trim() ? (
                <ReferenceText text={d.reasonMd.trim()} />
              ) : (
                t('review.dispute.noReason')
              )}
            </p>
            {d.evidenceRefs.length > 0 ? (
              <div className="text-[11px] text-muted-foreground">
                <span className="font-medium">
                  {t('review.verification.evidenceLabel')}:
                </span>{' '}
                {d.evidenceRefs
                  .map((e) => {
                    if (e.citationId !== undefined) return `#${e.citationId}`;
                    if (e.url) return e.url;
                    if (e.quote) return `“${e.quote}”`;
                    return '';
                  })
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            ) : null}
            {canResolve ? (
              <div className="flex flex-wrap gap-2 pt-0.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => handleResolve(d.id, 'upheld')}
                  title={t('review.dispute.upheldHint')}
                >
                  {t('review.dispute.uphold')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => handleResolve(d.id, 'rejected')}
                  title={t('review.dispute.overruleHint')}
                >
                  {t('review.dispute.overrule')}
                </Button>
                {user?.id === d.createdBy ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId !== null}
                    onClick={() => handleResolve(d.id, 'withdrawn')}
                  >
                    {t('review.dispute.withdraw')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}

export function PendingEditCard({ edit, onReviewed }: PendingEditCardProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [showReject, setShowReject] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [showRevise, setShowRevise] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRationales, setShowRationales] = useState(false);

  const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
  const isOwnEdit = user?.id === edit.submittedBy;
  const canReview = useCan('review.edit.decide');
  const canDecideModelStructure = useCan('edit.modelStructure.decide');
  // Deciding on your own proposal is a capability of its own (default admin).
  // Without it the review controls stay hidden on your own card and only the
  // withdraw/revise controls below are offered, as before.
  const canDecideOwn = useCan('review.edit.decideOwn');
  const canApproveWholePage = useCan('wiki.page.approve');
  const canSubmitWholePage = useCan('wiki.page.submit');
  const canSubmitThisType = useCan(capabilityForEditType(edit.editType));
  const canCreateDrug = useCan('drug.create');
  const canSubmitParameters = useCan('edit.parameter.submit');
  const isWholePageEdit =
    edit.editType === 'wiki_page' || edit.editType === 'wiki_new';
  const isModelStructureEdit =
    edit.editType === 'param_entry' &&
    typeof edit.parameter === 'string' &&
    isModelStructureParameter(edit.parameter);
  // Approving one of these creates the catalog drug as a side effect, which
  // the API gates on drug.create separately from the approval itself.
  const approvalCreatesDrug =
    edit.editType === 'wiki_new' && Boolean(meta.newDrug);
  // Likewise a parameters bag: approving publishes drug-parameter revisions,
  // which PATCH /api/pending-edits gates on edit.parameter.submit.
  const approvalPublishesParameters =
    edit.editType === 'wiki_new' &&
    Boolean(
      meta.parameters &&
        typeof meta.parameters === 'object' &&
        Object.keys(meta.parameters).length > 0,
    );
  // The API lets any reviewer reject or return a whole-page draft but only
  // lets wiki.page.approve holders apply it; mirror that split here.
  const mayDecideThisEdit =
    canReview &&
    (!isModelStructureEdit || canDecideModelStructure) &&
    (!isOwnEdit || canDecideOwn);
  // An upheld objection closes the dispute without clearing the proposal: its
  // author returns, rejects or revises it, and only someone else may approve
  // over the ruling. Mirrors `self_approval_blocked_by_upheld_dispute`.
  const selfApprovalHeldByUpheldDispute =
    isOwnEdit && edit.disputeUpheld === true;
  const canApprove =
    mayDecideThisEdit &&
    edit.status === 'pending' &&
    !selfApprovalHeldByUpheldDispute &&
    (!isWholePageEdit || canApproveWholePage) &&
    (!approvalCreatesDrug || canCreateDrug) &&
    (!approvalPublishesParameters || canSubmitParameters);
  // Rejecting your own edit is the withdraw path (canManageOwn below), which
  // needs no review capability — so the reject *review* control stays off your
  // own card even with review.edit.decideOwn, to keep one button per meaning.
  const canReject =
    canReview &&
    (!isModelStructureEdit || canDecideModelStructure) &&
    !isOwnEdit &&
    edit.status === 'pending';
  const canReturn = mayDecideThisEdit && edit.status === 'pending';
  // Mirrors the API's submitter-update guard (PATCH /api/pending-edits),
  // which re-checks capabilityForEditType for the row being updated — not
  // the approval capability, and not only the whole-page one.
  const canResubmitReturned =
    isOwnEdit && edit.status === 'returned' && canSubmitThisType;
  const canManageOwn =
    isOwnEdit &&
    (edit.status === 'pending' ||
      edit.status === 'draft' ||
      edit.status === 'returned');
  const conflict = meta.conflict as Record<string, unknown> | undefined;
  // The id THIS marker carries (`markEntryMutationsConflicted`) — echoed back
  // on a revision PATCH so the server can tell "answered this marker" from
  // "revised something while a marker happened to be present" (#1258). Only
  // the `direct_admin_write` marker carries one; the unrelated
  // sibling-approval marker (`buildConflictMarker`) never does, so this stays
  // null for it and the server's ack gate is a no-op there (see
  // `directAdminWriteConflictId` in api/pending-edits.ts).
  const conflictId =
    conflict?.reason === 'direct_admin_write' &&
    typeof conflict.id === 'string'
      ? conflict.id
      : null;
  // The live `param_entry` row the conflict is warning about, so the revise
  // dialog can show the author what changed under them before they edit —
  // rather than asking them to answer a marker they never actually saw. Only
  // for the direct-write marker: the sibling-approval conflict isn't about
  // this entry having changed under them, so the "review it before revising"
  // panel would be misleading there.
  const liveEntryForRevise =
    edit.editType === 'param_entry' && conflictId !== null && edit.currentEntry
      ? {
          fields: entryFieldsFromCurrentEntry(edit.currentEntry),
          citation: edit.currentEntry.citation,
        }
      : null;
  // The other half of the direct-write marker: the entry it warns about no
  // longer exists (a direct admin delete, not an edit) — `currentEntry` comes
  // back undefined because there is no live row left to hydrate. The revise
  // dialog must say so explicitly rather than silently rendering no panel, so
  // the author has actually been shown *something* before their acknowledgment
  // is accepted below (#1293).
  const conflictEntryDeleted =
    edit.editType === 'param_entry' && conflictId !== null && !edit.currentEntry;
  // Only fetch the disputes when something says there is one to fetch: the
  // list endpoint tags rows carrying an open dispute, and an agent dispute
  // verdict is mirrored into the same table, so either signal is worth a look.
  // The panel renders nothing when the fetch comes back empty.
  const showDisputes =
    edit.status === 'pending' &&
    (edit.hasOpenDispute === true || unresolvedDisputeCount(edit) > 0);
  // learning_unit / clinical_case carry their title in proposedMeta (there is
  // no drug/page target row to hydrate a name from), so pull it from there
  // instead of falling through to the "Unknown target" placeholder.
  const learningTitle =
    (edit.editType === 'learning_unit' || edit.editType === 'clinical_case') &&
    typeof meta.title === 'string' &&
    meta.title
      ? meta.title
      : null;
  const targetLabel =
    edit.drugName ??
    edit.pageTitle ??
    learningTitle ??
    (edit.editType === 'bio_entity'
      ? (edit.entitySymbol ??
        (typeof meta.symbol === 'string' ? meta.symbol : null) ??
        t('review.bioEntity'))
      : null) ??
    (edit.editType === 'paper_review'
      ? (edit.reference?.metadata?.title ??
        edit.reference?.identifier ??
        t('review.paperReview', { defaultValue: 'Paper review' }))
      : t('review.unknownTarget'));
  const targetHref = edit.pageSlug
    ? `/wiki/${encodeURIComponent(edit.pageSlug)}`
    : edit.drugSlug
      ? `/wiki/${encodeURIComponent(edit.drugSlug)}`
      : edit.editType === 'bio_entity' && edit.entitySlug
        ? `/wiki/entity/${encodeURIComponent(edit.entitySlug)}`
        : null;

  function formatApiError(err: unknown, fallbackKey: string): string {
    const key =
      err instanceof ApiError && err.code ? REVIEW_ERROR_KEYS[err.code] : null;
    return key ? t(key) : err instanceof Error ? err.message : t(fallbackKey);
  }

  async function handleApprove() {
    setSaving(true);
    setError(null);
    try {
      await reviewPendingEdit(edit.id, {
        status: 'approved',
        reviewToken: edit.reviewToken,
      });
      onReviewed();
    } catch (err) {
      setError(formatApiError(err, 'review.approveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReject(args: {
    reason: RejectionReason;
    comment: string;
  }) {
    setSaving(true);
    setError(null);
    try {
      await reviewPendingEdit(edit.id, {
        status: 'rejected',
        rejectionReason: args.reason,
        rejectionComment: args.comment ? args.comment : undefined,
        reviewToken: edit.reviewToken,
      });
      setShowReject(false);
      onReviewed();
    } catch (err) {
      setError(formatApiError(err, 'review.rejectFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReturn(args: {
    comment: string;
    proposedValue?: unknown;
  }) {
    setSaving(true);
    setError(null);
    try {
      await reviewPendingEdit(edit.id, {
        status: 'returned',
        returnComment: args.comment || undefined,
        ...(args.proposedValue !== undefined
          ? { proposedValue: args.proposedValue }
          : {}),
        reviewToken: edit.reviewToken,
      });
      setShowReturn(false);
      onReviewed();
    } catch (err) {
      setError(formatApiError(err, 'review.returnFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    setSaving(true);
    setError(null);
    try {
      await cancelPendingEdit(edit.id);
      onReviewed();
    } catch (err) {
      setError(formatApiError(err, 'review.cancelFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleResubmit() {
    setSaving(true);
    setError(null);
    try {
      await updatePendingEdit(edit.id, { status: 'pending' });
      onReviewed();
    } catch (err) {
      setError(formatApiError(err, 'review.resubmitFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReviseAndResubmit(args: { proposedValue?: unknown }) {
    setSaving(true);
    setError(null);
    try {
      await updatePendingEdit(edit.id, {
        status: 'pending',
        ...(args.proposedValue !== undefined
          ? { proposedValue: args.proposedValue }
          : {}),
        // Echo the marker id the revise dialog showed (#1258) — the server
        // only discharges a `direct_admin_write` conflict when this matches
        // the marker still on the row, so revising without ever having seen
        // the live entry (conflictId null) never clears it. Gated on having
        // actually shown the live entry, not on conflictId alone. When the
        // entry was deleted instead (conflictEntryDeleted), the dialog never
        // reaches this handler at all — it offers withdrawal, not a JSON
        // edit, because there is no live row a revision could target (#1295).
        ...(conflictId !== null && liveEntryForRevise !== null
          ? { acknowledgedConflictId: conflictId }
          : {}),
      });
      setShowRevise(false);
      onReviewed();
    } catch (err) {
      setError(formatApiError(err, 'review.resubmitFailed'));
    } finally {
      setSaving(false);
    }
  }

  // Resuming a whole-page draft reopens the page editor, which /wiki/new and
  // /wiki/:slug/edit both admit for wiki.page.submit holders — direct-write
  // only decides whether their save publishes or queues. Without that
  // capability, surface only the withdraw path via canManageOwn rather than
  // linking into a flow that 403s.
  const wikiEditLink = !canSubmitWholePage
    ? null
    : edit.editType === 'wiki_new'
      ? `/wiki/new?pendingEditId=${edit.id}`
      : edit.editType === 'wiki_page' && edit.targetId
        ? `/wiki/${encodeURIComponent(String((meta.slug as string) ?? ''))}/edit?pendingEditId=${edit.id}`
        : null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={edit.editType === 'parameter' ? 'default' : 'secondary'}
            >
              {edit.editType === 'parameter'
                ? t('review.parameter')
                : edit.editType === 'param_entry'
                ? t('review.paramEntry.label', {
                    defaultValue: 'Source value',
                  })
                : edit.editType === 'metabolism'
                ? t('review.metabolism')
                : edit.editType === 'receptor_targets'
                ? t('review.receptorTargets')
                : edit.editType === 'bio_entity'
                ? t('review.bioEntity')
                : edit.editType === 'wiki_new'
                  ? t('review.newPage')
                  : edit.editType === 'wiki_fact'
                    ? t('review.factEdit')
                    : edit.editType === 'wiki_section'
                      ? t('review.sectionEdit', {
                          defaultValue: 'Section edit',
                        })
                      : edit.editType === 'paper_review'
                        ? t('review.paperReview', {
                            defaultValue: 'Paper review',
                          })
                        : edit.editType === 'learning_unit'
                          ? t('review.learningUnit', {
                              defaultValue: 'Learning unit',
                            })
                          : edit.editType === 'clinical_case'
                            ? t('review.clinicalCase', {
                                defaultValue: 'Clinical case',
                              })
                            : t('review.pageEdit')}
            </Badge>
            <Badge variant={statusVariant(edit.status)}>
              {t(`review.status.${edit.status}`, {
                defaultValue:
                  edit.status === 'draft' ? t('review.drafts') : edit.status,
              })}
            </Badge>
            {conflict ? (
              <span className="text-xs font-medium text-accent">
                {t('review.conflictFlagged')}
              </span>
            ) : null}
            <VerificationBadges
              verifications={edit.verifications}
              expanded={showRationales}
              onToggle={() => setShowRationales((v) => !v)}
            />
          </div>
          {showRationales ? (
            <div className="mt-2 rounded-md border border-border bg-card p-2">
              <VerificationRationaleList
                targetType="pending_edit"
                targetId={edit.id}
              />
            </div>
          ) : null}
          {edit.status === 'pending' &&
          (edit.verifications?.approveCount ?? 0) >= 1 &&
          unresolvedDisputeCount(edit) === 0 ? (
            <ConsensusHoldNote status={edit.consensusStatus ?? null} />
          ) : null}
          <div className="text-sm font-medium">
            {targetHref ? (
              <Link
                to={targetHref}
                className="text-primary underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {targetLabel}
              </Link>
            ) : (
              targetLabel
            )}
            {edit.parameter ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({edit.parameter})
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {t('review.byAuthor')} <UserBadge user={edit.submitter} />
            </span>
            {' · '}
            {new Date(edit.submittedAt).toLocaleString()}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {edit.editType !== 'parameter' && wikiEditLink && canManageOwn ? (
            <>
              <Link
                to={wikiEditLink}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted/50"
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('review.editDraft')}
              </Link>
            </>
          ) : null}
          {edit.editType === 'wiki_page' && typeof meta.slug === 'string' ? (
            <Link
              to={`/wiki/${meta.slug}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted/50"
            >
              <Eye className="h-3.5 w-3.5" />
              {t('review.published')}
            </Link>
          ) : null}
        </div>
      </div>

      {edit.editType === 'parameter' ? (
        <ParameterDiff
          parameter={edit.parameter}
          currentValue={edit.currentValue}
          proposedValue={edit.proposedValue}
          referenceId={edit.referenceId}
          reference={edit.reference ?? null}
          references={edit.references ?? []}
          currentReferences={edit.currentReferences ?? []}
          currentReferenceIds={edit.currentReferenceIds ?? []}
          molecularWeight={edit.drugMolecularWeight ?? null}
        />
      ) : edit.editType === 'param_entry' ? (
        <ParameterEntryDiff edit={edit} />
      ) : edit.editType === 'metabolism' ? (
        <MetabolismDiff edit={edit} />
      ) : edit.editType === 'receptor_targets' ? (
        <ReceptorTargetsDiff edit={edit} />
      ) : edit.editType === 'bio_entity' ? (
        <BioEntityDiff edit={edit} />
      ) : edit.editType === 'wiki_fact' ? (
        <WikiFactDiff edit={edit} />
      ) : edit.editType === 'wiki_section' ? (
        <WikiSectionDiff edit={edit} />
      ) : edit.editType === 'paper_review' ? (
        <PaperReviewDiff edit={edit} />
      ) : edit.editType === 'learning_unit' ||
        edit.editType === 'clinical_case' ? (
        <LearningContentDiff edit={edit} />
      ) : (
        <WikiDiff
          currentContent={edit.currentContent}
          currentContentHtml={edit.currentContentHtml}
          proposedValue={edit.proposedValue}
        />
      )}

      {/*
        The verbatim source quote for a direct drug-parameter proposal. A
        `param_entry` proposal carries its quote on the entry payload and
        ParameterEntryDiff renders it there; a NumericRange has nowhere to put
        one, so it travels in proposed_meta and is shown here instead. Above the
        edit summary on purpose: the summary is the author's account of the
        change, the quote is the source's own words, and the reviewer's job is
        to check the second against the value — not to take the first on trust.
      */}
      {typeof meta.sourceQuote === 'string' && meta.sourceQuote ? (
        <div className="space-y-0.5 text-xs">
          <span className="text-muted-foreground">
            {t('review.sourceQuoteLabel', { defaultValue: 'Source quote' })}
          </span>
          <p className="border-l-2 border-border pl-2 italic">
            {meta.sourceQuote}
          </p>
        </div>
      ) : null}

      {typeof meta.editSummary === 'string' && meta.editSummary ? (
        <p className="text-xs italic text-muted-foreground">
          “<ReferenceText text={meta.editSummary} />”
        </p>
      ) : null}

      {edit.status === 'returned' && edit.rejectionComment ? (
        <div className="space-y-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <span className="font-semibold">
            {t('review.returnCommentLabel')}:{' '}
          </span>
          <ReferenceText text={edit.rejectionComment} />
        </div>
      ) : edit.rejectionReason || edit.rejectionComment ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 space-y-1">
          {edit.rejectionReason ? (
            <div>
              <span className="font-semibold">
                {t('review.rejectionReason')}:
              </span>{' '}
              {t(`rejectionReasons.${edit.rejectionReason}`)}
            </div>
          ) : null}
          {edit.rejectionComment ? (
            <div>
              {edit.rejectionReason ? (
                <span className="font-semibold">
                  {t('review.rejectionCommentLabel')}:{' '}
                </span>
              ) : (
                <span className="font-semibold">
                  {t('review.rejectionReason')}:{' '}
                </span>
              )}
              <ReferenceText text={edit.rejectionComment} />
            </div>
          ) : null}
        </div>
      ) : null}

      {conflict ? (
        <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
          {t('review.conflictWarning')}
        </div>
      ) : null}

      {showDisputes ? (
        <DisputePanel edit={edit} onResolved={onReviewed} />
      ) : null}

      {selfApprovalHeldByUpheldDispute && edit.status === 'pending' ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {t('review.dispute.upheldStanding')}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        {canApprove ? (
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={saving || Boolean(conflict)}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {t('review.approve')}
          </Button>
        ) : null}

        {canReject ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              setShowReject(true);
            }}
            disabled={saving}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            {t('review.reject')}
          </Button>
        ) : null}

        {canReturn ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              setShowReturn(true);
            }}
            disabled={saving}
          >
            <CornerUpLeft className="mr-1 h-3.5 w-3.5" />
            {t('review.returnForRevision')}
          </Button>
        ) : null}

        {canResubmitReturned ? (
          <>
            {!conflictEntryDeleted ? (
              <Button size="sm" onClick={handleResubmit} disabled={saving}>
                {t('review.resubmit')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                setShowRevise(true);
              }}
              disabled={saving}
            >
              <Pencil className="mr-1 h-3.5 w-3.5" />
              {t('review.editAndResubmit')}
            </Button>
          </>
        ) : null}

        {canManageOwn ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancel}
            disabled={saving}
          >
            {t('review.cancelSuggestion')}
          </Button>
        ) : null}
      </div>

      {showReject ? (
        <RejectDialog
          onReject={handleReject}
          onCancel={() => {
            setError(null);
            setShowReject(false);
          }}
          saving={saving}
          error={error}
        />
      ) : null}

      {showReturn ? (
        <ReturnDialog
          proposedValue={edit.proposedValue}
          onReturn={handleReturn}
          onCancel={() => {
            setError(null);
            setShowReturn(false);
          }}
          saving={saving}
          error={error}
        />
      ) : null}

      {showRevise ? (
        <ReturnDialog
          proposedValue={edit.proposedValue}
          mode="revise"
          liveEntry={liveEntryForRevise}
          conflictEntryDeleted={conflictEntryDeleted}
          onReturn={handleReviseAndResubmit}
          onWithdraw={handleCancel}
          onCancel={() => {
            setError(null);
            setShowRevise(false);
          }}
          saving={saving}
          error={error}
        />
      ) : null}
    </div>
  );
}
