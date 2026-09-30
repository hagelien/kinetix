import {
  Children,
  Fragment,
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
import { useAppStore } from '@/stores/appStore';
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

/** One row's formatted value, decomposed into decimal-aligned grid cells. */
interface RowParts {
  /** A leading "≥ "/"≤ " (or "< "/"> ") bound marker, when the row carries one. */
  qualifier: string;
  lowInt: string;
  lowFrac: string;
  /** The en dash of a low–high range; empty for a single figure. */
  separator: string;
  highInt: string;
  highFrac: string;
}

/**
 * Split a number as `formatWithMaxDecimals` writes it — digits, optional
 * thousands spaces, optional decimal separator — into the part before the
 * separator and the part from the separator on. Returns null when the text
 * isn't a plain number (an authored `sourceFormatted`, say), so callers can
 * fall back to showing it whole.
 */
function splitNumber(
  text: string,
): { intPart: string; fracPart: string } | null {
  const match = /^(-?[\d\s]*\d)([.,]\d+)?$/.exec(text);
  if (!match) return null;
  return { intPart: match[1] ?? text, fracPart: match[2] ?? '' };
}

/**
 * Decompose a formatted row value into the cells the tooltip grid aligns on.
 *
 * A single figure fills the low columns and leaves the separator and high
 * columns empty — those tracks are `auto`, so they collapse to nothing and the
 * unit sits straight after the number. A low–high range has *two* decimal
 * points, so it gets two aligned number slots rather than landing in the
 * integer column as one opaque string: both endpoints then line up on their own
 * separators down the panel, exactly as scalars do. Anything that doesn't parse
 * as a number (an authored source representation, for one) is shown whole in
 * the leading integer cell, right-aligned like every other entry.
 */
function splitFormatted(formatted: string): RowParts {
  const qualifierMatch = /^([≥≤<>]\s*)(.*)$/.exec(formatted);
  const qualifier = qualifierMatch?.[1] ?? '';
  const rest = qualifierMatch?.[2] ?? formatted;
  const empty = { separator: '', highInt: '', highFrac: '' };

  // `formatWithMaxDecimals` joins a range with an en dash; a negative number
  // uses a hyphen-minus, so the two can never be confused.
  const dash = rest.indexOf('–');
  if (dash > 0) {
    const low = splitNumber(rest.slice(0, dash));
    const high = splitNumber(rest.slice(dash + 1));
    if (low && high) {
      return {
        qualifier,
        lowInt: low.intPart,
        lowFrac: low.fracPart,
        separator: '–',
        highInt: high.intPart,
        highFrac: high.fracPart,
      };
    }
  }

  const single = splitNumber(rest);
  return {
    qualifier,
    lowInt: single?.intPart ?? rest,
    lowFrac: single?.fracPart ?? '',
    ...empty,
  };
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
  className,
}: UnitTooltipProps) {
  // Shared grace hook: spreading `hoverProps` on both the trigger wrapper and
  // the popover keeps it open while the pointer travels into it (the deferred
  // close bridges the gap between the trigger and the offset panel).
  const { open, hoverProps } = useHoverGrace();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const enabledUnits = useAppStore((s) => s.enabledUnits);

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
        reader's enabled units). Each row is split across fixed grid columns —
        bound qualifier, integer part, fractional part, range dash, the second
        endpoint's two parts, unit — so the decimal separators line up down the
        panel and a reader scanning the column can compare magnitudes at a
        glance instead of parsing each figure separately. Unused tracks are
        `auto` and collapse to zero width, so a panel of plain scalars looks
        exactly as it did before ranges were aligned.
      */}
      <span
        className="grid items-baseline gap-y-0.5"
        style={{
          gridTemplateColumns: 'auto auto auto auto auto auto auto',
        }}
      >
        {alternatives.map((a) => {
          const parts = splitFormatted(a.formatted);
          return (
            <Fragment key={a.unit}>
              <span className="text-right">{parts.qualifier}</span>
              <span className="text-right">{parts.lowInt}</span>
              <span className="text-left">{parts.lowFrac}</span>
              <span className={parts.separator ? 'px-1 text-center' : undefined}>
                {parts.separator}
              </span>
              <span className="text-right">{parts.highInt}</span>
              <span className="text-left">{parts.highFrac}</span>
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
            tabIndex={0}
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
      tabIndex={0}
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
