import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitTooltip } from './UnitTooltip';

describe('UnitTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('is a tab stop by default and not when focusable is false', () => {
    const { container, rerender } = render(
      <UnitTooltip value={1} unit="mg/L" molecularWeight={100}>
        1 mg/L
      </UnitTooltip>,
    );
    expect(container.querySelector('[tabindex]')).not.toBeNull();

    rerender(
      <UnitTooltip value={1} unit="mg/L" molecularWeight={100} focusable={false}>
        1 mg/L
      </UnitTooltip>,
    );
    expect(container.querySelector('[tabindex]')).toBeNull();
  });

  it('keeps the panel visible while the pointer travels into it', () => {
    const { container } = render(
      <UnitTooltip value={1} unit="mg/L" molecularWeight={100}>
        1 mg/L
      </UnitTooltip>,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;

    // Hovering the trigger shows the panel.
    fireEvent.mouseEnter(wrapper);
    expect(tooltip.className).not.toContain('sr-only');

    // Leaving the trigger schedules a deferred close, but entering the panel
    // within the grace window cancels it — the panel survives the gap.
    fireEvent.mouseLeave(wrapper);
    fireEvent.mouseEnter(tooltip);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip.className).not.toContain('sr-only');
  });

  it('closes after the grace window once the pointer leaves for good', () => {
    const { container } = render(
      <UnitTooltip value={1} unit="mg/L" molecularWeight={100}>
        1 mg/L
      </UnitTooltip>,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;

    fireEvent.mouseEnter(wrapper);
    expect(tooltip.className).not.toContain('sr-only');

    fireEvent.mouseLeave(wrapper);
    // Still open during the grace window.
    expect(tooltip.className).not.toContain('sr-only');

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(tooltip.className).toContain('sr-only');
  });

  it('preserves an authored source representation after inline conversion', () => {
    const { container } = render(
      <UnitTooltip
        value={0.2}
        unit="µmol/L"
        sourceUnit="mg/L"
        sourceFormatted="0,20"
        molecularWeight={100}
      >
        2 µmol/L
      </UnitTooltip>,
    );

    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain(
      '0,20 mg/L',
    );
  });

  it('splits a low–high range into right-aligned endpoint columns', () => {
    const { container } = render(
      <UnitTooltip low={0.429} high={2.993} unit="µmol/L" molecularWeight={303}>
        0.429–2.993 µmol/L
      </UnitTooltip>,
    );

    const cells = Array.from(
      container.querySelectorAll('[role="tooltip"] > span > span'),
    ).map((cell) => cell.textContent);

    // qualifier | low | dash | high | unit — the range no longer lands in
    // one opaque cell.
    expect(cells.slice(0, 5)).toEqual(['', '0.13', '–', '0.907', ' mg/L']);
  });

  it('keeps a bound qualifier in its own cell', () => {
    const { container } = render(
      <UnitTooltip low={0.429} unit="µmol/L" molecularWeight={303}>
        ≥ 0.429 µmol/L
      </UnitTooltip>,
    );

    const cells = Array.from(
      container.querySelectorAll('[role="tooltip"] > span > span'),
    ).map((cell) => cell.textContent);

    // A single endpoint leaves the dash and high columns empty, so they
    // collapse and the unit sits straight after the number.
    expect(cells.slice(0, 5)).toEqual(['\u2265 ', '0.13', '', '', ' mg/L']);
  });

  it('collapses a range whose endpoints are equal into a single figure', () => {
    const { container } = render(
      <UnitTooltip low={2.76} high={2.76} unit="µmol/L" molecularWeight={309.4}>
        2.76 µmol/L
      </UnitTooltip>,
    );

    const tooltip = container.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltip).not.toContain('–');
    expect(tooltip).toContain('0.854');
  });
});
