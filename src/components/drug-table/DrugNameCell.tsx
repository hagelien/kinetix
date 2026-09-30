import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { collectDrugAkaTerms } from '@/lib/drugNames';
import { useHoverGrace } from '@/lib/useHoverGrace';
import type { DrugComponent } from '@/types';

interface DrugNameCellProps {
  drug: DrugComponent;
  /** Standard display name already resolved for the active language and cased. */
  displayName: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
  /** Styling for the visible name; the full table defaults to its bold link style. */
  nameClassName?: string;
}

/**
 * The drug table's name cell. Shows the drug's standard (INN) name, and — when
 * the substance carries a shortname or aliases — surfaces those on hover/focus
 * in a tooltip so the abbreviation and every brand/street/literature variant
 * stay one hover away without cluttering the row (the table used to render the
 * shortname inline instead of the standard name).
 *
 * The tooltip is positioned `fixed` against the viewport rather than nested in
 * the cell: the name cell truncates behind `overflow-hidden`, which would clip
 * any absolutely-positioned child. Recomputed on scroll/resize while open, and
 * clamped to the viewport so a row near an edge pushes the panel inwards.
 */
export function DrugNameCell({
  drug,
  displayName,
  t,
  nameClassName = 'font-bold text-primary',
}: DrugNameCellProps) {
  const { shortName, aliases } = collectDrugAkaTerms(drug, displayName);
  const hasTooltip = shortName != null || aliases.length > 0;

  const { open, hoverProps } = useHoverGrace();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || !hasTooltip) return;
    const place = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const tr = trigger.getBoundingClientRect();
      const tp = tooltip.getBoundingClientRect();
      const margin = 8;
      const below = tr.bottom + 4;
      const above = tr.top - tp.height - 4;
      // Prefer below the name; flip above only when the panel would overrun the
      // viewport bottom and there is room above.
      const top =
        below + tp.height + margin <= window.innerHeight || above < margin
          ? below
          : above;
      const maxLeft = Math.max(margin, window.innerWidth - tp.width - margin);
      setPosition({
        left: Math.max(margin, Math.min(tr.left, maxLeft)),
        top: Math.max(margin, top),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, hasTooltip]);

  if (!hasTooltip) {
    return (
      <span
        className={`${nameClassName} truncate block max-w-full hover:underline`}
        title={displayName}
      >
        {displayName}
      </span>
    );
  }

  return (
    <span
      ref={triggerRef}
      className="relative block w-full max-w-full"
      {...hoverProps}
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      <span className={`${nameClassName} truncate block max-w-full hover:underline`}>
        {displayName}
      </span>
      <span
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        {...hoverProps}
        className={`fixed z-50 max-w-[min(20rem,calc(100vw-1rem))] whitespace-normal break-words rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md ${
          open ? '' : 'sr-only'
        }`}
        style={
          open
            ? {
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                visibility: position ? 'visible' : 'hidden',
              }
            : undefined
        }
      >
        <span className="block font-semibold text-popover-foreground">
          {displayName}
        </span>
        {shortName != null && (
          <span className="mt-1 block">
            <span className="text-muted-foreground">
              {t('drugTable.tooltip.shortName')}:{' '}
            </span>
            {shortName}
          </span>
        )}
        {aliases.length > 0 && (
          <span className="mt-1 block">
            <span className="text-muted-foreground">
              {t('drugTable.tooltip.aliases')}:{' '}
            </span>
            {aliases.join(', ')}
          </span>
        )}
      </span>
    </span>
  );
}
