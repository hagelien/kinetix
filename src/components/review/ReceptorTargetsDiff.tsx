import { useTranslation } from 'react-i18next';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import { formatInteractionLabel } from '@/lib/receptorInteractions';

// Read-only summary of a proposed set of receptor-target mechanisms for the
// review queue. The payload is full-replace, so we render the complete desired
// state rather than a field-by-field diff.

interface ProposedMechanism {
  receptorTargetId?: number | null;
  targetSymbol?: string;
  targetName?: string;
  interactionType?: string;
  tier?: 'primary' | 'secondary' | 'tertiary' | null;
  assaySpecies?: string | null;
  referenceIds?: number[] | null;
  evidenceNote?: string | null;
}

interface ProposedReceptorTargets {
  mechanisms?: ProposedMechanism[];
}

export function ReceptorTargetsDiff({ edit }: { edit: PendingEditRow }) {
  const { t } = useTranslation();
  const value = (edit.proposedValue ?? {}) as ProposedReceptorTargets;
  const mechanisms = value.mechanisms ?? [];

  function tierLabel(tier: ProposedMechanism['tier']): string {
    if (tier === 'primary') return t('sidebar.mechanismPrimary');
    if (tier === 'secondary') return t('sidebar.mechanismSecondary');
    if (tier === 'tertiary') return t('sidebar.mechanismTertiary');
    return t('sidebar.mechanismOther');
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
      <div className="font-medium">{t('review.receptorTargetsDiff.proposed')}</div>
      {mechanisms.length === 0 ? (
        <p className="text-muted-foreground">
          {t('review.receptorTargetsDiff.empty')}
        </p>
      ) : (
        <ul className="space-y-1">
          {mechanisms.map((m, i) => {
            const symbol =
              m.targetSymbol ||
              m.targetName ||
              (m.receptorTargetId != null ? `#${m.receptorTargetId}` : '?');
            const interaction = formatInteractionLabel(
              m.interactionType ?? 'unspecified',
              t,
            );
            const refCount = m.referenceIds?.length ?? 0;
            return (
              <li key={i} className="font-medium">
                {interaction} {t('sidebar.mechanismAt')} {symbol}
                <span className="font-normal text-muted-foreground">
                  {' '}
                  · {tierLabel(m.tier ?? null)}
                  {/* A reviewer approving this decides whether the numbers
                      transfer to humans, so the assay species has to be on the
                      card (#1017), not only in the payload. */}
                  {m.assaySpecies
                    ? ` · ${t('sidebar.assaySpecies')} ${m.assaySpecies}`
                    : ''}
                  {refCount > 0
                    ? ` · ${t('review.receptorTargetsDiff.refs', { count: refCount })}`
                    : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
