// Pure helpers for building Plotly shape/annotation arrays used by SimulatorGraph.
// Extracted from the component so they can be unit-tested without pulling in Plotly.

export interface ReferenceRange {
  therapeutic?: { min?: number; max?: number };
  toxic?: { min?: number; max?: number };
  lethal?: { min?: number; max?: number };
}

export interface LegalLimit {
  value: number;
  color: string;
  label: string;
  dash?: string;
}

export function buildReferenceShapes(
  referenceRanges: Record<string, ReferenceRange> | undefined,
  visibleDrugs: Set<string>,
  displayMode: 'overlay' | 'separate',
  orderedDrugIds: string[],
  drugLabels: Record<string, string>,
): { shapes: Array<Record<string, unknown>>; annotations: Array<Record<string, unknown>> } {
  if (!referenceRanges) return { shapes: [], annotations: [] };
  const shapes: Array<Record<string, unknown>> = [];
  const annotations: Array<Record<string, unknown>> = [];
  const multiDrug = Object.keys(referenceRanges).filter((id) => visibleDrugs.has(id)).length > 1;

  for (const [id, ranges] of Object.entries(referenceRanges)) {
    if (!visibleDrugs.has(id)) continue;

    const drugIdx = orderedDrugIds.indexOf(id);
    const yref = displayMode === 'separate' && drugIdx > 0 ? `y${drugIdx + 1}` : 'y';
    const drugName = multiDrug ? `${drugLabels[id] ?? ''} ` : '';

    const addLine = (value: number, color: string, width: number, dash: string, label: string) => {
      shapes.push({
        type: 'line', xref: 'paper', x0: 0, x1: 1,
        yref, y0: value, y1: value,
        line: { color, width, dash },
      });
      annotations.push({
        xref: 'paper', x: 1, yref, y: value,
        xanchor: 'left', yanchor: 'bottom',
        text: `${drugName}${label}`,
        showarrow: false,
        font: { size: 9, color },
        xshift: 4,
      });
    };

    if (ranges.therapeutic) {
      const { min, max } = ranges.therapeutic;
      if (max != null) addLine(max, 'rgba(34,197,94,0.7)', 1, 'dot', 'Therapeutic');
      if (min != null && min !== max) addLine(min, 'rgba(34,197,94,0.7)', 1, 'dot', 'Therapeutic min');
    }

    if (ranges.toxic) {
      const val = ranges.toxic.min ?? ranges.toxic.max;
      if (val != null) addLine(val, 'rgba(245,158,11,0.8)', 1.5, 'dash', 'Toxic');
    }

    if (ranges.lethal) {
      const val = ranges.lethal.min ?? ranges.lethal.max;
      if (val != null) addLine(val, 'rgba(239,68,68,0.8)', 1.5, 'dash', 'Lethal');
    }
  }

  return { shapes, annotations };
}

export function buildLegalLimitShapes(
  legalLimits: LegalLimit[] | undefined,
  displayMode: 'overlay' | 'separate',
  orderedDrugIds: string[],
): { shapes: Array<Record<string, unknown>>; annotations: Array<Record<string, unknown>> } {
  if (!legalLimits || legalLimits.length === 0) return { shapes: [], annotations: [] };
  const shapes: Array<Record<string, unknown>> = [];
  const annotations: Array<Record<string, unknown>> = [];

  // In separate mode, render the same limits on every drug's y-axis so each
  // panel has its own legal-limit reference. In overlay mode, render once on
  // the shared y-axis.
  const yrefs = displayMode === 'separate' && orderedDrugIds.length > 0
    ? orderedDrugIds.map((_, idx) => (idx === 0 ? 'y' : `y${idx + 1}`))
    : ['y'];

  for (const yref of yrefs) {
    for (const limit of legalLimits) {
      shapes.push({
        type: 'line', xref: 'paper', x0: 0, x1: 1,
        yref, y0: limit.value, y1: limit.value,
        line: { color: limit.color, width: 1.5, dash: limit.dash ?? 'dash' },
      });
      annotations.push({
        xref: 'paper', x: 1, yref, y: limit.value,
        xanchor: 'left', yanchor: 'bottom',
        text: limit.label,
        showarrow: false,
        font: { size: 9, color: limit.color },
        xshift: 4,
      });
    }
  }

  return { shapes, annotations };
}
