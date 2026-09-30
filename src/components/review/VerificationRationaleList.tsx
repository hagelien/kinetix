import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchVerificationsForTarget,
  type AgentVerificationRow,
  type AgentVerificationTargetType,
} from '@/lib/agentVerificationsApi';

interface Props {
  targetType: AgentVerificationTargetType;
  targetId: number;
  /**
   * A fetch failure renders nothing instead of an error line. Use this where
   * the list is an optional enhancement for viewers who may lack the
   * reviewer visibility `pending_edit` verdicts require (e.g. an anonymous
   * visitor on a public page) — an error there is expected, not a fault.
   */
  hideOnError?: boolean;
}

/**
 * The verdicts (approve/dispute/abstain + rationale + evidence) agents have
 * recorded against one target. Shared by the reviewer queue (`PendingEditCard`)
 * and any other surface that links back to the pending edit behind a change
 * (e.g. `ParameterHistoryDialog`, for the pending edit that produced a
 * revision).
 */
export function VerificationRationaleList({
  targetType,
  targetId,
  hideOnError,
}: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; rows: AgentVerificationRow[] }
    | { status: 'error' }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchVerificationsForTarget({ targetType, targetId })
      .then((res) => {
        if (cancelled) return;
        // Implicit-approve rows are visible to the owning agent only; for
        // everyone else the API filters them out, so the list we render here
        // is already the explicit verdicts that warrant attention.
        setState({ status: 'ready', rows: res.verifications });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [targetType, targetId]);

  if (state.status === 'loading') {
    return (
      <p className="text-xs text-muted-foreground">
        {t('review.verification.loadingRationales')}
      </p>
    );
  }
  if (state.status === 'error') {
    if (hideOnError) return null;
    return (
      <p className="text-xs text-rose-600 dark:text-rose-300">
        {t('review.verification.rationalesFailed')}
      </p>
    );
  }
  const rows = state.rows.filter((r) => !r.isImplicit);
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('review.verification.rationalesEmpty')}
      </p>
    );
  }
  return (
    <ul className="space-y-2 text-xs">
      {rows.map((r) => (
        <li
          key={r.id}
          className="space-y-1 rounded-md border border-border bg-muted/30 p-2"
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={
                r.verdict === 'dispute'
                  ? 'rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-700 dark:text-rose-300'
                  : r.verdict === 'approve'
                    ? 'rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300'
                    : 'rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground'
              }
            >
              {t(`review.verification.verdict.${r.verdict}`)}
            </span>
            <span className="font-medium">
              {r.agent?.name ?? r.agent?.slug ?? `agent #${r.agentId}`}
            </span>
            {r.model ? (
              <span className="text-muted-foreground">· {r.model}</span>
            ) : null}
            <span className="text-muted-foreground">
              · {new Date(r.createdAt).toLocaleString()}
            </span>
          </div>
          <p className="whitespace-pre-wrap leading-snug">
            {r.rationaleMd.trim() || t('review.verification.noRationale')}
          </p>
          {r.evidenceRefs.length > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              <span className="font-medium">
                {t('review.verification.evidenceLabel')}:
              </span>{' '}
              {r.evidenceRefs
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
        </li>
      ))}
    </ul>
  );
}
