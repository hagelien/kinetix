import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssumptionPanel } from './AssumptionPanel';
import type { DrugSimResult } from '@/types/simulator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo the key so tests can assert which i18n key was used (i.e. that the
    // Norwegian-translatable messageKey path is taken, not the English fallback).
    t: (key: string) => key,
  }),
}));

// Stub the bibliography hook so the panel doesn't hit the network: expose one
// reference attached to the halfLife parameter.
vi.mock('@/lib/useDrugBibliography', () => ({
  useDrugBibliography: () => ({
    ordered: [
      { index: 1, row: { id: 7, type: 'manual', title: 'Goodman & Gilman' } },
    ],
    bibliographyMap: new Map([[7, 1]]),
    refsByParameter: { halfLife: [7] },
  }),
}));

function pkResult(): DrugSimResult {
  return {
    drugConfigId: 'cfg-1',
    engine: 'pk-montecarlo',
    questionMode: 'concentration-from-dose',
    median: 1,
    p05: 0.5,
    p25: 0.8,
    p75: 1.2,
    p95: 1.5,
    unit: 'mg/L',
    timeSeries: [],
    assumptions: {
      model: 'one-compartment',
      route: 'oral',
      halfLife: { type: 'uniform', min: 9, max: 13 },
      vd: { type: 'triangular', min: 3, max: 5, mode: 4 },
      f: { type: 'fixed', value: 0.75 },
      weightScaling: true,
      provenance: { halfLife: 'verified', vd: 'verified', f: 'assumption' },
    },
    sensitivity: [],
    warnings: [
      {
        type: 'input-uncertainty',
        messageKey: 'simulator.warnings.defaultWeight',
        message: 'Vd is in L/kg; using default 70 kg body weight.',
        severity: 'info',
      },
    ],
    seed: 1,
    drawCount: 10000,
  };
}

// The panel links to the "How the simulator works" page, so it needs a router
// context — the panel's own assumptions and the simulator's general premises are
// deliberately one click apart.
function renderPanel() {
  return render(
    <MemoryRouter>
      <AssumptionPanel
        results={{ 'cfg-1': pkResult() }}
        drugLabels={{ 'cfg-1': 'Amphetamine' }}
        drugDbIds={{ 'cfg-1': 42 }}
      />
    </MemoryRouter>,
  );
}

describe('AssumptionPanel', () => {
  it('renders warnings via their i18n messageKey, not the English message', () => {
    renderPanel();
    // The translatable key is shown (proving messageKey is used), and the
    // hardcoded English fallback is not.
    expect(screen.getByText('simulator.warnings.defaultWeight')).toBeTruthy();
    expect(
      screen.queryByText(/using default 70 kg body weight/),
    ).toBeNull();
  });

  it('shows a hoverable refs affordance for a literature parameter', () => {
    renderPanel();
    // halfLife is verified with a reference → the "refs" pill replaces the green
    // LITTERATUR label. (assumptions.refsLabel echoes as its key here.)
    expect(screen.getByText('assumptions.refsLabel')).toBeTruthy();
    // F is an 'assumption' with no refs → keeps the provenance tag.
    expect(
      screen.getByText('assumptions.provenance.assumption'),
    ).toBeTruthy();
  });
});
