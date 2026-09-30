import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcut } from '../useKeyboardShortcut';

function dispatch(
  init: Pick<KeyboardEvent, 'key'> & {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    target?: EventTarget;
  },
) {
  const ev = new KeyboardEvent('keydown', {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    bubbles: true,
  });
  if (init.target) {
    Object.defineProperty(ev, 'target', { value: init.target });
  }
  document.dispatchEvent(ev);
}

describe('useKeyboardShortcut', () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
  });

  afterEach(() => {
    input.remove();
  });

  it('fires only on the configured key + modifier combination', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcut({ key: 'b', ctrl: true, handler }),
    );

    dispatch({ key: 'b' });
    expect(handler).not.toHaveBeenCalled();

    dispatch({ key: 'b', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);

    dispatch({ key: 'b', metaKey: true });
    expect(handler).toHaveBeenCalledTimes(2);

    dispatch({ key: 'b', ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('respects shift and alt requirements', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcut({ key: 'u', ctrl: true, shift: true, handler }),
    );

    dispatch({ key: 'u', ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();

    dispatch({ key: 'u', ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('skips while focus is on a text input by default', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcut({ key: 'b', ctrl: true, handler }),
    );

    dispatch({ key: 'b', ctrlKey: true, target: input });
    expect(handler).not.toHaveBeenCalled();
  });

  it('honors ignoreWhenTyping=false', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcut({
        key: 'b',
        ctrl: true,
        ignoreWhenTyping: false,
        handler,
      }),
    );

    dispatch({ key: 'b', ctrlKey: true, target: input });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcut({ key: 'b', ctrl: true, enabled: false, handler }),
    );
    dispatch({ key: 'b', ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
  });
});
