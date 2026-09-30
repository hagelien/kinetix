import { Badge } from '@/components/ui/badge';
import type { MethodMatrix } from '@/lib/drugApi';
import { matrixBorderColor, matrixGradient } from '@/lib/methodMeta';
import { cn } from '@/lib/utils';

interface MethodCodeBadgeProps {
  /** Method code shown inside the pill (e.g. "9001"). */
  code: string;
  /** Sample matrices the method runs in; drives the colour coding. */
  matrices?: MethodMatrix[];
  /** Hover affordance for badges wrapped in a link/button. */
  interactive?: boolean;
  title?: string;
  className?: string;
}

/**
 * A method-code pill colour-coded by its sample matrix (blood, saliva, …),
 * matching the {@link MatrixBadges} colour scheme. A method spanning several
 * matrices gets a striped background in every relevant colour. Used everywhere
 * a method's code is shown as a label button so the colour coding is
 * consistent across the site.
 */
export function MethodCodeBadge({
  code,
  matrices = [],
  interactive,
  title,
  className,
}: MethodCodeBadgeProps) {
  const hasMatrix = matrices.length > 0;
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        interactive && 'cursor-pointer',
        // When uncoloured keep the original primary hover; when colour-coded a
        // primary border/text would clobber the matrix colour, so fade instead.
        interactive &&
          (hasMatrix
            ? 'transition-opacity hover:opacity-80'
            : 'transition-colors hover:border-primary hover:text-primary'),
        className,
      )}
      style={
        hasMatrix
          ? {
              background: matrixGradient(matrices),
              borderColor: matrixBorderColor(matrices),
            }
          : undefined
      }
    >
      {code}
    </Badge>
  );
}
