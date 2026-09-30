import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ParameterForestPlot } from '@/components/wiki/ParameterForestPlot';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';

function summary(over: Partial<ParameterSummary> = {}): ParameterSummary {
  return {
    representative: 20,
    iqrLow: 15,
    iqrHigh: 25,
    min: 10,
    max: 40,
    unit: 'mg/L',
    entryCount: 3,
    pooledCount: 3,
    normalizedToWholeBlood: false,
    contributingCitationIds: [1, 2],
    byMatrix: [
      { matrix: 'whole_blood', min: 10, max: 30, representative: 20, sourceCount: 2, unit: 'mg/L' },
      { matrix: 'serum', min: 20, max: 40, representative: 30, sourceCount: 1, unit: 'mg/L' },
    ],
    points: [
      { matrix: 'whole_blood', low: 10, high: 20, representative: 15, qualifier: null, citationId: 1, unit: 'mg/L' },
      { matrix: 'whole_blood', low: 25, high: 30, representative: 28, qualifier: null, citationId: 2, unit: 'mg/L' },
      { matrix: 'serum', low: 20, high: 40, representative: 30, qualifier: null, citationId: 3, unit: 'mg/L' },
    ],
    ...over,
  };
}

describe('ParameterForestPlot', () => {
  it('renders per-source rows, the pooled diamond, and a matrix legend', () => {
    render(<ParameterForestPlot summary={summary()} />);
    // Matrix labels appear in the legend (i18n not loaded → raw keys).
    expect(
      screen.getAllByText('referenceConc.matrix.whole_blood').length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText('referenceConc.matrix.serum').length,
    ).toBeGreaterThan(0);
    // Pooled row label.
    expect(
      screen.getAllByText('parameterEntries.forestPlot.pooled').length,
    ).toBeGreaterThan(0);
    // One <g> row per source (3) plus the pooled group — assert ≥3 title nodes.
    expect(document.querySelectorAll('svg title').length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('svg')).not.toBeNull();
  });

  it('toggles between forest and stacked views', () => {
    render(<ParameterForestPlot summary={summary()} />);
    const toggle = screen.getByText('parameterEntries.forestPlot.stackedView');
    fireEvent.click(toggle);
    expect(
      screen.getByText('parameterEntries.forestPlot.forestView'),
    ).toBeInTheDocument();
  });

  it('draws a lone bound as an open-ended marker, not a point circle', () => {
    render(
      <ParameterForestPlot
        summary={summary({
          points: [
            // "≥ 10": only low, no median/qualifier → representative stays null.
            {
              matrix: 'whole_blood',
              low: 10,
              high: null,
              representative: null,
              qualifier: null,
              citationId: 1,
              unit: 'mg/L',
            },
          ],
        })}
      />,
    );
    // Rendered open-ended (dashed line), and labeled as a "≥ 10" threshold.
    expect(document.querySelector('line[stroke-dasharray]')).not.toBeNull();
    expect(
      document.querySelector('svg title')?.textContent,
    ).toMatch(/≥\s*10/);
  });

  it('discloses sources that produced no plottable value at all', () => {
    render(
      <ParameterForestPlot
        summary={summary({
          // Three entries were considered but only one yielded a convertible
          // value (e.g. the others are molar on a drug with no molecular
          // weight), so `points` is short of `entryCount`.
          entryCount: 3,
          points: [
            {
              matrix: 'whole_blood',
              low: 10,
              high: 20,
              representative: 15,
              qualifier: null,
              citationId: 1,
              unit: 'mg/L',
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText('parameterEntries.forestPlot.omitted'),
    ).toBeInTheDocument();
  });

  it('keeps an already-logarithmic parameter linear even when all values are positive', () => {
    // pKa IS a logarithm; a log axis would transform it twice and flatten the
    // spread between sources. Every value here is positive, so only the
    // registry flag can force the linear axis.
    const { container } = render(
      <ParameterForestPlot
        parameter="pKa"
        summary={summary({
          representative: 9.5,
          iqrLow: 9.2,
          iqrHigh: 9.8,
          min: 9,
          max: 10,
          unit: '',
          entryCount: 2,
          pooledCount: 2,
          byMatrix: [],
          points: [
            {
              matrix: null,
              low: 9,
              high: 9.4,
              representative: 9.2,
              qualifier: null,
              citationId: 1,
              unit: '',
            },
            {
              matrix: null,
              low: 9.6,
              high: 10,
              representative: 9.8,
              qualifier: null,
              citationId: 2,
              unit: '',
            },
          ],
        })}
      />,
    );
    // A log axis over 9–10 would emit decade ticks (1, 10); a linear axis emits
    // evenly spaced ticks across the padded domain around the data instead.
    const tickLabels = [...container.querySelectorAll('svg text')].map(
      (t) => t.textContent,
    );
    expect(tickLabels).toContain('9');
    expect(tickLabels).toContain('10');
    expect(tickLabels).not.toContain('1');
  });

  it('switches to a linear axis for parameters that go negative (logP)', () => {
    render(
      <ParameterForestPlot
        summary={summary({
          representative: 0.4,
          iqrLow: -0.2,
          iqrHigh: 1.1,
          min: -1.2,
          max: 2,
          unit: '',
          entryCount: 2,
          pooledCount: 2,
          byMatrix: [],
          points: [
            {
              matrix: null,
              low: -1.2,
              high: 0.3,
              representative: -0.45,
              qualifier: null,
              citationId: 1,
              unit: '',
            },
            {
              matrix: null,
              low: 0.8,
              high: 2,
              representative: 1.4,
              qualifier: null,
              citationId: 2,
              unit: '',
            },
          ],
        })}
      />,
    );
    // A log axis would have dropped the negative source; on the linear axis
    // both are drawn and nothing is disclosed as omitted.
    expect(document.querySelectorAll('svg > g > title').length).toBeGreaterThanOrEqual(2);
    expect(
      screen.queryByText('parameterEntries.forestPlot.omitted'),
    ).toBeNull();
    // Dimensionless: the caption carries no "(unit)" suffix.
    expect(
      screen.getAllByText('parameterEntries.forestPlot.titleNoUnit').length,
    ).toBeGreaterThan(0);
  });

  it('shows a no-data message when nothing is plottable', () => {
    render(
      <ParameterForestPlot
        summary={summary({
          representative: null,
          iqrLow: null,
          iqrHigh: null,
          min: null,
          max: null,
          byMatrix: [],
          points: [],
        })}
      />,
    );
    expect(
      screen.getByText('parameterEntries.forestPlot.noData'),
    ).toBeInTheDocument();
  });
  it('pads the axis so a tight cluster of sources reads as a tight cluster', () => {
    // Four pKa sources agreeing to within 1% used to fill the whole plot width,
    // because the domain was exactly min..max. The markers must now sit well
    // inside the frame.
    const { container } = render(
      <ParameterForestPlot
        parameter="pKa"
        summary={summary({
          representative: 10,
          iqrLow: 9.9,
          iqrHigh: 10.1,
          min: 9.9,
          max: 10.1,
          unit: '',
          entryCount: 3,
          pooledCount: 3,
          byMatrix: [],
          points: [9.9, 10, 10.1].map((v, i) => ({
            matrix: null,
            low: null,
            high: null,
            representative: v,
            qualifier: null,
            citationId: i + 1,
            entryId: i + 1,
            unit: '',
          })),
        })}
      />,
    );
    const cx = [...container.querySelectorAll('circle')].map((c) =>
      Number(c.getAttribute('cx')),
    );
    // LABEL_W = 72, right edge = 640 - 16. The cluster spans a small slice in
    // the middle instead of running edge to edge.
    expect(Math.min(...cx)).toBeGreaterThan(100);
    expect(Math.max(...cx)).toBeLessThan(590);
    expect(Math.max(...cx) - Math.min(...cx)).toBeLessThan(120);
  });

  it('never labels a matrix-less source "other", and draws no legend for it', () => {
    render(
      <ParameterForestPlot
        parameter="halfLife"
        summary={summary({
          unit: 'h',
          normalizedToWholeBlood: false,
          byMatrix: [],
          points: [
            {
              matrix: null,
              low: null,
              high: null,
              representative: 7.9,
              qualifier: null,
              citationId: 1,
              entryId: 11,
              unit: 'h',
            },
          ],
        })}
      />,
    );
    // 'other' is a matrix a source can be coded as deliberately; a parameter
    // with no matrix dimension must not borrow that label (nor "unspecified").
    expect(
      screen.queryByText(/referenceConc\.matrix\.other/),
    ).toBeNull();
    expect(
      screen.queryByText(/forestPlot\.unspecifiedMatrix/),
    ).toBeNull();
    const titles = [...document.querySelectorAll('svg title')].map(
      (n) => n.textContent ?? '',
    );
    expect(titles.some((x) => x.startsWith('7.9 h'))).toBe(true);
  });

  it('calls a matrix-dependent source with no stated matrix "unspecified"', () => {
    render(
      <ParameterForestPlot
        summary={summary({
          normalizedToWholeBlood: true,
          byMatrix: [],
          points: [
            {
              matrix: null,
              low: null,
              high: null,
              representative: 20,
              qualifier: null,
              citationId: 1,
              entryId: 12,
              unit: 'mg/L',
            },
          ],
        })}
      />,
    );
    const titles = [...document.querySelectorAll('svg title')].map(
      (n) => n.textContent ?? '',
    );
    expect(
      titles.some((x) =>
        x.includes('parameterEntries.forestPlot.unspecifiedMatrix'),
      ),
    ).toBe(true);
  });

  it('reports the hovered entry id and emphasizes an externally highlighted one', () => {
    const seen: (number | null)[] = [];
    const points = [
      {
        matrix: 'whole_blood' as const,
        low: null,
        high: null,
        representative: 15,
        qualifier: null,
        citationId: 1,
        entryId: 101,
        unit: 'mg/L',
      },
      {
        matrix: 'whole_blood' as const,
        low: null,
        high: null,
        representative: 25,
        qualifier: null,
        citationId: 2,
        entryId: 102,
        unit: 'mg/L',
      },
    ];
    const { container, rerender } = render(
      <ParameterForestPlot
        summary={summary({ points })}
        onHighlightEntry={(id) => seen.push(id)}
      />,
    );
    const rowsWithMarkers = [...container.querySelectorAll('svg > g')].filter(
      (g) => g.querySelector('circle'),
    );
    fireEvent.mouseEnter(rowsWithMarkers[0]!);
    expect(seen).toContain(101);

    rerender(
      <ParameterForestPlot
        summary={summary({ points })}
        highlightedEntryId={102}
        onHighlightEntry={(id) => seen.push(id)}
      />,
    );
    // The un-highlighted row is dimmed; the highlighted one keeps full opacity
    // and a fatter marker.
    const rows = [...container.querySelectorAll('svg > g')].filter((g) =>
      g.querySelector('circle'),
    );
    const opacities = rows.map((g) => g.getAttribute('opacity'));
    expect(opacities).toContain('0.3');
    const radii = rows.map((g) => g.querySelector('circle')!.getAttribute('r'));
    expect(radii).toContain('6');
  });

  it('re-expresses values in the reader\'s preferred unit', () => {
    render(
      <ParameterForestPlot
        summary={summary({
          unit: 'mg/L',
          representative: 0.02,
          iqrLow: 0.02,
          iqrHigh: 0.03,
          byMatrix: [],
          points: [
            {
              matrix: 'whole_blood',
              low: null,
              high: null,
              representative: 0.02,
              qualifier: null,
              citationId: 1,
              entryId: 1,
              unit: 'mg/L',
            },
          ],
        })}
        displayUnit="µg/L"
      />,
    );
    // 0.02 mg/L = 20 µg/L: the axis caption switches unit and the marker's
    // tooltip carries the converted figure.
    expect(screen.getAllByText(/µg\/L/).length).toBeGreaterThan(0);
    const titles = [...document.querySelectorAll('svg title')].map(
      (n) => n.textContent ?? '',
    );
    expect(titles.some((x) => x.includes('20 µg/L'))).toBe(true);
  });

  it('leaves the summary unit alone when it cannot convert to the preferred one', () => {
    render(
      <ParameterForestPlot
        summary={summary({ unit: 'h', byMatrix: [], points: [] })}
        displayUnit="mg/L"
      />,
    );
    // An hour is not a concentration — the caption must not claim mg/L.
    expect(screen.getAllByText(/\(h\)|h/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/mg\/L/)).toBeNull();
  });

  it('re-frames the plot to serum via the blood:plasma ratio', () => {
    const summ = summary({
      normalizedToWholeBlood: true,
      representative: 1,
      iqrLow: 1,
      iqrHigh: 1,
      byMatrix: [],
      points: [
        {
          matrix: 'whole_blood',
          low: null,
          high: null,
          representative: 1,
          qualifier: null,
          citationId: 1,
          entryId: 1,
          unit: 'mg/L',
        },
      ],
    });
    render(<ParameterForestPlot summary={summ} bloodPlasmaRatio={2} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'serum' } });
    const titles = [...document.querySelectorAll('svg title')].map(
      (n) => n.textContent ?? '',
    );
    // blood = ratio × plasma, so a 1 mg/L whole-blood value is 0.5 in serum.
    expect(titles.some((x) => x.includes('0.5 mg/L'))).toBe(true);
    expect(
      screen.getAllByText(/forestPlot\.frameNote/).length,
    ).toBeGreaterThan(0);
  });

  it('offers no matrix frame control without a blood:plasma ratio', () => {
    render(
      <ParameterForestPlot summary={summary({ normalizedToWholeBlood: true })} />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('leaves non-blood sources unscaled when the frame changes', () => {
    const summ = summary({
      normalizedToWholeBlood: true,
      representative: 1,
      iqrLow: 1,
      iqrHigh: 1,
      byMatrix: [],
      points: [
        {
          matrix: 'whole_blood',
          low: null,
          high: null,
          representative: 1,
          qualifier: null,
          citationId: 1,
          entryId: 1,
          unit: 'mg/L',
        },
        {
          matrix: 'urine',
          low: null,
          high: null,
          representative: 4,
          qualifier: null,
          citationId: 2,
          entryId: 2,
          unit: 'mg/L',
        },
      ],
    });
    render(<ParameterForestPlot summary={summ} bloodPlasmaRatio={2} />);
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'serum' },
    });
    const titles = [...document.querySelectorAll('svg title')].map(
      (n) => n.textContent ?? '',
    );
    // Whole blood → serum divides by the ratio…
    expect(titles.some((x) => x.includes('0.5 mg/L'))).toBe(true);
    // …but urine has no blood:plasma relation, so it keeps its reported value
    // and is never labelled a serum equivalent.
    const urine = titles.find((x) =>
      x.includes('referenceConc.matrix.urine'),
    )!;
    expect(urine).toContain('4 mg/L');
    expect(urine).not.toContain('frameShort');
    // The caption discloses that some rows were left as reported.
    expect(
      screen.getAllByText(/frameNoteNonBlood/).length,
    ).toBeGreaterThan(0);
  });
});
