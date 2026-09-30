import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useOverlayLayer } from '@/lib/overlayStack';

interface ModalOverlayProps {
  /** Called when the user dismisses the modal (backdrop click or Escape). */
  onClose: () => void;
  /**
   * Accessible name for the dialog — required, because a `role="dialog"` with
   * no name is announced as a bare "dialog". A heading rendered inside the box
   * does NOT name it: nothing links the two, so assistive tech never reads the
   * heading as the dialog's name. Usually the same string as that heading.
   */
  ariaLabel: string;
  /** Additional classes for the modal box (e.g. sizing/layout). */
  className?: string;
  /** Classes for the full-screen backdrop. */
  backdropClassName?: string;
  children: ReactNode;
}

/**
 * Elements a Tab press can land on. Deliberately structural (no visibility
 * test): jsdom reports every element as unrendered, so a geometry-based filter
 * would empty this list under test while behaving differently in a browser.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Full-screen modal backdrop with a centered box. Clicking anywhere on the
 * backdrop (outside the box) or pressing Escape calls `onClose`.
 *
 * Rendered through a portal on `document.body`, because "full-screen" is only
 * true when nothing between the modal and the viewport establishes a new
 * containing block. The monograph's floating parameter rail does exactly that:
 * its slide-over animates with `translate-x-*`, and any non-`none` transform
 * makes the element the containing block for `position: fixed` descendants —
 * so an in-tree overlay would size `inset-0` against a ~20rem rail and be
 * clipped by its `overflow-y-auto`, with backdrop clicks landing on the rail's
 * own backdrop instead. Portalling keeps every consumer viewport-anchored.
 *
 * The portal puts the box after the app root in DOM order, so without a trap
 * the first Tab would walk the page *behind* the overlay rather than the
 * dialog's own controls. Focus therefore moves into the box on open, cycles
 * within it while open, and returns to whatever opened it on close.
 *
 * Both key handlers stand down unless this is the topmost overlay — see
 * `useOverlayLayer`. The app shell's Ctrl+K palette and Ctrl+Shift+U converter
 * render above this box and can be opened while it is up; a trap that still
 * fired would read their focus as "outside" and drag every Tab back down here.
 */
export function ModalOverlay({
  onClose,
  ariaLabel,
  className,
  backdropClassName,
  children,
}: ModalOverlayProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const isTopOverlay = useOverlayLayer();

  // Captured during the first render — deliberately NOT in the effect below.
  // React applies a descendant's `autoFocus` in the commit phase, child-first,
  // so by the time any effect of ours runs the active element can already be a
  // control *inside* the dialog (RejectDialog, ReturnDialog and
  // ParameterFlagDialog all autofocus one). Reading it then would record that
  // control as the opener and, on close, try to restore focus to a node that
  // no longer exists — dropping the user at the top of the page. Render runs
  // before any of that, so it is the last moment the real opener is still
  // focused. A `useState` initializer is the idiomatic run-once-at-render hook.
  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    const box = boxRef.current;
    // Respect a descendant's own `autoFocus`: if the commit phase already put
    // focus inside the box, moving it to the first focusable would override a
    // deliberate choice (RejectDialog autofocuses its textarea, which is not
    // its first control). Only take focus when nothing in here has it.
    const active = document.activeElement;
    if (!box || (active instanceof Node && box.contains(active))) return;
    const first = box.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? box).focus();
  }, []);

  // Hand focus back to whatever opened the dialog, so a keyboard user resumes
  // where they left off. Skipped if the opener has since left the document —
  // focusing a detached node silently drops focus to <body>.
  useEffect(() => {
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Something opened above us: it owns the keyboard until it closes.
      if (!isTopOverlay()) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const box = boxRef.current;
      if (!box) return;
      const items = Array.from(
        box.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      // A dialog with nothing tabbable still must not leak focus to the page
      // behind it; park it on the box.
      if (items.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !box.contains(active);
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isTopOverlay]);

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4',
        backdropClassName,
      )}
      onClick={onClose}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        // Focusable as a last resort so an empty dialog can still hold focus;
        // -1 keeps it out of the normal Tab order.
        tabIndex={-1}
        className={cn('bg-card rounded-lg shadow-xl', className)}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
