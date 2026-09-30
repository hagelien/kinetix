import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnitTooltip } from '@/components/ui/UnitTooltip';

/**
 * Give the trigger and the panel real geometry. jsdom lays nothing out, so
 * every rect is zero unless it is stubbed — and zero-sized boxes can never
 * exercise a clamp.
 */
function stubGeometry(trigger: DOMRect, panelHeight: number, panelWidth: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      if (this.getAttribute('role') === 'tooltip') {
        return { width: panelWidth, height: panelHeight, top: 0, bottom: panelHeight, left: 0, right: panelWidth, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return trigger;
    },
  );
}

function rect(over: Partial<DOMRect>): DOMRect {
  return {
    width: 40,
    height: 16,
    top: 0,
    bottom: 16,
    left: 0,
    right: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...over,
  } as DOMRect;
}

function open() {
  // The trigger carries the hover props; opening measures and places the panel.
  fireEvent.mouseEnter(screen.getByRole('tooltip').parentElement!);
}

describe('UnitTooltip placement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pulls the panel back inside the viewport instead of off its left edge', () => {
    // A trigger hard against the left edge of a scrolling dialog: centring the
    // panel on it would put half the conversion chain off-screen.
    stubGeometry(rect({ left: 4, right: 44, top: 300, bottom: 316 }), 60, 320);
    render(
      <UnitTooltip low={10} high={30} unit="mg/L" molecularWeight={200}>
        10–30 mg/L
      </UnitTooltip>,
    );
    open();
    const panel = screen.getByRole('tooltip') as HTMLElement;
    expect(panel.style.position).toBe('');
    expect(panel.className).toContain('fixed');
    expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8);
  });

  it('keeps the panel on screen when there is no room above or below', () => {
    // Short viewport, tall panel: flipping below would run past the bottom,
    // which is the same clipping the fixed positioning is there to avoid.
    const viewportH = 200;
    Object.defineProperty(window, 'innerHeight', {
      value: viewportH,
      configurable: true,
    });
    stubGeometry(rect({ left: 100, right: 140, top: 150, bottom: 166 }), 160, 320);
    render(
      <UnitTooltip low={10} high={30} unit="mg/L" molecularWeight={200}>
        10–30 mg/L
      </UnitTooltip>,
    );
    open();
    const panel = screen.getByRole('tooltip') as HTMLElement;
    const top = parseFloat(panel.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 160).toBeLessThanOrEqual(viewportH - 8);
    // Taller-than-viewport content is capped and scrolls rather than overflowing.
    expect(panel.style.maxHeight).toBe(`${viewportH - 16}px`);
    expect(panel.style.overflowY).toBe('auto');
  });
});
