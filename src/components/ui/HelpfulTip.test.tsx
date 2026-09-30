import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HelpfulTip } from './HelpfulTip';
import { useAppStore } from '@/stores/appStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('HelpfulTip', () => {
  const originalState = useAppStore.getState();

  beforeEach(() => {
    useAppStore.setState({ tipsEnabled: true, dismissedTips: [] });
  });

  afterEach(() => {
    useAppStore.setState(originalState, true);
  });

  it('opens manually via the trigger even when tips are globally off', () => {
    useAppStore.setState({ tipsEnabled: false });
    render(
      <HelpfulTip id="t1" triggerLabel="help" content={<span>hello tip</span>} />,
    );

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByLabelText('help'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    expect(screen.getByText('hello tip')).toBeTruthy();
  });

  it('auto-shows when requested, but only while enabled and undismissed', () => {
    const { rerender } = render(
      <HelpfulTip
        id="t2"
        autoShow
        triggerLabel="help"
        content={<span>auto tip</span>}
      />,
    );
    expect(screen.getByRole('tooltip')).toBeTruthy();

    // "Don't show this again" dismisses just this tip.
    fireEvent.click(screen.getByText('helpfulTip.dontShowAgain'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(useAppStore.getState().dismissedTips).toContain('t2');

    // Re-render with autoShow still true — stays closed because it's dismissed.
    rerender(
      <HelpfulTip
        id="t2"
        autoShow
        triggerLabel="help"
        content={<span>auto tip</span>}
      />,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays open while the pointer moves from the trigger into the popover', () => {
    vi.useFakeTimers();
    try {
      render(
        <HelpfulTip
          id="t4"
          triggerLabel="help"
          content={<a href="/preferences">settings link</a>}
        />,
      );

      const trigger = screen.getByLabelText('help');
      fireEvent.mouseEnter(trigger);
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toBeTruthy();

      // Pointer leaves the trigger (heading for the popover) then lands on the
      // popover before the grace window elapses — it must not disappear.
      fireEvent.mouseLeave(trigger);
      fireEvent.mouseEnter(tooltip);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByRole('tooltip')).toBeTruthy();
      expect(screen.getByText('settings link')).toBeTruthy();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('the global "turn off tips" control disables the universal feature', () => {
    render(
      <HelpfulTip
        id="t3"
        autoShow
        triggerLabel="help"
        content={<span>tip</span>}
      />,
    );
    fireEvent.click(screen.getByText('helpfulTip.turnOffTips'));
    expect(useAppStore.getState().tipsEnabled).toBe(false);
  });
});
