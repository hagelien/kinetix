import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelingChart } from './ModelingChart';

const plotlyMock = vi.hoisted(() => ({
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
}));

vi.mock('plotly.js-basic-dist-min', () => plotlyMock);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('ModelingChart', () => {
  beforeEach(() => {
    plotlyMock.newPlot.mockResolvedValue(document.createElement('div'));
    plotlyMock.react.mockResolvedValue(document.createElement('div'));
    plotlyMock.purge.mockReset();
    plotlyMock.newPlot.mockClear();
    plotlyMock.react.mockClear();
  });

  it('renders an empty placeholder without loading Plotly', async () => {
    render(
      <ModelingChart
        series={[]}
        options={{ emptyMessage: 'No simulation yet' }}
      />,
    );

    expect(screen.getByText('No simulation yet')).toBeInTheDocument();
    await Promise.resolve();
    expect(plotlyMock.newPlot).not.toHaveBeenCalled();
    expect(plotlyMock.react).not.toHaveBeenCalled();
  });

  it('loads Plotly when series data is available', async () => {
    render(
      <ModelingChart
        series={[
          {
            id: 'ethanol',
            label: 'Ethanol',
            points: [
              { x: 0, y: 0.1 },
              { x: 1, y: 0.05 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => expect(plotlyMock.newPlot).toHaveBeenCalledTimes(1));
  });

  it('syncs the x-axis to an external timeline and draws vertical event lines', async () => {
    render(
      <ModelingChart
        series={[
          {
            id: 'amp',
            label: 'Amphetamine',
            points: [
              { x: 0, y: 3.5 },
              { x: 12, y: 1.8 },
            ],
          },
        ]}
        options={{
          xRange: [0, 24],
          xTickHours: [0, 6, 12, 18, 24],
          timeMarkers: [
            { x: 4, color: '#2563eb', label: 'Prediksjon' },
            { x: 6, color: '#2563eb', label: 'Måling' },
          ],
        }}
      />,
    );

    await waitFor(() => expect(plotlyMock.newPlot).toHaveBeenCalledTimes(1));
    const layout = plotlyMock.newPlot.mock.calls[0]![2] as {
      xaxis: { range?: [number, number]; tickvals?: number[] };
      shapes: Array<{ type?: string; x0?: number; x1?: number; yref?: string }>;
    };

    // Shared window + ticks with the timeline strip below.
    expect(layout.xaxis.range).toEqual([0, 24]);
    expect(layout.xaxis.tickvals).toEqual([0, 6, 12, 18, 24]);

    // One full-height vertical guide line per event marker.
    const verticalLines = layout.shapes.filter(
      (s) => s.type === 'line' && s.yref === 'paper' && s.x0 === s.x1,
    );
    expect(verticalLines.map((s) => s.x0)).toEqual([4, 6]);
  });

  it('gives each series its own y-axis when perSeriesAxis is on', async () => {
    render(
      <ModelingChart
        series={[
          { id: 'amp', label: 'Amphetamine', color: '#2563eb', points: [{ x: 0, y: 12 }] },
          { id: 'mor', label: 'Morphine', color: '#10b981', points: [{ x: 0, y: 0.2 }] },
        ]}
        options={{
          perSeriesAxis: true,
          referenceLines: [
            { y: 0.05, label: 'Morphine Toksisk', color: '#10b981', seriesId: 'mor' },
          ],
        }}
      />,
    );

    await waitFor(() => expect(plotlyMock.newPlot).toHaveBeenCalledTimes(1));
    const [, traces, layout] = plotlyMock.newPlot.mock.calls[0]! as [
      unknown,
      Array<{ legendgroup?: string; yaxis?: string }>,
      {
        yaxis?: unknown;
        yaxis2?: { overlaying?: string; side?: string };
        shapes: Array<{ yref?: string }>;
      },
    ];

    // A second, independently-scaled axis on the right for the second drug.
    expect(layout.yaxis).toBeDefined();
    expect(layout.yaxis2?.overlaying).toBe('y');
    expect(layout.yaxis2?.side).toBe('right');

    // The Morphine line trace is anchored to the second axis…
    const morLine = traces.find((tr) => tr.legendgroup === 'mor' && tr.yaxis);
    expect(morLine?.yaxis).toBe('y2');
    // …and so is its threshold line.
    expect(layout.shapes.some((s) => s.yref === 'y2')).toBe(true);
  });

  it('routes legend clicks to onSeriesToggle instead of Plotly default', async () => {
    const onSeriesToggle = vi.fn();
    const handlers: Record<string, (e: unknown) => boolean | void> = {};
    const el = document.createElement('div') as HTMLDivElement & {
      on: (event: string, cb: (e: unknown) => boolean | void) => void;
    };
    el.on = (event, cb) => {
      handlers[event] = cb;
    };
    plotlyMock.newPlot.mockResolvedValueOnce(el);

    render(
      <ModelingChart
        series={[
          { id: 'amp', label: 'Amphetamine', points: [{ x: 0, y: 1 }] },
          { id: 'mor', label: 'Morphine', points: [{ x: 0, y: 2 }] },
        ]}
        options={{ onSeriesToggle }}
      />,
    );

    await waitFor(() => expect(handlers['plotly_legendclick']).toBeDefined());
    const traces = plotlyMock.newPlot.mock.calls[0]![1] as Array<{
      legendgroup?: string;
    }>;
    // Simulate a click on the Morphine legend entry.
    const morIdx = traces.findIndex((tr) => tr.legendgroup === 'mor');
    const result = handlers['plotly_legendclick']!({
      curveNumber: morIdx,
      data: traces,
    });

    expect(onSeriesToggle).toHaveBeenCalledWith('mor');
    // Returning false suppresses Plotly's built-in hide.
    expect(result).toBe(false);
  });
});
