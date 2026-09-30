/**
 * The dialog's route-aware behaviour (CV-2c-4).
 *
 * A route-scoped entry never pools into the drug-level summary, so a parameter whose evidence has
 * all been curated onto a route has NO drug-level summary at all. Before per-route pools travelled
 * with the drug, that made the dialog draw no plot and state that no source values were registered
 * — directly above the list of them.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18nApp from '@/i18n';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';
import { ParameterSourcesDialog } from './ParameterSourcesDialog';

vi.mock('./ParameterEntryList', () => ({
  ParameterEntryList: () => <div data-testid="entry-list" />,
}));

function summary(representative: number, unit: string): ParameterSummary {
  return {
    representative,
    iqrLow: null,
    iqrHigh: null,
    min: representative,
    max: representative,
    unit,
    entryCount: 3,
    pooledCount: 3,
    contributingCitationIds: [],
    byMatrix: [],
    points: [],
    normalizedToWholeBlood: false,
  };
}

function renderDialog(props: Partial<Parameters<typeof ParameterSourcesDialog>[0]>) {
  return render(
    <ParameterSourcesDialog
      drugId={1}
      drugName="Amphetamine"
      parameter="tmax"
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('ParameterSourcesDialog', () => {
  beforeEach(async () => {
    await i18nApp.changeLanguage('en');
  });

  it('plots each route pool when the parameter has no drug-level summary', () => {
    renderDialog({
      routeSummaries: { tmax: { oral: summary(3.3, 'h') } },
    });
    expect(screen.getByTestId('parameter-forest-plot-oral')).toBeInTheDocument();
    expect(screen.queryByTestId('parameter-forest-plot')).toBeNull();
    // The contradiction this test exists for: no "nothing registered" beside a registered pool.
    expect(
      screen.queryByText(/no source values recorded/i),
    ).toBeNull();
  });

  it('keeps the drug-level plot and adds the route ones beside it', () => {
    renderDialog({
      summaries: { tmax: summary(2.5, 'h') },
      routeSummaries: { tmax: { oral: summary(3.3, 'h') } },
    });
    expect(screen.getByTestId('parameter-forest-plot')).toBeInTheDocument();
    expect(screen.getByTestId('parameter-forest-plot-oral')).toBeInTheDocument();
  });

  it('still reports an empty parameter as empty', () => {
    renderDialog({});
    expect(screen.getByText(/no source values recorded/i)).toBeInTheDocument();
    expect(screen.queryByTestId('parameter-forest-plot')).toBeNull();
  });
});
