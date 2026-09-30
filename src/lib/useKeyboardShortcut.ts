import { useEffect } from 'react';

interface ShortcutDescriptor {
  /** The KeyboardEvent.key value to match (case-insensitive). */
  key: string;
  /** Treat Cmd (macOS) and Ctrl (others) as the same modifier. Defaults to false. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * When false, the shortcut does not fire. Useful to gate on app state
   * (e.g. only when a panel is open). Defaults to true.
   */
  enabled?: boolean;
  /**
   * Suppress the shortcut while focus is in a text-entry surface
   * (input, textarea, contenteditable). Defaults to true so a user
   * typing into the simulator's clock-time field doesn't trigger
   * Ctrl+B accidentally. Pass false for chord shortcuts that you
   * specifically want to fire from inside an input.
   */
  ignoreWhenTyping?: boolean;
  handler: (event: KeyboardEvent) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/**
 * Register a global keyboard shortcut on `document`. Centralizes the
 * keydown plumbing the existing inline `addEventListener` calls were
 * duplicating, including platform-key parity (Cmd ↔ Ctrl) and the
 * "skip while typing" guard.
 */
export function useKeyboardShortcut({
  key,
  ctrl = false,
  shift = false,
  alt = false,
  enabled = true,
  ignoreWhenTyping = true,
  handler,
}: ShortcutDescriptor): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      const ctrlPressed = event.ctrlKey || event.metaKey;
      if (ctrl !== ctrlPressed) return;
      if (shift !== event.shiftKey) return;
      if (alt !== event.altKey) return;
      if (ignoreWhenTyping && isTypingTarget(event.target)) return;
      handler(event);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [key, ctrl, shift, alt, enabled, ignoreWhenTyping, handler]);
}
