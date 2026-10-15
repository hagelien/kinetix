import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import {
  ParameterSourcesHover,
  SOURCES_PREVIEW_OPEN_DELAY_MS,
} from './ParameterSourcesHover';

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean);
}

describe('ParameterSourcesHover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('keeps a nested unit tooltip description across opening and closing the preview', () => {
    render(
      <ParameterSourcesHover
        parameter="halfLife"
        entryCount={0}
        onOpen={() => {}}
        data-testid="value"
      >
        <UnitTooltip
          value={1}
          unit="mg/L"
          molecularWeight={100}
          focusable={false}
        >
          1 mg/L
        </UnitTooltip>
      </ParameterSourcesHover>,
    );
    const trigger = screen.getByTestId('value');
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    // The unit tooltip describes the button before any preview has opened.
    expect(describedBy(trigger)).toEqual([tooltip.id]);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(SOURCES_PREVIEW_OPEN_DELAY_MS);
    });
    const preview = screen.getByTestId('parameter-sources-preview');
    // Open: both descriptions, the unit tooltip's kept alongside the preview.
    expect(describedBy(trigger)).toEqual([tooltip.id, preview.id]);

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByTestId('parameter-sources-preview')).toBeNull();
    // Closed: the preview's id goes, the unit tooltip's stays.
    expect(describedBy(trigger)).toEqual([tooltip.id]);

    // And it survives a second open/close cycle.
    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(SOURCES_PREVIEW_OPEN_DELAY_MS);
    });
    expect(describedBy(trigger)).toEqual([
      tooltip.id,
      screen.getByTestId('parameter-sources-preview').id,
    ]);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(describedBy(trigger)).toEqual([tooltip.id]);
  });

  it('leaves no description behind when the preview closes on a bare value', () => {
    render(
      <ParameterSourcesHover
        parameter="halfLife"
        entryCount={0}
        onOpen={() => {}}
        data-testid="value"
      >
        2.2 h
      </ParameterSourcesHover>,
    );
    const trigger = screen.getByTestId('value');
    expect(trigger).not.toHaveAttribute('aria-describedby');

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(SOURCES_PREVIEW_OPEN_DELAY_MS);
    });
    const preview = screen.getByTestId('parameter-sources-preview');
    expect(trigger).toHaveAttribute('aria-describedby', preview.id);

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });
});
