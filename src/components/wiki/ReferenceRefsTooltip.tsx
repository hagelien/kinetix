import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCloseTimer } from '@/lib/useHoverGrace';
import {
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import { referenceModulePath, type CitationRow } from '@/lib/referencesApi';

export interface ReferenceItem {
  index: number;
  row: CitationRow;
}

const TOOLTIP_VIEWPORT_PADDING = 4;
const TOOLTIP_TARGET_GAP = 14;

interface TooltipState {
  items: ReferenceItem[];
  targetRect: DOMRect;
}

function ReferenceTooltipPortal({
  state,
  onPointerEnter,
  onPointerLeave,
}: {
  state: TooltipState | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [style, setStyle] = useState({ left: '-9999px', top: '-9999px' });

  useLayoutEffect(() => {
    if (!state) return;
    const element = ref.current;
    if (!element) return;
    const tooltipRect = element.getBoundingClientRect();
    let left =
      state.targetRect.left +
      state.targetRect.width / 2 -
      tooltipRect.width / 2;
    left = Math.max(
      TOOLTIP_VIEWPORT_PADDING,
      Math.min(
        left,
        window.innerWidth - tooltipRect.width - TOOLTIP_VIEWPORT_PADDING,
      ),
    );
    let top = state.targetRect.top - tooltipRect.height - TOOLTIP_TARGET_GAP;
    if (top < TOOLTIP_VIEWPORT_PADDING) top = TOOLTIP_VIEWPORT_PADDING;
    setStyle({ left: `${left}px`, top: `${top}px` });
  }, [state]);

  if (!state || state.items.length === 0) return null;

  return createPortal(
    <span
      ref={ref}
      className="citation-tooltip-portal"
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {state.items.map(({ index, row }) => (
        <span key={`${index}-${row.id}`} className="citation-tooltip-entry">
          <a
            href={referenceModulePath(row.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            [{index}] {citationTooltipLabel(row)}
          </a>
          <span>{citationTooltipTitle(row)}</span>
        </span>
      ))}
    </span>,
    document.body,
  );
}

/**
 * A compact, hoverable "refs" affordance that reveals a tooltip listing a
 * parameter's references (each opening in a new tab). Same look and behaviour as
 * the monograph parameter boxes, distilled to a single label instead of the
 * inline `[1][2]` superscripts — used where a small pill reads cleaner (e.g. the
 * simulator's assumptions pane). Renders nothing when there are no references.
 */
export function ReferenceRefsTooltip({
  references,
  label,
}: {
  references: ReferenceItem[];
  label: string;
}) {
  const [tooltipState, setTooltipState] = useState<TooltipState | null>(null);
  const { scheduleClose: scheduleHide, cancelClose: cancelHide } = useCloseTimer(
    () => setTooltipState(null),
  );

  const showTooltip = useCallback(
    (target: Element) => {
      cancelHide();
      setTooltipState({
        items: references,
        targetRect: target.getBoundingClientRect(),
      });
    },
    [cancelHide, references],
  );

  if (references.length === 0) return null;

  return (
    <span className="ml-1 inline-flex items-center align-middle">
      <span
        tabIndex={0}
        role="button"
        className="cursor-help rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted/70"
        onMouseEnter={(e) => showTooltip(e.currentTarget)}
        onMouseLeave={scheduleHide}
        onFocus={(e) => showTooltip(e.currentTarget)}
        onBlur={scheduleHide}
      >
        {label}
      </span>
      <ReferenceTooltipPortal
        state={tooltipState}
        onPointerEnter={cancelHide}
        onPointerLeave={scheduleHide}
      />
    </span>
  );
}
