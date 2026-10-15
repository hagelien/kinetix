import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { compactInlineRefs } from "@/lib/inlineRefs";
import { useCloseTimer } from "@/lib/useHoverGrace";
import {
  citationTooltipLabel,
  citationTooltipTitle,
} from "@/lib/citationFormat";
import { referenceModulePath, type CitationRow } from "@/lib/referencesApi";

export interface ReferenceItem {
  index: number;
  row: CitationRow;
}

const TOOLTIP_VIEWPORT_PADDING = 4;
const TOOLTIP_TARGET_GAP = 14;

function ReferenceTooltipPortal({
  items,
  targetRect,
  panelRef: ref,
  onEnter,
  onLeave,
  onKeyDown,
}: {
  items: ReferenceItem[];
  targetRect: DOMRect;
  panelRef: MutableRefObject<HTMLSpanElement | null>;
  /** Pointer or keyboard focus arrived in the panel. */
  onEnter: () => void;
  /** Pointer or keyboard focus left the panel. */
  onLeave: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => void;
}) {
  const [style, setStyle] = useState({ left: "-9999px", top: "-9999px" });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const tooltipRect = element.getBoundingClientRect();
    let left =
      targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
    left = Math.max(
      TOOLTIP_VIEWPORT_PADDING,
      Math.min(
        left,
        window.innerWidth - tooltipRect.width - TOOLTIP_VIEWPORT_PADDING,
      ),
    );
    let top = targetRect.top - tooltipRect.height - TOOLTIP_TARGET_GAP;
    if (top < TOOLTIP_VIEWPORT_PADDING) top = TOOLTIP_VIEWPORT_PADDING;
    setStyle({ left: `${left}px`, top: `${top}px` });
  }, [targetRect, ref]);

  return createPortal(
    <span
      ref={ref}
      className="citation-tooltip-portal"
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // focusin/focusout bubble, so focus on any link inside keeps the panel
      // open exactly as the pointer resting on it does.
      onFocus={onEnter}
      onBlur={onLeave}
      onKeyDown={onKeyDown}
    >
      {items.map(({ index, row }) => (
        <span key={`${index}-${row.id}`} className="citation-tooltip-entry">
          <a href={referenceModulePath(row.id)}>
            [{index}] {citationTooltipLabel(row)}
          </a>
          <span>{citationTooltipTitle(row)}</span>
        </span>
      ))}
    </span>,
    document.body,
  );
}

interface ReferenceHoverProps {
  /** The citations behind the wrapped value, numbered in the page bibliography. */
  references: ReferenceItem[];
  children: ReactNode;
}

/**
 * Makes a value in a parameter box its own citation trigger: hovering or
 * focusing the value opens a floating panel listing the references behind it
 * (numbered against the page bibliography, linked to each reference page).
 *
 * This replaces the trailing superscript `[n]` markers the parameter boxes
 * used to carry. The bibliography numbers are still announced to assistive
 * technology, and still shown inside the panel, so a number means the same
 * reference here as in the monograph prose.
 *
 * The wrapper is the value's single tab stop and is marked as a focus host, so
 * a nested `UnitTooltip` rendered with `focusable={false}` opens from it too.
 *
 * Keyboard: focusing the value opens the panel; Enter, Space or ArrowDown move
 * focus onto its first citation link. The panel is portalled to the end of the
 * document, so it is not next in the tab order — Tab past its last link (or
 * Shift+Tab before its first) and Escape close it and return focus to the
 * value, from which Tab carries on through the page.
 */
export function ReferenceHover({ references, children }: ReferenceHoverProps) {
  const { t } = useTranslation();
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLSpanElement | null>(null);
  // Set when the keyboard asked to enter a panel that was not open yet; the
  // layout effect below moves focus once the panel has mounted.
  const focusPanelOnOpen = useRef(false);
  // Set while focus is handed back to the value on closing, so that focus
  // event does not immediately reopen the panel it just closed.
  const suppressFocusOpen = useRef(false);
  // Hide is deferred (via the shared grace timer) so the pointer can travel
  // across the gap between the value and the portal-rendered panel without it
  // vanishing; entering either cancels the pending hide.
  const { scheduleClose: scheduleHide, cancelClose: cancelHide } =
    useCloseTimer(() => setTargetRect(null));

  const show = useCallback(
    (target: Element) => {
      cancelHide();
      setTargetRect(target.getBoundingClientRect());
    },
    [cancelHide],
  );

  const firstLink = () =>
    panelRef.current?.querySelector<HTMLAnchorElement>("a[href]") ?? null;

  useLayoutEffect(() => {
    if (!targetRect || !focusPanelOnOpen.current) return;
    focusPanelOnOpen.current = false;
    firstLink()?.focus();
  }, [targetRect]);

  const closeToTrigger = () => {
    cancelHide();
    setTargetRect(null);
    suppressFocusOpen.current = true;
    triggerRef.current?.focus();
    suppressFocusOpen.current = false;
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") {
      if (targetRect) {
        event.preventDefault();
        cancelHide();
        setTargetRect(null);
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown")
      return;
    event.preventDefault();
    const link = firstLink();
    if (link) {
      link.focus();
    } else {
      focusPanelOnOpen.current = true;
      show(event.currentTarget);
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeToTrigger();
      return;
    }
    if (event.key !== "Tab") return;
    const links = Array.from(
      panelRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [],
    );
    const active = document.activeElement;
    const leavingForward = !event.shiftKey && active === links[links.length - 1];
    const leavingBackward = event.shiftKey && active === links[0];
    if (leavingForward || leavingBackward) {
      event.preventDefault();
      closeToTrigger();
    }
  };

  if (references.length === 0) return <>{children}</>;

  const indices = references.map((item) => item.index);

  // The panel is a sibling of the trigger, not a child: React bubbles events
  // through portals along the component tree, and the panel's own pointer and
  // focus events must not re-enter the trigger's handlers.
  return (
    <>
      <span
        className="cursor-help border-b border-dotted border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        ref={triggerRef}
        tabIndex={0}
        role="button"
        aria-expanded={targetRect !== null}
        data-focus-host=""
        data-testid="reference-hover"
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={scheduleHide}
        onFocus={(event) => {
          if (!suppressFocusOpen.current) show(event.currentTarget);
        }}
        onBlur={scheduleHide}
        onKeyDown={onTriggerKeyDown}
      >
        {children}
        <span className="sr-only">
          {compactInlineRefs(indices).map((seg) =>
            seg.from === seg.to
              ? ` ${t("indicators.reference", { n: seg.from })}`
              : ` ${t("indicators.referenceRange", { from: seg.from, to: seg.to })}`,
          )}
        </span>
      </span>
      {targetRect ? (
        <ReferenceTooltipPortal
          items={references}
          targetRect={targetRect}
          panelRef={panelRef}
          onEnter={cancelHide}
          onLeave={scheduleHide}
          onKeyDown={onPanelKeyDown}
        />
      ) : null}
    </>
  );
}
