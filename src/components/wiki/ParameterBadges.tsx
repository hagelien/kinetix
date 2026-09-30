import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, MessageSquare } from "lucide-react";
import { compactInlineRefs } from "@/lib/inlineRefs";
import { useCloseTimer } from "@/lib/useHoverGrace";
import {
  citationTooltipLabel,
  citationTooltipTitle,
} from "@/lib/citationFormat";
import { referenceModulePath, type CitationRow } from "@/lib/referencesApi";

interface ReferenceItem {
  index: number;
  row: CitationRow;
}

interface ParameterBadgesProps {
  commentCount?: number;
  refCount?: number;
  /** Render the reference indicators (skip for non-editable entries like MW). */
  showRefWarning?: boolean;
  refIndices?: number[];
  references?: ReferenceItem[];
  onCommentClick?: () => void;
}

interface TooltipState {
  items: ReferenceItem[];
  targetRect: DOMRect;
}

const TOOLTIP_VIEWPORT_PADDING = 4;
const TOOLTIP_TARGET_GAP = 14;

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
  const [style, setStyle] = useState({ left: "-9999px", top: "-9999px" });

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
      {state.items.map(({ index, row }) => {
        return (
          <span key={`${index}-${row.id}`} className="citation-tooltip-entry">
            <a href={referenceModulePath(row.id)}>
              [{index}] {citationTooltipLabel(row)}
            </a>
            <span>{citationTooltipTitle(row)}</span>
          </span>
        );
      })}
    </span>,
    document.body,
  );
}

/**
 * Small row of visual indicators for a parameter box:
 *  - accent ⚠ when the parameter has no references attached
 *  - 💬 count when there are comments (clickable to open the discussion panel)
 *  - [1][2][3] superscript when multi-reference indices are provided
 *
 * Review status (verification level, unreviewed-source warnings) is
 * deliberately NOT shown here — it lives in the parameter's discussion and
 * revision history instead, to keep the browse surfaces free of visual noise.
 */
export function ParameterBadges({
  commentCount = 0,
  refCount,
  showRefWarning = true,
  refIndices,
  references,
  onCommentClick,
}: ParameterBadgesProps) {
  const { t } = useTranslation();
  const hasRefWarning = showRefWarning && refCount === 0;
  const [tooltipState, setTooltipState] = useState<TooltipState | null>(null);
  // Hide is deferred (via the shared grace timer) so the pointer can travel
  // across the gap between the reference marker and the portal-rendered tooltip
  // without it vanishing. Entering either the marker or the tooltip cancels the
  // pending hide; the tooltip stays open long enough to click the links inside.
  const { scheduleClose: scheduleHide, cancelClose: cancelHide } = useCloseTimer(
    () => setTooltipState(null),
  );

  const showTooltip = useCallback(
    (items: ReferenceItem[], target: Element) => {
      cancelHide();
      setTooltipState({ items, targetRect: target.getBoundingClientRect() });
    },
    [cancelHide],
  );

  if (!hasRefWarning && !commentCount && !refIndices?.length) return null;

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {refIndices && refIndices.length > 0 && (
        <sup className="text-[10px] font-medium">
          {compactInlineRefs(refIndices).map((seg) => {
            const tooltipItems =
              references?.filter(
                (item) => item.index >= seg.from && item.index <= seg.to,
              ) ?? [];
            return seg.from === seg.to ? (
              <span
                key={`s-${seg.from}`}
                className="relative inline-block"
                onMouseEnter={(event) =>
                  showTooltip(tooltipItems, event.currentTarget)
                }
                onMouseLeave={scheduleHide}
                onFocus={(event) =>
                  showTooltip(tooltipItems, event.currentTarget)
                }
                onBlur={scheduleHide}
              >
                <a
                  href={`#param-ref-${seg.from}`}
                  className="text-primary hover:underline"
                  aria-label={t("indicators.reference", { n: seg.from })}
                >
                  [{seg.from}]
                </a>
              </span>
            ) : (
              <span
                key={`r-${seg.from}-${seg.to}`}
                className="relative inline-block"
                onMouseEnter={(event) =>
                  showTooltip(tooltipItems, event.currentTarget)
                }
                onMouseLeave={scheduleHide}
                onFocus={(event) =>
                  showTooltip(tooltipItems, event.currentTarget)
                }
                onBlur={scheduleHide}
              >
                <a
                  href={`#param-ref-${seg.from}`}
                  className="text-primary hover:underline"
                  aria-label={t("indicators.referenceRange", {
                    from: seg.from,
                    to: seg.to,
                  })}
                >
                  [{seg.from}–{seg.to}]
                </a>
              </span>
            );
          })}
        </sup>
      )}
      {hasRefWarning && (
        <span
          className="inline-flex items-center text-accent"
          title={t("indicators.noReference")}
        >
          <AlertTriangle className="h-3 w-3" />
        </span>
      )}
      <ReferenceTooltipPortal
        state={tooltipState}
        onPointerEnter={cancelHide}
        onPointerLeave={scheduleHide}
      />
      {commentCount > 0 && (
        <button
          type="button"
          onClick={onCommentClick}
          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          title={t("indicators.comments", { count: commentCount })}
        >
          <MessageSquare className="h-3 w-3" />
          {commentCount}
        </button>
      )}
    </span>
  );
}
