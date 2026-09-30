import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';
import type { AnalyticalMethod } from '@/types';
import { formatMethodLabel } from '@/lib/methodSearch';
import { cn } from '@/lib/utils';

interface MethodSearchMatchesProps {
  /** Methods matching the current search query, already ranked and capped. */
  methods: AnalyticalMethod[];
  /** Apply one of them as the active method filter. */
  onSelect: (methodId: string) => void;
  /** Tighter typography for the narrow sidebar rail. */
  compact?: boolean;
  className?: string;
}

/**
 * Method suggestions for the drug-table search box.
 *
 * The search box searches drug names, so a query like "1006" (an analytical
 * method code) matched nothing at all even though the method exists and its
 * component list is exactly the set of drugs the user wanted. These chips
 * surface those method hits alongside the drug results; picking one applies
 * the method filter that both drug-table surfaces already share via the
 * store.
 */
export function MethodSearchMatches({
  methods,
  onSelect,
  compact = false,
  className,
}: MethodSearchMatchesProps) {
  const { t } = useTranslation();

  if (methods.length === 0) return null;

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      role="group"
      aria-label={t('drugTable.methodMatches')}
    >
      <span
        className={cn(
          'text-muted-foreground',
          compact ? 'text-[11px]' : 'text-xs',
        )}
      >
        {t('drugTable.methodMatches')}
      </span>
      {methods.map((method) => (
        <button
          key={method.id}
          type="button"
          onClick={() => onSelect(method.id)}
          title={t('drugTable.filterByMethod', {
            method: formatMethodLabel(method),
          })}
          aria-label={t('drugTable.filterByMethod', {
            method: formatMethodLabel(method),
          })}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 text-foreground transition-colors hover:border-primary/50 hover:bg-accent/40',
            compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
          )}
        >
          <FlaskConical
            aria-hidden
            className={cn(
              'shrink-0 text-primary',
              compact ? 'h-3 w-3' : 'h-3.5 w-3.5',
            )}
          />
          <span className="truncate">{formatMethodLabel(method)}</span>
          {method.componentCount != null && (
            <span className="shrink-0 text-muted-foreground">
              ({method.componentCount})
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
