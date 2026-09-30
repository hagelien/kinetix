import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ParameterSourcesDialog } from '@/components/wiki/ParameterSourcesDialog';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';
import type { ParameterEntryRow } from '@/lib/parameterEntriesApi';

const summary: ParameterSummary = {
  representative: 0.04,
  iqrLow: 0.04,
  iqrHigh: 0.04,
  min: 0.04,
  max: 0.04,
  unit: 'mg/L',
  entryCount: 1,
  pooledCount: 1,
  normalizedToWholeBlood: true,
  contributingCitationIds: [7],
  byMatrix: [],
  points: [
    {
      matrix: 'whole_blood',
      low: null,
      high: null,
      representative: 0.04,
      qualifier: null,
      citationId: 7,
      entryId: 3,
      unit: 'mg/L',
    },
  ],
};

const row: ParameterEntryRow = {
  id: 3,
  parameter: 'therapeuticConcentration',
  low: null,
  high: null,
  median: 0.04,
  qualifier: null,
  categoricalValue: null,
  unit: 'mg/L',
  route: null,
  matrix: 'whole_blood',
  scenario: null,
  n: null,
  comments: null,
  observationContext: null,
  sourceQuote: null,
  origin: 'contributor',
  citationId: 7,
  citation: null,
};

function renderDialog() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [row] }) }),
  );
  return render(
    <ParameterSourcesDialog
      drugId={5}
      drugName="Amfetamin"
      parameter="therapeuticConcentration"
      summaries={{ therapeuticConcentration: summary }}
      // No molecular weight: the preferred unit (µmol/L) needs one, so the
      // display unit stays mg/L and the frame is the only thing moving.
      molecularWeight={null}
      bloodPlasmaRatio={2}
      onClose={() => {}}
    />,
  );
}

describe('ParameterSourcesDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('moves the pooled headline into the same frame as the plot', async () => {
    renderDialog();
    // The list self-fetches; wait for the pooled headline to appear.
    await waitFor(() =>
      expect(
        screen.getByText(/parameterEntries\.summary\.line/),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'serum' },
    });

    // Same estimate, one frame: 0.04 mg/L whole blood is 0.02 in serum at
    // B/P = 2, and the headline says which frame it is now quoting.
    await waitFor(() =>
      expect(
        screen.getByText(/parameterEntries\.summary\.lineFramed/),
      ).toBeInTheDocument(),
    );
    const plotTitles = [...document.querySelectorAll('svg title')].map(
      (n) => n.textContent ?? '',
    );
    expect(plotTitles.some((x) => x.includes('0.02 mg/L'))).toBe(true);
  });
});
