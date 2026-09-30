import { describe, expect, it } from 'vitest';
import { buildChartPanels } from './simulatorPanels';
import type { ModelingSeries } from '@/types/modeling';

const s = (id: string, unit?: string): ModelingSeries => ({
  id,
  label: id,
  unit,
  points: [{ x: 0, y: 1 }],
});

describe('buildChartPanels', () => {
  it('returns no panels for no series', () => {
    expect(buildChartPanels([], { mode: 'overlay', normalized: false })).toEqual(
      [],
    );
  });

  it('keeps one panel when all series share a unit', () => {
    const panels = buildChartPanels([s('a', 'mg/L'), s('b', 'mg/L')], {
      mode: 'overlay',
      normalized: false,
    });
    expect(panels).toHaveLength(1);
    expect(panels[0]!.unit).toBe('mg/L');
    expect(panels[0]!.series).toHaveLength(2);
  });

  it('splits incompatible units into separate panels (small multiples)', () => {
    const panels = buildChartPanels(
      [s('a', 'mg/L'), s('b', 'g/dL'), s('c', 'mg/L')],
      { mode: 'overlay', normalized: false },
    );
    expect(panels).toHaveLength(2);
    expect(panels.map((p) => p.unit)).toEqual(['mg/L', 'g/dL']);
    expect(panels[0]!.series.map((x) => x.id)).toEqual(['a', 'c']);
    expect(panels[1]!.series.map((x) => x.id)).toEqual(['b']);
  });

  it('collapses to a single dimensionless panel when normalized', () => {
    const panels = buildChartPanels([s('a', 'mg/L'), s('b', 'g/dL')], {
      mode: 'overlay',
      normalized: true,
    });
    expect(panels).toHaveLength(1);
    expect(panels[0]!.unit).toBeUndefined();
  });

  it('renders one panel per series in separate mode', () => {
    const panels = buildChartPanels([s('a', 'mg/L'), s('b', 'mg/L')], {
      mode: 'separate',
      normalized: false,
    });
    expect(panels).toHaveLength(2);
    expect(panels.map((p) => p.key)).toEqual(['a', 'b']);
  });
});
