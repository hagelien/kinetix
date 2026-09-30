import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Grace window (ms) before a hover popover closes once the pointer leaves both
 * the trigger and the popover. This is the single knob that lets the pointer
 * travel across the dead space between a trigger and its (often detached or
 * offset) popover without the popover vanishing mid-journey.
 */
export const HOVER_CLOSE_DELAY_MS = 150;

interface CloseTimer {
  /** Cancel a pending close. Call on pointer-enter / focus of the trigger OR popover. */
  cancelClose: () => void;
  /** Begin the grace window. Call on pointer-leave / blur of the trigger OR popover. */
  scheduleClose: () => void;
}

/**
 * Low-level deferred-close timer shared by every hover popover on the site.
 *
 * The contract: wire `cancelClose` to the pointer-enter/focus of *both* the
 * trigger and the popover, and `scheduleClose` to the pointer-leave/blur of
 * both. Because the close is deferred by {@link HOVER_CLOSE_DELAY_MS}, moving
 * the pointer off the trigger and onto the popover cancels the pending close
 * before it fires — so the popover survives the gap and stays open long enough
 * to read or click the content inside it.
 *
 * Use this directly when the component manages its own richer open-state
 * (e.g. a portal tooltip holding content + position). For a plain boolean
 * open/closed popover, prefer {@link useHoverGrace}.
 */
export function useCloseTimer(
  onClose: () => void,
  delay: number = HOVER_CLOSE_DELAY_MS,
): CloseTimer {
  const timer = useRef<number | null>(null);
  // Keep the latest callback without re-creating the memoized helpers, so the
  // returned functions stay referentially stable across renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const cancelClose = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onCloseRef.current();
    }, delay);
  }, [cancelClose, delay]);

  // Clear any pending timer on unmount.
  useEffect(() => cancelClose, [cancelClose]);

  return { scheduleClose, cancelClose };
}

interface HoverGraceProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

interface HoverGrace {
  /** Whether the popover should be shown. */
  open: boolean;
  /**
   * Spread onto BOTH the trigger and the popover element. Spreading on both is
   * what keeps the popover alive while the pointer is over it — without it, the
   * popover would close the moment the pointer left the trigger.
   */
  hoverProps: HoverGraceProps;
  /** Open immediately, cancelling any pending close. */
  show: () => void;
  /** Close immediately, cancelling any pending close. */
  close: () => void;
  /** Toggle open/closed (for click/tap triggers). */
  toggle: () => void;
}

/**
 * Universal hover-popover state for the common "boolean open/closed" case.
 *
 * Returns an `open` flag plus a `hoverProps` bundle to spread on the trigger
 * AND the popover. Because `onFocus`/`onBlur` map to focusin/focusout (which
 * bubble), spreading `hoverProps` on the popover container also keeps it open
 * while keyboard focus is on a link or button *inside* the popover.
 *
 * The popover therefore never disappears while the user is pointing at — or
 * tabbing through — it, which is the behaviour every tooltip/popover on the
 * site is expected to have.
 */
export function useHoverGrace(delay: number = HOVER_CLOSE_DELAY_MS): HoverGrace {
  const [open, setOpen] = useState(false);
  const { scheduleClose, cancelClose } = useCloseTimer(
    () => setOpen(false),
    delay,
  );

  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  const toggle = useCallback(() => {
    cancelClose();
    setOpen((v) => !v);
  }, [cancelClose]);

  const hoverProps: HoverGraceProps = {
    onMouseEnter: show,
    onMouseLeave: scheduleClose,
    onFocus: show,
    onBlur: scheduleClose,
  };

  return { open, hoverProps, show, close, toggle };
}
