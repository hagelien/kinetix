import { describe, expect, it } from 'vitest';
import { buildLegalLimitShapes, type LegalLimit } from './simulatorGraphShapes';

const LIMITS: LegalLimit[] = [
  { value: 0.02, color: '#ca8a04', label: '0.2 ‰' },
  { value: 0.05, color: '#ea580c', label: '0.5 ‰' },
  { value: 0.12, color: '#dc2626', label: '1.2 ‰' },
];

describe('buildLegalLimitShapes', () => {
  it('returns empty output when no limits are supplied', () => {
    const { shapes, annotations } = buildLegalLimitShapes(undefined, 'overlay', []);
    expect(shapes).toEqual([]);
    expect(annotations).toEqual([]);
  });

  it('renders one shape + annotation per limit on the shared y-axis in overlay mode', () => {
    const { shapes, annotations } = buildLegalLimitShapes(LIMITS, 'overlay', ['drug-1', 'drug-2']);
    expect(shapes).toHaveLength(3);
    expect(annotations).toHaveLength(3);
    expect(shapes.every((s) => s.yref === 'y')).toBe(true);
    expect(shapes[0]).toMatchObject({
      type: 'line',
      xref: 'paper',
      x0: 0,
      x1: 1,
      y0: 0.02,
      y1: 0.02,
    });
    expect((shapes[0]!.line as { color: string }).color).toBe('#ca8a04');
    expect((shapes[0]!.line as { dash: string }).dash).toBe('dash');
  });

  it('repeats the limits on every subplot y-axis in separate mode', () => {
    const { shapes, annotations } = buildLegalLimitShapes(LIMITS, 'separate', ['drug-1', 'drug-2']);
    expect(shapes).toHaveLength(6);
    expect(annotations).toHaveLength(6);
    const yrefs = new Set(shapes.map((s) => s.yref as string));
    expect(yrefs).toEqual(new Set(['y', 'y2']));
  });

  it('honors a custom dash style per limit', () => {
    const { shapes } = buildLegalLimitShapes(
      [{ value: 0.5, color: '#000', label: 'x', dash: 'dot' }],
      'overlay',
      [],
    );
    expect((shapes[0]!.line as { dash: string }).dash).toBe('dot');
  });
});
