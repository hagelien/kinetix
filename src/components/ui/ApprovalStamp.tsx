import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { useCan } from '@/lib/usePermissions';
import {
  addApproval,
  withdrawApproval,
  ApprovalsApiError,
  type ApprovalSummary,
  type ApprovalTargetType,
  type ApproverRef,
} from '@/lib/approvalsApi';

/**
 * Stable server-side error codes the chip might surface in its
 * tooltip. Mapped to localized strings at the React boundary so
 * Norwegian sessions don't see English prose (AGENTS.md i18n rule).
 * Codes the client doesn't recognize fall back to the server's
 * English message — never silently swallowed.
 */
const APPROVAL_ERROR_KEYS: Record<string, string> = {
  approval_reviewer_required: 'approvals.errorReviewerRequired',
  approval_self_not_allowed: 'approvals.errorSelfNotAllowed',
  approval_target_not_found: 'approvals.errorTargetNotFound',
};

export interface ApprovalStampProps {
  targetType: ApprovalTargetType;
  targetId: number;
  /** Initial summary from the parent endpoint (history / discussion list). */
  initial: ApprovalSummary;
  /** Notified after a stamp is added/removed so the parent can refetch. */
  onChange?: () => void;
  /** Compact mode — render as a small chip (used in revision history). */
  variant?: 'inline' | 'hover';
}

function approverDisplay(a: ApproverRef): string {
  if (a.displayName && a.displayName.trim()) return a.displayName;
  return a.username ?? `#${a.id}`;
}

/**
 * Small ✓ + count chip with a tooltip that lists approvers.
 * Contributors and above can click to add or withdraw their own stamp;
 * everyone else just sees the badge.
 *
 * #344 invariant: this badge is a display-only signal. Agent
 * evaluation pipelines must never read approval counts when forming
 * judgments about a fact.
 */
export function ApprovalStamp({
  targetType,
  targetId,
  initial,
  onChange,
  variant = 'inline',
}: ApprovalStampProps): JSX.Element {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [summary, setSummary] = useState<ApprovalSummary>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStamp = useCan('approval.stamp.add');

  // The chip seeds local state from `initial`, so a parent that
  // refetches summaries (`onChange={load}` in WikiHistory) won't
  // surface the new server-side count unless we sync on prop
  // change. Reset whenever the target identity or the incoming
  // count / approver list / "did I stamp" flag changes — covers
  // the cases where `inserted: false` means our optimistic delta
  // was wrong, another reviewer changed the count between our
  // action and the refetch, or a withdraw didn't actually remove
  // anything. Effect deps key off scalar fields so a fresh-object
  // `initial` reference each render doesn't re-fire on every parent
  // pass; only meaningful changes do.
  const initialCount = initial.count;
  const initialApprovedByMe = initial.approvedByMe ?? false;
  const initialApproverIds = initial.approvers.map((a) => a.id).join(',');
  useEffect(() => {
    setSummary(initial);
    // Effect intentionally re-syncs only when scalar identity bits
    // change — the `initial` reference itself isn't a dep so we
    // don't oscillate when the parent rebuilds its fallback object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetType,
    targetId,
    initialCount,
    initialApprovedByMe,
    initialApproverIds,
  ]);

  async function handleClick() {
    if (!canStamp || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (summary.approvedByMe) {
        await withdrawApproval({ targetType, targetId });
        setSummary((prev) => ({
          ...prev,
          count: Math.max(0, prev.count - 1),
          approvers: prev.approvers.filter((a) => a.id !== user!.id),
          approvedByMe: false,
        }));
      } else {
        const me: ApproverRef = {
          id: user!.id,
          username: user!.username,
          displayName: user!.displayName ?? null,
          role: user!.role,
          isAgent: false,
        };
        await addApproval({ targetType, targetId });
        setSummary((prev) => {
          if (prev.approvedByMe) return prev;
          return {
            count: prev.count + 1,
            approvers: [...prev.approvers, me],
            approvedByMe: true,
          };
        });
      }
      onChange?.();
    } catch (err) {
      // Map known stable codes to localized strings; fall back to
      // raw server prose for codes we haven't taught the UI yet.
      const code =
        err instanceof ApprovalsApiError ? err.code : null;
      const key = code ? APPROVAL_ERROR_KEYS[code] : undefined;
      setError(
        key
          ? t(key)
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  const tooltipParts: string[] = [];
  if (summary.approvers.length > 0) {
    tooltipParts.push(
      summary.approvers.map((a) => approverDisplay(a)).join(', '),
    );
  } else {
    tooltipParts.push(
      t('approvals.noApprovalsYet', { defaultValue: 'No approvals yet' }),
    );
  }
  if (canStamp) {
    tooltipParts.push(
      summary.approvedByMe
        ? t('approvals.clickToWithdraw', {
            defaultValue: 'Click to withdraw your approval',
          })
        : t('approvals.clickToApprove', {
            defaultValue: 'Click to approve',
          }),
    );
  }
  const tooltip = tooltipParts.join(' — ');

  const baseChip =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none transition-colors';
  const stampClasses = summary.approvedByMe
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : summary.count > 0
      ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
      : 'border-border bg-muted/40 text-muted-foreground';
  const interaction = canStamp
    ? 'cursor-pointer hover:bg-emerald-500/15'
    : 'cursor-default';
  const visibility = variant === 'hover' ? 'opacity-70 hover:opacity-100' : '';

  return (
    <button
      type="button"
      onClick={canStamp ? handleClick : undefined}
      disabled={!canStamp || busy}
      title={error ?? tooltip}
      aria-label={t('approvals.stampAriaLabel', {
        count: summary.count,
        defaultValue:
          '{{count}} approval(s). Click to add or withdraw your stamp.',
      })}
      className={`${baseChip} ${stampClasses} ${interaction} ${visibility} disabled:opacity-50`}
    >
      <span aria-hidden="true">{summary.count > 0 ? '✓' : '○'}</span>
      <span>{summary.count}</span>
    </button>
  );
}
