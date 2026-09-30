import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_CLOSE_DELAY_MS, useHoverGrace } from './useHoverGrace';

describe('useHoverGrace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('opens on enter and stays open while the close window is cancelled', () => {
    const { result } = renderHook(() => useHoverGrace());

    expect(result.current.open).toBe(false);

    // Pointer enters the trigger.
    act(() => result.current.hoverProps.onMouseEnter());
    expect(result.current.open).toBe(true);

    // Pointer leaves the trigger (schedules close) then enters the popover
    // before the grace window elapses — the close is cancelled.
    act(() => result.current.hoverProps.onMouseLeave());
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 4);
    });
    expect(result.current.open).toBe(true);
  });

  it('closes only after the grace window once the pointer leaves for good', () => {
    const { result } = renderHook(() => useHoverGrace());

    act(() => result.current.hoverProps.onMouseEnter());
    act(() => result.current.hoverProps.onMouseLeave());

    // Still open within the grace window.
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 1);
    });
    expect(result.current.open).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.open).toBe(false);
  });

  it('close() cancels a pending close and shuts immediately', () => {
    const { result } = renderHook(() => useHoverGrace());

    act(() => result.current.show());
    expect(result.current.open).toBe(true);

    act(() => result.current.close());
    expect(result.current.open).toBe(false);

    // A close scheduled before close() must not reopen anything later.
    act(() => result.current.hoverProps.onMouseLeave());
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2);
    });
    expect(result.current.open).toBe(false);
  });

  it('toggle() flips the open state', () => {
    const { result } = renderHook(() => useHoverGrace());

    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
  });
});
