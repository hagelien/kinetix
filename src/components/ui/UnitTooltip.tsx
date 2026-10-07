import {
  Children,
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  getConversionTooltipRows,
  type AlternativeRange,
} from '@/lib/unitTooltip';
import { useDisplayUnits } from './DrugUnitScope';
import { useHoverGrace } from '@/lib/useHoverGrace';

interface UnitTooltipProps {
  /** Visible content (typically a formatted "100–300 µmol/L" string). */
  children: ReactNode;
  /** Numeric source — provide either `value` or `low`/`high` (or both). */
  value?: number | null;
  low?: number | null;
  high?: number | null;
  /** The unit that the visible content is rendered in. */
  unit: string | null | undefined;
  /**
   * The unit the value was authored in, when the visible content has already
   * been converted into `unit` (the reader's preferred unit). The authored
   * figure then leads the tooltip, so the source's own numbers stay one hover
   * away. Defaults to `unit` — the value is shown as written.
   */
  sourceUnit?: string | null;
  /**
   * Authored display text for the source-unit row. Use this when the source
   * carries meaningful precision that cannot survive a number round-trip.
   */
  sourceFormatted?: string | null;
  /** Drug molecular weight — required for molar↔mass conversions. */
  molecularWeight: number | null | undefined;
  /**
   * Whether the trigger takes keyboard focus (default true). Pass `false` when
   * the tooltip sits inside another interactive element, such as a button, so
   * that element is the only tab stop. The nearest such ancestor then opens
   * and is described by the panel on keyboard focus.
   */
  focusable?: boolean;
  /** Optional className applied to the wrapping span. */
  className?: string;
}

function splitChildrenOnUnit(
  children: ReactNode,
  unit: string | null | undefined,
): { prefix: string; trigger: string; suffix: string } | null {
  if (!unit) return null;
  const parts = Children.toArray(children);
  if (
    parts.length === 0 ||
    parts.some((part) => typeof part !== 'string' && typeof part !== 'number')
  ) {
    return null;
  }

  const text = parts.join('');
  const index = text.lastIndexOf(unit);
  if (index < 0) return null;
  return {
    prefix: text.slice(0, index),
    trigger: text.slice(index, index + unit.length),
    suffix: text.slice(index + unit.length),
  };
}

/** One row's formatted value, decomposed into the tooltip grid's cells. */
interface RowParts {
  /** A leading "≥ "/"≤ " (or "< "/"> ") bound marker, when the row carries one. */
  qualifier: string;
  low: string;
  /** The en dash of a low–high range; empty for a single figure. */
  separator: string;
  high: string;
}

/**
 * Decompose a formatted row value into the cells the tooltip grid aligns on.
 *
 * Each number sits whole in its own right-aligned column — the low endpoint,
 * the range dash, the high endpoint — so every column has one clean edge, the
 * way figures line up in a spreadsheet. (Aligning on the decimal point was
 * tried, but rows span several orders of magnitude — `0.00276` next to
 * `2 760` — and the long fractional tails pushed the figures apart into a
 * ragged scatter.) A single figure leaves the dash and high columns empty;
 * those tracks are `auto`, so they collapse and the unit sits straight after
 * the number. Anything that isn't a plain range (an authored source
 * representation, for one) is shown whole in the low cell.
 */
function splitFormatted(formatted: string): RowParts {
  const qualifierMatch = /^([≥≤<>]\s*)(.*)$/.exec(formatted);
  const qualifier = qualifierMatch?.[1] ?? '';
  const rest = qualifierMatch?.[2] ?? formatted;

  // `formatWithMaxDecimals` joins a range with an en dash; a negative number
  // uses a hyphen-minus, so the two can never be confused.
  const dash = rest.indexOf('–');
  if (dash > 0 && dash < rest.length - 1) {
    return {
      qualifier,
      low: rest.slice(0, dash).trim(),
      separator: '–',
      high: rest.slice(dash + 1).trim(),
    };
  }
  return { qualifier, low: rest, separator: '', high: '' };
}

/**
 * Wraps a concentration display with a hover popover showing the same value
 * in all other relevant concentration units (nmol/L, µmol/L, mmol/L, µg/L,
 * mg/L). When `molecularWeight` is missing, only same-kind alternatives are
 * shown. Renders nothing extra when no alternatives are available.
 */
export function UnitTooltip({
  children,
  value,
  low,
  high,
  unit,
  sourceUnit,
  sourceFormatted,
  molecularWeight,
  focusable = true,
  className,
}: UnitTooltipProps) {
  // Shared grace hook: spreading `hoverProps` on both the trigger wrapper and
  // the popover keeps it open while the pointer travels into it (the deferred
  // close bridges the gap between the trigger and the offset panel).
  const { open, hoverProps, show } = useHoverGrace();
  const onBlurRef = useRef(hoverProps.onBlur);
  onBlurRef.current = hoverProps.onBlur;
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const enabledUnits = useDisplayUnits();

  const alternatives: AlternativeRange[] = getConversionTooltipRows(
    {
      value: value ?? undefined,
      low: low ?? undefined,
      high: high ?? undefined,
    },
    sourceUnit ?? unit ?? undefined,
    unit ?? undefined,
    molecularWeight ?? undefined,
    enabledUnits,
  ).map((alternative) =>
    sourceFormatted && alternative.unit === sourceUnit
      ? { ...alternative, formatted: sourceFormatted }
      : alternative,
  );
  const split = splitChildrenOnUnit(children, unit);

  /**
   * Place the panel against the VIEWPORT rather than the trigger's box.
   *
   * The panel used to be an absolutely positioned child centred on its trigger,
   * which put it at the mercy of every ancestor: inside a scrolling dialog the
   * left half of a wide conversion chain was simply clipped away. Fixed
   * positioning escapes ancestor overflow, and clamping both axes to the
   * viewport means a trigger near an edge pushes the panel inwards instead of
   * off-screen. Recomputed on scroll and resize while open, since fixed
   * coordinates do not follow the trigger on their own.
   *
   * Both axes are clamped, not just the horizontal one: on a short viewport
   * neither side of the trigger has room, and "flip below" alone would push the
   * panel off the bottom — the same clipping, in the other direction. A panel
   * taller than the viewport is capped and scrolls internally (the hover grace
   * props are on the panel, so it stays open while the pointer is inside it).
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const t = trigger.getBoundingClientRect();
      const p = tooltip.getBoundingClientRect();
      const margin = 8;
      const viewportH = window.innerHeight;
      const above = t.top - p.height - 4;
      const preferred = above >= margin ? above : t.bottom + 4;
      // Never let the bottom edge run past the viewport; when even that cannot
      // fit, sit at the top margin and let the cap below make it scrollable.
      const maxTop = Math.max(margin, viewportH - p.height - margin);
      const centred = t.left + t.width / 2 - p.width / 2;
      const maxLeft = Math.max(margin, window.innerWidth - p.width - margin);
      setPosition({
        left: Math.max(margin, Math.min(centred, maxLeft)),
        top: Math.max(margin, Math.min(preferred, maxTop)),
        maxHeight: viewportH - 2 * margin,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, alternatives.length]);

  /**
   * A non-focusable trigger sits inside another interactive element (a button)
   * that is the real tab stop. Focus on that ancestor never reaches the
   * descendant trigger, so the ancestor itself opens and describes the panel.
   */
  const hasAlternatives = alternatives.length > 0;
  useEffect(() => {
    if (focusable || !hasAlternatives) return;
    const host = triggerRef.current?.closest<HTMLElement>(
      'button, a[href], [role="button"]',
    );
    if (!host) return;
    const previous = host.getAttribute('aria-describedby');
    host.setAttribute(
      'aria-describedby',
      previous ? `${previous} ${tooltipId}` : tooltipId,
    );
    const onFocusOut = () => onBlurRef.current();
    host.addEventListener('focusin', show);
    host.addEventListener('focusout', onFocusOut);
    return () => {
      host.removeEventListener('focusin', show);
      host.removeEventListener('focusout', onFocusOut);
      if (previous) host.setAttribute('aria-describedby', previous);
      else host.removeAttribute('aria-describedby');
    };
  }, [focusable, hasAlternatives, tooltipId, show]);

  if (alternatives.length === 0) {
    return <span className={className}>{children}</span>;
  }

  const tooltip = (
    <span
      ref={tooltipRef}
      id={tooltipId}
      role="tooltip"
      {...hoverProps}
      className={`fixed z-50 max-w-[min(22rem,calc(100vw-1rem))] whitespace-normal break-words rounded-md border border-border bg-popover px-3 py-2 text-sm leading-relaxed text-popover-foreground shadow-md tabular-nums ${
        open ? '' : 'sr-only'
      }`}
      // Measured off-screen on the first open (position is still null), so the
      // panel never flashes at the top-left corner before it is placed.
      style={
        open
          ? {
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              maxHeight: position?.maxHeight,
              overflowY: 'auto',
              visibility: position ? 'visible' : 'hidden',
            }
          : undefined
      }
    >
      {/*
        Every enabled unit gets its own row, molar and mass alike, ordered as
        `getConversionTooltipRows` returns them (source unit first, then the
        reader's enabled units). Each row is split across grid columns — bound
        qualifier, low endpoint, range dash, high endpoint, unit — with every
        number right-aligned and every unit left-aligned, so the panel reads as
        a tidy table. Unused tracks are `auto` and collapse to zero width.
      */}
      <span
        className="grid items-baseline gap-y-0.5"
        style={{
          gridTemplateColumns: 'auto auto auto auto auto',
        }}
      >
        {alternatives.map((a) => {
          const parts = splitFormatted(a.formatted);
          return (
            <Fragment key={a.unit}>
              <span className="text-right">{parts.qualifier}</span>
              <span className="whitespace-nowrap text-right">{parts.low}</span>
              <span className={parts.separator ? 'px-1 text-center' : undefined}>
                {parts.separator}
              </span>
              <span className="whitespace-nowrap text-right">{parts.high}</span>
              <span className="whitespace-nowrap pl-1 text-left">{` ${a.unit}`}</span>
            </Fragment>
          );
        })}
      </span>
    </span>
  );

  if (split) {
    return (
      <span className={`relative inline-block ${className ?? ''}`} {...hoverProps}>
        <span>
          {split.prefix}
          <span
            ref={triggerRef}
            className="border-b border-dotted border-muted-foreground/40 cursor-help"
            tabIndex={focusable ? 0 : undefined}
            aria-describedby={tooltipId}
          >
            {split.trigger}
          </span>
          {split.suffix}
        </span>
        {tooltip}
      </span>
    );
  }

  return (
    <span
      ref={triggerRef}
      className={`relative inline-block ${className ?? ''}`}
      {...hoverProps}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={tooltipId}
    >
      <span className="border-b border-dotted border-muted-foreground/40 cursor-help">
        {children}
      </span>
      {/*
        The tooltip element is rendered into the DOM in both states so that
        assistive tech wired through `aria-describedby` always finds it; we
        toggle visibility (and presentation) rather than mounting/unmounting.
      */}
      {tooltip}
    </span>
  );
}
