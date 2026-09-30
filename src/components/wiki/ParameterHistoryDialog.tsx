import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import {
  DRUG_PARAMETERS,
  type DrugParameterId,
} from '@/lib/drugParameters';
import { useParameterLabels } from '@/lib/useParameterLabels';
import {
  fetchDrugParameterHistory,
  type DrugParameterRevisionDTO,
  type DrugParameterRevisionDisputeDTO,
  type DrugParameterRevisionSourceDiff,
  type DrugParameterRevisionVerificationDTO,
} from '@/lib/drugApi';
import { UserBadge } from '@/components/ui/UserBadge';
import { ApprovalStamp } from '@/components/ui/ApprovalStamp';
import type { VerificationLevelInfo } from '@/lib/verificationLevel';
import { VerificationRationaleList } from '@/components/review/VerificationRationaleList';
import { VerificationSummary } from './VerificationSummary';

interface Props {
  drugId: number;
  parameter: DrugParameterId;
  /** Verification level of this parameter's live value, if known. */
  verification?: VerificationLevelInfo;
  onClose: () => void;
}

/** Machine reasons a recompute can carry after the pooled count/cleared code. */
const RECOMPUTE_REASON_KEYS: Record<string, string> = {
  citation_cleanup: 'paramHistory.reasonCitationCleanup',
};

/**
 * Auto-generated cache revisions store a stable CODE (not English prose) as
 * their editSummary so this boundary can localize them. Anything else — a
 * human-written summary — is shown verbatim.
 */
function formatEditSummary(
  summary: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const cleared = summary.match(/^auto:param_entries_cleared(?::([a-z_]+))?$/);
  if (cleared) {
    return withReason(t('paramHistory.autoCleared'), cleared[1], t);
  }
  const recomputedFrom = summary.match(
    /^auto:param_entries_recomputed:(\d+):from:(\d+)(?::([a-z_]+))?$/,
  );
  if (recomputedFrom) {
    const base = t('paramHistory.autoRecomputedFrom', {
      count: Number(recomputedFrom[1]),
      from: Number(recomputedFrom[2]),
    });
    return withReason(base, recomputedFrom[3], t);
  }
  const recomputed = summary.match(
    /^auto:param_entries_recomputed:(\d+)(?::([a-z_]+))?$/,
  );
  if (recomputed) {
    const base = t('paramHistory.autoRecomputed', {
      count: Number(recomputed[1]),
    });
    return withReason(base, recomputed[2], t);
  }
  return summary;
}

function withReason(
  base: string,
  reasonCode: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const key = reasonCode ? RECOMPUTE_REASON_KEYS[reasonCode] : undefined;
  return key ? `${base} — ${t(key)}` : base;
}

/** Which citations entered/left this revision's pooled aggregate (#1358). */
function SourceDiffSection({
  diff,
  t,
}: {
  diff: DrugParameterRevisionSourceDiff;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (diff.added.length === 0 && diff.removed.length === 0) return null;
  return (
    <div className="mt-2 text-xs">
      <div className="text-muted-foreground mb-1">
        {t('paramHistory.sourcesChanged')}
      </div>
      <ul className="space-y-0.5">
        {diff.removed.map((e) => (
          <li
            key={`removed-${e.citationId}`}
            className="text-red-700 dark:text-red-400"
          >
            − {e.label ?? t('paramHistory.sourceUnknown', { id: e.citationId })}
          </li>
        ))}
        {diff.added.map((e) => (
          <li
            key={`added-${e.citationId}`}
            className="text-emerald-700 dark:text-emerald-400"
          >
            + {e.label ?? t('paramHistory.sourceUnknown', { id: e.citationId })}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ReviewRoundItem {
  key: string;
  createdAt: string;
  verdictLabel: string;
  author: string | null;
  rationale: string;
  implicit: boolean;
}

/**
 * The peer-review "round" behind a revision: agent approve/dispute/abstain
 * verdicts plus human and agent disputes, oldest first (#1358, #1379).
 *
 * An agent dispute mirrored into `disputes` (source='agent') is normally
 * shown via its `agent_verifications` row above, not listed again here. But
 * `agent_verifications` has no status column — a verdict is the agent's
 * permanent testimony, so a moderator resolving the mirror leaves the
 * verdict reading `dispute` regardless (see `unresolvedDisputeVerdictCount`
 * in `api/_lib/disputes.ts`). Matching every dispute row by agent slug alone
 * therefore hid more than the intended case (#1379, then caught again in
 * #1393 review): a dispute opened directly via `POST /api/disputes` with no
 * verdict behind it at all, and — once a moderator has resolved an agent's
 * mirror — both that now-historical row *and* any fresh, independent dispute
 * the same agent opens afterward while its old verdict still reads `dispute`.
 *
 * So a verdict's live mirror is identified the same way the backend does:
 * a `resolved` dispute from the same agent with `updatedAt` (== its
 * resolution time) at or after the verdict's own `updatedAt` means that
 * verdict has already been answered — nothing from that agent is the "same"
 * dispute as the verdict anymore, and every row shows standalone. Only when
 * no such resolution exists is the agent's one allowed open row (the
 * `disputes_open_author_target_idx` partial unique index permits at most
 * one) still the live, unanswered mirror, and that's the sole row skipped.
 */
function ReviewRoundSection({
  verifications,
  disputes,
  t,
}: {
  verifications: DrugParameterRevisionVerificationDTO[];
  disputes: DrugParameterRevisionDisputeDTO[];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const relevantDisputes = disputes.filter((d) => {
    if (d.source === 'human' || d.status !== 'open') return true;
    const liveVerdict = verifications.find(
      (v) => v.verdict === 'dispute' && v.agent?.slug === d.author?.agentSlug,
    );
    if (!liveVerdict) return true;
    const verdictAnswered = disputes.some(
      (other) =>
        other.source === 'agent' &&
        other.status === 'resolved' &&
        other.author?.agentSlug === d.author?.agentSlug &&
        other.updatedAt >= liveVerdict.updatedAt,
    );
    return verdictAnswered;
  });
  if (verifications.length === 0 && relevantDisputes.length === 0) return null;

  const items: ReviewRoundItem[] = [
    ...verifications.map((v) => ({
      key: `verify-${v.id}`,
      createdAt: v.createdAt,
      verdictLabel: t(`paramHistory.reviewVerdict.${v.verdict}`),
      author: v.agent?.name || v.agent?.slug || null,
      rationale: v.rationaleMd,
      implicit: v.isImplicit,
    })),
    ...relevantDisputes.map((d) => ({
      key: `dispute-${d.id}`,
      createdAt: d.createdAt,
      verdictLabel: t('paramHistory.reviewVerdict.dispute'),
      author: d.author?.name ?? null,
      rationale: d.reasonMd,
      implicit: false,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="mt-2 text-xs">
      <div className="text-muted-foreground mb-1">{t('paramHistory.reviewRounds')}</div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key} className="border-l-2 border-border pl-2">
            <div>
              <span className="font-medium">{item.verdictLabel}</span>
              {item.author && (
                <span className="text-muted-foreground"> · {item.author}</span>
              )}
              {item.implicit && (
                <span className="text-muted-foreground">
                  {' '}
                  ({t('paramHistory.reviewImplicit')})
                </span>
              )}
            </div>
            <p className="text-muted-foreground line-clamp-2">{item.rationale}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Explicit verdict count for a revision's linked pending edit; implicit
 * self-approve rows aren't part of "the debate" and don't count. */
function verdictCount(v: DrugParameterRevisionDTO['verifications']): number {
  if (!v) return 0;
  return v.approveCount + v.disputeCount + v.abstainCount;
}

export function ParameterHistoryDialog({
  drugId,
  parameter,
  verification,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const spec = DRUG_PARAMETERS[parameter];
  const { longLabel } = useParameterLabels(spec);
  const [revisions, setRevisions] = useState<DrugParameterRevisionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which revisions' agent-verdict rationale (the "review debate" behind a
  // pending-edit-driven revision, #1358) the viewer has expanded.
  const [expandedVerdicts, setExpandedVerdicts] = useState<Set<number>>(
    new Set(),
  );
  // One string for the visible heading and the dialog's accessible name, so
  // the two can never drift apart. Interpolated rather than glued together
  // from `paramHistory.title` — punctuation and word order around a name are
  // the locale's to decide. `title` stays as the standalone label it was.
  const heading = t('paramHistory.dialogHeading', { parameter: longLabel });

  const load = useCallback(() => {
    fetchDrugParameterHistory(drugId, parameter)
      .then((data) => setRevisions(data.revisions))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [drugId, parameter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={heading}
      className="w-full max-w-2xl p-6 max-h-[80vh] flex flex-col"
    >
      <div className="flex items-start justify-between mb-4">
        <h3 className="text-lg font-semibold">{heading}</h3>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {verification ? <VerificationSummary info={verification} /> : null}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && revisions === null && (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
        {revisions && revisions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('paramHistory.noRevisions')}
          </p>
        )}
        {revisions && revisions.length > 0 && (
          <ul className="space-y-3">
            {revisions.map((rev) => (
              <li
                key={rev.id}
                className="rounded-md border border-border p-3 bg-muted/30"
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-2 gap-2">
                  <span>
                    <UserBadge user={rev.author} /> ·{' '}
                    {new Date(rev.createdAt).toLocaleString()}
                  </span>
                  <ApprovalStamp
                    targetType="drug_parameter_revision"
                    targetId={rev.id}
                    initial={
                      rev.approvals ?? {
                        count: 0,
                        approvers: [],
                        approvedByMe: false,
                      }
                    }
                    onChange={load}
                  />
                </div>
                {rev.editSummary && (
                  <div className="text-sm italic mb-2">
                    “{formatEditSummary(rev.editSummary, t)}”
                  </div>
                )}
                {rev.pendingEditId != null && verdictCount(rev.verifications) > 0 ? (
                  <div className="mb-2">
                    <button
                      type="button"
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                      aria-expanded={expandedVerdicts.has(rev.id)}
                      onClick={() =>
                        setExpandedVerdicts((prev) => {
                          const next = new Set(prev);
                          if (next.has(rev.id)) next.delete(rev.id);
                          else next.add(rev.id);
                          return next;
                        })
                      }
                    >
                      {t(
                        expandedVerdicts.has(rev.id)
                          ? 'review.verification.hideRationales'
                          : 'review.verification.showRationales',
                      )}
                    </button>
                    {expandedVerdicts.has(rev.id) ? (
                      <div className="mt-1 rounded-md border border-border bg-card p-2">
                        <VerificationRationaleList
                          targetType="pending_edit"
                          targetId={rev.pendingEditId}
                          hideOnError
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground mb-1">{t('paramHistory.before')}</div>
                    <div className="font-mono break-words">
                      {spec.format(rev.oldValue) || '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">{t('paramHistory.after')}</div>
                    <div className="font-mono break-words">
                      {spec.format(rev.newValue) || '—'}
                    </div>
                  </div>
                </div>
                {rev.sourceDiff && <SourceDiffSection diff={rev.sourceDiff} t={t} />}
                <ReviewRoundSection
                  verifications={rev.reviewVerdicts ?? []}
                  disputes={rev.disputes ?? []}
                  t={t}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ModalOverlay>
  );
}
