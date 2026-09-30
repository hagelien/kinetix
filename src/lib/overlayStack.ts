import { useCallback, useEffect, useRef } from 'react';

/**
 * Registry of the overlays currently on screen, innermost last.
 *
 * Overlays here listen on `document` — for Escape, and for Tab when they trap
 * focus — so without a shared notion of "who is on top" every open overlay
 * reacts to the same keypress. That is harmless for Escape (closing two things
 * at once is merely rude) but breaks a focus trap outright: a lower modal sees
 * focus sitting in the higher overlay, judges it "outside", and yanks it back
 * on every Tab, leaving the thing the user is actually looking at unusable by
 * keyboard. The app shell's Ctrl+K palette and Ctrl+Shift+U unit converter both
 * render above `ModalOverlay` and can open while one is up, so this is reachable
 * rather than theoretical.
 *
 * Membership is a plain array rather than a count because overlays do not
 * necessarily unmount in the order they mounted.
 */
const stack: object[] = [];

/**
 * Registers this component as an overlay layer while `active`, and returns a
 * predicate telling it whether it is the topmost one.
 *
 * Call the predicate inside the event handler, never during render: the answer
 * changes when some *other* overlay opens above, which does not re-render this
 * one. An inactive (or unmounted) layer is never on top, so a guarded handler
 * simply does nothing.
 */
export function useOverlayLayer(active: boolean = true): () => boolean {
  // Identity for this component instance; the object itself is the token.
  const tokenRef = useRef<object>({});

  useEffect(() => {
    if (!active) return;
    const token = tokenRef.current;
    stack.push(token);
    return () => {
      const index = stack.lastIndexOf(token);
      if (index !== -1) stack.splice(index, 1);
    };
  }, [active]);

  // Stable identity: callers list it in effect deps alongside their handler,
  // and a fresh function each render would re-bind the listener every time.
  return useCallback(
    () => stack.length > 0 && stack[stack.length - 1] === tokenRef.current,
    [],
  );
}

/** Test-only: drop any registrations leaked by a previous test's overlay. */
export function resetOverlayStackForTests(): void {
  stack.length = 0;
}
