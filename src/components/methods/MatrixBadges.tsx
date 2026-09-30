import { useTranslation } from 'react-i18next';
import type { MethodMatrix } from '@/lib/drugApi';
import { matrixColor, matrixGradient, matrixLabelKey } from '@/lib/methodMeta';
import { cn } from '@/lib/utils';

interface MatrixBadgesProps {
  matrices: MethodMatrix[];
  className?: string;
}

/**
 * Colour-coded matrix indicator for a method. Each matrix has its own colour
 * (a leading dot); a method that runs in several matrices renders a single
 * pill whose background is striped in all the relevant matrix colours, so it
 * is visibly "partly coloured" in every matrix it applies to.
 */
export function MatrixBadges({ matrices, className }: MatrixBadgesProps) {
  const { t } = useTranslation();

  if (matrices.length === 0) {
    return <span className="text-muted-foreground">–</span>;
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
      style={{ background: matrixGradient(matrices) }}
    >
      {matrices.map((mx, i) => (
        <span key={mx} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-muted-foreground/60">·</span>}
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: matrixColor(mx) }}
          />
          {t(matrixLabelKey(mx))}
        </span>
      ))}
    </span>
  );
}
