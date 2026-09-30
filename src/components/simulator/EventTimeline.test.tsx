import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EventTimeline,
  computeTimelineRange,
  computeTimelineTicks,
  type TimelineMarker,
} from './EventTimeline';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${params.label} at ${params.time}` : key,
  }),
}));

const marker: TimelineMarker = {
  id: 'cfg:event',
  configId: 'cfg',
  eventId: 'event',
  t: 2,
  label: '500 mg',
  color: '#2563eb',
  kind: 'dose',
};

function renderTimeline(
  props: Partial<Parameters<typeof EventTimeline>[0]> = {},
) {
  const onMarkerSelect = vi.fn();
  const onMarkerTimeChange = vi.fn();
  render(
    <EventTimeline
      markers={[marker]}
      fromHour={0}
      toHour={10}
      timeFormat="hours"
      referenceTime="00:00"
      onMarkerSelect={onMarkerSelect}
      onMarkerTimeChange={onMarkerTimeChange}
      {...props}
    />,
  );
  const track = screen.getByTestId('event-timeline-track');
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 56,
    width: 100,
    height: 56,
    toJSON: () => ({}),
  } as DOMRect);
  return { onMarkerSelect, onMarkerTimeChange };
}

describe('EventTimeline', () => {
  it('selects markers and supports keyboard timing changes', () => {
    const { onMarkerSelect, onMarkerTimeChange } = renderTimeline();
    const button = screen.getByRole('button', { name: /500 mg at 2.0 h/ });

    fireEvent.click(button);
    expect(onMarkerSelect).toHaveBeenCalledWith(marker);

    fireEvent.keyDown(button, { key: 'ArrowRight' });
    expect(onMarkerTimeChange).toHaveBeenCalledWith(marker, 2.25);

    fireEvent.keyDown(button, { key: 'ArrowLeft', shiftKey: true });
    expect(onMarkerTimeChange).toHaveBeenCalledWith(marker, 1);
  });

  it('maps horizontal pointer drag to timeline hours', () => {
    const { onMarkerSelect, onMarkerTimeChange } = renderTimeline();
    const button = screen.getByRole('button', { name: /500 mg at 2.0 h/ });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(pointerDown, 'clientX', { value: 50 });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    fireEvent(button, pointerDown);
    const pointerMove = new Event('pointermove', { bubbles: true });
    Object.defineProperty(pointerMove, 'clientX', { value: 50 });
    Object.defineProperty(pointerMove, 'pointerId', { value: 1 });
    fireEvent(button, pointerMove);

    expect(onMarkerSelect).toHaveBeenCalledWith(marker);
    expect(onMarkerTimeChange).toHaveBeenCalledWith(marker, 5);
  });
});

describe('computeTimelineRange', () => {
  it('uses a default day window when there are no timed points', () => {
    expect(computeTimelineRange([], [])).toEqual({ from: 0, to: 24 });
  });

  it('keeps a far single marker inside an editable window', () => {
    // A lone event at 72 h must not snap to a 0–24 h fallback, which would
    // corrupt the stored time the moment it is nudged or dragged. The window
    // now starts just before the marker (small left pad) rather than at 0, so a
    // late-in-day event doesn't leave hours of empty baseline on the left.
    const { from, to } = computeTimelineRange([72], []);
    expect(from).toBe(71.5);
    expect(to).toBeGreaterThan(72);
  });

  it('starts a single point at the origin just before it, spanning a day', () => {
    // A small left pad keeps drag headroom; the degenerate single-point span
    // still widens to ~a day so a nudge isn't clamped into 0–24 h.
    expect(computeTimelineRange([0], [])).toEqual({ from: -0.5, to: 23.5 });
  });

  it('leaves headroom above the furthest marker so it can extend right', () => {
    // Dose at 0, query at 1, no results: the query defines the right edge and
    // must keep room to be dragged later in time.
    const { to } = computeTimelineRange([0, 1], []);
    expect(to).toBeGreaterThan(1);
  });

  it('does not pad past results that already extend beyond the markers', () => {
    expect(computeTimelineRange([5], [0, 10])).toEqual({ from: 0, to: 10 });
  });

  it('includes negative marker times in the window', () => {
    const { from, to } = computeTimelineRange([-3], []);
    // Starts a small pad before the earliest marker, so it stays draggable.
    expect(from).toBe(-3.5);
    expect(to).toBeGreaterThan(-3);
  });
});

describe('computeTimelineTicks', () => {
  it('steps whole hours across a short window', () => {
    expect(computeTimelineTicks(0, 10)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('coarsens the step for a long window so ticks stay ~12 apart', () => {
    // A day-long window: (24 - 0) / 12 = 2 h per tick.
    expect(computeTimelineTicks(0, 24)).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24,
    ]);
  });

  it('starts at the first whole hour inside a fractional window', () => {
    expect(computeTimelineTicks(0.5, 5.5)).toEqual([1, 2, 3, 4, 5]);
  });
});
